import test from 'node:test';
import assert from 'node:assert/strict';
import RAPIER from '@dimforge/rapier3d-compat';
import { buildScene } from '../src/scene/build.js';

const D = Math.PI / 180;
await RAPIER.init();

function newScene(opts = {}) {
  const scene = buildScene(RAPIER, { dt: 1 / 120, solverIterations: 6, ...opts });
  scene.settle(0.5);
  return scene;
}

test('hinges assemble with sub-millimetre anchor error at rest', () => {
  const scene = newScene();
  for (const h of Object.values(scene.hinges)) {
    assert.ok(h.anchorErr < 5e-4, `${h.id} anchor error ${h.anchorErr}`);
    assert.ok(h.axisErr < 5e-4, `${h.id} axis error ${h.axisErr}`);
    assert.ok(Math.abs(h.angle) < 0.01, `${h.id} rest angle ${h.angle}`);
  }
});

test('anchor error stays sub-millimetre while a joint is driven', () => {
  const scene = newScene();
  const elbow = scene.hinges.elbow;
  scene.assembly.setTarget('elbow', 60 * D);
  scene.assembly.runSteps(360, 1 / 120);
  assert.ok(elbow.anchorErr < 1e-3, `anchor error ${elbow.anchorErr}`);
  scene.assembly.setTarget('shoulder', -30 * D);
  scene.assembly.runSteps(300, 1 / 120);
  assert.ok(scene.hinges.shoulder.anchorErr < 1e-3);
  assert.ok(scene.hinges.elbow.anchorErr < 1e-3);
});

test('limits are respected within solver precision', () => {
  // The shoulder has a clear arc, so its angle limit is the only thing that can
  // stop it. (The elbow is deliberately blocked by a pad before its limit.)
  const scene = newScene();
  const shoulder = scene.hinges.shoulder;
  scene.assembly.setTarget('shoulder', 80 * D);
  scene.assembly.runSteps(900, 1 / 120);
  const degrees = shoulder.angle / D;
  assert.ok(degrees <= 35 + 0.5, `shoulder passed its limit: ${degrees}`);
  assert.ok(degrees > 25, `shoulder never approached its limit: ${degrees}`);
  assert.ok(Math.abs(shoulder.limitErr) < 1e-3);
});

test('contact in the swing path blocks the joint before its angle limit', () => {
  const scene = newScene();
  const elbow = scene.hinges.elbow;
  scene.assembly.setTarget('elbow', 110 * D);
  scene.assembly.runSteps(900, 1 / 120);
  const degrees = elbow.angle / D;
  assert.ok(degrees < 100, `expected contact to stop the arm early, got ${degrees}`);
  assert.ok(degrees > 45, `arm stopped implausibly early at ${degrees}`);
  assert.ok(elbow.contact.others.includes('stop pad'), `contact list ${elbow.contact.others}`);
  assert.ok(Math.abs(elbow.limitErr) < 1e-3, 'limit itself must not be violated');
});

test('door is stopped by the crate, not by its angle limit', () => {
  const scene = newScene();
  const door = scene.hinges.door;
  scene.assembly.setTarget('door', 96 * D);
  scene.assembly.runSteps(600, 1 / 120);
  assert.ok(door.contact.others.includes('crate'), `door contacts ${door.contact.others}`);
  assert.ok(door.angle / D < 90, `door reached ${door.angle / D} deg despite the crate`);
  assert.ok(Math.abs(door.limitErr) < 1e-3);
});

