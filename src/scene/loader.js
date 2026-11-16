import { HingeAssembly } from '../core/hinges.js';
import { v3, vSub, vLen, vDot } from '../core/math.js';
import { hingeConfig } from './hinge-config.js';
import { createPlayerRig } from './player.js';

const D = Math.PI / 180;
export const ASSET_FORMAT = 'hinge-scene/1';

const vec = (a, name) => {
  if (!Array.isArray(a) || a.length !== 3 || a.some((v) => !Number.isFinite(v))) {
    throw new Error(`asset: ${name} must be a [x, y, z] array of finite numbers`);
  }
  return v3(a[0], a[1], a[2]);
};

const quat = (a, name) => {
  if (a == null) return null;
  if (!Array.isArray(a) || a.length !== 4 || a.some((v) => !Number.isFinite(v))) {
    throw new Error(`asset: ${name} must be a [x, y, z, w] array of finite numbers`);
  }
  return { x: a[0], y: a[1], z: a[2], w: a[3] };
};

const num = (v, name) => {
  if (!Number.isFinite(v)) throw new Error(`asset: ${name} must be a finite number`);
  return v;
};

/**
 * Structural validation for a hinge-scene asset. Throws on anything malformed;
 * a scene is only ever built from an asset that passed through here.
 */
export function validateAsset(asset) {
  if (!asset || typeof asset !== 'object') throw new Error('asset: not an object');
  if (asset.format !== ASSET_FORMAT) throw new Error(`asset: format must be "${ASSET_FORMAT}", got ${JSON.stringify(asset.format)}`);
  if (!asset.id || typeof asset.id !== 'string') throw new Error('asset: id must be a non-empty string');
  if (!Array.isArray(asset.bodies) || asset.bodies.length === 0) throw new Error('asset: bodies must be a non-empty array');
  if (!Array.isArray(asset.hinges)) throw new Error('asset: hinges must be an array');

  const bodyIds = new Set();
  for (const b of asset.bodies) {
    if (!b.id || typeof b.id !== 'string') throw new Error('asset: every body needs an id');
    if (bodyIds.has(b.id)) throw new Error(`asset: duplicate body id "${b.id}"`);
    bodyIds.add(b.id);
    if (b.type !== 'fixed' && b.type !== 'dynamic') throw new Error(`asset: body "${b.id}" type must be fixed|dynamic`);
    if (!Array.isArray(b.colliders)) throw new Error(`asset: body "${b.id}" needs a colliders array`);
    vec(b.translation ?? [0, 0, 0], `body "${b.id}" translation`);
    quat(b.rotation, `body "${b.id}" rotation`);
    for (const c of b.colliders) {
      if (c.shape !== 'cuboid') throw new Error(`asset: body "${b.id}" collider shape must be "cuboid", got ${JSON.stringify(c.shape)}`);
      vec(c.half, `body "${b.id}" collider half`);
      vec(c.translation ?? [0, 0, 0], `body "${b.id}" collider translation`);
      quat(c.rotation, `body "${b.id}" collider rotation`);
    }
  }
  for (const h of asset.hinges) {
    if (!h.id || typeof h.id !== 'string') throw new Error('asset: every hinge needs an id');
    if (!bodyIds.has(h.parent)) throw new Error(`asset: hinge "${h.id}" parent "${h.parent}" is not a body`);
    if (!bodyIds.has(h.child)) throw new Error(`asset: hinge "${h.id}" child "${h.child}" is not a body`);
    vec(h.pivot, `hinge "${h.id}" pivot`);
    const axis = vec(h.axis, `hinge "${h.id}" axis`);
    if (vLen(axis) < 1e-6) throw new Error(`asset: hinge "${h.id}" axis must be non-zero`);
    if (!h.continuous) {
      num(h.minDeg, `hinge "${h.id}" minDeg`);
      num(h.maxDeg, `hinge "${h.id}" maxDeg`);
      if (h.minDeg > h.maxDeg) throw new Error(`asset: hinge "${h.id}" minDeg > maxDeg`);
    }
    num(h.targetDeg ?? 0, `hinge "${h.id}" targetDeg`);
  }
  for (const op of asset.script ?? []) {
    if (!Number.isFinite(op.t) || op.t < 0) throw new Error('asset: every script op needs a non-negative t');
    if (op.op === 'setTarget') {
      num(op.deg, `script setTarget for "${op.joint}" deg`);
    } else if (op.op === 'setLimits') {
      num(op.minDeg, `script setLimits for "${op.joint}" minDeg`);
      num(op.maxDeg, `script setLimits for "${op.joint}" maxDeg`);
    } else {
      throw new Error(`asset: unknown script op ${JSON.stringify(op.op)}`);
    }
    if (!asset.hinges.some((h) => h.id === op.joint)) throw new Error(`asset: script references unknown joint "${op.joint}"`);
  }
  if (asset.player) vec(asset.player.start, 'player start');
  return true;
}

