import fs from 'fs';
import { ORIGAMI_CATALOG } from '../src/kinematicModels.js';
import { compilePlanarTimeline, computeSnapPoints } from '../src/planarEngine.js';
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
fs.writeFileSync('/home/antigravity/origami-3d-studio/test/sample_verify.gif', gifBytes);
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

console.log(`\nSUMMARY: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
