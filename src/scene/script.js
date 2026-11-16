const D = 180 / Math.PI;

const r4 = (v) => Math.round(v * 1e4) / 1e4;

/**
 * Interaction input scripts. An op is one of:
 *   { t, op: 'setTarget', joint, deg }
 *   { t, op: 'setLimits', joint, minDeg, maxDeg }
 *
 * Ops only command the hinge kernel's motors and limits — exactly what the UI
 * sliders and limit fields do. Motion always comes out of the constraint
 * solver; a script never writes a transform, so a replayed run is a real
 * constraint-driven trajectory, not a keyframed one.
 */
export function applyOp(scene, op) {
  if (op.op === 'setTarget') return scene.assembly.setTarget(op.joint, op.deg / D);
  if (op.op === 'setLimits') return scene.assembly.setLimits(op.joint, op.minDeg / D, op.maxDeg / D);
  throw new Error(`unknown script op ${JSON.stringify(op.op)}`);
}

export function sortOps(script) {
  return [...(script ?? [])].sort((a, b) => a.t - b.t);
}

/** Snapshots every hinge's kernel diagnostics at sim time `t`. */
export function sampleJoints(scene, t) {
  const joints = {};
  for (const h of scene.assembly.hinges) {
    joints[h.id] = {
      a: r4(h.angle * D),
      tg: r4(h.target * D),
      an: r4(h.anchorErr * 1000),
      ax: r4(h.axisErr * D),
      le: r4(h.limitErr * D),
      mn: r4(h.min * D),
      mx: r4(h.max * D),
      c: h.contact.others.slice().sort(),
      b: h.blocked ? h.blocked.by.slice().sort() : [],
    };
  }
  return { t: r4(t), joints };
}

/**
 * Headless script execution: steps the assembly at a fixed dt, applies ops at
 * their sim times and records a sample every `sampleEvery` steps. Returns the
 * raw samples; `summarizeSamples` turns them into the comparable record.
 */
export function runScriptHeadless(scene, script, { dt = scene.assembly.dt, durationSec, sampleEvery = 4 } = {}) {
  const ops = sortOps(script);
  const duration = durationSec ?? (ops.length ? ops[ops.length - 1].t + 1 : 0);
  const samples = [];
  let t = 0;
  let stepIndex = 0;
  scene.assembly.onAfterStep = (dtStep) => {
    t += dtStep;
    stepIndex += 1;
    if (stepIndex % sampleEvery === 0) samples.push(sampleJoints(scene, t));
  };
  try {
    for (const op of ops) {
      const steps = Math.max(0, Math.round((op.t - t) / dt));
      if (steps > 0) scene.assembly.runSteps(steps, dt);
      applyOp(scene, op);
    }
    const tail = Math.max(0, Math.round((duration - t) / dt));
    if (tail > 0) scene.assembly.runSteps(tail, dt);
  } finally {
    scene.assembly.onAfterStep = null;
  }
  return { samples, duration, dt };
}

/**
 * Per-joint summary of a recorded run: final/rest angles, the worst joint
 * errors, which limits were actually reached (against the limit in force at
 * that moment), and who the joint touched or was blocked by.
 */
export function summarizeSamples(samples, jointIds) {
  const perJoint = {};
  for (const id of jointIds) {
    const acc = {
      finalAngleDeg: null,
      minAngleDeg: Infinity,
      maxAngleDeg: -Infinity,
      maxAnchorMm: 0,
      maxAxisErrDeg: 0,
      maxLimitErrDeg: 0,
      contacts: new Set(),
      blockedBy: new Set(),
      reachedMin: null,
      reachedMax: null,
    };
    for (const s of samples) {
      const j = s.joints[id];
      if (!j) continue;
      acc.finalAngleDeg = j.a;
      acc.minAngleDeg = Math.min(acc.minAngleDeg, j.a);
      acc.maxAngleDeg = Math.max(acc.maxAngleDeg, j.a);
      acc.maxAnchorMm = Math.max(acc.maxAnchorMm, j.an);
      acc.maxAxisErrDeg = Math.max(acc.maxAxisErrDeg, j.ax);
      acc.maxLimitErrDeg = Math.max(acc.maxLimitErrDeg, Math.abs(j.le));
      for (const c of j.c) acc.contacts.add(c);
      for (const b of j.b) acc.blockedBy.add(b);
      // A limit counts as reached when the joint sits on it while commanded
      // there — resting sag near a limit is not a limit hit.
      if (acc.reachedMin == null && Math.abs(j.a - j.mn) < 0.6 && Math.abs(j.tg - j.mn) < 1.0) {
        acc.reachedMin = { t: s.t, limitDeg: j.mn, angleDeg: j.a };
      }
      if (acc.reachedMax == null && Math.abs(j.a - j.mx) < 0.6 && Math.abs(j.tg - j.mx) < 1.0) {
        acc.reachedMax = { t: s.t, limitDeg: j.mx, angleDeg: j.a };
      }
    }
    perJoint[id] = {
      ...acc,
      contacts: [...acc.contacts].sort(),
      blockedBy: [...acc.blockedBy].sort(),
    };
  }
  return { perJoint, samples: samples.length, seconds: samples.length ? samples[samples.length - 1].t : 0 };
}

