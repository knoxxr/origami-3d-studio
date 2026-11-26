// ============================================================================
// math3d.js — 3D Vector Math, Rodrigues Rotation, Polygon Clipping & Sorting
// ============================================================================

export const EPS = 1e-6;

export function v3(x, y, z = 0) {
  return { x, y, z };
}

export function add(a, b) {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function sub(a, b) {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function scale(a, s) {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}

export function dot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function cross(a, b) {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

export function len(a) {
  return Math.hypot(a.x, a.y, a.z);
}

export function norm(a) {
  const l = len(a);
  if (l < 1e-12) return { x: 0, y: 0, z: 1 };
  return { x: a.x / l, y: a.y / l, z: a.z / l };
}

export function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

export function lerp3(a, b, t) {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t,
  };
}

export function easeInOutCubic(t) {
  const c = Math.max(0, Math.min(1, t));
  return c < 0.5 ? 4 * c * c * c : 1 - Math.pow(-2 * c + 2, 3) / 2;
}

export function easeOutCubic(t) {
  const c = Math.max(0, Math.min(1, t));
  return 1 - Math.pow(1 - c, 3);
}

/**
 * Rodrigues' rotation formula: rotate point `p` around axis passing through
 * `origin` with unit direction `axis` by `angle` radians (right-hand rule).
 */
export function rotateAroundAxis(p, origin, axis, angle) {
  if (Math.abs(angle) < 1e-9) return { x: p.x, y: p.y, z: p.z };
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const v = sub(p, origin);
  const kDotV = dot(axis, v);
  const kCrossV = cross(axis, v);
  return {
    x: origin.x + v.x * c + kCrossV.x * s + axis.x * kDotV * (1 - c),
    y: origin.y + v.y * c + kCrossV.y * s + axis.y * kDotV * (1 - c),
    z: origin.z + v.z * c + kCrossV.z * s + axis.z * kDotV * (1 - c),
  };
}

/**
 * Compute polygon normal from 3D points (Newell's method, robust for >3 verts).
 */
export function polyNormal(pts) {
  let nx = 0, ny = 0, nz = 0;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    nx += (a.y - b.y) * (a.z + b.z);
    ny += (a.z - b.z) * (a.x + b.x);
    nz += (a.x - b.x) * (a.y + b.y);
  }
  return norm({ x: nx, y: ny, z: nz });
}

export function polyArea3D(pts) {
  if (pts.length < 3) return 0;
  let ax = 0, ay = 0, az = 0;
  const p0 = pts[0];
  for (let i = 1; i < pts.length - 1; i++) {
    const u = sub(pts[i], p0);
    const v = sub(pts[i + 1], p0);
    const c = cross(u, v);
    ax += c.x;
    ay += c.y;
    az += c.z;
  }
  return 0.5 * Math.hypot(ax, ay, az);
}

export function polyCentroid(pts) {
  let x = 0, y = 0, z = 0;
  const n = pts.length || 1;
  for (let i = 0; i < pts.length; i++) {
    x += pts[i].x;
    y += pts[i].y;
    z += pts[i].z;
  }
  return { x: x / n, y: y / n, z: z / n };
}

/**
 * Split a convex polygon (with matching 3D `pts` and 2D `uvs`) by a plane
 * defined by `planeOrigin` and unit `planeNormal`.
 * Returns { pos, neg } where `pos` has signed distance >= 0 and `neg` has <= 0.
 * Either may be null if empty or degenerate.
 */
export function splitPolygonByPlane(pts, uvs, planeOrigin, planeNormal) {
  const n = pts.length;
  const dists = new Array(n);
  let hasPos = false;
  let hasNeg = false;

  for (let i = 0; i < n; i++) {
    const d = dot(sub(pts[i], planeOrigin), planeNormal);
    dists[i] = Math.abs(d) < 1e-5 ? 0 : d;
    if (dists[i] > 0) hasPos = true;
    if (dists[i] < 0) hasNeg = true;
  }

  if (!hasPos && !hasNeg) {
    return { pos: null, neg: null };
  }
  if (!hasNeg) {
    return {
      pos: { pts: pts.map(p => ({ ...p })), uvs: uvs.map(u => ({ ...u })) },
      neg: null,
    };
  }
  if (!hasPos) {
    return {
      pos: null,
      neg: { pts: pts.map(p => ({ ...p })), uvs: uvs.map(u => ({ ...u })) },
    };
  }

  const posPts = [], posUvs = [];
  const negPts = [], negUvs = [];

  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const p1 = pts[i], p2 = pts[j];
    const u1 = uvs[i], u2 = uvs[j];
    const d1 = dists[i], d2 = dists[j];

    if (d1 >= 0) {
      posPts.push({ ...p1 });
      posUvs.push({ ...u1 });
    }
    if (d1 <= 0) {
      negPts.push({ ...p1 });
      negUvs.push({ ...u1 });
    }

    if ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) {
      const t = d1 / (d1 - d2);
      const ip = lerp3(p1, p2, t);
      const iu = {
        u: u1.u + (u2.u - u1.u) * t,
        v: u1.v + (u2.v - u1.v) * t,
      };
      posPts.push(ip);
      posUvs.push(iu);
      negPts.push({ ...ip });
      negUvs.push({ ...iu });
    }
  }

  const clean = (pArr, uArr) => {
    const outP = [], outU = [];
    for (let i = 0; i < pArr.length; i++) {
      const prev = outP.length ? outP[outP.length - 1] : null;
      if (!prev || dist(prev, pArr[i]) > 1e-5) {
        outP.push(pArr[i]);
        outU.push(uArr[i]);
      }
    }
    if (outP.length > 1 && dist(outP[0], outP[outP.length - 1]) <= 1e-5) {
      outP.pop();
      outU.pop();
    }
    if (outP.length < 3 || polyArea3D(outP) < 1e-5) return null;
    return { pts: outP, uvs: outU };
  };

  return {
    pos: clean(posPts, posUvs),
    neg: clean(negPts, negUvs),
  };
}

