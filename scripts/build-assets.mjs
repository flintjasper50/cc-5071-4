/**
 * Scene asset authoring (auxiliary CLI — the graphical entry is the Scene card
 * in the drill UI). Rebuilds the loading-dock scene through the asset loader,
 * verifies the reconstruction against the spec, then runs the interaction
 * script on the real hinge kernel and records the trajectory.
 *
 *   npm run asset:build
 *
 * Outputs (committed to the repo):
 *   public/assets/scenes/dock-gate-arm.json        geometry + joints + input script
 *   public/assets/scenes/dock-gate-arm.trace.json  recorded run (the evidence)
 *   public/assets/scenes/manifest.json             loadable scene index
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import RAPIER from '@dimforge/rapier3d-compat';
import { buildSceneFromAsset, checkReconstruction } from '../src/scene/loader.js';
import { runScriptHeadless, summarizeSamples } from '../src/scene/script.js';
import { defineDockAsset } from './dock-asset.mjs';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'assets', 'scenes');

await RAPIER.init();

const asset = defineDockAsset();
const scene = buildSceneFromAsset(RAPIER, asset, {});

// The reconstruction must conform before anything is recorded.
const recon = checkReconstruction(scene, asset);
for (const c of recon.checks) {
  console.log(`reconstruction ${c.ok ? 'OK  ' : 'FAIL'}  ${c.hinge}  ${c.detail}`);
}
if (!recon.ok) {
  console.error('reconstruction does not conform to the asset; refusing to record');
  process.exit(1);
}

scene.settle(0.5);
const { samples } = runScriptHeadless(scene, asset.script, {
  dt: asset.solver.dt,
  durationSec: asset.scriptDuration,
  sampleEvery: 4,
});
const jointIds = asset.hinges.map((h) => h.id);
const summary = summarizeSamples(samples, jointIds);

// The recorded run must contain the evidence this scene exists for: the
// reversed gate blocked by the bollard and resting on its min limit, and both
// arm joints reaching their limit angles.
const evidence = [
  ['gate blocked by the bollard', summary.perJoint.gate.blockedBy.includes('bollard')],
  ['gate reached its min limit', summary.perJoint.gate.reachedMin != null],
  ['shoulder reached its min limit', summary.perJoint.shoulder.reachedMin != null],
  ['elbow reached its min limit', summary.perJoint.elbow.reachedMin != null],
  ['gate anchor stayed sub-mm', summary.perJoint.gate.maxAnchorMm < 1],
  ['arm anchor stayed sub-mm', Math.max(summary.perJoint.shoulder.maxAnchorMm, summary.perJoint.elbow.maxAnchorMm) < 1],
];
let evidenceOk = true;
for (const [name, ok] of evidence) {
  console.log(`evidence ${ok ? 'OK  ' : 'FAIL'}  ${name}`);
  evidenceOk &&= ok;
}
if (!evidenceOk) {
  console.error('recorded run is missing the expected evidence; refusing to write assets');
  process.exit(1);
}

const trace = {
  format: 'hinge-trace/1',
  scene: asset.id,
  meta: {
    source: 'scripts/build-assets.mjs',
    recordedAt: asset.meta.createdAt,
    dt: asset.solver.dt,
    iterations: asset.solver.iterations,
    durationSec: asset.scriptDuration,
    sampleEverySteps: 4,
  },
  summary,
  samples,
};

mkdirSync(outDir, { recursive: true });
const assetPath = join(outDir, `${asset.id}.json`);
const tracePath = join(outDir, `${asset.id}.trace.json`);
writeFileSync(assetPath, JSON.stringify(asset, null, 2) + '\n');
writeFileSync(tracePath, JSON.stringify(trace, null, 2) + '\n');
const manifest = {
  scenes: [
    {
      id: asset.id,
      title: asset.title,
      url: `/assets/scenes/${asset.id}.json`,
      trace: `/assets/scenes/${asset.id}.trace.json`,
      hasScript: true,
      joints: jointIds,
    },
  ],
};
writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

console.log(`\nwrote ${assetPath}`);
console.log(`wrote ${tracePath}`);
console.log(`\nrecorded run: ${samples.length} samples over ${summary.seconds.toFixed(2)} s`);
for (const id of jointIds) {
  const s = summary.perJoint[id];
  console.log(
    `  ${id.padEnd(9)} final ${String(s.finalAngleDeg).padStart(7)}°  range [${s.minAngleDeg}, ${s.maxAngleDeg}]  ` +
      `max anchor ${s.maxAnchorMm} mm  max limit err ${s.maxLimitErrDeg}°  ` +
      `contacts [${s.contacts.join(',')}] blocked [${s.blockedBy.join(',')}]`
  );
}
