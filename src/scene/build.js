import {
  qFromAxisAngle,
  qMul,
  qRotate,
  v3,
  vAdd,
  vScale,
} from '../core/math.js';
import { HingeAssembly } from '../core/hinges.js';
import { hingeConfig } from './hinge-config.js';
import { createPlayerRig } from './player.js';

const D = Math.PI / 180;

export function buildScene(RAPIER, opts = {}) {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  const labels = new Map();
  const items = [];
  const assembly = new HingeAssembly(RAPIER, world, {
    dt: opts.dt ?? 1 / 120,
    solverIterations: opts.solverIterations ?? 6,
    colliderLabels: labels,
  });

  /**
   * Single source of truth for a solid: the collider. Rendering reads the collider's
   * world transform every frame, so a body can never render somewhere its collision
   * shape is not.
   */
  function solid(desc, body, visual) {
    const collider = world.createCollider(desc, body);
    // Every collider is labelled, so contact diagnostics always name the thing
    // the joint ran into instead of leaking an opaque Rapier handle.
    labels.set(collider.handle, visual.label ?? visual.kind ?? 'collider');
    const item = { collider, ...visual };
    items.push(item);
    return item;
  }

  const box = (hx, hy, hz, t = v3(), r = null) => {
    let d = RAPIER.ColliderDesc.cuboid(hx, hy, hz).setTranslation(t.x, t.y, t.z);
    if (r) d = d.setRotation(r);
    return d;
  };

  const staticBody = () => world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const dynBody = (pos, rot) => {
    let d = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(pos.x, pos.y, pos.z)
      .setLinearDamping(0.1)
      .setAngularDamping(0.15)
      .setCcdEnabled(true)
      .setCanSleep(false);
    if (rot) d = d.setRotation(rot);
    return world.createRigidBody(d);
  };

  // --- Ground ---------------------------------------------------------------
  const ground = staticBody();
  solid(box(7, 0.1, 7, v3(0, -0.1, 0)).setFriction(0.9), ground, {
    shape: 'cuboid', half: v3(7, 0.1, 7), color: 0x3a434e, kind: 'ground', receiveShadow: true,
  });
  solid(box(0.3, 0.06, 0.32, v3(-2.2, 0.06, -1.0)).setFriction(0.9), ground, {
    shape: 'cuboid', half: v3(0.3, 0.06, 0.32), color: 0x2f3742, kind: 'static',
  });

  // --- Wall with a doorway --------------------------------------------------
  const wall = staticBody();
  const wallSolid = (half, offset, color = 0x898f99) =>
    solid(box(half.x, half.y, half.z, offset).setFriction(0.8), wall, {
      shape: 'cuboid', half, color, kind: 'wall',
    });
  wallSolid(v3(2.425, 1.5, 0.09), v3(-3.575, 1.5, 0));
  wallSolid(v3(2.175, 1.5, 0.09), v3(2.825, 1.5, 0));
  wallSolid(v3(4.575, 0.375, 0.09), v3(-0.375, 2.625, 0));
  // Trim around the opening.
  wallSolid(v3(0.055, 1.18, 0.11), v3(-1.155, 1.18, 0), 0x6e747d);
  wallSolid(v3(0.055, 1.18, 0.11), v3(0.555, 1.18, 0), 0x6e747d);
  wallSolid(v3(0.91, 0.06, 0.11), v3(-0.3, 2.3, 0), 0x6e747d);
  // Low stops on both faces of the opening.
  wallSolid(v3(0.075, 0.09, 0.055), v3(0.5, 0.09, 0.34), 0x556069);
  wallSolid(v3(0.075, 0.09, 0.055), v3(0.5, 0.09, -0.34), 0x556069);

  // --- Door panel -----------------------------------------------------------
  const doorPivot = v3(-1.05, 1.18, 0);
  const doorHalf = v3(0.75, 1.0, 0.035);
  const doorCenter = v3(-0.27, 1.15, 0);
  const doorBody = dynBody(doorCenter);
  doorBody.setAngularDamping(0.25);
  solid(box(doorHalf.x, doorHalf.y, doorHalf.z, v3(), null).setDensity(650).setFriction(0.55), doorBody, {
    shape: 'cuboid', half: doorHalf, color: 0xb07a45, kind: 'door', edge: 0x5f3f22,
  });
  const handleLocal = v3(0.62, -0.24, 0);
  solid(box(0.075, 0.03, 0.032, v3(handleLocal.x, handleLocal.y, -0.085)).setDensity(1400).setFriction(0.4), doorBody, {
    shape: 'cuboid', half: v3(0.075, 0.03, 0.032), color: 0xd9dee5, kind: 'handle',
  });
  solid(box(0.06, 0.05, 0.012, v3(handleLocal.x, handleLocal.y, -0.052)).setDensity(1000), doorBody, {
    shape: 'cuboid', half: v3(0.06, 0.05, 0.012), color: 0x8d949c, kind: 'handle',
  });

  // --- Robot arm base -------------------------------------------------------
  const armBase = staticBody();
  const basePos = v3(3.05, 0, -1.6);
  solid(box(0.22, 0.71, 0.22, v3(basePos.x, 0.71, basePos.z)).setFriction(0.8).setDensity(1200), armBase, {
    shape: 'cuboid', half: v3(0.22, 0.71, 0.22), color: 0x424c59, kind: 'static',
  });
  solid(box(0.32, 0.06, 0.32, v3(basePos.x, 1.42, basePos.z)).setDensity(1200), armBase, {
    shape: 'cuboid', half: v3(0.32, 0.06, 0.32), color: 0x2c343d, kind: 'static',
  });

  // Rotated mount: the arm is yawed and tilted, so world axes and body axes differ.
  const mountYaw = (opts.armYawDeg ?? 32) * D;
  const mountTilt = (opts.armTiltDeg ?? -8) * D;
  const armMount = qMul(qFromAxisAngle(v3(0, 1, 0), mountYaw), qFromAxisAngle(v3(0, 0, 1), mountTilt));
  const shoulderPivot = v3(basePos.x, 1.45, basePos.z);
  const shoulderAxis = qRotate(armMount, v3(1, 0, 0));
  const elbowAxis = qRotate(armMount, v3(0, 0, 1));

  const link1Len = 1.0;
  const link1Center = vAdd(shoulderPivot, qRotate(armMount, v3(link1Len * 0.5, 0, 0)));
  const link1 = dynBody(link1Center, armMount);
  solid(box(link1Len * 0.5, 0.07, 0.055).setDensity(2300).setFriction(0.5), link1, {
    shape: 'cuboid', half: v3(link1Len * 0.5, 0.07, 0.055), color: 0xd6a63f, kind: 'arm', edge: 0x8a6519,
  });

  const elbowPivot = vAdd(shoulderPivot, qRotate(armMount, v3(link1Len, 0, 0)));
  const link2Len = 0.9;
  const link2Center = vAdd(elbowPivot, qRotate(armMount, v3(link2Len * 0.5, 0, 0)));
  const link2 = dynBody(link2Center, armMount);
  solid(box(link2Len * 0.5, 0.06, 0.05).setDensity(2000).setFriction(0.5), link2, {
    shape: 'cuboid', half: v3(link2Len * 0.5, 0.06, 0.05), color: 0xc1633a, kind: 'arm', edge: 0x7d3d22,
  });
  const toolLocal = v3(link2Len * 0.5 + 0.12, 0, 0);
  solid(box(0.12, 0.12, 0.12, toolLocal).setDensity(1500).setFriction(0.6), link2, {
    shape: 'cuboid', half: v3(0.12, 0.12, 0.12), color: 0x8fa4bb, kind: 'arm',
  });
  solid(box(0.03, 0.07, 0.07, v3(toolLocal.x + 0.14, 0, 0)).setDensity(1200), link2, {
    shape: 'cuboid', half: v3(0.03, 0.07, 0.07), color: 0x535e6b, kind: 'arm',
  });

  // --- Stop pad in the arm's swing path ------------------------------------
  // The arm sweeps in the plane perpendicular to the elbow axis. Only the pad
  // sits in that plane (inside the tool's reach, well inside the 118 deg limit),
  // so collision must stop the joint before the limit does. The column is offset
  // along the hinge axis, outside the arm's sweep, and joined by a short bracket.
  const padAngle = 68 * D;
  // Furthest point of the tool from the elbow pivot, so the pad's inner face
  // lands just beyond everything the link can reach.
  const linkTipRadius = toolLocal.x + 0.03 + Math.hypot(0.03, 0.07);
  const axialDir = qRotate(armMount, v3(0, 0, 1));
  const padHalf = v3(0.05, 0.08, 0.16);
  // Thin local +x points radially outward, so the pad's inner face is a flat
  // radial wall at padRadius - padHalf.x, and it spans a small angular arc.
  const padRadius = linkTipRadius + padHalf.x + 0.005;
  const padCenter = vAdd(elbowPivot, qRotate(armMount, v3(padRadius * Math.cos(padAngle), padRadius * Math.sin(padAngle), 0)));
  const padRot = qMul(armMount, qFromAxisAngle(v3(0, 0, 1), padAngle));
  const stopPad = staticBody();
  solid(box(padHalf.x, padHalf.y, padHalf.z, padCenter, padRot).setFriction(0.7), stopPad, {
    shape: 'cuboid', half: padHalf, color: 0xf0a23f, kind: 'obstacle', label: 'stop pad',
  });
  const colOffset = 0.52;
  const colCenter = vAdd(padCenter, vScale(axialDir, colOffset));
  solid(box(0.06, Math.max(0.1, colCenter.y * 0.5), 0.06, v3(colCenter.x, colCenter.y * 0.5, colCenter.z)).setFriction(0.7), stopPad, {
    shape: 'cuboid', half: v3(0.06, Math.max(0.1, colCenter.y * 0.5), 0.06), color: 0x59636f, kind: 'static', label: 'stop pad column',
  });
  const bracketMid = vAdd(padCenter, vScale(axialDir, (padHalf.z + colOffset) * 0.5));
  solid(box(0.07, 0.045, (colOffset - padHalf.z) * 0.5, bracketMid, armMount).setFriction(0.7), stopPad, {
    shape: 'cuboid', half: v3(0.07, 0.045, (colOffset - padHalf.z) * 0.5), color: 0x59636f, kind: 'static', label: 'stop pad bracket',
  });

  // --- Crate blocking the door's inward swing ------------------------------
  const cratePos = v3(-0.27, 0.44, -1.52);
  const crateHalf = v3(0.32, 0.44, 0.32);
  const crateBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(cratePos.x, cratePos.y, cratePos.z));
  solid(box(crateHalf.x, crateHalf.y, crateHalf.z).setFriction(0.75), crateBody, {
    shape: 'cuboid', half: crateHalf, color: 0x9a6d3c, kind: 'obstacle', edge: 0x64471f, label: 'crate',
  });

  // --- Player --------------------------------------------------------------
  const playerStart = v3(-2.45, 0.95, -2.05);
  const rig = createPlayerRig(RAPIER, world, items, labels, playerStart);
  const { player, playerCollider, playerState, setPlayerVelocity, setPlayerYaw, placePlayer, resetPlayer } = rig;

  // --- Hinges --------------------------------------------------------------
  const door = assembly.addHinge(
    hingeConfig({
      id: 'door', label: 'Door', group: 'door', parent: wall, child: doorBody,
      pivot: doorPivot, axis: v3(0, 1, 0), min: -5, max: 100, target: 0,
      motorStiffness: 90, motorDamping: 14, motorMaxForce: 900,
    })
  );
  const shoulder = assembly.addHinge(
    hingeConfig({
      id: 'shoulder', label: 'Shoulder', group: 'arm', parent: armBase, child: link1,
      pivot: shoulderPivot, axis: shoulderAxis, min: -55, max: 35, target: 0,
      motorStiffness: 1800, motorDamping: 150, motorMaxForce: 9000,
    })
  );
  const elbow = assembly.addHinge(
    hingeConfig({
      id: 'elbow', label: 'Elbow', group: 'arm', parent: link1, child: link2,
      pivot: elbowPivot, axis: elbowAxis, min: 0, max: 118, target: 0,
      motorStiffness: 1400, motorDamping: 110, motorMaxForce: 6000,
    })
  );
  assembly.sample();

  const meta = {
    doorPivot, shoulderPivot, elbowPivot, doorHalf, link1Len, link2Len,
    armMount, shoulderAxis, elbowAxis, mountYawDeg: mountYaw / D, mountTiltDeg: mountTilt / D,
    playerStart, cratePos, padCenter, padAngle: padAngle / D, linkTipRadius, padHalf,
  };

  function settle(seconds = 0.4) {
    const steps = Math.max(1, Math.round(seconds / assembly.dt));
    for (let i = 0; i < steps; i++) {
      world.step();
      assembly.sample();
    }
  }

  return {
    RAPIER, world, assembly, hinges: { door, shoulder, elbow },
    doorBody, link1, link2, player, playerState, playerCollider,
    items, labels, meta, setPlayerVelocity, setPlayerYaw, placePlayer, resetPlayer, settle,
  };
}
