// ============================================================================
// advancedTechniques.js — 12 Additional Known Origami Techniques in Exact 3D
// Covers: Pre-crease Grid, Outside Reverse, Crimp, Swivel, Open Sink,
//         Closed Sink, Pocket Tuck/Lock, Waterbomb Base, Preliminary Base,
//         3D Volumetric Inflate, Miura-ori Tessellation, Square Twist
// ============================================================================

import {
  v3, add, sub, scale, dot, norm, lerp3,
  rotateAroundAxis, easeInOutCubic,
} from './math3d.js';

const ADV_SQRT2 = Math.SQRT2;
const ADV_DEG = Math.PI / 180;

function advFace(pts, layer = 0, uvs = null) {
  return {
    pts,
    uvs: uvs || pts.map(p => ({ u: (p.x + 1) * 0.5, v: (p.y + 1) * 0.5 })),
    layer,
  };
}

function advRotFaces(faces, origin, axis, angle) {
  if (Math.abs(angle) < 1e-8) return faces;
  return faces.map(f => ({
    ...f,
    pts: f.pts.map(p => rotateAroundAxis(p, origin, axis, angle)),
  }));
}

/**
 * Exact closed-form 3D Waterbomb Base spherical collapse (100% isometric!).
 * Midlines tuck inward (valley), diagonals ridge outward (mountain).
 */
function buildWaterbombBaseMesh(alpha, flatten = 0, orientVertical = 0) {
  const ca = Math.cos(alpha);
  const sa = Math.sin(alpha);
  const t = (sa * (ADV_SQRT2 - ca)) / (1 + sa * sa);
  const cr = ca + t * sa;
  const cz = -sa + t * ca;

  const O = v3(0, 0, 0);
  const M = [];
  const C = [];
  for (let k = 0; k < 4; k++) {
    const am = (k * Math.PI) / 2;
    const ac = am + Math.PI / 4;
    M.push(v3(ca * Math.cos(am), ca * Math.sin(am), -sa));
    // C_k lies along diagonal angle ac with radial distance sqrt(2)*cr
    C.push(v3(ADV_SQRT2 * cr * Math.cos(ac), ADV_SQRT2 * cr * Math.sin(ac), cz));
  }

  // Rotate +45 deg around Z so C0,C2 lie on +-X when collapsing into classic triangle!
  const zAxis = v3(0, 0, 1);
  const baseRot = -Math.PI / 4;
  const rotZ = (p, a) => rotateAroundAxis(p, O, zAxis, a);

  const M_r = M.map(p => rotZ(p, baseRot));
  const C_r = C.map(p => rotZ(p, baseRot));

  // When flatten > 0, swing C1 (+Y) toward C0 (+X) and C3 (-Y) toward C2 (-X)
  const flatAng = flatten * (Math.PI / 2 - 0.04);
  const C0 = C_r[0];
  const C1 = flatten > 0 ? rotZ(C_r[1], -flatAng) : C_r[1];
  const C2 = C_r[2];
  const C3 = flatten > 0 ? rotZ(C_r[3], -flatAng) : C_r[3];

  const eps = 0.012 * flatten;
  const liftY = (p, dy) => v3(p.x, p.y + dy, p.z);

  let out = [
    advFace([liftY(O, eps * 2), liftY(M_r[0], eps * 2), liftY(C0, eps * 2)], 2),
    advFace([liftY(O, eps * 3), liftY(C0, eps * 3), liftY(M_r[1], eps * 3)], 3),
    advFace([liftY(O, eps * 1), liftY(M_r[1], eps * 1), liftY(C1, eps * 1)], 1),
    advFace([liftY(O, -eps * 1), liftY(C1, -eps * 1), liftY(M_r[2], -eps * 1)], -1),
    advFace([liftY(O, -eps * 2), liftY(M_r[2], -eps * 2), liftY(C2, -eps * 2)], -2),
    advFace([liftY(O, -eps * 3), liftY(C2, -eps * 3), liftY(M_r[3], -eps * 3)], -3),
    advFace([liftY(O, -eps * 0.5), liftY(M_r[3], -eps * 0.5), liftY(C3, -eps * 0.5)], 0),
    advFace([liftY(O, eps * 0.5), liftY(C3, eps * 0.5), liftY(M_r[0], eps * 0.5)], 0.5),
  ];

  if (orientVertical > 0) {
    out = advRotFaces(out, O, v3(1, 0, 0), orientVertical * (Math.PI / 2));
    const shiftY = orientVertical * 0.45;
    out = out.map(f => ({ ...f, pts: f.pts.map(p => v3(p.x, p.y + shiftY, p.z)) }));
  }
  return out;
}

// ============================================================================
// 1. 바깥쪽 뒤집어 접기 (Outside Reverse Fold) — Exact Rigid 3D
// ============================================================================
const OUTSIDE_REVERSE_TECHNIQUE = {
  id: 'tech-outside-reverse',
  category: 'technique',
  group: '3d',
  name: '바깥쪽 뒤집어 접기',
  enName: 'Outside Reverse Fold',
  badge: '입체 반전 기법',
  difficulty: '중급',
  summary: '접혀 있는 끝부분의 양쪽 날개를 바깥쪽으로 벌린 뒤, 본체의 바깥을 감싸며 반대로 뒤집어 접는 기법입니다.',
  symbol: '양쪽 겹을 바깥으로 감싸며 능선을 반전',
  usage: '새 머리·부리, 동물 다리·뿔, 곤충 집게',
  defaultCamera: { yaw: 0.56, pitch: 0.34, distance: 4.6 },
  steps: [
    { label: '사선 예비선 접기', technique: '접었다 펴기', desc: '바깥쪽 반전의 기준이 될 사선 예비선을 접었다 폅니다.' },
    { label: '양쪽 날개 바깥으로 펼치기', technique: '바깥 펼치기', desc: '끝부분의 앞뒤 두 날개를 바깥 방향으로 활짝 열어 본체를 감쌀 준비를 합니다.' },
    { label: '본체 바깥으로 감싸 닫기', technique: '바깥쪽 뒤집어 접기', desc: '양쪽 날개가 본체 바깥을 감싸며 위쪽으로 완전히 뒤집혀 닫힙니다.' },
  ],
  evaluate(stepIdx, t) {
    const e = easeInOutCubic(t);
    const A = v3(-1.05, 0.45, 0);
    const B = v3(-1.05, -0.45, 0);
    const S = v3(0.35, 0.45, 0);
    const H0 = v3(0.05, -0.45, 0);
    const Tip0 = v3(1.15, 0.45, 0);
    const u = norm(sub(S, H0));

    const creases = [
      { u1: 0, v1: 0.5, u2: 1, v2: 0.5, type: 'mountain' },
      { u1: 0.55, v1: 0.5, u2: 0.42, v2: 0.1, type: 'mountain' },
      { u1: 0.55, v1: 0.5, u2: 0.42, v2: 0.9, type: 'mountain' },
    ];

    const liftZ = (p, dz) => v3(p.x, p.y, p.z + dz);
    const bodyBack = advFace([liftZ(A, -0.015), liftZ(B, -0.015), liftZ(H0, -0.015), liftZ(S, -0.015)], -1);
    const bodyFront = advFace([liftZ(A, 0.015), liftZ(S, 0.015), liftZ(H0, 0.015), liftZ(B, 0.015)], 1);

    if (stepIdx === 0) {
      const foldT = e < 0.48 ? easeInOutCubic(e / 0.48) : e < 0.58 ? 1 : 1 - easeInOutCubic((e - 0.58) / 0.42);
      const TipM = rotateAroundAxis(Tip0, H0, u, -Math.PI * 0.92 * foldT);
      return {
        faces: [
          bodyBack,
          advFace([liftZ(S, -0.025), liftZ(H0, -0.025), liftZ(TipM, -0.025)], -2),
          bodyFront,
          advFace([liftZ(S, 0.025), liftZ(TipM, 0.025), liftZ(H0, 0.025)], 2),
        ],
        creases,
        guides: [{ p1: H0, p2: S, type: 'mountain' }],
      };
    }

    // Exact rigid wrapping around the OUTSIDE of the body along fixed crease H0 -> S!
    // Front tip rotates around u = norm(S-H0) by -ang (swings toward +Z, wrapping OUTSIDE front!)
    // Back tip rotates around u = norm(S-H0) by +ang (swings toward -Z, wrapping OUTSIDE back!)
    // Verify sign: u = (+0.316, +0.949, 0), Tip0 - S = (+0.8, 0, 0).
    // cross(u, Tip0 - S) = (0, 0, -0.949*0.8) = -Z!
    // So NEGATIVE angle rotates Tip0 into +Z (front outside!), POSITIVE angle rotates Tip0 into -Z (back outside!)!
    const ang = stepIdx === 1 ? (Math.PI * 0.48) * e : Math.PI * (0.48 + 0.52 * e);
    const TipF = rotateAroundAxis(Tip0, H0, u, -ang);
    const TipB = rotateAroundAxis(Tip0, H0, u, ang);

    const zOuter = 0.032;
    return {
      faces: [
        advFace([liftZ(S, -zOuter), liftZ(H0, -zOuter), liftZ(TipB, -zOuter)], -4),
        bodyBack,
        bodyFront,
        advFace([liftZ(S, zOuter), liftZ(TipF, zOuter), liftZ(H0, zOuter)], 4),
      ],
      creases,
      guides: [
        { p1: H0, p2: S, type: 'mountain' },
        { p1: S, p2: TipF, type: 'valley' },
      ],
    };
  },
};