const sameSet = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Compares a fresh run's summary against the recorded one. Joint errors and
 * limit hits are the evidence: the fresh run must land on the same angles,
 * touch the same bodies and stay within solver-level error bounds.
 */
export function compareSummaries(recorded, fresh, jointIds) {
  const rows = [];
  for (const id of jointIds) {
    const rec = recorded.perJoint[id];
    const cur = fresh.perJoint[id];
    if (!rec || !cur) {
      rows.push({ joint: id, ok: false, detail: 'missing in one of the runs' });
      continue;
    }
    const checks = [
      ['final angle (deg)', rec.finalAngleDeg, cur.finalAngleDeg, 1.0],
      ['min angle (deg)', rec.minAngleDeg, cur.minAngleDeg, 1.5],
      ['max angle (deg)', rec.maxAngleDeg, cur.maxAngleDeg, 1.5],
    ];
    const failures = [];
    for (const [name, a, b, tol] of checks) {
      if (Math.abs(a - b) > tol) failures.push(`${name}: recorded ${a} vs fresh ${b} (tol ${tol})`);
    }
    const anchorBudget = Math.max(rec.maxAnchorMm * 4, 0.3);
    if (cur.maxAnchorMm > anchorBudget) failures.push(`max anchor: recorded ${rec.maxAnchorMm} mm, fresh ${cur.maxAnchorMm} mm over budget ${anchorBudget} mm`);
    const axisBudget = Math.max(rec.maxAxisErrDeg * 4, 0.05);
    if (cur.maxAxisErrDeg > axisBudget) failures.push(`max axis err: recorded ${rec.maxAxisErrDeg}°, fresh ${cur.maxAxisErrDeg}° over budget ${axisBudget}°`);
    const limitBudget = Math.max(rec.maxLimitErrDeg * 4, 0.1);
    if (cur.maxLimitErrDeg > limitBudget) failures.push(`max limit err: recorded ${rec.maxLimitErrDeg}°, fresh ${cur.maxLimitErrDeg}° over budget ${limitBudget}°`);
    if (!sameSet(rec.contacts, cur.contacts)) failures.push(`contacts: recorded [${rec.contacts}] vs fresh [${cur.contacts}]`);
    if (!sameSet(rec.blockedBy, cur.blockedBy)) failures.push(`blocked by: recorded [${rec.blockedBy}] vs fresh [${cur.blockedBy}]`);
    if (Boolean(rec.reachedMin) !== Boolean(cur.reachedMin)) failures.push(`reached min limit: recorded ${Boolean(rec.reachedMin)} vs fresh ${Boolean(cur.reachedMin)}`);
    if (Boolean(rec.reachedMax) !== Boolean(cur.reachedMax)) failures.push(`reached max limit: recorded ${Boolean(rec.reachedMax)} vs fresh ${Boolean(cur.reachedMax)}`);
    rows.push({
      joint: id,
      ok: failures.length === 0,
      detail: failures.length ? failures.join('; ') : 'matches the record',
      recorded: rec,
      fresh: cur,
    });
  }
  return { ok: rows.every((r) => r.ok), rows };
}

/**
 * Live script playback inside the running app. Ops are applied by sim time
 * against the same kernel API the panel uses; the viewport keeps showing real
 * constraint motion while the script runs.
 */
export class ScriptPlayer {
  constructor(scene, script, durationSec) {
    this.scene = scene;
    this.ops = sortOps(script);
    this.duration = durationSec ?? (this.ops.length ? this.ops[this.ops.length - 1].t + 1 : 0);
    this.active = false;
    this.cursor = 0;
    this.startT = 0;
  }

  start() {
    this.cursor = 0;
    this.startT = this.scene.assembly.simTime;
    this.active = true;
  }

  stop() {
    this.active = false;
  }

  get t() {
    return this.active ? this.scene.assembly.simTime - this.startT : 0;
  }

  update() {
    if (!this.active) return;
    const t = this.t;
    while (this.cursor < this.ops.length && this.ops[this.cursor].t <= t) {
      applyOp(this.scene, this.ops[this.cursor]);
      this.cursor += 1;
    }
    if (t >= this.duration) this.active = false;
  }
}
