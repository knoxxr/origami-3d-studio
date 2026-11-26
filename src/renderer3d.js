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

function shadePaperColor(baseRgb, normal, viewDir, layer, isBack, isDark) {
  // Orient normal toward viewer for lighting computation
  const n = dot(normal, viewDir) >= 0 ? normal : scale(normal, -1);

  const keyLight = norm(v3(-0.42, 0.68, 0.65));
  const fillLight = norm(v3(0.55, -0.28, 0.52));
  const rimLight = norm(v3(0.15, 0.35, -0.92));

  const nDotKey = Math.max(0, dot(n, keyLight));
  const nDotFill = Math.max(0, dot(n, fillLight));
  const nDotRim = Math.max(0, dot(n, rimLight));

  // Soft Blinn-Phong satin paper highlight
  const halfVec = norm(add(keyLight, viewDir));
  const spec = Math.pow(Math.max(0, dot(n, halfVec)), 22) * (isBack ? 0.08 : 0.14);

  // Hemisphere ambient + directional diffuse
  const hemi = 0.5 + 0.5 * n.y;
  const ambient = (isDark ? 0.34 : 0.40) + hemi * 0.12;
  const diffuse = nDotKey * 0.52 + nDotFill * 0.22 + nDotRim * 0.10;
  // Subtle layer depth cue so overlapping paper folds remain distinct
  const layerCue = Math.max(-0.04, Math.min(0.05, layer * 0.01));
  const intensity = Math.max(0.28, Math.min(1.22, ambient + diffuse + layerCue));

  const r = clamp255(baseRgb.r * intensity + spec * 255);
  const g = clamp255(baseRgb.g * intensity + spec * 250);
  const b = clamp255(baseRgb.b * intensity + spec * 242);

  // Subtle crease edge stroke (slightly darker tone of the shaded paper)
  const edgeFactor = isBack ? 0.78 : 0.72;
  const er = clamp255(r * edgeFactor);
  const eg = clamp255(g * edgeFactor);
  const eb = clamp255(b * edgeFactor);

  return {
    fill: `rgb(${r},${g},${b})`,
    stroke: `rgb(${er},${eg},${eb})`,
  };
}

/**
 * Topological plane-aware painter's sort (back-to-front).
 * Resolves overlapping polygons cleanly using camera-space plane tests + layer tie-breakers.
 */