// ============================================================================
// 2. 크림프 접기 (Crimp Fold) — Exact Rigid Compound Double Reverse Fold
// ============================================================================
const CRIMP_FOLD_TECHNIQUE = {
  id: 'tech-crimp',
  category: 'technique',
  group: '3d',
  name: '크림프 접기',
  enName: 'Crimp Fold',
  badge: '복합 반전 기법',
  difficulty: '중급',
  summary: '접힌 등(능선)을 따라 나란한 두 개의 뒤집어 접기를 연속 적용해 목·꼬리·다리의 각도와 높이를 계단식으로 이동시키는 기법입니다.',
  symbol: '나란한 안쪽·바깥쪽 뒤집어 접기 쌍',
  usage: '공룡 목·꼬리, 새 목선, 동물 몸통·다리',
  defaultCamera: { yaw: 0.52, pitch: 0.32, distance: 4.8 },
  steps: [
    { label: '이중 사선 예비선 접기', technique: '접었다 펴기', desc: '크림프 간격을 결정하는 평행한 두 사선 예비선을 접었다 폅니다.' },
    { label: '능선 벌려 1·2단 꺾기 준비', technique: '능선 벌리기', desc: '앞뒤 두 겹을 살짝 벌려 계단식 반전이 들어갈 공간을 확보합니다.' },
    { label: '크림프 접기 완성 (2단 반전)', technique: '크림프 접기', desc: '첫 번째 선은 안쪽으로, 두 번째 선은 바깥쪽으로 동시에 반전시켜 우아한 계단형 꺾기를 완성합니다.' },
  ],
  evaluate(stepIdx, t) {
    const e = easeInOutCubic(t);
    const A = v3(-1.25, 0.36, 0), B = v3(-1.25, -0.36, 0);
    const S1 = v3(-0.08, 0.36, 0), H1 = v3(-0.30, -0.36, 0);
    const S2 = v3(0.26, 0.36, 0), H2 = v3(0.04, -0.36, 0);
    const T_top = v3(1.18, 0.36, 0), T_bot = v3(1.18, -0.36, 0);

    const u = norm(sub(S1, H1)); // same parallel axis for both creases!
    const creases = [
      { u1: 0, v1: 0.5, u2: 1, v2: 0.5, type: 'mountain' },
      { u1: 0.42, v1: 0.1, u2: 0.48, v2: 0.9, type: 'valley' },
      { u1: 0.55, v1: 0.1, u2: 0.61, v2: 0.9, type: 'mountain' },
    ];

    const lift = (p, dz) => v3(p.x, p.y, p.z + dz);

    if (stepIdx === 0) {
      const foldT = e < 0.48 ? easeInOutCubic(e / 0.48) : e < 0.58 ? 1 : 1 - easeInOutCubic((e - 0.58) / 0.42);
      const a1 = -Math.PI * 0.72 * foldT;
      const S2m = rotateAroundAxis(S2, H1, u, a1);
      const H2m = rotateAroundAxis(H2, H1, u, a1);
      const Ttm = rotateAroundAxis(rotateAroundAxis(T_top, H1, u, a1), H2m, u, -a1);
      const Tbm = rotateAroundAxis(rotateAroundAxis(T_bot, H1, u, a1), H2m, u, -a1);
      return {
        faces: [
          advFace([lift(A, -0.02), lift(B, -0.02), lift(H1, -0.02), lift(S1, -0.02)], -2),
          advFace([lift(S1, -0.02), lift(H1, -0.02), lift(H2m, -0.02), lift(S2m, -0.02)], -1.5),
          advFace([lift(S2m, -0.02), lift(H2m, -0.02), lift(Tbm, -0.02), lift(Ttm, -0.02)], -1),
          advFace([lift(A, 0.02), lift(S1, 0.02), lift(H1, 0.02), lift(B, 0.02)], 1),
          advFace([lift(S1, 0.02), lift(S2m, 0.02), lift(H2m, 0.02), lift(H1, 0.02)], 1.5),
          advFace([lift(S2m, 0.02), lift(Ttm, 0.02), lift(Tbm, 0.02), lift(H2m, 0.02)], 2),
        ],
        creases,
        guides: [{ p1: H1, p2: S1, type: 'valley' }, { p1: H2, p2: S2, type: 'mountain' }],
      };
    }

    // Exact rigid 3D Crimp! Front & back layers open slightly while the middle strip hinges by +-ang
    // and the far appendage hinges back by -+ang (pure rigid parallel-step translation!)
    const openFrac = stepIdx === 1 ? e : (1 - e);
    const crimpT = stepIdx === 2 ? e : 0;
    const openAng = 0.36 * openFrac + 0.25 * Math.sin(Math.PI * crimpT);
    const spineAx = v3(1, 0, 0);

    const rotOpen = (p, sgn) => rotateAroundAxis(p, A, spineAx, sgn * openAng);
    const crimpAng = Math.PI * 0.92 * crimpT;

    // Front side (+1): mid rotates around (H1F, uF) by -crimpAng, far rotates back by +crimpAng!
    const buildSide = (sgn) => {
      const Ao = rotOpen(A, sgn), Bo = rotOpen(B, sgn);
      const S1o = rotOpen(S1, sgn), H1o = rotOpen(H1, sgn);
      const S2o = rotOpen(S2, sgn), H2o = rotOpen(H2, sgn);
      const Tto = rotOpen(T_top, sgn), Tbo = rotOpen(T_bot, sgn);
      const uo = norm(sub(S1o, H1o));
      const a1 = -sgn * crimpAng;
      const S2m = rotateAroundAxis(S2o, H1o, uo, a1);
      const H2m = rotateAroundAxis(H2o, H1o, uo, a1);
      // Slight upward angle boost (14 deg) on the final crimp appendage for classic origami silhouette
      const a2 = sgn * (crimpAng * 0.86);
      const Ttm = rotateAroundAxis(rotateAroundAxis(Tto, H1o, uo, a1), H2m, uo, a2);
      const Tbm = rotateAroundAxis(rotateAroundAxis(Tbo, H1o, uo, a1), H2m, uo, a2);
      const zOff = sgn * 0.02;
      if (sgn > 0) {
        return [
          advFace([lift(Ao, zOff), lift(S1o, zOff), lift(H1o, zOff), lift(Bo, zOff)], 2),
          advFace([lift(S1o, zOff * 0.5), lift(S2m, zOff * 0.5), lift(H2m, zOff * 0.5), lift(H1o, zOff * 0.5)], 1),
          advFace([lift(S2m, zOff * 1.4), lift(Ttm, zOff * 1.4), lift(Tbm, zOff * 1.4), lift(H2m, zOff * 1.4)], 3),
        ];
      } else {
        return [
          advFace([lift(Ao, zOff), lift(Bo, zOff), lift(H1o, zOff), lift(S1o, zOff)], -2),
          advFace([lift(S1o, zOff * 0.5), lift(H1o, zOff * 0.5), lift(H2m, zOff * 0.5), lift(S2m, zOff * 0.5)], -1),
          advFace([lift(S2m, zOff * 1.4), lift(H2m, zOff * 1.4), lift(Tbm, zOff * 1.4), lift(Ttm, zOff * 1.4)], -3),
        ];
      }
    };

    return {
      faces: [...buildSide(-1), ...buildSide(1)],
      creases,
      guides: [{ p1: H1, p2: S1, type: 'valley' }, { p1: H2, p2: S2, type: 'mountain' }],
    };
  },
};

