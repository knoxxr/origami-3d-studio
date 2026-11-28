import fs from 'fs';
import { ORIGAMI_CATALOG } from '../src/kinematicModels.js';
import { compilePlanarTimeline, computeSnapPoints, compilePlanarStep, createInitialPaper, estimateBendRadius, bendTipOffset } from '../src/planarEngine.js';
import { GifEncoder } from '../src/gifEncoder.js';
import { dist } from '../src/math3d.js';

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error('FAIL:', msg);
  }
}

console.log('=== 1. Verifying All 13 Origami Models & Techniques ===');
for (const item of ORIGAMI_CATALOG) {
  const isKinematic = typeof item.evaluate === 'function';
  const timeline = isKinematic
    ? null
    : compilePlanarTimeline(item.paper || { width: 2, height: 2 }, item.steps);

  const stepCount = item.steps.length;
  assert(stepCount > 0, `${item.id} has steps`);

  let totalFacesMax = 0;
  for (let s = 0; s < stepCount; s++) {
    for (const t of [0, 0.25, 0.5, 0.75, 1.0]) {
      const frame = isKinematic ? item.evaluate(s, t) : timeline.evaluate(s, t);
      assert(Array.isArray(frame.faces) && frame.faces.length > 0, `${item.id} step ${s} t=${t} produces faces`);
      if (frame.faces.length > totalFacesMax) totalFacesMax = frame.faces.length;

      for (const f of frame.faces) {
        assert(f.pts.length >= 3, `${item.id} face has >= 3 verts`);
        for (const p of f.pts) {
          assert(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z),
            `${item.id} step ${s} t=${t} vertex is finite`);
        }
      }
    }
  }
  console.log(`  [OK] ${item.id.padEnd(18)} (${isKinematic ? 'kinematic' : 'planar   '}) · ${stepCount} steps · max ${totalFacesMax} faces`);
}

console.log('\n=== 2. Verifying Rigid-Origami Isometric Edge Lengths ===');
// Squash Fold isometric check: |O - T|, |O - CR|, |M - CR|, |T - CR| constant across all t in [0,1]
const squash = ORIGAMI_CATALOG.find(m => m.id === 'tech-squash');
const sqLengths0 = (() => {
  const f = squash.evaluate(2, 0).faces;
  // baseTriR = [O, M, CR], topTriR = [O, CR, T]
  const [O, M, CR] = f[1].pts;
  const T = f[3].pts[2];
  return [dist(O, M), dist(O, CR), dist(M, CR), dist(O, T), dist(CR, T)];
})();
for (const t of [0.1, 0.35, 0.5, 0.75, 0.99, 1.0]) {
  const f = squash.evaluate(2, t).faces;
  const [O, M, CR] = f[1].pts;
  const T = f[3].pts[2];
  const cur = [dist(O, M), dist(O, CR), dist(M, CR), dist(O, T), dist(CR, T)];
  for (let i = 0; i < cur.length; i++) {
    assert(Math.abs(cur[i] - sqLengths0[i]) < 1e-5, `Squash Fold edge ${i} isometric at t=${t}: ${cur[i]} vs ${sqLengths0[i]}`);
  }
}
console.log('  [OK] Squash Fold 3D kinematics: 100% isometric (error < 1e-5)');

// Petal Fold isometric check: center triangle & side kite triangles stay rigid across t in [0,1]
const petal = ORIGAMI_CATALOG.find(m => m.id === 'tech-petal');
const pf0 = petal.evaluate(2, 0).faces;
// faces: [back, topTri, centerPetal(KL,Bm,KR), rightWing(KR,Bm,Rm), leftWing(KL,Lm,Bm)]
const pfLens0 = [
  dist(pf0[2].pts[0], pf0[2].pts[1]),
  dist(pf0[2].pts[1], pf0[2].pts[2]),
  dist(pf0[3].pts[0], pf0[3].pts[2]),
  dist(pf0[3].pts[1], pf0[3].pts[2]),
];
for (const t of [0.2, 0.5, 0.8, 1.0]) {
  const pf = petal.evaluate(2, t).faces;
  const cur = [
    dist(pf[2].pts[0], pf[2].pts[1]),
    dist(pf[2].pts[1], pf[2].pts[2]),
    dist(pf[3].pts[0], pf[3].pts[2]),
    dist(pf[3].pts[1], pf[3].pts[2]),
  ];
  for (let i = 0; i < cur.length; i++) {
    assert(Math.abs(cur[i] - pfLens0[i]) < 1e-5, `Petal Fold edge ${i} isometric at t=${t}: ${cur[i]} vs ${pfLens0[i]}`);
  }
}
console.log('  [OK] Petal Fold 3D kinematics: 100% isometric (error < 1e-5)');

