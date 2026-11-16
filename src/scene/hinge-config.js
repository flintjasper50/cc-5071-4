import { qFromXAxis, qInv, qMul, qRotate, vSub } from '../core/math.js';

const D = Math.PI / 180;

/**
 * Shared hinge-frame math for scene builders. The pivot and axis are given in
 * world space; the returned config carries them into each body's local frame.
 * Rapier's revolute joint frees the X axis of each local frame, so frames are
 * built from the world hinge axis and rendering, the angle readout and the
 * Rapier limit all share one axis.
 */
export function hingeConfig({ id, label, group, parent, child, pivot, axis, min, max, target, ...rest }) {
  const ra = parent.rotation();
  const rb = child.rotation();
  const localAnchorA = qRotate(qInv(ra), vSub(pivot, parent.translation()));
  const localAnchorB = qRotate(qInv(rb), vSub(pivot, child.translation()));
  const frameWorld = qFromXAxis(axis);
  return {
    id,
    label,
    group,
    bodyA: parent,
    bodyB: child,
    localAnchorA,
    localAnchorB,
    localAxisA: qRotate(qInv(ra), axis),
    localAxisB: qRotate(qInv(rb), axis),
    frameA: qMul(qInv(ra), frameWorld),
    frameB: qMul(qInv(rb), frameWorld),
    min: min * D,
    max: max * D,
    target: (target ?? 0) * D,
    ...rest,
  };
}