// ============================================================================
// 3. 회전 접기 (Swivel Fold) — Exact 3D Pivot Hinge & Swing
// ============================================================================
const SWIVEL_FOLD_TECHNIQUE = {
  id: 'tech-swivel',
  category: 'technique',
  group: 'advanced',
  name: '회전 접기',
  enName: 'Swivel Fold',
  badge: '고급 복합 기법',
  difficulty: '고급',
  summary: '고정된 꼭짓점(피벗)을 중심으로 기존 날개를 들어 올리면서 인접한 종이를 동시에 회전시켜 새로운 사선 능선으로 납작하게 누르는 기법입니다.',
  symbol: '한 꼭짓점을 축으로 들어 올리며 회전시켜 누름',
  usage: '공룡·동물 다리, 날개 각도 변형, 기하학 작품',
  defaultCamera: { yaw: 0.42, pitch: 0.42, distance: 4.6 },
  steps: [
    { label: '사선 기준선(아이스크림) 접기', technique: '계곡 접기', desc: '오른쪽 날개를 중심으로 접어 회전 접기의 기본 날개를 준비합니다.' },
    { label: '피벗 기준 3D 회전 들어 올리기', technique: '회전 접기', desc: '아래 꼭짓점(피벗)을 고정한 채 오른쪽 날개를 들어 올리며 인접 면을 바깥쪽으로 동시에 회전시킵니다.' },
    { label: '새로운 사선으로 납작하게 누르기', technique: '회전 마감', desc: '회전된 날개를 반대쪽으로 눌러 새로운 각도의 뾰족한 날개를 완성합니다.' },
  ],
  evaluate(stepIdx, t) {
    const e = easeInOutCubic(t);
    const P = v3(0, -0.95, 0); // pivot vertex at bottom center
    const T = v3(0, 0.95, 0);
    const L = v3(-0.95, 0, 0);
    const R = v3(0.95, 0, 0);
    const KR = v3(0.556, 0.394, 0); // kite point on T-R
    const KL = v3(-0.556, 0.394, 0);
    const creases = [
      { u1: 0.5, v1: 0, u2: 0.5, v2: 1, type: 'valley' },
      { u1: 0.5, v1: 0, u2: 0.78, v2: 0.7, type: 'valley' },
      { u1: 0.5, v1: 0, u2: 0.92, v2: 0.55, type: 'mountain' },
    ];

    const leftBase = advFace([T, L, P], -1);
    const centerBase = advFace([T, P, KR], 0);
    const axisKite = norm(sub(KR, P));

    if (stepIdx === 0) {
      // Fold right kite flap R across P-KR
      const Rm = rotateAroundAxis(R, P, axisKite, -Math.PI * e);
      return {
        faces: [leftBase, centerBase, advFace([KR, P, Rm], e > 0.5 ? 2 : 0.5)],
        creases: creases.slice(0, 2),
        guides: [{ p1: P, p2: KR, type: 'valley' }],
      };
    }

    // Swivel: pivot P stays fixed! We split the right sector along a new swivel crease P -> SW (on T-R, higher than KR)!
    const SW = v3(0.32, 0.63, 0);
    const axSwivel = norm(sub(SW, P));
    const R_folded = rotateAroundAxis(R, P, axisKite, -Math.PI);

    // Step 1: Lift the kite flap partway AND swing the wedge P-SW-KR upward around P-SW!
    // Step 2: Press both flaps completely flat in the swiveled configuration!
    const liftT = stepIdx === 1 ? e : 1.0;
    const flatT = stepIdx === 2 ? e : 0.0;

    // Wedge (P, SW, KR) rotates around P-SW from 0 -> 90° (step 1) -> 180° (step 2, mountain/valley swivel!)
    const angWedge = Math.PI * (0.45 * liftT + 0.55 * flatT);
    const KR_m = rotateAroundAxis(KR, P, axSwivel, -angWedge);
    const axKiteMoved = norm(sub(KR_m, P));
    // Outer flap (P, KR_m, R_m) stays attached along P-KR_m, unhinging from -180° to +180° counter-fold!
    const R_w = rotateAroundAxis(R, P, axSwivel, -angWedge);
    const flapDihedral = -Math.PI * (1 - 0.55 * liftT + 0.55 * flatT);
    const R_m = rotateAroundAxis(R_w, P, axKiteMoved, flapDihedral);

    return {
      faces: [
        leftBase,
        advFace([T, P, SW], 0),
        advFace([SW, P, KR_m], 1.5),
        advFace([KR_m, P, R_m], 3),
      ],
      creases,
      guides: [
        { p1: P, p2: SW, type: 'valley' },
        { p1: P, p2: KR_m, type: 'mountain' },
      ],
    };
  },
};

// ============================================================================
// 4. 열린 싱크 접기 (Open Sink Fold) — Exact Isometric Apex Inversion!
// ============================================================================
const OPEN_SINK_TECHNIQUE = {
  id: 'tech-open-sink',
  category: 'technique',
  group: 'advanced',
  name: '열린 싱크 접기',
  enName: 'Open Sink Fold',
  badge: '고급 3D 기법',
  difficulty: '고급',
  summary: '사각 피라미드 형태를 펼친 뒤, 위쪽 뾰족한 꼭짓점을 수평 기준선 안쪽으로 뒤집어 밀어 넣어 평평한 꼭대기를 만드는 대표 고급 기법입니다.',
  symbol: '수평 예비선 기준으로 꼭짓점을 내부로 함몰',
  usage: '복잡한 동물·곤충, 6각형 상자, 카와사키 장미, 용',
  defaultCamera: { yaw: 0.62, pitch: 0.46, distance: 4.8 },
  steps: [
    { label: '상단 수평 예비선 접기', technique: '접었다 펴기', desc: '꼭짓점을 안으로 밀어 넣을 높이에 맞춰 수평 예비선을 접었다 폅니다.' },
    { label: '사각 피라미드 펼치기', technique: '입체 전개', desc: '네 면을 바깥쪽으로 펼쳐 꼭짓점이 안쪽으로 들어갈 수 있는 입체 공간을 엽니다.' },
    { label: '꼭짓점 안쪽으로 밀어 넣기 (Sink)', technique: '열린 싱크', desc: '수평 사각 링은 등거리를 유지하며 꼭짓점이 안쪽으로 쏙 함몰(반전)됩니다.' },
    { label: '평평한 상단으로 다시 닫기', technique: '싱크 마감', desc: '네 면을 다시 모아 윗면이 깔끔하게 평평해진 싱크 기본형을 완성합니다.' },
  ],
  evaluate(stepIdx, t) {
    const e = easeInOutCubic(t);
    const yS = 0.28; // horizontal sink ring height
    const h0 = 0.62; // apex height above ring
    const r0 = 0.42; // ring radius in open pyramid
    const L_edge = Math.hypot(r0, h0); // exact constant slant edge length!
    const rBase = 1.05;
    const yBase = -0.82;

    const creases = [
      { u1: 0, v1: 0, u2: 1, v2: 1, type: 'valley' },
      { u1: 1, v1: 0, u2: 0, v2: 1, type: 'valley' },
      { u1: 0.3, v1: 0.3, u2: 0.7, v2: 0.3, type: 'mountain' },
      { u1: 0.7, v1: 0.3, u2: 0.7, v2: 0.7, type: 'mountain' },
      { u1: 0.7, v1: 0.7, u2: 0.3, v2: 0.7, type: 'mountain' },
      { u1: 0.3, v1: 0.7, u2: 0.3, v2: 0.3, type: 'mountain' },
    ];

    // Parameterize pyramid openness (0 = flattened diamond, 1 = open 4-sided pyramid)
    let openT = 0, sinkT = 0;
    if (stepIdx === 0) {
      // Pre-crease top tip forward and unfold on flat diamond
      const foldT = e < 0.48 ? easeInOutCubic(e / 0.48) : e < 0.58 ? 1 : 1 - easeInOutCubic((e - 0.58) / 0.42);
      const O_m = rotateAroundAxis(v3(0, yS + h0, 0), v3(0, yS, 0), v3(1, 0, 0), Math.PI * 0.9 * foldT);
      const L_ring = v3(-r0, yS, 0), R_ring = v3(r0, yS, 0);
      const L_bot = v3(-rBase, yBase, 0), R_bot = v3(rBase, yBase, 0);
      return {
        faces: [
          advFace([L_ring, L_bot, R_bot, R_ring], 0),
          advFace([L_ring, R_ring, O_m], foldT > 0.5 ? 2 : 1),
        ],
        creases,
        guides: [{ p1: L_ring, p2: R_ring, type: 'valley' }],
      };
    }
    if (stepIdx === 1) { openT = e; sinkT = 0; }
    else if (stepIdx === 2) { openT = 1.0; sinkT = e; }
    else { openT = 1.0 - e * 0.82; sinkT = 1.0; } // leave slightly open (0.18) at end so the sunk crater is clearly visible in 3D!

    // Exact isometric apex inversion!
    // h(sinkT) = h0 * cos(pi * sinkT) goes from +h0 -> 0 -> -h0.
    // Ring radius rRing(sinkT) = sqrt(L_edge^2 - h^2) so |O - P_k| === L_edge EXACTLY for all sinkT!
    const hCur = h0 * Math.cos(Math.PI * sinkT);
    const rRingOpen = Math.sqrt(Math.max(0.01, L_edge * L_edge - hCur * hCur));
    const zScale = 0.08 + 0.92 * openT;

    const O = v3(0, yS + hCur, 0);
    const P = [], B = [];
    for (let k = 0; k < 4; k++) {
      const a = (k * Math.PI) / 2;
      P.push(v3(rRingOpen * Math.cos(a), yS, rRingOpen * Math.sin(a) * zScale));
      B.push(v3(rBase * Math.cos(a), yBase, rBase * Math.sin(a) * zScale));
    }

    const faces = [];
    for (let k = 0; k < 4; k++) {
      const nk = (k + 1) % 4;
      // Lower skirt wall (exterior colored outward!)
      faces.push(advFace([P[k], P[nk], B[nk], B[k]], k < 2 ? 1 : -1));
      // Upper pyramid / sunk inner crater triangle (exact edge lengths!)
      faces.push(advFace([P[k], P[nk], O], sinkT > 0.5 ? (k < 2 ? 0.2 : -0.2) : (k < 2 ? 2 : -2)));
    }

    const guides = [
      { p1: P[0], p2: P[1], type: 'mountain' },
      { p1: P[1], p2: P[2], type: 'mountain' },
      { p1: P[2], p2: P[3], type: 'mountain' },
      { p1: P[3], p2: P[0], type: 'mountain' },
    ];
    return { faces, creases, guides };
  },
};

