import {
  clamp,
  qCanonical,
  qFromXAxis,
  qInv,
  qMul,
  qNorm,
  qRotate,
  twistX,
  vAdd,
  vCross,
  vDot,
  vLen,
  vNorm,
  vSub,
  vScale,
} from './math.js';
import { AngleTracker } from './angles.js';

/**
 * A revolute joint between a parent body and a leaf body, with a local pivot and local
 * hinge axis on each side. Both angular readings and limit state are derived from the
 * physical bodies, so they cannot drift from rendering or collision.
 */
export class Hinge {
  constructor(cfg) {
    this.id = cfg.id;
    this.label = cfg.label ?? cfg.id;
    this.group = cfg.group ?? 'rig';
    this.bodyA = cfg.bodyA;
    this.bodyB = cfg.bodyB;
    this.localAnchorA = cfg.localAnchorA;
    this.localAnchorB = cfg.localAnchorB;
    this.localAxisA = vNorm(cfg.localAxisA);
    this.localAxisB = vNorm(cfg.localAxisB);
    this.frameA = cfg.frameA ?? qFromXAxis(this.localAxisA);
    this.frameB = cfg.frameB ?? qFromXAxis(this.localAxisB);
    this.continuous = Boolean(cfg.continuous);
    this.min = this.continuous ? -Math.PI : cfg.min ?? -Math.PI;
    this.max = this.continuous ? Math.PI : cfg.max ?? Math.PI;
    this.motorStiffness = cfg.motorStiffness ?? 60;
    this.motorDamping = cfg.motorDamping ?? 8;
    this.motorMaxForce = cfg.motorMaxForce ?? 300;
    this.target = clamp(cfg.target ?? 0, this.min, this.max);
    this.enabled = true;
    this.joint = null;
    this.tracker = new AngleTracker(0);
    this.angle = 0;
    this.rawAngleValue = 0;
    this.axisSpeed = 0;
    this.anchorErr = 0;
    this.axisErr = 0;
    this.limitErr = 0;
    this.contact = { count: 0, maxPenetration: 0, minDistance: Infinity, others: [], points: [] };
    this.stalledFor = 0;
    this.blocked = null;
    this.commandedTarget = this.target;
    this.freeFor = 0;
    this.retractAt = 0;
    this.gravityFeedForward = cfg.gravityFeedForward ?? true;
    this.payload = cfg.payload ?? []; // bodies hanging off bodyB, for gravity feed-forward
    this.gravityTorque = 0;
    this.contactHold = false;
    this.holdAt = 0;
    this.parts = cfg.parts ?? [];
  }

  worldAnchorA() {
    return vAdd(this.bodyA.translation(), qRotate(this.bodyA.rotation(), this.localAnchorA));
  }

  worldAnchorB() {
    return vAdd(this.bodyB.translation(), qRotate(this.bodyB.rotation(), this.localAnchorB));
  }

  worldAxisA() {
    return vNorm(qRotate(this.bodyA.rotation(), this.localAxisA));
  }

  worldAxisB() {
    return vNorm(qRotate(this.bodyB.rotation(), this.localAxisB));
  }

  relativeQuat() {
    const qa = qMul(this.bodyA.rotation(), this.frameA);
    const qb = qMul(this.bodyB.rotation(), this.frameB);
    return qCanonical(qMul(qInv(qa), qb));
  }

  rawAngle() {
    return twistX(this.relativeQuat());
  }

  anchorError() {
    return vLen(vSub(this.worldAnchorA(), this.worldAnchorB()));
  }

  axisError() {
    const a = this.worldAxisA();
    const b = this.worldAxisB();
    return Math.acos(clamp(vDot(a, b), -1, 1));
  }

  limitOverflow() {
    if (this.continuous) return 0;
    if (this.angle < this.min) return this.angle - this.min;
    if (this.angle > this.max) return this.angle - this.max;
    return 0;
  }

  resetTracker() {
    const raw = this.rawAngle();
    this.tracker.reset(raw);
    this.rawAngleValue = raw;
    this.angle = raw;
    this.stalledFor = 0;
    this.blocked = null;
  }

