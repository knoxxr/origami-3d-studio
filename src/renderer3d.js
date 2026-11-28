// ============================================================================
// renderer3d.js — High-DPI 3D Origami Canvas Renderer, Topological Depth Sort,
//                 Washi Paper Lighting, 2D Crease Pattern & GIF HUD Overlay
// ============================================================================

import {
  v3, add, sub, scale, dot, norm, polyNormal, polyCentroid,
  buildCamera, worldToCamera, projectPoint,
} from './math3d.js';

export function hexToRgb(hex) {
  const clean = (hex || '#cf4436').replace('#', '');
  const full = clean.length === 3
    ? clean.split('').map(c => c + c).join('')
    : clean.padEnd(6, '0');
  const num = parseInt(full, 16);
  return {
    r: (num >> 16) & 255,
    g: (num >> 8) & 255,
    b: num & 255,
  };
}

function clamp255(v) {
  return Math.max(0, Math.min(255, Math.round(v)));
}

// ---------------------------------------------------------------------------
// Washi / kami paper fibre texture (procedural, tileable, neutral-gray so it
// modulates any paper colour through a soft-light blend).
// ---------------------------------------------------------------------------
const PAPER_TEX_SIZE = 256;
const PAPER_TEX_REPEAT = 3.2; // tiles across one paper edge
let paperTexCanvas = null;
const paperPatternCache = new WeakMap();

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function createTexCanvas(size) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(size, size);
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = size; c.height = size;
    return c;
  }
  return null;
}

function buildPaperTexture() {
  const N = PAPER_TEX_SIZE;
  const c = createTexCanvas(N);
  if (!c) return null;
  const g = c.getContext('2d');
  if (!g) return null;
  const rnd = mulberry32(0x5eed0f);

  // Low-frequency cloudy mottling (pulp density variation), wrapped for seamless tiling
  g.fillStyle = 'rgb(128,128,128)';
  g.fillRect(0, 0, N, N);
  for (let i = 0; i < 18; i++) {
    const x = rnd() * N, y = rnd() * N, rad = 50 + rnd() * 70;
    const light = rnd() > 0.5;
    const a = 0.018 + rnd() * 0.03;
    for (let ox = -N; ox <= N; ox += N) {
      for (let oy = -N; oy <= N; oy += N) {
        const gr = g.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, rad);
        gr.addColorStop(0, light ? `rgba(255,255,255,${a})` : `rgba(0,0,0,${a})`);
        gr.addColorStop(1, 'rgba(128,128,128,0)');
        g.fillStyle = gr;
        g.fillRect(x + ox - rad, y + oy - rad, rad * 2, rad * 2);
      }
    }
  }

  // Fine per-pixel grain
  const img = g.getImageData(0, 0, N, N);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rnd() - 0.5) * 16;
    d[i] = Math.max(0, Math.min(255, d[i] + n));
    d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n));
    d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n));
    d[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);

  // Long soft fibres (kozo-style), drawn with wrap-around so the tile is seamless
  g.lineCap = 'round';
  for (let i = 0; i < 120; i++) {
    const x = rnd() * N, y = rnd() * N;
    const ang = rnd() * Math.PI * 2;
    const L = 6 + rnd() * 26;
    const bendAmt = (rnd() - 0.5) * L * 0.22;
    const ex = x + Math.cos(ang) * L, ey = y + Math.sin(ang) * L;
    const cx = (x + ex) * 0.5 - Math.sin(ang) * bendAmt;
    const cy = (y + ey) * 0.5 + Math.cos(ang) * bendAmt;
    const light = rnd() > 0.38;
    g.strokeStyle = light ? `rgba(255,255,255,${0.07 + rnd() * 0.12})` : `rgba(40,30,20,${0.04 + rnd() * 0.06})`;
    g.lineWidth = 0.45 + rnd() * 0.7;
    for (let ox = -N; ox <= N; ox += N) {
      for (let oy = -N; oy <= N; oy += N) {
        g.beginPath();
        g.moveTo(x + ox, y + oy);
        g.quadraticCurveTo(cx + ox, cy + oy, ex + ox, ey + oy);
        g.stroke();
      }
    }
  }
  return c;
}

function getPaperPattern(ctx) {
  if (paperPatternCache.has(ctx)) return paperPatternCache.get(ctx);
  let pattern = null;
  try {
    if (!paperTexCanvas) paperTexCanvas = buildPaperTexture();
    if (paperTexCanvas) {
      pattern = ctx.createPattern(paperTexCanvas, 'repeat');
      if (pattern && typeof pattern.setTransform !== 'function') pattern = null;
    }
  } catch {
    pattern = null;
  }
  paperPatternCache.set(ctx, pattern);
  return pattern;
}

/**
 * Affine map from paper UV-texture space to screen space for one face so the
 * fibre texture sticks to the paper (folds, flips and orbits carry it along).
 */
function faceTextureMatrix(face, scrPts) {
  const uvs = face.uvs;
  if (!uvs || uvs.length !== scrPts.length || uvs.length < 3) return null;
  const K = PAPER_TEX_SIZE * PAPER_TEX_REPEAT;
  const X = (i) => uvs[i].u * K;
  const Y = (i) => (1 - uvs[i].v) * K;
  // Pick the most stable triangle (largest UV area) anchored at vertex 0
  let i1 = 1, i2 = 2, best = 0;
  for (let a = 1; a < uvs.length; a++) {
    for (let b = a + 1; b < uvs.length; b++) {
      const ar = Math.abs((X(a) - X(0)) * (Y(b) - Y(0)) - (X(b) - X(0)) * (Y(a) - Y(0)));
      if (ar > best) { best = ar; i1 = a; i2 = b; }
    }
  }
  if (best < 1e-3) return null;
  const X0 = X(0), Y0 = Y(0);
  const dX1 = X(i1) - X0, dY1 = Y(i1) - Y0, dX2 = X(i2) - X0, dY2 = Y(i2) - Y0;
  const det = dX1 * dY2 - dX2 * dY1;
  const s0 = scrPts[0], s1 = scrPts[i1], s2 = scrPts[i2];
  const dx1 = s1.x - s0.x, dy1 = s1.y - s0.y, dx2 = s2.x - s0.x, dy2 = s2.y - s0.y;
  const a = (dx1 * dY2 - dx2 * dY1) / det;
  const c = (dX1 * dx2 - dX2 * dx1) / det;
  const b = (dy1 * dY2 - dy2 * dY1) / det;
  const d = (dX1 * dy2 - dX2 * dy1) / det;
  const e = s0.x - a * X0 - c * Y0;
  const f = s0.y - b * X0 - d * Y0;
  if (![a, b, c, d, e, f].every(Number.isFinite)) return null;
  // Reject near edge-on faces (texture would smear into streaks)
  if (Math.abs(a * d - b * c) < 1e-5) return null;
  return { a, b, c, d, e, f };
}

function buildStudioLights(cam) {
  const toCam = scale(cam.forward, -1);
  const camVec = (rx, uy, cz) => norm(add(add(scale(cam.right, rx), scale(cam.up, uy)), scale(toCam, cz)));
  return {
    keyLight: camVec(-0.42, 0.68, 0.65),
    fillLight: camVec(0.55, -0.28, 0.52),
    rimLight: camVec(0.15, 0.35, -0.92),
  };
}

function shadePaperColor(baseRgb, normal, viewDir, layer, isBack, isDark, lights = null) {
  // Orient normal toward viewer for lighting computation
  const n = dot(normal, viewDir) >= 0 ? normal : scale(normal, -1);

  const keyLight = lights ? lights.keyLight : norm(v3(-0.42, 0.68, 0.65));
  const fillLight = lights ? lights.fillLight : norm(v3(0.55, -0.28, 0.52));
  const rimLight = lights ? lights.rimLight : norm(v3(0.15, 0.35, -0.92));

  const nDotKey = Math.max(0, dot(n, keyLight));
  const nDotFill = Math.max(0, dot(n, fillLight));
  const nDotRim = Math.max(0, dot(n, rimLight));

  // Soft Blinn-Phong satin paper highlight
  const halfVec = norm(add(keyLight, viewDir));
  const spec = Math.pow(Math.max(0, dot(n, halfVec)), 22) * (isBack ? 0.08 : 0.14);

  // Hemisphere ambient + directional diffuse
  const hemi = 0.5 + 0.5 * n.y;
  const ambient = (isDark ? 0.35 : 0.41) + hemi * 0.12;
  const diffuse = nDotKey * 0.52 + nDotFill * 0.22 + nDotRim * 0.10;
  // Whisper-subtle layer cue (real depth comes from inter-flap contact shadows, not grey tinting)
  const layerCue = Math.max(-0.012, Math.min(0.014, layer * 0.0022));
  const intensity = Math.max(0.28, Math.min(1.22, ambient + diffuse + layerCue));

  const r = clamp255(baseRgb.r * intensity + spec * 255);
  const g = clamp255(baseRgb.g * intensity + spec * 250);
  const b = clamp255(baseRgb.b * intensity + spec * 242);

  // Subtle directional satin-paper gradient stops (top-left lit -> bottom-right shaded)
  const lr = clamp255(r * 1.032 + 2);
  const lg = clamp255(g * 1.030 + 2);
  const lb = clamp255(b * 1.024 + 1);
  const dr = clamp255(r * 0.966);
  const dg = clamp255(g * 0.964);
  const db = clamp255(b * 0.962);

  // Distinct physical tones for outer paper cut edges, bent fold ridges, and flat embossed creases
  const borderFactor = isBack ? 0.77 : 0.72;
  const br = clamp255(r * borderFactor);
  const bg = clamp255(g * borderFactor);
  const bb = clamp255(b * borderFactor);

  const foldFactor = isBack ? 0.80 : 0.74;
  const fr = clamp255(r * foldFactor);
  const fg = clamp255(g * foldFactor);
  const fb = clamp255(b * foldFactor);

  const creaseFactor = isBack ? 0.66 : 0.60;
  const cr = clamp255(r * creaseFactor);
  const cg = clamp255(g * creaseFactor);
  const cb = clamp255(b * creaseFactor);

  return {
    fill: `rgb(${r},${g},${b})`,
    fillLight: `rgb(${lr},${lg},${lb})`,
    fillDark: `rgb(${dr},${dg},${db})`,
    stroke: `rgb(${fr},${fg},${fb})`,
    borderStroke: `rgb(${br},${bg},${bb})`,
    foldStroke: `rgb(${fr},${fg},${fb})`,
    foldHighlight: isBack ? 'rgba(255,252,246,0.22)' : 'rgba(255,248,242,0.16)',
    creaseStroke: `rgba(${cr},${cg},${cb},${isBack ? 0.24 : 0.21})`,
  };
}