// Miura-ori isometric check: ALL 16 parallelograms keep exact constant side lengths a=0.56, b=0.56 across full collapse!
const miura = ORIGAMI_CATALOG.find(m => m.id === 'tech-miura');
for (const [s, t] of [[1, 0], [1, 0.5], [1, 1], [2, 0.5], [2, 1]]) {
  const mf = miura.evaluate(s, t).faces;
  assert(mf.length === 16, `Miura-ori has 16 parallelograms at s=${s} t=${t}`);
  for (const f of mf) {
    const [p0, p1, p2, p3] = f.pts;
    assert(Math.abs(dist(p0, p1) - 0.56) < 1e-5, `Miura edge a isometric: ${dist(p0, p1)}`);
    assert(Math.abs(dist(p1, p2) - 0.56) < 1e-5, `Miura edge b isometric: ${dist(p1, p2)}`);
    assert(Math.abs(dist(p2, p3) - 0.56) < 1e-5, `Miura edge c isometric: ${dist(p2, p3)}`);
    assert(Math.abs(dist(p3, p0) - 0.56) < 1e-5, `Miura edge d isometric: ${dist(p3, p0)}`);
  }
}
console.log('  [OK] Miura-ori 4x4 Tessellation: ALL 64 edges 100% rigid isometric (error < 1e-5)');

// Open Sink apex slant-edge isometric check across full inversion t in [0, 1]
const openSink = ORIGAMI_CATALOG.find(m => m.id === 'tech-open-sink');
const os0 = openSink.evaluate(2, 0).faces[1].pts; // [P0, P1, O]
const osEdge0 = dist(os0[0], os0[2]);
for (const t of [0.15, 0.4, 0.5, 0.75, 1.0]) {
  const os = openSink.evaluate(2, t).faces[1].pts;
  assert(Math.abs(dist(os[0], os[2]) - osEdge0) < 1e-5, `Open Sink slant edge isometric at t=${t}`);
}
console.log('  [OK] Open Sink 3D apex inversion: 100% isometric (error < 1e-5)');

// Outside Reverse Fold rigid tip wrapping check
const outRev = ORIGAMI_CATALOG.find(m => m.id === 'tech-outside-reverse');
const or0 = outRev.evaluate(1, 0).faces[3].pts; // [S, TipF, H0]
const orLen0 = [dist(or0[0], or0[1]), dist(or0[1], or0[2])];
for (const [s, t] of [[1, 0.5], [1, 1], [2, 0.5], [2, 1]]) {
  const cur = outRev.evaluate(s, t).faces[3].pts;
  assert(Math.abs(dist(cur[0], cur[1]) - orLen0[0]) < 1e-4, `Outside Reverse S-Tip rigid at s=${s} t=${t}`);
  assert(Math.abs(dist(cur[1], cur[2]) - orLen0[1]) < 1e-4, `Outside Reverse Tip-H0 rigid at s=${s} t=${t}`);
}
console.log('  [OK] Outside Reverse Fold 3D wrap: 100% isometric (error < 1e-4)');

console.log('\n=== 3. Verifying Free Fold Studio Engine & Snap Points ===');
const freeSteps = [
  { type: 'valley', p1: [-1, -1], p2: [1, 1], side: -1, angleDeg: 180 },
  { type: 'pleat', p1: [-0.3, -1], p2: [-0.3, 1], side: -1, offset: 0.25, angleDeg: 180 },
  { type: 'flip', axis: 'y' },
  { type: 'rotate', angleDeg: 45 },
];
const freeTL = compilePlanarTimeline({ width: 2, height: 2 }, freeSteps);
const snaps = computeSnapPoints(freeTL.finalState);
assert(snaps.length >= 6, `Snap points generated (${snaps.length})`);
console.log(`  [OK] Free Studio multi-step timeline & ${snaps.length} snap points`);