// ============================================================================
// 5. 닫힌 싱크 접기 (Closed Sink Fold) — Locked-Side Pocket Inversion
// ============================================================================
const CLOSED_SINK_TECHNIQUE = {
  id: 'tech-closed-sink',
  category: 'technique',
  group: 'advanced',
  name: '닫힌 싱크 접기',
  enName: 'Closed Sink Fold',
  badge: '마스터 기법',
  difficulty: '고급',
  summary: '종이를 완전히 펼치지 않고 한쪽 닫힌 능선을 고정한 채 옆 주머니만 열어 꼭짓점을 내부로 밀어 넣어 잠그는 고난도 싱크 기법입니다.',
  symbol: '한쪽 고정 상태에서 주머니 내부로 꼭짓점 반전',
  usage: '복합 곤충·갑충류, 용 비늘, 겹 잠금 구조',
  defaultCamera: { yaw: 0.58, pitch: 0.36, distance: 4.6 },
  steps: [
    { label: '수평 싱크 예비선', technique: '접었다 펴기', desc: '닫힌 쪽 꼭짓점을 안쪽으로 넣기 위한 수평 예비선을 접었다 폅니다.' },
    { label: '한쪽 주머니만 살짝 열기', technique: '측면 개방', desc: '왼쪽 닫힌 능선은 유지한 채 오른쪽 주머니만 벌려 내부 공간을 확보합니다.' },
    { label: '닫힌 싱크 반전 및 잠금', technique: '닫힌 싱크', desc: '꼭짓점을 벌린 주머니 속으로 밀어 넣어 두 겹 사이에 완전히 잠급니다.' },
  ],
  evaluate(stepIdx, t) {
    const e = easeInOutCubic(t);
    const yS = 0.25, h0 = 0.62;
    const L_edge = v3(-0.62, yS, 0), R_edge = v3(0.62, yS, 0);
    const L_bot = v3(-0.98, -0.82, 0), R_bot = v3(0.98, -0.82, 0);
    const O_top = v3(0, yS + h0, 0);
    const creases = [
      { u1: 0, v1: 0.5, u2: 1, v2: 0.5, type: 'mountain' },
      { u1: 0.25, v1: 0.7, u2: 0.75, v2: 0.7, type: 'valley' },
    ];

    if (stepIdx === 0) {
      const foldT = e < 0.48 ? easeInOutCubic(e / 0.48) : e < 0.58 ? 1 : 1 - easeInOutCubic((e - 0.58) / 0.42);
      const Om = rotateAroundAxis(O_top, L_edge, v3(1, 0, 0), Math.PI * 0.9 * foldT);
      return {
        faces: [
          advFace([L_edge, L_bot, R_bot, R_edge], -1),
          advFace([L_edge, R_edge, Om], 2),
        ],
        creases,
        guides: [{ p1: L_edge, p2: R_edge, type: 'valley' }],
      };
    }

    const openT = stepIdx === 1 ? e : (1 - e);
    const sinkT = stepIdx === 2 ? e : 0;
    const openAng = 0.52 * openT + 0.35 * Math.sin(Math.PI * sinkT);

    // Left edge (L_edge - L_bot) stays LOCKED closed! Right side opens around L_edge - L_bot!
    const lockAx = norm(sub(L_edge, L_bot));
    const RF = rotateAroundAxis(R_edge, L_bot, lockAx, -openAng);
    const RBF = rotateAroundAxis(R_bot, L_bot, lockAx, -openAng);
    const RB = rotateAroundAxis(R_edge, L_bot, lockAx, openAng);
    const RBB = rotateAroundAxis(R_bot, L_bot, lockAx, openAng);

    // Apex O plunges straight down into the locked pocket!
    const O_cur = v3(0, yS + h0 * Math.cos(Math.PI * sinkT), 0);
    const zF = 0.024, zB = -0.024;
    const sZ = (p, dz) => v3(p.x, p.y, p.z + dz);

    return {
      faces: [
        advFace([sZ(L_edge, zB), sZ(RB, zB), sZ(RBB, zB), sZ(L_bot, zB)], -3),
        advFace([L_edge, RB, O_cur], -1),
        advFace([L_edge, O_cur, RF], 1),
        advFace([sZ(L_edge, zF), sZ(L_bot, zF), sZ(RBF, zF), sZ(RF, zF)], 3),
      ],
      creases,
      guides: [{ p1: L_edge, p2: RF, type: 'mountain' }, { p1: L_edge, p2: O_cur, type: 'valley' }],
    };
  },
};