function pointInScrPoly(px, py, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
    if (((yi > py) !== (yj > py)) && (px < ((xj - xi) * (py - yi)) / (yj - yi + 1e-12) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

function distToSegmentSq2D(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const lenSq = vx * vx + vy * vy;
  if (lenSq < 1e-6) return (px - ax) * (px - ax) + (py - ay) * (py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / lenSq));
  const dx = px - (ax + t * vx);
  const dy = py - (ay + t * vy);
  return dx * dx + dy * dy;
}

/**
 * Check if a projected 2D snap point at spLayerKey is strictly buried behind a
 * camera-facing front paper face (excluding points that lie on the covering face's edge).
 */
export function isScreenPointOccluded(px, py, spLayerKey, paperItems, edgeMarginPx = 3.5) {
  if (!paperItems || paperItems.length === 0) return false;
  const marginSq = edgeMarginPx * edgeMarginPx;
  for (let i = paperItems.length - 1; i >= 0; i--) {
    const it = paperItems[i];
    if (it.isSpine || it.layerKey <= spLayerKey + 0.05) continue;
    if (px <= it.minX + 1.5 || px >= it.maxX - 1.5 || py <= it.minY + 1.5 || py >= it.maxY - 1.5) continue;
    const pts = it.scrPts;
    if (!pointInScrPoly(px, py, pts)) continue;
    let nearEdge = false;
    for (let k = 0; k < pts.length; k++) {
      const a = pts[k], b = pts[(k + 1) % pts.length];
      if (distToSegmentSq2D(px, py, a.x, a.y, b.x, b.y) <= marginSq) {
        nearEdge = true;
        break;
      }
    }
    if (!nearEdge) return true;
  }
  return false;
}

function isBoundaryUVEdge(u1, u2) {
  const eps = 3.5e-3;
  return (u1.u <= eps && u2.u <= eps) ||
         (u1.u >= 1 - eps && u2.u >= 1 - eps) ||
         (u1.v <= eps && u2.v <= eps) ||
         (u1.v >= 1 - eps && u2.v >= 1 - eps);
}

/**
 * Compute adaptive physical layer spacing so even heavily stacked folds stay
 * realistically paper-thin without drifting apart into floating slices.
 */
export function computeLayerThick(faces) {
  if (!faces || faces.length <= 1) return 0.0014;
  let minL = Infinity, maxL = -Infinity;
  for (let i = 0; i < faces.length; i++) {
    const l = faces[i].layer || 0;
    if (l < minL) minL = l;
    if (l > maxL) maxL = l;
  }
  const span = Math.max(1, maxL - minL);
  return Math.min(0.0015, 0.011 / span);
}

/**
 * Exact 2D convex polygon interior overlap test (Separating Axis Theorem).
 * Uses a tiny negative epsilon (-0.35px) so polygons merely sharing a crease edge
 * do NOT create false DAG ordering cycles.
 */
function polysOverlap2D(ptsA, ptsB) {
  const nA = ptsA.length, nB = ptsB.length;
  if (nA < 3 || nB < 3) return false;
  const eps = 0.35;
  for (let pass = 0; pass < 2; pass++) {
    const poly = pass === 0 ? ptsA : ptsB;
    const n = poly.length;
    for (let i = 0; i < n; i++) {
      const a = poly[i], b = poly[(i + 1) % n];
      const ex = b.x - a.x, ey = b.y - a.y;
      const len = Math.hypot(ex, ey);
      if (len < 1e-4) continue;
      const nx = -ey / len, ny = ex / len;
      let minA = Infinity, maxA = -Infinity;
      for (let k = 0; k < nA; k++) {
        const p = ptsA[k].x * nx + ptsA[k].y * ny;
        if (p < minA) minA = p;
        if (p > maxA) maxA = p;
      }
      let minB = Infinity, maxB = -Infinity;
      for (let k = 0; k < nB; k++) {
        const p = ptsB[k].x * nx + ptsB[k].y * ny;
        if (p < minB) minB = p;
        if (p > maxB) maxB = p;
      }
      if (maxA <= minB + eps || maxB <= minA + eps) return false;
    }
  }
  return true;
}

/**
 * Topological plane-aware painter's sort (back-to-front).
 * Uses exact 2D SAT overlap filtering + parallel-layer priority + camera-space plane tests.
 */
function sortFacesBackToFront(items) {
  const n = items.length;
  if (n <= 1) return items;

  // Initial sort by average camera Z descending (farthest first), tie-breaking by layerKey
  items.sort((a, b) => {
    const dz = b.avgZ - a.avgZ;
    if (Math.abs(dz) > 0.008) return dz;
    return a.layerKey - b.layerKey;
  });

  if (n > 480) return items;

  const adj = Array.from({ length: n }, () => []);
  const indeg = new Int32Array(n);

  const planeSide = (pts, planeOrig, planeN) => {
    let pos = 0, neg = 0;
    for (let k = 0; k < pts.length; k++) {
      const d = dot(sub(pts[k], planeOrig), planeN);
      if (d > 3.5e-4) pos++;
      else if (d < -3.5e-4) neg++;
    }
    if (pos > 0 && neg === 0) return 1;  // strictly in front (camera side)
    if (neg > 0 && pos === 0) return -1; // strictly behind
    if (pos === 0 && neg === 0) return 0; // coplanar
    return 2; // straddling
  };

  for (let i = 0; i < n; i++) {
    const A = items[i];
    for (let j = i + 1; j < n; j++) {
      const B = items[j];
      // Fast 2D screen bounding-box rejection
      if (A.maxX <= B.minX + 0.3 || B.maxX <= A.minX + 0.3 ||
          A.maxY <= B.minY + 0.3 || B.maxY <= A.minY + 0.3) {
        continue;
      }
      // Exact 2D convex polygon interior overlap test (eliminates diagonal & edge-sharing false cycles!)
      if (!polysOverlap2D(A.scrPts, B.scrPts)) {
        continue;
      }

      // Spine vs sheet: never let a buried fold spine punch through a covering front sheet
      if (A.isSpine !== B.isSpine) {
        const spine = A.isSpine ? A : B;
        const sheet = A.isSpine ? B : A;
        const spineIdx = A.isSpine ? i : j;
        const sheetIdx = A.isSpine ? j : i;
        if (sheet.layerKey > spine.spineMaxLayerKey + 0.05) {
          adj[spineIdx].push(sheetIdx); indeg[sheetIdx]++; continue;
        }
        if (sheet.layerKey < spine.spineMinLayerKey - 0.05) {
          adj[sheetIdx].push(spineIdx); indeg[spineIdx]++; continue;
        }
      }

      // Parallel stacked paper sheets -> order strictly by layerKey (immune to large-vs-small avgZ distortion!)
      if (!A.isSpine && !B.isSpine && Math.abs(dot(A.camNormal, B.camNormal)) > 0.992) {
        const planeDist = Math.abs(dot(sub(A.camCenter, B.camCenter), B.camNormal));
        if (planeDist < 0.022 && Math.abs(A.layerKey - B.layerKey) > 1e-4) {
          if (A.layerKey < B.layerKey) { adj[i].push(j); indeg[j]++; }
          else { adj[j].push(i); indeg[i]++; }
          continue;
        }
      }

      // Fast depth interval separation (cam Z: larger = farther)
      if (A.minZ > B.maxZ + 1e-4) {
        adj[i].push(j); indeg[j]++; continue;
      }
      if (B.minZ > A.maxZ + 1e-4) {
        adj[j].push(i); indeg[i]++; continue;
      }

      // Plane test in camera space
      const aVsB = planeSide(A.camPts, B.camCenter, B.camNormal);
      if (aVsB === -1) { adj[i].push(j); indeg[j]++; continue; }
      if (aVsB === 1) { adj[j].push(i); indeg[i]++; continue; }

      const bVsA = planeSide(B.camPts, A.camCenter, A.camNormal);
      if (bVsA === 1) { adj[i].push(j); indeg[j]++; continue; }
      if (bVsA === -1) { adj[j].push(i); indeg[i]++; continue; }

      // Coplanar fallback -> sort by signed layerKey
      if (aVsB === 0 || bVsA === 0) {
        if (A.layerKey < B.layerKey) { adj[i].push(j); indeg[j]++; }
        else if (B.layerKey < A.layerKey) { adj[j].push(i); indeg[i]++; }
      }
    }
  }

  // Kahn's topological sort: among ready nodes (indeg === 0), prefer lowest layerKey
  // so coplanar stacked paper layers stay contiguous for unified flap shadows,
  // while preserving avgZ descending order within the same layer.
  const visited = new Uint8Array(n);
  const result = [];
  for (let step = 0; step < n; step++) {
    let pick = -1;
    let pickLayer = Infinity;
    for (let i = 0; i < n; i++) {
      if (!visited[i] && indeg[i] === 0) {
        if (pick === -1 || items[i].layerKey < pickLayer - 0.05) {
          pick = i;
          pickLayer = items[i].layerKey;
        }
      }
    }
    if (pick === -1) {
      let bestDeg = Infinity;
      for (let i = 0; i < n; i++) {
        if (!visited[i] && indeg[i] < bestDeg) {
          bestDeg = indeg[i];
          pick = i;
        }
      }
    }
    visited[pick] = 1;
    result.push(items[pick]);
    const neighbors = adj[pick];
    for (let k = 0; k < neighbors.length; k++) {
      indeg[neighbors[k]]--;
    }
  }

  return result;
}

/**
 * Render a 3D origami frame onto a CanvasRenderingContext2D.
 */
export function renderOrigami3D(ctx, width, height, frameData, options = {}) {
  const {
    camera = { yaw: 0.4, pitch: 0.38, distance: 4.6, target: v3(0, 0, 0) },
    frontColor = '#cf4436',
    backColor = '#f7f1e3',
    isDark = false,
    showGuides = true,
    showWireframe = false,
    showShadow = true,
    freeOverlay = null,
    hudOverlay = null,
    paperTexture = true,
    flapShadows = true,
    creaseFlash = null,
  } = options;

  const cam = buildCamera(camera.yaw, camera.pitch, camera.distance, camera.target || v3(0, 0, 0));

  // 1. Studio radial backdrop (warm craft paper desk feel, zero clutter)
  const bgGrad = ctx.createRadialGradient(
    width * 0.48, height * 0.42, Math.min(width, height) * 0.05,
    width * 0.5, height * 0.5, Math.max(width, height) * 0.72
  );
  if (isDark) {
    bgGrad.addColorStop(0, '#26242b');
    bgGrad.addColorStop(0.65, '#1b1a20');
    bgGrad.addColorStop(1, '#121116');
  } else {
    bgGrad.addColorStop(0, '#fbf8f3');
    bgGrad.addColorStop(0.65, '#f0e9df');
    bgGrad.addColorStop(1, '#e4dacb');
  }
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, width, height);

  const faces = frameData?.faces || [];
  const frontRgb = hexToRgb(frontColor);
  const backRgb = hexToRgb(backColor);

  // 2. Soft unified studio desk shadow projected neatly below the paper's actual vertical span
  if (showShadow && faces.length > 0) {
    let minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < faces.length; i++) {
      const pts = faces[i].pts;
      for (let k = 0; k < pts.length; k++) {
        if (pts[k].y < minY) minY = pts[k].y;
        if (pts[k].y > maxY) maxY = pts[k].y;
      }
    }
    const spanY = Math.max(0.4, maxY - minY);
    const floorY = minY - Math.max(0.24, Math.min(0.42, spanY * 0.18));
    ctx.save();
    if ('filter' in ctx) ctx.filter = 'blur(7px)';
    ctx.fillStyle = isDark ? 'rgba(0, 0, 0, 0.34)' : 'rgba(65, 48, 32, 0.135)';
    ctx.beginPath();
    let hasShadow = false;
    for (let i = 0; i < faces.length; i++) {
      const pts = faces[i].pts;
      if (pts.length < 3) continue;
      const shPts = [];
      let valid = true;
      for (let k = 0; k < pts.length; k++) {
        // Project softly along light vector onto floorY
        const p = pts[k];
        const drop = Math.max(0, p.y - floorY);
        const sp = v3(p.x + drop * 0.14, floorY, p.z - drop * 0.16);
        const cp = worldToCamera(sp, cam);
        if (cp.z <= 0.1) { valid = false; break; }
        shPts.push(projectPoint(cp, width, height));
      }
      if (!valid) continue;
      // Enforce consistent CCW screen winding so nonzero fill computes a seamless union with zero holes
      let area2 = 0;
      for (let k = 0; k < shPts.length; k++) {
        const a = shPts[k], b = shPts[(k + 1) % shPts.length];
        area2 += a.x * b.y - b.x * a.y;
      }
      if (Math.abs(area2) < 1.0) continue;
      if (area2 < 0) shPts.reverse();
      ctx.moveTo(shPts[0].x, shPts[0].y);
      for (let k = 1; k < shPts.length; k++) ctx.lineTo(shPts[k].x, shPts[k].y);
      ctx.closePath();
      hasShadow = true;
    }
    if (hasShadow) ctx.fill('nonzero');
    ctx.restore();
  }

  // 3. Transform & shade all paper faces
  const renderItems = [];
  const layerThick = computeLayerThick(faces);
  const viewSideZ = (cam.eye.z - cam.target.z) >= 0 ? 1 : -1;
  // Which side of the z = 0 table plane the eye is on (for lifted-flap shadow partitioning)
  const eyeSideZ = cam.eye.z >= 0 ? 1 : -1;
  const studioLights = buildStudioLights(cam);

  for (let i = 0; i < faces.length; i++) {
    const f = faces[i];
    if (!f.pts || f.pts.length < 3) continue;

    const normal = polyNormal(f.pts);
    const center = polyCentroid(f.pts);
    const viewDir = norm(sub(cam.eye, center));
    const frontFacing = dot(normal, viewDir) >= 0;

    // Realistic paper-thin layer offset along Z so stacked layers stay cohesive & crisp
    const offsetZ = (f.layer || 0) * layerThick;
    const worldPts = f.pts.map(p => v3(p.x, p.y, p.z + offsetZ));
    const camPts = worldPts.map(p => worldToCamera(p, cam));
    const scrPts = camPts.map(p => projectPoint(p, width, height));

    let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
    let minZ = 1e9, maxZ = -1e9, sumZ = 0;
    for (let k = 0; k < scrPts.length; k++) {
      const s = scrPts[k];
      if (s.x < minX) minX = s.x;
      if (s.x > maxX) maxX = s.x;
      if (s.y < minY) minY = s.y;
      if (s.y > maxY) maxY = s.y;
      const cz = camPts[k].z;
      if (cz < minZ) minZ = cz;
      if (cz > maxZ) maxZ = cz;
      sumZ += cz;
    }

    const camCenter = polyCentroid(camPts);
    let camN = polyNormal(camPts);
    // Orient camNormal toward camera origin (0,0,0): dot(camN, -camCenter) >= 0
    if (dot(camN, scale(camCenter, -1)) < 0) {
      camN = scale(camN, -1);
    }

    const layerKey = (f.layer || 0) * viewSideZ;
    const shaded = shadePaperColor(
      frontFacing ? frontRgb : backRgb,
      normal,
      viewDir,
      layerKey,
      !frontFacing,
      isDark,
      studioLights
    );

    let wzMin = Infinity, wzMax = -Infinity;
    for (let k = 0; k < f.pts.length; k++) {
      const z = (f.pts[k].z || 0) * eyeSideZ;
      if (z < wzMin) wzMin = z;
      if (z > wzMax) wzMax = z;
    }

    renderItems.push({
      worldPts,
      worldNormal: normal,
      scrPts,
      camPts,
      camCenter,
      camNormal: camN,
      minX, maxX, minY, maxY,
      minZ, maxZ,
      avgZ: sumZ / camPts.length,
      layerKey: (f.layer || 0) * viewSideZ,
      shaded,
      frontFacing,
      isSpine: false,
      edgeKinds: new Array(f.pts.length).fill('fold'),
      origFace: f,
      isBendStrip: !!f.bendStrip,
      sideZMin: wzMin,
      sideZMax: wzMax,
      avgScale: scrPts.reduce((acc, sp) => acc + (sp.scale || 0), 0) / scrPts.length,
    });
  }

  // 3b. Classify every polygon edge ('border' | 'fold' | 'crease') using exact UV adjacency
  //     and emit 3D fold-spine bridge quads ONLY for visibly oblique folded edges (never hairlines).
  if (!showWireframe && renderItems.length >= 1) {
    const edgeBuckets = new Map();
    const qKey = (u, v) => `${Math.round(u * 120)},${Math.round(v * 120)}`;
    const uvMatch = (a, b) => Math.hypot(a.u - b.u, a.v - b.v) < 3.5e-3;

    for (let fi = 0; fi < renderItems.length; fi++) {
      const item = renderItems[fi];
      const f = item.origFace;
      if (!f.uvs || f.uvs.length !== f.pts.length) continue;
      const n = f.pts.length;
      for (let e = 0; e < n; e++) {
        const j = (e + 1) % n;
        const u1 = f.uvs[e], u2 = f.uvs[j];
        if (f.smoothEdges && f.smoothEdges[e]) {
          // Internal seam of a smoothly bent paper strip: no line, no spine
          item.edgeKinds[e] = 'smooth';
          continue;
        }
        if (isBoundaryUVEdge(u1, u2)) {
          item.edgeKinds[e] = 'border';
          continue;
        }
        if (Math.hypot(u2.u - u1.u, u2.v - u1.v) < 4e-3) continue;
        const key = qKey((u1.u + u2.u) * 0.5, (u1.v + u2.v) * 0.5);
        let bucket = edgeBuckets.get(key);
        if (!bucket) { bucket = []; edgeBuckets.set(key, bucket); }
        bucket.push({
          fi, ei: e, u1, u2,
          w1: item.worldPts[e], w2: item.worldPts[j],
          s1: item.scrPts[e], s2: item.scrPts[j],
        });
      }
    }

    const spineItems = [];
    for (const bucket of edgeBuckets.values()) {
      if (bucket.length < 2) continue;
      for (let i = 0; i < bucket.length; i++) {
        const ea = bucket[i];
        for (let j = i + 1; j < bucket.length; j++) {
          const eb = bucket[j];
          if (ea.fi === eb.fi) continue;
          let b1 = null, b2 = null, sb1 = null, sb2 = null;
          if (uvMatch(ea.u1, eb.u2) && uvMatch(ea.u2, eb.u1)) {
            b1 = eb.w2; b2 = eb.w1; sb1 = eb.s2; sb2 = eb.s1;
          } else if (uvMatch(ea.u1, eb.u1) && uvMatch(ea.u2, eb.u2)) {
            b1 = eb.w1; b2 = eb.w2; sb1 = eb.s1; sb2 = eb.s2;
          }
          if (!b1) continue;

          const itemA = renderItems[ea.fi];
          const itemB = renderItems[eb.fi];
          const layerDiff = Math.abs((itemA.origFace.layer || 0) - (itemB.origFace.layer || 0));
          const normDot = dot(itemA.worldNormal, itemB.worldNormal);

          // Coplanar same-layer split -> soft embossed crease (NOT a dark cut!)
          if (layerDiff < 0.05 && normDot > 0.985 && itemA.frontFacing === itemB.frontFacing) {
            itemA.edgeKinds[ea.ei] = 'crease';
            itemB.edgeKinds[eb.ei] = 'crease';
            continue;
          }

          // Distinct layer or bent hinge -> true folded ridge
          itemA.edgeKinds[ea.ei] = 'fold';
          itemB.edgeKinds[eb.ei] = 'fold';
          // Real paper wraps around a fold with a tiny rounded ridge: flag both sides
          // (except while a flap is still softly bending, where the bend itself shows it)
          if (!itemA.origFace.bent && !itemB.origFace.bent) {
            (itemA.ridgeEdges || (itemA.ridgeEdges = []))[ea.ei] = true;
            (itemB.ridgeEdges || (itemB.ridgeEdges = []))[eb.ei] = true;
          }

          const a1 = ea.w1, a2 = ea.w2;
          const dz = Math.max(Math.abs(a1.z - b1.z), Math.abs(a2.z - b2.z));
          const xyErr = Math.max(Math.hypot(a1.x - b1.x, a1.y - b1.y), Math.hypot(a2.x - b2.x, a2.y - b2.y));
          if (dz < 0.0003 || dz > 0.08 || xyErr > 0.03 || layerDiff > 2.5) continue;

          // Only emit fold-spine bridge when visibly oblique on screen (prevents face-on hairlines!)
          const ex = ea.s2.x - ea.s1.x, ey = ea.s2.y - ea.s1.y;
          const eLen = Math.hypot(ex, ey);
          const perpW = eLen > 1 ? Math.max(
            Math.abs((sb1.x - ea.s1.x) * (-ey) + (sb1.y - ea.s1.y) * ex) / eLen,
            Math.abs((sb2.x - ea.s1.x) * (-ey) + (sb2.y - ea.s1.y) * ex) / eLen
          ) : 0;
          if (perpW < 0.75) continue;

          const qWorld = [a1, a2, b2, b1];
          const qCam = qWorld.map(p => worldToCamera(p, cam));
          const qScr = qCam.map(p => projectPoint(p, width, height));
          let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
          let minZ = 1e9, maxZ = -1e9, sumZ = 0;
          for (let k = 0; k < 4; k++) {
            const s = qScr[k];
            if (s.x < minX) minX = s.x; if (s.x > maxX) maxX = s.x;
            if (s.y < minY) minY = s.y; if (s.y > maxY) maxY = s.y;
            const cz = qCam[k].z;
            if (cz < minZ) minZ = cz; if (cz > maxZ) maxZ = cz;
            sumZ += cz;
          }
          const qCenter = polyCentroid(qWorld);
          const qView = norm(sub(cam.eye, qCenter));
          const qNorm = polyNormal(qWorld);
          const qCamCenter = polyCentroid(qCam);
          let qCamN = polyNormal(qCam);
          if (dot(qCamN, scale(qCamCenter, -1)) < 0) qCamN = scale(qCamN, -1);

          // Real origami spine wraps the outer camera-facing paper surface cleanly
          const outerItem = itemA.layerKey >= itemB.layerKey ? itemA : itemB;
          const baseRgb = outerItem.frontFacing ? frontRgb : backRgb;
          const avgLayerKey = (itemA.layerKey + itemB.layerKey) * 0.5;
          const shaded = shadePaperColor(baseRgb, qNorm, qView, avgLayerKey, !outerItem.frontFacing, isDark, studioLights);
          const spineMinLayerKey = Math.min(itemA.layerKey, itemB.layerKey);
          const spineMaxLayerKey = Math.max(itemA.layerKey, itemB.layerKey);
          let sqMin = Infinity, sqMax = -Infinity;
          for (const qp of [a1, a2, b1, b2]) {
            const z = (qp.z || 0) * eyeSideZ;
            if (z < sqMin) sqMin = z;
            if (z > sqMax) sqMax = z;
          }

          spineItems.push({
            worldPts: qWorld,
            worldNormal: qNorm,
            scrPts: qScr,
            camPts: qCam,
            camCenter: qCamCenter,
            camNormal: qCamN,
            minX, maxX, minY, maxY,
            minZ, maxZ,
            avgZ: sumZ * 0.25,
            layerKey: spineMinLayerKey + 0.01,
            spineMinLayerKey,
            spineMaxLayerKey,
            shaded,
            frontFacing: outerItem.frontFacing,
            isSpine: true,
            origFace: outerItem.origFace,
            sideZMin: sqMin,
            sideZMax: sqMax,
          });
        }
      }
    }
    for (let i = 0; i < spineItems.length; i++) renderItems.push(spineItems[i]);
  }

  const sorted = sortFacesBackToFront(renderItems);
  const paperItems = sorted.filter(it => !it.isSpine);
  let minPaperLayerKey = Infinity;
  for (let i = 0; i < paperItems.length; i++) {
    if (paperItems[i].layerKey < minPaperLayerKey) minPaperLayerKey = paperItems[i].layerKey;
  }

  // 3c. Partition into "resting on the table plane" vs "lifted toward the viewer".
  //     A face lying wholly on the camera side of z = 0 can never be hidden by a face
  //     lying in z = 0, so drawing all resting paper first, then a physically projected
  //     soft shadow of the lifted flaps, then the lifted flaps keeps depth order exact.
  const ELEV_EPS = 0.004;
  const ELEV_MIN = 0.018;
  let drawSeq = sorted;
  let liftedItems = [];
  let liftedSet = null;
  let restingFlat = [];
  if (!showWireframe && flapShadows && Math.abs(cam.eye.z) > 0.2) {
    const lifted = [];
    const resting = [];
    for (let i = 0; i < sorted.length; i++) {
      const it = sorted[i];
      const isLifted = it.sideZMin > -ELEV_EPS && it.sideZMax > ELEV_MIN;
      if (isLifted) lifted.push(it); else resting.push(it);
    }
    restingFlat = resting.filter(it => !it.isSpine && it.sideZMax < ELEV_EPS && it.sideZMin > -ELEV_EPS);
    if (lifted.length > 0 && restingFlat.length > 0) {
      liftedItems = lifted;
      liftedSet = new Set(lifted);
      drawSeq = [...resting, { isShadowMarker: true }, ...lifted];
    }
  }

  // 4. Paint paper polygons back-to-front with unified inter-flap shadows,
  //    subtle satin paper sheen, washi fibre texture, and physically distinct edges.
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  const tracePoly = (pts) => {
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let k = 1; k < pts.length; k++) ctx.lineTo(pts[k].x, pts[k].y);
    ctx.closePath();
  };

  const paperPattern = (!showWireframe && paperTexture) ? getPaperPattern(ctx) : null;
  const MatrixCtor = typeof DOMMatrix !== 'undefined' ? DOMMatrix : null;
  const paperMaterial = !showWireframe && paperTexture;

  // Screen-space direction toward the key light (for emboss lips & rim highlights)
  const keyCam = worldToCamera(add(cam.eye, studioLights.keyLight), cam);
  const keyLen = Math.hypot(keyCam.x, keyCam.y) || 1;
  const lightDirX = keyCam.x / keyLen;
  const lightDirY = -keyCam.y / keyLen;
  const lightOffX = -lightDirX * 0.7;
  const lightOffY = -lightDirY * 0.7;

  const drawPaperEdgeShading = (it) => {
    if (it.isSpine || it.origFace.bent) return;
    const pts = it.scrPts;
    const n = pts.length;
    const kinds = it.edgeKinds;
    const ridges = it.ridgeEdges;
    let any = false;
    for (let e = 0; e < n; e++) {
      if ((ridges && ridges[e]) || kinds[e] === 'border') { any = true; break; }
    }
    if (!any) return;
    let cx = 0, cy = 0;
    for (let k = 0; k < n; k++) { cx += pts[k].x; cy += pts[k].y; }
    cx /= n; cy /= n;
    const pxPerUnit = it.avgScale || 200;
    // Faces seen nearly edge-on get no bands (they would smear)
    const facing = Math.abs(it.camNormal ? it.camNormal.z : 1);
    if (facing < 0.25) return;
    const ridgeW = Math.max(3, Math.min(13, pxPerUnit * 0.038)) * facing;
    const rimW = Math.max(1.1, Math.min(3, pxPerUnit * 0.008)) * facing;
    const hlRidge = isDark ? 0.14 : (it.frontFacing ? 0.30 : 0.42);
    const shRidge = isDark ? 0.28 : 0.13;
    const hlRim = isDark ? 0.10 : (it.frontFacing ? 0.22 : 0.30);

    ctx.save();
    ctx.beginPath();
    tracePoly(pts);
    ctx.clip();
    for (let e = 0; e < n; e++) {
      const isRidge = !!(ridges && ridges[e]);
      const isRim = !isRidge && kinds[e] === 'border';
      if (!isRidge && !isRim) continue;
      const a = pts[e], b = pts[(e + 1) % n];
      const ex = b.x - a.x, ey = b.y - a.y;
      const el = Math.hypot(ex, ey);
      if (el < 4) continue;
      let nx = -ey / el, ny = ex / el;
      const mx = (a.x + b.x) * 0.5, my = (a.y + b.y) * 0.5;
      if ((cx - mx) * nx + (cy - my) * ny < 0) { nx = -nx; ny = -ny; }
      const w = isRidge ? ridgeW : rimW;
      const g = ctx.createLinearGradient(mx, my, mx + nx * w, my + ny * w);
      if (isRidge) {
        // Rounded ridge: catch-light, then the curve rolling away from the light, then flat
        const facingLight = Math.max(0, nx * lightDirX + ny * lightDirY);
        const hl = hlRidge * (0.55 + 0.45 * (1 - facingLight));
        g.addColorStop(0, `rgba(255,252,244,${hl})`);
        g.addColorStop(0.16, `rgba(255,252,244,${hl * 0.25})`);
        g.addColorStop(0.42, isDark ? `rgba(0,0,0,${shRidge})` : `rgba(50,30,12,${shRidge})`);
        g.addColorStop(1, 'rgba(50,30,12,0)');
      } else {
        // Cut-edge thickness rim, brighter on the edges facing the light
        const towardLight = Math.max(0, -(nx * lightDirX + ny * lightDirY));
        const a0 = hlRim * (0.45 + 0.55 * towardLight);
        g.addColorStop(0, `rgba(255,253,248,${a0})`);
        g.addColorStop(1, 'rgba(255,253,248,0)');
      }
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.lineTo(b.x + nx * w, b.y + ny * w);
      ctx.lineTo(a.x + nx * w, a.y + ny * w);
      ctx.closePath();
      ctx.fillStyle = g;
      ctx.fill();
    }
    ctx.restore();
  };

  const drawFlapShadow = () => {
    // Project every lifted face onto the table plane along the (softened) key light.
    // Mostly overhead soft-box light with a hint of the key direction: the shadow sits
    // under the flap and its penumbra widens with height, so it always reads on the sheet.
    const key = studioLights.keyLight;
    const L = norm(add(scale(key, 0.55), v3(0, 0, eyeSideZ)));
    if (Math.abs(L.z) < 0.15) return;
    const shadowPolys = [];
    for (const it of liftedItems) {
      if (it.isSpine) continue;
      const src = it.worldPts;
      const proj = [];
      let ok = true;
      let hSum = 0;
      for (let k = 0; k < src.length; k++) {
        const p = src[k];
        const tt = p.z / L.z;
        const sp = v3(p.x - L.x * tt, p.y - L.y * tt, 0);
        const cp = worldToCamera(sp, cam);
        if (cp.z <= 0.1) { ok = false; break; }
        proj.push(projectPoint(cp, width, height));
        hSum += Math.abs(p.z);
      }
      if (!ok) continue;
      let area2 = 0;
      for (let k = 0; k < proj.length; k++) {
        const a = proj[k], b = proj[(k + 1) % proj.length];
        area2 += a.x * b.y - b.x * a.y;
      }
      if (Math.abs(area2) < 0.5) continue;
      if (area2 < 0) proj.reverse();
      shadowPolys.push({ pts: proj, h: hSum / src.length, pxPerUnit: it.avgScale || 200 });
    }
    if (!shadowPolys.length) return;

    const tf = typeof ctx.getTransform === 'function' ? ctx.getTransform() : { a: 1 };
    const dpr = Math.abs(tf.a) || 1;
    const OFF = 20000;

    ctx.save();
    ctx.beginPath();
    for (const it of restingFlat) tracePoly(it.scrPts);
    ctx.clip('nonzero');
    ctx.fillStyle = '#000';
    ctx.shadowOffsetX = OFF * dpr;
    ctx.shadowOffsetY = 0;
    // Higher parts of the flap cast wider, fainter penumbrae (soft-box physics).
    // Bucket by height so stacked layers don't double-darken, one blur per bucket.
    const buckets = new Map();
    for (const sp of shadowPolys) {
      const hPx = sp.h * sp.pxPerUnit;
      const key = Math.min(7, Math.floor(hPx / 14));
      let bk = buckets.get(key);
      if (!bk) { bk = { polys: [], hPx: 0, n: 0 }; buckets.set(key, bk); }
      bk.polys.push(sp.pts);
      bk.hPx += hPx;
      bk.n++;
    }
    for (const bk of buckets.values()) {
      const hPx = bk.hPx / bk.n;
      const blurCss = Math.max(2, Math.min(44, 2 + hPx * 0.6));
      const alpha = Math.max(0.12, Math.min(0.34, 0.34 * Math.exp(-hPx / 190)));
      ctx.shadowColor = isDark ? `rgba(0,0,0,${Math.min(0.6, alpha * 1.9)})` : `rgba(48,30,16,${alpha})`;
      ctx.shadowBlur = blurCss * dpr;
      ctx.beginPath();
      for (const poly of bk.polys) {
        ctx.moveTo(poly[0].x - OFF, poly[0].y);
        for (let k = 1; k < poly.length; k++) ctx.lineTo(poly[k].x - OFF, poly[k].y);
        ctx.closePath();
      }
      ctx.fill('nonzero');
    }
    ctx.restore();
  };

  if (showWireframe) {
    for (let i = 0; i < sorted.length; i++) {
      const it = sorted[i];
      ctx.beginPath();
      tracePoly(it.scrPts);
      ctx.fillStyle = it.frontFacing
        ? 'rgba(207, 68, 54, 0.16)'
        : 'rgba(180, 170, 155, 0.14)';
      ctx.fill();
      ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.65)' : 'rgba(40,35,30,0.65)';
      ctx.lineWidth = 1.25;
      ctx.stroke();
    }
  } else {
    let idx = 0;
    while (idx < drawSeq.length) {
      const first = drawSeq[idx];
      if (first.isShadowMarker) {
        if (showShadow) drawFlapShadow();
        idx++;
        continue;
      }
      if (first.isSpine) {
        ctx.beginPath();
        tracePoly(first.scrPts);
        ctx.fillStyle = first.shaded.fill;
        ctx.fill();
        idx++;
        continue;
      }

      // Group contiguous coplanar faces on the same layer into ONE flap island
      const firstLayerBin = Math.round(first.layerKey * 10);
      let end = idx + 1;
      while (end < drawSeq.length) {
        const nxt = drawSeq[end];
        if (nxt.isSpine || nxt.isShadowMarker) break;
        if (Math.round(nxt.layerKey * 10) !== firstLayerBin) break;
        if (nxt.frontFacing !== first.frontFacing) break;
        if (dot(nxt.worldNormal, first.worldNormal) < 0.985) break;
        end++;
      }

      // Pass 4a: Unified inter-flap contact shadow (zero shadow across internal flat creases!)
      //          Lifted flaps get a projected table shadow instead, and smoothly bent
      //          strips never cast one onto their own neighbouring strips.
      const isRaised = first.layerKey > minPaperLayerKey + 0.05;
      const tilt = 1 - Math.abs(first.worldNormal.z);
      const isTilted = tilt > 0.04;
      const isLiftedGroup = !!liftedSet && liftedSet.has(first);
      if (showShadow && (isRaised || isTilted) && !first.isBendStrip && !isLiftedGroup) {
        ctx.save();
        ctx.beginPath();
        for (let r = idx; r < end; r++) tracePoly(drawSeq[r].scrPts);
        // Stacked flaps never lie perfectly flat on real paper: a soft contact shadow
        // plus a tighter occlusion line under the free edges sells the layer thickness.
        const dprS = Math.abs(typeof ctx.getTransform === 'function' ? ctx.getTransform().a : 1) || 1;
        ctx.shadowColor = isDark
          ? (isTilted ? 'rgba(0, 0, 0, 0.45)' : 'rgba(0, 0, 0, 0.40)')
          : (isTilted ? 'rgba(42, 28, 16, 0.22)' : 'rgba(42, 28, 16, 0.22)');
        ctx.shadowBlur = (isTilted ? (4.4 + tilt * 6.4) : 5.0) * dprS;
        ctx.shadowOffsetX = (isTilted ? (1.3 + tilt * 2.6) : 1.2) * dprS;
        ctx.shadowOffsetY = (isTilted ? (1.9 + tilt * 3.6) : 1.8) * dprS;
        ctx.fillStyle = first.shaded.fill;
        ctx.fill();
        if (!isTilted) {
          ctx.shadowColor = isDark ? 'rgba(0, 0, 0, 0.45)' : 'rgba(42, 28, 16, 0.20)';
          ctx.shadowBlur = 1.4 * dprS;
          ctx.shadowOffsetX = 0.5 * dprS;
          ctx.shadowOffsetY = 0.8 * dprS;
        }
        ctx.fillStyle = first.shaded.fill;
        ctx.fill();
        ctx.restore();
      }

      // Pass 4b: Subtle satin key-light paper fill + washi fibre texture + seam seal
      for (let r = idx; r < end; r++) {
        const it = drawSeq[r];
        ctx.beginPath();
        tracePoly(it.scrPts);
        const spanW = it.maxX - it.minX;
        const spanH = it.maxY - it.minY;
        if (!it.isBendStrip && (spanW > 10 || spanH > 10)) {
          const grad = ctx.createLinearGradient(it.minX, it.minY, it.maxX, it.maxY);
          grad.addColorStop(0, it.shaded.fillLight);
          grad.addColorStop(0.52, it.shaded.fill);
          grad.addColorStop(1, it.shaded.fillDark);
          ctx.fillStyle = grad;
        } else {
          ctx.fillStyle = it.shaded.fill;
        }
        ctx.fill();
        // Micro same-color seal eliminates Canvas 2D anti-aliasing seams between coplanar triangles
        ctx.strokeStyle = it.shaded.fill;
        ctx.lineWidth = it.isBendStrip ? 0.9 : 0.55;
        ctx.stroke();

        if (paperPattern && MatrixCtor && (spanW > 3 || spanH > 3)) {
          const m = faceTextureMatrix(it.origFace, it.scrPts);
          if (m) {
            try {
              paperPattern.setTransform(new MatrixCtor([m.a, m.b, m.c, m.d, m.e, m.f]));
              ctx.save();
              ctx.globalCompositeOperation = 'soft-light';
              ctx.globalAlpha = it.frontFacing ? 0.9 : 0.75;
              ctx.fillStyle = paperPattern;
              ctx.fill();
              ctx.restore();
            } catch {
              // Pattern transforms unsupported: plain satin paper is fine
            }
          }
        }
      }

      // Pass 4b': Paper-material edge shading inside each face
      //   - fold ridges: the sheet rolls over a hairline-radius bend, so a bright
      //     catch-light sits right on the ridge and the surface darkens slightly as
      //     it curves away before flattening out;
      //   - cut edges: the paper's thickness catches a thin light rim.
      if (paperMaterial) {
        for (let r = idx; r < end; r++) {
          drawPaperEdgeShading(drawSeq[r]);
        }
      }

      // Pass 4c: Physically distinct edge strokes (delicate embossed crease vs crisp border/fold)
      let hasCrease = false, hasBorder = false, hasFold = false;
      ctx.beginPath();
      for (let r = idx; r < end; r++) {
        const it = drawSeq[r];
        const pts = it.scrPts;
        const kinds = it.edgeKinds;
        for (let e = 0; e < pts.length; e++) {
          const k = kinds[e];
          if (k === 'crease') {
            hasCrease = true;
            const a = pts[e], b = pts[(e + 1) % pts.length];
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
          } else if (k === 'border') {
            hasBorder = true;
          } else if (k === 'fold') {
            hasFold = true;
          }
        }
      }
      if (hasCrease) {
        // Pressed-in crease memory: soft dark groove + a light lip offset toward the light
        ctx.strokeStyle = first.shaded.creaseStroke;
        ctx.lineWidth = 0.9;
        ctx.stroke();
        if (paperMaterial) {
          ctx.save();
          ctx.translate(lightOffX, lightOffY);
          ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.07)' : 'rgba(255,252,245,0.30)';
          ctx.lineWidth = 0.7;
          ctx.stroke();
          ctx.restore();
        }
      }

      if (hasBorder) {
        ctx.beginPath();
        for (let r = idx; r < end; r++) {
          const it = drawSeq[r];
          const pts = it.scrPts;
          const kinds = it.edgeKinds;
          for (let e = 0; e < pts.length; e++) {
            if (kinds[e] === 'border') {
              const a = pts[e], b = pts[(e + 1) % pts.length];
              ctx.moveTo(a.x, a.y);
              ctx.lineTo(b.x, b.y);
            }
          }
        }
        ctx.strokeStyle = first.shaded.borderStroke;
        ctx.lineWidth = 0.82;
        ctx.stroke();
      }

      if (hasFold) {
        ctx.beginPath();
        for (let r = idx; r < end; r++) {
          const it = drawSeq[r];
          const pts = it.scrPts;
          const kinds = it.edgeKinds;
          for (let e = 0; e < pts.length; e++) {
            if (kinds[e] === 'fold') {
              const a = pts[e], b = pts[(e + 1) % pts.length];
              ctx.moveTo(a.x, a.y);
              ctx.lineTo(b.x, b.y);
            }
          }
        }
        ctx.strokeStyle = first.shaded.foldStroke;
        ctx.lineWidth = 0.88;
        ctx.stroke();

        // Subtle soft paper-bend catchlight along folded ridges
        ctx.strokeStyle = first.shaded.foldHighlight;
        ctx.lineWidth = 0.55;
        ctx.stroke();
      }

      idx = end;
    }
  }

  // 4d. Fresh-crease "press" flash: a soft sheen that sweeps along a crease the
  //     moment a fold is pressed flat (like running a fingernail along it).
  if (creaseFlash && creaseFlash.segments && creaseFlash.segments.length) {
    const ft = Math.max(0, Math.min(1, creaseFlash.t || 0));
    ctx.save();
    ctx.lineCap = 'round';
    for (const seg of creaseFlash.segments) {
      const c1 = worldToCamera(seg.p1, cam);
      const c2 = worldToCamera(seg.p2, cam);
      if (c1.z <= 0.1 || c2.z <= 0.1) continue;
      const s1 = projectPoint(c1, width, height);
      const s2 = projectPoint(c2, width, height);
      if (Math.hypot(s2.x - s1.x, s2.y - s1.y) < 4) continue;
      // Pressed crease darkening that fades in and stays subtle
      ctx.beginPath();
      ctx.moveTo(s1.x, s1.y);
      ctx.lineTo(s2.x, s2.y);
      ctx.strokeStyle = isDark ? `rgba(0,0,0,${0.35 * (1 - ft)})` : `rgba(60,35,20,${0.22 * (1 - ft)})`;
      ctx.lineWidth = 2.2;
      ctx.stroke();
      // Travelling sheen
      const grad = ctx.createLinearGradient(s1.x, s1.y, s2.x, s2.y);
      const head = ft * 1.3 - 0.15;
      const stops = [
        [head - 0.28, 0],
        [head - 0.08, 0.55],
        [head, 0.95],
        [head + 0.06, 0],
      ];
      for (const [pos, a] of stops) {
        if (pos < 0 || pos > 1) continue;
        grad.addColorStop(pos, `rgba(255,253,246,${a * (1 - ft * 0.5)})`);
      }
      grad.addColorStop(0, 'rgba(255,253,246,0)');
      grad.addColorStop(1, 'rgba(255,253,246,0)');
      ctx.beginPath();
      ctx.moveTo(s1.x, s1.y);
      ctx.lineTo(s2.x, s2.y);
      ctx.strokeStyle = grad;
      ctx.lineWidth = 3.2;
      ctx.stroke();
    }
    ctx.restore();
  }

  // 5. Active Fold Guide Lines (Yoshizawa-Randlett: blue dashed = valley, red dash-dot = mountain)
  if (showGuides && frameData?.guides && frameData.guides.length > 0) {
    ctx.save();
    for (const g of frameData.guides) {
      const cp1 = worldToCamera(g.p1, cam);
      const cp2 = worldToCamera(g.p2, cam);
      if (cp1.z <= 0.1 || cp2.z <= 0.1) continue;
      const s1 = projectPoint(cp1, width, height);
      const s2 = projectPoint(cp2, width, height);
      const isMountain = viewSideZ >= 0 ? (g.type === 'mountain') : (g.type !== 'mountain');

      // Subtle light halo behind dashed guide so it reads clearly on dark & light paper
      ctx.beginPath();
      ctx.setLineDash([]);
      ctx.strokeStyle = isDark ? 'rgba(0,0,0,0.45)' : 'rgba(255,255,255,0.72)';
      ctx.lineWidth = 4.2;
      ctx.moveTo(s1.x, s1.y);
      ctx.lineTo(s2.x, s2.y);
      ctx.stroke();

      ctx.beginPath();
      ctx.setLineDash(isMountain ? [10, 4, 2, 4] : [7, 5]);
      ctx.strokeStyle = isMountain ? '#dc2626' : '#2563eb';
      ctx.lineWidth = 2.2;
      ctx.moveTo(s1.x, s1.y);
      ctx.lineTo(s2.x, s2.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  // Expose sorted screen-space paper faces for snap occlusion checks in app.js
  cam.paperItems = paperItems;

  // 6. Free Fold Studio interactive overlays (snap points, rubber-band line, side highlight)
  if (freeOverlay) {
    drawFreeStudioOverlay(ctx, width, height, cam, freeOverlay, isDark, layerThick, viewSideZ, paperItems);
  }

  // 7. Optional HUD Overlay (used when baking captions into exported GIF frames!)
  if (hudOverlay) {
    drawGifHudOverlay(ctx, width, height, hudOverlay, isDark);
  }

  return cam;
}

function snapWorldPos(sp, layerThick, viewSideZ) {
  const layer = viewSideZ >= 0 ? (sp.maxLayer ?? 0) : (sp.minLayer ?? 0);
  return v3(sp.x, sp.y, (sp.z || 0) + layer * layerThick);
}

function isExposedStructuralCorner(px, py, spLayerKey, paperItems) {
  if (!paperItems || paperItems.length === 0) return true;
  for (let i = 0; i < paperItems.length; i++) {
    const it = paperItems[i];
    if (it.layerKey < spLayerKey - 0.15) continue;
    const pts = it.scrPts;
    const kinds = it.edgeKinds;
    for (let k = 0; k < pts.length; k++) {
      if (Math.hypot(pts[k].x - px, pts[k].y - py) < 5.5) {
        const prevKind = kinds[(k + pts.length - 1) % pts.length];
        const nextKind = kinds[k];
        if (prevKind === 'border' || prevKind === 'fold' || nextKind === 'border' || nextKind === 'fold') {
          return true;
        }
      }
    }
  }
  return false;
}

function drawFreeStudioOverlay(ctx, width, height, cam, overlay, isDark, layerThick = 0.0014, viewSideZ = 1, paperItems = []) {
  const {
    interactMode = 'drag',
    snapPoints, hoveredSnap, p1, p2, hoverWorld, foldType, hoverSide, previewFaces,
    dragStart, dragCurrent, dragSnapLabel, dragCrease, dragMirrorCrease = null,
    mirrorAxisX = null, dragIsUnfold = false, unfoldGhost = null, unfoldGhostLabel = 'Unfold',
    dragCancelZone = false, dragCancelLabel = 'Release to cancel',
    dragPointer = null, dragSnapped = false, dragAngleSnap = 0,
  } = overlay;
  ctx.save();

  const isMountain = foldType === 'mountain';
  const foldAccent = isMountain ? '#dc2626' : '#2563eb';
  const unfoldAccent = '#0d9488';
  const accent = dragIsUnfold ? unfoldAccent : foldAccent;

  // Subtle vertical symmetry axis guide when Mirror Fold mode is ON
  if (mirrorAxisX !== null && Number.isFinite(mirrorAxisX)) {
    const mTop = projectPoint(worldToCamera(v3(mirrorAxisX, 1.35, 0), cam), width, height);
    const mBot = projectPoint(worldToCamera(v3(mirrorAxisX, -1.35, 0), cam), width, height);
    ctx.save();
    ctx.beginPath();
    ctx.setLineDash([4, 5]);
    ctx.strokeStyle = 'rgba(147, 51, 234, 0.45)';
    ctx.lineWidth = 1.6;
    ctx.moveTo(mTop.x, mTop.y);
    ctx.lineTo(mBot.x, mBot.y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  // Helper to draw a snap marker cleanly by kind
  const drawSnapDot = (pr, sp, isHighlight, showMinor) => {
    if (!showMinor && (sp.kind === 'quarter' || sp.kind === 'intersect')) return;
    if (sp.kind === 'intersect') {
      const r = isHighlight ? 7.5 : 4.2;
      ctx.beginPath();
      ctx.moveTo(pr.x, pr.y - r);
      ctx.lineTo(pr.x + r, pr.y);
      ctx.lineTo(pr.x, pr.y + r);
      ctx.lineTo(pr.x - r, pr.y);
      ctx.closePath();
      ctx.fillStyle = isHighlight ? '#9333ea' : 'rgba(255,255,255,0.9)';
      ctx.fill();
      ctx.lineWidth = isHighlight ? 2.2 : 1.4;
      ctx.strokeStyle = isHighlight ? '#ffffff' : '#9333ea';
      ctx.stroke();
      return;
    }
    if (sp.kind === 'quarter') {
      const r = isHighlight ? 7 : 3.1;
      ctx.beginPath();
      ctx.arc(pr.x, pr.y, r, 0, Math.PI * 2);
      ctx.fillStyle = isHighlight ? foldAccent : 'rgba(255,255,255,0.72)';
      ctx.fill();
      ctx.lineWidth = isHighlight ? 2.2 : 1.1;
      ctx.strokeStyle = isHighlight ? '#ffffff' : 'rgba(120,113,108,0.68)';
      ctx.stroke();
      return;
    }
    const r = isHighlight ? 9 : sp.kind === 'center' ? 5.5 : sp.kind === 'vertex' ? 5.0 : 3.8;
    ctx.beginPath();
    ctx.arc(pr.x, pr.y, r, 0, Math.PI * 2);
    ctx.fillStyle = isHighlight ? foldAccent : 'rgba(255,255,255,0.88)';
    ctx.fill();
    ctx.lineWidth = isHighlight ? 2.6 : 1.5;
    ctx.strokeStyle = isHighlight ? '#ffffff' : (sp.kind === 'center' ? '#cf4436' : foldAccent);
    ctx.stroke();
  };

  // ---- Mode A: Direct Drag-to-Fold / Unfold visual cues ----
  if (interactMode === 'drag') {
    // 1. When idle (not dragging), show clean, occlusion-culled grab rings ONLY on visible corners & major edges
    if (!dragStart && snapPoints) {
      for (const sp of snapPoints) {
        if (sp.kind === 'center' || sp.kind === 'quarter' || sp.kind === 'intersect') continue;
        if (sp.kind === 'midpoint' && (sp.edgeLen ?? 1) < 0.34) continue;
        const spLayer = viewSideZ >= 0 ? (sp.maxLayer ?? 0) : (sp.minLayer ?? 0);
        const spLayerKey = spLayer * viewSideZ;
        const pr = projectPoint(worldToCamera(snapWorldPos(sp, layerThick, viewSideZ), cam), width, height);
        const isHov = hoveredSnap && hoveredSnap === sp;
        if (!isHov && isScreenPointOccluded(pr.x, pr.y, spLayerKey, paperItems)) continue;

        const isCorner = sp.kind === 'vertex' && isExposedStructuralCorner(pr.x, pr.y, spLayerKey, paperItems);
        const rad = isHov ? 8.8 : isCorner ? 4.8 : 3.1;

        if (isCorner || isHov) {
          ctx.beginPath();
          ctx.arc(pr.x, pr.y, rad + (isHov ? 3.5 : 2.6), 0, Math.PI * 2);
          ctx.fillStyle = isMountain ? 'rgba(220, 38, 38, 0.14)' : 'rgba(37, 99, 235, 0.14)';
          ctx.fill();
        }
        ctx.beginPath();
        ctx.arc(pr.x, pr.y, rad, 0, Math.PI * 2);
        ctx.fillStyle = isHov ? foldAccent : (isCorner ? 'rgba(255, 255, 255, 0.94)' : 'rgba(255, 255, 255, 0.78)');
        ctx.fill();
        ctx.lineWidth = isHov ? 2.3 : (isCorner ? 1.65 : 1.25);
        ctx.strokeStyle = isHov ? '#ffffff' : (isCorner ? foldAccent : 'rgba(120, 113, 108, 0.78)');
        ctx.stroke();
      }
    }

    // 2. While actively dragging a corner/edge to fold or unfold!
    if (dragStart && dragCurrent) {
      // Show snap targets (including intersections & quarter points) glued to the visible surface
      if (!dragIsUnfold && !dragCancelZone && snapPoints) {
        for (const sp of snapPoints) {
          if (Math.hypot(sp.x - dragStart.x, sp.y - dragStart.y) < 0.08) continue;
          const pr = projectPoint(worldToCamera(snapWorldPos(sp, layerThick, viewSideZ), cam), width, height);
          const isTarget = Math.hypot(sp.x - dragCurrent.x, sp.y - dragCurrent.y) < 0.03;
          drawSnapDot(pr, sp, isTarget, true);
        }
      }

      // Dashed teal ghost target ring showing where this folded corner came from (pull here to unfold!)
      if (unfoldGhost) {
        const ug = projectPoint(worldToCamera(unfoldGhost, cam), width, height);
        ctx.save();
        ctx.beginPath();
        ctx.arc(ug.x, ug.y, dragIsUnfold ? 13 : 10.5, 0, Math.PI * 2);
        ctx.fillStyle = dragIsUnfold ? 'rgba(13, 148, 136, 0.22)' : 'rgba(13, 148, 136, 0.10)';
        ctx.fill();
        ctx.setLineDash(dragIsUnfold ? [] : [4, 3]);
        ctx.lineWidth = dragIsUnfold ? 2.5 : 1.8;
        ctx.strokeStyle = unfoldAccent;
        ctx.stroke();
        ctx.setLineDash([]);
        if (!dragIsUnfold) {
          ctx.font = '600 10.5px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
          const lbl = unfoldGhostLabel;
          const tw = ctx.measureText(lbl).width;
          ctx.fillStyle = 'rgba(13, 148, 136, 0.90)';
          roundRect(ctx, ug.x - tw * 0.5 - 6, ug.y + 14, tw + 12, 18, 9);
          ctx.fill();
          ctx.fillStyle = '#ffffff';
          ctx.textBaseline = 'middle';
          ctx.fillText(lbl, ug.x - tw * 0.5, ug.y + 23);
        }
        ctx.restore();
      }

      // Dashed fold crease line(s) along perpendicular bisector (+ optional mirror crease!)
      const drawCreasePair = (cr, alpha = 1) => {
        if (!cr) return;
        const c1 = projectPoint(worldToCamera(cr.p1, cam), width, height);
        const c2 = projectPoint(worldToCamera(cr.p2, cam), width, height);
        ctx.save();
        ctx.globalAlpha = alpha * 0.75;
        ctx.beginPath();
        ctx.setLineDash([]);
        ctx.strokeStyle = 'rgba(255,255,255,0.7)';
        ctx.lineWidth = 3.6;
        ctx.moveTo(c1.x, c1.y);
        ctx.lineTo(c2.x, c2.y);
        ctx.stroke();

        ctx.beginPath();
        // Angle-snapped creases lock in as a firmer line so the 45° click is visible
        ctx.setLineDash(dragAngleSnap ? (isMountain ? [14, 3, 2, 3] : [14, 3]) : (isMountain ? [10, 4, 2, 4] : [8, 5]));
        ctx.strokeStyle = accent;
        ctx.lineWidth = dragAngleSnap ? 2.6 : 1.8;
        ctx.moveTo(c1.x, c1.y);
        ctx.lineTo(c2.x, c2.y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
      };
      if (!dragCancelZone) {
        drawCreasePair(dragCrease, 1.0);
        drawCreasePair(dragMirrorCrease, 0.72);
      }

      // Physical drag cues: the grabbed corner itself follows the finger in 3D, so
      // we only mark where it was lifted from and where it will land when released.
      const sA = projectPoint(worldToCamera(dragStart, cam), width, height);
      const sB = projectPoint(worldToCamera(dragCurrent, cam), width, height);
      const sP = dragPointer || sB;
      const dLen = Math.hypot(sB.x - sA.x, sB.y - sA.y);

      if (!dragCancelZone && !dragIsUnfold && dLen > 10) {
        // Landing spot: soft "drop shadow" target where the corner will touch down
        ctx.save();
        const ringR = dragSnapped ? 11 : 8;
        ctx.beginPath();
        ctx.arc(sB.x, sB.y, ringR + 5, 0, Math.PI * 2);
        ctx.fillStyle = isMountain ? 'rgba(220, 38, 38, 0.10)' : 'rgba(37, 99, 235, 0.10)';
        ctx.fill();
        ctx.beginPath();
        ctx.arc(sB.x, sB.y, ringR, 0, Math.PI * 2);
        ctx.setLineDash(dragSnapped ? [] : [3, 3]);
        ctx.lineWidth = dragSnapped ? 2.4 : 1.6;
        ctx.strokeStyle = accent;
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.arc(sB.x, sB.y, 2.4, 0, Math.PI * 2);
        ctx.fillStyle = accent;
        ctx.fill();
        // Faint dotted guide from the fingertip down to the landing spot
        if (Math.hypot(sP.x - sB.x, sP.y - sB.y) > 16) {
          ctx.beginPath();
          ctx.setLineDash([2, 4]);
          ctx.lineWidth = 1.2;
          ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.45)' : 'rgba(60,50,40,0.38)';
          ctx.moveTo(sP.x, sP.y);
          ctx.lineTo(sB.x, sB.y);
          ctx.stroke();
          ctx.setLineDash([]);
        }
        ctx.restore();
      }

      // Start point: hollow "lifted from here" ghost (or amber cancel halo when dragged back)
      if (dragCancelZone) {
        ctx.beginPath();
        ctx.arc(sA.x, sA.y, 16, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(217, 119, 6, 0.18)';
        ctx.fill();
        ctx.setLineDash([4, 3]);
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#d97706';
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.arc(sA.x, sA.y, 6, 0, Math.PI * 2);
        ctx.fillStyle = '#d97706';
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.arc(sA.x, sA.y, 4.5, 0, Math.PI * 2);
        ctx.setLineDash([2, 2.5]);
        ctx.lineWidth = 1.4;
        ctx.strokeStyle = dragIsUnfold ? unfoldAccent : (isDark ? 'rgba(255,255,255,0.6)' : 'rgba(80,60,45,0.55)');
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Fingertip contact ring (pressure feel)
      if (dragPointer && !dragCancelZone) {
        ctx.beginPath();
        ctx.arc(sP.x, sP.y, 13, 0, Math.PI * 2);
        ctx.fillStyle = isDark ? 'rgba(255,255,255,0.07)' : 'rgba(30,20,10,0.06)';
        ctx.fill();
        ctx.lineWidth = 1.2;
        ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.35)' : 'rgba(30,20,10,0.22)';
        ctx.stroke();
      }

      // Badge near cursor (cancel badge OR magnetic snap label)
      const badgeText = dragCancelZone ? dragCancelLabel : dragSnapLabel;
      if (badgeText) {
        ctx.font = '600 11.5px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
        const tw = ctx.measureText(badgeText).width;
        const anchor = dragPointer || sB;
        const bx = Math.min(width - tw - 22, Math.max(10, anchor.x - tw * 0.5 - 8));
        const by = Math.max(12, anchor.y - 44);
        ctx.fillStyle = dragCancelZone
          ? 'rgba(180, 83, 9, 0.94)'
          : dragIsUnfold
            ? 'rgba(13, 148, 136, 0.94)'
            : 'rgba(24, 22, 20, 0.88)';
        roundRect(ctx, bx, by, tw + 16, 22, 11);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.textBaseline = 'middle';
        ctx.fillText(badgeText, bx + 8, by + 11.5);
      }
    }

    ctx.restore();
    return;
  }

  // ---- Mode B: Precision 2-Point Line-Fold overlays ----
  if (previewFaces && previewFaces.length > 0 && hoverSide !== 0) {
    ctx.fillStyle = isMountain ? 'rgba(220, 38, 38, 0.28)' : 'rgba(37, 99, 235, 0.28)';
    for (const f of previewFaces) {
      const scr = f.pts.map(p => projectPoint(worldToCamera(p, cam), width, height));
      ctx.beginPath();
      ctx.moveTo(scr[0].x, scr[0].y);
      for (let k = 1; k < scr.length; k++) ctx.lineTo(scr[k].x, scr[k].y);
      ctx.closePath();
      ctx.fill();
    }
  }

  if (snapPoints && !p2) {
    for (const sp of snapPoints) {
      const pr = projectPoint(worldToCamera(snapWorldPos(sp, layerThick, viewSideZ), cam), width, height);
      const isHov = hoveredSnap && hoveredSnap === sp;
      const isSelected = p1 && Math.hypot(sp.x - p1.x, sp.y - p1.y) < 0.02;
      const rad = isHov || isSelected ? 7.5 : sp.kind === 'vertex' ? 5.2 : 3.6;

      ctx.beginPath();
      ctx.arc(pr.x, pr.y, rad, 0, Math.PI * 2);
      ctx.fillStyle = isSelected ? '#cf4436' : isHov ? accent : (isDark ? 'rgba(255,255,255,0.88)' : 'rgba(255,255,255,0.94)');
      ctx.fill();
      ctx.lineWidth = isHov || isSelected ? 2.2 : 1.6;
      ctx.strokeStyle = isSelected || isHov ? '#ffffff' : (sp.kind === 'vertex' ? '#2563eb' : '#78716c');
      ctx.stroke();
    }
  }

  const lineEnd = p2 || hoverWorld;
  if (p1 && lineEnd) {
    const s1 = projectPoint(worldToCamera(p1, cam), width, height);
    const s2 = projectPoint(worldToCamera(lineEnd, cam), width, height);

    ctx.beginPath();
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 4.5;
    ctx.moveTo(s1.x, s1.y);
    ctx.lineTo(s2.x, s2.y);
    ctx.stroke();

    ctx.beginPath();
    ctx.setLineDash(isMountain ? [10, 4, 2, 4] : [8, 5]);
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2.5;
    ctx.moveTo(s1.x, s1.y);
    ctx.lineTo(s2.x, s2.y);
    ctx.stroke();
    ctx.setLineDash([]);

    for (const s of [s1, s2]) {
      ctx.beginPath();
      ctx.arc(s.x, s.y, 6, 0, Math.PI * 2);
      ctx.fillStyle = accent;
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }

  ctx.restore();
}

function drawGifHudOverlay(ctx, width, height, hud, isDark) {
  const { title, stepLabel, technique, stepNum, totalSteps, progress } = hud;
  ctx.save();

  // Top-left subtle watermark badge
  const pad = Math.round(width * 0.03);
  const titleFontSize = Math.max(12, Math.round(width * 0.025));
  ctx.font = `600 ${titleFontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
  const titleW = ctx.measureText(title).width;
  const pillH = Math.round(titleFontSize * 1.9);

  ctx.fillStyle = isDark ? 'rgba(20, 19, 24, 0.72)' : 'rgba(255, 252, 247, 0.84)';
  roundRect(ctx, pad, pad, titleW + 22, pillH, 8);
  ctx.fill();
  ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.12)' : 'rgba(120,100,80,0.18)';
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.fillStyle = isDark ? '#f5f2eb' : '#292524';
  ctx.textBaseline = 'middle';
  ctx.fillText(title, pad + 11, pad + pillH * 0.52);

  // Bottom bar with step caption & smooth progress
  const barH = Math.max(40, Math.round(height * 0.115));
  const barY = height - barH;
  ctx.fillStyle = isDark ? 'rgba(18, 17, 22, 0.82)' : 'rgba(255, 252, 247, 0.88)';
  ctx.fillRect(0, barY, width, barH);

  // Progress line at top of bottom bar
  ctx.fillStyle = isDark ? 'rgba(255,255,255,0.12)' : 'rgba(120,100,80,0.16)';
  ctx.fillRect(0, barY, width, 3);
  ctx.fillStyle = '#cf4436';
  ctx.fillRect(0, barY, Math.round(width * Math.max(0, Math.min(1, progress))), 3);

  const captionSize = Math.max(11, Math.round(width * 0.022));
  const badgeSize = Math.max(10, Math.round(width * 0.018));

  // Step counter chip
  const stepText = totalSteps > 0 ? `${stepNum}/${totalSteps}` : '3D';
  ctx.font = `700 ${badgeSize}px monospace`;
  const chipW = ctx.measureText(stepText).width + 14;
  const chipH = Math.round(barH * 0.52);
  const chipY = barY + (barH - chipH) * 0.5 + 1;
  ctx.fillStyle = '#cf4436';
  roundRect(ctx, pad, chipY, chipW, chipH, 5);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'middle';
  ctx.fillText(stepText, pad + 7, chipY + chipH * 0.52);

  // Step label
  ctx.font = `600 ${captionSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
  ctx.fillStyle = isDark ? '#f5f2eb' : '#1c1917';
  const labelText = technique ? `[${technique}] ${stepLabel}` : stepLabel;
  ctx.fillText(labelText, pad + chipW + 10, barY + barH * 0.54);

  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * Render the 2D Crease Pattern (전개도) mini-canvas showing all Valley (blue)
 * and Mountain (red) crease lines mapped onto the paper's true aspect ratio.
 */
export function renderCreasePattern2D(ctx, size, creases, isDark = false, paperAspect = 1) {
  ctx.clearRect(0, 0, size, size);
  const pad = 10;
  const maxInner = size - pad * 2;
  const aspect = Math.max(0.25, Math.min(4.0, Number.isFinite(paperAspect) && paperAspect > 0 ? paperAspect : 1));
  const drawW = aspect >= 1 ? maxInner : maxInner * aspect;
  const drawH = aspect >= 1 ? maxInner / aspect : maxInner;
  const ox = (size - drawW) * 0.5;
  const oy = (size - drawH) * 0.5;

  ctx.fillStyle = isDark ? '#25232a' : '#fbf8f2';
  ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.25)' : 'rgba(120,100,80,0.4)';
  ctx.lineWidth = 1.5;
  ctx.fillRect(ox, oy, drawW, drawH);
  ctx.strokeRect(ox, oy, drawW, drawH);

  if (!creases || creases.length === 0) return;

  ctx.save();
  ctx.lineCap = 'round';
  for (const c of creases) {
    const x1 = ox + c.u1 * drawW;
    const y1 = oy + (1 - c.v1) * drawH;
    const x2 = ox + c.u2 * drawW;
    const y2 = oy + (1 - c.v2) * drawH;
    const isM = c.type === 'mountain';
    ctx.beginPath();
    ctx.setLineDash(isM ? [5, 2.5, 1.5, 2.5] : [4, 3]);
    ctx.strokeStyle = isM ? '#dc2626' : '#2563eb';
    ctx.lineWidth = 1.35;
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }
  ctx.restore();
}