console.log('\n=== 4. Verifying Pure-JS GIF89a Encoder ===');
const W = 160, H = 120;
const gif = new GifEncoder(W, H, 0);
const numFrames = 12;
const t0 = performance.now();
for (let f = 0; f < numFrames; f++) {
  const rgba = new Uint8Array(W * H * 4);
  const cx = 30 + f * 9;
  const cy = 60 + Math.round(Math.sin(f * 0.5) * 20);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx = (y * W + x) * 4;
      const d = Math.hypot(x - cx, y - cy);
      if (d < 26) {
        rgba[idx] = 207;
        rgba[idx + 1] = 68;
        rgba[idx + 2] = 54;
      } else {
        rgba[idx] = 245 - Math.round((y / H) * 20);
        rgba[idx + 1] = 238 - Math.round((y / H) * 18);
        rgba[idx + 2] = 228 - Math.round((y / H) * 15);
      }
      rgba[idx + 3] = 255;
    }
  }
  gif.addFrame(rgba, 60);
}
const gifBytes = gif.finish();
const dt = (performance.now() - t0).toFixed(1);
fs.writeFileSync(new URL('./sample_verify.gif', import.meta.url), gifBytes);
assert(gifBytes[0] === 0x47 && gifBytes[1] === 0x49 && gifBytes[2] === 0x46, 'GIF89a magic bytes');
assert(gifBytes[gifBytes.length - 1] === 0x3b, 'GIF trailer 0x3B');
console.log(`  [OK] Encoded ${numFrames}-frame ${W}x${H} GIF (${gifBytes.length} bytes) in ${dt}ms`);

console.log('\n=== 5. Verifying Unfold Engine (unfoldLast, unfoldAll, flip+unfold, topUnfoldHint) ===');
{
  const unfoldSteps = [
    { type: 'valley', p1: [-1, -1], p2: [1, 1], side: -1, angleDeg: 180, label: '대각선 접기' },
    { type: 'valley', p1: [0, -1], p2: [0, 1], side: -1, angleDeg: 180, label: '세로 반 접기' },
  ];
  const tlFolded = compilePlanarTimeline({ width: 2, height: 2 }, unfoldSteps);
  assert(tlFolded.activeFoldCount === 2, 'activeFoldCount === 2 after two folds');
  assert(tlFolded.topUnfoldHint && tlFolded.topUnfoldHint.pairs.length > 0, 'topUnfoldHint has moving flap pairs');
  const prevCreases = tlFolded.finalState.creases.length;
  assert(prevCreases >= 2, 'creases recorded before unfold');

  // Unfold last step (keeps creases, decrements activeFoldCount to 1)
  const tlUnfold1 = compilePlanarTimeline({ width: 2, height: 2 }, [...unfoldSteps, { type: 'unfoldLast', label: '직전 펼치기' }]);
  assert(tlUnfold1.activeFoldCount === 1, 'activeFoldCount === 1 after unfoldLast');
  assert(tlUnfold1.finalState.creases.length === prevCreases, 'unfoldLast preserves all creases');
  const uMid = tlUnfold1.evaluate(2, 0.5);
  assert(uMid.faces.length > 0 && uMid.faces.every(f => f.pts.every(p => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z))), 'unfoldLast mid-frame finite');

  // Unfold all remaining folds back to flat square (z=0 everywhere, bounds [-1, 1])
  const tlUnfoldAll = compilePlanarTimeline({ width: 2, height: 2 }, [...unfoldSteps, { type: 'unfoldAll', label: '전체 펼치기' }]);
  assert(tlUnfoldAll.activeFoldCount === 0, 'activeFoldCount === 0 after unfoldAll');
  assert(tlUnfoldAll.topUnfoldHint === null, 'topUnfoldHint is null when flat');
  assert(tlUnfoldAll.finalState.creases.length === prevCreases, 'unfoldAll preserves all creases');
  let maxZ = 0, minX = 9, maxX = -9, minY = 9, maxY = -9;
  for (const f of tlUnfoldAll.finalState.faces) {
    for (const p of f.pts) {
      maxZ = Math.max(maxZ, Math.abs(p.z));
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
  }
  assert(maxZ < 1e-3, `unfoldAll returns flat sheet (maxZ=${maxZ})`);
  assert(Math.abs(minX + 1) < 1e-3 && Math.abs(maxX - 1) < 1e-3 && Math.abs(minY + 1) < 1e-3 && Math.abs(maxY - 1) < 1e-3, 'unfoldAll restores full [-1,1]x[-1,1] square');

  // Fold -> Flip -> UnfoldLast stays continuous and unfolds in flipped coordinates
  const tlFlipUnfold = compilePlanarTimeline({ width: 2, height: 2 }, [
    { type: 'valley', p1: [-1, -1], p2: [1, 1], side: -1, angleDeg: 180, label: '대각선 접기' },
    { type: 'flip', axis: 'y', label: '뒤집기' },
    { type: 'unfoldLast', label: '뒤집은 뒤 펼치기' },
  ]);
  assert(tlFlipUnfold.activeFoldCount === 0, 'fold -> flip -> unfoldLast resets activeFoldCount to 0');
  const fAfterFlip = tlFlipUnfold.evaluate(1, 1.0);
  const fStartUnfold = tlFlipUnfold.evaluate(2, 0.0);
  assert(fAfterFlip.faces.length === fStartUnfold.faces.length, 'fold -> flip -> unfoldLast face count continuity');
  console.log('  [OK] unfoldLast, unfoldAll, flip+unfold conjugation, and topUnfoldHint verified');
}

