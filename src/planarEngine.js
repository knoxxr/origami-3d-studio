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

/**
 * Determine which faces are eligible to move given layerScope ('all'|'top'|'bottom').
 */
function filterLayerEligible(faces, movingSide, planeOrigin, planeNormal, layerScope) {
  if (!layerScope || layerScope === 'all') {
    return new Set(faces.map((_, i) => i));
  }
  // Find faces that have at least one vertex strictly on movingSide
  const candidateIdx = [];
  for (let i = 0; i < faces.length; i++) {
    const f = faces[i];
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

  let targetLayer = faces[candidateIdx[0]].layer;
  for (const idx of candidateIdx) {
    if (layerScope === 'top') {
      if (faces[idx].layer > targetLayer) targetLayer = faces[idx].layer;
    } else if (layerScope === 'bottom') {
      if (faces[idx].layer < targetLayer) targetLayer = faces[idx].layer;
    }
  }

  const eligible = new Set();
  for (const idx of candidateIdx) {
    if (Math.abs(faces[idx].layer - targetLayer) < 0.55) {
      eligible.add(idx);
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
 * Prepare a single planar step on a base PaperState, returning a fast evaluator
 * function(t in [0,1]) -> { faces, guides, creases } and the final end state.
 */
export function compilePlanarStep(baseState, step) {
  const type = step.type;

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
      const eligible = filterLayerEligible(workFaces, side, p1, planeNormal, sf.layerScope || 'all');

      guides.push({ p1, p2, type: fType });
      foldInfos.push({ origin: p1, axis, targetAngle, fType, angleDeg });

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
          nextWork.push({ ...movingPoly, layer: f.layer, foldIdx: fi, origIdx: f.origIdx });
        }
      }
      workFaces = nextWork;
    });

    const maxAll = Math.max(...workFaces.map(f => f.layer), 0);
    const minAll = Math.min(...workFaces.map(f => f.layer), 0);

    const evaluate = (t) => {
      const e = easeInOutCubic(t);
      const faces = workFaces.map(f => {
        if (f.foldIdx === -1) {
          return { pts: f.pts, uvs: f.uvs, layer: f.layer };
        }
        const info = foldInfos[f.foldIdx];
        const ang = info.targetAngle * e;
        let layer = f.layer;
        if (e > 0.65 && info.angleDeg >= 165) {
          layer = info.fType === 'valley'
            ? maxAll + 1 + (maxAll - f.layer)
            : minAll - 1 - (f.layer - minAll);
        }
        return {
          pts: f.pts.map(p => rotateAroundAxis(p, info.origin, info.axis, ang)),
          uvs: f.uvs,
          layer,
        };
      });
      return {
        faces,
        creases: [...baseState.creases, ...addedCreases],
        guides,
      };
    };

    const finalEval = evaluate(1.0);
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

  // 4. PLEAT FOLD (Two parallel creases: Valley + Mountain simultaneously)
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
    const firstSign = side; // first crease is valley
    const targetAng1 = firstSign * (angleDeg * Math.PI) / 180;
    const targetAng2 = -targetAng1; // second crease is mountain (opposite)

    const eligible = filterLayerEligible(baseState.faces, side, p1, planeNormal, step.layerScope || 'all');
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
      if (seg1) addedCreases.push({ ...seg1, type: 'valley' });

      const stay1 = side > 0 ? s1.neg : s1.pos;
      const move1 = side > 0 ? s1.pos : s1.neg;
      if (stay1) pieces.push({ ...stay1, layer: f.layer, group: 0 });
      if (move1) {
        const s2 = splitPolygonByPlane(move1.pts, move1.uvs, q1, planeNormal);
        const seg2 = extractCreaseSegmentUV(s2.pos, s2.neg, q1, planeNormal);
        if (seg2) addedCreases.push({ ...seg2, type: 'mountain' });

        const midStrip = side > 0 ? s2.neg : s2.pos;
        const farRegion = side > 0 ? s2.pos : s2.neg;
        if (midStrip) pieces.push({ ...midStrip, layer: f.layer, group: 1 });
        if (farRegion) pieces.push({ ...farRegion, layer: f.layer, group: 2 });
      }
    }

    const maxAll = Math.max(...pieces.map(p => p.layer), 0);
    const guides = [
      { p1, p2, type: 'valley' },
      { p1: q1, p2: q2, type: 'mountain' },
    ];

    const evaluate = (t) => {
      const e = easeInOutCubic(t);
      const a1 = targetAng1 * e;
      const a2 = targetAng2 * e;
      const q1Moved = rotateAroundAxis(q1, p1, axis, a1);

      const faces = pieces.map(pc => {
        if (pc.group === 0) {
          return { pts: pc.pts, uvs: pc.uvs, layer: pc.layer };
        }
        if (pc.group === 1) {
          const layer = (e > 0.6 && angleDeg >= 165) ? maxAll + 1 + (maxAll - pc.layer) : pc.layer;
          return {
            pts: pc.pts.map(p => rotateAroundAxis(p, p1, axis, a1)),
            uvs: pc.uvs,
            layer,
          };
        }
        // Group 2: first rotate around p1 by a1, then around q1Moved by a2 (stays parallel!)
        const layer = (e > 0.6 && angleDeg >= 165) ? maxAll + 3 + pc.layer : pc.layer;
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

    const endEval = evaluate(1.0);
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

  // 5. VALLEY, MOUNTAIN, or PRECREASE
  const isPrecrease = type === 'precrease';
  const foldType = type === 'mountain' ? 'mountain' : 'valley';
  const p1 = v3(step.p1[0], step.p1[1], step.p1[2] || 0);
  const p2 = v3(step.p2[0], step.p2[1], step.p2[2] || 0);
  const axis = norm(sub(p2, p1));
  const planeNormal = norm(cross(v3(0, 0, 1), axis)); // (-dy, dx, 0)
  const side = step.side >= 0 ? 1 : -1;
  const angleDeg = Math.abs(step.angleDeg ?? (isPrecrease ? 155 : 180));
  const sign = (foldType === 'mountain' ? -1 : 1) * side;
  const targetAngle = sign * (angleDeg * Math.PI) / 180;

  const eligible = filterLayerEligible(baseState.faces, side, p1, planeNormal, step.layerScope || 'all');

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
    if (movingPoly) moveFaces.push({ ...movingPoly, layer: f.layer });
  }

  const allLayers = [...stayFaces, ...moveFaces].map(f => f.layer);
  const maxAll = allLayers.length ? Math.max(...allLayers) : 0;
  const minAll = allLayers.length ? Math.min(...allLayers) : 0;
  const moveMax = moveFaces.length ? Math.max(...moveFaces.map(f => f.layer)) : 0;
  const moveMin = moveFaces.length ? Math.min(...moveFaces.map(f => f.layer)) : 0;

  const guides = [{ p1, p2, type: step.creaseType || foldType }];

  const evaluate = (t) => {
    let foldProgress;
    if (isPrecrease) {
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

    for (const f of moveFaces) {
      let layer = f.layer;
      if (!isPrecrease && foldProgress > 0.65 && angleDeg >= 165) {
        layer = foldType === 'valley'
          ? maxAll + 1 + (moveMax - f.layer)
          : minAll - 1 - (f.layer - moveMin);
      }
      outFaces.push({
        pts: f.pts.map(p => rotateAroundAxis(p, p1, axis, ang)),
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
    const endEval = evaluate(1.0);
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
 * Compile an entire sequence of planar steps into a timeline evaluator.
 */
export function compilePlanarTimeline(initialConfig, steps) {
  const initState = createInitialPaper(
    initialConfig?.width ?? 2.0,
    initialConfig?.height ?? 2.0,
    initialConfig?.rotationDeg ?? 0
  );
  const compiledSteps = [];
  let cur = initState;

  for (const step of steps) {
    const compiled = compilePlanarStep(cur, step);
    compiledSteps.push({ step, ...compiled });
    cur = compiled.endState;
  }

  return {
    initState,
    compiledSteps,
    finalState: cur,
    stepCount: compiledSteps.length,
    evaluate(stepIdx, t) {
      if (compiledSteps.length === 0) {
        return { faces: initState.faces, creases: initState.creases, guides: [] };
      }
      const clampedIdx = Math.max(0, Math.min(compiledSteps.length - 1, stepIdx));
      return compiledSteps[clampedIdx].evaluate(Math.max(0, Math.min(1, t)));
    },
  };
}

/**
 * Collect magnetic snap points from the current paper state (vertices, edge
 * midpoints, and paper center) for intuitive Free Fold Studio interaction.
 */
export function computeSnapPoints(paperState) {
  const raw = [];
  const addUnique = (p, kind) => {
    for (const q of raw) {
      if (Math.hypot(q.x - p.x, q.y - p.y) < 0.03) {
        if (kind === 'vertex') q.kind = 'vertex';
        return;
      }
    }
    raw.push({ x: p.x, y: p.y, z: p.z || 0, kind });
  };

  for (const f of paperState.faces) {
    const n = f.pts.length;
    for (let i = 0; i < n; i++) {
      const a = f.pts[i];
      const b = f.pts[(i + 1) % n];
      addUnique(a, 'vertex');
      addUnique({ x: (a.x + b.x) * 0.5, y: (a.y + b.y) * 0.5, z: (a.z + b.z) * 0.5 }, 'midpoint');
    }
  }
  // Add centroid of bounding box
  let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
  for (const p of raw) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  if (raw.length > 0) {
    addUnique({ x: (minX + maxX) * 0.5, y: (minY + maxY) * 0.5, z: 0 }, 'center');
  }
  return raw;
}