/**
 * Build camera basis vectors from orbit parameters (yaw, pitch, dist, target).
 */
export function buildCamera(yaw, pitch, distance, target = { x: 0, y: 0, z: 0 }) {
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);

  const eye = {
    x: target.x + distance * cp * sy,
    y: target.y + distance * sp,
    z: target.z + distance * cp * cy,
  };

  const forward = norm(sub(target, eye));
  const worldUp = { x: 0, y: 1, z: 0 };
  let right = cross(forward, worldUp);
  if (len(right) < 1e-5) {
    right = { x: 1, y: 0, z: 0 };
  } else {
    right = norm(right);
  }
  const up = norm(cross(right, forward));

  return { eye, target, forward, right, up, distance };
}

export function worldToCamera(p, cam) {
  const d = sub(p, cam.eye);
  return {
    x: dot(d, cam.right),
    y: dot(d, cam.up),
    z: dot(d, cam.forward), // positive = in front of camera
  };
}

export function projectPoint(camPt, width, height, fovDeg = 38) {
  const refDim = Math.min(width, height);
  const f = (refDim * 0.5) / Math.tan((fovDeg * Math.PI) / 360);
  const z = Math.max(0.05, camPt.z);
  return {
    x: width * 0.5 + (camPt.x * f) / z,
    y: height * 0.5 - (camPt.y * f) / z,
    z: camPt.z,
    scale: f / z,
  };
}

/**
 * Unproject a screen pixel (sx, sy) onto a 3D plane (default z = 0).
 */
export function screenToPlane(sx, sy, width, height, cam, planeOrigin = { x: 0, y: 0, z: 0 }, planeNormal = { x: 0, y: 0, z: 1 }, fovDeg = 38) {
  const refDim = Math.min(width, height);
  const f = (refDim * 0.5) / Math.tan((fovDeg * Math.PI) / 360);
  const nx = (sx - width * 0.5) / f;
  const ny = (height * 0.5 - sy) / f;
  const rayDir = norm(add(add(scale(cam.right, nx), scale(cam.up, ny)), cam.forward));
  const denom = dot(rayDir, planeNormal);
  if (Math.abs(denom) < 1e-6) return null;
  const t = dot(sub(planeOrigin, cam.eye), planeNormal) / denom;
  if (t < 0) return null;
  return add(cam.eye, scale(rayDir, t));
}