console.log('\n=== 6. Verifying Expanded Snap Points (Quarter & Intersections) & Mirror Fold ===');
{
  const tlCross = compilePlanarTimeline({ width: 2, height: 2 }, [
    { type: 'precrease', p1: [-1, -1], p2: [1, 1], side: -1, label: 'Diag 1' },
    { type: 'precrease', p1: [-1, 1], p2: [1, -1], side: -1, label: 'Diag 2' },
    { type: 'precrease', p1: [-0.5, -1], p2: [-0.5, 1], side: -1, label: 'Quarter line' },
  ]);
  const snaps = computeSnapPoints(tlCross.finalState);
  const quarters = snaps.filter(s => s.kind === 'quarter');
  const hasCenter = snaps.some(s => Math.hypot(s.x, s.y) < 0.04);
  const hasQuarterHit = snaps.some(s => Math.abs(s.x + 0.5) < 0.04 && Math.abs(s.y - 1) < 0.04);
  assert(quarters.length >= 4, `Expected >= 4 quarter snap points, got ${quarters.length}`);
  assert(hasCenter, 'Expected center snap point');
  assert(hasQuarterHit, 'Expected (-0.5, 1) quarter snap point');

  // Verify symmetric Mirror Fold (both top corners folded simultaneously via multiFold)
  const tlMirror = compilePlanarTimeline({ width: 2, height: 2 }, [
    {
      type: 'multiFold',
      label: 'Mirror Valley Fold',
      folds: [
        { p1: [0, 1], p2: [1, 0], side: 1, foldType: 'valley', angleDeg: 180 },
        { p1: [0, 1], p2: [-1, 0], side: -1, foldType: 'valley', angleDeg: 180 },
      ],
    },
  ]);
  assert(tlMirror.activeFoldCount === 1, 'Mirror fold counts as 1 unfoldable step');
  assert(tlMirror.finalState.faces.length >= 3, 'Mirror fold splits both corners cleanly');
  const midM = tlMirror.evaluate(0, 0.5);
  assert(midM.faces.every(f => f.pts.every(p => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z))), 'Mirror fold mid-frame finite');
  console.log(`  [OK] Expanded snaps (${snaps.length} total, ${quarters.length} quarter) & symmetric Mirror Fold verified`);
}

