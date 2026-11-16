import { qFromAxisAngle, qMul, qRotate, v3, vAdd, vScale } from '../src/core/math.js';
import { ASSET_FORMAT } from '../src/scene/loader.js';

const D = Math.PI / 180;

/** Every knob the dock scene is built from; recorded into the asset's meta. */
export const DOCK_PARAMS = {
  gatePivot: [0.85, 1.15, 0],
  gateHalf: [0.83, 1.1, 0.04],
  gateAxis: [0, -1, 0], // reversed: positive angle swings the panel toward -Z
  gateLimits: [-6, 96],
  bollardAngleDeg: 70,
  bollardRadius: 1.45,
  armYawDeg: -48,
  armDropDeg: -80, // mount roll: link direction points mostly downward
  shoulderPivot: [3.2, 2.56, -1.0],
  link1Len: 0.85,
  link2Len: 0.75,
  shoulderLimits: [-115, 25],
  elbowLimits: [-125, 0],
  playerStart: [-2.0, 0.95, 2.2],
};

export function defineDockAsset(P = DOCK_PARAMS) {
  const mount = qMul(qFromAxisAngle(v3(0, 1, 0), P.armYawDeg * D), qFromAxisAngle(v3(0, 0, 1), P.armDropDeg * D));
  const mountQ = [mount.x, mount.y, mount.z, mount.w];
  const mountX = qRotate(mount, v3(1, 0, 0));
  const armAxis = qRotate(mount, v3(0, 0, 1));
  const shoulderPivot = v3(...P.shoulderPivot);
  const elbowPivot = vAdd(shoulderPivot, vScale(mountX, P.link1Len));
  const link1Center = vAdd(shoulderPivot, vScale(mountX, P.link1Len * 0.5));
  const link2Center = vAdd(elbowPivot, vScale(mountX, P.link2Len * 0.5));

  const gatePivot = v3(...P.gatePivot);
  const bollardAngle = P.bollardAngleDeg * D;
  // The gate panel hangs along -X from its pivot; a positive (reversed) swing
  // moves it toward -Z, so the bollard sits on that arc.
  const bollardPos = vAdd(gatePivot, v3(-P.bollardRadius * Math.cos(bollardAngle), 0, -P.bollardRadius * Math.sin(bollardAngle)));

  const toolLocalX = P.link2Len * 0.5 + 0.1;

  return {
    format: ASSET_FORMAT,
    id: 'dock-gate-arm',
    title: 'Loading dock: reversed gate + ceiling arm',
    meta: {
      source: 'scripts/build-assets.mjs',
      params: P,
      createdAt: new Date().toISOString(),
    },
    solver: { dt: 1 / 120, iterations: 12 },
    gravity: [0, -9.81, 0],
    cameras: {
      overview: { position: [7.6, 5.4, 7.4], lookAt: [0.9, 1.2, -0.4] },
      door: { position: [0.2, 2.3, 4.6], lookAt: [0.1, 1.2, 0] },
      arm: { position: [5.8, 3.6, 1.6], lookAt: [3.2, 1.7, -1.0] },
      player: { position: [-0.6, 2.4, 4.8], lookAt: [-1.4, 1.0, 1.6] },
    },
    bodies: [
      {
        id: 'ground',
        type: 'fixed',
        colliders: [
          { shape: 'cuboid', half: [8, 0.1, 8], translation: [0, -0.1, 0], friction: 0.9, kind: 'ground', color: 0x39424d, label: 'ground' },
        ],
      },
      {
        id: 'frame',
        type: 'fixed',
        colliders: [
          { shape: 'cuboid', half: [0.1, 1.2, 0.12], translation: [-0.95, 1.2, 0], friction: 0.8, kind: 'wall', color: 0x8d939c, label: 'gate post' },
          { shape: 'cuboid', half: [0.1, 1.2, 0.12], translation: [0.95, 1.2, 0], friction: 0.8, kind: 'wall', color: 0x8d939c, label: 'gate post' },
          { shape: 'cuboid', half: [1.05, 0.12, 0.12], translation: [0, 2.42, 0], friction: 0.8, kind: 'wall', color: 0x8d939c, label: 'lintel' },
          { shape: 'cuboid', half: [1.5, 1.2, 0.09], translation: [-2.55, 1.2, 0], friction: 0.8, kind: 'wall', color: 0x7d838c, label: 'wall wing' },
          { shape: 'cuboid', half: [1.5, 1.2, 0.09], translation: [2.55, 1.2, 0], friction: 0.8, kind: 'wall', color: 0x7d838c, label: 'wall wing' },
        ],
      },
      {
        id: 'gate',
        type: 'dynamic',
        translation: [0, 1.15, 0],
        angularDamping: 0.25,
        colliders: [
          { shape: 'cuboid', half: P.gateHalf, density: 140, friction: 0.55, kind: 'door', color: 0x7fa8c9, edge: 0x3d5a74, label: 'gate panel' },
          { shape: 'cuboid', half: [0.03, 0.075, 0.032], translation: [-0.62, -0.2, -0.085], density: 400, friction: 0.4, kind: 'handle', color: 0xd9dee5, label: 'gate handle' },
          { shape: 'cuboid', half: [0.05, 0.06, 0.012], translation: [-0.62, -0.2, -0.052], density: 300, kind: 'handle', color: 0x8d949c, label: 'gate handle' },
        ],
      },
      {
        id: 'bollard',
        type: 'fixed',
        colliders: [
          { shape: 'cuboid', half: [0.09, 0.5, 0.09], translation: [bollardPos.x, 0.5, bollardPos.z], friction: 0.7, kind: 'obstacle', color: 0xf0a23f, label: 'bollard' },
        ],
      },
      {
        id: 'gantry',
        type: 'fixed',
        colliders: [
          { shape: 'cuboid', half: [1.1, 0.06, 0.08], translation: [3.2, 2.66, -1.0], friction: 0.8, kind: 'static', color: 0x4a5560, label: 'gantry rail' },
          { shape: 'cuboid', half: [0.05, 1.3, 0.05], translation: [2.15, 1.3, -1.0], friction: 0.8, kind: 'static', color: 0x424c58, label: 'gantry leg' },
          { shape: 'cuboid', half: [0.05, 1.3, 0.05], translation: [4.25, 1.3, -1.0], friction: 0.8, kind: 'static', color: 0x424c58, label: 'gantry leg' },
        ],
      },
      {
        id: 'link1',
        type: 'dynamic',
        translation: [link1Center.x, link1Center.y, link1Center.z],
        rotation: mountQ,
        colliders: [
          { shape: 'cuboid', half: [P.link1Len * 0.5, 0.065, 0.05], density: 2300, friction: 0.5, kind: 'arm', color: 0x59b0d6, edge: 0x2a6b8a, label: 'upper link' },
        ],
      },
      {
        id: 'link2',
        type: 'dynamic',
        translation: [link2Center.x, link2Center.y, link2Center.z],
        rotation: mountQ,
        colliders: [
          { shape: 'cuboid', half: [P.link2Len * 0.5, 0.055, 0.045], density: 2000, friction: 0.5, kind: 'arm', color: 0x3f8fb8, edge: 0x235672, label: 'fore link' },
          { shape: 'cuboid', half: [0.1, 0.1, 0.1], translation: [toolLocalX, 0, 0], density: 1500, friction: 0.6, kind: 'arm', color: 0x9fb4c8, label: 'tool head' },
          { shape: 'cuboid', half: [0.025, 0.06, 0.06], translation: [toolLocalX + 0.12, 0, 0], density: 1200, kind: 'arm', color: 0x5b6673, label: 'tool tip' },
        ],
      },
      {
        id: 'pallet',
        type: 'fixed',
        colliders: [
          { shape: 'cuboid', half: [0.5, 0.07, 0.4], translation: [-1.9, 0.07, -1.1], friction: 0.8, kind: 'static', color: 0x8a6b42, label: 'pallet' },
          { shape: 'cuboid', half: [0.34, 0.26, 0.3], translation: [-1.9, 0.4, -1.1], friction: 0.75, kind: 'obstacle', color: 0x9a6d3c, edge: 0x64471f, label: 'crate' },
        ],
      },
    ],
    hinges: [
      {
        id: 'gate', label: 'Dock gate', group: 'door',
        parent: 'frame', child: 'gate',
        pivot: P.gatePivot, axis: P.gateAxis,
        minDeg: P.gateLimits[0], maxDeg: P.gateLimits[1], targetDeg: 0,
        motor: { stiffness: 90, damping: 14, maxForce: 900 },
      },
      {
        id: 'shoulder', label: 'Shoulder', group: 'arm',
        parent: 'gantry', child: 'link1',
        pivot: P.shoulderPivot, axis: [armAxis.x, armAxis.y, armAxis.z],
        minDeg: P.shoulderLimits[0], maxDeg: P.shoulderLimits[1], targetDeg: 0,
        motor: { stiffness: 1800, damping: 150, maxForce: 9000 },
      },
      {
        id: 'elbow', label: 'Elbow', group: 'arm',
        parent: 'link1', child: 'link2',
        pivot: [elbowPivot.x, elbowPivot.y, elbowPivot.z], axis: [armAxis.x, armAxis.y, armAxis.z],
        minDeg: P.elbowLimits[0], maxDeg: P.elbowLimits[1], targetDeg: 0,
        motor: { stiffness: 1400, damping: 110, maxForce: 6000 },
      },
    ],
    player: { start: P.playerStart },
    script: [
      { t: 0.2, op: 'setTarget', joint: 'gate', deg: 96 },
      { t: 3.4, op: 'setTarget', joint: 'gate', deg: -6 },
      { t: 6.0, op: 'setTarget', joint: 'gate', deg: 0 },
      { t: 7.0, op: 'setTarget', joint: 'shoulder', deg: -115 },
      { t: 9.5, op: 'setTarget', joint: 'elbow', deg: -100 },
      { t: 11.0, op: 'setTarget', joint: 'elbow', deg: -125 },
      { t: 13.0, op: 'setTarget', joint: 'shoulder', deg: -40 },
      { t: 13.0, op: 'setTarget', joint: 'elbow', deg: -60 },
      { t: 15.0, op: 'setLimits', joint: 'elbow', minDeg: -100, maxDeg: -5 },
      { t: 15.1, op: 'setTarget', joint: 'elbow', deg: -100 },
    ],
    scriptDuration: 17.5,
  };
}