/**
 * Rebuilds a fully drivable drill scene from a hinge-scene asset. The returned
 * object has the same shape as buildScene's, so the viewport, panel and
 * interaction layers work on it unchanged.
 */
export function buildSceneFromAsset(RAPIER, asset, opts = {}) {
  validateAsset(asset);

  const world = new RAPIER.World(asset.gravity ? vec(asset.gravity, 'gravity') : { x: 0, y: -9.81, z: 0 });
  const labels = new Map();
  const items = [];
  const assembly = new HingeAssembly(RAPIER, world, {
    dt: opts.dt ?? asset.solver?.dt ?? 1 / 120,
    solverIterations: opts.solverIterations ?? asset.solver?.iterations ?? 6,
    colliderLabels: labels,
  });

  function solid(desc, body, visual) {
    const collider = world.createCollider(desc, body);
    labels.set(collider.handle, visual.label ?? visual.kind ?? 'collider');
    const item = { collider, ...visual };
    items.push(item);
    return item;
  }

  const bodies = new Map();
  for (const spec of asset.bodies) {
    const t = vec(spec.translation ?? [0, 0, 0], `body "${spec.id}" translation`);
    const r = quat(spec.rotation, `body "${spec.id}" rotation`);
    let desc;
    if (spec.type === 'fixed') {
      desc = RAPIER.RigidBodyDesc.fixed().setTranslation(t.x, t.y, t.z);
    } else {
      desc = RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(t.x, t.y, t.z)
        .setLinearDamping(spec.linearDamping ?? 0.1)
        .setAngularDamping(spec.angularDamping ?? 0.15)
        .setCcdEnabled(spec.ccd ?? true)
        .setCanSleep(false);
    }
    if (r) desc = desc.setRotation(r);
    const body = world.createRigidBody(desc);
    bodies.set(spec.id, body);

    for (const c of spec.colliders) {
      const half = vec(c.half, 'collider half');
      const ct = vec(c.translation ?? [0, 0, 0], 'collider translation');
      const cr = quat(c.rotation, 'collider rotation');
      let desc2 = RAPIER.ColliderDesc.cuboid(half.x, half.y, half.z).setTranslation(ct.x, ct.y, ct.z);
      if (cr) desc2 = desc2.setRotation(cr);
      if (c.density != null) desc2 = desc2.setDensity(num(c.density, 'collider density'));
      if (c.friction != null) desc2 = desc2.setFriction(num(c.friction, 'collider friction'));
      solid(desc2, body, {
        shape: 'cuboid',
        half,
        color: c.color ?? 0x8a929c,
        kind: c.kind ?? 'static',
        label: c.label,
        edge: c.edge,
        receiveShadow: c.kind === 'ground',
      });
    }
  }

  const hinges = {};
  for (const spec of asset.hinges) {
    const hinge = assembly.addHinge(
      hingeConfig({
        id: spec.id,
        label: spec.label ?? spec.id,
        group: spec.group ?? 'rig',
        parent: bodies.get(spec.parent),
        child: bodies.get(spec.child),
        pivot: vec(spec.pivot, `hinge "${spec.id}" pivot`),
        axis: vec(spec.axis, `hinge "${spec.id}" axis`),
        min: spec.continuous ? -180 : spec.minDeg,
        max: spec.continuous ? 180 : spec.maxDeg,
        target: spec.targetDeg ?? 0,
        continuous: Boolean(spec.continuous),
        motorStiffness: spec.motor?.stiffness ?? 60,
        motorDamping: spec.motor?.damping ?? 8,
        motorMaxForce: spec.motor?.maxForce ?? 300,
      })
    );
    hinges[spec.id] = hinge;
  }
  assembly.sample();

  let rig = {};
  if (asset.player) {
    rig = createPlayerRig(RAPIER, world, items, labels, vec(asset.player.start, 'player start'));
  }

  function settle(seconds = 0.4) {
    const steps = Math.max(1, Math.round(seconds / assembly.dt));
    for (let i = 0; i < steps; i++) {
      world.step();
      assembly.sample();
    }
  }

  const meta = {
    assetId: asset.id,
    title: asset.title ?? asset.id,
    cameras: asset.cameras ?? null,
    playerStart: asset.player ? vec(asset.player.start, 'player start') : null,
  };

  return {
    RAPIER, world, assembly, hinges, items, labels, meta, settle, asset,
    player: rig.player ?? null,
    playerCollider: rig.playerCollider ?? null,
    playerState: rig.playerState ?? null,
    setPlayerVelocity: rig.setPlayerVelocity ?? (() => {}),
    setPlayerYaw: rig.setPlayerYaw ?? (() => {}),
    placePlayer: rig.placePlayer ?? (() => {}),
    resetPlayer: rig.resetPlayer ?? (() => {}),
  };
}

