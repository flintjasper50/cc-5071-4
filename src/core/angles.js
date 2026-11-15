import { clamp, qCanonical, twistX, wrapPi } from './math.js';

/**
 * Wraps an angle into (-PI, PI].
 */
export function normalizeAngle(a) {
  return wrapPi(a);
}

/**
 * Unwraps `raw` toward `previous` by selecting the equivalent turn closest to it.
 * This is the per-frame step of a continuous angle representation.
 */
export function unwrapToward(raw, previous) {
  const turns = Math.round((previous - raw) / (2 * Math.PI));
  return raw + turns * 2 * Math.PI;
}

/**
 * Tracks a continuous (unwrapped) hinge angle from a raw per-frame measurement in (-PI, PI].
 *
 * A naive `prev - raw` difference sees a 2*PI jump whenever the raw angle crosses the
 * +/-PI seam. This tracker instead picks the branch nearest the running value, so a
 * small physical motion near the seam is recorded as a small change. A real half-turn
 * still registers because the nearest branch is at most PI away from the previous angle.
 */
export class AngleTracker {
  constructor(initialRaw = 0) {
    this.raw = normalizeAngle(initialRaw);
    this.continuous = this.raw;
    this.lastDelta = 0;
    this.wraps = 0;
  }

  reset(raw) {
    this.raw = normalizeAngle(raw);
    this.continuous = this.raw;
    this.lastDelta = 0;
    this.wraps = 0;
  }

  push(raw) {
    const r = normalizeAngle(raw);
    const candidate = unwrapToward(r, this.continuous);
    this.lastDelta = candidate - this.continuous;
    this.continuous = candidate;
    this.raw = r;
    if (Math.abs(this.lastDelta) > Math.PI) this.wraps += Math.sign(this.lastDelta);
    return this.continuous;
  }
}

/** Tracks the continuous twist about a joint frame's X axis, given a relative quaternion. */
export class QuatAngleTracker {
  constructor(relQuat) {
    this.tracker = new AngleTracker(twistX(qCanonical(relQuat)));
  }

  push(relQuat) {
    return this.tracker.push(twistX(qCanonical(relQuat)));
  }

  reset(relQuat) {
    this.tracker.reset(twistX(qCanonical(relQuat)));
  }

  get continuous() {
    return this.tracker.continuous;
  }

  get lastDelta() {
    return this.tracker.lastDelta;
  }
}

/**
 * Projects `angle` into [min, max] while preserving the turn count that keeps it closest
 * to the measured angle. `overflow` is the signed distance outside the limit relative to
 * the projected representation (so a full turn away from the range is not mistaken for a
 * range violation of one revolution).
 */
export function clampToLimits(angle, min, max) {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  const center = (lo + hi) * 0.5;
  const span = hi - lo;
  let reference = angle;
  if (span < 2 * Math.PI - 1e-9) {
    const turns = Math.round((angle - center) / (2 * Math.PI));
    reference = angle - turns * 2 * Math.PI;
  }
  const projected = clamp(reference, lo, hi);
  return { angle: projected, overflow: reference - projected };
}

export function limitOverflow(angle, min, max) {
  return clampToLimits(angle, min, max).overflow;
}