  /** Gravity torque about the hinge axis from bodyB and every body in `payload`. */
  computeGravityTorque(gravity) {
    const pivot = this.worldAnchorB();
    const axis = this.worldAxisA();
    let torque = 0;
    const bodies = [this.bodyB, ...this.payload];
    for (const body of bodies) {
      if (body.isFixed?.() || body.isKinematic?.()) continue;
      const m = body.mass();
      if (!(m > 0)) continue;
      const com = body.worldCom?.() ?? body.translation();
      const r = vSub(com, pivot);
      const force = vScale(gravity, m);
      torque += vDot(axis, vCross(r, force));
    }
    return torque;
  }
}

export class HingeAssembly {
  constructor(RAPIER, world, opts = {}) {
    this.RAPIER = RAPIER;
    this.world = world;
    this.hinges = [];
    this.byId = new Map();
    this.dt = opts.dt ?? 1 / 120;
    this.solverIterations = opts.solverIterations ?? 4;
    this.simTime = 0;
    this.stepCount = 0;
    this.accumulator = 0;
    this.colliderLabels = opts.colliderLabels ?? new Map();
    this.onAfterStep = null;
    this._applySolverSettings();
  }

  _applySolverSettings() {
    const ip = this.world.integrationParameters;
    ip.dt = this.dt;
    ip.numSolverIterations = this.solverIterations;
    this.world.timestep = this.dt;
  }

  setStep(dt, solverIterations) {
    if (dt != null) this.dt = dt;
    if (solverIterations != null) this.solverIterations = solverIterations;
    this._applySolverSettings();
  }

  addHinge(cfg) {
    const hinge = new Hinge(cfg);
    const jd = this.RAPIER.JointData.revolute(hinge.localAnchorA, hinge.localAnchorB, hinge.localAxisA);
    const joint = this.world.createImpulseJoint(jd, hinge.bodyA, hinge.bodyB, true);
    joint.setLocalFrame1(hinge.localAnchorA, hinge.frameA);
    joint.setLocalFrame2(hinge.localAnchorB, hinge.frameB);
    if (!hinge.continuous) joint.setLimits(hinge.min, hinge.max);
    joint.configureMotorModel(cfg.motorModel ?? this.RAPIER.MotorModel.ForceBased);
    joint.setMotorMaxForce(hinge.motorMaxForce);
    joint.configureMotorPosition(hinge.target, hinge.motorStiffness, hinge.motorDamping);
    joint.setContactsEnabled(cfg.contacts ?? false);
    hinge.joint = joint;
    hinge.resetTracker();
    this.hinges.push(hinge);
    this.byId.set(hinge.id, hinge);
    return hinge;
  }

  get(id) {
    return this.byId.get(id);
  }

  setTarget(id, target) {
    const h = this.get(id);
    if (!h || !h.joint) return false;
    h.target = h.continuous ? target : clamp(target, h.min, h.max);
    h.commandedTarget = h.target;
    h.joint.configureMotorPosition(h.target, h.motorStiffness, h.motorDamping);
    h.stalledFor = 0;
    h.blocked = null;
    h.freeFor = 0;
    h.bodyB.wakeUp();
    return true;
  }

  setMotorEnabled(id, enabled) {
    const h = this.get(id);
    if (!h || !h.joint) return false;
    h.enabled = enabled;
    if (enabled) h.joint.configureMotorPosition(h.target, h.motorStiffness, h.motorDamping);
    else h.joint.configureMotorPosition(h.angle, 0, 0);
    h.bodyB.wakeUp();
    return true;
  }

  setLimits(id, min, max) {
    const h = this.get(id);
    if (!h || !h.joint) return false;
    if (h.continuous) return false;
    h.min = Math.min(min, max);
    h.max = Math.max(min, max);
    h.joint.setLimits(h.min, h.max);
    h.target = clamp(h.target, h.min, h.max);
    h.commandedTarget = h.target;
    h.joint.configureMotorPosition(h.target, h.motorStiffness, h.motorDamping);
    h.blocked = null;
    h.stalledFor = 0;
    h.bodyB.wakeUp();
    return true;
  }

  applyTorqueImpulse(id, worldAxis, magnitude) {
    const h = this.get(id);
    if (!h) return;
    const axis = vNorm(worldAxis);
    h.bodyB.applyTorqueImpulse(vScale(axis, magnitude), true);
  }

  applyImpulseAtWorldPoint(id, point, dir, magnitude) {
    const h = this.get(id);
    if (!h) return;
    h.bodyB.applyImpulseAtPoint(vScale(vNorm(dir), magnitude), point, true);
  }