test('removing the blocking body lets the joint resume and reach its limit', () => {
  const scene = newScene();
  const elbow = scene.hinges.elbow;
  scene.assembly.setTarget('elbow', 110 * D);
  scene.assembly.runSteps(600, 1 / 120);
  const blockedAngle = elbow.angle / D;
  assert.ok(blockedAngle < 100);
  // Remove the stop pad colliders while the joint is pressed against them.
  for (const item of scene.items) {
    if (item.label === 'stop pad') scene.world.removeCollider(item.collider, true);
  }
  // Also remove the pad's bracket/column, which are unlabelled statics near it.
  for (const item of scene.items) {
    if (item.kind === 'static' && item.collider.parent()?.isFixed()) {
      const p = item.collider.translation();
      if (Math.hypot(p.x - scene.meta.padCenter.x, p.z - scene.meta.padCenter.z) < 0.9 && p.y > 1.5) {
        scene.world.removeCollider(item.collider, true);
      }
    }
  }
  scene.assembly.runSteps(900, 1 / 120);
  assert.ok(elbow.angle / D > blockedAngle + 20, `arm did not resume: ${blockedAngle} -> ${elbow.angle / D}`);
});

test('door can be pushed from both faces by the player', () => {
  function push(side) {
    const scene = newScene();
    const { hinges, playerState, placePlayer, setPlayerVelocity } = scene;
    const door = hinges.door;
    const pivot = scene.meta.doorPivot;
    const mid = { x: pivot.x + 0.72, y: 1.15, z: 0 };
    const sign = side === 'front' ? -1 : 1;
    const start = { x: mid.x, y: 0.95, z: sign * 1.35 };
    scene.placePlayer(start, Math.atan2(mid.x - start.x, mid.z - start.z));
    playerState.enabled = true;
    playerState.forward = 1;
    for (let i = 0; i < 420; i++) {
      setPlayerVelocity();
      scene.assembly.advance(1 / 120);
    }
    playerState.forward = 0;
    for (let i = 0; i < 120; i++) {
      setPlayerVelocity();
      scene.assembly.advance(1 / 120);
    }
    return { angle: door.angle / D, anchor: door.anchorErr, contact: door.contact.others };
  }
  const front = push('front');
  const back = push('back');
  // Front face pushes the door toward its negative (closed) stop; back face opens it.
  assert.ok(front.angle < -2, `front push angle ${front.angle}`);
  assert.ok(back.angle > 20, `back push angle ${back.angle}`);
  assert.ok(front.anchor < 1e-3 && back.anchor < 1e-3);
});

test('rotation-installed arm still reads correct world angles', () => {
  const scene = buildScene(RAPIER, { dt: 1 / 120, solverIterations: 6 });
  scene.settle(0.4);
  const shoulder = scene.hinges.shoulder;
  const elbow = scene.hinges.elbow;
  // The mount is deliberately yawed and tilted, so parent/child frames differ.
  assert.ok(Math.abs(scene.meta.mountYawDeg) > 10, `yaw ${scene.meta.mountYawDeg}`);
  assert.ok(Math.abs(scene.meta.mountTiltDeg) > 3, `tilt ${scene.meta.mountTiltDeg}`);
  scene.assembly.setTarget('shoulder', 20 * D);
  scene.assembly.setTarget('elbow', 40 * D);
  scene.assembly.runSteps(600, 1 / 120);
  assert.ok(Math.abs(shoulder.angle / D - 20) < 3, `shoulder ${shoulder.angle / D}`);
  assert.ok(Math.abs(elbow.angle / D - 40) < 6, `elbow ${elbow.angle / D}`);
  assert.ok(shoulder.anchorErr < 1e-3);
  assert.ok(elbow.anchorErr < 1e-3);
  // The world hinge axes must match the declared ones.
  const mount = scene.meta.armMount;
  const d = (a, b) => Math.abs(a.x * b.x + a.y * b.y + a.z * b.z);
  assert.ok(d(shoulder.worldAxisA(), scene.meta.shoulderAxis) > 0.9999);
  // The elbow axis rides with link 1, so compare the two ends of that hinge
  // rather than the initial world direction.
  assert.ok(d(elbow.worldAxisA(), elbow.worldAxisB()) > 0.9999);
});

