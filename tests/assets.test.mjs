import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import RAPIER from '@dimforge/rapier3d-compat';
import { buildSceneFromAsset, checkReconstruction } from '../src/scene/loader.js';
import { runScriptHeadless, summarizeSamples, compareSummaries } from '../src/scene/script.js';

const scenesDir = join(fileURLToPath(import.meta.url), '..', '..', 'public', 'assets', 'scenes');
const asset = JSON.parse(readFileSync(join(scenesDir, 'dock-gate-arm.json'), 'utf8'));
const trace = JSON.parse(readFileSync(join(scenesDir, 'dock-gate-arm.trace.json'), 'utf8'));
const jointIds = asset.hinges.map((h) => h.id);

await RAPIER.init();

test('asset file is well-formed and carries its source and parameters', () => {
  assert.equal(asset.format, 'hinge-scene/1');
  assert.equal(asset.meta.source, 'scripts/build-assets.mjs');
  assert.ok(asset.meta.params, 'authoring parameters must be recorded');
  assert.ok(asset.meta.createdAt, 'authoring time must be recorded');
  assert.equal(trace.scene, asset.id);
  assert.equal(trace.format, 'hinge-trace/1');
  // The scene must cover what it claims: a reversed hinge axis and limit hits.
  const gate = asset.hinges.find((h) => h.id === 'gate');
  assert.deepEqual(gate.axis, [0, -1, 0], 'gate axis must be the reversed vertical axis');
  assert.ok(asset.script.length > 0, 'the interaction input script must be saved with the geometry');
});

test('reconstruction conforms to the asset spec', () => {
  const scene = buildSceneFromAsset(RAPIER, asset, {});
  const recon = checkReconstruction(scene, asset);
  for (const c of recon.checks) {
    assert.ok(c.ok, `${c.hinge}: ${c.detail}`);
  }
});

test('the recorded trace contains the claimed joint error and limit evidence', () => {
  const { perJoint } = trace.summary;
  // These are the facts the asset was authored to demonstrate; the record
  // itself must contain them before any fresh run is compared against it.
  assert.ok(perJoint.gate.blockedBy.includes('bollard'), 'gate must be blocked by the bollard');
  assert.ok(perJoint.gate.reachedMin, 'gate must reach its min limit');
  assert.ok(perJoint.shoulder.reachedMin, 'shoulder must reach its min limit');
  assert.ok(perJoint.elbow.reachedMin, 'elbow must reach its min limit');
  assert.ok(perJoint.gate.maxAnchorMm < 1, 'gate anchor error must be sub-millimetre');
  assert.ok(perJoint.shoulder.maxAnchorMm < 1 && perJoint.elbow.maxAnchorMm < 1, 'arm anchor errors must be sub-millimetre');
  assert.ok(perJoint.elbow.maxLimitErrDeg < 0.5, 'elbow limit error must stay tiny');
});

test('replaying the saved script reproduces the recorded trajectory', () => {
  const scene = buildSceneFromAsset(RAPIER, asset, {});
  scene.settle(0.5);
  const { samples } = runScriptHeadless(scene, asset.script, {
    dt: asset.solver.dt,
    durationSec: asset.scriptDuration,
    sampleEvery: trace.meta.sampleEverySteps,
  });
  const fresh = summarizeSamples(samples, jointIds);
  const cmp = compareSummaries(trace.summary, fresh, jointIds);
  for (const row of cmp.rows) {
    assert.ok(row.ok, `${row.joint}: ${row.detail}`);
  }
});

test('a tampered record is detected, not rubber-stamped', () => {
  const scene = buildSceneFromAsset(RAPIER, asset, {});
  scene.settle(0.5);
  const { samples } = runScriptHeadless(scene, asset.script, {
    dt: asset.solver.dt,
    durationSec: asset.scriptDuration,
    sampleEvery: trace.meta.sampleEverySteps,
  });
  const fresh = summarizeSamples(samples, jointIds);
  const fake = JSON.parse(JSON.stringify(trace.summary));
  fake.perJoint.gate.finalAngleDeg += 30; // claim the gate ended somewhere it did not
  fake.perJoint.elbow.blockedBy = ['ghost']; // claim a contact that never happened
  const cmp = compareSummaries(fake, fresh, jointIds);
  assert.equal(cmp.ok, false, 'comparison must fail against a fabricated record');
  assert.ok(cmp.rows.some((r) => !r.ok));
});