/**
 * Conformance check between a freshly rebuilt scene and its asset: every hinge
 * must sit on its declared pivot and axis with the declared limits, and the
 * joint diagnostics must be clean before any motion. This is what "the
 * reconstruction matches the spec" means, measured on the kernel itself.
 */
export function checkReconstruction(scene, asset) {
  const checks = [];
  for (const spec of asset.hinges) {
    const h = scene.assembly.get(spec.id);
    if (!h) {
      checks.push({ hinge: spec.id, ok: false, detail: 'missing from assembly' });
      continue;
    }
    const axis = vec(spec.axis, 'axis');
    const pivot = vec(spec.pivot, 'pivot');
    const axisDot = vDot(h.worldAxisA(), axis) / (vLen(axis) || 1);
    const anchorGap = vLen(vSub(h.worldAnchorA(), pivot));
    const rows = [
      ['anchor to declared pivot (mm)', anchorGap * 1000, (v) => v < 1e-3],
      ['kernel anchor error (mm)', h.anchorErr * 1000, (v) => v < 1e-3],
      ['axis alignment |dot|', Math.abs(axisDot), (v) => v > 1 - 1e-6],
      ['kernel axis error (deg)', h.axisErr / D, (v) => v < 1e-3],
    ];
    if (!spec.continuous) {
      rows.push(
        ['min limit (deg)', h.min / D - spec.minDeg, (v) => Math.abs(v) < 1e-6],
        ['max limit (deg)', h.max / D - spec.maxDeg, (v) => Math.abs(v) < 1e-6]
      );
    }
    const failed = rows.filter(([, v, ok]) => !ok(v));
    checks.push({
      hinge: spec.id,
      ok: failed.length === 0,
      detail: failed.length ? failed.map(([name, v]) => `${name}=${v}`).join(', ') : 'conforms',
      measured: Object.fromEntries(rows.map(([name, v]) => [name, v])),
    });
  }
  return { ok: checks.every((c) => c.ok), checks };
}

/**
 * Serialises the live scene back into an editable asset. Geometry comes from
 * the asset the scene was built from (that is what really constructed the
 * world); limits, targets and solver settings are read back from the kernel,
 * so an export captures exactly what the user dialled in.
 */
export function exportSceneAsset(scene) {
  const src = scene.asset;
  if (!src) return null;
  const out = JSON.parse(JSON.stringify(src));
  const r1 = (v) => Math.round(v * 10) / 10;
  for (const hs of out.hinges) {
    const h = scene.assembly.get(hs.id);
    if (!h || h.continuous) continue;
    hs.minDeg = r1(h.min / D);
    hs.maxDeg = r1(h.max / D);
    hs.targetDeg = r1(h.target / D);
  }
  out.solver = { dt: scene.assembly.dt, iterations: scene.assembly.solverIterations };
  out.meta = {
    ...(src.meta ?? {}),
    exportedAt: new Date().toISOString(),
    exportedFrom: 'contact-drill-ui',
  };
  return out;
}
