// ============================================================================
// app.js — Interactive 3D Origami Studio Controller (Desktop & Mobile Touch)
// Features: Direct Drag-to-Fold (Huzita-Hatori Axiom 2 live 3D folding!),
//           2-Point Precision Line Fold, Multi-Touch Pinch Zoom & Orbit,
//           Mobile Bottom Sheet Drawer, Timeline Scrubber & Full-Process GIF
// ============================================================================

import { v3, sub, dot, cross, norm, screenToPlane, worldToCamera, projectPoint } from './math3d.js';
import { compilePlanarTimeline, compilePlanarStep, computeSnapPoints, createInitialPaper } from './planarEngine.js';
import { ORIGAMI_CATALOG, PAPER_PRESETS } from './kinematicModels.js';
import { renderOrigami3D, renderCreasePattern2D } from './renderer3d.js';
import { GifEncoder } from './gifEncoder.js';

export function initOrigamiStudio() {
  // ---- State ----
  const state = {
    mode: 'library', // 'library' | 'free'
    catalogFilter: 'all', // 'all' | 'model' | 'basic' | '3d' | 'advanced'
    selectedId: 'model-crane',
    frontColor: PAPER_PRESETS[0].front,
    backColor: PAPER_PRESETS[0].back,
    showGuides: true,
    showWireframe: false,
    showCP: true,
    autoOrbit: false,
    isDark: false,
    sheetOpen: false,

    // Playback timeline (continuous float in [0, stepCount])
    playPos: 0,
    playing: true,
    playbackSpeed: 1.0,
    pauseBetweenSteps: 0.42,
    stepHoldTimer: 0,

    // 3D Orbit Camera
    camera: { yaw: 0.58, pitch: 0.34, distance: 4.8, target: v3(0, 0, 0) },
    targetCamera: null,

    // Free Fold Studio state
    freeTitle: '나의 3D 종이접기',
    freePaper: { width: 2.0, height: 2.0, rotationDeg: 0 },
    freeSteps: [],
    freeRedo: [],
    freeTool: 'valley', // 'valley' | 'mountain' | 'precrease' | 'pleat'
    freeInteractMode: 'drag', // 'drag' (직관적 끌어접기) | 'line' (선 긋기) | 'orbit' (3D 회전)
    freeAngle: 180,
    freeLayerScope: 'all', // 'all' | 'top'
    freePleatOffset: 0.25,

    // Interactive Line-Fold state
    pickP1: null,
    pickP2: null,
    hoverWorld: null,
    hoveredSnap: null,
    hoverSide: 0,

    // Interactive Direct Drag-to-Fold live state
    dragFoldActive: false,
    dragStart: null,
    dragCurrent: null,
    dragSnapLabel: '',
    dragCrease: null,
    dragLiveStep: null,
    dragLiveCompiled: null,
    dragLiveT: 0,

    // Compiled timeline cache
    compiledPlanar: null,
    snapPoints: [],

    // GIF export state
    gifBusy: false,
    gifCancel: false,
    gifBlobUrl: null,
    gifFileName: 'origami-3d.gif',
  };

  // ---- DOM References ----
  const $ = (id) => document.getElementById(id);
  const canvas = $('viewport-canvas');
  const ctx = canvas.getContext('2d');
  const cpCanvas = $('cp-canvas');
  const cpCtx = cpCanvas.getContext('2d');

  const isMobileViewport = () => window.innerWidth <= 768;

  // Detect light/dark theme dynamically
  function detectTheme() {
    const html = document.documentElement;
    if (html.classList.contains('dark')) {
      state.isDark = true;
    } else if (html.classList.contains('light')) {
      state.isDark = false;
    } else {
      const bg = getComputedStyle(document.documentElement).getPropertyValue('--background').trim();
      if (bg && bg.startsWith('#')) {
        const r = parseInt(bg.slice(1, 3), 16) || 240;
        state.isDark = r < 110;
      } else {
        state.isDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
      }
    }
  }
  detectTheme();
  window.addEventListener('themechange', () => { detectTheme(); renderAll(); });

  // ---- Mobile Bottom Sheet Controls ----
  function openSheet() {
    state.sheetOpen = true;
    $('studio-sidebar').classList.add('sheet-open');
    $('sheet-backdrop').classList.add('open');
    $('sheet-title').textContent = state.mode === 'library'
      ? '작품 · 종이접기 기술 (25종)'
      : '접기 도구 · 기법 설정';
  }

  function closeSheet() {
    state.sheetOpen = false;
    $('studio-sidebar').classList.remove('sheet-open');
    $('sheet-backdrop').classList.remove('open');
  }

  // ---- Active Work Helpers ----
  function getActiveModel() {
    if (state.mode === 'free') {
      return {
        id: 'free-custom',
        category: 'free',
        name: state.freeTitle || '나의 3D 종이접기',
        enName: 'Custom Free Fold',
        steps: state.freeSteps,
        paper: state.freePaper,
      };
    }
    return ORIGAMI_CATALOG.find(m => m.id === state.selectedId) || ORIGAMI_CATALOG[0];
  }

  function rebuildCompiledTimeline() {
    const model = getActiveModel();
    if (typeof model.evaluate === 'function') {
      state.compiledPlanar = null;
      state.snapPoints = [];
    } else {
      state.compiledPlanar = compilePlanarTimeline(model.paper || { width: 2, height: 2 }, model.steps);
      state.snapPoints = state.mode === 'free'
        ? computeSnapPoints(state.compiledPlanar.finalState)
        : [];
    }
  }

  function evaluateAtPos(pos) {
    const model = getActiveModel();
    const total = model.steps.length;
    if (total === 0) {
      const init = createInitialPaper(state.freePaper.width, state.freePaper.height, state.freePaper.rotationDeg);
      return { faces: init.faces, creases: [], guides: [], stepIdx: -1, t: 0 };
    }
    const clamped = Math.max(0, Math.min(total, pos));
    let stepIdx = Math.floor(clamped);
    let t = clamped - stepIdx;
    if (stepIdx >= total) {
      stepIdx = total - 1;
      t = 1.0;
    }
    const frame = typeof model.evaluate === 'function'
      ? model.evaluate(stepIdx, t)
      : state.compiledPlanar.evaluate(stepIdx, t);
    return { ...frame, stepIdx, t };
  }

  // ---- Model & Mode Switching ----
  function selectLibraryModel(id, autoPlay = true) {
    state.mode = 'library';
    state.selectedId = id;
    clearInteractiveDraft();
    rebuildCompiledTimeline();
    const model = getActiveModel();
    if (model.defaultCamera) {
      state.targetCamera = { ...model.defaultCamera, target: v3(0, 0, 0) };
    }
    state.playPos = 0;
    state.stepHoldTimer = 0;
    state.playing = autoPlay;
    if (isMobileViewport()) closeSheet();
    syncUI();
  }

  function switchMode(newMode) {
    if (state.mode === newMode) return;
    state.mode = newMode;
    clearInteractiveDraft();
    rebuildCompiledTimeline();
    if (newMode === 'free') {
      state.playing = false;
      state.playPos = state.freeSteps.length;
      state.targetCamera = { yaw: 0.0, pitch: 0.14, distance: isMobileViewport() ? 4.3 : 4.5, target: v3(0, 0, 0) };
    } else {
      const m = getActiveModel();
      if (m.defaultCamera) state.targetCamera = { ...m.defaultCamera, target: v3(0, 0, 0) };
    }
    if (isMobileViewport()) closeSheet();
    syncUI();
  }

  function branchCurrentToFreeStudio() {
    const model = getActiveModel();
    if (typeof model.evaluate === 'function') return;
    state.freeTitle = `${model.name} (커스텀)`;
    state.freePaper = { ...(model.paper || { width: 2, height: 2, rotationDeg: 0 }) };
    state.freeSteps = model.steps.map(s => JSON.parse(JSON.stringify(s)));
    state.freeRedo = [];
    state.mode = 'free';
    clearInteractiveDraft();
    rebuildCompiledTimeline();
    state.playing = false;
    state.playPos = state.freeSteps.length;
    state.targetCamera = { yaw: 0.12, pitch: 0.18, distance: 4.5, target: v3(0, 0, 0) };
    if (isMobileViewport()) closeSheet();
    syncUI();
  }

  function clearInteractiveDraft() {
    state.pickP1 = null;
    state.pickP2 = null;
    state.hoverSide = 0;
    state.dragFoldActive = false;
    state.dragStart = null;
    state.dragCurrent = null;
    state.dragSnapLabel = '';
    state.dragCrease = null;
    state.dragLiveStep = null;
    state.dragLiveCompiled = null;
    state.dragLiveT = 0;
  }

  // ---- Free Fold Actions ----
  function addFreeStep(step, startOffsetT = 0) {
    state.freeSteps.push(step);
    state.freeRedo = [];
    clearInteractiveDraft();
    rebuildCompiledTimeline();
    state.playPos = Math.max(0, state.freeSteps.length - 1 + startOffsetT);
    state.playing = true;
    state.stepHoldTimer = 0;
    syncUI();
  }

  function undoFreeStep() {
    if (state.freeSteps.length === 0) return;
    state.freeRedo.push(state.freeSteps.pop());
    clearInteractiveDraft();
    rebuildCompiledTimeline();
    state.playing = false;
    state.playPos = state.freeSteps.length;
    syncUI();
  }

  function redoFreeStep() {
    if (state.freeRedo.length === 0) return;
    addFreeStep(state.freeRedo.pop());
  }

  function resetFreeStudio() {
    state.freeSteps = [];
    state.freeRedo = [];
    state.freePaper = { width: 2, height: 2, rotationDeg: 0 };
    clearInteractiveDraft();
    rebuildCompiledTimeline();
    state.playing = false;
    state.playPos = 0;
    syncUI();
  }

  function deleteFreeStepAt(idx) {
    if (state.mode !== 'free') return;
    state.freeSteps.splice(idx, 1);
    state.freeRedo = [];
    clearInteractiveDraft();
    rebuildCompiledTimeline();
    state.playPos = Math.min(state.playPos, state.freeSteps.length);
    state.playing = false;
    syncUI();
  }

  function applyQuickMacro(macroId) {
    const scope = state.freeLayerScope;
    const macros = {
      diag: { type: 'valley', p1: [-1, -1], p2: [1, 1], side: -1, angleDeg: 180, layerScope: scope, label: '대각선 계곡 접기', technique: '계곡 접기' },
      halfV: { type: 'valley', p1: [0, -1], p2: [0, 1], side: -1, angleDeg: 180, layerScope: scope, label: '세로 반 접기', technique: '계곡 접기' },
      halfH: { type: 'valley', p1: [-1, 0], p2: [1, 0], side: 1, angleDeg: 180, layerScope: scope, label: '가로 반 접기', technique: '계곡 접기' },
      kite: {
        type: 'multiFold', label: '아이스크림 접기 (Kite)', technique: '아이스크림 접기',
        folds: [
          { p1: [0, 1], p2: [1, 0], side: 1, foldType: 'valley', angleDeg: 180, layerScope: scope },
          { p1: [-1, 0], p2: [0, 1], side: 1, foldType: 'valley', angleDeg: 180, layerScope: scope },
        ],
      },
      blintz: {
        type: 'multiFold', label: '방석 접기 (4모서리)', technique: '방석 접기',
        folds: [
          { p1: [0, 1], p2: [1, 0], side: 1, foldType: 'valley', angleDeg: 180 },
          { p1: [-1, 0], p2: [0, 1], side: 1, foldType: 'valley', angleDeg: 180 },
          { p1: [-1, 0], p2: [0, -1], side: -1, foldType: 'valley', angleDeg: 180 },
          { p1: [0, -1], p2: [1, 0], side: -1, foldType: 'valley', angleDeg: 180 },
        ],
      },
      pleat: { type: 'pleat', p1: [-0.25, -1], p2: [-0.25, 1], side: -1, offset: state.freePleatOffset, angleDeg: 165, layerScope: scope, label: '계단 접기 (Pleat)', technique: '계단 접기' },
      flip: { type: 'flip', axis: 'y', label: '종이 뒤집기', technique: '뒤집기' },
      rot90: { type: 'rotate', angleDeg: 90, label: '90° 회전', technique: '회전' },
      rot45: { type: 'rotate', angleDeg: 45, label: '45° 회전', technique: '회전' },
    };
    if (isMobileViewport()) closeSheet();
    if (macroId === 'accordion') {
      addFreeStep({ type: 'pleat', p1: [-0.45, -1], p2: [-0.45, 1], side: -1, offset: 0.25, angleDeg: 155, layerScope: scope, label: '아코디언 1단 주름', technique: '계단 접기' });
      addFreeStep({ type: 'pleat', p1: [0.15, -1], p2: [0.15, 1], side: -1, offset: 0.25, angleDeg: 155, layerScope: scope, label: '아코디언 2단 주름', technique: '계단 접기' });
      return;
    }
    if (macroId === 'grid') {
      addFreeStep({ type: 'precrease', p1: [0, -1], p2: [0, 1], side: -1, label: '세로 중심 예비선', technique: '접었다 펴기' });
      addFreeStep({ type: 'precrease', p1: [-1, 0], p2: [1, 0], side: 1, label: '가로 중심 예비선', technique: '접었다 펴기' });
      return;
    }
    const step = macros[macroId];
    if (step) addFreeStep(step);
  }

  // ---- Geometry Hit-Test & Direct Drag-to-Fold Helpers ----
  let lastCam = null;

  function getCanvasCoords(e) {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top, w: rect.width, h: rect.height };
  }

  function findNearestSnap(sx, sy, w, h, radiusPx = 28, excludePt = null) {
    if (!lastCam || state.snapPoints.length === 0) return null;
    let best = null, bestDist = radiusPx;
    for (const sp of state.snapPoints) {
      if (excludePt && Math.hypot(sp.x - excludePt.x, sp.y - excludePt.y) < 0.08) continue;
      const pr = projectPoint(worldToCamera(sp, lastCam), w, h);
      const d = Math.hypot(pr.x - sx, pr.y - sy);
      if (d < bestDist) {
        bestDist = d;
        best = sp;
      }
    }
    return best;
  }

  function pointInPoly2D(px, py, pts) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
      if (((yi > py) !== (yj > py)) && (px < ((xj - xi) * (py - yi)) / (yj - yi + 1e-12) + xi)) {
        inside = !inside;
      }
    }
    return inside;
  }

  function isPointOnPaper(worldPt) {
    if (!worldPt || !state.compiledPlanar) return false;
    for (const f of state.compiledPlanar.finalState.faces) {
      if (pointInPoly2D(worldPt.x, worldPt.y, f.pts)) return true;
    }
    return false;
  }

  function updateDirectDragFold(sx, sy, w, h) {
    if (!state.dragStart || !lastCam || !state.compiledPlanar) return;
    const snapRadius = isMobileViewport() ? 36 : 26;
    const snapTarget = findNearestSnap(sx, sy, w, h, snapRadius, state.dragStart);
    const raw = screenToPlane(sx, sy, w, h, lastCam, v3(0, 0, 0), v3(0, 0, 1));
    const cur = snapTarget ? v3(snapTarget.x, snapTarget.y, 0) : (raw ? v3(raw.x, raw.y, 0) : state.dragStart);

    state.dragCurrent = cur;
    state.dragSnapLabel = snapTarget
      ? (snapTarget.kind === 'vertex' ? '꼭짓점 맞춤' : snapTarget.kind === 'center' ? '중심 맞춤' : '변 중점 맞춤')
      : '';

    const dx = cur.x - state.dragStart.x;
    const dy = cur.y - state.dragStart.y;
    const dLen = Math.hypot(dx, dy);

    if (dLen < 0.14) {
      state.dragCrease = null;
      state.dragLiveStep = null;
      state.dragLiveCompiled = null;
      state.dragLiveT = 0;
      return;
    }

    // Huzita-Hatori Axiom 2: exact perpendicular bisector bringing dragStart onto cur!
    const mid = v3((state.dragStart.x + cur.x) * 0.5, (state.dragStart.y + cur.y) * 0.5, 0);
    const dir = norm(v3(-dy, dx, 0));
    const p1 = v3(mid.x - dir.x * 1.45, mid.y - dir.y * 1.45, 0);
    const p2 = v3(mid.x + dir.x * 1.45, mid.y + dir.y * 1.45, 0);
    const leftNormal = norm(cross(v3(0, 0, 1), dir));
    const side = dot(sub(state.dragStart, mid), leftNormal) >= 0 ? 1 : -1;

    const toolNames = {
      valley: '계곡 접기',
      mountain: '산 접기',
      precrease: '접었다 펴기',
      pleat: '계단 접기',
    };
    const labelSuffix = state.dragSnapLabel ? ` · ${state.dragSnapLabel}` : '';
    const liveStep = {
      type: state.freeTool,
      p1: [p1.x, p1.y],
      p2: [p2.x, p2.y],
      side,
      angleDeg: state.freeAngle,
      layerScope: state.freeLayerScope,
      offset: state.freePleatOffset,
      label: `${toolNames[state.freeTool]}${labelSuffix}`,
      technique: toolNames[state.freeTool],
    };

    state.dragCrease = { p1, p2 };
    state.dragLiveStep = liveStep;
    state.dragLiveCompiled = compilePlanarStep(state.compiledPlanar.finalState, liveStep);
    // Real-time 3D preview angle follows drag distance & snaps close to finished when locked on target!
    state.dragLiveT = snapTarget ? 0.88 : Math.min(0.84, 0.25 + (dLen / 1.55) * 0.62);
  }

  function computeFreePreviewFaces() {
    if (!state.pickP1 || !state.pickP2 || state.hoverSide === 0 || !state.compiledPlanar) return [];
    const dir = norm(sub(state.pickP2, state.pickP1));
    const nrm = norm(cross(v3(0, 0, 1), dir));
    const out = [];
    for (const f of state.compiledPlanar.finalState.faces) {
      for (const p of f.pts) {
        if (dot(sub(p, state.pickP1), nrm) * state.hoverSide > 0.02) {
          out.push(f);
          break;
        }
      }
    }
    return out;
  }

  // ---- Multi-Touch Pointer & Gesture System ----
  const activePointers = new Map(); // pointerId -> { x, y }
  let gestureMode = 'none'; // 'none' | 'orbit' | 'drag-fold' | 'pinch'
  let dragMoved = false;
  let dragStartX = 0, dragStartY = 0;
  let dragLastX = 0, dragLastY = 0;
  let pinchStartDist = 0, pinchStartCamDist = 4.6, pinchMidX = 0, pinchMidY = 0;

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    const { x, y, w, h } = getCanvasCoords(e);
    activePointers.set(e.pointerId, { x, y });
    state.targetCamera = null;

    if (e.button === 2 && state.mode === 'free') {
      clearInteractiveDraft();
      updateFreeBanner();
      return;
    }

    // Two-finger gesture -> Pinch-to-Zoom + 2-Finger Orbit!
    if (activePointers.size === 2) {
      clearInteractiveDraft();
      const pts = Array.from(activePointers.values());
      pinchStartDist = Math.max(10, Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y));
      pinchStartCamDist = state.camera.distance;
      pinchMidX = (pts[0].x + pts[1].x) * 0.5;
      pinchMidY = (pts[0].y + pts[1].y) * 0.5;
      gestureMode = 'pinch';
      return;
    }

    if (activePointers.size > 2) return;

    dragMoved = false;
    dragStartX = dragLastX = x;
    dragStartY = dragLastY = y;

    // Decide 1-finger gesture: Direct Drag-to-Fold vs Orbit!
    const inDirectDrag = state.mode === 'free' && state.freeInteractMode === 'drag' && lastCam;
    if (inDirectDrag) {
      // Jump to latest folded state if user paused earlier
      if (state.playPos < state.freeSteps.length) {
        state.playPos = state.freeSteps.length;
        state.playing = false;
        syncPlaybackControls();
      }
      const grabRadius = isMobileViewport() ? 42 : 30;
      const snap = findNearestSnap(x, y, w, h, grabRadius);
      const raw = screenToPlane(x, y, w, h, lastCam, v3(0, 0, 0), v3(0, 0, 1));
      const onPaper = snap || isPointOnPaper(raw);

      if (onPaper) {
        const startPt = snap ? v3(snap.x, snap.y, 0) : v3(raw.x, raw.y, 0);
        gestureMode = 'drag-fold';
        state.dragFoldActive = true;
        state.dragStart = startPt;
        state.dragCurrent = startPt;
        state.dragSnapLabel = '';
        state.dragCrease = null;
        state.dragLiveStep = null;
        state.dragLiveCompiled = null;
        updateFreeBanner();
        return;
      }
    }

    // Touching empty background OR Library Mode OR Orbit/Line Mode -> Orbit camera on drag!
    gestureMode = 'orbit';
  });

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  canvas.addEventListener('pointermove', (e) => {
    const { x, y, w, h } = getCanvasCoords(e);
    if (activePointers.has(e.pointerId)) {
      activePointers.set(e.pointerId, { x, y });
    }

    // 1. Two-finger pinch zoom & orbit
    if (gestureMode === 'pinch' && activePointers.size >= 2) {
      const pts = Array.from(activePointers.values());
      const curDist = Math.max(10, Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y));
      const ratio = pinchStartDist / curDist;
      state.camera.distance = Math.max(2.5, Math.min(8.4, pinchStartCamDist * ratio));
      const midX = (pts[0].x + pts[1].x) * 0.5;
      const midY = (pts[0].y + pts[1].y) * 0.5;
      state.camera.yaw -= (midX - pinchMidX) * 0.008;
      state.camera.pitch = Math.max(-1.42, Math.min(1.42, state.camera.pitch + (midY - pinchMidY) * 0.008));
      pinchMidX = midX;
      pinchMidY = midY;
      state.autoOrbit = false;
      return;
    }

    // 2. Direct Drag-to-Fold live 3D folding!
    if (gestureMode === 'drag-fold' && state.dragFoldActive) {
      if (Math.hypot(x - dragStartX, y - dragStartY) > 6) dragMoved = true;
      updateDirectDragFold(x, y, w, h);
      updateFreeBanner();
      return;
    }

    // 3. Camera Orbit drag
    if (gestureMode === 'orbit' && activePointers.size === 1) {
      const dx = x - dragLastX;
      const dy = y - dragLastY;
      if (Math.hypot(x - dragStartX, y - dragStartY) > 6) dragMoved = true;
      if (dragMoved) {
        state.camera.yaw -= dx * 0.0085;
        state.camera.pitch = Math.max(-1.42, Math.min(1.42, state.camera.pitch + dy * 0.0085));
        state.autoOrbit = false;
      }
      dragLastX = x;
      dragLastY = y;
      return;
    }

    // 4. Desktop hover feedback when idle in Free Studio
    if (activePointers.size === 0 && state.mode === 'free' && !state.playing && lastCam) {
      const worldPt = screenToPlane(x, y, w, h, lastCam, v3(0, 0, 0), v3(0, 0, 1));
      const snap = findNearestSnap(x, y, w, h, 26);
      state.hoveredSnap = snap;
      state.hoverWorld = snap ? v3(snap.x, snap.y, 0) : (worldPt ? v3(worldPt.x, worldPt.y, 0) : null);

      if (state.freeInteractMode === 'line' && state.pickP1 && state.pickP2 && state.hoverWorld) {
        const dir = norm(sub(state.pickP2, state.pickP1));
        const nrm = norm(cross(v3(0, 0, 1), dir));
        const d = dot(sub(state.hoverWorld, state.pickP1), nrm);
        state.hoverSide = Math.abs(d) > 0.04 ? (d > 0 ? 1 : -1) : 0;
      } else {
        state.hoverSide = 0;
      }
    }
  });

  function handlePointerRelease(e) {
    const { x, y, w, h } = getCanvasCoords(e);
    activePointers.delete(e.pointerId);

    // Finish Direct Drag-to-Fold!
    if (gestureMode === 'drag-fold') {
      const stepToCommit = state.dragLiveStep;
      const startT = state.dragLiveT;
      gestureMode = 'none';
      if (stepToCommit && dragMoved) {
        // Commit the fold and finish animating smoothly from current live angle to 1.0!
        addFreeStep(stepToCommit, Math.min(0.85, startT));
      } else {
        clearInteractiveDraft();
        updateFreeBanner();
      }
      return;
    }

    // Tap in Precision Line-Fold Mode
    const wasTap = gestureMode === 'orbit' && !dragMoved && (e.button === 0 || e.pointerType === 'touch');
    if (activePointers.size === 0) gestureMode = 'none';

    if (!wasTap || state.mode !== 'free' || state.freeInteractMode !== 'line' || !lastCam) return;

    if (state.playPos < state.freeSteps.length) {
      state.playPos = state.freeSteps.length;
      state.playing = false;
    }

    const snap = findNearestSnap(x, y, w, h, isMobileViewport() ? 36 : 24);
    const raw = screenToPlane(x, y, w, h, lastCam, v3(0, 0, 0), v3(0, 0, 1));
    const pt = snap ? v3(snap.x, snap.y, 0) : (raw ? v3(raw.x, raw.y, 0) : null);
    if (!pt) return;

    if (!state.pickP1) {
      state.pickP1 = pt;
      state.pickP2 = null;
      updateFreeBanner();
    } else if (!state.pickP2) {
      if (Math.hypot(pt.x - state.pickP1.x, pt.y - state.pickP1.y) < 0.08) return;
      state.pickP2 = pt;
      updateFreeBanner();
    } else {
      const dir = norm(sub(state.pickP2, state.pickP1));
      const nrm = norm(cross(v3(0, 0, 1), dir));
      const d = dot(sub(pt, state.pickP1), nrm);
      if (Math.abs(d) < 0.03) return;
      const side = d > 0 ? 1 : -1;
      const toolNames = { valley: '계곡 접기', mountain: '산 접기', precrease: '접었다 펴기', pleat: '계단 접기' };
      addFreeStep({
        type: state.freeTool,
        p1: [state.pickP1.x, state.pickP1.y],
        p2: [state.pickP2.x, state.pickP2.y],
        side,
        angleDeg: state.freeAngle,
        layerScope: state.freeLayerScope,
        offset: state.freePleatOffset,
        label: `${toolNames[state.freeTool]} (${state.freeAngle}°)`,
        technique: toolNames[state.freeTool],
      });
    }
  }

  canvas.addEventListener('pointerup', handlePointerRelease);
  canvas.addEventListener('pointercancel', (e) => {
    activePointers.delete(e.pointerId);
    if (activePointers.size === 0) {
      gestureMode = 'none';
      clearInteractiveDraft();
      updateFreeBanner();
    }
  });

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    state.targetCamera = null;
    state.camera.distance = Math.max(2.5, Math.min(8.4, state.camera.distance * (1 + e.deltaY * 0.001)));
  }, { passive: false });

  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.key === 'Escape' && state.mode === 'free') {
      clearInteractiveDraft();
      updateFreeBanner();
    } else if (e.code === 'Space') {
      e.preventDefault();
      togglePlay();
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && state.mode === 'free') {
      e.preventDefault();
      if (e.shiftKey) redoFreeStep();
      else undoFreeStep();
    }
  });

  // ---- Playback Controls ----
  function togglePlay() {
    const total = getActiveModel().steps.length;
    if (total === 0) return;
    if (!state.playing && state.playPos >= total - 0.001) {
      state.playPos = 0;
    }
    state.playing = !state.playing;
    state.stepHoldTimer = 0;
    syncPlaybackControls();
  }

  function jumpToStep(stepIdx) {
    const total = getActiveModel().steps.length;
    state.playing = false;
    state.playPos = Math.max(0, Math.min(total, stepIdx));
    syncPlaybackControls();
  }

  // ---- UI Rendering & Sync ----
  function renderCatalogList() {
    const modelsEl = $('catalog-models');
    const basicEl = $('catalog-tech-basic');
    const t3dEl = $('catalog-tech-3d');
    const advEl = $('catalog-tech-adv');
    modelsEl.innerHTML = '';
    basicEl.innerHTML = '';
    t3dEl.innerHTML = '';
    advEl.innerHTML = '';

    const f = state.catalogFilter;
    $('sec-models').style.display = (f === 'all' || f === 'model') ? 'block' : 'none';
    $('sec-basic').style.display = (f === 'all' || f === 'basic') ? 'block' : 'none';
    $('sec-3d').style.display = (f === 'all' || f === '3d') ? 'block' : 'none';
    $('sec-advanced').style.display = (f === 'all' || f === 'advanced') ? 'block' : 'none';

    document.querySelectorAll('[data-filter]').forEach(ch => {
      ch.classList.toggle('active', ch.dataset.filter === f);
    });

    for (const item of ORIGAMI_CATALOG) {
      const btn = document.createElement('button');
      btn.className = `catalog-item ${state.selectedId === item.id ? 'active' : ''}`;
      btn.innerHTML = `
        <div class="catalog-item-top">
          <span class="catalog-item-name">${item.name}</span>
          <span class="catalog-diff">${item.difficulty}</span>
        </div>
        <div class="catalog-item-sub">${item.enName} · ${item.steps.length}단계</div>
      `;
      btn.addEventListener('click', () => selectLibraryModel(item.id, true));
      if (item.category === 'model') modelsEl.appendChild(btn);
      else if (item.group === 'basic') basicEl.appendChild(btn);
      else if (item.group === '3d') t3dEl.appendChild(btn);
      else advEl.appendChild(btn);
    }
  }

  function renderPaperSwatches() {
    const container = $('paper-swatches');
    container.innerHTML = '';
    for (const p of PAPER_PRESETS) {
      const sw = document.createElement('button');
      sw.className = `swatch-btn ${state.frontColor === p.front ? 'active' : ''}`;
      sw.title = p.name;
      sw.style.background = `linear-gradient(135deg, ${p.front} 55%, ${p.back} 55%)`;
      sw.addEventListener('click', () => {
        state.frontColor = p.front;
        state.backColor = p.back;
        $('color-front').value = p.front;
        $('color-back').value = p.back;
        renderPaperSwatches();
      });
      container.appendChild(sw);
    }
  }

  function renderTimelineSteps() {
    const list = $('step-pills');
    const model = getActiveModel();
    list.innerHTML = '';

    if (model.steps.length === 0) {
      list.innerHTML = '<div class="empty-steps">종이 모서리를 끌어 다른 모서리·중심에 맞춰 첫 접기를 해보세요!</div>';
      return;
    }

    const activeIdx = Math.min(model.steps.length - 1, Math.floor(state.playPos));
    model.steps.forEach((s, idx) => {
      const pill = document.createElement('div');
      pill.className = `step-pill ${idx === activeIdx ? 'active' : idx < activeIdx ? 'done' : ''}`;
      pill.innerHTML = `
        <span class="step-num">${idx + 1}</span>
        <span class="step-txt">${s.label || s.technique || '접기'}</span>
        ${state.mode === 'free' ? `<button class="step-del" title="단계 삭제" data-del="${idx}">×</button>` : ''}
      `;
      pill.addEventListener('click', (ev) => {
        if (ev.target.dataset.del !== undefined) {
          ev.stopPropagation();
          deleteFreeStepAt(Number(ev.target.dataset.del));
          return;
        }
        state.playing = false;
        state.playPos = idx + 1;
        syncPlaybackControls();
      });
      list.appendChild(pill);
    });
  }

  function updateFreeBanner() {
    const banner = $('free-guide-banner');
    if (state.mode !== 'free') {
      banner.style.display = 'none';
      return;
    }
    banner.style.display = 'flex';
    const textEl = $('free-guide-text');
    if (state.freeInteractMode === 'drag') {
      if (state.dragFoldActive) {
        textEl.textContent = state.dragSnapLabel
          ? `손을 떼면 접기 완료! (${state.dragSnapLabel})`
          : '원하는 지점까지 끌어당긴 뒤 손을 떼세요';
      } else {
        textEl.textContent = '모서리를 끌어 다른 점에 맞춰 접기 · 바깥 드래그로 3D 회전';
      }
    } else if (state.freeInteractMode === 'orbit') {
      textEl.textContent = '3D 회전 모드 · 화면을 드래그해 회전, 두 손가락으로 확대/축소';
    } else {
      if (!state.pickP1) textEl.textContent = '1/3 · 접기 선의 시작점을 탭하세요';
      else if (!state.pickP2) textEl.textContent = '2/3 · 접기 선의 끝점을 탭하세요';
      else textEl.textContent = '3/3 · 접어 올릴 영역을 탭해 실행하세요';
    }
  }

  function syncPlaybackControls() {
    const model = getActiveModel();
    const total = model.steps.length;
    const slider = $('timeline-slider');
    slider.max = String(Math.max(1, total));
    slider.value = String(Math.min(total, state.playPos));
    slider.disabled = total === 0;

    $('btn-play').innerHTML = state.playing
      ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg> 일시정지'
      : '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="6,4 20,12 6,20"/></svg> 전체 재생';
    $('mob-play').textContent = state.playing ? '⏸ 정지' : '▶ 재생';

    const curIdx = total > 0 ? Math.min(total - 1, Math.floor(state.playPos)) : -1;
    const stepObj = curIdx >= 0 ? model.steps[curIdx] : null;
    $('hud-step-counter').textContent = total > 0 ? `STEP ${curIdx + 1} / ${total}` : 'STEP 0 / 0';
    $('hud-step-title').textContent = stepObj ? (stepObj.label || stepObj.technique) : '새 정사각형 종이';
    $('hud-step-desc').textContent = stepObj?.desc || (state.mode === 'free'
      ? '모서리를 끌어 바로 3D로 접고, 완성된 전 과정을 GIF로 내보내세요.'
      : model.summary);

    const pills = $('step-pills').children;
    for (let i = 0; i < pills.length; i++) {
      pills[i].classList.toggle('active', i === curIdx);
      pills[i].classList.toggle('done', i < curIdx);
    }
  }

  function syncMobileBar() {
    $('mob-bar-library').style.display = state.mode === 'library' ? 'flex' : 'none';
    $('mob-bar-free').style.display = state.mode === 'free' ? 'flex' : 'none';

    const interactLabels = { drag: '✋ 끌어접기', line: '✂️ 선긋기', orbit: '🔄 3D회전' };
    $('mob-interact-toggle').textContent = interactLabels[state.freeInteractMode];

    const isMountain = state.freeTool === 'mountain';
    const dirBtn = $('mob-fold-dir');
    dirBtn.textContent = isMountain ? '산 ▼' : '계곡 ▲';
    dirBtn.classList.toggle('mountain', isMountain);
    $('mob-undo').disabled = state.freeSteps.length === 0;
  }

  function syncUI() {
    $('tab-library').classList.toggle('active', state.mode === 'library');
    $('tab-free').classList.toggle('active', state.mode === 'free');
    $('panel-library').style.display = state.mode === 'library' ? 'flex' : 'none';
    $('panel-free').style.display = state.mode === 'free' ? 'flex' : 'none';

    const model = getActiveModel();
    $('work-title-badge').textContent = model.name;
    $('work-subtitle').textContent = model.enName || '';

    const infoCard = $('library-info-card');
    if (state.mode === 'library') {
      const canBranch = typeof model.evaluate !== 'function';
      infoCard.innerHTML = `
        <div class="info-head">
          <span class="info-badge">${model.badge || ''}</span>
          <span class="info-diff">${model.difficulty || ''}</span>
        </div>
        <p class="info-summary">${model.summary || ''}</p>
        ${model.symbol ? `<div class="info-meta"><b>기호:</b> ${model.symbol}</div>` : ''}
        ${model.usage ? `<div class="info-meta"><b>활용:</b> ${model.usage}</div>` : ''}
        ${canBranch ? `<button id="btn-branch-free" class="btn-secondary full-w" style="margin-top:8px;">이 작품 직접 접기에서 이어하기</button>` : ''}
      `;
      const branchBtn = $('btn-branch-free');
      if (branchBtn) branchBtn.addEventListener('click', branchCurrentToFreeStudio);
    }

    if (state.mode === 'free') {
      $('free-title-input').value = state.freeTitle;
      $('btn-undo').disabled = state.freeSteps.length === 0;
      $('btn-redo').disabled = state.freeRedo.length === 0;
      $('pleat-offset-row').style.display = state.freeTool === 'pleat' ? 'flex' : 'none';
      document.querySelectorAll('[data-tool]').forEach(b => {
        b.classList.toggle('active', b.dataset.tool === state.freeTool);
      });
      document.querySelectorAll('[data-interact]').forEach(b => {
        b.classList.toggle('active', b.dataset.interact === state.freeInteractMode);
      });
    }

    $('cp-overlay').style.display = state.showCP ? 'block' : 'none';
    renderCatalogList();
    renderTimelineSteps();
    updateFreeBanner();
    syncPlaybackControls();
    syncMobileBar();
  }

  // ---- Main Animation & Render Loop ----
  function resizeCanvas() {
    const rect = canvas.parentElement.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(200, Math.floor(rect.width));
    const h = Math.max(200, Math.floor(rect.height));
    if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) {
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w, h };
  }

  function renderAll() {
    const { w, h } = resizeCanvas();

    // If user is actively Drag-to-Folding, render the LIVE 3D folding mesh directly!
    let frame;
    if (state.dragFoldActive && state.dragLiveCompiled) {
      frame = state.dragLiveCompiled.evaluate(state.dragLiveT);
    } else {
      frame = evaluateAtPos(state.playPos);
    }

    const showFreeOverlay = state.mode === 'free'
      && state.freeInteractMode !== 'orbit'
      && (state.dragFoldActive || (!state.playing && state.playPos >= state.freeSteps.length - 0.01));

    const freeOverlay = showFreeOverlay
      ? {
          interactMode: state.freeInteractMode,
          snapPoints: state.snapPoints,
          hoveredSnap: state.hoveredSnap,
          p1: state.pickP1,
          p2: state.pickP2,
          hoverWorld: state.hoverWorld,
          foldType: state.freeTool === 'mountain' ? 'mountain' : 'valley',
          hoverSide: state.hoverSide,
          previewFaces: computeFreePreviewFaces(),
          dragStart: state.dragStart,
          dragCurrent: state.dragCurrent,
          dragSnapLabel: state.dragSnapLabel,
          dragCrease: state.dragCrease,
        }
      : null;

    const totalSteps = getActiveModel().steps.length;
    const isFinishedFinal = totalSteps > 0 && state.playPos >= totalSteps - 0.005 && !state.dragFoldActive;

    lastCam = renderOrigami3D(ctx, w, h, frame, {
      camera: state.camera,
      frontColor: state.frontColor,
      backColor: state.backColor,
      isDark: state.isDark,
      showGuides: state.showGuides && !isFinishedFinal && !state.dragFoldActive,
      showWireframe: state.showWireframe,
      showShadow: true,
      freeOverlay,
    });

    if (state.showCP && !isMobileViewport()) {
      renderCreasePattern2D(cpCtx, cpCanvas.width, frame.creases, state.isDark);
    }
  }

  let lastTime = performance.now();
  function tick(now) {
    const dt = Math.min(0.05, (now - lastTime) / 1000);
    lastTime = now;

    if (state.targetCamera) {
      const k = Math.min(1, dt * 8);
      state.camera.yaw += (state.targetCamera.yaw - state.camera.yaw) * k;
      state.camera.pitch += (state.targetCamera.pitch - state.camera.pitch) * k;
      state.camera.distance += (state.targetCamera.distance - state.camera.distance) * k;
      if (
        Math.abs(state.targetCamera.yaw - state.camera.yaw) < 0.002 &&
        Math.abs(state.targetCamera.pitch - state.camera.pitch) < 0.002 &&
        Math.abs(state.targetCamera.distance - state.camera.distance) < 0.005
      ) {
        state.camera.yaw = state.targetCamera.yaw;
        state.camera.pitch = state.targetCamera.pitch;
        state.camera.distance = state.targetCamera.distance;
        state.targetCamera = null;
      }
    } else if (state.autoOrbit) {
      state.camera.yaw += dt * 0.48;
    }

    const total = getActiveModel().steps.length;
    if (state.playing && total > 0) {
      if (state.stepHoldTimer > 0) {
        state.stepHoldTimer -= dt;
      } else {
        const prevStep = Math.floor(state.playPos);
        state.playPos += dt * 0.78 * state.playbackSpeed;
        const nextStep = Math.floor(state.playPos);
        if (state.playPos >= total) {
          state.playPos = total;
          state.playing = false;
        } else if (nextStep > prevStep) {
          state.playPos = nextStep;
          state.stepHoldTimer = state.pauseBetweenSteps / state.playbackSpeed;
        }
        syncPlaybackControls();
      }
    }

    renderAll();
    requestAnimationFrame(tick);
  }

  // ---- FULL-PROCESS GIF EXPORT STUDIO ----
  function openGifModal() {
    closeSheet();
    const model = getActiveModel();
    $('gif-modal').classList.add('open');
    $('gif-work-name').textContent = `${model.name} (${model.steps.length}단계 전체 과정)`;
    $('gif-progress-wrap').style.display = 'none';
    $('gif-result-wrap').style.display = 'none';
    $('gif-start-btn').disabled = false;
    $('gif-start-btn').textContent = '과정 전체 GIF 생성 시작';
  }

  function closeGifModal() {
    if (state.gifBusy) state.gifCancel = true;
    $('gif-modal').classList.remove('open');
  }

  async function runFullProcessGifExport() {
    if (state.gifBusy) return;
    const model = getActiveModel();
    const totalSteps = model.steps.length;

    const [gw, gh] = $('gif-resolution').value.split('x').map(Number);
    const fps = Number($('gif-fps').value);
    const stepDurationSec = Number($('gif-speed').value);
    const camMode = $('gif-camera-mode').value;
    const includeHud = $('gif-show-hud').checked;
    const includeSpin = camMode === 'orbit-spin' || camMode === 'fixed-spin';

    state.gifBusy = true;
    state.gifCancel = false;
    $('gif-start-btn').disabled = true;
    $('gif-progress-wrap').style.display = 'block';
    $('gif-result-wrap').style.display = 'none';
    $('gif-progress-bar').style.width = '0%';
    $('gif-progress-text').textContent = '프레임 시퀀스 준비 중...';

    const frameDelayMs = Math.round(1000 / fps);
    const framesPerStep = Math.max(8, Math.round(fps * stepDurationSec));
    const holdFrames = Math.max(3, Math.round(fps * 0.32));
    const introHold = Math.max(4, Math.round(fps * 0.45));
    const spinFrames = includeSpin ? Math.round(fps * 2.4) : Math.round(fps * 0.9);

    const schedule = [];
    const baseYaw = state.camera.yaw;
    const basePitch = state.camera.pitch;
    const baseDist = state.camera.distance;

    for (let i = 0; i < introHold; i++) {
      schedule.push({
        pos: 0, yaw: baseYaw, pitch: basePitch, dist: baseDist, delay: frameDelayMs,
        stepNum: totalSteps > 0 ? 1 : 0,
        label: totalSteps > 0 ? '시작 · 정사각형 색종이' : model.name,
        technique: '준비', progress: 0,
      });
    }

    const totalAnimSteps = Math.max(1, totalSteps);
    for (let s = 0; s < totalSteps; s++) {
      const stepMeta = model.steps[s];
      for (let f = 0; f < framesPerStep; f++) {
        const localT = f / (framesPerStep - 1);
        const globalFrac = (s + localT) / totalAnimSteps;
        const orbitOffset = camMode === 'orbit-spin' ? Math.sin(globalFrac * Math.PI * 2) * 0.34 : 0;
        schedule.push({
          pos: s + localT * 0.9999,
          yaw: baseYaw + orbitOffset,
          pitch: basePitch + (camMode === 'orbit-spin' ? Math.sin(globalFrac * Math.PI) * 0.08 : 0),
          dist: baseDist, delay: frameDelayMs, stepNum: s + 1,
          label: stepMeta.label || stepMeta.technique || `단계 ${s + 1}`,
          technique: stepMeta.technique || '', progress: globalFrac,
        });
      }
      schedule.push({
        pos: s + 0.9999,
        yaw: baseYaw + (camMode === 'orbit-spin' ? Math.sin(((s + 1) / totalAnimSteps) * Math.PI * 2) * 0.34 : 0),
        pitch: basePitch, dist: baseDist, delay: Math.round(frameDelayMs * holdFrames), stepNum: s + 1,
        label: stepMeta.label || stepMeta.technique || `단계 ${s + 1}`,
        technique: stepMeta.technique || '', progress: (s + 1) / totalAnimSteps,
      });
    }

    for (let f = 0; f < spinFrames; f++) {
      const frac = f / Math.max(1, spinFrames - 1);
      schedule.push({
        pos: totalSteps,
        yaw: includeSpin ? baseYaw + frac * Math.PI * 2 : baseYaw,
        pitch: basePitch + (includeSpin ? Math.sin(frac * Math.PI) * 0.14 : 0),
        dist: baseDist * (includeSpin ? 0.96 : 1.0), delay: frameDelayMs,
        stepNum: totalSteps, label: `${model.name} 완성!`, technique: '완성', progress: 1.0,
      });
    }

    const offCanvas = document.createElement('canvas');
    offCanvas.width = gw;
    offCanvas.height = gh;
    const offCtx = offCanvas.getContext('2d', { willReadFrequently: true });

    const encoder = new GifEncoder(gw, gh, 0);
    const totalFrames = schedule.length;

    for (let i = 0; i < totalFrames; i++) {
      if (state.gifCancel) {
        state.gifBusy = false;
        $('gif-start-btn').disabled = false;
        return;
      }

      const item = schedule[i];
      const frameData = evaluateAtPos(item.pos);
      renderOrigami3D(offCtx, gw, gh, frameData, {
        camera: { yaw: item.yaw, pitch: item.pitch, distance: item.dist, target: v3(0, 0, 0) },
        frontColor: state.frontColor, backColor: state.backColor, isDark: state.isDark,
        showGuides: state.showGuides && item.progress < 1.0,
        showWireframe: state.showWireframe, showShadow: true,
        hudOverlay: includeHud
          ? { title: model.name, stepLabel: item.label, technique: item.technique, stepNum: item.stepNum, totalSteps, progress: item.progress }
          : null,
      });

      encoder.addFrame(offCtx.getImageData(0, 0, gw, gh).data, item.delay);

      const pct = Math.round(((i + 1) / totalFrames) * 100);
      $('gif-progress-bar').style.width = `${pct}%`;
      $('gif-progress-text').textContent = `GIF 인코딩 중... ${i + 1} / ${totalFrames} 프레임 (${pct}%)`;
      if (i % 3 === 0) await new Promise(r => setTimeout(r, 0));
    }

    const bytes = encoder.finish();
    if (state.gifBlobUrl) URL.revokeObjectURL(state.gifBlobUrl);
    state.gifBlobUrl = URL.createObjectURL(new Blob([bytes], { type: 'image/gif' }));
    state.gifFileName = `${(model.enName || model.id || 'origami').toLowerCase().replace(/[^a-z0-9]+/g, '-')}-3d-process.gif`;

    $('gif-preview-img').src = state.gifBlobUrl;
    $('gif-meta-info').textContent = `${gw}×${gh} · ${totalFrames}프레임 · ${(schedule.reduce((a, b) => a + b.delay, 0) / 1000).toFixed(1)}초 · ${(bytes.length / 1024).toFixed(1)} KB`;
    $('gif-download-link').href = state.gifBlobUrl;
    $('gif-download-link').download = state.gifFileName;
    $('gif-progress-wrap').style.display = 'none';
    $('gif-result-wrap').style.display = 'block';
    $('gif-start-btn').disabled = false;
    $('gif-start-btn').textContent = '다시 생성하기';
    state.gifBusy = false;
  }

  // ---- Wire Up Event Listeners ----
  $('tab-library').addEventListener('click', () => switchMode('library'));
  $('tab-free').addEventListener('click', () => switchMode('free'));

  // Mobile sheet drawer & quick thumb bar listeners
  $('sheet-backdrop').addEventListener('click', closeSheet);
  $('sheet-close-btn').addEventListener('click', closeSheet);
  $('mob-open-library').addEventListener('click', openSheet);
  $('mob-open-tools').addEventListener('click', openSheet);
  $('mob-play').addEventListener('click', togglePlay);
  $('mob-prev').addEventListener('click', () => jumpToStep(Math.max(0, Math.ceil(state.playPos) - 1)));
  $('mob-next').addEventListener('click', () => jumpToStep(Math.min(getActiveModel().steps.length, Math.floor(state.playPos) + 1)));
  $('mob-undo').addEventListener('click', undoFreeStep);
  $('mob-flip').addEventListener('click', () => applyQuickMacro('flip'));
  $('mob-interact-toggle').addEventListener('click', () => {
    const order = ['drag', 'line', 'orbit'];
    state.freeInteractMode = order[(order.indexOf(state.freeInteractMode) + 1) % order.length];
    clearInteractiveDraft();
    syncUI();
  });
  $('mob-fold-dir').addEventListener('click', () => {
    state.freeTool = state.freeTool === 'mountain' ? 'valley' : 'mountain';
    clearInteractiveDraft();
    syncUI();
  });

  // View & color controls
  $('color-front').addEventListener('input', (e) => { state.frontColor = e.target.value; renderPaperSwatches(); });
  $('color-back').addEventListener('input', (e) => { state.backColor = e.target.value; renderPaperSwatches(); });
  $('toggle-guides').addEventListener('click', (e) => { state.showGuides = !state.showGuides; e.currentTarget.classList.toggle('active', state.showGuides); });
  $('toggle-cp').addEventListener('click', (e) => { state.showCP = !state.showCP; e.currentTarget.classList.toggle('active', state.showCP); $('cp-overlay').style.display = state.showCP ? 'block' : 'none'; });
  $('toggle-wire').addEventListener('click', (e) => { state.showWireframe = !state.showWireframe; e.currentTarget.classList.toggle('active', state.showWireframe); });

  // Camera presets
  $('cam-3d').addEventListener('click', () => { state.autoOrbit = false; state.targetCamera = { yaw: 0.52, pitch: 0.38, distance: 4.7, target: v3(0, 0, 0) }; });
  $('cam-front').addEventListener('click', () => { state.autoOrbit = false; state.targetCamera = { yaw: 0.0, pitch: 0.02, distance: 4.4, target: v3(0, 0, 0) }; });
  $('cam-side').addEventListener('click', () => { state.autoOrbit = false; state.targetCamera = { yaw: 1.48, pitch: 0.22, distance: 4.7, target: v3(0, 0, 0) }; });
  $('cam-top').addEventListener('click', () => { state.autoOrbit = false; state.targetCamera = { yaw: 0.0, pitch: 1.32, distance: 4.8, target: v3(0, 0, 0) }; });
  $('cam-spin').addEventListener('click', (e) => { state.autoOrbit = !state.autoOrbit; e.currentTarget.classList.toggle('active', state.autoOrbit); });

  // Playback controls
  $('btn-play').addEventListener('click', togglePlay);
  $('btn-restart').addEventListener('click', () => { state.playPos = 0; state.playing = true; state.stepHoldTimer = 0; syncPlaybackControls(); });
  $('btn-prev').addEventListener('click', () => jumpToStep(Math.max(0, Math.ceil(state.playPos) - 1)));
  $('btn-next').addEventListener('click', () => jumpToStep(Math.min(getActiveModel().steps.length, Math.floor(state.playPos) + 1)));
  $('timeline-slider').addEventListener('input', (e) => { state.playing = false; state.playPos = Number(e.target.value); syncPlaybackControls(); });
  $('speed-select').addEventListener('change', (e) => { state.playbackSpeed = Number(e.target.value); });

  // Free Fold Studio controls
  $('free-title-input').addEventListener('input', (e) => { state.freeTitle = e.target.value; $('work-title-badge').textContent = state.freeTitle || '나의 3D 종이접기'; });
  document.querySelectorAll('[data-interact]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.freeInteractMode = btn.dataset.interact;
      clearInteractiveDraft();
      syncUI();
    });
  });
  document.querySelectorAll('[data-tool]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.freeTool = btn.dataset.tool;
      clearInteractiveDraft();
      syncUI();
    });
  });
  $('free-angle-slider').addEventListener('input', (e) => { state.freeAngle = Number(e.target.value); $('free-angle-val').textContent = `${state.freeAngle}°`; });
  document.querySelectorAll('[data-angle]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.freeAngle = Number(btn.dataset.angle);
      $('free-angle-slider').value = String(state.freeAngle);
      $('free-angle-val').textContent = `${state.freeAngle}°`;
    });
  });
  $('free-pleat-offset').addEventListener('input', (e) => { state.freePleatOffset = Number(e.target.value); $('free-pleat-val').textContent = `${Math.round(state.freePleatOffset * 100)}%`; });
  $('layer-all').addEventListener('click', () => { state.freeLayerScope = 'all'; $('layer-all').classList.add('active'); $('layer-top').classList.remove('active'); });
  $('layer-top').addEventListener('click', () => { state.freeLayerScope = 'top'; $('layer-top').classList.add('active'); $('layer-all').classList.remove('active'); });
  document.querySelectorAll('[data-macro]').forEach(btn => btn.addEventListener('click', () => applyQuickMacro(btn.dataset.macro)));
  $('btn-undo').addEventListener('click', undoFreeStep);
  $('btn-redo').addEventListener('click', redoFreeStep);
  $('btn-reset').addEventListener('click', resetFreeStudio);

  // GIF Export Modal controls
  $('btn-open-gif').addEventListener('click', openGifModal);
  $('gif-close-btn').addEventListener('click', closeGifModal);
  $('gif-modal').addEventListener('click', (e) => { if (e.target === $('gif-modal')) closeGifModal(); });
  $('gif-start-btn').addEventListener('click', runFullProcessGifExport);

  document.querySelectorAll('[data-filter]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.catalogFilter = btn.dataset.filter;
      renderCatalogList();
    });
  });

  // ---- Bootstrap ----
  renderPaperSwatches();
  selectLibraryModel('model-crane', true);
  requestAnimationFrame(tick);
}