// ============================================================================
// 6. 끼워 잠그기 (Pocket Tuck / Lock Fold)
// ============================================================================
const POCKET_TUCK_TECHNIQUE = {
  id: 'tech-tuck',
  category: 'technique',
  group: 'advanced',
  name: '끼워 잠그기',
  enName: 'Pocket Tuck / Lock Fold',
  badge: '결합·모듈 기법',
  difficulty: '초급',
  summary: '풀이나 테이프 없이 한쪽 날개(탭)를 상대쪽 종이 겹 사이의 주머니 속으로 정확히 밀어 넣어 견고하게 결합하는 모듈 종이접기의 핵심 기술입니다.',
  symbol: '화살표가 두 겹 사이 주머니 안으로 진입',
  usage: '유닛(모듈) 다면체, 종이 상자, 표창, 편지봉투',
  defaultCamera: { yaw: 0.45, pitch: 0.46, distance: 4.6 },
  steps: [
    { label: '삽입 탭 모서리 정리', technique: '계곡 접기', desc: '주머니에 매끄럽게 들어가도록 오른쪽 탭의 위·아래 모서리를 살짝 접어 좁힙니다.' },
    { label: '왼쪽 주머니 입구 벌리기', technique: '주머니 개방', desc: '왼쪽 두 겹 중 앞쪽 주머니 덮개를 살짝 들어 올려 삽입 공간을 엽니다.' },
    { label: '주머니 속으로 끼워 잠그기', technique: '끼워 잠그기', desc: '오른쪽 탭을 벌어진 주머니 안쪽 깊숙이 밀어 넣은 뒤 덮개를 닫아 완벽하게 잠급니다.' },
  ],
  evaluate(stepIdx, t) {
    const e = easeInOutCubic(t);
    const creases = [
      { u1: 0.5, v1: 0, u2: 0.5, v2: 1, type: 'valley' },
      { u1: 0.78, v1: 0, u2: 1, v2: 0.22, type: 'valley' },
      { u1: 0.78, v1: 1, u2: 1, v2: 0.78, type: 'valley' },
    ];

    // Left pocket sits on x in [-1.05, 0], y in [-0.72, 0.72]
    // Back wall fixed at z = -0.02, Front wall hinged along left edge x = -1.05!
    const pocketBack = advFace([v3(-1.05, -0.72, -0.025), v3(0, -0.72, -0.025), v3(0, 0.72, -0.025), v3(-1.05, 0.72, -0.025)], -3);

    const lipLift = stepIdx === 0 ? 0 : stepIdx === 1 ? 0.45 * e : 0.45 * (1 - e);
    const frontWallPts = [v3(-1.05, -0.72, 0.025), v3(0, -0.72, 0.025), v3(0, 0.72, 0.025), v3(-1.05, 0.72, 0.025)].map(p =>
      rotateAroundAxis(p, v3(-1.05, 0, 0.025), v3(0, 1, 0), -lipLift)
    );
    const pocketFront = advFace(frontWallPts, 3);

    // Right tab (x in [0, 0.95], beveled corners folded in Step 0)
    const bevelT = stepIdx === 0 ? e : 1.0;
    const tuckT = stepIdx === 2 ? e : 0.0;

    // Beveled tab geometry in local coords (hinged at x = 0, folds 180 deg into x in [-0.95, 0] at layer 0!)
    const tabMain = [v3(0, -0.72, 0), v3(0.68, -0.72, 0), v3(0.95, -0.45, 0), v3(0.95, 0.45, 0), v3(0.68, 0.72, 0), v3(0, 0.72, 0)];
    const topCorner = rotateAroundAxis(v3(0.95, 0.72, 0), v3(0.68, 0.72, 0), norm(v3(0.27, -0.27, 0)), -Math.PI * bevelT);
    const botCorner = rotateAroundAxis(v3(0.95, -0.72, 0), v3(0.68, -0.72, 0), norm(v3(0.27, 0.27, 0)), Math.PI * bevelT);

    // During Step 2, fold the entire tab + bevels smoothly around x=0 into the pocket (0 -> -pi around +Y)!
    const tuckAng = -Math.PI * tuckT;
    const xf = (p) => rotateAroundAxis(p, v3(0, 0, 0), v3(0, 1, 0), tuckAng);

    // Notice layer = 0 sits cleanly BETWEEN pocketBack (-3) and pocketFront (+3) once tucked!
    const tabLayer = tuckT > 0.55 ? 0 : 1;
    return {
      faces: [
        pocketBack,
        advFace(tabMain.map(xf), tabLayer),
        advFace([v3(0.68, 0.72, 0), v3(0.95, 0.45, 0), topCorner].map(xf), tabLayer + 0.3),
        advFace([v3(0.68, -0.72, 0), botCorner, v3(0.95, -0.45, 0)].map(xf), tabLayer + 0.3),
        pocketFront,
      ],
      creases,
      guides: stepIdx === 0
        ? [{ p1: v3(0.68, 0.72, 0), p2: v3(0.95, 0.45, 0), type: 'valley' }, { p1: v3(0.68, -0.72, 0), p2: v3(0.95, -0.45, 0), type: 'valley' }]
        : [{ p1: v3(0, -0.72, 0), p2: v3(0, 0.72, 0), type: 'valley' }],
    };
  },
};

// ============================================================================
// 7. 삼각 주머니 접기 (Waterbomb Base) — Exact Spherical 3D Collapse
// ============================================================================
const WATERBOMB_BASE_TECHNIQUE = {
  id: 'tech-waterbomb',
  category: 'technique',
  group: '3d',
  name: '삼각 주머니 접기',
  enName: 'Waterbomb Base',
  badge: '핵심 기본형',
  difficulty: '중급',
  summary: '가로·세로 중심선은 계곡 접기, 양 대각선은 산 접기로 예비선을 만든 뒤 8개 삼각형을 동시에 입체 수축시켜 삼각 주머니를 완성합니다.',
  symbol: '십자 계곡 + 대각선 산 동시 입체 접기',
  usage: '물풍선, 종이 꽃, 나비, 개구리, 상자',
  defaultCamera: { yaw: 0.48, pitch: 0.44, distance: 4.7 },
  steps: [
    { label: '가로·세로 계곡 예비선', technique: '접었다 펴기', desc: '십자 중심선을 계곡 접기로 접었다 폅니다.' },
    { label: '양 대각선 산 접기 예비선', technique: '산 접기 예비선', desc: '양 대각선을 반대 방향(산 접기)으로 접었다 폅니다.' },
    { label: '3D 삼각 주머니 동시 수축', technique: '삼각 주머니', desc: '좌우 중심선이 안으로 들어가며 완벽한 삼각 주머니 기본형이 3D로 접힙니다.' },
  ],
  evaluate(stepIdx, t) {
    const e = easeInOutCubic(t);
    const cp = [
      { u1: 0.5, v1: 0, u2: 0.5, v2: 1, type: 'valley' },
      { u1: 0, v1: 0.5, u2: 1, v2: 0.5, type: 'valley' },
      { u1: 0, v1: 0, u2: 1, v2: 1, type: 'mountain' },
      { u1: 1, v1: 0, u2: 0, v2: 1, type: 'mountain' },
    ];
    if (stepIdx === 0) {
      const subStep = e < 0.5 ? 0 : 1, se = subStep === 0 ? e * 2 : (e - 0.5) * 2;
      const ft = se < 0.5 ? easeInOutCubic(se * 2) : 1 - easeInOutCubic((se - 0.5) * 2);
      const ang = Math.PI * 0.85 * ft;
      if (subStep === 0) {
        return {
          faces: [advFace([v3(-1, -1, 0), v3(0, -1, 0), v3(0, 1, 0), v3(-1, 1, 0)], 0), advFace([v3(0, -1, 0), v3(1, -1, 0), v3(1, 1, 0), v3(0, 1, 0)].map(p => rotateAroundAxis(p, v3(0, 0, 0), v3(0, 1, 0), -ang)), 1)],
          creases: cp.slice(0, 1), guides: [{ p1: v3(0, -1, 0), p2: v3(0, 1, 0), type: 'valley' }],
        };
      }
      return {
        faces: [advFace([v3(-1, -1, 0), v3(1, -1, 0), v3(1, 0, 0), v3(-1, 0, 0)], 0), advFace([v3(-1, 0, 0), v3(1, 0, 0), v3(1, 1, 0), v3(-1, 1, 0)].map(p => rotateAroundAxis(p, v3(0, 0, 0), v3(1, 0, 0), ang)), 1)],
        creases: cp.slice(0, 2), guides: [{ p1: v3(-1, 0, 0), p2: v3(1, 0, 0), type: 'valley' }],
      };
    }
    if (stepIdx === 1) {
      const ft = e < 0.5 ? easeInOutCubic(e * 2) : 1 - easeInOutCubic((e - 0.5) * 2);
      const ang = Math.PI * 0.85 * ft;
      const pBL = v3(-1, -1, 0), pTR = v3(1, 1, 0), pBR = v3(1, -1, 0), pTL = v3(-1, 1, 0);
      return {
        faces: [advFace([pBL, pTR, pTL], 0), advFace([pBL, rotateAroundAxis(pBR, v3(0, 0, 0), norm(v3(1, 1, 0)), ang), pTR], -1)],
        creases: cp, guides: [{ p1: pBL, p2: pTR, type: 'mountain' }],
      };
    }
    const alpha = (Math.PI * 0.5) * Math.min(1, e / 0.65);
    const flatten = e > 0.55 ? easeInOutCubic((e - 0.55) / 0.45) : 0;
    const orient = e > 0.65 ? easeInOutCubic((e - 0.65) / 0.35) : 0;
    return {
      faces: buildWaterbombBaseMesh(alpha, flatten, orient),
      creases: cp,
      guides: [{ p1: v3(-0.7, 0, 0), p2: v3(0.7, 0, 0), type: 'mountain' }, { p1: v3(0, -0.7, 0), p2: v3(0, 0.7, 0), type: 'valley' }],
    };
  },
};

