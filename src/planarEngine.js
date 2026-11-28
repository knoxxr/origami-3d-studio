// ============================================================================
// planarEngine.js — Exact 3D Planar Origami Folding Kernel
// Supports: Valley Fold, Mountain Fold, Pre-crease, Pleat Fold, Flip, Rotate,
//           Symmetric Multi-Fold, Top/Bottom/All Layer Scope, 2D Crease Pattern
// ============================================================================

import {
  v3, add, sub, scale, dot, cross, norm, dist,
  rotateAroundAxis, splitPolygonByPlane, polyCentroid, polyNormal,
  easeInOutCubic,
} from './math3d.js';

/**
 * Create an initial flat sheet of origami paper.
 * Default: 2x2 square centered at origin on z = 0.
 */
export function createInitialPaper(width = 2.0, height = 2.0, rotationDeg = 0) {
  const hw = width * 0.5;
  const hh = height * 0.5;
  const rad = (rotationDeg * Math.PI) / 180;
  const rot = (x, y) => ({
    x: x * Math.cos(rad) - y * Math.sin(rad),
    y: x * Math.sin(rad) + y * Math.cos(rad),
    z: 0,
  });

  const faces = [
    {
      pts: [rot(-hw, -hh), rot(hw, -hh), rot(hw, hh), rot(-hw, hh)],
      uvs: [
        { u: 0, v: 0 },
        { u: 1, v: 0 },
        { u: 1, v: 1 },
        { u: 0, v: 1 },
      ],
      layer: 0,
    },
  ];

  return {
    faces,
    creases: [], // 2D crease lines in UV space: { u1, v1, u2, v2, type: 'valley'|'mountain' }
    width,
    height,
    rotationDeg,
  };
}

export function clonePaperState(state) {
  return {
    faces: state.faces.map(f => ({
      pts: f.pts.map(p => ({ x: p.x, y: p.y, z: p.z })),
      uvs: f.uvs.map(u => ({ u: u.u, v: u.v })),
      layer: f.layer,
    })),
    creases: state.creases.map(c => ({ ...c })),
    width: state.width,
    height: state.height,
    rotationDeg: state.rotationDeg,
  };
}

function compactLayers(faces) {
  const unique = Array.from(new Set(faces.map(f => f.layer))).sort((a, b) => a - b);
  const map = new Map();
  const mid = (unique.length - 1) * 0.5;
  unique.forEach((val, idx) => map.set(val, idx - mid));
  for (const f of faces) {
    f.layer = map.get(f.layer);
  }
}

function pointDistToPolyXY(px, py, pts) {
  let inside = false;
  let minSq = Infinity;
  const n = pts.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
    if (((yi > py) !== (yj > py)) && (px < ((xj - xi) * (py - yi)) / (yj - yi + 1e-12) + xi)) {
      inside = !inside;
    }
    const vx = xi - xj, vy = yi - yj;
    const lenSq = vx * vx + vy * vy;
    const t = lenSq > 1e-8 ? Math.max(0, Math.min(1, ((px - xj) * vx + (py - yj) * vy) / lenSq)) : 0;
    const dx = px - (xj + t * vx), dy = py - (yj + t * vy);
    const dSq = dx * dx + dy * dy;
    if (dSq < minSq) minSq = dSq;
  }
  return inside ? 0 : Math.sqrt(minSq);
}