function sortFacesBackToFront(items) {
  const n = items.length;
  if (n <= 1) return items;

  // Initial sort by average camera Z descending (farthest first)
  items.sort((a, b) => {
    const dz = b.avgZ - a.avgZ;
    if (Math.abs(dz) > 0.008) return dz;
    // Tie-break by signed layer along viewing side
    return a.layerKey - b.layerKey;
  });

  // Only run pairwise plane-dominance DAG if count is reasonable (<= 220 faces)
  if (n > 220) return items;

  const adj = Array.from({ length: n }, () => []);
  const indeg = new Int32Array(n);

  for (let i = 0; i < n; i++) {
    const A = items[i];
    for (let j = i + 1; j < n; j++) {
      const B = items[j];
      // Fast 2D screen bounding-box rejection
      if (A.maxX < B.minX - 0.5 || B.maxX < A.minX - 0.5 ||
          A.maxY < B.minY - 0.5 || B.maxY < A.minY - 0.5) {
        continue;
      }

      // Fast depth interval separation (remember cam Z: larger = farther!)
      if (A.minZ > B.maxZ + 1e-4) {
        // A is strictly behind B -> draw A before B
        adj[i].push(j);
        indeg[j]++;
        continue;
      }
      if (B.minZ > A.maxZ + 1e-4) {
        // B is strictly behind A -> draw B before A
        adj[j].push(i);
        indeg[i]++;
        continue;
      }

      // Plane test: check if all vertices of A lie strictly on one side of B's camera-space plane
      // Camera is at origin (0,0,0) in camera space; B.camNormal points TOWARD camera (dot(camNormal, -B.camCenter) > 0)
      const planeSide = (pts, planeOrig, planeN) => {
        let pos = 0, neg = 0;
        for (let k = 0; k < pts.length; k++) {
          const d = dot(sub(pts[k], planeOrig), planeN);
          if (d > 2e-3) pos++;
          else if (d < -2e-3) neg++;
        }
        if (pos > 0 && neg === 0) return 1;  // strictly in front (camera side)
        if (neg > 0 && pos === 0) return -1; // strictly behind
        if (pos === 0 && neg === 0) return 0; // coplanar
        return 2; // straddling
      };

      const aVsB = planeSide(A.camPts, B.camCenter, B.camNormal);
      if (aVsB === -1) {
        adj[i].push(j); indeg[j]++; continue;
      }
      if (aVsB === 1) {
        adj[j].push(i); indeg[i]++; continue;
      }

      const bVsA = planeSide(B.camPts, A.camCenter, A.camNormal);
      if (bVsA === 1) {
        adj[i].push(j); indeg[j]++; continue;
      }
      if (bVsA === -1) {
        adj[j].push(i); indeg[i]++; continue;
      }

      // Coplanar (stacked paper layers!) -> sort by signed layerKey
      if (aVsB === 0 || bVsA === 0) {
        if (A.layerKey < B.layerKey) {
          adj[i].push(j); indeg[j]++;
        } else if (B.layerKey < A.layerKey) {
          adj[j].push(i); indeg[i]++;
        }
      }
    }
  }

  // Kahn's topological sort with deterministic back-to-front tie-breaking
  const visited = new Uint8Array(n);
  const result = [];
  for (let step = 0; step < n; step++) {
    let pick = -1;
    for (let i = 0; i < n; i++) {
      if (!visited[i] && indeg[i] === 0) {
        pick = i;
        break;
      }
    }
    if (pick === -1) {
      // Break any cycle by picking the farthest unvisited face
      for (let i = 0; i < n; i++) {
        if (!visited[i]) {
          pick = i;
          break;
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

  // 2. Soft ground contact shadow projected neatly below the paper's actual vertical span
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
    ctx.fillStyle = isDark ? 'rgba(0, 0, 0, 0.24)' : 'rgba(65, 48, 32, 0.085)';
    for (let i = 0; i < faces.length; i++) {
      const pts = faces[i].pts;
      if (pts.length < 3) continue;
      ctx.beginPath();
      let valid = true;
      for (let k = 0; k < pts.length; k++) {
        // Project softly along light vector onto floorY
        const p = pts[k];
        const drop = Math.max(0, p.y - floorY);
        const sp = v3(p.x + drop * 0.14, floorY, p.z - drop * 0.16);
        const cp = worldToCamera(sp, cam);
        if (cp.z <= 0.1) { valid = false; break; }
        const pr = projectPoint(cp, width, height);
        if (k === 0) ctx.moveTo(pr.x, pr.y);
        else ctx.lineTo(pr.x, pr.y);
      }
      if (valid) {
        ctx.closePath();
        ctx.fill();
      }
    }
    ctx.restore();
  }

  // 3. Transform & shade all paper faces
  const renderItems = [];
  const layerThick = 0.0042;
  const viewSideZ = (cam.eye.z - cam.target.z) >= 0 ? 1 : -1;

  for (let i = 0; i < faces.length; i++) {
    const f = faces[i];
    if (!f.pts || f.pts.length < 3) continue;

    const normal = polyNormal(f.pts);
    const center = polyCentroid(f.pts);
    const viewDir = norm(sub(cam.eye, center));
    const frontFacing = dot(normal, viewDir) >= 0;

    // Tiny physical thickness offset along Z/normal so stacked layers never z-fight
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

    const shaded = shadePaperColor(
      frontFacing ? frontRgb : backRgb,
      normal,
      viewDir,
      f.layer || 0,
      !frontFacing,
      isDark
    );

    renderItems.push({
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
      origFace: f,
    });
  }

  const sorted = sortFacesBackToFront(renderItems);

  // 4. Paint paper polygons back-to-front
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (let i = 0; i < sorted.length; i++) {
    const it = sorted[i];
    const pts = it.scrPts;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let k = 1; k < pts.length; k++) {
      ctx.lineTo(pts[k].x, pts[k].y);
    }
    ctx.closePath();

    if (!showWireframe) {
      ctx.fillStyle = it.shaded.fill;
      ctx.fill();
      ctx.strokeStyle = it.shaded.stroke;
      ctx.lineWidth = 1.05;
      ctx.stroke();
    } else {
      ctx.fillStyle = it.frontFacing
        ? 'rgba(207, 68, 54, 0.16)'
        : 'rgba(180, 170, 155, 0.14)';
      ctx.fill();
      ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.65)' : 'rgba(40,35,30,0.65)';
      ctx.lineWidth = 1.25;
      ctx.stroke();
    }
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
      const isMountain = g.type === 'mountain';

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

  // 6. Free Fold Studio interactive overlays (snap points, rubber-band line, side highlight)
  if (freeOverlay) {
    drawFreeStudioOverlay(ctx, width, height, cam, freeOverlay, isDark);
  }

  // 7. Optional HUD Overlay (used when baking captions into exported GIF frames!)
  if (hudOverlay) {
    drawGifHudOverlay(ctx, width, height, hudOverlay, isDark);
  }

  return cam;
}

function drawFreeStudioOverlay(ctx, width, height, cam, overlay, isDark) {
  const {
    interactMode = 'drag',
    snapPoints, hoveredSnap, p1, p2, hoverWorld, foldType, hoverSide, previewFaces,
    dragStart, dragCurrent, dragSnapLabel, dragCrease, dragMirrorCrease = null,
    mirrorAxisX = null, dragIsUnfold = false, unfoldGhost = null, unfoldGhostLabel = 'Unfold',
    dragCancelZone = false, dragCancelLabel = 'Release to cancel',
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
    const r = isHighlight ? 9 : sp.kind === 'center' ? 5.5 : sp.kind === 'vertex' ? 5.2 : 4.2;
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
    // 1. When idle (not dragging), show subtle, touch-friendly glowing grab rings on corners & midpoints
    if (!dragStart && snapPoints) {
      for (const sp of snapPoints) {
        if (sp.kind === 'center' || sp.kind === 'quarter' || sp.kind === 'intersect') continue;
        const pr = projectPoint(worldToCamera(sp, cam), width, height);
        const isHov = hoveredSnap && hoveredSnap === sp;
        const rad = isHov ? 9.5 : sp.kind === 'vertex' ? 6.5 : 4.2;

        if (sp.kind === 'vertex' || isHov) {
          ctx.beginPath();
          ctx.arc(pr.x, pr.y, rad + 4, 0, Math.PI * 2);
          ctx.fillStyle = isMountain ? 'rgba(220, 38, 38, 0.16)' : 'rgba(37, 99, 235, 0.16)';
          ctx.fill();
        }
        ctx.beginPath();
        ctx.arc(pr.x, pr.y, rad, 0, Math.PI * 2);
        ctx.fillStyle = isHov ? foldAccent : 'rgba(255, 255, 255, 0.94)';
        ctx.fill();
        ctx.lineWidth = isHov ? 2.4 : 1.8;
        ctx.strokeStyle = isHov ? '#ffffff' : (sp.kind === 'vertex' ? foldAccent : '#78716c');
        ctx.stroke();
      }
    }

    // 2. While actively dragging a corner/edge to fold or unfold!
    if (dragStart && dragCurrent) {
      // Show snap targets (including intersections & quarter points) so the user sees magnetic targets!
      if (!dragIsUnfold && !dragCancelZone && snapPoints) {
        for (const sp of snapPoints) {
          if (Math.hypot(sp.x - dragStart.x, sp.y - dragStart.y) < 0.08) continue;
          const pr = projectPoint(worldToCamera(sp, cam), width, height);
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
        ctx.globalAlpha = alpha;
        ctx.beginPath();
        ctx.setLineDash([]);
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.lineWidth = 4.6;
        ctx.moveTo(c1.x, c1.y);
        ctx.lineTo(c2.x, c2.y);
        ctx.stroke();

        ctx.beginPath();
        ctx.setLineDash(isMountain ? [10, 4, 2, 4] : [8, 5]);
        ctx.strokeStyle = accent;
        ctx.lineWidth = 2.6;
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

      // Curved directional arrow from dragStart -> dragCurrent
      const sA = projectPoint(worldToCamera(dragStart, cam), width, height);
      const sB = projectPoint(worldToCamera(dragCurrent, cam), width, height);
      const mx = (sA.x + sB.x) * 0.5;
      const my = (sA.y + sB.y) * 0.5;
      const dx = sB.x - sA.x;
      const dy = sB.y - sA.y;
      const dLen = Math.hypot(dx, dy);

      if (!dragCancelZone && dLen > 14) {
        const cx = mx - dy * 0.16;
        const cy = my + dx * 0.16 - 12;

        ctx.beginPath();
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.lineWidth = 5;
        ctx.moveTo(sA.x, sA.y);
        ctx.quadraticCurveTo(cx, cy, sB.x, sB.y);
        ctx.stroke();

        ctx.beginPath();
        ctx.strokeStyle = accent;
        ctx.lineWidth = 2.8;
        ctx.moveTo(sA.x, sA.y);
        ctx.quadraticCurveTo(cx, cy, sB.x, sB.y);
        ctx.stroke();

        // Arrowhead at sB
        const tangAng = Math.atan2(sB.y - cy, sB.x - cx);
        const headLen = 11;
        ctx.beginPath();
        ctx.fillStyle = accent;
        ctx.moveTo(sB.x, sB.y);
        ctx.lineTo(sB.x - headLen * Math.cos(tangAng - 0.45), sB.y - headLen * Math.sin(tangAng - 0.45));
        ctx.lineTo(sB.x - headLen * Math.cos(tangAng + 0.45), sB.y - headLen * Math.sin(tangAng + 0.45));
        ctx.closePath();
        ctx.fill();
      }

      // Start point dot (or amber cancel halo when dragged back to origin)
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
      }
      ctx.beginPath();
      ctx.arc(sA.x, sA.y, 6, 0, Math.PI * 2);
      ctx.fillStyle = dragCancelZone ? '#d97706' : (dragIsUnfold ? unfoldAccent : '#cf4436');
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.stroke();

      // Badge near cursor (cancel badge OR magnetic snap label)
      const badgeText = dragCancelZone ? dragCancelLabel : dragSnapLabel;
      if (badgeText) {
        ctx.font = '600 11.5px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
        const tw = ctx.measureText(badgeText).width;
        const bx = Math.min(width - tw - 22, Math.max(10, sB.x - tw * 0.5 - 8));
        const by = Math.max(12, sB.y - 34);
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
      const pr = projectPoint(worldToCamera(sp, cam), width, height);
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
 * and Mountain (red) crease lines mapped onto the original square sheet.
 */
export function renderCreasePattern2D(ctx, size, creases, isDark = false) {
  ctx.clearRect(0, 0, size, size);
  const pad = 10;
  const inner = size - pad * 2;

  ctx.fillStyle = isDark ? '#25232a' : '#fbf8f2';
  ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.25)' : 'rgba(120,100,80,0.4)';
  ctx.lineWidth = 1.5;
  ctx.fillRect(pad, pad, inner, inner);
  ctx.strokeRect(pad, pad, inner, inner);

  if (!creases || creases.length === 0) return;

  ctx.save();
  ctx.lineCap = 'round';
  for (const c of creases) {
    const x1 = pad + c.u1 * inner;
    const y1 = pad + (1 - c.v1) * inner;
    const x2 = pad + c.u2 * inner;
    const y2 = pad + (1 - c.v2) * inner;
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
