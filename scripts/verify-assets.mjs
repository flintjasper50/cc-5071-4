/**
 * Clean-directory asset verification (auxiliary CLI — the graphical entry is
 * the Scene card in the drill UI).
 *
 *   npm run asset:verify
 *
 * Copies the runtime sources and the committed scene assets into a fresh
 * temporary directory and executes the verification there, so nothing in the
 * repo working tree can influence the result. For every scene in the manifest
 * the runner rebuilds the scene from its asset, checks the reconstruction
 * against the spec, replays the saved interaction script on the hinge kernel,
 * and compares the fresh joint errors and limit hits against the committed
 * original record. The report is written inside the clean directory.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const RUNNER = `
import { readFileSync, writeFileSync } from 'node:fs';
import RAPIER from '@dimforge/rapier3d-compat';
import { buildSceneFromAsset, checkReconstruction } from './src/scene/loader.js';
import { runScriptHeadless, summarizeSamples, compareSummaries } from './src/scene/script.js';

await RAPIER.init();
const manifest = JSON.parse(readFileSync('./public/assets/scenes/manifest.json', 'utf8'));
const report = { startedAt: new Date().toISOString(), cwd: process.cwd(), scenes: [] };
// Manifest URLs are web paths (/assets/...); on disk they live under public/.
const toDisk = (url) => './public' + url;

for (const entry of manifest.scenes) {
  const asset = JSON.parse(readFileSync(toDisk(entry.url), 'utf8'));
  const trace = JSON.parse(readFileSync(toDisk(entry.trace), 'utf8'));
  const jointIds = asset.hinges.map((h) => h.id);

  const scene = buildSceneFromAsset(RAPIER, asset, {});
  const recon = checkReconstruction(scene, asset);
  scene.settle(0.5);
  const { samples } = runScriptHeadless(scene, asset.script, {
    dt: asset.solver.dt,
    durationSec: asset.scriptDuration,
    sampleEvery: trace.meta.sampleEverySteps,
  });
  const fresh = summarizeSamples(samples, jointIds);
  const cmp = compareSummaries(trace.summary, fresh, jointIds);
  report.scenes.push({
    id: asset.id,
    reconstruction: recon,
    comparison: cmp,
    freshSummary: fresh,
    recordedSummary: trace.summary,
  });
}

report.ok = report.scenes.every((s) => s.reconstruction.ok && s.comparison.ok);
report.finishedAt = new Date().toISOString();
writeFileSync('./verification-report.json', JSON.stringify(report, null, 2) + '\\n');
console.log(JSON.stringify({ ok: report.ok }));
process.exit(report.ok ? 0 : 1);
`;

const tmp = mkdtempSync(join(tmpdir(), 'hinge-asset-verify-'));
let keep = false;
try {
  cpSync(join(repoRoot, 'src'), join(tmp, 'src'), { recursive: true });
  cpSync(join(repoRoot, 'public', 'assets'), join(tmp, 'public', 'assets'), { recursive: true });
  cpSync(join(repoRoot, 'package.json'), join(tmp, 'package.json'));
  // Dependencies are resolved, not copied: the clean dir gets a symlink so the
  // run is isolated from the working tree but still uses the pinned install.
  symlinkSync(join(repoRoot, 'node_modules'), join(tmp, 'node_modules'), 'dir');
  writeFileSync(join(tmp, 'run-verify.mjs'), RUNNER);

  console.log(`clean verification directory: ${tmp}`);
  let failed = false;
  try {
    execFileSync(process.execPath, ['run-verify.mjs'], { cwd: tmp, stdio: 'pipe' });
  } catch {
    failed = true;
  }

  const reportPath = join(tmp, 'verification-report.json');
  if (!existsSync(reportPath)) {
    console.error('verification runner did not produce a report');
    keep = true;
    process.exit(1);
  }
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));

  for (const scene of report.scenes) {
    console.log(`\nscene ${scene.id}`);
    for (const c of scene.reconstruction.checks) {
      console.log(`  reconstruction ${c.ok ? 'OK  ' : 'FAIL'}  ${c.hinge}  ${c.detail}`);
    }
    console.log('  joint        final° (rec→fresh)   max anchor mm (rec→fresh)   max limit err° (rec→fresh)   verdict');
    for (const row of scene.comparison.rows) {
      const r = row.recorded ?? {};
      const f = row.fresh ?? {};
      const cell = (a, b, w = 9) => `${String(a).padStart(w)} → ${String(b).padEnd(w)}`;
      console.log(
        `  ${row.joint.padEnd(11)}  ${cell(r.finalAngleDeg, f.finalAngleDeg)}  ${cell(r.maxAnchorMm, f.maxAnchorMm)}  ` +
          `${cell(r.maxLimitErrDeg, f.maxLimitErrDeg)}  ${row.ok ? 'matches' : 'MISMATCH'}`
      );
      if (!row.ok) console.log(`      ${row.detail}`);
    }
  }

  const ok = report.ok && !failed;
  console.log(`\nverification ${ok ? 'PASSED' : 'FAILED'} — joint errors and limits checked against the original records`);
  console.log(`report: ${reportPath}`);
  keep = !ok;
  process.exit(ok ? 0 : 1);
} finally {
  if (!keep) rmSync(tmp, { recursive: true, force: true });
  else console.log(`clean directory kept for inspection: ${tmp}`);
}