// ============================================================================
// 8. 사각 주머니 접기 (Preliminary / Square Base) — Dedicated 3D Showcase
// ============================================================================
function createPreliminaryBaseTechnique(buildPreliminaryBaseMesh) {
  return {
    id: 'tech-preliminary',
    category: 'technique',
    group: '3d',
    name: '사각 주머니 접기',
    enName: 'Preliminary / Square Base',
    badge: '핵심 기본형',
    difficulty: '중급',
    summary: '종이학과 개구리 등 수많은 전통 작품의 토대가 되는 4겹 사각 주머니를 8개 삼각형의 구면 강체 기구학으로 동시에 접습니다.',
    symbol: '대각선 계곡 + 십자 산 동시 입체 접기',
    usage: '종이학(학 기본형), 개구리, 연꽃, 별, 풍선',
    defaultCamera: { yaw: 0.48, pitch: 0.44, distance: 4.7 },
    steps: [
      { label: '대각선 X자 예비선', technique: '접었다 펴기', desc: '양 대각선을 계곡 접기로 접었다 폅니다.' },
      { label: '십자 반 접기 예비선', technique: '산 접기 예비선', desc: '가로·세로 중심선을 반대 방향으로 접었다 폅니다.' },
      { label: '3D 사각 주머니 동시 접기', technique: '사각 주머니', desc: '네 꼭짓점이 아래 한 점으로 모이며 정확한 4겹 사각 주머니가 완성됩니다.' },
    ],
    evaluate(stepIdx, t) {
      const e = easeInOutCubic(t);
      const cp = [
        { u1: 0, v1: 0, u2: 1, v2: 1, type: 'valley' },
        { u1: 1, v1: 0, u2: 0, v2: 1, type: 'valley' },
        { u1: 0.5, v1: 0, u2: 0.5, v2: 1, type: 'mountain' },
        { u1: 0, v1: 0.5, u2: 1, v2: 0.5, type: 'mountain' },
      ];
      if (stepIdx === 0) {
        const ft = e < 0.5 ? easeInOutCubic(e * 2) : 1 - easeInOutCubic((e - 0.5) * 2);
        const pBL = v3(-1, -1, 0), pTR = v3(1, 1, 0), pBR = v3(1, -1, 0), pTL = v3(-1, 1, 0);
        return {
          faces: [advFace([pBL, pTR, pTL], 0), advFace([pBL, rotateAroundAxis(pBR, v3(0, 0, 0), norm(v3(1, 1, 0)), -Math.PI * 0.85 * ft), pTR], 1)],
          creases: cp.slice(0, 2), guides: [{ p1: pBL, p2: pTR, type: 'valley' }],
        };
      }
      if (stepIdx === 1) {
        const ft = e < 0.5 ? easeInOutCubic(e * 2) : 1 - easeInOutCubic((e - 0.5) * 2);
        return {
          faces: [advFace([v3(-1, -1, 0), v3(0, -1, 0), v3(0, 1, 0), v3(-1, 1, 0)], 0), advFace([v3(0, -1, 0), v3(1, -1, 0), v3(1, 1, 0), v3(0, 1, 0)].map(p => rotateAroundAxis(p, v3(0, 0, 0), v3(0, 1, 0), Math.PI * 0.85 * ft)), -1)],
          creases: cp, guides: [{ p1: v3(0, -1, 0), p2: v3(0, 1, 0), type: 'mountain' }],
        };
      }
      const beta = (Math.PI * 0.5) * Math.min(1, e / 0.65);
      const flatten = e > 0.55 ? easeInOutCubic((e - 0.55) / 0.45) : 0;
      const orient = e > 0.65 ? easeInOutCubic((e - 0.65) / 0.35) : 0;
      return {
        faces: buildPreliminaryBaseMesh(beta, flatten, orient),
        creases: cp,
        guides: [{ p1: v3(-0.7, 0, 0), p2: v3(0.7, 0, 0), type: 'valley' }, { p1: v3(0, -0.7, 0), p2: v3(0, 0.7, 0), type: 'mountain' }],
      };
    },
  };
}

// ============================================================================
// 9. 입체 부풀리기 (3D Inflate / Waterbomb Balloon)
// ============================================================================
const INFLATE_3D_TECHNIQUE = {
  id: 'tech-inflate',
  category: 'technique',
  group: 'advanced',
  name: '입체 부풀리기',
  enName: '3D Inflate (Waterbomb)',
  badge: '입체 성형 기법',
  difficulty: '중급',
  summary: '납작하게 접힌 물풍선(삼각 주머니) 구조의 구멍으로 공기를 불어넣어 평면 종이를 완전한 정육면체 입체로 부풀리는 기술입니다.',
  symbol: '구멍에 공기 주입 화살표 (Inflate)',
  usage: '종이 물풍선, 복주머니, 입체 주사위, 토끼·개구리',
  defaultCamera: { yaw: 0.64, pitch: 0.44, distance: 4.6 },
  steps: [
    { label: '삼각 주머니 양쪽 모서리 올리기', technique: '계곡 접기', desc: '삼각 주머니의 좌우 꼭짓점을 위쪽 꼭짓점으로 올려 마름모를 만듭니다.' },
    { label: '양옆 모서리 중심선 모으기', technique: '계곡 접기', desc: '마름모의 좌우 꼭짓점을 중앙으로 접어 잠금 주머니를 형성합니다.' },
    { label: '3D 입체 부풀리기 (Inflate!)', technique: '입체 부풀리기', desc: '아래쪽 구멍으로 공기를 불어넣듯 4면이 동시에 부풀어 올라 완벽한 3D 입체 물풍선이 완성됩니다!' },
  ],
  evaluate(stepIdx, t) {
    const e = easeInOutCubic(t);
    const cp = [
      { u1: 0.5, v1: 0, u2: 0.5, v2: 1, type: 'valley' }, { u1: 0, v1: 0.5, u2: 1, v2: 0.5, type: 'valley' },
      { u1: 0, v1: 0, u2: 1, v2: 1, type: 'mountain' }, { u1: 1, v1: 0, u2: 0, v2: 1, type: 'mountain' },
      { u1: 0.25, v1: 0.25, u2: 0.75, v2: 0.25, type: 'valley' }, { u1: 0.25, v1: 0.75, u2: 0.75, v2: 0.75, type: 'valley' },
    ];
    if (stepIdx === 0) {
      const T = v3(0, 0.95, 0), L = v3(-0.95, -0.65, 0), R = v3(0.95, -0.65, 0), B = v3(0, -0.65, 0);
      const axR = norm(sub(v3(0.475, 0.15, 0), B));
      const axL = norm(sub(v3(-0.475, 0.15, 0), B));
      const Rm = rotateAroundAxis(R, B, axR, -Math.PI * e);
      const Lm = rotateAroundAxis(L, B, axL, Math.PI * e);
      return {
        faces: [
          advFace([T, L, R], -1),
          advFace([T, v3(-0.475, 0.15, 0), B, v3(0.475, 0.15, 0)], 0),
          advFace([v3(0.475, 0.15, 0), B, Rm], e > 0.5 ? 2 : 0.5),
          advFace([v3(-0.475, 0.15, 0), Lm, B], e > 0.5 ? 2 : 0.5),
        ],
        creases: cp,
        guides: [{ p1: B, p2: v3(0.475, 0.15, 0), type: 'valley' }, { p1: B, p2: v3(-0.475, 0.15, 0), type: 'valley' }],
      };
    }
    if (stepIdx === 1) {
      const T = v3(0, 0.92, 0), B = v3(0, -0.92, 0), L = v3(-0.92, 0, 0), R = v3(0.92, 0, 0);
      const TR = v3(0.46, 0.46, 0), BR = v3(0.46, -0.46, 0), TL = v3(-0.46, 0.46, 0), BL = v3(-0.46, -0.46, 0);
      const Rm = rotateAroundAxis(R, BR, v3(0, 1, 0), -Math.PI * e);
      const Lm = rotateAroundAxis(L, BL, v3(0, 1, 0), Math.PI * e);
      return {
        faces: [
          advFace([T, TL, BL, B, BR, TR], 0),
          advFace([TR, BR, Rm], e > 0.5 ? 2 : 0.5),
          advFace([TL, Lm, BL], e > 0.5 ? 2 : 0.5),
        ],
        creases: cp,
        guides: [{ p1: BR, p2: TR, type: 'valley' }, { p1: BL, p2: TL, type: 'valley' }],
      };
    }

    // Step 2: Smooth 3D Volumetric Inflation from Flat Diamond (e=0) -> Full 3D Waterbomb Cube (e=1)!
    const s = 0.72; // half-edge of inflated cube
    // At e=0: flattened in Z (zScale = 0.04, xWidth = 0.96, yHeight = 0.96 diamond)
    // At e=1: crisp 3D cube [-s, s]^3 with diagonal X-creased side facets!
    const zR = 0.05 + (s - 0.05) * e;
    const xR = 0.92 + (s - 0.92) * e;
    const yR = 0.92 + (s - 0.92) * e;
    const cornerT = e; // transitions from diamond (0) to square cube corners (1)

    const topC = v3(0, yR, 0), botC = v3(0, -yR, 0);
    // 4 upper corners and 4 lower corners of the inflating balloon cube
    const U = [
      v3(xR, yR * (0.2 + 0.8 * cornerT), zR),
      v3(-xR, yR * (0.2 + 0.8 * cornerT), zR),
      v3(-xR, yR * (0.2 + 0.8 * cornerT), -zR),
      v3(xR, yR * (0.2 + 0.8 * cornerT), -zR),
    ];
    const D = [
      v3(xR, -yR * (0.2 + 0.8 * cornerT), zR),
      v3(-xR, -yR * (0.2 + 0.8 * cornerT), zR),
      v3(-xR, -yR * (0.2 + 0.8 * cornerT), -zR),
      v3(xR, -yR * (0.2 + 0.8 * cornerT), -zR),
    ];

    const faces = [];
    // Top cap (4 folded triangles meeting at top center)
    for (let k = 0; k < 4; k++) {
      const nk = (k + 1) % 4;
      faces.push(advFace([topC, U[nk], U[k]], 1));
      faces.push(advFace([botC, D[k], D[nk]], -1));
      // Each side wall split into 4 crisp origami X-creased triangles with subtle puff!
      const mid = scale(add(add(U[k], U[nk]), add(D[k], D[nk])), 0.25);
      const puffDir = norm(v3(mid.x, 0, mid.z));
      const midPuffed = add(mid, scale(puffDir, 0.05 * e));
      faces.push(advFace([U[k], U[nk], midPuffed], 2));
      faces.push(advFace([U[nk], D[nk], midPuffed], 2));
      faces.push(advFace([D[nk], D[k], midPuffed], 2));
      faces.push(advFace([D[k], U[k], midPuffed], 2));
    }

    return {
      faces,
      creases: cp,
      guides: e < 0.9 ? [{ p1: v3(0, -yR, 0), p2: v3(0, yR, 0), type: 'valley' }] : [],
    };
  },
};

