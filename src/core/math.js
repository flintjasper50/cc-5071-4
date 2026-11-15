export function v3(x = 0, y = 0, z = 0) {
  return { x, y, z };
}

export function vAdd(a, b) {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function vSub(a, b) {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function vScale(a, s) {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}

export function vDot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function vCross(a, b) {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

export function vLen(a) {
  return Math.hypot(a.x, a.y, a.z);
}

export function vNorm(a) {
  const l = vLen(a);
  return l > 1e-12 ? vScale(a, 1 / l) : v3(0, 0, 0);
}

export function vLerp(a, b, t) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
}

export function qIdentity() {
  return { x: 0, y: 0, z: 0, w: 1 };
}

export function qMul(a, b) {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

export function qInv(q) {
  const n = q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w;
  if (n < 1e-20) return qIdentity();
  return { x: -q.x / n, y: -q.y / n, z: -q.z / n, w: q.w / n };
}

export function qNorm(q) {
  const n = Math.hypot(q.x, q.y, q.z, q.w);
  return n > 1e-12 ? { x: q.x / n, y: q.y / n, z: q.z / n, w: q.w / n } : qIdentity();
}

export const qConj = qInv;

export function qCanonical(q) {
  return q.w < 0 ? { x: -q.x, y: -q.y, z: -q.z, w: -q.w } : { x: q.x, y: q.y, z: q.z, w: q.w };
}

export function qRotate(q, v) {
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return {
    x: v.x + q.w * tx + (q.y * tz - q.z * ty),
    y: v.y + q.w * ty + (q.z * tx - q.x * tz),
    z: v.z + q.w * tz + (q.x * ty - q.y * tx),
  };
}

export function qFromAxisAngle(axis, angle) {
  const a = vNorm(axis);
  const s = Math.sin(angle / 2);
  return { x: a.x * s, y: a.y * s, z: a.z * s, w: Math.cos(angle / 2) };
}

export function qFromEuler(rx, ry, rz) {
  return qNorm(qMul(qMul(qFromAxisAngle(v3(0, 1, 0), ry), qFromAxisAngle(v3(1, 0, 0), rx)), qFromAxisAngle(v3(0, 0, 1), rz)));
}

/** Builds an orthonormal frame whose local +X aligns with `axis`, using `up` as a reference. */
export function qFromXAxis(axis, up = v3(0, 0, 1)) {
  const x = vNorm(axis);
  let z = vCross(x, up);
  if (vLen(z) < 1e-6) z = vCross(x, v3(1, 0, 0));
  z = vNorm(z);
  const y = vCross(z, x);
  const m00 = x.x, m01 = y.x, m02 = z.x;
  const m10 = x.y, m11 = y.y, m12 = z.y;
  const m20 = x.z, m21 = y.z, m22 = z.z;
  const tr = m00 + m11 + m22;
  let q;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    q = { w: s / 4, x: (m21 - m12) / s, y: (m02 - m20) / s, z: (m10 - m01) / s };
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    q = { w: (m21 - m12) / s, x: s / 4, y: (m01 + m10) / s, z: (m02 + m20) / s };
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    q = { w: (m02 - m20) / s, x: (m01 + m10) / s, y: s / 4, z: (m12 + m21) / s };
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    q = { w: (m10 - m01) / s, x: (m02 + m20) / s, y: (m12 + m21) / s, z: s / 4 };
  }
  return qNorm(q);
}

export function qSlerp(a, b, t) {
  let bb = b;
  let d = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
  if (d < 0) {
    bb = { x: -b.x, y: -b.y, z: -b.z, w: -b.w };
    d = -d;
  }
  if (d > 0.9995) return qNorm(vLerp(a, bb, t));
  const th = Math.acos(Math.min(1, Math.max(-1, d)));
  const s = Math.sin(th);
  const wa = Math.sin((1 - t) * th) / s;
  const wb = Math.sin(t * th) / s;
  return qNorm({
    x: a.x * wa + bb.x * wb,
    y: a.y * wa + bb.y * wb,
    z: a.z * wa + bb.z * wb,
    w: a.w * wa + bb.w * wb,
  });
}

/** Signed twist of quaternion `q` about the local +X axis, in (-PI, PI]. */
export function twistX(q) {
  const qq = q.w < 0 ? { x: -q.x, y: -q.y, z: -q.z, w: -q.w } : q;
  return 2 * Math.atan2(qq.x, qq.w);
}

export function wrapPi(a) {
  let r = a;
  while (r > Math.PI) r -= 2 * Math.PI;
  while (r <= -Math.PI) r += 2 * Math.PI;
  return r;
}

export function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

export function approach(x, target, maxDelta) {
  const d = target - x;
  if (Math.abs(d) <= maxDelta) return target;
  return x + Math.sign(d) * maxDelta;
}