function facesShareUVEdge(fA, fB) {
  if (!fA.uvs || !fB.uvs) return false;
  const eps = 3.5e-3;
  const uvEq = (a, b) => Math.hypot(a.u - b.u, a.v - b.v) < eps;
  const nA = fA.uvs.length, nB = fB.uvs.length;
  for (let i = 0; i < nA; i++) {
    const a1 = fA.uvs[i], a2 = fA.uvs[(i + 1) % nA];
    if (Math.hypot(a2.u - a1.u, a2.v - a1.v) < 4e-3) continue;
    for (let j = 0; j < nB; j++) {
      const b1 = fB.uvs[j], b2 = fB.uvs[(j + 1) % nB];
      if ((uvEq(a1, b2) && uvEq(a2, b1)) || (uvEq(a1, b1) && uvEq(a2, b2))) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Returns true if two faces share a UV crease edge whose 3D segment extends
 * strictly onto movingSide — meaning they are physically hinged together as a
 * multi-layer folded tab (e.g. a 3-layer paper airplane nose lock-tab).
 */
function facesShareMovingUVEdge(fA, fB, planeOrigin, planeNormal, movingSide) {
  if (!fA.uvs || !fB.uvs) return false;
  const eps = 3.5e-3;
  const uvEq = (a, b) => Math.hypot(a.u - b.u, a.v - b.v) < eps;
  const nA = fA.uvs.length, nB = fB.uvs.length;
  for (let i = 0; i < nA; i++) {
    const a1 = fA.uvs[i], a2 = fA.uvs[(i + 1) % nA];
    if (Math.hypot(a2.u - a1.u, a2.v - a1.v) < 4e-3) continue;
    const p1 = fA.pts[i], p2 = fA.pts[(i + 1) % nA];
    const d1 = dot(sub(p1, planeOrigin), planeNormal) * movingSide;
    const d2 = dot(sub(p2, planeOrigin), planeNormal) * movingSide;
    if (d1 <= 0.025 && d2 <= 0.025) continue;
    for (let j = 0; j < nB; j++) {
      const b1 = fB.uvs[j], b2 = fB.uvs[(j + 1) % nB];
      if ((uvEq(a1, b2) && uvEq(a2, b1)) || (uvEq(a1, b1) && uvEq(a2, b2))) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Determine which faces are eligible to move given layerScope ('all'|'top'|'bottom'),
 * optional explicit targetLayerOverride (picked flap layer), and optional seedPoint
 * (isolates ONLY the UV-connected continuous flap — including any physically joined
 * layers of a multi-layer folded tab — without dragging the untouched base sheet).
 */
function filterLayerEligible(faces, movingSide, planeOrigin, planeNormal, layerScope, targetLayerOverride = null, seedPoint = null) {
  if (!layerScope || layerScope === 'all') {
    return new Set(faces.map((_, i) => i));
  }
  // Find faces that have at least one vertex strictly on movingSide
  const candidateIdx = [];
  let gMinLayer = Infinity, gMaxLayer = -Infinity;
  for (let i = 0; i < faces.length; i++) {
    const f = faces[i];
    if (f.layer < gMinLayer) gMinLayer = f.layer;
    if (f.layer > gMaxLayer) gMaxLayer = f.layer;
    let hasMoving = false;
    for (const p of f.pts) {
      const d = dot(sub(p, planeOrigin), planeNormal) * movingSide;
      if (d > 0.025) {
        hasMoving = true;
        break;
      }
    }
    if (hasMoving) candidateIdx.push(i);
  }
  if (candidateIdx.length === 0) return new Set();

  let targetLayer;
  if (Number.isFinite(targetLayerOverride) &&
      candidateIdx.some(idx => Math.abs(faces[idx].layer - targetLayerOverride) < 0.55)) {
    targetLayer = targetLayerOverride;
  } else {
    targetLayer = faces[candidateIdx[0]].layer;
    for (const idx of candidateIdx) {
      if (layerScope === 'top') {
        if (faces[idx].layer > targetLayer) targetLayer = faces[idx].layer;
      } else if (layerScope === 'bottom') {
        if (faces[idx].layer < targetLayer) targetLayer = faces[idx].layer;
      }
    }
  }

  const eligible = new Set();
  for (const idx of candidateIdx) {
    if (Math.abs(faces[idx].layer - targetLayer) < 0.55) {
      eligible.add(idx);
    }
  }

  // If a grab seedPoint is provided, isolate ONLY the UV-connected flap island containing
  // that seedPoint (plus any sub-layers physically hinged to it on movingSide, excluding the base sheet).
  if (seedPoint && eligible.size > 0) {
    const sx = seedPoint[0], sy = seedPoint[1];
    const layerIndices = [];
    for (let i = 0; i < faces.length; i++) {
      if (Math.abs(faces[i].layer - targetLayer) < 0.55) layerIndices.push(i);
    }
    const straddlesCrease = (idx) => {
      let hasStay = false;
      for (const p of faces[idx].pts) {
        if (dot(sub(p, planeOrigin), planeNormal) * movingSide < -0.02) {
          hasStay = true;
          break;
        }
      }
      return hasStay;
    };
    const eligibleArr = Array.from(eligible);
    const straddling = eligibleArr.filter(straddlesCrease);
    const pool = straddling.length > 0 ? straddling : eligibleArr;

    let bestDist = Infinity;
    const scored = pool.map(idx => {
      const d = pointDistToPolyXY(sx, sy, faces[idx].pts);
      if (d < bestDist) bestDist = d;
      return { idx, d };
    });
    let seeds = bestDist < 0.35
      ? scored.filter(s => s.d <= bestDist + 2e-3).map(s => s.idx)
      : [];
    // If multiple distinct flaps meet at the exact grabbed vertex (e.g. Blintz center (0,0)),
    // pick the flap whose body lies in the fold's drag/stay direction (-planeNormal * movingSide)!
    if (seeds.length > 1) {
      const stayDirX = -planeNormal.x * movingSide;
      const stayDirY = -planeNormal.y * movingSide;
      let bestAlign = -Infinity;
      let bestSeed = seeds[0];
      for (const idx of seeds) {
        const c = polyCentroid(faces[idx].pts);
        const align = (c.x - sx) * stayDirX + (c.y - sy) * stayDirY;
        if (align > bestAlign) { bestAlign = align; bestSeed = idx; }
      }
      seeds = [bestSeed];
    }
    if (seeds.length > 0) {
      const candidateSet = new Set(candidateIdx);
      const excludeBottomBase = layerScope === 'top' && targetLayer > gMinLayer + 0.05;
      const excludeTopBase = layerScope === 'bottom' && targetLayer < gMaxLayer - 0.05;
      const visited = new Set(seeds);
      const queue = [...seeds];
      while (queue.length > 0) {
        const cur = queue.shift();
        // 1. Same-layer UV neighbors (keeps creased single-layer flaps intact)
        for (const nxt of layerIndices) {
          if (visited.has(nxt)) continue;
          if (facesShareUVEdge(faces[cur], faces[nxt])) {
            visited.add(nxt);
            queue.push(nxt);
          }
        }
        // 2. Cross-layer UV neighbors hinged strictly on movingSide (keeps multi-layer folded tabs together!)
        for (const nxt of candidateIdx) {
          if (visited.has(nxt)) continue;
          if (excludeBottomBase && faces[nxt].layer <= gMinLayer + 0.05) continue;
          if (excludeTopBase && faces[nxt].layer >= gMaxLayer - 0.05) continue;
          if (facesShareMovingUVEdge(faces[cur], faces[nxt], planeOrigin, planeNormal, movingSide)) {
            visited.add(nxt);
            queue.push(nxt);
          }
        }
      }
      const isolated = new Set();
      for (const idx of visited) {
        if (candidateSet.has(idx)) isolated.add(idx);
      }
      if (isolated.size > 0) return isolated;
    }
  }

  return eligible;
}

/**
 * Extract 2D UV crease segment generated when a polygon is split by a plane.
 */
function extractCreaseSegmentUV(posPoly, negPoly, planeOrigin, planeNormal) {
  if (!posPoly || !negPoly) return null;
  const onPlaneUVs = [];
  for (let i = 0; i < posPoly.pts.length; i++) {
    const d = Math.abs(dot(sub(posPoly.pts[i], planeOrigin), planeNormal));
    if (d < 1e-3) {
      onPlaneUVs.push(posPoly.uvs[i]);
    }
  }
  if (onPlaneUVs.length < 2) return null;
  // Find furthest pair
  let bestD = -1, a = onPlaneUVs[0], b = onPlaneUVs[1];
  for (let i = 0; i < onPlaneUVs.length; i++) {
    for (let j = i + 1; j < onPlaneUVs.length; j++) {
      const dd = Math.hypot(onPlaneUVs[i].u - onPlaneUVs[j].u, onPlaneUVs[i].v - onPlaneUVs[j].v);
      if (dd > bestD) {
        bestD = dd;
        a = onPlaneUVs[i];
        b = onPlaneUVs[j];
      }
    }
  }
  if (bestD < 1e-4) return null;
  return { u1: a.u, v1: a.v, u2: b.u, v2: b.v };
}

/**
 * Compute exact 3D crease hinge (origin + unit axis) for a moving polygon piece so
 * faces sitting at z != 0 (e.g. after a pleat or partial-angle fold) stay 100% welded
 * along their cut edge with zero Z-discontinuity.
 */
function computeFaceHinge(pos, neg, movingPoly, p1, planeNormal, axis) {
  if (pos && neg) {
    const onPlane = [];
    for (let i = 0; i < pos.pts.length; i++) {
      const p = pos.pts[i];
      if (Math.abs(dot(sub(p, p1), planeNormal)) < 1e-3) {
        onPlane.push(p);
      }
    }
    if (onPlane.length >= 2) {
      let bestD = -1, a = onPlane[0], b = onPlane[1];
      for (let i = 0; i < onPlane.length; i++) {
        for (let j = i + 1; j < onPlane.length; j++) {
          const dd = dist(onPlane[i], onPlane[j]);
          if (dd > bestD) { bestD = dd; a = onPlane[i]; b = onPlane[j]; }
        }
      }
      if (bestD > 1e-5) {
        let hAxis = norm(sub(b, a));
        if (dot(hAxis, axis) < 0) hAxis = scale(hAxis, -1);
        return { origin: a, axis: hAxis };
      }
    }
  }
  if (movingPoly && movingPoly.pts.length > 0) {
    let minZ = Infinity, maxZ = -Infinity, sumZ = 0;
    for (const p of movingPoly.pts) {
      const z = p.z || 0;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
      sumZ += z;
    }
    if (maxZ - minZ < 1e-3) {
      const avgZ = sumZ / movingPoly.pts.length;
      if (Math.abs(avgZ) > 1e-4) {
        return { origin: v3(p1.x, p1.y, avgZ), axis };
      }
    }
  }
  return { origin: p1, axis };
}

// ---------------------------------------------------------------------------
// Physical paper bending: while a flap is mid-fold, real paper does not hinge
// like sheet metal — it rolls over a soft cylindrical bend next to the crease
// line which tightens into a sharp crease as the fold is pressed flat.
// ---------------------------------------------------------------------------

/** Peak bend radius as a fraction of the paper's half-size. */
const BEND_RADIUS_FRAC = 0.075;
/** Max faces the renderer should receive once bend strips are added. */
const BEND_FACE_BUDGET = 340;

/**
 * Precompute the per-face bend frame (radial direction away from the hinge) for
 * moving faces. Faces that are not lying flat (|n.z| < 0.995) stay rigid.
 */
function prepareBendFrames(moveFaces, defaultOrigin, defaultAxis, radialDir) {
  let maxS = 0;
  const frames = moveFaces.map(f => {
    const origin = f.hingeOrigin || defaultOrigin;
    const axis = f.hingeAxis || defaultAxis;
    const n = polyNormal(f.pts);
    if (Math.abs(n.z) < 0.995) return null;
    // Radial direction: horizontal, perpendicular to the hinge, pointing into the moving side
    let u = sub(radialDir, scale(axis, dot(radialDir, axis)));
    u = v3(u.x, u.y, 0);
    const ul = Math.hypot(u.x, u.y);
    if (ul < 1e-6) return null;
    u = scale(u, 1 / ul);
    let fMax = 0;
    for (const p of f.pts) {
      const s = dot(sub(p, origin), u);
      if (s > fMax) fMax = s;
    }
    if (fMax > maxS) maxS = fMax;
    return { origin, axis, u, maxS: fMax };
  });
  return { frames, maxS };
}

/**
 * Wrap a flat moving face around a cylinder of radius `r` tangent to the hinge.
 * Arc length is preserved (isometric up to chord subdivision), so the flap's far
 * region continues straight at the full rotation angle `ang` beyond the bend.
 * Returns the replacement face list (bend strips + straight remainder).
 */
function bendFaceAroundHinge(face, frame, ang, r, segs, layer) {
  const absAng = Math.abs(ang);
  const sgn = ang >= 0 ? 1 : -1;
  const { origin: H, axis, u } = frame;
  // w = direction the flap lifts toward at the hinge (u rotated +/-90deg about axis)
  const w = scale(cross(axis, u), sgn);
  const L = r * absAng;
  const cosA = Math.cos(absAng), sinA = Math.sin(absAng);
  const arcEnd = add(scale(u, r * sinA), scale(w, r * (1 - cosA)));
  const tailDir = add(scale(u, cosA), scale(w, sinA));

  const mapPoint = (p) => {
    const d = sub(p, H);
    const a = dot(d, axis);
    const s = dot(d, u);
    const rest = sub(sub(d, scale(axis, a)), scale(u, s));
    let local, base;
    if (s <= 0) {
      local = 0;
      base = scale(u, s);
    } else if (s < L) {
      local = s / r;
      base = add(scale(u, r * Math.sin(local)), scale(w, r * (1 - Math.cos(local))));
    } else {
      local = absAng;
      base = add(arcEnd, scale(tailDir, s - L));
    }
    const restRot = (Math.abs(rest.x) + Math.abs(rest.y) + Math.abs(rest.z)) > 1e-9
      ? rotateAroundAxis(rest, v3(0, 0, 0), axis, sgn * local)
      : rest;
    return add(add(add(H, scale(axis, a)), base), restRot);
  };

  // Slice the face into strips at s = L*k/segs (k = 1..segs) parallel to the hinge
  const cuts = [];
  for (let k = 1; k <= segs; k++) cuts.push((L * k) / segs);
  const pieces = [];
  let remaining = { pts: face.pts, uvs: face.uvs };
  for (let k = 0; k < cuts.length && remaining; k++) {
    const { pos, neg } = splitPolygonByPlane(remaining.pts, remaining.uvs, add(H, scale(u, cuts[k])), u);
    if (neg) pieces.push({ ...neg, strip: true });
    remaining = pos;
  }
  if (remaining) pieces.push({ ...remaining, strip: false });

  const onCut = (p) => {
    const s = dot(sub(p, H), u);
    for (let k = 0; k < cuts.length; k++) {
      if (Math.abs(s - cuts[k]) < 2e-5) return true;
    }
    return false;
  };

  return pieces.map(pc => {
    const n = pc.pts.length;
    const smoothEdges = new Array(n);
    for (let i = 0; i < n; i++) {
      smoothEdges[i] = onCut(pc.pts[i]) && onCut(pc.pts[(i + 1) % n]);
    }
    return {
      pts: pc.pts.map(mapPoint),
      uvs: pc.uvs,
      layer,
      smoothEdges,
      bendStrip: pc.strip,
      bent: true,
    };
  });
}

/**
 * Bend radius used for a flap at a given fold progress (exported so direct-drag
 * interaction can compensate for the bend and keep the grabbed corner under the finger).
 */
export function estimateBendRadius(foldProgress, absTargetAng, maxS, paperHalf = 1) {
  const p = Math.max(0, Math.min(1, foldProgress));
  const ang = absTargetAng * p;
  if (ang < 0.05 || p >= 0.998) return 0;
  const r = paperHalf * BEND_RADIUS_FRAC * Math.sin(Math.PI * p);
  // Keep the bent zone a modest fraction of the flap so small flaps stay believable
  return Math.max(0, Math.min(r, (maxS * 0.42) / ang));
}

/**
 * Offset of a bent flap's far region relative to the rigid hinge rotation, in the
 * hinge frame: returns { du, dw } (u = away from hinge in-plane, w = lift direction).
 */
export function bendTipOffset(ang, r) {
  const a = Math.abs(ang);
  return {
    du: r * (Math.sin(a) - a * Math.cos(a)),
    dw: r * (1 - Math.cos(a) - a * Math.sin(a)),
  };
}

/**
 * Decide the bend radius / strip count for the current fold progress.
 * Returns null when the fold should be rendered rigidly (crisp crease).
 */
function resolveBend(opts, foldProgress, absTargetAng, bendInfo, totalFaces, moveCount, paperHalf) {
  if (opts && opts.bend === false) return null;
  if (!bendInfo || bendInfo.maxS <= 1e-4 || moveCount === 0) return null;
  if (foldProgress <= 0.002 || foldProgress >= 0.998) return null;
  const ang = absTargetAng * foldProgress;
  if (ang < 0.05) return null;
  const amount = opts && Number.isFinite(opts.bendAmount) ? opts.bendAmount : 1;
  const r = estimateBendRadius(foldProgress, absTargetAng, bendInfo.maxS, paperHalf) * amount;
  if (r * ang < 0.006) return null;
  const budget = Math.floor((BEND_FACE_BUDGET - totalFaces) / Math.max(1, moveCount));
  const segs = Math.min(Math.max(2, Math.ceil(ang / (Math.PI / 11))), 9, budget);
  if (segs < 2) return null;
  return { r, segs };
}

/**
 * Prepare a single planar step on a base PaperState, returning a fast evaluator
 * function(t in [0,1], opts?) -> { faces, guides, creases } and the final end state.
 *
 * opts.progress — explicit fold progress in [0,1] (linear in angle, no easing);
 *                 used by direct-manipulation dragging so the flap tracks the finger.
 * opts.bend     — false disables the soft cylindrical paper bend near the hinge.
 */
export function compilePlanarStep(baseState, step) {
  const type = step.type;
  const paperHalf = Math.max(0.2, Math.max(baseState.width || 2, baseState.height || 2) * 0.5);
  const progressOf = (t, opts) => (opts && Number.isFinite(opts.progress)
    ? Math.max(0, Math.min(1, opts.progress))
    : easeInOutCubic(t));

  // 1. FLIP (Turn paper over 180 deg around Y or X axis)
  if (type === 'flip') {
    const axis = step.axis === 'x' ? v3(1, 0, 0) : v3(0, 1, 0);
    const origin = v3(0, 0, 0);
    const evaluate = (t) => {
      const e = easeInOutCubic(t);
      const ang = Math.PI * e;
      const faces = baseState.faces.map(f => ({
        pts: f.pts.map(p => rotateAroundAxis(p, origin, axis, ang)),
        uvs: f.uvs,
        layer: e > 0.5 ? -f.layer : f.layer,
      }));
      return {
        faces,
        creases: baseState.creases,
        guides: [],
      };
    };
    const endState = clonePaperState(baseState);
    endState.faces = endState.faces.map(f => ({
      pts: f.pts.map(p => {
        const rp = rotateAroundAxis(p, origin, axis, Math.PI);
        if (Math.abs(rp.z) < 1e-4) rp.z = 0;
        return rp;
      }),
      uvs: f.uvs,
      layer: -f.layer,
    }));
    compactLayers(endState.faces);
    return { evaluate, endState };
  }

  // 2. ROTATE (Rotate paper around Z axis)
  if (type === 'rotate') {
    const axis = v3(0, 0, 1);
    const origin = v3(0, 0, 0);
    const totalRad = ((step.angleDeg ?? 90) * Math.PI) / 180;
    const evaluate = (t) => {
      const ang = totalRad * easeInOutCubic(t);
      const faces = baseState.faces.map(f => ({
        pts: f.pts.map(p => rotateAroundAxis(p, origin, axis, ang)),
        uvs: f.uvs,
        layer: f.layer,
      }));
      return { faces, creases: baseState.creases, guides: [] };
    };
    const endState = clonePaperState(baseState);
    endState.faces = endState.faces.map(f => ({
      pts: f.pts.map(p => rotateAroundAxis(p, origin, axis, totalRad)),
      uvs: f.uvs,
      layer: f.layer,
    }));
    return { evaluate, endState };
  }

  // 3. MULTI-FOLD (Simultaneous independent folds, e.g. symmetric wings or corners)
  if (type === 'multiFold') {
    const subFolds = step.folds || [];
    // Apply splits sequentially on a working list, tagging each face with its fold group index (-1 = stationary)
    let workFaces = baseState.faces.map((f, i) => ({
      pts: f.pts.map(p => ({ ...p })),
      uvs: f.uvs.map(u => ({ ...u })),
      layer: f.layer,
      foldIdx: -1,
      origIdx: i,
    }));
    const addedCreases = [];
    const guides = [];
    const foldInfos = [];

    subFolds.forEach((sf, fi) => {
      const p1 = v3(sf.p1[0], sf.p1[1], sf.p1[2] || 0);
      const p2 = v3(sf.p2[0], sf.p2[1], sf.p2[2] || 0);
      const axis = norm(sub(p2, p1));
      const planeNormal = sf.planeNormal
        ? norm(v3(sf.planeNormal[0], sf.planeNormal[1], sf.planeNormal[2]))
        : norm(cross(v3(0, 0, 1), axis)); // (-dy, dx, 0)
      const side = sf.side >= 0 ? 1 : -1;
      const fType = sf.foldType || 'valley';
      const angleDeg = Math.abs(sf.angleDeg ?? 180);
      const targetAngle = sf.rawAngleDeg !== undefined
        ? (sf.rawAngleDeg * Math.PI) / 180
        : ((fType === 'mountain' ? -1 : 1) * side) * (angleDeg * Math.PI) / 180;
      const eligible = filterLayerEligible(workFaces, side, p1, planeNormal, sf.layerScope || 'all', sf.targetLayer ?? null, sf.seedPoint ?? null);

      guides.push({ p1, p2, type: fType });
      foldInfos.push({ origin: p1, axis, targetAngle, fType, angleDeg, radialDir: scale(planeNormal, side) });

      const nextWork = [];
      for (let i = 0; i < workFaces.length; i++) {
        const f = workFaces[i];
        if (f.foldIdx !== -1 || !eligible.has(i)) {
          nextWork.push(f);
          continue;
        }
        if (sf.xFilter) {
          const c = polyCentroid(f.pts);
          if ((sf.xFilter === 'pos' && c.x < -1e-4) || (sf.xFilter === 'neg' && c.x > 1e-4)) {
            nextWork.push(f);
            continue;
          }
        }
        const { pos, neg } = splitPolygonByPlane(f.pts, f.uvs, p1, planeNormal);
        const seg = extractCreaseSegmentUV(pos, neg, p1, planeNormal);
        if (seg) addedCreases.push({ ...seg, type: fType });

        const movingPoly = side > 0 ? pos : neg;
        const stayPoly = side > 0 ? neg : pos;
        if (stayPoly) {
          nextWork.push({ ...stayPoly, layer: f.layer, foldIdx: -1, origIdx: f.origIdx });
        }
        if (movingPoly) {
          const hinge = computeFaceHinge(pos, neg, movingPoly, p1, planeNormal, axis);
          nextWork.push({ ...movingPoly, layer: f.layer, foldIdx: fi, origIdx: f.origIdx, hingeOrigin: hinge.origin, hingeAxis: hinge.axis });
        }
      }
      workFaces = nextWork;
    });

    const maxAll = Math.max(...workFaces.map(f => f.layer), 0);
    const minAll = Math.min(...workFaces.map(f => f.layer), 0);

    // Per-face bend frames (each sub-fold bends around its own hinge)
    const mfMoving = workFaces.filter(f => f.foldIdx !== -1);
    const mfBendFrames = new Map();
    let mfMaxS = 0;
    foldInfos.forEach((info, fi) => {
      const group = mfMoving.filter(f => f.foldIdx === fi);
      const prep = prepareBendFrames(group, info.origin, info.axis, info.radialDir);
      group.forEach((f, k) => mfBendFrames.set(f, prep.frames[k]));
      if (prep.maxS > mfMaxS) mfMaxS = prep.maxS;
    });
    const mfAbsTarget = Math.max(0, ...foldInfos.map(info => Math.abs(info.targetAngle)));

    const evaluate = (t, opts) => {
      const e = progressOf(t, opts);
      const bend = resolveBend(opts, e, mfAbsTarget, { maxS: mfMaxS }, workFaces.length, mfMoving.length, paperHalf);
      const faces = [];
      for (const f of workFaces) {
        if (f.foldIdx === -1) {
          faces.push({ pts: f.pts, uvs: f.uvs, layer: f.layer });
          continue;
        }
        const info = foldInfos[f.foldIdx];
        const ang = info.targetAngle * e;
        let layer = f.layer;
        if (e > 0.51 && info.angleDeg >= 165) {
          layer = info.fType === 'valley'
            ? maxAll + 1 + (maxAll - f.layer)
            : minAll - 1 - (f.layer - minAll);
        }
        const frame = bend ? mfBendFrames.get(f) : null;
        if (frame) {
          const r = Math.min(bend.r, (frame.maxS * 0.42) / Math.max(0.05, Math.abs(ang)));
          if (r * Math.abs(ang) >= 0.006) {
            for (const bf of bendFaceAroundHinge(f, frame, ang, r, bend.segs, layer)) faces.push(bf);
            continue;
          }
        }
        const hOrigin = f.hingeOrigin || info.origin;
        const hAxis = f.hingeAxis || info.axis;
        faces.push({
          pts: f.pts.map(p => rotateAroundAxis(p, hOrigin, hAxis, ang)),
          uvs: f.uvs,
          layer,
        });
      }
      return {
        faces,
        creases: [...baseState.creases, ...addedCreases],
        guides,
      };
    };

    const finalEval = evaluate(1.0, { progress: 1, bend: false });
    const endState = {
      faces: finalEval.faces.map(f => ({
        pts: f.pts.map(p => ({
          x: p.x,
          y: p.y,
          z: Math.abs(p.z) < 1e-4 ? 0 : p.z,
        })),
        uvs: f.uvs.map(u => ({ ...u })),
        layer: f.layer,
      })),
      creases: [...baseState.creases, ...addedCreases],
      width: baseState.width,
      height: baseState.height,
      rotationDeg: baseState.rotationDeg,
    };
    compactLayers(endState.faces);
    return { evaluate, endState };
  }

  // 4. PLEAT FOLD (Two parallel creases: Valley + Mountain simultaneously, front or back side)
  if (type === 'pleat') {
    const p1 = v3(step.p1[0], step.p1[1], step.p1[2] || 0);
    const p2 = v3(step.p2[0], step.p2[1], step.p2[2] || 0);
    const axis = norm(sub(p2, p1));
    const planeNormal = norm(cross(v3(0, 0, 1), axis));
    const side = step.side >= 0 ? 1 : -1;
    const offset = Math.max(0.08, Math.abs(step.offset ?? 0.25));
    const shiftVec = scale(planeNormal, side * offset);
    const q1 = add(p1, shiftVec);
    const q2 = add(p2, shiftVec);
    const angleDeg = Math.abs(step.angleDeg ?? 180);
    const isBackPleat = step.foldDir === 'mountain' || step.creaseType === 'mountain';
    const firstType = isBackPleat ? 'mountain' : 'valley';
    const secondType = isBackPleat ? 'valley' : 'mountain';
    const firstSign = (isBackPleat ? -1 : 1) * side;
    const targetAng1 = firstSign * (angleDeg * Math.PI) / 180;
    const targetAng2 = -targetAng1; // second crease is opposite

    const eligible = filterLayerEligible(baseState.faces, side, p1, planeNormal, step.layerScope || 'all', step.targetLayer ?? null, step.seedPoint ?? null);
    const pieces = []; // group: 0 = stationary, 1 = middle strip, 2 = far region
    const addedCreases = [];

    for (let i = 0; i < baseState.faces.length; i++) {
      const f = baseState.faces[i];
      if (!eligible.has(i)) {
        pieces.push({ pts: f.pts, uvs: f.uvs, layer: f.layer, group: 0 });
        continue;
      }
      const s1 = splitPolygonByPlane(f.pts, f.uvs, p1, planeNormal);
      const seg1 = extractCreaseSegmentUV(s1.pos, s1.neg, p1, planeNormal);
      if (seg1) addedCreases.push({ ...seg1, type: firstType });

      const stay1 = side > 0 ? s1.neg : s1.pos;
      const move1 = side > 0 ? s1.pos : s1.neg;
      if (stay1) pieces.push({ ...stay1, layer: f.layer, group: 0 });
      if (move1) {
        const s2 = splitPolygonByPlane(move1.pts, move1.uvs, q1, planeNormal);
        const seg2 = extractCreaseSegmentUV(s2.pos, s2.neg, q1, planeNormal);
        if (seg2) addedCreases.push({ ...seg2, type: secondType });

        const midStrip = side > 0 ? s2.neg : s2.pos;
        const farRegion = side > 0 ? s2.pos : s2.neg;
        if (midStrip) pieces.push({ ...midStrip, layer: f.layer, group: 1 });
        if (farRegion) pieces.push({ ...farRegion, layer: f.layer, group: 2 });
      }
    }

    const maxAll = Math.max(...pieces.map(p => p.layer), 0);
    const minAll = Math.min(...pieces.map(p => p.layer), 0);
    const guides = [
      { p1, p2, type: firstType },
      { p1: q1, p2: q2, type: secondType },
    ];

    const evaluate = (t, opts) => {
      const e = progressOf(t, opts);
      const a1 = targetAng1 * e;
      const a2 = targetAng2 * e;
      const q1Moved = rotateAroundAxis(q1, p1, axis, a1);

      const faces = pieces.map(pc => {
        if (pc.group === 0) {
          return { pts: pc.pts, uvs: pc.uvs, layer: pc.layer };
        }
        if (pc.group === 1) {
          const layer = (e > 0.51 && angleDeg >= 165)
            ? (isBackPleat ? minAll - 1 - (pc.layer - minAll) : maxAll + 1 + (maxAll - pc.layer))
            : pc.layer;
          return {
            pts: pc.pts.map(p => rotateAroundAxis(p, p1, axis, a1)),
            uvs: pc.uvs,
            layer,
          };
        }
        // Group 2: first rotate around p1 by a1, then around q1Moved by a2 (stays parallel!)
        const layer = (e > 0.51 && angleDeg >= 165)
          ? (isBackPleat ? minAll - 3 - (pc.layer - minAll) : maxAll + 3 + pc.layer)
          : pc.layer;
        return {
          pts: pc.pts.map(p => {
            const pMid = rotateAroundAxis(p, p1, axis, a1);
            return rotateAroundAxis(pMid, q1Moved, axis, a2);
          }),
          uvs: pc.uvs,
          layer,
        };
      });
      return {
        faces,
        creases: [...baseState.creases, ...addedCreases],
        guides,
      };
    };

    const endEval = evaluate(1.0, { progress: 1 });
    const endState = {
      faces: endEval.faces.map(f => ({
        pts: f.pts.map(p => ({ x: p.x, y: p.y, z: Math.abs(p.z) < 1e-4 ? 0 : p.z })),
        uvs: f.uvs.map(u => ({ ...u })),
        layer: f.layer,
      })),
      creases: [...baseState.creases, ...addedCreases],
      width: baseState.width,
      height: baseState.height,
      rotationDeg: baseState.rotationDeg,
    };
    compactLayers(endState.faces);
    return { evaluate, endState };
  }

  // 5. VALLEY, MOUNTAIN, or PRECREASE (supports both front/valley and back/mountain directions)
  const isPrecrease = type === 'precrease';
  const foldType = (type === 'mountain' || step.foldDir === 'mountain' || step.creaseType === 'mountain') ? 'mountain' : 'valley';
  const p1 = v3(step.p1[0], step.p1[1], step.p1[2] || 0);
  const p2 = v3(step.p2[0], step.p2[1], step.p2[2] || 0);
  const axis = norm(sub(p2, p1));
  const planeNormal = norm(cross(v3(0, 0, 1), axis)); // (-dy, dx, 0)
  const side = step.side >= 0 ? 1 : -1;
  const angleDeg = Math.abs(step.angleDeg ?? (isPrecrease ? 155 : 180));
  const sign = (foldType === 'mountain' ? -1 : 1) * side;
  const targetAngle = sign * (angleDeg * Math.PI) / 180;

  const layerScope = step.layerScope || 'all';
  const eligible = filterLayerEligible(baseState.faces, side, p1, planeNormal, layerScope, step.targetLayer ?? null, step.seedPoint ?? null);

  const stayFaces = [];
  const moveFaces = [];
  const addedCreases = [];

  for (let i = 0; i < baseState.faces.length; i++) {
    const f = baseState.faces[i];
    if (!eligible.has(i)) {
      stayFaces.push({ pts: f.pts, uvs: f.uvs, layer: f.layer });
      continue;
    }
    const { pos, neg } = splitPolygonByPlane(f.pts, f.uvs, p1, planeNormal);
    const seg = extractCreaseSegmentUV(pos, neg, p1, planeNormal);
    if (seg) addedCreases.push({ ...seg, type: step.creaseType || foldType });

    const movingPoly = side > 0 ? pos : neg;
    const stayPoly = side > 0 ? neg : pos;
    if (stayPoly) stayFaces.push({ ...stayPoly, layer: f.layer });
    if (movingPoly) {
      const hinge = computeFaceHinge(pos, neg, movingPoly, p1, planeNormal, axis);
      moveFaces.push({ ...movingPoly, layer: f.layer, hingeOrigin: hinge.origin, hingeAxis: hinge.axis });
    }
  }

  const allLayers = [...stayFaces, ...moveFaces].map(f => f.layer);
  const maxAll = allLayers.length ? Math.max(...allLayers) : 0;
  const minAll = allLayers.length ? Math.min(...allLayers) : 0;
  const moveMax = moveFaces.length ? Math.max(...moveFaces.map(f => f.layer)) : 0;
  const moveMin = moveFaces.length ? Math.min(...moveFaces.map(f => f.layer)) : 0;

  // For single-layer folds ('top'|'bottom'), detect any untouched stationary sheet directly
  // behind/above the moving flap so tucking a flap backward lands inside the pocket between
  // the flap and the base sheet instead of phasing through solid paper!
  let belowMax = -Infinity;
  let aboveMin = Infinity;
  if (layerScope !== 'all' && moveFaces.length > 0) {
    for (const sf of stayFaces) {
      if (sf.layer < moveMin - 0.05 && sf.layer > belowMax) belowMax = sf.layer;
      if (sf.layer > moveMax + 0.05 && sf.layer < aboveMin) aboveMin = sf.layer;
    }
  }

  const guides = [{ p1, p2, type: step.creaseType || foldType }];
  const bendPrep = prepareBendFrames(moveFaces, p1, axis, scale(planeNormal, side));
  const absTargetAngle = Math.abs(targetAngle);

  const evaluate = (t, opts) => {
    let foldProgress;
    if (opts && Number.isFinite(opts.progress)) {
      foldProgress = Math.max(0, Math.min(1, opts.progress));
    } else if (isPrecrease) {
      // Fold smoothly to peak at t = 0.52, hold briefly, then unfold back to 0
      if (t < 0.48) foldProgress = easeInOutCubic(t / 0.48);
      else if (t < 0.58) foldProgress = 1.0;
      else foldProgress = 1.0 - easeInOutCubic((t - 0.58) / 0.42);
    } else {
      foldProgress = easeInOutCubic(t);
    }

    const ang = targetAngle * foldProgress;
    const outFaces = stayFaces.map(f => ({
      pts: f.pts,
      uvs: f.uvs,
      layer: f.layer,
    }));

    const isInwardSingle = (layerScope === 'top' && foldType === 'mountain')
      || (layerScope === 'bottom' && foldType === 'valley');
    const bend = resolveBend(opts, foldProgress, absTargetAngle, bendPrep, stayFaces.length + moveFaces.length, moveFaces.length, paperHalf);
    for (let mi = 0; mi < moveFaces.length; mi++) {
      const f = moveFaces[mi];
      let layer = f.layer;
      if (!isPrecrease && foldProgress > 0.51 && angleDeg >= 165) {
        if (foldType === 'valley') {
          if (isInwardSingle && Number.isFinite(aboveMin)) {
            const span = Math.max(1, moveMax - moveMin + 1);
            const frac = (moveMax - f.layer + 1) / (span + 1);
            layer = moveMax + (aboveMin - moveMax) * frac;
          } else {
            layer = maxAll + 1 + (moveMax - f.layer);
          }
        } else {
          if (isInwardSingle && Number.isFinite(belowMax)) {
            const span = Math.max(1, moveMax - moveMin + 1);
            const frac = (f.layer - moveMin + 1) / (span + 1);
            layer = moveMin - (moveMin - belowMax) * frac;
          } else {
            layer = minAll - 1 - (f.layer - moveMin);
          }
        }
      }
      const frame = bend ? bendPrep.frames[mi] : null;
      if (frame) {
        const r = Math.min(bend.r, (frame.maxS * 0.42) / Math.max(0.05, Math.abs(ang)));
        if (r * Math.abs(ang) >= 0.006) {
          const bentFaces = bendFaceAroundHinge(f, frame, ang, r, bend.segs, layer);
          for (const bf of bentFaces) outFaces.push(bf);
          continue;
        }
      }
      const hOrigin = f.hingeOrigin || p1;
      const hAxis = f.hingeAxis || axis;
      outFaces.push({
        pts: f.pts.map(p => rotateAroundAxis(p, hOrigin, hAxis, ang)),
        uvs: f.uvs,
        layer,
      });
    }

    return {
      faces: outFaces,
      creases: [...baseState.creases, ...addedCreases],
      guides,
    };
  };

  let endState;
  if (isPrecrease) {
    // Keep split faces (so crease line is visible on 3D paper!) in unfolded positions
    endState = {
      faces: [...stayFaces, ...moveFaces].map(f => ({
        pts: f.pts.map(p => ({ ...p })),
        uvs: f.uvs.map(u => ({ ...u })),
        layer: f.layer,
      })),
      creases: [...baseState.creases, ...addedCreases],
      width: baseState.width,
      height: baseState.height,
      rotationDeg: baseState.rotationDeg,
    };
  } else {
    const endEval = evaluate(1.0, { progress: 1, bend: false });
    endState = {
      faces: endEval.faces.map(f => ({
        pts: f.pts.map(p => ({
          x: p.x,
          y: p.y,
          z: Math.abs(p.z) < 1e-4 ? 0 : p.z,
        })),
        uvs: f.uvs.map(u => ({ ...u })),
        layer: f.layer,
      })),
      creases: [...baseState.creases, ...addedCreases],
      width: baseState.width,
      height: baseState.height,
      rotationDeg: baseState.rotationDeg,
    };
    compactLayers(endState.faces);
  }

  return { evaluate, endState };
}

/**
 * Apply a list of rigid whole-paper transforms (flip / rotate) that occurred
 * after a fold step so unfolding always animates in the paper's current frame.
 */
function applyRigidOpsToPoint(p, ops) {
  let out = { x: p.x, y: p.y, z: p.z || 0 };
  const origin = v3(0, 0, 0);
  for (const op of ops) {
    if (op.type === 'flip') {
      const axis = op.axis === 'x' ? v3(1, 0, 0) : v3(0, 1, 0);
      out = rotateAroundAxis(out, origin, axis, Math.PI);
    } else if (op.type === 'rotate') {
      const rad = ((op.angleDeg ?? 90) * Math.PI) / 180;
      out = rotateAroundAxis(out, origin, v3(0, 0, 1), rad);
    }
  }
  return out;
}

function applyRigidOpsToFrame(frame, ops) {
  if (!ops || ops.length === 0) return frame;
  let flipSign = 1;
  for (const op of ops) {
    if (op.type === 'flip') flipSign *= -1;
  }
  return {
    faces: frame.faces.map(f => ({
      ...f,
      pts: f.pts.map(p => applyRigidOpsToPoint(p, ops)),
      uvs: f.uvs,
      layer: f.layer * flipSign,
    })),
    creases: frame.creases,
    guides: (frame.guides || []).map(g => ({
      ...g,
      p1: applyRigidOpsToPoint(g.p1, ops),
      p2: applyRigidOpsToPoint(g.p2, ops),
    })),
  };
}

function buildEndStateFromFaces(faces, baseState) {
  const endState = {
    faces: faces.map(f => ({
      pts: f.pts.map(p => ({
        x: p.x,
        y: p.y,
        z: Math.abs(p.z) < 1e-4 ? 0 : p.z,
      })),
      uvs: f.uvs.map(u => ({ ...u })),
      layer: f.layer,
    })),
    creases: baseState.creases.map(c => ({ ...c })),
    width: baseState.width,
    height: baseState.height,
    rotationDeg: baseState.rotationDeg,
  };
  compactLayers(endState.faces);
  return endState;
}

function compileUnfoldEntry(curState, entry) {
  // opts.progress here is the UNFOLD progress (0 = still folded, 1 = fully opened)
  const evaluate = (t, opts) => {
    const u = Math.max(0, Math.min(1, 1 - t));
    const innerOpts = opts && Number.isFinite(opts.progress)
      ? { ...opts, progress: 1 - Math.max(0, Math.min(1, opts.progress)) }
      : opts;
    const raw = applyRigidOpsToFrame(entry.compiled.evaluate(u, innerOpts), entry.postRigids);
    return {
      faces: raw.faces,
      creases: curState.creases,
      guides: raw.guides,
    };
  };
  const endEval = evaluate(1.0, { progress: 1, bend: false });
  const endState = buildEndStateFromFaces(endEval.faces, curState);
  return { evaluate, endState };
}

function compileUnfoldAllEntries(curState, stackEntries) {
  if (!stackEntries.length) {
    const endState = clonePaperState(curState);
    return {
      evaluate: () => ({ faces: curState.faces, creases: curState.creases, guides: [] }),
      endState,
    };
  }
  const ordered = stackEntries.slice().reverse();
  const k = ordered.length;
  const evaluate = (t) => {
    const clamped = Math.max(0, Math.min(1, t));
    if (clamped >= 1) {
      const last = ordered[k - 1];
      const raw = applyRigidOpsToFrame(last.compiled.evaluate(0), last.postRigids);
      return { faces: raw.faces, creases: curState.creases, guides: [] };
    }
    const scaled = clamped * k;
    const idx = Math.min(k - 1, Math.floor(scaled));
    const localT = scaled - idx;
    const entry = ordered[idx];
    const raw = applyRigidOpsToFrame(entry.compiled.evaluate(1 - localT), entry.postRigids);
    return {
      faces: raw.faces,
      creases: curState.creases,
      guides: raw.guides,
    };
  };
  const endEval = evaluate(1.0);
  const endState = buildEndStateFromFaces(endEval.faces, curState);
  return { evaluate, endState };
}

/**
 * Extract folded -> unfolded handle pairs for the top active fold so users can
 * pull a folded corner/edge back outward to unfold it intuitively in 3D.
 */
function computeUnfoldHint(curState, entry) {
  const rigid = { bend: false };
  const f0 = applyRigidOpsToFrame(entry.compiled.evaluate(0, { ...rigid, progress: 0 }), entry.postRigids).faces;
  const f1 = applyRigidOpsToFrame(entry.compiled.evaluate(1, { ...rigid, progress: 1 }), entry.postRigids).faces;
  const fMid = applyRigidOpsToFrame(entry.compiled.evaluate(0.5, { ...rigid, progress: 0.5 }), entry.postRigids).faces;
  const candidates = [];
  let maxDist = 0;

  const count = Math.min(f0.length, f1.length, fMid.length);
  for (let i = 0; i < count; i++) {
    const pts0 = f0[i].pts;
    const pts1 = f1[i].pts;
    const ptsM = fMid[i].pts;
    const n = Math.min(pts0.length, pts1.length, ptsM.length);
    for (let j = 0; j < n; j++) {
      const a0 = pts0[j];
      const a1 = pts1[j];
      const aM = ptsM[j];
      const d = Math.hypot(a1.x - a0.x, a1.y - a0.y, (a1.z || 0) - (a0.z || 0));
      if (d > 0.16) {
        if (d > maxDist) maxDist = d;
        candidates.push({
          folded: v3(a1.x, a1.y, a1.z || 0),
          unfolded: v3(a0.x, a0.y, a0.z || 0),
          mid: v3(aM.x, aM.y, aM.z || 0),
          dist: d,
        });
      }
      // Also include edge midpoints so dragging the middle of a folded edge works too
      const k = (j + 1) % n;
      const b0 = pts0[k];
      const b1 = pts1[k];
      const bM = ptsM[k];
      const m0 = v3((a0.x + b0.x) * 0.5, (a0.y + b0.y) * 0.5, ((a0.z || 0) + (b0.z || 0)) * 0.5);
      const m1 = v3((a1.x + b1.x) * 0.5, (a1.y + b1.y) * 0.5, ((a1.z || 0) + (b1.z || 0)) * 0.5);
      const mM = v3((aM.x + bM.x) * 0.5, (aM.y + bM.y) * 0.5, ((aM.z || 0) + (bM.z || 0)) * 0.5);
      const dm = Math.hypot(m1.x - m0.x, m1.y - m0.y, m1.z - m0.z);
      if (dm > 0.16) {
        if (dm > maxDist) maxDist = dm;
        candidates.push({ folded: m1, unfolded: m0, mid: mM, dist: dm });
      }
    }
  }

  const pairs = [];
  const threshold = Math.max(0.18, maxDist * 0.62);
  candidates.sort((a, b) => b.dist - a.dist);
  for (const c of candidates) {
    if (c.dist < threshold) continue;
    const dup = pairs.some(p =>
      Math.hypot(p.folded.x - c.folded.x, p.folded.y - c.folded.y) < 0.08
      && Math.hypot(p.unfolded.x - c.unfolded.x, p.unfolded.y - c.unfolded.y) < 0.08
    );
    if (!dup) pairs.push(c);
  }

  const unfoldCompiled = compileUnfoldEntry(curState, entry);
  return {
    label: entry.step.label || entry.step.technique || '접기',
    pairs,
    evaluateUnfold: unfoldCompiled.evaluate,
  };
}

/**
 * Compile an entire sequence of planar steps into a timeline evaluator.
 */
export function compilePlanarTimeline(initialConfig, steps) {
  const initState = createInitialPaper(
    initialConfig?.width ?? 2.0,
    initialConfig?.height ?? 2.0,
    initialConfig?.rotationDeg ?? 0
  );
  const compiledSteps = [];
  const activeFoldStack = [];
  let cur = initState;

  for (const step of steps) {
    let compiled;
    if (step.type === 'unfoldLast') {
      if (activeFoldStack.length > 0) {
        const target = activeFoldStack.pop();
        compiled = compileUnfoldEntry(cur, target);
      } else {
        const endState = clonePaperState(cur);
        compiled = {
          evaluate: () => ({ faces: cur.faces, creases: cur.creases, guides: [] }),
          endState,
        };
      }
    } else if (step.type === 'unfoldAll') {
      compiled = compileUnfoldAllEntries(cur, activeFoldStack);
      activeFoldStack.length = 0;
    } else {
      compiled = compilePlanarStep(cur, step);
      if (step.type === 'flip' || step.type === 'rotate') {
        const op = { type: step.type, axis: step.axis, angleDeg: step.angleDeg };
        for (const entry of activeFoldStack) {
          entry.postRigids.push(op);
        }
      } else if (step.type !== 'precrease') {
        activeFoldStack.push({ step, compiled, postRigids: [] });
      }
    }
    compiledSteps.push({ step, ...compiled });
    cur = compiled.endState;
  }

  const topUnfoldHint = activeFoldStack.length > 0
    ? computeUnfoldHint(cur, activeFoldStack[activeFoldStack.length - 1])
    : null;

  return {
    initState,
    compiledSteps,
    finalState: cur,
    stepCount: compiledSteps.length,
    activeFoldCount: activeFoldStack.length,
    topUnfoldHint,
    evaluate(stepIdx, t) {
      if (compiledSteps.length === 0) {
        return { faces: initState.faces, creases: initState.creases, guides: [] };
      }
      const clampedIdx = Math.max(0, Math.min(compiledSteps.length - 1, stepIdx));
      const clampedT = Math.max(0, Math.min(1, t));
      if (clampedT >= 0.9999) {
        const end = compiledSteps[clampedIdx].endState;
        return { faces: end.faces, creases: end.creases, guides: [] };
      }
      return compiledSteps[clampedIdx].evaluate(clampedT);
    },
  };
}

/**
 * 2D segment-segment strict interior intersection (in XY plane).
 */
function segIntersect2D(a, b, c, d) {
  const rx = b.x - a.x, ry = b.y - a.y;
  const sx = d.x - c.x, sy = d.y - c.y;
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < 1e-5) return null;
  const qpx = c.x - a.x, qpy = c.y - a.y;
  const t = (qpx * sy - qpy * sx) / denom;
  const u = (qpx * ry - qpy * rx) / denom;
  if (t > 0.04 && t < 0.96 && u > 0.04 && u < 0.96) {
    return {
      x: a.x + t * rx,
      y: a.y + t * ry,
      z: (a.z + t * (b.z - a.z) + c.z + u * (d.z - c.z)) * 0.5,
    };
  }
  return null;
}

/**
 * Collect magnetic snap points from the current paper state (vertices, edge
 * midpoints, crease/edge intersections, quarter divisions, and paper center)
 * for intuitive Free Fold Studio interaction.
 */
export function computeSnapPoints(paperState) {
  const raw = [];
  const priority = { vertex: 4, center: 3, intersect: 2, midpoint: 1, quarter: 0 };
  const addUnique = (p, kind, layer = 0, edgeLen = 1) => {
    for (const q of raw) {
      if (Math.hypot(q.x - p.x, q.y - p.y) < 0.03) {
        if ((priority[kind] || 0) > (priority[q.kind] || 0)) q.kind = kind;
        if (layer < q.minLayer) q.minLayer = layer;
        if (layer > q.maxLayer) q.maxLayer = layer;
        if (edgeLen > q.edgeLen) q.edgeLen = edgeLen;
        return;
      }
    }
    raw.push({ x: p.x, y: p.y, z: p.z || 0, kind, minLayer: layer, maxLayer: layer, edgeLen });
  };

  // Deduplicate unique 2D edges for fast intersection & quarter-point detection
  const uniqueEdges = [];
  const addEdge = (a, b, layer) => {
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 0.06) return;
    for (const e of uniqueEdges) {
      const sameDir = Math.hypot(e.a.x - a.x, e.a.y - a.y) < 0.025 && Math.hypot(e.b.x - b.x, e.b.y - b.y) < 0.025;
      const revDir = Math.hypot(e.a.x - b.x, e.a.y - b.y) < 0.025 && Math.hypot(e.b.x - a.x, e.b.y - a.y) < 0.025;
      if (sameDir || revDir) {
        if (layer < e.minLayer) e.minLayer = layer;
        if (layer > e.maxLayer) e.maxLayer = layer;
        return;
      }
    }
    uniqueEdges.push({ a, b, len, minLayer: layer, maxLayer: layer });
  };

  let gMinLayer = Infinity, gMaxLayer = -Infinity;
  for (const f of paperState.faces) {
    const fl = f.layer || 0;
    if (fl < gMinLayer) gMinLayer = fl;
    if (fl > gMaxLayer) gMaxLayer = fl;
    const n = f.pts.length;
    for (let i = 0; i < n; i++) {
      const a = f.pts[i];
      const b = f.pts[(i + 1) % n];
      const eLen = Math.hypot(b.x - a.x, b.y - a.y);
      addUnique(a, 'vertex', fl, eLen);
      addUnique({ x: (a.x + b.x) * 0.5, y: (a.y + b.y) * 0.5, z: (a.z + b.z) * 0.5 }, 'midpoint', fl, eLen);
      addEdge(a, b, fl);
    }
  }
  if (!Number.isFinite(gMinLayer)) { gMinLayer = 0; gMaxLayer = 0; }

  // Add centroid of bounding box
  let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
  for (const p of raw) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  if (raw.length > 0) {
    addUnique({ x: (minX + maxX) * 0.5, y: (minY + maxY) * 0.5, z: 0 }, 'center', gMaxLayer, 1);
    const cPt = raw.find(q => q.kind === 'center');
    if (cPt) { cPt.minLayer = gMinLayer; cPt.maxLayer = gMaxLayer; }
  }

  // Crease / edge interior intersections (capped for complex folded meshes)
  const edgeLimit = Math.min(uniqueEdges.length, 48);
  for (let i = 0; i < edgeLimit; i++) {
    for (let j = i + 1; j < edgeLimit; j++) {
      const hit = segIntersect2D(uniqueEdges[i].a, uniqueEdges[i].b, uniqueEdges[j].a, uniqueEdges[j].b);
      if (hit) {
        addUnique(hit, 'intersect', Math.max(uniqueEdges[i].maxLayer, uniqueEdges[j].maxLayer), 1);
        const q = raw.find(r => Math.hypot(r.x - hit.x, r.y - hit.y) < 0.03);
        if (q) q.minLayer = Math.min(q.minLayer, uniqueEdges[i].minLayer, uniqueEdges[j].minLayer);
      }
    }
  }

  // Quarter divisions (1/4 and 3/4) on sufficiently long edges
  const paperSpan = Math.max(0.4, Math.hypot(maxX - minX, maxY - minY));
  const minQuarterLen = Math.max(0.55, paperSpan * 0.34);
  for (let i = 0; i < edgeLimit; i++) {
    const { a, b, len, minLayer, maxLayer } = uniqueEdges[i];
    if (len < minQuarterLen) continue;
    const p25 = { x: a.x + (b.x - a.x) * 0.25, y: a.y + (b.y - a.y) * 0.25, z: a.z + (b.z - a.z) * 0.25 };
    const p75 = { x: a.x + (b.x - a.x) * 0.75, y: a.y + (b.y - a.y) * 0.75, z: a.z + (b.z - a.z) * 0.75 };
    addUnique(p25, 'quarter', maxLayer, len);
    addUnique(p75, 'quarter', maxLayer, len);
    const q1 = raw.find(r => Math.hypot(r.x - p25.x, r.y - p25.y) < 0.03);
    if (q1) q1.minLayer = Math.min(q1.minLayer, minLayer);
    const q2 = raw.find(r => Math.hypot(r.x - p75.x, r.y - p75.y) < 0.03);
    if (q2) q2.minLayer = Math.min(q2.minLayer, minLayer);
  }

  return raw;
}