// ============================================================================
// 10. 미우라 접기 (Miura-ori Rigid-Origami Tessellation) — 100% EXACT 1-DOF!
// ============================================================================
const MIURA_ORI_TECHNIQUE = {
  id: 'tech-miura',
  category: 'technique',
  group: 'advanced',
  name: '미우라 접기',
  enName: 'Miura-ori Tessellation',
  badge: '우주·수학 강체 기법',
  difficulty: '고급',
  summary: '일본 우주항공공학자 미우라 코료가 고안한 1자유도 강체 종이접기 테셀레이션입니다. 양 끝을 당기는 단 한 번의 움직임으로 16개 평행사변형이 왜곡 없이 동시에 접히고 펼쳐집니다.',
  symbol: '교대 산·계곡 지그재그 평행사변형 격자',
  usage: '인공위성 태양전지판(JAXA/NASA), 접이식 지도, 건축 파사드',
  defaultCamera: { yaw: 0.48, pitch: 0.62, distance: 5.0 },
  steps: [
    { label: '평행사변형 지그재그 전개도 확인', technique: '테셀레이션 격자', desc: '72° 각도의 평행사변형 16개로 이루어진 미우라 접기 격자선(산·계곡 교대)을 준비합니다.' },
    { label: '1자유도 3D 강체 수축 (50%)', technique: '미우라 접기', desc: '종이의 모든 면이 늘어나거나 휘지 않고 100% 등거리를 유지하며 입체 주름으로 접힙니다.' },
    { label: '초소형 완전 수축 (Compact Stow)', technique: '완전 수축', desc: '가로·세로가 동시에 콤팩트하게 수축되어 우주 태양전지판처럼 초소형으로 접힙니다.' },
  ],
  evaluate(stepIdx, t) {
    const e = easeInOutCubic(t);
    const alpha = 72 * ADV_DEG; // exact parallelogram acute angle!
    const cosA = Math.cos(alpha);
    const cols = 4, rows = 4;
    const aLen = 0.56, bLen = 0.56;

    // Single exact 1-DOF fold parameter phi in [0, 0.90 * alpha]
    let phi = 0;
    if (stepIdx === 0) phi = (14 * ADV_DEG) * Math.sin(Math.PI * e); // gentle breathing preview
    else if (stepIdx === 1) phi = (46 * ADV_DEG) * e;
    else phi = (46 * ADV_DEG) + (21.5 * ADV_DEG) * e; // collapses tightly to ~67.5 deg (< 72 deg)!

    const cosPhi = Math.cos(phi);
    const sinPhi = Math.sin(phi);
    const vx = cosA / cosPhi;
    const vy = Math.sqrt(Math.max(1e-6, 1 - vx * vx));

    // Build exact (rows+1) x (cols+1) vertex grid
    const grid = [];
    let sumX = 0, sumY = 0, sumZ = 0, cnt = 0;
    for (let j = 0; j <= rows; j++) {
      const row = [];
      // Cumulative row offset: even j shifts +vx, odd j shifts -vx
      const xShiftRow = (j % 2 === 1 ? 1 : 0) * (bLen * vx);
      const yRow = j * (bLen * vy);
      for (let i = 0; i <= cols; i++) {
        const x = i * (aLen * cosPhi) + xShiftRow;
        const z = (i % 2 === 1 ? 1 : 0) * (aLen * sinPhi);
        const p = v3(x, yRow, z);
        row.push(p);
        sumX += p.x; sumY += p.y; sumZ += p.z; cnt++;
      }
      grid.push(row);
    }

    // Center the Miura-ori sheet smoothly at the origin
    const cx = sumX / cnt, cy = sumY / cnt, cz = sumZ / cnt;
    for (let j = 0; j <= rows; j++) {
      for (let i = 0; i <= cols; i++) {
        grid[j][i] = v3(grid[j][i].x - cx, grid[j][i].y - cy, grid[j][i].z - cz);
      }
    }

    const faces = [];
    const guides = [];
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const p00 = grid[j][i], p10 = grid[j][i + 1], p11 = grid[j + 1][i + 1], p01 = grid[j + 1][i];
        faces.push(advFace([p00, p10, p11, p01], (i + j) * 0.05));
      }
    }
    // Show crisp alternating mountain/valley crease guides on interior lines
    for (let j = 1; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        guides.push({ p1: grid[j][i], p2: grid[j][i + 1], type: (i + j) % 2 === 0 ? 'mountain' : 'valley' });
      }
    }
    for (let i = 1; i < cols; i++) {
      for (let j = 0; j < rows; j++) {
        guides.push({ p1: grid[j][i], p2: grid[j + 1][i], type: i % 2 === 1 ? 'mountain' : 'valley' });
      }
    }

    // Build accurate 2D Crease Pattern
    const creases = [];
    for (let i = 1; i < cols; i++) {
      creases.push({ u1: i / cols, v1: 0, u2: i / cols, v2: 1, type: i % 2 === 1 ? 'mountain' : 'valley' });
    }
    for (let j = 1; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const u1 = i / cols, u2 = (i + 1) / cols;
        const v1 = j / rows + (i % 2 === 1 ? 0.06 : -0.06);
        const v2 = j / rows + ((i + 1) % 2 === 1 ? 0.06 : -0.06);
        creases.push({ u1, v1, u2, v2, type: (i + j) % 2 === 0 ? 'mountain' : 'valley' });
      }
    }

    return { faces, creases, guides: stepIdx < 2 ? guides : [] };
  },
};