console.log('\n=== 7. Verifying Double-Sided Folding (Front vs Back, Back Pleat, Back Pre-crease, Back Layer Scope) ===');
{
  // 1. Valley (+Z) vs Mountain (-Z) mid-frame Z sign verification
  const tlFront = compilePlanarTimeline({ width: 2, height: 2 }, [
    { type: 'valley', p1: [0, -1], p2: [0, 1], side: -1, angleDeg: 180, label: 'Front Half' },
  ]);
  const tlBack = compilePlanarTimeline({ width: 2, height: 2 }, [
    { type: 'mountain', p1: [0, -1], p2: [0, 1], side: -1, angleDeg: 180, label: 'Back Half' },
  ]);
  const midFrontZs = tlFront.evaluate(0, 0.5).faces.flatMap(f => f.pts.map(p => p.z));
  const midBackZs = tlBack.evaluate(0, 0.5).faces.flatMap(f => f.pts.map(p => p.z));
  assert(Math.max(...midFrontZs) > 0.5, 'Front (valley) fold lifts flap into +Z');
  assert(Math.min(...midBackZs) < -0.5, 'Back (mountain) fold folds flap into -Z');

  // 2. Back-side Pleat (foldDir: 'mountain') folds toward -Z & records mountain crease first
  const tlBackPleat = compilePlanarTimeline({ width: 2, height: 2 }, [
    { type: 'pleat', foldDir: 'mountain', p1: [-0.25, -1], p2: [-0.25, 1], side: -1, offset: 0.25, angleDeg: 165 },
  ]);
  const bpMidZs = tlBackPleat.evaluate(0, 0.5).faces.flatMap(f => f.pts.map(p => p.z));
  assert(Math.min(...bpMidZs) < -0.1, 'Back-side pleat moves into -Z');
  assert(tlBackPleat.finalState.creases[0]?.type === 'mountain', 'Back-side pleat first crease is mountain');

  // 3. Back-side Pre-crease (foldDir: 'mountain') folds into -Z then returns flat with mountain crease
  const tlBackPre = compilePlanarTimeline({ width: 2, height: 2 }, [
    { type: 'precrease', foldDir: 'mountain', creaseType: 'mountain', p1: [0, -1], p2: [0, 1], side: -1 },
  ]);
  const preSwingZs = tlBackPre.evaluate(0, 0.24).faces.flatMap(f => f.pts.map(p => p.z));
  const prePeakZs = tlBackPre.evaluate(0, 0.5).faces.flatMap(f => f.pts.map(p => p.z));
  assert(Math.min(...preSwingZs) < -0.7 && Math.min(...prePeakZs) < -0.35, 'Back-side pre-crease folds into -Z');
  assert(tlBackPre.finalState.creases[0]?.type === 'mountain', 'Back-side pre-crease leaves mountain crease');

  // 4. Back Layer only ('bottom') after stacking 2 layers
  const tlBottomLayer = compilePlanarTimeline({ width: 2, height: 2 }, [
    { type: 'valley', p1: [0, -1], p2: [0, 1], side: -1, angleDeg: 180 },
    { type: 'mountain', p1: [-1, 0], p2: [0, 0], side: 1, angleDeg: 180, layerScope: 'bottom' },
  ]);
  assert(tlBottomLayer.finalState.faces.length === 3, `Expected 3 faces (top stays whole, bottom splits into 2), got ${tlBottomLayer.finalState.faces.length}`);

  // 5. 3D Hinge continuity: folding across a non-zero-Z pleat must NOT tear moving piece to -Z
  const tlPleatThenFold = compilePlanarTimeline({ width: 2, height: 2 }, [
    { type: 'pleat', p1: [-0.25, -1], p2: [-0.25, 1], side: -1, offset: 0.25, angleDeg: 165 },
    { type: 'valley', p1: [-1, 0], p2: [1, 0], side: 1, angleDeg: 180 },
  ]);
  const allMinZ = Math.min(...tlPleatThenFold.finalState.faces.flatMap(f => f.pts.map(p => p.z)));
  assert(allMinZ >= -1e-4, `Hinge continuity after pleat+fold: expected no negative Z tearing, got minZ=${allMinZ}`);
  const snapsWithLayer = computeSnapPoints(tlPleatThenFold.finalState);
  assert(snapsWithLayer.every(s => Number.isFinite(s.minLayer) && Number.isFinite(s.maxLayer)), 'All snap points carry finite minLayer/maxLayer');
  console.log('  [OK] Front/Back folds, back pleat, back pre-crease, bottom-layer scope & 3D hinge continuity verified');
}

