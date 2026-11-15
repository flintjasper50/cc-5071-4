import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AngleTracker,
  QuatAngleTracker,
  clampToLimits,
  limitOverflow,
  normalizeAngle,
  unwrapToward,
} from '../src/core/angles.js';
import { qFromAxisAngle, qFromXAxis, qMul, qRotate, qSlerp, twistX, v3, wrapPi } from '../src/core/math.js';

const TAU = Math.PI * 2;

test('normalizeAngle maps into (-PI, PI]', () => {
  assert.ok(Math.abs(normalizeAngle(3 * Math.PI) - Math.PI) < 1e-12);
  assert.ok(Math.abs(normalizeAngle(-3 * Math.PI) - Math.PI) < 1e-12);
  assert.ok(Math.abs(normalizeAngle(Math.PI + 0.1) - (-Math.PI + 0.1)) < 1e-12);
  assert.equal(normalizeAngle(0.5), 0.5);
});

test('unwrapToward picks the branch nearest the previous value', () => {
  const prev = Math.PI - 0.01;
  const raw = -Math.PI + 0.01; // physically +0.02 rad past the seam
  const next = unwrapToward(raw, prev);
  assert.ok(Math.abs(next - (Math.PI + 0.01)) < 1e-12);
  assert.ok(Math.abs(next - prev - 0.02) < 1e-12);
});

test('a tiny move across the seam is not counted as a full turn', () => {
  const tracker = new AngleTracker(0);
  // Drive to just under +PI
  for (let i = 0; i < 314; i++) tracker.push(i * 0.01);
  const before = tracker.continuous;
  assert.ok(before > 3.1 && before < Math.PI);
  // Cross the seam by a hair
  tracker.push(-Math.PI + 0.001);
  const moved = tracker.continuous - before;
  assert.ok(moved > 0 && moved < 0.02, `expected a small positive step, got ${moved}`);
  assert.ok(Math.abs(tracker.continuous - (Math.PI + 0.001)) < 1e-9);
});

test('a genuine full revolution is accumulated', () => {
  const tracker = new AngleTracker(0);
  const steps = 720;
  for (let i = 1; i <= steps; i++) tracker.push(wrapPi((i / steps) * TAU));
  assert.ok(Math.abs(tracker.continuous - TAU) < 0.02, `continuous=${tracker.continuous}`);
});

test('angle tracker handles back-and-forth near the seam without drift', () => {
  const tracker = new AngleTracker(Math.PI - 0.005);
  tracker.push(-Math.PI + 0.004);
  tracker.push(Math.PI - 0.003);
  tracker.push(-Math.PI + 0.002);
  // Net motion is small; no accumulated 2*PI terms
  assert.ok(Math.abs(tracker.continuous - Math.PI) < 0.02);
});

test('clampToLimits preserves the turn count nearest the measured angle', () => {
  const min = -0.5;
  const max = 0.5;
  const r1 = clampToLimits(2 * Math.PI + 0.2, min, max);
  assert.ok(Math.abs(r1.angle - 0.2) < 1e-9);
  assert.equal(r1.overflow, 0);

  const r2 = clampToLimits(2 * Math.PI + 0.8, min, max);
  assert.ok(Math.abs(r2.angle - 0.5) < 1e-9);
  assert.ok(Math.abs(r2.overflow - 0.3) < 1e-9);

  const r3 = clampToLimits(-2 * Math.PI - 0.7, min, max);
  assert.ok(Math.abs(r3.angle - -0.5) < 1e-9);
  assert.ok(Math.abs(r3.overflow - -0.2) < 1e-9);
});

test('limitOverflow is zero inside and signed outside', () => {
  assert.equal(limitOverflow(0, -1, 1), 0);
  assert.ok(limitOverflow(1.2, -1, 1) > 0);
  assert.ok(limitOverflow(-1.2, -1, 1) < 0);
});

test('twistX recovers an angle injected about local +X', () => {
  for (const angle of [-3.1, -1.2, 0, 0.4, 2.9]) {
    const q = qFromAxisAngle(v3(1, 0, 0), angle);
    assert.ok(Math.abs(twistX(q) - angle) < 1e-12);
  }
});

test('quaternion helpers: frame from axis points its X along the axis', () => {
  const axis = v3(0.25, 1, -0.4);
  const q = qFromXAxis(axis);
  const mapped = qRotate(q, v3(1, 0, 0));
  const n = Math.hypot(axis.x, axis.y, axis.z);
  assert.ok(Math.abs(mapped.x - axis.x / n) < 1e-12);
  assert.ok(Math.abs(mapped.y - axis.y / n) < 1e-12);
  assert.ok(Math.abs(mapped.z - axis.z / n) < 1e-12);
});

test('qMul composition matches sequential rotation', () => {
  const a = qFromAxisAngle(v3(0, 1, 0), 0.7);
  const b = qFromAxisAngle(v3(1, 0, 0), -0.3);
  const v = v3(0.2, 0.5, -0.8);
  const seq = qRotate(a, qRotate(b, v));
  const comp = qRotate(qMul(a, b), v);
  assert.ok(Math.abs(seq.x - comp.x) < 1e-12);
  assert.ok(Math.abs(seq.y - comp.y) < 1e-12);
  assert.ok(Math.abs(seq.z - comp.z) < 1e-12);
});

test('qSlerp stays on the unit sphere and interpolates twist', () => {
  const a = qFromAxisAngle(v3(0, 0, 1), 0.1);
  const b = qFromAxisAngle(v3(0, 0, 1), 2.4);
  const m = qSlerp(a, b, 0.5);
  assert.ok(Math.abs(Math.hypot(m.x, m.y, m.z, m.w) - 1) < 1e-9);
  const angle = 2 * Math.atan2(m.z, m.w);
  assert.ok(Math.abs(angle - 1.25) < 1e-6, `got ${angle}`);
  const end = qSlerp(a, b, 1);
  assert.ok(Math.abs(2 * Math.atan2(end.z, end.w) - 2.4) < 1e-6);
});

test('QuatAngleTracker unwraps the relative quaternion continuously', () => {
  const tracker = new QuatAngleTracker(qFromAxisAngle(v3(1, 0, 0), Math.PI - 0.01));
  tracker.push(qFromAxisAngle(v3(1, 0, 0), -Math.PI + 0.01));
  assert.ok(tracker.continuous > Math.PI);
  assert.ok(tracker.lastDelta > 0 && tracker.lastDelta < 0.05);
});