test('solver settings change reported error and cost, not just appearance', () => {
  const results = [];
  for (const dt of [1 / 60, 1 / 120, 1 / 240]) {
    for (const iterations of [2, 6, 12]) {
      const scene = buildScene(RAPIER, { dt, solverIterations: iterations });
      scene.settle(0.4);
      scene.assembly.setTarget('shoulder', 25 * D);
      scene.assembly.setTarget('elbow', 70 * D);
      const seconds = 3;
      const steps = Math.round(seconds / dt);
      const elapsed = scene.assembly.runSteps(steps, dt);
      const hinges = Object.values(scene.hinges);
      const maxAnchor = Math.max(...hinges.map((h) => h.anchorErr));
      results.push({
        dt,
        iterations,
        maxAnchor,
        ms: elapsed,
        msPerSecond: elapsed / seconds,
        stepCount: steps,
      });
    }
  }
  // Every configuration must keep the pivot together.
  for (const r of results) {
    assert.ok(r.maxAnchor < 0.01, `dt=${r.dt} it=${r.iterations} anchor ${r.maxAnchor}`);
    assert.ok(r.msPerSecond < 2000, `dt=${r.dt} it=${r.iterations} too slow: ${r.msPerSecond} ms/s`);
  }
  // More work must cost more: 12 iterations at 1/240 should cost more than 2 at 1/60.
  const cheapest = results.find((r) => r.dt === 1 / 60 && r.iterations === 2);
  const heaviest = results.find((r) => r.dt === 1 / 240 && r.iterations === 12);
  assert.ok(heaviest.msPerSecond > cheapest.msPerSecond, `${heaviest.msPerSecond} vs ${cheapest.msPerSecond}`);
});

test('continuous angle keeps a small seam crossing small after physical simulation', async () => {
  // A free door on an unlimited hinge: spin it fast enough that the raw reading
  // passes through the +/-PI seam inside the simulated window.
  const R = RAPIER;
  const world = new R.World({ x: 0, y: 0, z: 0 });
  const { HingeAssembly } = await import('../src/core/hinges.js');
  const assembly = new HingeAssembly(R, world, { dt: 1 / 120, solverIterations: 6 });
  const parent = world.createRigidBody(R.RigidBodyDesc.fixed());
  const panel = world.createRigidBody(
    R.RigidBodyDesc.dynamic().setTranslation(0.6, 0, 0).setLinearDamping(0).setAngularDamping(0).setCanSleep(false)
  );
  world.createCollider(R.ColliderDesc.cuboid(0.6, 0.4, 0.03).setMass(6), panel);
  const hinge = assembly.addHinge({
    id: 'spin',
    bodyA: parent,
    bodyB: panel,
    localAnchorA: { x: 0, y: 0, z: 0 },
    localAnchorB: { x: -0.6, y: 0, z: 0 },
    localAxisA: { x: 0, y: 1, z: 0 },
    localAxisB: { x: 0, y: 1, z: 0 },
    continuous: true,
    target: 0,
    motorStiffness: 0,
    motorDamping: 0,
    motorMaxForce: 0,
    gravityFeedForward: false,
  });
  panel.setAngvel({ x: 0, y: 6.0, z: 0 }, true);

  const samples = [];
  for (let i = 0; i < 360; i++) {
    world.step();
    assembly.sample();
    samples.push({ raw: hinge.rawAngleValue, continuous: hinge.angle });
  }
  let seamIndex = -1;
  for (let i = 1; i < samples.length; i++) {
    if (Math.abs(samples[i].raw - samples[i - 1].raw) > Math.PI) {
      seamIndex = i;
      break;
    }
  }
  assert.ok(seamIndex > 0, 'spin never crossed the seam; test did not exercise the case');
  const step = samples[seamIndex].continuous - samples[seamIndex - 1].continuous;
  assert.ok(Math.abs(step) < 0.15, `seam step was ${(step / D).toFixed(2)} deg`);
  assert.ok(Math.abs(hinge.angle) > Math.PI, `continuous angle did not pass PI: ${hinge.angle}`);
});