console.log('\n=== 8. Verifying Partial Single-Flap Back-Folding, Pocket Tuck & UV-Island Isolation ===');
{
  // 1. Fold right half over onto front, then fold ONLY the tip of that top flap back in opposite direction (Front/Valley)
  const tlBackTip = compilePlanarTimeline({ width: 2, height: 2 }, [
    { type: 'valley', p1: [0, -1], p2: [0, 1], side: -1, angleDeg: 180 },
    { type: 'valley', p1: [-0.5, -1], p2: [-0.5, 1], side: 1, angleDeg: 180, layerScope: 'top', seedPoint: [-0.95, 0] },
  ]);
  assert(tlBackTip.finalState.faces.length === 3, `Expected 3 faces (untouched base + flap + folded-back tip), got ${tlBackTip.finalState.faces.length}`);
  const layersBackTip = tlBackTip.finalState.faces.map(f => f.layer).sort((a, b) => a - b);
  assert(layersBackTip[0] < layersBackTip[1] && layersBackTip[1] < layersBackTip[2], `Expected 3 distinct stacked layers [-1,0,1], got ${JSON.stringify(layersBackTip)}`);

  // 2. Fold ONLY the tip of the top flap BACK into the pocket (Mountain) -> must tuck BETWEEN base & flap, not behind base!
  const tlPocketTuck = compilePlanarTimeline({ width: 2, height: 2 }, [
    { type: 'valley', p1: [0, -1], p2: [0, 1], side: -1, angleDeg: 180 },
    { type: 'mountain', p1: [-0.5, -1], p2: [-0.5, 1], side: 1, angleDeg: 180, layerScope: 'top', seedPoint: [-0.95, 0] },
  ]);
  assert(tlPocketTuck.finalState.faces.length === 3, `Expected 3 faces for pocket tuck, got ${tlPocketTuck.finalState.faces.length}`);
  const baseFace = tlPocketTuck.finalState.faces.find(f => {
    const xs = f.pts.map(p => p.x);
    return Math.min(...xs) < -0.95 && Math.max(...xs) > -0.05;
  });
  const minPocketLayer = Math.min(...tlPocketTuck.finalState.faces.map(f => f.layer));
  assert(baseFace && baseFace.layer === minPocketLayer, `Pocket-tucked tip must land ABOVE untouched base sheet (base layer=${baseFace?.layer}, min=${minPocketLayer})`);

  // 3. UV-connected island isolation on a Blintz fold: folding ONLY top-right flap tip back must NOT slice sibling flaps on the same layer!
  const tlBlintzOneFlap = compilePlanarTimeline({ width: 2, height: 2 }, [
    {
      type: 'multiFold',
      folds: [
        { p1: [0, 1], p2: [1, 0], side: 1, foldType: 'valley', angleDeg: 180 },
        { p1: [-1, 0], p2: [0, 1], side: 1, foldType: 'valley', angleDeg: 180 },
        { p1: [-1, 0], p2: [0, -1], side: -1, foldType: 'valley', angleDeg: 180 },
        { p1: [0, -1], p2: [1, 0], side: -1, foldType: 'valley', angleDeg: 180 },
      ],
    },
    { type: 'valley', p1: [0.45, 0], p2: [0, 0.45], side: -1, angleDeg: 180, layerScope: 'top', seedPoint: [0.05, 0.05] },
  ]);
  assert(tlBlintzOneFlap.finalState.faces.length === 6, `Expected 6 faces (1 base + 3 untouched sibling flaps + 2 split pieces of grabbed flap), got ${tlBlintzOneFlap.finalState.faces.length}`);

  // 4. Paper airplane center lock-tab: 3-layer downward nose triangle under 2 overlapping wings folds UP OVER top of the wings!
  const airplaneLockSteps = [
    { type: 'valley', p1: [0, 1], p2: [1, 0], side: 1, angleDeg: 180 },
    { type: 'valley', p1: [-1, 0], p2: [0, 1], side: 1, angleDeg: 180 },
    { type: 'valley', p1: [-1, 0.05], p2: [1, 0.05], side: 1, angleDeg: 180 },
    { type: 'valley', p1: [-0.9, 0.05], p2: [-0.08, 1.0], side: 1, angleDeg: 180 },
    { type: 'valley', p1: [0.08, 1.0], p2: [0.9, 0.05], side: 1, angleDeg: 180 },
  ];
  const tlPreLock = compilePlanarTimeline({ width: 2, height: 2 }, airplaneLockSteps);
  const preSnaps = computeSnapPoints(tlPreLock.finalState);
  const lockTip = preSnaps.find(s => Math.abs(s.x) < 0.1 && s.y < -0.5 && s.y > -0.98);
  assert(!!lockTip, 'Center lock-tab downward tip snap point exists');
  const tlLocked = compilePlanarTimeline({ width: 2, height: 2 }, [
    ...airplaneLockSteps,
    { type: 'valley', p1: [-1, -0.35], p2: [1, -0.35], side: -1, angleDeg: 180, layerScope: 'top', targetLayer: lockTip.maxLayer, seedPoint: [lockTip.x, lockTip.y] },
  ]);
  const maxLockedLayer = Math.max(...tlLocked.finalState.faces.map(f => f.layer));
  // All 3 folded-up tab pieces should land at the VERY TOP (above the wings!), and NO nose piece should remain dangling at y < -0.8
  const foldedUpTabFaces = tlLocked.finalState.faces.filter(f => f.layer >= maxLockedLayer - 2.1 && Math.max(...f.pts.map(p => p.y)) > 0.12);
  const danglingNoseFaces = tlLocked.finalState.faces.filter(f => f.layer > Math.min(...tlLocked.finalState.faces.map(x => x.layer)) + 0.5 && Math.min(...f.pts.map(p => p.y)) < -0.8);
  assert(foldedUpTabFaces.length === 3, `Expected all 3 layers of lock-tab folded UP over wings, got ${foldedUpTabFaces.length}`);
  assert(danglingNoseFaces.length === 0, `Expected 0 dangling nose layers left pointing down, got ${danglingNoseFaces.length}`);

  console.log('  [OK] Partial opposite-direction 1-flap fold, pocket-tuck ordering, Blintz UV-island & 3-layer airplane lock-tab verified');
}