  /** Physical spring drag: pulls a grabbed point toward a target with an impulse budget. */
  applyDrag(id, grabLocal, targetWorld, stiffness, damping, maxImpulse) {
    const h = this.get(id);
    if (!h) return;
    const body = h.bodyB;
    const grabWorld = vAdd(body.translation(), qRotate(body.rotation(), grabLocal));
    const delta = vSub(targetWorld, grabWorld);
    const v = body.linvel();
    const w = body.angvel();
    const r = vSub(grabWorld, body.translation());
    const pointVel = vAdd(v, {
      x: w.y * r.z - w.z * r.y,
      y: w.z * r.x - w.x * r.z,
      z: w.x * r.y - w.y * r.x,
    });
    const impulse = vSub(vScale(delta, stiffness), vScale(pointVel, damping));
    let mag = vLen(impulse);
    if (mag > maxImpulse) {
      mag = maxImpulse;
    }
    if (mag < 1e-6) return;
    body.applyImpulseAtPoint(vScale(vNorm(impulse), mag), grabWorld, true);
  }

  /**
   * Collects contacts between each hinge's bodies and the rest of the scene.
   * Rapier emits predictive contacts slightly before shapes touch, so the
   * threshold is above the default prediction distance to catch blockages early.
   *
   * Every (own collider, other collider) pair is examined: a partner is never
   * skipped just because another collider on the same body is paired with it —
   * that pairing can be contact-free while a secondary collider (a handle, a
   * tool tip) carries the actual contact.
   */
  sampleContacts(maxDistance = 0.03) {
    for (const h of this.hinges) {
      const info = { count: 0, maxPenetration: 0, minDistance: Infinity, others: [], points: [] };
      const bodies = [h.bodyA, h.bodyB];
      for (const body of bodies) {
        for (let ci = 0; ci < body.numColliders(); ci++) {
          const collider = body.collider(ci);
          this.world.contactPairsWith(collider, (other) => {
            const parent = other.parent();
            if (parent && (parent.handle === h.bodyA.handle || parent.handle === h.bodyB.handle)) return;
            this.world.contactPair(collider, other, (manifold) => {
              let best = Infinity;
              const n = manifold.numContacts();
              for (let i = 0; i < n; i++) {
                const d = manifold.contactDist(i);
                if (d < best) best = d;
              }
              if (n > 0 && best <= maxDistance) {
                info.count += n;
                if (best < info.maxPenetration) info.maxPenetration = best;
                if (best < info.minDistance) info.minDistance = best;
                const label = this.colliderLabels.get(other.handle) ?? `collider#${other.handle}`;
                if (!info.others.includes(label)) info.others.push(label);
                if (info.points.length < 8) {
                  const p = manifold.solverContactPoint(0) ?? manifold.localContactPoint1(0);
                  const nrm = manifold.normal();
                  if (p) info.points.push({ point: { x: p.x, y: p.y, z: p.z }, normal: { x: nrm.x, y: nrm.y, z: nrm.z } });
                }
              }
            });
          });
        }
      }
      h.contact = info;
    }
  }

  /** Reads physical state back into each hinge's diagnostic fields. */
  sample() {
    for (const h of this.hinges) {
      const prev = h.angle;
      const raw = h.rawAngle();
      h.rawAngleValue = raw;
      h.angle = h.tracker.push(raw);
      h.anchorErr = h.anchorError();
      h.axisErr = h.axisError();
      h.limitErr = h.limitOverflow();
      const axis = h.worldAxisB();
      const w = h.bodyB.angvel();
      h.axisSpeed = vDot(w, axis);
      h.angleDelta = h.angle - prev;
    }
  }

  /** Refreshes the gravity torque needed to hold each driven hinge in place. */
  updateGravityFeedForward() {
    const g = this.world.gravity;
    for (const h of this.hinges) {
      if (!h.joint || !h.gravityFeedForward) {
        h.gravityTorque = 0;
        continue;
      }
      h.gravityTorque = h.computeGravityTorque(g);
    }
  }

