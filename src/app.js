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
import { UI_STRINGS, getInitialLang, saveLang, localizeModel } from './i18n.js';

export function initOrigamiStudio() {
  const initLang = getInitialLang();

  // ---- State ----
  const state = {
    lang: initLang, // 'en' (default) | 'ko'
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
    userZoomScale: 1.0,

    // Free Fold Studio state
    freeTitle: UI_STRINGS[initLang].defaultFreeTitle,
    freePaper: { width: 2.0, height: 2.0, rotationDeg: 0 },
    freeSteps: [],
    freeRedo: [],
    freeTool: 'valley', // 'valley' | 'mountain' | 'precrease' | 'pleat'
    freeInteractMode: 'drag', // 'drag' | 'line' | 'orbit'
    freeAngle: 180,
    freeLayerScope: 'all', // 'all' | 'top'
    freePleatOffset: 0.25,

    // Interactive Line-Fold state
    pickP1: null,
    pickP2: null,
    hoverWorld: null,
    hoveredSnap: null,
    hoverSide: 0,

    // Interactive Direct Drag-to-Fold / Unfold live state
    dragFoldActive: false,
    dragStart: null,
    dragCurrent: null,
    dragSnapLabel: '',
    dragCrease: null,
    dragLiveStep: null,
    dragLiveCompiled: null,
    dragLiveT: 0,
    dragIsUnfold: false,
    dragUnfoldGhost: null,

    // Compiled timeline cache
    compiledPlanar: null,
    snapPoints: [],

    // GIF export state
    gifBusy: false,
    gifCancel: false,
    gifBlobUrl: null,
    gifFileName: 'origami-3d.gif',
  };

  // ---- Localization Helpers ----
  const t = (key, ...args) => {
    const dict = UI_STRINGS[state.lang] || UI_STRINGS.en;
    const val = dict[key] !== undefined ? dict[key] : UI_STRINGS.en[key];
    return typeof val === 'function' ? val(...args) : val;
  };

  function applyStaticI18n() {
    document.documentElement.lang = state.lang;
    document.title = t('docTitle');
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      const val = t(el.dataset.i18n);
      if (typeof val === 'string') el.textContent = val;
    });
    document.querySelectorAll('[data-i18n-title]').forEach((el) => {
      const val = t(el.dataset.i18nTitle);
      if (typeof val === 'string') el.title = val;
    });
    document.querySelectorAll('[data-i18n-count]').forEach((el) => {
      el.textContent = t('countUnit', el.dataset.i18nCount);
    });
    document.querySelectorAll('[data-lang-opt]').forEach((el) => {
      el.classList.toggle('active', el.dataset.langOpt === state.lang);
    });
  }

  function toggleLanguage() {
    const prevDefault = UI_STRINGS[state.lang].defaultFreeTitle;
    state.lang = state.lang === 'en' ? 'ko' : 'en';
    saveLang(state.lang);
    if (!state.freeTitle || state.freeTitle === prevDefault) {
      state.freeTitle = t('defaultFreeTitle');
    }
    applyStaticI18n();
    renderPaperSwatches();
    syncUI();
  }

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
      ? t('sheetTitleLibrary')
      : t('sheetTitleFree');
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
        name: state.freeTitle || t('defaultFreeTitle'),
        enName: state.lang === 'en' ? 'Custom Free Fold' : '자유 창작 스튜디오',
        steps: state.freeSteps,
        paper: state.freePaper,
      };
    }
    return ORIGAMI_CATALOG.find(m => m.id === state.selectedId) || ORIGAMI_CATALOG[0];
  }

  function getLocalizedActiveModel() {
    return localizeModel(getActiveModel(), state.lang);
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

  // ---- Adaptive 3D Paper Bounds & Auto-Framing ----
  function computePaperBounds(faces) {
    if (!faces || !faces.length) return { center: v3(0, 0, 0), radius: 1.414 };
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < faces.length; i++) {
      const pts = faces[i].pts;
      for (let k = 0; k < pts.length; k++) {
        const p = pts[k];
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
        if (p.z < minZ) minZ = p.z;
        if (p.z > maxZ) maxZ = p.z;
      }
    }
    if (!Number.isFinite(minX)) return { center: v3(0, 0, 0), radius: 1.414 };
    const center = v3((minX + maxX) * 0.5, (minY + maxY) * 0.5, (minZ + maxZ) * 0.5);
    const radius = Math.max(0.24, 0.5 * Math.hypot(maxX - minX, maxY - minY, maxZ - minZ));
    return { center, radius };
  }

  function idealDistanceForRadius(radius) {
    const factor = isMobileViewport() ? 3.08 : 3.16;
    return Math.max(1.25, Math.min(6.4, radius * factor));
  }

  function getCurrentPaperBounds() {
    const frame = evaluateAtPos(state.playPos);
    return computePaperBounds(frame.faces);
  }

  // ---- Model & Mode Switching ----
  function selectLibraryModel(id, autoPlay = true) {
    state.mode = 'library';
    state.selectedId = id;
    state.userZoomScale = 1.0;
    clearInteractiveDraft();
    rebuildCompiledTimeline();
    state.playPos = 0;
    state.stepHoldTimer = 0;
    state.playing = autoPlay;
    const model = getActiveModel();
    const bounds = getCurrentPaperBounds();
    if (model.defaultCamera) {
      state.targetCamera = { ...model.defaultCamera, target: bounds.center };
    }
    if (isMobileViewport()) closeSheet();
    syncUI();
  }

  function switchMode(newMode) {
    if (state.mode === newMode) return;
    state.mode = newMode;
    state.userZoomScale = 1.0;
    clearInteractiveDraft();
    rebuildCompiledTimeline();
    if (newMode === 'free') {
      state.playing = false;
      state.playPos = state.freeSteps.length;
      const bounds = getCurrentPaperBounds();
      state.targetCamera = {
        yaw: 0.0,
        pitch: 0.14,
        distance: idealDistanceForRadius(bounds.radius),
        target: bounds.center,
      };
    } else {
      const m = getActiveModel();
      const bounds = getCurrentPaperBounds();
      if (m.defaultCamera) state.targetCamera = { ...m.defaultCamera, target: bounds.center };
    }
    if (isMobileViewport()) closeSheet();
    syncUI();
  }

  function branchCurrentToFreeStudio() {
    const model = getActiveModel();
    if (typeof model.evaluate === 'function') return;
    const loc = localizeModel(model, state.lang);
    const enLoc = localizeModel(model, 'en');
    const koLoc = localizeModel(model, 'ko');
    state.freeTitle = `${loc.displayName} ${t('customSuffix')}`;
    state.freePaper = { ...(model.paper || { width: 2, height: 2, rotationDeg: 0 }) };
    state.freeSteps = model.steps.map((s, idx) => ({
      ...JSON.parse(JSON.stringify(s)),
      labelEn: enLoc.displaySteps[idx]?.displayLabel || s.label,
      labelKo: koLoc.displaySteps[idx]?.displayLabel || s.label,
      techniqueEn: enLoc.displaySteps[idx]?.displayTech || s.technique,
      techniqueKo: koLoc.displaySteps[idx]?.displayTech || s.technique,
      descEn: enLoc.displaySteps[idx]?.displayDesc || s.desc || '',
      descKo: koLoc.displaySteps[idx]?.displayDesc || s.desc || '',
    }));
    state.freeRedo = [];
    state.mode = 'free';
    state.userZoomScale = 1.0;
    clearInteractiveDraft();
    rebuildCompiledTimeline();
    state.playing = false;
    state.playPos = state.freeSteps.length;
    const bounds = getCurrentPaperBounds();
    state.targetCamera = {
      yaw: 0.12,
      pitch: 0.18,
      distance: idealDistanceForRadius(bounds.radius),
      target: bounds.center,
    };
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
    state.dragIsUnfold = false;
    state.dragUnfoldGhost = null;
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

  function unfoldLastFreeStep() {
    if (state.mode !== 'free' || !state.compiledPlanar || state.compiledPlanar.activeFoldCount === 0) return;
    if (isMobileViewport()) closeSheet();
    const topStep = state.freeSteps.slice().reverse().find(s => !['unfoldLast', 'unfoldAll', 'precrease', 'flip', 'rotate'].includes(s.type));
    const enLbl = topStep?.labelEn || '';
    const koLbl = topStep?.labelKo || topStep?.label || '';
    addFreeStep({
      type: 'unfoldLast',
      label: UI_STRINGS.en.freeStepUnfoldLast(enLbl),
      labelEn: UI_STRINGS.en.freeStepUnfoldLast(enLbl),
      labelKo: UI_STRINGS.ko.freeStepUnfoldLast(koLbl),
      technique: 'Unfold',
      techniqueEn: UI_STRINGS.en.freeStepUnfoldTech,
      techniqueKo: UI_STRINGS.ko.freeStepUnfoldTech,
      descEn: UI_STRINGS.en.freeStepUnfoldLastDesc,
      descKo: UI_STRINGS.ko.freeStepUnfoldLastDesc,
    });
  }

  function unfoldAllFreeSteps() {
    if (state.mode !== 'free' || !state.compiledPlanar || state.compiledPlanar.activeFoldCount === 0) return;
    if (isMobileViewport()) closeSheet();
    addFreeStep({
      type: 'unfoldAll',
      label: UI_STRINGS.en.freeStepUnfoldAll,
      labelEn: UI_STRINGS.en.freeStepUnfoldAll,
      labelKo: UI_STRINGS.ko.freeStepUnfoldAll,
      technique: 'Unfold',
      techniqueEn: UI_STRINGS.en.freeStepUnfoldTech,
      techniqueKo: UI_STRINGS.ko.freeStepUnfoldTech,
      descEn: UI_STRINGS.en.freeStepUnfoldAllDesc,
      descKo: UI_STRINGS.ko.freeStepUnfoldAllDesc,
    });
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
    state.userZoomScale = 1.0;
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
      diag: { type: 'valley', p1: [-1, -1], p2: [1, 1], side: -1, angleDeg: 180, layerScope: scope, label: 'Diagonal Valley Fold', labelEn: 'Diagonal Valley Fold', labelKo: '대각선 계곡 접기', techniqueEn: 'Valley Fold', techniqueKo: '계곡 접기' },
      halfV: { type: 'valley', p1: [0, -1], p2: [0, 1], side: -1, angleDeg: 180, layerScope: scope, label: 'Vertical Half Fold', labelEn: 'Vertical Half Fold', labelKo: '세로 반 접기', techniqueEn: 'Valley Fold', techniqueKo: '계곡 접기' },
      halfH: { type: 'valley', p1: [-1, 0], p2: [1, 0], side: 1, angleDeg: 180, layerScope: scope, label: 'Horizontal Half Fold', labelEn: 'Horizontal Half Fold', labelKo: '가로 반 접기', techniqueEn: 'Valley Fold', techniqueKo: '계곡 접기' },
      kite: {
        type: 'multiFold', label: 'Kite Fold', labelEn: 'Kite Fold', labelKo: '아이스크림 접기 (Kite)', techniqueEn: 'Kite Fold', techniqueKo: '아이스크림 접기',
        folds: [
          { p1: [0, 1], p2: [1, 0], side: 1, foldType: 'valley', angleDeg: 180, layerScope: scope },
          { p1: [-1, 0], p2: [0, 1], side: 1, foldType: 'valley', angleDeg: 180, layerScope: scope },
        ],
      },
      blintz: {
        type: 'multiFold', label: 'Blintz Fold (4 Corners)', labelEn: 'Blintz Fold (4 Corners)', labelKo: '방석 접기 (4모서리)', techniqueEn: 'Blintz Fold', techniqueKo: '방석 접기',
        folds: [
          { p1: [0, 1], p2: [1, 0], side: 1, foldType: 'valley', angleDeg: 180 },
          { p1: [-1, 0], p2: [0, 1], side: 1, foldType: 'valley', angleDeg: 180 },
          { p1: [-1, 0], p2: [0, -1], side: -1, foldType: 'valley', angleDeg: 180 },
          { p1: [0, -1], p2: [1, 0], side: -1, foldType: 'valley', angleDeg: 180 },
        ],
      },
      pleat: { type: 'pleat', p1: [-0.25, -1], p2: [-0.25, 1], side: -1, offset: state.freePleatOffset, angleDeg: 165, layerScope: scope, label: 'Pleat Fold', labelEn: 'Pleat Fold', labelKo: '계단 접기 (Pleat)', techniqueEn: 'Pleat Fold', techniqueKo: '계단 접기' },
      flip: { type: 'flip', axis: 'y', label: 'Flip Paper', labelEn: 'Flip Paper', labelKo: '종이 뒤집기', techniqueEn: 'Flip', techniqueKo: '뒤집기' },
      rot90: { type: 'rotate', angleDeg: 90, label: 'Rotate 90°', labelEn: 'Rotate 90°', labelKo: '90° 회전', techniqueEn: 'Rotate', techniqueKo: '회전' },
      rot45: { type: 'rotate', angleDeg: 45, label: 'Rotate 45°', labelEn: 'Rotate 45°', labelKo: '45° 회전', techniqueEn: 'Rotate', techniqueKo: '회전' },
    };
    if (isMobileViewport()) closeSheet();
    if (macroId === 'accordion') {
      addFreeStep({ type: 'pleat', p1: [-0.45, -1], p2: [-0.45, 1], side: -1, offset: 0.25, angleDeg: 155, layerScope: scope, label: 'Accordion Pleat 1', labelEn: 'Accordion Pleat 1', labelKo: '아코디언 1단 주름', techniqueEn: 'Pleat Fold', techniqueKo: '계단 접기' });
      addFreeStep({ type: 'pleat', p1: [0.15, -1], p2: [0.15, 1], side: -1, offset: 0.25, angleDeg: 155, layerScope: scope, label: 'Accordion Pleat 2', labelEn: 'Accordion Pleat 2', labelKo: '아코디언 2단 주름', techniqueEn: 'Pleat Fold', techniqueKo: '계단 접기' });
      return;
    }
    if (macroId === 'grid') {
      addFreeStep({ type: 'precrease', p1: [0, -1], p2: [0, 1], side: -1, label: 'Vertical Center Pre-crease', labelEn: 'Vertical Center Pre-crease', labelKo: '세로 중심 예비선', techniqueEn: 'Pre-crease', techniqueKo: '접었다 펴기' });
      addFreeStep({ type: 'precrease', p1: [-1, 0], p2: [1, 0], side: 1, label: 'Horizontal Center Pre-crease', labelEn: 'Horizontal Center Pre-crease', labelKo: '가로 중심 예비선', techniqueEn: 'Pre-crease', techniqueKo: '접었다 펴기' });
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

  function findUnfoldPairForPoint(pt) {
    const hint = state.compiledPlanar?.topUnfoldHint;
    if (!hint || !hint.pairs || !pt) return null;
    let best = null;
    let bestD = 0.36;
    for (const pair of hint.pairs) {
      const d = Math.hypot(pair.folded.x - pt.x, pair.folded.y - pt.y);
      if (d < bestD) {
        bestD = d;
        best = pair;
      }
    }
    return best;
  }

  function updateDirectDragFold(sx, sy, w, h) {
    if (!state.dragStart || !lastCam || !state.compiledPlanar) return;
    const snapRadius = isMobileViewport() ? 36 : 26;
    const raw = screenToPlane(sx, sy, w, h, lastCam, v3(0, 0, 0), v3(0, 0, 1));
    const rawPt = raw ? v3(raw.x, raw.y, 0) : state.dragStart;

    // 1. Check Direct Drag-to-Unfold: pulling a folded corner/edge back past its hinge toward its original unfolded position!
    const unfoldPair = findUnfoldPairForPoint(state.dragStart);
    state.dragUnfoldGhost = unfoldPair ? unfoldPair.unfolded : null;

    if (unfoldPair && state.compiledPlanar.topUnfoldHint) {
      const ux = unfoldPair.unfolded.x - unfoldPair.folded.x;
      const uy = unfoldPair.unfolded.y - unfoldPair.folded.y;
      const uLen = Math.hypot(ux, uy);
      if (uLen > 0.16) {
        const dxU = rawPt.x - state.dragStart.x;
        const dyU = rawPt.y - state.dragStart.y;
        const proj = (dxU * ux + dyU * uy) / uLen;
        const perp = Math.abs(dxU * (-uy) + dyU * ux) / uLen;

        // Crossing past the hinge line (proj > 0.52 * uLen) into the unfolded side triggers live 3D Unfold!
        if (proj > uLen * 0.52 && perp < Math.max(0.48, proj * 0.65)) {
          const distToOrigin = Math.hypot(rawPt.x - unfoldPair.unfolded.x, rawPt.y - unfoldPair.unfolded.y);
          const snapped = distToOrigin < 0.42 || proj >= uLen * 0.88;
          const topStep = state.freeSteps.slice().reverse().find(s => !['unfoldLast', 'unfoldAll', 'precrease', 'flip', 'rotate'].includes(s.type));
          const enLbl = topStep?.labelEn || '';
          const koLbl = topStep?.labelKo || topStep?.label || '';
          state.dragIsUnfold = true;
          state.dragCurrent = snapped ? v3(unfoldPair.unfolded.x, unfoldPair.unfolded.y, 0) : rawPt;
          state.dragSnapLabel = snapped ? t('unfoldSnapOrigin') : t('unfoldDragOut');
          state.dragCrease = null;
          state.dragLiveStep = {
            type: 'unfoldLast',
            label: UI_STRINGS.en.freeStepUnfoldLast(enLbl),
            labelEn: UI_STRINGS.en.freeStepUnfoldLast(enLbl),
            labelKo: UI_STRINGS.ko.freeStepUnfoldLast(koLbl),
            technique: 'Unfold',
            techniqueEn: UI_STRINGS.en.freeStepUnfoldTech,
            techniqueKo: UI_STRINGS.ko.freeStepUnfoldTech,
            descEn: UI_STRINGS.en.freeStepUnfoldLastDesc,
            descKo: UI_STRINGS.ko.freeStepUnfoldLastDesc,
          };
          state.dragLiveCompiled = { evaluate: state.compiledPlanar.topUnfoldHint.evaluateUnfold };
          state.dragLiveT = snapped ? 0.94 : Math.max(0.22, Math.min(0.92, proj / uLen));
          return;
        }
      }
    }

    // 2. Standard Direct Drag-to-Fold (Huzita-Hatori Axiom 2)
    state.dragIsUnfold = false;
    const snapTarget = findNearestSnap(sx, sy, w, h, snapRadius, state.dragStart);
    const cur = snapTarget ? v3(snapTarget.x, snapTarget.y, 0) : rawPt;

    state.dragCurrent = cur;
    const snapKey = snapTarget
      ? (snapTarget.kind === 'vertex' ? 'snapVertex' : snapTarget.kind === 'center' ? 'snapCenter' : 'snapMid')
      : '';
    state.dragSnapLabel = snapKey ? t(snapKey) : '';

    const dx = cur.x - state.dragStart.x;
    const dy = cur.y - state.dragStart.y;
    const dLen = Math.hypot(dx, dy);

    const paperBounds = computePaperBounds(state.compiledPlanar.finalState.faces);
    const minDrag = Math.max(0.035, Math.min(0.14, paperBounds.radius * 0.12));
    if (dLen < minDrag) {
      state.dragCrease = null;
      state.dragLiveStep = null;
      state.dragLiveCompiled = null;
      state.dragLiveT = 0;
      return;
    }

    // Huzita-Hatori Axiom 2: exact perpendicular bisector bringing dragStart onto cur!
    const mid = v3((state.dragStart.x + cur.x) * 0.5, (state.dragStart.y + cur.y) * 0.5, 0);
    const dir = norm(v3(-dy, dx, 0));
    const halfCrease = Math.max(0.45, Math.min(1.45, paperBounds.radius * 1.15));
    const p1 = v3(mid.x - dir.x * halfCrease, mid.y - dir.y * halfCrease, 0);
    const p2 = v3(mid.x + dir.x * halfCrease, mid.y + dir.y * halfCrease, 0);
    const leftNormal = norm(cross(v3(0, 0, 1), dir));
    const side = dot(sub(state.dragStart, mid), leftNormal) >= 0 ? 1 : -1;

    const toolNamesEn = { valley: 'Valley Fold', mountain: 'Mountain Fold', precrease: 'Pre-crease', pleat: 'Pleat Fold' };
    const toolNamesKo = { valley: '계곡 접기', mountain: '산 접기', precrease: '접었다 펴기', pleat: '계단 접기' };
    const sufEn = snapKey ? ` · ${UI_STRINGS.en[snapKey]}` : '';
    const sufKo = snapKey ? ` · ${UI_STRINGS.ko[snapKey]}` : '';
    const liveStep = {
      type: state.freeTool,
      p1: [p1.x, p1.y],
      p2: [p2.x, p2.y],
      side,
      angleDeg: state.freeAngle,
      layerScope: state.freeLayerScope,
      offset: state.freePleatOffset,
      label: `${toolNamesEn[state.freeTool]}${sufEn}`,
      labelEn: `${toolNamesEn[state.freeTool]}${sufEn}`,
      labelKo: `${toolNamesKo[state.freeTool]}${sufKo}`,
      technique: toolNamesEn[state.freeTool],
      techniqueEn: toolNamesEn[state.freeTool],
      techniqueKo: toolNamesKo[state.freeTool],
    };

    state.dragCrease = { p1, p2 };
    state.dragLiveStep = liveStep;
    state.dragLiveCompiled = compilePlanarStep(state.compiledPlanar.finalState, liveStep);
    // Real-time 3D preview angle follows drag distance & snaps close to finished when locked on target!
    const liveScale = Math.max(0.32, paperBounds.radius * 1.1);
    state.dragLiveT = snapTarget ? 0.88 : Math.min(0.84, 0.25 + (dLen / liveScale) * 0.62);
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

    // Decide 1-finger gesture: Direct Drag-to-Fold/Unfold vs Orbit!
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
        const unfoldPair = findUnfoldPairForPoint(startPt);
        gestureMode = 'drag-fold';
        state.dragFoldActive = true;
        state.dragStart = startPt;
        state.dragCurrent = startPt;
        state.dragSnapLabel = '';
        state.dragCrease = null;
        state.dragLiveStep = null;
        state.dragLiveCompiled = null;
        state.dragIsUnfold = false;
        state.dragUnfoldGhost = unfoldPair ? unfoldPair.unfolded : null;
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
      state.camera.distance = Math.max(1.05, Math.min(8.4, pinchStartCamDist * ratio));
      if (state.mode === 'free') {
        const ideal = idealDistanceForRadius(getCurrentPaperBounds().radius);
        state.userZoomScale = Math.max(0.55, Math.min(2.2, state.camera.distance / ideal));
      }
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
      const toolNamesEn = { valley: 'Valley Fold', mountain: 'Mountain Fold', precrease: 'Pre-crease', pleat: 'Pleat Fold' };
      const toolNamesKo = { valley: '계곡 접기', mountain: '산 접기', precrease: '접었다 펴기', pleat: '계단 접기' };
      addFreeStep({
        type: state.freeTool,
        p1: [state.pickP1.x, state.pickP1.y],
        p2: [state.pickP2.x, state.pickP2.y],
        side,
        angleDeg: state.freeAngle,
        layerScope: state.freeLayerScope,
        offset: state.freePleatOffset,
        label: `${toolNamesEn[state.freeTool]} (${state.freeAngle}°)`,
        labelEn: `${toolNamesEn[state.freeTool]} (${state.freeAngle}°)`,
        labelKo: `${toolNamesKo[state.freeTool]} (${state.freeAngle}°)`,
        technique: toolNamesEn[state.freeTool],
        techniqueEn: toolNamesEn[state.freeTool],
        techniqueKo: toolNamesKo[state.freeTool],
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
    state.camera.distance = Math.max(1.05, Math.min(8.4, state.camera.distance * (1 + e.deltaY * 0.001)));
    if (state.mode === 'free') {
      const ideal = idealDistanceForRadius(getCurrentPaperBounds().radius);
      state.userZoomScale = Math.max(0.55, Math.min(2.2, state.camera.distance / ideal));
    }
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

    for (const rawItem of ORIGAMI_CATALOG) {
      const item = localizeModel(rawItem, state.lang);
      const btn = document.createElement('button');
      btn.className = `catalog-item ${state.selectedId === item.id ? 'active' : ''}`;
      btn.innerHTML = `
        <div class="catalog-item-top">
          <span class="catalog-item-name">${item.displayName}</span>
          <span class="catalog-diff">${item.displayDiff}</span>
        </div>
        <div class="catalog-item-sub">${item.displaySub} · ${t('stepCountUnit', item.steps.length)}</div>
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
    const names = UI_STRINGS[state.lang].paperNames || {};
    for (const p of PAPER_PRESETS) {
      const sw = document.createElement('button');
      sw.className = `swatch-btn ${state.frontColor === p.front ? 'active' : ''}`;
      sw.title = names[p.id] || p.name;
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
    const model = getLocalizedActiveModel();
    list.innerHTML = '';

    if (model.displaySteps.length === 0) {
      list.innerHTML = `<div class="empty-steps">${t('emptyTimelineHint')}</div>`;
      return;
    }

    const activeIdx = Math.min(model.displaySteps.length - 1, Math.floor(state.playPos));
    model.displaySteps.forEach((s, idx) => {
      const pill = document.createElement('div');
      pill.className = `step-pill ${idx === activeIdx ? 'active' : idx < activeIdx ? 'done' : ''}`;
      pill.innerHTML = `
        <span class="step-num">${idx + 1}</span>
        <span class="step-txt">${s.displayLabel || s.displayTech}</span>
        ${state.mode === 'free' ? `<button class="step-del" title="${t('stepDeleteTitle')}" data-del="${idx}">×</button>` : ''}
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
    const canUnfold = (state.compiledPlanar?.activeFoldCount || 0) > 0;
    if (state.freeInteractMode === 'drag') {
      if (state.dragFoldActive) {
        if (state.dragIsUnfold) {
          textEl.textContent = t('bannerDragUnfoldActive');
        } else {
          textEl.textContent = state.dragSnapLabel
            ? t('bannerDragActiveSnap', state.dragSnapLabel)
            : t('bannerDragActiveNoSnap');
        }
      } else if (canUnfold) {
        textEl.textContent = isMobileViewport()
          ? t('bannerDragUnfoldMobile')
          : t('bannerDragUnfoldDesktop');
      } else {
        textEl.textContent = t('bannerDragIdle');
      }
    } else if (state.freeInteractMode === 'orbit') {
      textEl.textContent = t('bannerOrbit');
    } else {
      if (!state.pickP1) textEl.textContent = t('bannerLine1');
      else if (!state.pickP2) textEl.textContent = t('bannerLine2');
      else textEl.textContent = t('bannerLine3');
    }
  }

  function syncPlaybackControls() {
    const model = getLocalizedActiveModel();
    const total = model.displaySteps.length;
    const slider = $('timeline-slider');
    slider.max = String(Math.max(1, total));
    slider.value = String(Math.min(total, state.playPos));
    slider.disabled = total === 0;

    $('btn-play').innerHTML = state.playing
      ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg> ${t('btnPause')}`
      : `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="6,4 20,12 6,20"/></svg> ${t('btnPlay')}`;
    $('mob-play').textContent = state.playing ? t('mobPause') : t('mobPlay');

    const curIdx = total > 0 ? Math.min(total - 1, Math.floor(state.playPos)) : -1;
    const stepObj = curIdx >= 0 ? model.displaySteps[curIdx] : null;
    $('hud-step-counter').textContent = total > 0 ? `STEP ${curIdx + 1} / ${total}` : 'STEP 0 / 0';
    $('hud-step-title').textContent = stepObj ? (stepObj.displayLabel || stepObj.displayTech) : t('emptyStepTitle');
    $('hud-step-desc').textContent = stepObj?.displayDesc || (state.mode === 'free'
      ? t('emptyStepDesc')
      : model.displaySummary);

    const pills = $('step-pills').children;
    for (let i = 0; i < pills.length; i++) {
      pills[i].classList.toggle('active', i === curIdx);
      pills[i].classList.toggle('done', i < curIdx);
    }
  }

  function syncMobileBar() {
    $('mob-bar-library').style.display = state.mode === 'library' ? 'flex' : 'none';
    $('mob-bar-free').style.display = state.mode === 'free' ? 'flex' : 'none';

    const interactLabels = {
      drag: t('mobInteractDrag'),
      line: t('mobInteractLine'),
      orbit: t('mobInteractOrbit'),
    };
    $('mob-interact-toggle').textContent = interactLabels[state.freeInteractMode];

    const isMountain = state.freeTool === 'mountain';
    const dirBtn = $('mob-fold-dir');
    dirBtn.textContent = isMountain ? t('mobMountain') : t('mobValley');
    dirBtn.classList.toggle('mountain', isMountain);
    const canUnfold = (state.compiledPlanar?.activeFoldCount || 0) > 0;
    $('mob-unfold').disabled = !canUnfold;
    $('mob-undo').disabled = state.freeSteps.length === 0;
  }

  function syncUI() {
    $('tab-library').classList.toggle('active', state.mode === 'library');
    $('tab-free').classList.toggle('active', state.mode === 'free');
    $('panel-library').style.display = state.mode === 'library' ? 'flex' : 'none';
    $('panel-free').style.display = state.mode === 'free' ? 'flex' : 'none';
    $('sheet-title').textContent = state.mode === 'library' ? t('sheetTitleLibrary') : t('sheetTitleFree');

    const model = getLocalizedActiveModel();
    $('work-title-badge').textContent = model.displayName;
    $('work-subtitle').textContent = model.displaySub;

    const infoCard = $('library-info-card');
    if (state.mode === 'library') {
      const canBranch = typeof model.evaluate !== 'function';
      infoCard.innerHTML = `
        <div class="info-head">
          <span class="info-badge">${model.displayBadge}</span>
          <span class="info-diff">${model.displayDiff}</span>
        </div>
        <p class="info-summary">${model.displaySummary}</p>
        ${model.displaySymbol ? `<div class="info-meta"><b>${t('metaSymbol')}</b> ${model.displaySymbol}</div>` : ''}
        ${model.displayUsage ? `<div class="info-meta"><b>${t('metaUsage')}</b> ${model.displayUsage}</div>` : ''}
        ${canBranch ? `<button id="btn-branch-free" class="btn-secondary full-w" style="margin-top:8px;">${t('btnBranchFree')}</button>` : ''}
      `;
      const branchBtn = $('btn-branch-free');
      if (branchBtn) branchBtn.addEventListener('click', branchCurrentToFreeStudio);
    }

    if (state.mode === 'free') {
      const canUnfold = (state.compiledPlanar?.activeFoldCount || 0) > 0;
      $('free-title-input').value = state.freeTitle;
      $('btn-unfold-last').disabled = !canUnfold;
      $('btn-unfold-all').disabled = !canUnfold;
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

    // If user is actively Drag-to-Folding or Drag-to-Unfolding, render the LIVE 3D mesh directly!
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
          dragIsUnfold: state.dragIsUnfold,
          unfoldGhost: state.dragUnfoldGhost,
          unfoldGhostLabel: t('unfoldBadge'),
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

    // Smooth camera transitions & continuous auto-framing around the paper's true 3D center
    if (!state.dragFoldActive) {
      const bounds = getCurrentPaperBounds();
      if (state.targetCamera) {
        const k = Math.min(1, dt * 8);
        const tgt = state.targetCamera.target || bounds.center;
        state.camera.yaw += (state.targetCamera.yaw - state.camera.yaw) * k;
        state.camera.pitch += (state.targetCamera.pitch - state.camera.pitch) * k;
        state.camera.distance += (state.targetCamera.distance - state.camera.distance) * k;
        state.camera.target.x += (tgt.x - state.camera.target.x) * k;
        state.camera.target.y += (tgt.y - state.camera.target.y) * k;
        state.camera.target.z += (tgt.z - state.camera.target.z) * k;
        if (
          Math.abs(state.targetCamera.yaw - state.camera.yaw) < 0.002 &&
          Math.abs(state.targetCamera.pitch - state.camera.pitch) < 0.002 &&
          Math.abs(state.targetCamera.distance - state.camera.distance) < 0.005 &&
          Math.hypot(tgt.x - state.camera.target.x, tgt.y - state.camera.target.y, tgt.z - state.camera.target.z) < 0.004
        ) {
          state.camera.yaw = state.targetCamera.yaw;
          state.camera.pitch = state.targetCamera.pitch;
          state.camera.distance = state.targetCamera.distance;
          state.camera.target = { x: tgt.x, y: tgt.y, z: tgt.z };
          state.targetCamera = null;
        }
      } else {
        if (state.autoOrbit) {
          state.camera.yaw += dt * 0.48;
        }
        // Keep the paper smoothly centered as folds shift its centroid
        const kCenter = 1 - Math.exp(-dt * 6.5);
        state.camera.target.x += (bounds.center.x - state.camera.target.x) * kCenter;
        state.camera.target.y += (bounds.center.y - state.camera.target.y) * kCenter;
        state.camera.target.z += (bounds.center.z - state.camera.target.z) * kCenter;

        // In Free Studio, smoothly keep the paper comfortably sized even after many consecutive folds
        if (state.mode === 'free' && gestureMode !== 'pinch') {
          const desiredDist = Math.max(1.05, Math.min(8.4, idealDistanceForRadius(bounds.radius) * state.userZoomScale));
          const kDist = 1 - Math.exp(-dt * 5.0);
          state.camera.distance += (desiredDist - state.camera.distance) * kDist;
        }
      }
    }

    renderAll();
    requestAnimationFrame(tick);
  }

  // ---- FULL-PROCESS GIF EXPORT STUDIO ----
  function openGifModal() {
    closeSheet();
    const model = getLocalizedActiveModel();
    $('gif-modal').classList.add('open');
    $('gif-work-name').textContent = t('gifWorkSub', model.displayName, model.displaySteps.length);
    $('gif-progress-wrap').style.display = 'none';
    $('gif-result-wrap').style.display = 'none';
    $('gif-start-btn').disabled = false;
    $('gif-start-btn').textContent = t('gifStartBtn');
  }

  function closeGifModal() {
    if (state.gifBusy) state.gifCancel = true;
    $('gif-modal').classList.remove('open');
  }

  async function runFullProcessGifExport() {
    if (state.gifBusy) return;
    const model = getLocalizedActiveModel();
    const totalSteps = model.displaySteps.length;

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
    $('gif-progress-text').textContent = t('gifPreparing');

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
        label: totalSteps > 0 ? t('gifIntroLabel') : model.displayName,
        technique: t('gifIntroTech'), progress: 0,
      });
    }

    const totalAnimSteps = Math.max(1, totalSteps);
    for (let s = 0; s < totalSteps; s++) {
      const stepMeta = model.displaySteps[s];
      const stepLabel = stepMeta.displayLabel || stepMeta.displayTech || `Step ${s + 1}`;
      for (let f = 0; f < framesPerStep; f++) {
        const localT = f / (framesPerStep - 1);
        const globalFrac = (s + localT) / totalAnimSteps;
        const orbitOffset = camMode === 'orbit-spin' ? Math.sin(globalFrac * Math.PI * 2) * 0.34 : 0;
        schedule.push({
          pos: s + localT * 0.9999,
          yaw: baseYaw + orbitOffset,
          pitch: basePitch + (camMode === 'orbit-spin' ? Math.sin(globalFrac * Math.PI) * 0.08 : 0),
          dist: baseDist, delay: frameDelayMs, stepNum: s + 1,
          label: stepLabel,
          technique: stepMeta.displayTech || '', progress: globalFrac,
        });
      }
      schedule.push({
        pos: s + 0.9999,
        yaw: baseYaw + (camMode === 'orbit-spin' ? Math.sin(((s + 1) / totalAnimSteps) * Math.PI * 2) * 0.34 : 0),
        pitch: basePitch, dist: baseDist, delay: Math.round(frameDelayMs * holdFrames), stepNum: s + 1,
        label: stepLabel,
        technique: stepMeta.displayTech || '', progress: (s + 1) / totalAnimSteps,
      });
    }

    for (let f = 0; f < spinFrames; f++) {
      const frac = f / Math.max(1, spinFrames - 1);
      schedule.push({
        pos: totalSteps,
        yaw: includeSpin ? baseYaw + frac * Math.PI * 2 : baseYaw,
        pitch: basePitch + (includeSpin ? Math.sin(frac * Math.PI) * 0.14 : 0),
        dist: baseDist * (includeSpin ? 0.96 : 1.0), delay: frameDelayMs,
        stepNum: totalSteps, label: t('gifDoneLabel', model.displayName), technique: t('gifDoneTech'), progress: 1.0,
      });
    }

    const offCanvas = document.createElement('canvas');
    offCanvas.width = gw;
    offCanvas.height = gh;
    const offCtx = offCanvas.getContext('2d', { willReadFrequently: true });

    const encoder = new GifEncoder(gw, gh, 0);
    const totalFrames = schedule.length;
    const initBounds = computePaperBounds(evaluateAtPos(0).faces);
    const gifTarget = { x: initBounds.center.x, y: initBounds.center.y, z: initBounds.center.z };
    let gifDist = state.mode === 'free' ? idealDistanceForRadius(initBounds.radius) : baseDist;

    for (let i = 0; i < totalFrames; i++) {
      if (state.gifCancel) {
        state.gifBusy = false;
        $('gif-start-btn').disabled = false;
        return;
      }

      const item = schedule[i];
      const frameData = evaluateAtPos(item.pos);
      const fb = computePaperBounds(frameData.faces);
      gifTarget.x += (fb.center.x - gifTarget.x) * 0.28;
      gifTarget.y += (fb.center.y - gifTarget.y) * 0.28;
      gifTarget.z += (fb.center.z - gifTarget.z) * 0.28;
      if (state.mode === 'free') {
        const targetD = idealDistanceForRadius(fb.radius) * (item.dist / Math.max(0.1, baseDist));
        gifDist += (targetD - gifDist) * 0.24;
      } else {
        gifDist = item.dist;
      }

      renderOrigami3D(offCtx, gw, gh, frameData, {
        camera: { yaw: item.yaw, pitch: item.pitch, distance: gifDist, target: { ...gifTarget } },
        frontColor: state.frontColor, backColor: state.backColor, isDark: state.isDark,
        showGuides: state.showGuides && item.progress < 1.0,
        showWireframe: state.showWireframe, showShadow: true,
        hudOverlay: includeHud
          ? { title: model.displayName, stepLabel: item.label, technique: item.technique, stepNum: item.stepNum, totalSteps, progress: item.progress }
          : null,
      });

      encoder.addFrame(offCtx.getImageData(0, 0, gw, gh).data, item.delay);

      const pct = Math.round(((i + 1) / totalFrames) * 100);
      $('gif-progress-bar').style.width = `${pct}%`;
      $('gif-progress-text').textContent = t('gifEncoding', i + 1, totalFrames, pct);
      if (i % 3 === 0) await new Promise(r => setTimeout(r, 0));
    }

    const bytes = encoder.finish();
    if (state.gifBlobUrl) URL.revokeObjectURL(state.gifBlobUrl);
    state.gifBlobUrl = URL.createObjectURL(new Blob([bytes], { type: 'image/gif' }));
    state.gifFileName = `${(model.enName || model.id || 'origami').toLowerCase().replace(/[^a-z0-9]+/g, '-')}-3d-process.gif`;

    $('gif-preview-img').src = state.gifBlobUrl;
    $('gif-meta-info').textContent = t(
      'gifMeta',
      gw, gh, totalFrames,
      (schedule.reduce((a, b) => a + b.delay, 0) / 1000).toFixed(1),
      (bytes.length / 1024).toFixed(1)
    );
    $('gif-download-link').href = state.gifBlobUrl;
    $('gif-download-link').download = state.gifFileName;
    $('gif-progress-wrap').style.display = 'none';
    $('gif-result-wrap').style.display = 'block';
    $('gif-start-btn').disabled = false;
    $('gif-start-btn').textContent = t('gifRetryBtn');
    state.gifBusy = false;
  }

  // ---- Wire Up Event Listeners ----
  $('tab-library').addEventListener('click', () => switchMode('library'));
  $('tab-free').addEventListener('click', () => switchMode('free'));
  $('btn-lang-toggle').addEventListener('click', toggleLanguage);

  // Mobile sheet drawer & quick thumb bar listeners
  $('sheet-backdrop').addEventListener('click', closeSheet);
  $('sheet-close-btn').addEventListener('click', closeSheet);
  $('mob-open-library').addEventListener('click', openSheet);
  $('mob-open-tools').addEventListener('click', openSheet);
  $('mob-play').addEventListener('click', togglePlay);
  $('mob-prev').addEventListener('click', () => jumpToStep(Math.max(0, Math.ceil(state.playPos) - 1)));
  $('mob-next').addEventListener('click', () => jumpToStep(Math.min(getActiveModel().steps.length, Math.floor(state.playPos) + 1)));
  $('mob-undo').addEventListener('click', undoFreeStep);
  $('mob-unfold').addEventListener('click', unfoldLastFreeStep);
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

  // Camera presets (always re-center & auto-frame the current paper!)
  function applyCameraPreset(yaw, pitch, fallbackDist) {
    state.autoOrbit = false;
    state.userZoomScale = 1.0;
    const bounds = getCurrentPaperBounds();
    const dist = state.mode === 'free' ? idealDistanceForRadius(bounds.radius) : fallbackDist;
    state.targetCamera = { yaw, pitch, distance: dist, target: bounds.center };
  }
  $('cam-3d').addEventListener('click', () => applyCameraPreset(0.52, 0.38, 4.7));
  $('cam-front').addEventListener('click', () => applyCameraPreset(0.0, 0.02, 4.4));
  $('cam-side').addEventListener('click', () => applyCameraPreset(1.48, 0.22, 4.7));
  $('cam-top').addEventListener('click', () => applyCameraPreset(0.0, 1.32, 4.8));
  $('cam-spin').addEventListener('click', (e) => { state.autoOrbit = !state.autoOrbit; e.currentTarget.classList.toggle('active', state.autoOrbit); });

  // Playback controls
  $('btn-play').addEventListener('click', togglePlay);
  $('btn-restart').addEventListener('click', () => { state.playPos = 0; state.playing = true; state.stepHoldTimer = 0; syncPlaybackControls(); });
  $('btn-prev').addEventListener('click', () => jumpToStep(Math.max(0, Math.ceil(state.playPos) - 1)));
  $('btn-next').addEventListener('click', () => jumpToStep(Math.min(getActiveModel().steps.length, Math.floor(state.playPos) + 1)));
  $('timeline-slider').addEventListener('input', (e) => { state.playing = false; state.playPos = Number(e.target.value); syncPlaybackControls(); });
  $('speed-select').addEventListener('change', (e) => { state.playbackSpeed = Number(e.target.value); });

  // Free Fold Studio controls
  $('free-title-input').addEventListener('input', (e) => { state.freeTitle = e.target.value; $('work-title-badge').textContent = state.freeTitle || t('defaultFreeTitle'); });
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
  $('btn-unfold-last').addEventListener('click', unfoldLastFreeStep);
  $('btn-unfold-all').addEventListener('click', unfoldAllFreeSteps);
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
  applyStaticI18n();
  renderPaperSwatches();
  selectLibraryModel('model-crane', true);
  requestAnimationFrame(tick);
}