console.log('\n=== 9. Verifying Physical Paper Bending & Direct-Drag Progress Override ===');
{
  const base = createInitialPaper(2, 2, 0);
  const diag = { type: 'valley', p1: [-1.5, 1.5], p2: [1.5, -1.5], side: 1, angleDeg: 180 };
  const c = compilePlanarStep(base, diag);
  const findUV = (faces, u, v) => {
    for (const f of faces) for (let i = 0; i < f.uvs.length; i++) {
      if (Math.abs(f.uvs[i].u - u) < 1e-6 && Math.abs(f.uvs[i].v - v) < 1e-6) return f.pts[i];
    }
    return null;
  };

  // Progress override is linear in angle and bypasses easing
  const rigidHalf = c.evaluate(0, { progress: 0.5, bend: false });
  const tipHalf = findUV(rigidHalf.faces, 1, 1);
  assert(tipHalf && Math.abs(tipHalf.z - Math.SQRT2) < 1e-6, `progress 0.5 rigid tip stands straight up (z=${tipHalf && tipHalf.z})`);

  // Bending subdivides the moving flap mid-fold, never at rest
  for (const p of [0.2, 0.5, 0.8]) {
    const fr = c.evaluate(0, { progress: p });
    const bent = fr.faces.filter(f => f.bent);
    assert(bent.length >= 3, `progress ${p}: flap is bent into strips (${bent.length})`);
    assert(fr.faces.every(f => f.pts.every(q => Number.isFinite(q.x) && Number.isFinite(q.y) && Number.isFinite(q.z))), `progress ${p}: bent vertices finite`);
    assert(bent.some(f => f.smoothEdges && f.smoothEdges.some(Boolean)), `progress ${p}: bend seams flagged smooth`);
    // Bend is (near-)isometric: every UV edge keeps its paper length within chord error
    const scaleXY = 2; // uv -> world for a 2x2 sheet
    let worst = 0;
    for (const f of bent) {
      for (let i = 0; i < f.pts.length; i++) {
        const j = (i + 1) % f.pts.length;
        const uvLen = Math.hypot(f.uvs[j].u - f.uvs[i].u, f.uvs[j].v - f.uvs[i].v) * scaleXY;
        const wLen = dist(f.pts[i], f.pts[j]);
        worst = Math.max(worst, Math.abs(uvLen - wLen) / Math.max(uvLen, 1e-6));
      }
    }
    assert(worst < 0.03, `progress ${p}: bend strips stay near-isometric (worst rel err ${worst.toFixed(4)})`);
  }
  for (const p of [0, 1]) {
    const fr = c.evaluate(0, { progress: p });
    assert(fr.faces.every(f => !f.bent), `progress ${p}: no bending at rest`);
  }
  assert(c.evaluate(0, { progress: 0.5, bend: false }).faces.every(f => !f.bent), 'bend:false keeps fold rigid');

  // Bend tip-offset helper matches the actual bent geometry (used to keep the corner under the finger)
  {
    const p = 0.8;
    const ang = Math.PI * p;
    const bentTip = findUV(c.evaluate(0, { progress: p }).faces, 1, 1);
    const rigidTip = findUV(c.evaluate(0, { progress: p, bend: false }).faces, 1, 1);
    const r = estimateBendRadius(p, Math.PI, Math.SQRT2, 1);
    const off = bendTipOffset(ang, r);
    const u = { x: Math.SQRT1_2, y: Math.SQRT1_2 };
    const pred = { x: rigidTip.x + u.x * off.du, y: rigidTip.y + u.y * off.du, z: rigidTip.z + off.dw };
    assert(dist(pred, bentTip) < 1e-6, `bendTipOffset predicts bent tip (err ${dist(pred, bentTip)})`);
  }

  // Timeline evaluation stays continuous with the bend (face count returns to rigid at t = 1)
  const tl = compilePlanarTimeline({ width: 2, height: 2 }, [diag]);
  assert(tl.evaluate(0, 1).faces.length === tl.finalState.faces.length, 'timeline end matches final state after bending');
  assert(tl.topUnfoldHint && tl.topUnfoldHint.pairs.every(pr => pr.mid && Number.isFinite(pr.mid.z)), 'unfold hint pairs carry mid-arc points');
  const mid = tl.topUnfoldHint.pairs[0].mid;
  assert(mid.z > 0.5, `unfold arc mid-point is lifted above the sheet (z=${mid.z.toFixed(3)})`);

  // Unfold evaluator accepts explicit unfold progress
  const ue = tl.topUnfoldHint.evaluateUnfold(0, { progress: 0.5, bend: false });
  const ueTip = findUV(ue.faces, 1, 1);
  assert(ueTip && Math.abs(ueTip.z - Math.SQRT2) < 1e-6, 'evaluateUnfold progress override lifts tip halfway');

  // Mirror multiFold bends both flaps
  const mf = compilePlanarStep(base, { type: 'multiFold', folds: [
    { p1: [0.2, -1.5], p2: [1.5, -0.2], side: -1, foldType: 'valley', angleDeg: 180 },
    { p1: [-0.2, -1.5], p2: [-1.5, -0.2], side: 1, foldType: 'valley', angleDeg: 180 },
  ] });
  const mfr = mf.evaluate(0, { progress: 0.6 });
  assert(mfr.faces.filter(f => f.bent).length >= 4, 'mirror multiFold bends both flaps');
  console.log('  [OK] Progress override, cylindrical paper bend (near-isometric), tip-offset compensation & unfold arc verified');
}

console.log(`\nSUMMARY: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