  /**
   * Contact-aware motor command.
   *
   * A bare position motor under gravity has no idea it is leaning on an
   * obstacle: it keeps commanding the unreachable angle, loads the contact and
   * then snaps back. This pass supplies two things the solver alone cannot:
   *
   *  1. Gravity feed-forward, so the joint can hold an angle without sagging
   *     when it is unloaded (and without needing huge stiffness).
   *  2. A hold state: once the joint is in contact and has stopped progressing
   *     toward its command, the command is retracted to the current angle.
   *     The hold releases after a probe interval, or immediately when contact
   *     disappears, so the joint resumes as soon as the obstacle moves away.
   */
  updateBlockage() {
    const dt = this.dt;
    const stallSpeed = 0.06;
    const progressEps = 0.003;
    const stallTime = 0.08;
    const probeInterval = 0.6;
    for (const h of this.hinges) {
      if (!h.joint || !h.enabled) {
        h.blocked = null;
        h.stalledFor = 0;
        h.contactHold = false;
        continue;
      }
      const inContact = h.contact.count > 0;
      const error = h.target - h.angle;
      const wantsMotion = Math.abs(error) > 0.02;
      const toward = Math.sign(error);
      const movingToward = Math.abs(h.axisSpeed) > stallSpeed && Math.sign(h.axisSpeed) === toward;
      const progressed = Math.abs(h.angleDelta) > progressEps * (dt * 120);
      const stuckAtLimit = Math.abs(h.limitErr) > 1e-4 && Math.sign(h.limitErr) !== toward;

      if (h.contactHold) {
        // Hold until the contact clears or a probe is due.
        if (!inContact) {
          h.freeFor += dt;
          if (h.freeFor > 0.12) {
            h.contactHold = false;
            h.blocked = null;
            h.commandedTarget = h.target;
          }
        } else {
          h.freeFor = 0;
          if (this.simTime - h.holdAt > probeInterval) {
            h.contactHold = false;
            h.commandedTarget = h.target;
          }
        }
      } else if (inContact && wantsMotion && !movingToward && !progressed && !stuckAtLimit) {
        h.stalledFor += dt;
        if (h.stalledFor > stallTime) {
          const by = h.contact.others.slice();
          h.blocked = { by, angle: h.angle, target: h.target, at: this.simTime, limitErr: h.limitErr };
          h.contactHold = true;
          h.holdAt = this.simTime;
          h.freeFor = 0;
          h.commandedTarget = h.angle;
        }
      } else {
        h.stalledFor = 0;
      }

      // Compose the actual motor command: held angle + gravity feed-forward.
      const cmd = h.contactHold ? h.commandedTarget : h.target;
      const maxForce = h.motorMaxForce;
      const ff = h.gravityFeedForward ? h.gravityTorque : 0;
      h.joint.configureMotorModel(this.RAPIER.MotorModel.ForceBased);
      h.joint.setMotorMaxForce(maxForce);
      h.joint.configureMotor(h.contactHold ? h.angle : cmd, 0, h.motorStiffness, h.motorDamping);
      if (Math.abs(ff) > 1e-6) {
        // Counter-gravity impulse about the hinge axis, bounded by the motor budget.
        const comp = -clamp(ff, -maxForce, maxForce) * dt;
        h.bodyB.applyTorqueImpulse(vScale(h.worldAxisB(), comp), true);
      }
    }
  }

  advance(dtSeconds, maxSubsteps = 8) {
    this.accumulator += Math.min(dtSeconds, 0.25);
    let n = 0;
    while (this.accumulator >= this.dt && n < maxSubsteps) {
      this.world.step();
      this.accumulator -= this.dt;
      this.simTime += this.dt;
      this.stepCount += 1;
      n += 1;
      this.sample();
      this.sampleContacts();
      this.updateGravityFeedForward();
      this.updateBlockage();
      if (this.onAfterStep) this.onAfterStep(this.dt, n);
    }
    return n;
  }

  runSteps(count, dt = this.dt) {
    const prev = this.dt;
    this.setStep(dt, this.solverIterations);
    const t0 = performance.now();
    for (let i = 0; i < count; i++) {
      this.world.step();
      this.simTime += dt;
      this.stepCount += 1;
      this.sample();
      this.sampleContacts();
      this.updateGravityFeedForward();
      this.updateBlockage();
      if (this.onAfterStep) this.onAfterStep(dt, i + 1);
    }
    const elapsed = performance.now() - t0;
    if (dt !== prev) this.setStep(prev, this.solverIterations);
    return elapsed;
  }
}