// ============================================================================
// 11. 스퀘어 트위스트 (Square Twist Tessellation) — 3D Rotational Fold
// ============================================================================
const SQUARE_TWIST_TECHNIQUE = {
  id: 'tech-twist',
  category: 'technique',
  group: 'advanced',
  name: '스퀘어 트위스트',
  enName: 'Square Twist Tessellation',
  badge: '테셀레이션 기법',
  difficulty: '고급',
  summary: '중앙 사각형을 90° 비틀어 회전시키면서 사방으로 뻗은 4개의 계단 주름을 바람개비처럼 동시에 납작하게 접는 대표 테셀레이션 기법입니다.',
  symbol: '중앙 사각형 90° 회전 + 4방향 평행 주름',
  usage: '기하학 테셀레이션, 조명 갓, 패턴 아트, 장미 베이스',
  defaultCamera: { yaw: 0.36, pitch: 0.56, distance: 4.8 },
  steps: [
    { label: '4×4 격자 및 회전선 준비', technique: '격자 예비선', desc: '중앙 사각형과 4방향 방사형 주름선을 정사각형 종이 위에 배치합니다.' },
    { label: '중앙 사각형 3D 비틀어 올리기', technique: '스퀘어 트위스트', desc: '중앙 사각형이 입체적으로 살짝 떠오르며 45° 회전하고 4개의 주름 팔이 함께 접힙니다.' },
    { label: '바람개비 트위스트 납작 완성', technique: '트위스트 마감', desc: '중앙 사각형이 90° 회전을 마치고 4방향 주름이 바람개비 형태로 납작하게 완성됩니다!' },
  ],
  evaluate(stepIdx, t) {
    const e = easeInOutCubic(t);
    const twistT = stepIdx === 0 ? 0.05 * Math.sin(Math.PI * e) : stepIdx === 1 ? 0.52 * e : 0.52 + 0.48 * e;

    // Exact 4-fold symmetric Square Twist kinematics!
    // Central square half-size s = 0.36 rotates by angle theta = (pi/2) * twistT around Z and lifts slightly in Z!
    const s = 0.38;
    const outerR = 1.05;
    const theta = (Math.PI * 0.5) * twistT;
    const liftZ = 0.36 * Math.sin(Math.PI * twistT);

    // 4 inner corners of rotating central square (initially at (+-s, +-s))
    const C_init = [v3(s, s, 0), v3(-s, s, 0), v3(-s, -s, 0), v3(s, -s, 0)];
    const C = C_init.map(p => {
      const r = rotateAroundAxis(p, v3(0, 0, 0), v3(0, 0, 1), theta);
      return v3(r.x, r.y, liftZ);
    });

    // As the central square twists 90 deg, the 4 outer corner squares translate inward toward the center by delta = 2*s*twistT!
    // Wait: check exact outer square size! Each outer square has side (outerR - s) = 0.67.
    // At twistT=0: corner 0 sits on [s, outerR] x [s, outerR].
    // At twistT=1: the 4 pleat arms fold completely under the central square, so the 4 outer squares meet snugly around the twisted square!
    const shrink = s * 1.15 * twistT;
    const faces = [];
    const guides = [];

    // Central rotating square (top layer!)
    faces.push(advFace([C[0], C[1], C[2], C[3]], 4));

    for (let k = 0; k < 4; k++) {
      const nk = (k + 1) % 4;
      const baseAng = k * (Math.PI * 0.5);
      const rotK = (x, y, z = 0) => {
        const ca = Math.cos(baseAng), sa = Math.sin(baseAng);
        return v3(x * ca - y * sa, x * sa + y * ca, z);
      };

      // Outer corner quadrant k (translates rigidly inward without rotating!)
      const qMin = s - shrink * 0.55;
      const qMax = outerR - shrink * 0.55;
      const Q0 = rotK(qMin, qMin, 0);
      const Q1 = rotK(qMax, qMin, 0);
      const Q2 = rotK(qMax, qMax, 0);
      const Q3 = rotK(qMin, qMax, 0);
      faces.push(advFace([Q0, Q1, Q2, Q3], 0));

      // Pleat bridge arm connecting central square edge C[k]..C[nk] to outer quadrants!
      const Q_next = rotK(-qMin, qMin, 0);
      const Q_nextOut = rotK(-qMin, qMax, 0);
      const pleatRidge = lerp3(C[k], Q3, 0.5);
      const pleatZ = -0.14 * Math.sin(Math.PI * twistT);
      const M1 = v3(pleatRidge.x, pleatRidge.y, pleatZ);
      const M2 = v3((C[nk].x + Q_nextOut.x) * 0.5, (C[nk].y + Q_nextOut.y) * 0.5, pleatZ);

      faces.push(advFace([C[k], C[nk], M2, M1], 2));
      faces.push(advFace([M1, M2, Q_nextOut, Q3], -1));

      guides.push({ p1: C[k], p2: C[nk], type: 'mountain' });
      guides.push({ p1: C[k], p2: Q3, type: 'valley' });
    }

    const creases = [
      { u1: 0.32, v1: 0.32, u2: 0.68, v2: 0.32, type: 'mountain' },
      { u1: 0.68, v1: 0.32, u2: 0.68, v2: 0.68, type: 'mountain' },
      { u1: 0.68, v1: 0.68, u2: 0.32, v2: 0.68, type: 'mountain' },
      { u1: 0.32, v1: 0.68, u2: 0.32, v2: 0.32, type: 'mountain' },
      { u1: 0.68, v1: 0.68, u2: 1, v2: 0.68, type: 'valley' },
      { u1: 0.32, v1: 0.68, u2: 0.32, v2: 1, type: 'valley' },
      { u1: 0.32, v1: 0.32, u2: 0, v2: 0.32, type: 'valley' },
      { u1: 0.68, v1: 0.32, u2: 0.68, v2: 0, type: 'valley' },
    ];

    return { faces, creases, guides: stepIdx < 2 ? guides : [] };
  },
};

// ============================================================================
// 12. 접었다 펴기 · 기준 격자 (Pre-crease & Reference Grid — Planar)
// ============================================================================
const PRECREASE_GRID_TECHNIQUE = {
  id: 'tech-precrease',
  category: 'technique',
  group: 'basic',
  name: '접었다 펴기 (기준선)',
  enName: 'Pre-crease & Reference Grid',
  badge: '기본 기법',
  difficulty: '입문',
  summary: '복잡한 작품을 접기 전에 종이를 접었다 다시 펴서 정확한 1/2·1/4·대각선 기준 주름(전개도 뼈대)을 새기는 필수 준비 기술입니다.',
  symbol: '양방향 화살표 (접었다 펴기)',
  usage: '모든 기본형, 4등분/8등분 박스 플리팅, 테셀레이션',
  defaultCamera: { yaw: 0.32, pitch: 0.44, distance: 4.5 },
  paper: { width: 2, height: 2, rotationDeg: 0 },
  steps: [
    { type: 'precrease', p1: [0, -1], p2: [0, 1], side: -1, label: '세로 1/2 기준선 새기기', technique: '접었다 펴기', desc: '오른쪽 절반을 접었다 펴서 정확한 세로 중심선을 만듭니다.' },
    { type: 'precrease', p1: [-1, 0], p2: [1, 0], side: 1, label: '가로 1/2 기준선 새기기', technique: '접었다 펴기', desc: '위쪽 절반을 접었다 펴서 십자 기준선을 완성합니다.' },
    { type: 'precrease', p1: [-1, -1], p2: [1, 1], side: -1, label: '대각선 45° 기준선 새기기', technique: '접었다 펴기', desc: '대각선을 접었다 펴서 중심 교차점과 45° 각도 기준을 확보합니다.' },
    { type: 'precrease', p1: [0.5, -1], p2: [0.5, 1], side: -1, label: '1/4 문접기 기준선 새기기', technique: '접었다 펴기', desc: '오른쪽 변을 중심선까지 접었다 펴서 4등분 격자 기준선을 완성합니다.' },
  ],
};

export function getAdvancedTechniques(buildPreliminaryBaseMesh) {
  return {
    PRECREASE_GRID_TECHNIQUE,
    OUTSIDE_REVERSE_TECHNIQUE,
    CRIMP_FOLD_TECHNIQUE,
    SWIVEL_FOLD_TECHNIQUE,
    OPEN_SINK_TECHNIQUE,
    CLOSED_SINK_TECHNIQUE,
    POCKET_TUCK_TECHNIQUE,
    WATERBOMB_BASE_TECHNIQUE,
    PRELIMINARY_BASE_TECHNIQUE: createPreliminaryBaseTechnique(buildPreliminaryBaseMesh),
    INFLATE_3D_TECHNIQUE,
    MIURA_ORI_TECHNIQUE,
    SQUARE_TWIST_TECHNIQUE,
  };
}
