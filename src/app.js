// ============================================================================
// app.js — Interactive 3D Origami Studio Controller (Desktop & Mobile Touch)
// Features: Direct Drag-to-Fold (Huzita-Hatori Axiom 2 live 3D folding!),
//           2-Point Precision Line Fold, Multi-Touch Pinch Zoom & Orbit,
//           Mobile Bottom Sheet Drawer, Timeline Scrubber & Full-Process GIF
// ============================================================================

import { v3, sub, dot, cross, norm, screenToPlane, worldToCamera, projectPoint } from './math3d.js';
import { compilePlanarTimeline, compilePlanarStep, computeSnapPoints, createInitialPaper, estimateBendRadius, bendTipOffset } from './planarEngine.js';
import { ORIGAMI_CATALOG, PAPER_PRESETS } from './kinematicModels.js';
import { renderOrigami3D, renderCreasePattern2D, computeLayerThick, isScreenPointOccluded } from './renderer3d.js';
import { GifEncoder } from './gifEncoder.js';
import { UI_STRINGS, getInitialLang, saveLang, localizeModel } from './i18n.js';
import { createPaperAudio } from './paperAudio.js';

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
    loopPlay: false,
    loopHoldTimer: 0,
    playbackSpeed: 1.0,
    pauseBetweenSteps: 0.42,
    stepHoldTimer: 0,
    lastScrolledStepIdx: -1,

    // 3D Orbit Camera
    camera: { yaw: 0.58, pitch: 0.34, distance: 4.8, target: v3(0, 0, 0) },
    targetCamera: null,
    userZoomScale: 1.0,

    // Free Fold Studio state
    freeTitle: UI_STRINGS[initLang].defaultFreeTitle,
    freePaper: { presetId: 'square', width: 2.0, height: 2.0, rotationDeg: 0, cmW: 15, cmH: 15 },
    freeSteps: [],
    freeRedo: [],
    freeTool: 'valley', // 'valley' | 'mountain' | 'precrease' | 'pleat'
    freeFoldDir: 'valley', // 'valley' (toward Front +Z) | 'mountain' (toward Back -Z)
    freeInteractMode: 'drag', // 'drag' | 'line' | 'orbit'
    freeAngle: 180,
    freeLayerScope: 'all', // 'all' | 'top'
    freePleatOffset: 0.25,
    freeMirror: false,
    restoredStepCount: 0,
    restoredToastShown: false,

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
    dragMirrorCrease: null,
    dragLiveStep: null,
    dragLiveCompiled: null,
    dragLiveT: 0,
    dragIsUnfold: false,
    dragUnfoldGhost: null,
    dragCancelZone: false,
    dragShiftFlip: false,
    dragAltFree: false,
    lastSnapId: '',
    // Physical drag model (corner follows the finger in 3D)
    dragProgress: 0,
    dragLift: 0.3,
    dragSpeed: 0,
    dragSpeedTarget: 0,
    dragLastMoveT: 0,
    dragPointer: null,
    dragSnapped: false,
    dragUnfoldArc: null,
    dragLiveKey: '',
    settle: null,
    creaseFlash: null,
    soundOn: true,

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

  // ---- Mobile Bottom Sheet Controls (+ Swipe-Down to Close) ----
  function openSheet() {
    state.sheetOpen = true;
    const sb = $('studio-sidebar');
    sb.style.transform = '';
    sb.classList.add('sheet-open');
    $('sheet-backdrop').classList.add('open');
    $('sheet-title').textContent = state.mode === 'library'
      ? t('sheetTitleLibrary')
      : t('sheetTitleFree');
  }

  function closeSheet() {
    state.sheetOpen = false;
    const sb = $('studio-sidebar');
    sb.style.transform = '';
    sb.classList.remove('sheet-dragging');
    sb.classList.remove('sheet-open');
    $('sheet-backdrop').classList.remove('open');
  }

  // Swipe down on mobile bottom sheet header handle to dismiss smoothly
  const sheetHeaderEl = document.querySelector('.sheet-header');
  if (sheetHeaderEl) {
    let sheetSwipeStartY = 0;
    let sheetSwipeDy = 0;
    let sheetSwiping = false;
    sheetHeaderEl.addEventListener('pointerdown', (e) => {
      if (!state.sheetOpen || e.target.closest('button')) return;
      sheetSwiping = true;
      sheetSwipeStartY = e.clientY;
      sheetSwipeDy = 0;
      $('studio-sidebar').classList.add('sheet-dragging');
      try { sheetHeaderEl.setPointerCapture(e.pointerId); } catch {}
    });
    sheetHeaderEl.addEventListener('pointermove', (e) => {
      if (!sheetSwiping) return;
      sheetSwipeDy = Math.max(0, e.clientY - sheetSwipeStartY);
      $('studio-sidebar').style.transform = `translateY(${sheetSwipeDy}px)`;
    });
    const finishSheetSwipe = () => {
      if (!sheetSwiping) return;
      sheetSwiping = false;
      const sb = $('studio-sidebar');
      sb.classList.remove('sheet-dragging');
      if (sheetSwipeDy > 72) {
        closeSheet();
      } else {
        sb.style.transform = '';
      }
    };
    sheetHeaderEl.addEventListener('pointerup', finishSheetSwipe);
    sheetHeaderEl.addEventListener('pointercancel', finishSheetSwipe);
  }

  // ---- Toast, Haptics, Auto-Save, Mirror, Loop & Shortcuts Helpers ----
  let toastTimer = null;
  function showToast(msg, durationMs = 2000) {
    const el = $('studio-toast');
    if (!el || !msg) return;
    el.textContent = msg;
    el.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.classList.remove('show'); }, durationMs);
  }

  const paperAudio = createPaperAudio(() => state.soundOn);

  function triggerHaptic(ms = 8) {
    try {
      if (isMobileViewport() && navigator.vibrate) navigator.vibrate(ms);
    } catch {
      // Ignore unsupported vibration environments
    }
  }

  const DRAFT_KEY = 'origami3d_free_draft_v1';
  function saveFreeDraft() {
    try {
      if (state.freeSteps.length === 0) {
        window.localStorage.removeItem(DRAFT_KEY);
        return;
      }
      window.localStorage.setItem(DRAFT_KEY, JSON.stringify({
        v: 1,
        title: state.freeTitle,
        paper: state.freePaper,
        steps: state.freeSteps,
        frontColor: state.frontColor,
        backColor: state.backColor,
        mirror: state.freeMirror,
        foldDir: state.freeFoldDir,
      }));
    } catch {
      // Ignore storage quota / private mode restrictions
    }
  }

  function loadFreeDraft() {
    try {
      const raw = window.localStorage.getItem(DRAFT_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (!data || !Array.isArray(data.steps) || data.steps.length === 0) return;
      state.freeSteps = data.steps;
      if (data.paper && typeof data.paper.width === 'number') state.freePaper = data.paper;
      if (typeof data.title === 'string' && data.title.trim()) state.freeTitle = data.title;
      if (typeof data.frontColor === 'string') {
        state.frontColor = data.frontColor;
        if ($('color-front')) $('color-front').value = data.frontColor;
      }
      if (typeof data.backColor === 'string') {
        state.backColor = data.backColor;
        if ($('color-back')) $('color-back').value = data.backColor;
      }
      state.freeMirror = !!data.mirror;
      if (data.foldDir === 'mountain' || data.foldDir === 'valley') {
        state.freeFoldDir = data.foldDir;
        if (state.freeTool === 'valley' || state.freeTool === 'mountain') {
          state.freeTool = data.foldDir;
        }
      }
      state.restoredStepCount = data.steps.length;
    } catch {
      // Ignore corrupted localStorage draft
    }
  }

  function clearFreeDraft() {
    try { window.localStorage.removeItem(DRAFT_KEY); } catch {}
  }

  function setFoldDir(dir) {
    const next = dir === 'mountain' ? 'mountain' : 'valley';
    state.freeFoldDir = next;
    if (state.freeTool === 'valley' || state.freeTool === 'mountain') {
      state.freeTool = next;
    }
    clearInteractiveDraft();
    saveFreeDraft();
    syncUI();
  }

  function setFoldTool(tool) {
    state.freeTool = tool;
    if (tool === 'valley' || tool === 'mountain') {
      state.freeFoldDir = tool;
    }
    clearInteractiveDraft();
    saveFreeDraft();
    syncUI();
  }

  function swapPaperColors() {
    const prevFront = state.frontColor;
    state.frontColor = state.backColor;
    state.backColor = prevFront;
    if ($('color-front')) $('color-front').value = state.frontColor;
    if ($('color-back')) $('color-back').value = state.backColor;
    renderPaperSwatches();
    saveFreeDraft();
    showToast(t('toastSwappedSides'), 1500);
  }

  function toggleMirrorFold() {
    state.freeMirror = !state.freeMirror;
    clearInteractiveDraft();
    saveFreeDraft();
    syncUI();
  }

  function toggleLoopPlay() {
    state.loopPlay = !state.loopPlay;
    state.loopHoldTimer = 0;
    syncPlaybackControls();
  }

  function openShortcutsModal() {
    closeSheet();
    if ($('shortcuts-modal')) $('shortcuts-modal').classList.add('open');
  }

  function closeShortcutsModal() {
    if ($('shortcuts-modal')) $('shortcuts-modal').classList.remove('open');
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
    finishSettleNow();
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
      if (state.restoredStepCount > 0 && !state.restoredToastShown) {
        state.restoredToastShown = true;
        showToast(t('toastRestored', state.restoredStepCount), 2600);
      }
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
    saveFreeDraft();
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
    state.dragMirrorCrease = null;
    state.dragLiveStep = null;
    state.dragLiveCompiled = null;
    state.dragLiveT = 0;
    state.dragIsUnfold = false;
    state.dragUnfoldGhost = null;
    state.dragCancelZone = false;
    state.dragShiftFlip = false;
    state.dragAltFree = false;
    state.dragPickedLayer = null;
    state.dragAutoFlap = false;
    state.lastSnapId = '';
    state.dragProgress = 0;
    state.dragPointer = null;
    state.dragSnapped = false;
    state.dragUnfoldArc = null;
    state.dragLiveKey = '';
  }

  // ---- Free Fold Actions ----
  function addFreeStep(step, startOffsetT = 0, alreadyFolded = false) {
    if (!alreadyFolded) finishSettleNow();
    state.freeSteps.push(step);
    state.freeRedo = [];
    clearInteractiveDraft();
    rebuildCompiledTimeline();
    // A fold that was physically dragged & pressed by hand is already in place: no replay
    state.playPos = alreadyFolded
      ? state.freeSteps.length
      : Math.max(0, state.freeSteps.length - 1 + startOffsetT);
    state.playing = !alreadyFolded;
    state.stepHoldTimer = 0;
    state.loopHoldTimer = 0;
    saveFreeDraft();
    syncUI();
  }

  function unfoldLastFreeStep() {
    finishSettleNow();
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
    finishSettleNow();
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
    finishSettleNow();
    if (state.freeSteps.length === 0) return;
    state.freeRedo.push(state.freeSteps.pop());
    clearInteractiveDraft();
    rebuildCompiledTimeline();
    state.playing = false;
    state.playPos = state.freeSteps.length;
    saveFreeDraft();
    syncUI();
  }

  function redoFreeStep() {
    finishSettleNow();
    if (state.freeRedo.length === 0) return;
    addFreeStep(state.freeRedo.pop());
  }

  const PAPER_SIZE_PRESETS = {
    square:  { id: 'square',  cmW: 15,   cmH: 15,   rotationDeg: 0,  nameKey: 'psSquare' },
    a4:      { id: 'a4',      cmW: 21,   cmH: 29.7, rotationDeg: 0,  nameKey: 'psA4' },
    letter:  { id: 'letter',  cmW: 21.6, cmH: 27.9, rotationDeg: 0,  nameKey: 'psLetter' },
    rect21:  { id: 'rect21',  cmW: 10,   cmH: 20,   rotationDeg: 0,  nameKey: 'psRect21' },
    bill:    { id: 'bill',    cmW: 15.6, cmH: 6.6,  rotationDeg: 0,  nameKey: 'psBill' },
    diamond: { id: 'diamond', cmW: 15,   cmH: 15,   rotationDeg: 45, nameKey: 'psDiamond' },
  };

  function makePaperSpec(cmW, cmH, rotationDeg = 0, presetId = 'custom') {
    const rw = Math.max(1, Math.min(100, Number(cmW) || 15));
    const rh = Math.max(1, Math.min(100, Number(cmH) || 15));
    let effW = rw, effH = rh;
    if (effW / effH > 4.0) effW = effH * 4.0;
    else if (effH / effW > 4.0) effH = effW * 4.0;
    const s = Math.sqrt(4.0 / (effW * effH));
    let width = effW * s;
    let height = effH * s;
    const maxDim = Math.max(width, height);
    if (maxDim > 2.68) {
      const shrink = 2.68 / maxDim;
      width *= shrink;
      height *= shrink;
    }
    return {
      presetId,
      width: Number(width.toFixed(4)),
      height: Number(height.toFixed(4)),
      rotationDeg,
      cmW: Number(rw.toFixed(1)),
      cmH: Number(rh.toFixed(1)),
    };
  }

  function formatRatioLabel(paper) {
    const w = paper?.width || 2;
    const h = paper?.height || 2;
    if (Math.abs(w - h) < 1e-3) return paper?.rotationDeg === 45 ? '1:1 ◇' : '1:1';
    const fmt = (v) => v.toFixed(2).replace(/\.?0+$/, '');
    return w > h ? `${fmt(w / h)}:1` : `1:${fmt(h / w)}`;
  }

  function setFreePaperSize(paperSpec, toastLabel = '') {
    finishSettleNow();
    state.freePaper = { ...paperSpec };
    state.freeSteps = [];
    state.freeRedo = [];
    state.userZoomScale = 1.0;
    state.restoredStepCount = 0;
    clearInteractiveDraft();
    rebuildCompiledTimeline();
    state.playing = false;
    state.playPos = 0;
    clearFreeDraft();
    const bounds = getCurrentPaperBounds();
    state.targetCamera = {
      yaw: state.camera.yaw,
      pitch: state.camera.pitch,
      distance: idealDistanceForRadius(bounds.radius),
      target: bounds.center,
    };
    syncUI();
    if (toastLabel) showToast(t('toastPaperSize', toastLabel), 2000);
    if (isMobileViewport()) closeSheet();
  }

  function applyPaperSizePreset(presetId) {
    const preset = PAPER_SIZE_PRESETS[presetId];
    if (!preset) return;
    const spec = makePaperSpec(preset.cmW, preset.cmH, preset.rotationDeg, preset.id);
    setFreePaperSize(spec, `${t(preset.nameKey)} (${formatRatioLabel(spec)})`);
  }

  function swapPaperOrientation() {
    const cur = state.freePaper;
    if (Math.abs(cur.width - cur.height) < 1e-3) {
      const nextRot = cur.rotationDeg === 45 ? 0 : 45;
      const nextPreset = nextRot === 45 ? 'diamond' : 'square';
      const spec = makePaperSpec(cur.cmW || 15, cur.cmH || 15, nextRot, nextPreset);
      setFreePaperSize(spec, `${t(PAPER_SIZE_PRESETS[nextPreset].nameKey)} (${formatRatioLabel(spec)})`);
      return;
    }
    const spec = makePaperSpec(cur.cmH || cur.height * 7.5, cur.cmW || cur.width * 7.5, cur.rotationDeg || 0, cur.presetId || 'custom');
    setFreePaperSize(spec, formatRatioLabel(spec));
  }

  function resetFreeStudio() {
    finishSettleNow();
    state.freeSteps = [];
    state.freeRedo = [];
    state.userZoomScale = 1.0;
    state.restoredStepCount = 0;
    clearInteractiveDraft();
    rebuildCompiledTimeline();
    state.playing = false;
    state.playPos = 0;
    clearFreeDraft();
    syncUI();
  }

  function deleteFreeStepAt(idx) {
    finishSettleNow();
    if (state.mode !== 'free') return;
    state.freeSteps.splice(idx, 1);
    state.freeRedo = [];
    clearInteractiveDraft();
    rebuildCompiledTimeline();
    state.playPos = Math.min(state.playPos, state.freeSteps.length);
    state.playing = false;
    saveFreeDraft();
    syncUI();
  }

  /**
   * True when the camera is currently facing the rear (-Z) side of the paper.
   * All Free Studio fold directions, layer scopes, and macros resolve relative
   * to whichever side of the paper the user is currently looking at.
   */
  function isViewingBackSide() {
    if (lastCam) return (lastCam.eye.z - lastCam.target.z) < 0;
    return Math.cos(state.camera.pitch) * Math.cos(state.camera.yaw) < 0;
  }

  function resolveWorldFoldDir(uiDir) {
    if (!isViewingBackSide()) return uiDir;
    return uiDir === 'mountain' ? 'valley' : 'mountain';
  }

  function resolveWorldLayerScope(uiScope = state.freeLayerScope) {
    if (!isViewingBackSide() || uiScope === 'all') return uiScope;
    return uiScope === 'top' ? 'bottom' : 'top';
  }

  function applyQuickMacro(macroId) {
    finishSettleNow();
    const viewingBack = isViewingBackSide();
    const xSign = viewingBack ? -1 : 1;
    const scope = resolveWorldLayerScope(state.freeLayerScope);
    const uiDir = state.freeFoldDir === 'mountain' ? 'mountain' : 'valley';
    const dir = resolveWorldFoldDir(uiDir);
    const isBack = uiDir === 'mountain';
    const ang = state.freeAngle;
    const hw = (state.freePaper?.width || 2) * 0.5;
    const hh = (state.freePaper?.height || 2) * 0.5;
    const m = Math.min(hw, hh);
    const dirWordEn = isBack ? 'Mountain' : 'Valley';
    const dirWordKo = isBack ? '뒷면(산)' : '앞면(계곡)';
    const dirTagEn = isBack ? ` (${UI_STRINGS.en.backDirSuffix})` : '';
    const dirTagKo = isBack ? ` (${UI_STRINGS.ko.backDirSuffix})` : '';
    const techEn = isBack ? 'Mountain Fold' : 'Valley Fold';
    const techKo = isBack ? '뒷면(산) 접기' : '앞면(계곡) 접기';
    const macros = {
      diag: { type: dir, p1: [-xSign * hw, -hh], p2: [xSign * hw, hh], side: -xSign, angleDeg: ang, layerScope: scope, label: `Diagonal ${dirWordEn} Fold`, labelEn: `Diagonal ${dirWordEn} Fold`, labelKo: `대각선 ${dirWordKo} 접기`, techniqueEn: techEn, techniqueKo: techKo },
      halfV: { type: dir, p1: [0, -hh], p2: [0, hh], side: -xSign, angleDeg: ang, layerScope: scope, label: `Vertical Half Fold${dirTagEn}`, labelEn: `Vertical Half Fold${dirTagEn}`, labelKo: `세로 반 접기${dirTagKo}`, techniqueEn: techEn, techniqueKo: techKo },
      halfH: { type: dir, p1: [-hw, 0], p2: [hw, 0], side: 1, angleDeg: ang, layerScope: scope, label: `Horizontal Half Fold${dirTagEn}`, labelEn: `Horizontal Half Fold${dirTagEn}`, labelKo: `가로 반 접기${dirTagKo}`, techniqueEn: techEn, techniqueKo: techKo },
      kite: {
        type: 'multiFold', label: `Kite Fold${dirTagEn}`, labelEn: `Kite Fold${dirTagEn}`, labelKo: `아이스크림 접기${dirTagKo}`, techniqueEn: 'Kite Fold', techniqueKo: '아이스크림 접기',
        folds: [
          { p1: [hw - m, hh], p2: [hw, hh - m], side: 1, foldType: dir, angleDeg: ang, layerScope: scope },
          { p1: [-hw, hh - m], p2: [-hw + m, hh], side: 1, foldType: dir, angleDeg: ang, layerScope: scope },
        ],
      },
      blintz: {
        type: 'multiFold', label: `Blintz Fold${dirTagEn}`, labelEn: `Blintz Fold (4 Corners)${dirTagEn}`, labelKo: `방석 접기 (4모서리)${dirTagKo}`, techniqueEn: 'Blintz Fold', techniqueKo: '방석 접기',
        folds: [
          { p1: [hw - m, hh], p2: [hw, hh - m], side: 1, foldType: dir, angleDeg: ang, layerScope: scope },
          { p1: [-hw, hh - m], p2: [-hw + m, hh], side: 1, foldType: dir, angleDeg: ang, layerScope: scope },
          { p1: [-hw, -hh + m], p2: [-hw + m, -hh], side: -1, foldType: dir, angleDeg: ang, layerScope: scope },
          { p1: [hw - m, -hh], p2: [hw, -hh + m], side: -1, foldType: dir, angleDeg: ang, layerScope: scope },
        ],
      },
      pleat: { type: 'pleat', foldDir: dir, p1: [-0.25 * hw * xSign, -hh], p2: [-0.25 * hw * xSign, hh], side: -xSign, offset: state.freePleatOffset * hw, angleDeg: ang, layerScope: scope, label: `Pleat Fold${dirTagEn}`, labelEn: `Pleat Fold${dirTagEn}`, labelKo: `계단 접기${dirTagKo}`, techniqueEn: 'Pleat Fold', techniqueKo: '계단 접기' },
      flip: { type: 'flip', axis: 'y', label: 'Flip Paper', labelEn: 'Flip Paper', labelKo: '종이 뒤집기', techniqueEn: 'Flip', techniqueKo: '뒤집기' },
      rot90: { type: 'rotate', angleDeg: 90 * xSign, label: 'Rotate 90°', labelEn: 'Rotate 90°', labelKo: '90° 회전', techniqueEn: 'Rotate', techniqueKo: '회전' },
      rot45: { type: 'rotate', angleDeg: 45 * xSign, label: 'Rotate 45°', labelEn: 'Rotate 45°', labelKo: '45° 회전', techniqueEn: 'Rotate', techniqueKo: '회전' },
    };
    if (isMobileViewport()) closeSheet();
    if (macroId === 'accordion') {
      addFreeStep({ type: 'pleat', foldDir: dir, p1: [-0.45 * hw * xSign, -hh], p2: [-0.45 * hw * xSign, hh], side: -xSign, offset: 0.25 * hw, angleDeg: ang, layerScope: scope, label: `Accordion Pleat 1${dirTagEn}`, labelEn: `Accordion Pleat 1${dirTagEn}`, labelKo: `아코디언 1단 주름${dirTagKo}`, techniqueEn: 'Pleat Fold', techniqueKo: '계단 접기' });
      addFreeStep({ type: 'pleat', foldDir: dir, p1: [0.15 * hw * xSign, -hh], p2: [0.15 * hw * xSign, hh], side: -xSign, offset: 0.25 * hw, angleDeg: ang, layerScope: scope, label: `Accordion Pleat 2${dirTagEn}`, labelEn: `Accordion Pleat 2${dirTagEn}`, labelKo: `아코디언 2단 주름${dirTagKo}`, techniqueEn: 'Pleat Fold', techniqueKo: '계단 접기' });
      return;
    }
    if (macroId === 'grid') {
      addFreeStep({ type: 'precrease', foldDir: dir, creaseType: dir, p1: [0, -hh], p2: [0, hh], side: -xSign, label: `Vertical Center Pre-crease${dirTagEn}`, labelEn: `Vertical Center Pre-crease${dirTagEn}`, labelKo: `세로 중심 예비선${dirTagKo}`, techniqueEn: 'Pre-crease', techniqueKo: '접었다 펴기' });
      addFreeStep({ type: 'precrease', foldDir: dir, creaseType: dir, p1: [-hw, 0], p2: [hw, 0], side: 1, label: `Horizontal Center Pre-crease${dirTagEn}`, labelEn: `Horizontal Center Pre-crease${dirTagEn}`, labelKo: `가로 중심 예비선${dirTagKo}`, techniqueEn: 'Pre-crease', techniqueKo: '접었다 펴기' });
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

  function findNearestSnap(sx, sy, w, h, radiusPx = 28, excludePt = null, allowMinor = true, checkOcclusion = false) {
    if (!lastCam || state.snapPoints.length === 0) return null;
    const faces = state.compiledPlanar?.finalState?.faces;
    const layerThick = computeLayerThick(faces);
    const viewSideZ = (lastCam.eye.z - lastCam.target.z) >= 0 ? 1 : -1;
    const paperItems = checkOcclusion ? (lastCam.paperItems || null) : null;
    let best = null, bestScore = radiusPx;
    for (const sp of state.snapPoints) {
      if (!allowMinor && (sp.kind === 'quarter' || sp.kind === 'intersect')) continue;
      if (excludePt && Math.hypot(sp.x - excludePt.x, sp.y - excludePt.y) < 0.08) continue;
      const spLayer = viewSideZ >= 0 ? (sp.maxLayer ?? 0) : (sp.minLayer ?? 0);
      const spWorld = v3(sp.x, sp.y, (sp.z || 0) + spLayer * layerThick);
      const pr = projectPoint(worldToCamera(spWorld, lastCam), w, h);
      const d = Math.hypot(pr.x - sx, pr.y - sy);
      if (d >= radiusPx) continue;
      if (paperItems && isScreenPointOccluded(pr.x, pr.y, spLayer * viewSideZ, paperItems)) continue;
      // Slight preference for vertices/intersections/center over quarter points when close
      const bias = sp.kind === 'vertex' ? 0 : sp.kind === 'center' ? 1.5 : sp.kind === 'intersect' ? 2.0 : sp.kind === 'midpoint' ? 2.5 : 5.5;
      const score = d + bias;
      if (score < bestScore) {
        bestScore = score;
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

  function pointLineDist2D(px, py, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    return Math.abs((px - a[0]) * (-dy) + (py - a[1]) * dx) / len;
  }

  function pickFrontMostLayerAt(sx, sy, snap, w, h) {
    const viewSideZ = lastCam && (lastCam.eye.z - lastCam.target.z) < 0 ? -1 : 1;
    // When grabbing a snap point (corner/midpoint), use its exact front-most visible layer!
    if (snap && Number.isFinite(snap.maxLayer) && Number.isFinite(snap.minLayer)) {
      return viewSideZ >= 0 ? snap.maxLayer : snap.minLayer;
    }
    const items = lastCam?.paperItems;
    if (!items || items.length === 0) return null;
    // paperItems is sorted back-to-front by layerKey -> pick front-most face containing or touching (sx, sy)
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.isSpine) continue;
      if (sx < it.minX - 6 || sx > it.maxX + 6 || sy < it.minY - 6 || sy > it.maxY + 6) continue;
      if (pointInPoly2D(sx, sy, it.scrPts)) return it.origFace.layer ?? 0;
      const pts = it.scrPts;
      for (let k = 0; k < pts.length; k++) {
        const a = pts[k], b = pts[(k + 1) % pts.length];
        const vx = b.x - a.x, vy = b.y - a.y;
        const lenSq = vx * vx + vy * vy;
        const t = lenSq > 1e-4 ? Math.max(0, Math.min(1, ((sx - a.x) * vx + (sy - a.y) * vy) / lenSq)) : 0;
        if (Math.hypot(sx - (a.x + t * vx), sy - (a.y + t * vy)) <= 6) {
          return it.origFace.layer ?? 0;
        }
      }
    }
    return null;
  }

  /**
   * Build either a single fold step or a left-right symmetric multiFold step
   * when Mirror Fold mode is active and the two halves do not collide across x = center.x.
   */
  function buildFoldStepWithMirror(spec, paperBounds) {
    const {
      toolType, foldDir = 'valley', p1, p2, side, angleDeg, layerScope, offset,
      targetLayer = null, seedPoint = null,
      labelEn, labelKo, techniqueEn, techniqueKo,
    } = spec;

    const singleStep = {
      type: toolType,
      foldDir,
      p1,
      p2,
      side,
      angleDeg,
      layerScope,
      offset,
      ...(Number.isFinite(targetLayer) ? { targetLayer } : {}),
      ...(seedPoint ? { seedPoint } : {}),
      label: labelEn,
      labelEn,
      labelKo,
      technique: techniqueEn,
      techniqueEn,
      techniqueKo,
    };

    if (!state.freeMirror || (toolType !== 'valley' && toolType !== 'mountain')) {
      return { step: singleStep, mirrorCrease: null };
    }

    const mx = paperBounds.center.x;
    const mp1 = [2 * mx - p1[0], p1[1]];
    const mp2 = [2 * mx - p2[0], p2[1]];
    const mSide = -side;

    // Skip mirroring if crease is virtually identical to its mirror (e.g. horizontal or center vertical fold)
    const sameLine = pointLineDist2D(mp1[0], mp1[1], p1, p2) < 0.08 && pointLineDist2D(mp2[0], mp2[1], p1, p2) < 0.08;
    if (sameLine) {
      return { step: singleStep, mirrorCrease: null };
    }

    // Skip mirroring if the primary fold's moving side strictly crosses the center axis (would overlap itself)
    const ax = p2[0] - p1[0], ay = p2[1] - p1[1];
    const aLen = Math.hypot(ax, ay) || 1;
    const nx = -ay / aLen, ny = ax / aLen;
    const centerSigned = ((mx - p1[0]) * nx + (paperBounds.center.y - p1[1]) * ny) * side;
    if (centerSigned > 0.06) {
      return { step: singleStep, mirrorCrease: null };
    }

    const mSeed = seedPoint ? [2 * mx - seedPoint[0], seedPoint[1]] : null;
    const mirrorStep = {
      type: 'multiFold',
      label: `${labelEn} (${UI_STRINGS.en.mirrorSuffix})`,
      labelEn: `${labelEn} (${UI_STRINGS.en.mirrorSuffix})`,
      labelKo: `${labelKo} (${UI_STRINGS.ko.mirrorSuffix})`,
      technique: `${techniqueEn} (${UI_STRINGS.en.mirrorSuffix})`,
      techniqueEn: `${techniqueEn} (${UI_STRINGS.en.mirrorSuffix})`,
      techniqueKo: `${techniqueKo} (${UI_STRINGS.ko.mirrorSuffix})`,
      folds: [
        { p1, p2, side, foldType: toolType, angleDeg, layerScope, ...(Number.isFinite(targetLayer) ? { targetLayer } : {}), ...(seedPoint ? { seedPoint } : {}) },
        { p1: mp1, p2: mp2, side: mSide, foldType: toolType, angleDeg, layerScope, ...(Number.isFinite(targetLayer) ? { targetLayer } : {}), ...(mSeed ? { seedPoint: mSeed } : {}) },
      ],
    };

    return {
      step: mirrorStep,
      mirrorCrease: { p1: v3(mp1[0], mp1[1], 0), p2: v3(mp2[0], mp2[1], 0) },
    };
  }

  let lastDragSx = 0, lastDragSy = 0, lastDragW = 0, lastDragH = 0;

  // ---------------------------------------------------------------------------
  // Physical Drag-to-Fold model
  //
  // Real paper: you pinch a corner, lift it, carry it over and press it down.
  // The grabbed corner therefore sits exactly under the finger in 3D, hovering at
  // a "lift" height above the sheet. For any 3D corner position P, the unique
  // crease that rotates the corner S onto P is the intersection of the
  // perpendicular-bisector plane of S-P with the paper plane, and the fold angle
  // is the angle S-F-P around that crease (F = foot of S on the crease).
  // Lift height follows hand speed (fast = carried high, resting = laid low) and
  // drops onto magnetic snap targets, so the paper settles where you aim.
  // ---------------------------------------------------------------------------

  /** Crease line in z = 0 that rotates S (z = 0) onto 3D point X. */
  function creaseFromTip(S, X) {
    const nx = X.x - S.x, ny = X.y - S.y;
    const nLenSq = nx * nx + ny * ny;
    if (nLenSq < 1e-8) return null;
    const c = ((X.x * X.x + X.y * X.y + (X.z || 0) * (X.z || 0)) - (S.x * S.x + S.y * S.y)) * 0.5;
    const k = (c - (S.x * nx + S.y * ny)) / nLenSq;
    const F = v3(S.x + nx * k, S.y + ny * k, 0);
    const sfx = S.x - F.x, sfy = S.y - F.y;
    const sfLen = Math.hypot(sfx, sfy);
    if (sfLen < 1e-5) return null;
    const u = v3(sfx / sfLen, sfy / sfLen, 0);
    const xf = v3(X.x - F.x, X.y - F.y, X.z || 0);
    const xfLen = Math.hypot(xf.x, xf.y, xf.z);
    const cosT = xfLen > 1e-6 ? Math.max(-1, Math.min(1, (xf.x * sfx + xf.y * sfy) / (xfLen * sfLen))) : 1;
    const dir = norm(v3(-ny, nx, 0));
    return {
      foot: F,
      dir,
      u,
      radius: sfLen,
      theta: Math.acos(cosT),
      landing: v3(2 * F.x - S.x, 2 * F.y - S.y, 0),
    };
  }

  function getPaperHalf() {
    return Math.max(0.2, Math.max(state.freePaper.width || 2, state.freePaper.height || 2) * 0.5);
  }

  /** Precompute the circular arc a folded tip travels when it is peeled back open. */
  function buildUnfoldArc(pair) {
    if (!pair || !pair.mid) return null;
    const A = pair.unfolded, B = pair.mid, C = pair.folded;
    const ab = sub(B, A), ac = sub(C, A);
    const n = cross(ab, ac);
    const nn = dot(n, n);
    if (nn < 1e-8) return null;
    const term1 = cross(n, ab);
    const term2 = cross(ac, n);
    const abL = dot(ab, ab), acL = dot(ac, ac);
    const center = v3(
      A.x + (acL * term1.x + abL * term2.x) / (2 * nn),
      A.y + (acL * term1.y + abL * term2.y) / (2 * nn),
      A.z + (acL * term1.z + abL * term2.z) / (2 * nn)
    );
    const rA = sub(A, center);
    const R = Math.hypot(rA.x, rA.y, rA.z);
    if (R < 1e-4) return null;
    const e1 = norm(rA);
    const rB = sub(B, center);
    const bPerp = sub(rB, v3(e1.x * dot(rB, e1), e1.y * dot(rB, e1), e1.z * dot(rB, e1)));
    if (Math.hypot(bPerp.x, bPerp.y, bPerp.z) < 1e-6) return null;
    const e2 = norm(bPerp);
    const rC = sub(C, center);
    let total = Math.atan2(dot(rC, e2), dot(rC, e1));
    if (total < 0) total += Math.PI * 2;
    if (total < 0.2) return null;
    return { center, R, e1, e2, total };
  }

  /** Screen-space closest point on the unfold arc: returns { phi, distPx }. */
  function closestOnUnfoldArc(arc, sx, sy, w, h) {
    const at = (phi) => {
      const c = Math.cos(phi), s = Math.sin(phi);
      const p = v3(
        arc.center.x + arc.R * (c * arc.e1.x + s * arc.e2.x),
        arc.center.y + arc.R * (c * arc.e1.y + s * arc.e2.y),
        arc.center.z + arc.R * (c * arc.e1.z + s * arc.e2.z)
      );
      const pr = projectPoint(worldToCamera(p, lastCam), w, h);
      return Math.hypot(pr.x - sx, pr.y - sy);
    };
    const N = 40;
    let bestPhi = arc.total, bestD = Infinity;
    for (let i = 0; i <= N; i++) {
      const phi = (arc.total * i) / N;
      const d = at(phi);
      if (d < bestD) { bestD = d; bestPhi = phi; }
    }
    // Local refinement
    let step = arc.total / N;
    for (let it = 0; it < 6; it++) {
      step *= 0.5;
      for (const cand of [bestPhi - step, bestPhi + step]) {
        if (cand < 0 || cand > arc.total) continue;
        const d = at(cand);
        if (d < bestD) { bestD = d; bestPhi = cand; }
      }
    }
    return { phi: bestPhi, distPx: bestD };
  }

  function updateDirectDragFold(sx, sy, w, h) {
    if (!state.dragStart || !lastCam || !state.compiledPlanar) return;
    lastDragSx = sx; lastDragSy = sy; lastDragW = w; lastDragH = h;
    state.dragPointer = { x: sx, y: sy };
    const S = state.dragStart;
    const snapRadius = isMobileViewport() ? 36 : 26;
    const ground = screenToPlane(sx, sy, w, h, lastCam, v3(0, 0, 0), v3(0, 0, 1));
    const rawPt = ground ? v3(ground.x, ground.y, 0) : S;

    // 1. Physical Drag-to-Unfold: a folded tip peels back open along the exact arc it
    //    travelled when it was folded, following the finger. Leaving that arc turns the
    //    gesture into a brand-new fold of the grabbed tip instead.
    const unfoldPair = findUnfoldPairForPoint(S);
    state.dragUnfoldGhost = unfoldPair ? unfoldPair.unfolded : null;
    const hint = state.compiledPlanar.topUnfoldHint;
    const lowering = state.settle && state.settle.kind === 'lower';
    if (unfoldPair && hint && !state.dragAltFree && !lowering) {
      if (!state.dragUnfoldArc || state.dragUnfoldArc.pair !== unfoldPair) {
        const arc = buildUnfoldArc(unfoldPair);
        state.dragUnfoldArc = arc ? { ...arc, pair: unfoldPair } : null;
      }
      const arc = state.dragUnfoldArc;
      if (arc) {
        const hit = closestOnUnfoldArc(arc, sx, sy, w, h);
        const enterPx = isMobileViewport() ? 34 : 26;
        const keepPx = enterPx * 2.1;
        const keep = state.dragIsUnfold ? hit.distPx < keepPx : hit.distPx < enterPx;
        const progressU = 1 - hit.phi / arc.total;
        if (keep && (state.dragIsUnfold || progressU > 0.04 || !dragMoved)) {
          const snapped = progressU > 0.9;
          if (snapped && state.lastSnapId !== 'unfold-origin') {
            state.lastSnapId = 'unfold-origin';
            triggerHaptic(10);
            paperAudio.snapTick();
          } else if (!snapped && state.lastSnapId === 'unfold-origin') {
            state.lastSnapId = '';
          }
          const topStep = state.freeSteps.slice().reverse().find(s => !['unfoldLast', 'unfoldAll', 'precrease', 'flip', 'rotate'].includes(s.type));
          const enLbl = topStep?.labelEn || '';
          const koLbl = topStep?.labelKo || topStep?.label || '';
          state.dragCancelZone = false;
          state.dragIsUnfold = true;
          state.dragSnapped = snapped;
          state.dragCurrent = snapped ? v3(unfoldPair.unfolded.x, unfoldPair.unfolded.y, 0) : rawPt;
          state.dragSnapLabel = snapped ? t('unfoldSnapOrigin') : t('unfoldDragOut');
          state.dragCrease = null;
          state.dragMirrorCrease = null;
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
          state.dragLiveCompiled = { evaluate: hint.evaluateUnfold };
          state.dragProgress = Math.max(0, Math.min(1, progressU));
          return;
        }
      }
    }

    // 2. Physical Drag-to-Fold (Huzita-Hatori Axiom 2 generalised to a lifted 3D corner)
    state.dragIsUnfold = false;
    const uiDir = getEffectiveFoldDir();
    const uiTool = getEffectiveDragTool();
    const worldDir = resolveWorldFoldDir(uiDir);
    const liftSign = worldDir === 'mountain' ? -1 : 1;
    const snapTarget = state.dragAltFree ? null : findNearestSnap(sx, sy, w, h, snapRadius, S, true);

    const snapKeyMap = {
      vertex: 'snapVertex',
      center: 'snapCenter',
      midpoint: 'snapMid',
      intersect: 'snapIntersect',
      quarter: 'snapQuarter',
    };
    const snapKey = snapTarget ? (snapKeyMap[snapTarget.kind] || 'snapMid') : '';
    state.dragSnapLabel = snapKey ? t(snapKey) : '';
    state.dragSnapped = !!snapTarget;

    if (snapTarget) {
      const sid = `${snapTarget.kind}:${snapTarget.x.toFixed(2)},${snapTarget.y.toFixed(2)}`;
      if (state.lastSnapId !== sid) {
        state.lastSnapId = sid;
        triggerHaptic(8);
        paperAudio.snapTick();
      }
    } else {
      state.lastSnapId = '';
    }

    const paperBounds = computePaperBounds(state.compiledPlanar.finalState.faces);
    const groundDist = Math.hypot(rawPt.x - S.x, rawPt.y - S.y);
    const minDrag = Math.max(0.035, Math.min(0.14, paperBounds.radius * 0.12));
    const targetDist = snapTarget ? Math.hypot(snapTarget.x - S.x, snapTarget.y - S.y) : groundDist;
    if (targetDist < minDrag) {
      state.dragCancelZone = dragMoved;
      state.dragCurrent = rawPt;
      state.dragCrease = null;
      state.dragMirrorCrease = null;
      state.dragLiveStep = null;
      state.dragLiveCompiled = null;
      state.dragProgress = 0;
      return;
    }
    state.dragCancelZone = false;

    const targetRad = Math.max(0.2, (state.freeAngle * Math.PI) / 180);
    const paperHalf = getPaperHalf();
    let fold = null;
    if (snapTarget) {
      // Magnetic target: crease is the exact bisector; the corner hovers just above the target
      const Q = v3(snapTarget.x, snapTarget.y, 0);
      fold = creaseFromTip(S, Q);
      if (fold) fold.theta = Math.PI - 2 * Math.atan(state.dragLift);
    } else {
      // Free drag: corner sits under the finger at the current lift height
      const hMax = Math.max(0.12, paperBounds.radius * 0.75);
      const hgt = liftSign * Math.min(hMax, state.dragLift * groundDist);
      const fingerPt = screenToPlane(sx, sy, w, h, lastCam, v3(0, 0, hgt), v3(0, 0, 1)) || v3(rawPt.x, rawPt.y, hgt);
      const P = v3(fingerPt.x, fingerPt.y, hgt);
      // Compensate the soft paper bend so the bent flap's corner (not the rigid one) meets the finger
      let aim = P;
      for (let it = 0; it < 3; it++) {
        const f = creaseFromTip(S, aim);
        if (!f) break;
        const prog = Math.min(1, f.theta / targetRad);
        const r = estimateBendRadius(prog, targetRad, f.radius, paperHalf);
        const off = bendTipOffset(prog * targetRad, r);
        aim = v3(
          P.x - f.u.x * off.du,
          P.y - f.u.y * off.du,
          P.z - liftSign * off.dw
        );
      }
      fold = creaseFromTip(S, aim);
    }
    if (!fold) return;

    const mid = fold.foot;
    const dir = fold.dir;
    const cur = fold.landing;
    state.dragCurrent = cur;
    const halfCrease = Math.max(0.45, Math.min(1.45, paperBounds.radius * 1.15));
    const p1 = v3(mid.x - dir.x * halfCrease, mid.y - dir.y * halfCrease, 0);
    const p2 = v3(mid.x + dir.x * halfCrease, mid.y + dir.y * halfCrease, 0);
    const leftNormal = norm(cross(v3(0, 0, 1), dir));
    const side = dot(sub(S, mid), leftNormal) >= 0 ? 1 : -1;

    const worldTool = (uiTool === 'valley' || uiTool === 'mountain') ? worldDir : uiTool;
    const effUiScope = (state.freeLayerScope === 'all' && state.dragAutoFlap) ? 'top' : state.freeLayerScope;
    const worldScope = resolveWorldLayerScope(effUiScope);
    const isBack = uiDir === 'mountain';
    const toolNamesEn = { valley: 'Valley Fold', mountain: 'Mountain Fold', precrease: isBack ? 'Back Pre-crease' : 'Pre-crease', pleat: isBack ? 'Back Pleat Fold' : 'Pleat Fold' };
    const toolNamesKo = { valley: '앞면(계곡) 접기', mountain: '뒷면(산) 접기', precrease: isBack ? '뒷면 접었다 펴기' : '접었다 펴기', pleat: isBack ? '뒷면 계단 접기' : '계단 접기' };
    const sufEn = snapKey ? ` · ${UI_STRINGS.en[snapKey]}` : '';
    const sufKo = snapKey ? ` · ${UI_STRINGS.ko[snapKey]}` : '';

    const built = buildFoldStepWithMirror({
      toolType: worldTool,
      foldDir: worldDir,
      p1: [p1.x, p1.y],
      p2: [p2.x, p2.y],
      side,
      angleDeg: state.freeAngle,
      layerScope: worldScope,
      targetLayer: effUiScope === 'top' ? state.dragPickedLayer : null,
      seedPoint: effUiScope !== 'all' ? [S.x, S.y] : null,
      offset: state.freePleatOffset,
      labelEn: `${toolNamesEn[uiTool]}${sufEn}`,
      labelKo: `${toolNamesKo[uiTool]}${sufKo}`,
      techniqueEn: toolNamesEn[uiTool],
      techniqueKo: toolNamesKo[uiTool],
    }, paperBounds);

    state.dragCrease = { p1, p2 };
    state.dragMirrorCrease = built.mirrorCrease;
    state.dragLiveStep = built.step;
    // Recompile only when the crease actually moved (lift easing re-runs this every frame)
    const key = `${built.step.type}|${p1.x.toFixed(4)},${p1.y.toFixed(4)},${p2.x.toFixed(4)},${p2.y.toFixed(4)}|${side}|${worldDir}|${worldScope}|${state.freeMirror}`;
    if (!state.dragLiveCompiled || state.dragLiveKey !== key) {
      state.dragLiveCompiled = compilePlanarStep(state.compiledPlanar.finalState, built.step);
      state.dragLiveKey = key;
    }
    state.dragProgress = Math.max(0.02, Math.min(0.995, fold.theta / targetRad));
  }

  /** Per-frame drag physics: hand-speed driven lift height, eased like a real wrist. */
  function stepDragPhysics(dt, now) {
    if (!state.dragFoldActive || gestureMode !== 'drag-fold') return;
    if (now - state.dragLastMoveT > 70) state.dragSpeedTarget = 0;
    const attack = state.dragSpeedTarget > state.dragSpeed ? 14 : 3.2;
    state.dragSpeed += (state.dragSpeedTarget - state.dragSpeed) * (1 - Math.exp(-dt * attack));
    const liftTarget = state.dragSnapped ? 0.11 : (0.3 + 0.48 * state.dragSpeed);
    const prevLift = state.dragLift;
    state.dragLift += (liftTarget - state.dragLift) * (1 - Math.exp(-dt * 9));
    paperAudio.rustle(state.dragSpeed);
    if (Math.abs(state.dragLift - prevLift) > 0.0015 && !state.dragIsUnfold) {
      updateDirectDragFold(lastDragSx, lastDragSy, lastDragW, lastDragH);
    }
  }

  // ---------------------------------------------------------------------------
  // Release physics: the flap drops and is pressed flat (or springs back open)
  // ---------------------------------------------------------------------------
  function clipCreaseToPaper(cr, faces) {
    if (!cr || !faces || !faces.length) return null;
    const N = 90;
    let first = -1, last = -1;
    for (let i = 0; i <= N; i++) {
      const tt = i / N;
      const x = cr.p1.x + (cr.p2.x - cr.p1.x) * tt;
      const y = cr.p1.y + (cr.p2.y - cr.p1.y) * tt;
      let inside = false;
      for (const f of faces) {
        if (pointInPoly2D(x, y, f.pts)) { inside = true; break; }
      }
      if (inside) {
        if (first < 0) first = i;
        last = i;
      }
    }
    if (first < 0 || last <= first) return null;
    const lerpPt = (tt) => v3(cr.p1.x + (cr.p2.x - cr.p1.x) * tt, cr.p1.y + (cr.p2.y - cr.p1.y) * tt, 0);
    return { p1: lerpPt(first / N), p2: lerpPt(last / N) };
  }

  function startSettle(spec) {
    finishSettleNow();
    state.settle = { ...spec, elapsed: 0, p: spec.from, pressed: false };
  }

  function finishSettleNow() {
    const st = state.settle;
    if (!st) return;
    if (st.kind === 'lower') {
      state.dragLift = 0;
      updateDirectDragFold(lastDragSx, lastDragSy, lastDragW, lastDragH);
    }
    state.settle = null;
    if (!st.pressed && st.onPress) st.onPress();
    if (st.onDone) st.onDone();
  }

  function stepSettle(dt) {
    const st = state.settle;
    if (!st) return;
    st.elapsed += dt;
    const { from, kind } = st;
    if (kind === 'lower') {
      // The hand presses the lifted corner straight down where the finger is: the lift
      // height falls to zero (gravity-like) while the crease re-solves every frame, so the
      // corner touches down exactly under the cursor.
      const tau = Math.min(1, st.elapsed / st.dur);
      const fall = 0.3 * tau + 0.7 * tau * tau;
      state.dragLift = st.lift0 * (1 - fall);
      updateDirectDragFold(lastDragSx, lastDragSy, lastDragW, lastDragH);
      if (tau >= 1) finishSettleNow();
    } else if (kind === 'press') {
      // Gravity-like drop that accelerates into the table, then the crease is pressed
      const tau = Math.min(1, st.elapsed / st.dur);
      st.p = from + (1 - from) * (0.3 * tau + 0.7 * tau * tau);
      if (tau >= 1) {
        st.p = 1;
        if (!st.pressed) { st.pressed = true; if (st.onPress) st.onPress(); }
        state.settle = null;
        if (st.onDone) st.onDone();
      }
    } else if (kind === 'precrease') {
      // Press flat, hold a beat, then let the sheet spring back open with a crease
      const d1 = st.dur, hold = 0.06, d2 = 0.34;
      const e = st.elapsed;
      if (e < d1) {
        const tau = e / d1;
        st.p = from + (1 - from) * (0.3 * tau + 0.7 * tau * tau);
      } else {
        if (!st.pressed) { st.pressed = true; if (st.onPress) st.onPress(); }
        if (e < d1 + hold) st.p = 1;
        else {
          const tau = Math.min(1, (e - d1 - hold) / d2);
          st.p = 1 - (1 - Math.pow(1 - tau, 3));
          if (tau >= 1) {
            st.p = 0;
            state.settle = null;
            if (st.onDone) st.onDone();
          }
        }
      }
    } else {
      // 'spring' toward st.to with a soft ease-out (paper relaxing back)
      const tau = Math.max(0, Math.min(1, (st.elapsed - (st.delay || 0)) / st.dur));
      const eased = 1 - Math.pow(1 - tau, 3);
      st.p = from + (st.to - from) * eased;
      if (tau >= 1) {
        st.p = st.to;
        state.settle = null;
        if (st.onDone) st.onDone();
      }
    }
  }

  function flashCreases(segments) {
    const segs = (segments || []).filter(Boolean);
    if (!segs.length) return;
    state.creaseFlash = { segments: segs, start: performance.now(), dur: 520 };
  }

  function releaseDirectDrag() {
    const compiled = state.dragLiveCompiled;
    const p0 = state.dragProgress || 0;
    const step = state.dragLiveStep;
    const baseFaces = state.compiledPlanar?.finalState?.faces || [];
    const isUnfold = state.dragIsUnfold;
    const cancel = state.dragCancelZone || !dragMoved;
    const keepDrag = {
      dragStart: state.dragStart,
      dragPickedLayer: state.dragPickedLayer,
      dragAutoFlap: state.dragAutoFlap,
      dragShiftFlip: state.dragShiftFlip,
      dragAltFree: state.dragAltFree,
      dragLift: state.dragLift,
      dragLiveKey: state.dragLiveKey,
    };
    paperAudio.stopRustle();
    clearInteractiveDraft();
    updateFreeBanner();

    if (!compiled || !step) return;

    if (cancel) {
      if (p0 > 0.01) {
        startSettle({ compiled, from: p0, to: 0, kind: 'spring', dur: 0.24 + 0.16 * p0 });
      }
      return;
    }

    if (isUnfold) {
      if (p0 >= 0.42) {
        startSettle({
          compiled, from: p0, to: 1, kind: 'spring', dur: 0.16 + 0.24 * (1 - p0),
          onDone: () => { paperAudio.unfold(); triggerHaptic(10); addFreeStep(step, 0, true); },
        });
      } else {
        // Not pulled far enough: the crease's memory snaps the flap back down
        startSettle({
          compiled, from: p0, to: 0, kind: 'spring', dur: 0.2 + 0.2 * p0,
          onDone: () => { paperAudio.crease(0.5); },
        });
      }
      return;
    }

    // Keep the live drag alive while the corner is lowered onto the table under the finger
    state.dragFoldActive = true;
    state.dragStart = keepDrag.dragStart;
    state.dragPickedLayer = keepDrag.dragPickedLayer;
    state.dragAutoFlap = keepDrag.dragAutoFlap;
    state.dragShiftFlip = keepDrag.dragShiftFlip;
    state.dragAltFree = keepDrag.dragAltFree;
    state.dragLiveCompiled = compiled;
    state.dragLiveStep = step;
    state.dragLiveKey = keepDrag.dragLiveKey;
    state.dragProgress = p0;
    const isPrecrease = step.type === 'precrease';
    const pressNow = () => {
      paperAudio.crease(1);
      triggerHaptic([6, 28, 14]);
      flashCreases([
        clipCreaseToPaper(state.dragCrease, baseFaces),
        clipCreaseToPaper(state.dragMirrorCrease, baseFaces),
      ]);
    };
    startSettle({
      kind: 'lower',
      lift0: Math.max(0.0001, keepDrag.dragLift),
      dur: 0.1 + 0.24 * (1 - p0),
      onPress: pressNow,
      onDone: () => {
        const finalStep = state.dragLiveStep || step;
        const finalCompiled = state.dragLiveCompiled || compiled;
        const finalP = state.dragProgress;
        clearInteractiveDraft();
        if (isPrecrease) {
          // Pre-crease: pressed flat, then the sheet relaxes back open leaving the crease
          startSettle({
            compiled: finalCompiled, from: finalP, to: 0, kind: 'spring', dur: 0.36, delay: 0.06,
            onDone: () => { addFreeStep(finalStep, 0, true); },
          });
        } else {
          addFreeStep(finalStep, 0, true);
        }
      },
    });
  }

  function isRaisedInteriorFlapSnap(snap) {
    if (!snap || (snap.kind !== 'vertex' && snap.kind !== 'midpoint')) return false;
    const faces = state.compiledPlanar?.finalState?.faces;
    if (!faces || faces.length <= 1) return false;
    let gMin = Infinity, gMax = -Infinity;
    for (const f of faces) {
      if (f.layer < gMin) gMin = f.layer;
      if (f.layer > gMax) gMax = f.layer;
    }
    if (gMax - gMin < 0.5) return false;
    return isViewingBackSide()
      ? (snap.maxLayer < gMax - 0.05)
      : (snap.minLayer > gMin + 0.05);
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
  let dragStartButton = 0;
  let pinchStartDist = 0, pinchStartCamDist = 4.6, pinchMidX = 0, pinchMidY = 0;
  let lastTapTime = 0, lastTapX = 0, lastTapY = 0;

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    finishSettleNow();
    const { x, y, w, h } = getCanvasCoords(e);
    activePointers.set(e.pointerId, { x, y });
    state.targetCamera = null;
    dragStartButton = e.button;

    // Two-finger gesture -> Pinch-to-Zoom + 2-Finger Orbit!
    if (activePointers.size === 2) {
      paperAudio.stopRustle();
      canvas.style.cursor = '';
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

    // Right-click or Middle-click drag ALWAYS orbits 3D camera (even directly over the paper!)
    if (e.button === 1 || e.button === 2) {
      gestureMode = 'orbit';
      return;
    }

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
      const snap = findNearestSnap(x, y, w, h, grabRadius, null, false, true);
      const raw = screenToPlane(x, y, w, h, lastCam, v3(0, 0, 0), v3(0, 0, 1));
      const onPaper = snap || isPointOnPaper(raw);

      if (onPaper) {
        const startPt = snap ? v3(snap.x, snap.y, 0) : v3(raw.x, raw.y, 0);
        const unfoldPair = findUnfoldPairForPoint(startPt);
        gestureMode = 'drag-fold';
        state.dragFoldActive = true;
        state.dragShiftFlip = !!e.shiftKey;
        state.dragAltFree = !!e.altKey;
        state.dragPickedLayer = pickFrontMostLayerAt(x, y, snap, w, h);
        state.dragAutoFlap = state.freeLayerScope === 'all' && isRaisedInteriorFlapSnap(snap);
        state.dragCancelZone = false;
        state.lastSnapId = '';
        state.dragStart = startPt;
        state.dragCurrent = startPt;
        state.dragSnapLabel = '';
        state.dragCrease = null;
        state.dragMirrorCrease = null;
        state.dragLiveStep = null;
        state.dragLiveCompiled = null;
        state.dragIsUnfold = false;
        state.dragUnfoldGhost = unfoldPair ? unfoldPair.unfolded : null;
        state.dragUnfoldArc = null;
        state.dragProgress = 0;
        state.dragLift = 0.42; // a fresh pinch lifts the corner noticeably
        state.dragSpeed = 0;
        state.dragSpeedTarget = 0;
        state.dragLastMoveT = performance.now();
        state.dragPointer = { x, y };
        state.dragSnapped = false;
        state.dragLiveKey = '';
        lastDragSx = x; lastDragSy = y; lastDragW = w; lastDragH = h;
        canvas.style.cursor = 'grabbing';
        paperAudio.pickup();
        paperAudio.startRustle();
        triggerHaptic(6);
        updateFreeBanner();
        return;
      }
    }

    // Touching empty background OR Library Mode OR Orbit/Line Mode -> Orbit camera on drag!
    gestureMode = 'orbit';
  });

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  // Desktop double-click on canvas smoothly resets & auto-frames camera
  canvas.addEventListener('dblclick', () => {
    if (state.mode === 'free' && state.freeInteractMode === 'line') return;
    resetCameraView(true);
  });

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
      state.dragShiftFlip = !!e.shiftKey;
      state.dragAltFree = !!e.altKey;
      if (Math.hypot(x - dragStartX, y - dragStartY) > 6) dragMoved = true;
      const nowT = performance.now();
      const dtMove = Math.max(4, nowT - state.dragLastMoveT);
      const prev = state.dragPointer || { x, y };
      const speedPx = (Math.hypot(x - prev.x, y - prev.y) / dtMove) * 1000;
      state.dragSpeedTarget = Math.max(0, Math.min(1, speedPx / 1300));
      state.dragLastMoveT = nowT;
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
      const isLineMode = state.freeInteractMode === 'line';
      const snap = findNearestSnap(x, y, w, h, 26, null, isLineMode, !isLineMode);
      state.hoveredSnap = snap;
      if (!isLineMode && state.freeInteractMode === 'drag') {
        canvas.style.cursor = (snap || isPointOnPaper(worldPt)) ? 'grab' : '';
      }
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
      gestureMode = 'none';
      canvas.style.cursor = '';
      // Let go: the flap drops & gets pressed into a crease (or springs back open)
      releaseDirectDrag();
      return;
    }

    // Quick right-click (without drag) cancels active Free Studio draft
    if (gestureMode === 'orbit' && dragStartButton === 2 && !dragMoved && state.mode === 'free') {
      if (activePointers.size === 0) gestureMode = 'none';
      clearInteractiveDraft();
      updateFreeBanner();
      return;
    }

    // Mobile double-tap on empty space (or non-line mode) resets camera smoothly
    const wasTap = gestureMode === 'orbit' && !dragMoved && (e.button === 0 || e.pointerType === 'touch');
    if (activePointers.size === 0) gestureMode = 'none';

    if (wasTap && e.pointerType === 'touch' && !(state.mode === 'free' && state.freeInteractMode === 'line')) {
      const now = performance.now();
      if (now - lastTapTime < 320 && Math.hypot(x - lastTapX, y - lastTapY) < 36) {
        lastTapTime = 0;
        resetCameraView(true);
        return;
      }
      lastTapTime = now;
      lastTapX = x;
      lastTapY = y;
    }

    if (!wasTap || state.mode !== 'free' || state.freeInteractMode !== 'line' || !lastCam) return;

    if (state.playPos < state.freeSteps.length) {
      state.playPos = state.freeSteps.length;
      state.playing = false;
    }

    const snap = findNearestSnap(x, y, w, h, isMobileViewport() ? 36 : 24, null, true);
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
      const uiDir = state.freeFoldDir;
      const uiTool = (state.freeTool === 'valley' || state.freeTool === 'mountain') ? uiDir : state.freeTool;
      const worldDir = resolveWorldFoldDir(uiDir);
      const worldTool = (state.freeTool === 'valley' || state.freeTool === 'mountain') ? worldDir : state.freeTool;
      const worldScope = resolveWorldLayerScope(state.freeLayerScope);
      const isBack = uiDir === 'mountain';
      const toolNamesEn = { valley: 'Valley Fold', mountain: 'Mountain Fold', precrease: isBack ? 'Back Pre-crease' : 'Pre-crease', pleat: isBack ? 'Back Pleat Fold' : 'Pleat Fold' };
      const toolNamesKo = { valley: '앞면(계곡) 접기', mountain: '뒷면(산) 접기', precrease: isBack ? '뒷면 접었다 펴기' : '접었다 펴기', pleat: isBack ? '뒷면 계단 접기' : '계단 접기' };
      const paperBounds = computePaperBounds(state.compiledPlanar.finalState.faces);
      const built = buildFoldStepWithMirror({
        toolType: worldTool,
        foldDir: worldDir,
        p1: [state.pickP1.x, state.pickP1.y],
        p2: [state.pickP2.x, state.pickP2.y],
        side,
        angleDeg: state.freeAngle,
        layerScope: worldScope,
        offset: state.freePleatOffset,
        labelEn: `${toolNamesEn[uiTool]} (${state.freeAngle}°)`,
        labelKo: `${toolNamesKo[uiTool]} (${state.freeAngle}°)`,
        techniqueEn: toolNamesEn[uiTool],
        techniqueKo: toolNamesKo[uiTool],
      }, paperBounds);
      addFreeStep(built.step);
    }
  }

  canvas.addEventListener('pointerup', handlePointerRelease);
  canvas.addEventListener('pointercancel', (e) => {
    activePointers.delete(e.pointerId);
    if (activePointers.size === 0) {
      gestureMode = 'none';
      paperAudio.stopRustle();
      canvas.style.cursor = '';
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
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;

    // Live Shift / Alt modulation during active Drag-to-Fold
    if (state.dragFoldActive && (e.key === 'Shift' || e.key === 'Alt')) {
      const nextShift = e.key === 'Shift' ? true : state.dragShiftFlip;
      const nextAlt = e.key === 'Alt' ? true : state.dragAltFree;
      if (nextShift !== state.dragShiftFlip || nextAlt !== state.dragAltFree) {
        state.dragShiftFlip = nextShift;
        state.dragAltFree = nextAlt;
        updateDirectDragFold(lastDragSx, lastDragSy, lastDragW, lastDragH);
        updateFreeBanner();
      }
      return;
    }

    const key = e.key.toLowerCase();

    if (e.key === 'Escape') {
      if ($('shortcuts-modal')?.classList.contains('open')) { closeShortcutsModal(); return; }
      if ($('gif-modal')?.classList.contains('open')) { closeGifModal(); return; }
      if (state.sheetOpen) { closeSheet(); return; }
      if (state.mode === 'free') {
        clearInteractiveDraft();
        updateFreeBanner();
      }
      return;
    }

    if (e.key === '?' || (e.shiftKey && e.key === '/')) {
      e.preventDefault();
      if ($('shortcuts-modal')?.classList.contains('open')) closeShortcutsModal();
      else openShortcutsModal();
      return;
    }

    // Undo / Redo
    if ((e.metaKey || e.ctrlKey) && (key === 'z' || key === 'y') && state.mode === 'free') {
      e.preventDefault();
      if (key === 'y' || e.shiftKey) redoFreeStep();
      else undoFreeStep();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    if (e.code === 'Space') {
      e.preventDefault();
      togglePlay();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      jumpToStep(Math.max(0, Math.ceil(state.playPos) - 1));
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      jumpToStep(Math.min(getActiveModel().steps.length, Math.floor(state.playPos) + 1));
    } else if (key === 'l') {
      toggleLoopPlay();
    } else if (key === 'r') {
      resetCameraView(true);
    } else if (key === '1') {
      applyCameraPreset(0.52, 0.38, 4.7);
    } else if (key === '2') {
      applyCameraPreset(0.0, 0.02, 4.4);
    } else if (key === '3') {
      applyCameraPreset(1.48, 0.22, 4.7);
    } else if (key === '4') {
      applyCameraPreset(0.0, 1.32, 4.8);
    } else if (key === '5') {
      applyCameraPreset(Math.PI, 0.04, 4.4);
    } else if (state.mode === 'free') {
      if (key === 'v') { setFoldDir('valley'); }
      else if (key === 'm') { setFoldDir('mountain'); }
      else if (key === 't') { toggleSingleFlapScope(); }
      else if (key === 'x') { toggleMirrorFold(); }
      else if (key === 'u') { unfoldLastFreeStep(); }
      else if (key === 'f') { applyQuickMacro('flip'); }
      else if (key === 'g') { applyQuickMacro('rot45'); }
    }
  });

  window.addEventListener('keyup', (e) => {
    if (state.dragFoldActive && (e.key === 'Shift' || e.key === 'Alt')) {
      const nextShift = e.key === 'Shift' ? false : state.dragShiftFlip;
      const nextAlt = e.key === 'Alt' ? false : state.dragAltFree;
      if (nextShift !== state.dragShiftFlip || nextAlt !== state.dragAltFree) {
        state.dragShiftFlip = nextShift;
        state.dragAltFree = nextAlt;
        updateDirectDragFold(lastDragSx, lastDragSy, lastDragW, lastDragH);
        updateFreeBanner();
      }
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
        saveFreeDraft();
      });
      container.appendChild(sw);
    }
  }

  function renderTimelineSteps() {
    const list = $('step-pills');
    const model = getLocalizedActiveModel();
    list.innerHTML = '';
    state.lastScrolledStepIdx = -1;

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
        if (state.dragCancelZone) {
          textEl.textContent = t('bannerDragCancel');
        } else if (state.dragIsUnfold) {
          textEl.textContent = t('bannerDragUnfoldActive');
        } else {
          const base = state.dragSnapLabel
            ? t('bannerDragActiveSnap', state.dragSnapLabel)
            : t('bannerDragActiveNoSnap');
          textEl.textContent = isMobileViewport() ? base : `${base} · ${t('bannerDragShiftHint')}`;
        }
      } else if (state.freeMirror) {
        textEl.textContent = t('bannerDragMirrorHint');
      } else if (state.freeLayerScope !== 'all') {
        textEl.textContent = t('bannerSingleLayerHint');
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
    if ($('btn-loop')) {
      $('btn-loop').classList.toggle('active', state.loopPlay);
      $('btn-loop').setAttribute('aria-pressed', String(state.loopPlay));
    }

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
    if (curIdx >= 0 && curIdx < pills.length && curIdx !== state.lastScrolledStepIdx) {
      state.lastScrolledStepIdx = curIdx;
      try {
        pills[curIdx].scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
      } catch {
        // Fallback for older browsers
      }
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

    const isMountain = state.freeFoldDir === 'mountain';
    const dirBtn = $('mob-fold-dir');
    dirBtn.textContent = isMountain ? t('mobMountain') : t('mobValley');
    dirBtn.classList.toggle('mountain', isMountain);
    const canUnfold = (state.compiledPlanar?.activeFoldCount || 0) > 0;
    $('mob-unfold').disabled = !canUnfold;
    $('mob-undo').disabled = state.freeSteps.length === 0;
  }

  function syncQuickRail() {
    const rail = $('free-quick-rail');
    if (!rail) return;
    rail.style.display = state.mode === 'free' ? 'flex' : 'none';
    if (state.mode !== 'free') return;

    const isMountain = state.freeFoldDir === 'mountain';
    const qDir = $('qbtn-dir');
    if (qDir) {
      qDir.classList.toggle('is-mountain', isMountain);
      qDir.classList.toggle('is-valley', !isMountain);
      const ico = qDir.querySelector('.q-ico');
      if (ico) ico.textContent = isMountain ? '▼' : '▲';
      const lbl = $('qbtn-dir-lbl');
      if (lbl) lbl.textContent = isMountain ? t('quickMountain') : t('quickValley');
    }
    const qLayer = $('qbtn-layer');
    if (qLayer) {
      const sc = state.freeLayerScope;
      qLayer.classList.toggle('active-layer', sc !== 'all');
      const ico = qLayer.querySelector('.q-ico');
      if (ico) ico.textContent = sc === 'all' ? '▤' : sc === 'top' ? '◰' : '◳';
      const lbl = $('qbtn-layer-lbl');
      if (lbl) lbl.textContent = sc === 'all' ? t('quickLayerAll') : sc === 'top' ? t('quickLayerOne') : t('quickLayerBack');
    }
    if ($('qbtn-mirror')) {
      $('qbtn-mirror').classList.toggle('active-mirror', state.freeMirror);
    }
    const canUnfold = (state.compiledPlanar?.activeFoldCount || 0) > 0;
    if ($('qbtn-unfold')) $('qbtn-unfold').disabled = !canUnfold;
    if ($('qbtn-undo')) $('qbtn-undo').disabled = state.freeSteps.length === 0;
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
      if ($('btn-mirror-toggle')) {
        $('btn-mirror-toggle').classList.toggle('active', state.freeMirror);
        $('btn-mirror-toggle').setAttribute('aria-pressed', String(state.freeMirror));
        if ($('mirror-state-pill')) $('mirror-state-pill').textContent = state.freeMirror ? 'ON' : 'OFF';
      }
      document.querySelectorAll('[data-fold-dir]').forEach(b => {
        b.classList.toggle('active', b.dataset.foldDir === state.freeFoldDir);
      });
      document.querySelectorAll('[data-tool]').forEach(b => {
        b.classList.toggle('active', b.dataset.tool === state.freeTool);
      });
      document.querySelectorAll('[data-interact]').forEach(b => {
        b.classList.toggle('active', b.dataset.interact === state.freeInteractMode);
      });
      const activePreset = state.freePaper?.presetId || 'square';
      document.querySelectorAll('[data-paper-size]').forEach(b => {
        b.classList.toggle('active', b.dataset.paperSize === activePreset);
      });
      if ($('paper-ratio-badge')) {
        $('paper-ratio-badge').textContent = formatRatioLabel(state.freePaper);
      }
      if ($('paper-custom-w') && document.activeElement !== $('paper-custom-w')) {
        $('paper-custom-w').value = String(state.freePaper?.cmW ?? Number((state.freePaper.width * 7.5).toFixed(1)));
      }
      if ($('paper-custom-h') && document.activeElement !== $('paper-custom-h')) {
        $('paper-custom-h').value = String(state.freePaper?.cmH ?? Number((state.freePaper.height * 7.5).toFixed(1)));
      }
      $('layer-all').classList.toggle('active', state.freeLayerScope === 'all');
      $('layer-top').classList.toggle('active', state.freeLayerScope === 'top');
      if ($('layer-bottom')) $('layer-bottom').classList.toggle('active', state.freeLayerScope === 'bottom');
    }

    $('cp-overlay').style.display = state.showCP ? 'block' : 'none';
    renderCatalogList();
    renderTimelineSteps();
    updateFreeBanner();
    syncPlaybackControls();
    syncMobileBar();
    syncQuickRail();
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

  function getEffectiveFoldDir() {
    if (state.dragShiftFlip) {
      return state.freeFoldDir === 'mountain' ? 'valley' : 'mountain';
    }
    return state.freeFoldDir;
  }

  function getEffectiveDragTool() {
    if (state.freeTool === 'valley' || state.freeTool === 'mountain') {
      return getEffectiveFoldDir();
    }
    return state.freeTool;
  }

  function renderAll() {
    const { w, h } = resizeCanvas();

    // If user is actively Drag-to-Folding or Drag-to-Unfolding, render the LIVE 3D mesh directly!
    let frame;
    if (state.settle && state.settle.compiled) {
      frame = state.settle.compiled.evaluate(0, { progress: state.settle.p });
    } else if (state.dragFoldActive && state.dragLiveCompiled && !state.dragCancelZone) {
      frame = state.dragLiveCompiled.evaluate(0, { progress: state.dragProgress });
    } else {
      frame = evaluateAtPos(state.playPos);
    }

    let creaseFlash = null;
    if (state.creaseFlash) {
      const ft = (performance.now() - state.creaseFlash.start) / state.creaseFlash.dur;
      if (ft >= 1) state.creaseFlash = null;
      else creaseFlash = { segments: state.creaseFlash.segments, t: ft };
    }

    const showFreeOverlay = state.mode === 'free'
      && state.freeInteractMode !== 'orbit'
      && !state.settle
      && (state.dragFoldActive || (!state.playing && state.playPos >= state.freeSteps.length - 0.01));

    const effDir = state.dragFoldActive ? getEffectiveFoldDir() : state.freeFoldDir;
    const mirrorAxisX = (showFreeOverlay && state.freeMirror && state.compiledPlanar)
      ? computePaperBounds(state.compiledPlanar.finalState.faces).center.x
      : null;

    const freeOverlay = showFreeOverlay
      ? {
          interactMode: state.freeInteractMode,
          snapPoints: state.snapPoints,
          hoveredSnap: state.hoveredSnap,
          p1: state.pickP1,
          p2: state.pickP2,
          hoverWorld: state.hoverWorld,
          foldType: effDir === 'mountain' ? 'mountain' : 'valley',
          hoverSide: state.hoverSide,
          previewFaces: computeFreePreviewFaces(),
          dragStart: state.dragStart,
          dragCurrent: state.dragCurrent,
          dragSnapLabel: state.dragSnapLabel,
          dragCrease: state.dragCrease,
          dragMirrorCrease: state.dragMirrorCrease,
          mirrorAxisX,
          dragIsUnfold: state.dragIsUnfold,
          unfoldGhost: state.dragUnfoldGhost,
          unfoldGhostLabel: t('unfoldBadge'),
          dragCancelZone: state.dragCancelZone,
          dragCancelLabel: t('dragCancelBadge'),
          dragPointer: state.dragPointer,
          dragSnapped: state.dragSnapped,
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
      creaseFlash,
    });

    if (state.showCP && !isMobileViewport()) {
      const pSpec = state.mode === 'free' ? state.freePaper : (getActiveModel().paper || { width: 2, height: 2 });
      const pAspect = (pSpec?.width || 2) / (pSpec?.height || 2);
      renderCreasePattern2D(cpCtx, cpCanvas.width, frame.creases, state.isDark, pAspect);
    }
  }

  let lastTime = performance.now();
  function tick(now) {
    const dt = Math.min(0.05, (now - lastTime) / 1000);
    lastTime = now;
    stepSettle(dt);
    stepDragPhysics(dt, now);

    const total = getActiveModel().steps.length;
    if (state.playing && total > 0) {
      if (state.loopHoldTimer > 0) {
        state.loopHoldTimer -= dt;
        if (state.loopHoldTimer <= 0) {
          state.playPos = 0;
          state.stepHoldTimer = 0;
          syncPlaybackControls();
        }
      } else if (state.stepHoldTimer > 0) {
        state.stepHoldTimer -= dt;
      } else {
        const prevStep = Math.floor(state.playPos);
        state.playPos += dt * 0.78 * state.playbackSpeed;
        const nextStep = Math.floor(state.playPos);
        if (state.playPos >= total) {
          state.playPos = total;
          if (state.loopPlay) {
            state.loopHoldTimer = 1.05 / state.playbackSpeed;
          } else {
            state.playing = false;
          }
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
    setFoldDir(state.freeFoldDir === 'mountain' ? 'valley' : 'mountain');
  });

  // View & color controls
  $('color-front').addEventListener('input', (e) => { state.frontColor = e.target.value; renderPaperSwatches(); saveFreeDraft(); });
  $('color-back').addEventListener('input', (e) => { state.backColor = e.target.value; renderPaperSwatches(); saveFreeDraft(); });
  if ($('btn-swap-colors')) $('btn-swap-colors').addEventListener('click', swapPaperColors);
  $('toggle-guides').addEventListener('click', (e) => { state.showGuides = !state.showGuides; e.currentTarget.classList.toggle('active', state.showGuides); });
  $('toggle-cp').addEventListener('click', (e) => { state.showCP = !state.showCP; e.currentTarget.classList.toggle('active', state.showCP); $('cp-overlay').style.display = state.showCP ? 'block' : 'none'; });
  $('toggle-wire').addEventListener('click', (e) => { state.showWireframe = !state.showWireframe; e.currentTarget.classList.toggle('active', state.showWireframe); });
  const SOUND_KEY = 'origami3d_sound_v1';
  try { state.soundOn = localStorage.getItem(SOUND_KEY) !== 'off'; } catch { state.soundOn = true; }
  if ($('toggle-sound')) {
    $('toggle-sound').classList.toggle('active', state.soundOn);
    $('toggle-sound').addEventListener('click', (e) => {
      state.soundOn = !state.soundOn;
      e.currentTarget.classList.toggle('active', state.soundOn);
      try { localStorage.setItem(SOUND_KEY, state.soundOn ? 'on' : 'off'); } catch { /* storage blocked */ }
      if (state.soundOn) paperAudio.crease(0.6);
    });
  }

  // Camera presets (always re-center & auto-frame the current paper!)
  function applyCameraPreset(yaw, pitch, fallbackDist) {
    state.autoOrbit = false;
    state.userZoomScale = 1.0;
    const bounds = getCurrentPaperBounds();
    const dist = state.mode === 'free' ? idealDistanceForRadius(bounds.radius) : fallbackDist;
    state.targetCamera = { yaw, pitch, distance: dist, target: bounds.center };
  }
  function resetCameraView(notify = false) {
    if (state.mode === 'free') {
      applyCameraPreset(0.0, 0.14, 4.4);
    } else {
      const m = getActiveModel();
      const c = m.defaultCamera || { yaw: 0.52, pitch: 0.38, distance: 4.7 };
      applyCameraPreset(c.yaw, c.pitch, c.distance);
    }
    if (notify) showToast(t('toastCamReset'), 1400);
  }
  $('cam-3d').addEventListener('click', () => applyCameraPreset(0.52, 0.38, 4.7));
  $('cam-front').addEventListener('click', () => applyCameraPreset(0.0, 0.02, 4.4));
  if ($('cam-back')) $('cam-back').addEventListener('click', () => applyCameraPreset(Math.PI, 0.04, 4.4));
  $('cam-side').addEventListener('click', () => applyCameraPreset(1.48, 0.22, 4.7));
  $('cam-top').addEventListener('click', () => applyCameraPreset(0.0, 1.32, 4.8));
  $('cam-spin').addEventListener('click', (e) => { state.autoOrbit = !state.autoOrbit; e.currentTarget.classList.toggle('active', state.autoOrbit); });

  // Playback controls
  $('btn-play').addEventListener('click', togglePlay);
  $('btn-restart').addEventListener('click', () => { state.playPos = 0; state.playing = true; state.stepHoldTimer = 0; state.loopHoldTimer = 0; syncPlaybackControls(); });
  $('btn-prev').addEventListener('click', () => jumpToStep(Math.max(0, Math.ceil(state.playPos) - 1)));
  $('btn-next').addEventListener('click', () => jumpToStep(Math.min(getActiveModel().steps.length, Math.floor(state.playPos) + 1)));
  $('timeline-slider').addEventListener('input', (e) => { state.playing = false; state.playPos = Number(e.target.value); syncPlaybackControls(); });
  $('speed-select').addEventListener('change', (e) => { state.playbackSpeed = Number(e.target.value); });
  if ($('btn-loop')) $('btn-loop').addEventListener('click', toggleLoopPlay);

  // Free Fold Studio controls
  $('free-title-input').addEventListener('input', (e) => {
    state.freeTitle = e.target.value;
    $('work-title-badge').textContent = state.freeTitle || t('defaultFreeTitle');
    saveFreeDraft();
  });
  document.querySelectorAll('[data-interact]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.freeInteractMode = btn.dataset.interact;
      clearInteractiveDraft();
      syncUI();
    });
  });
  document.querySelectorAll('[data-fold-dir]').forEach(btn => {
    btn.addEventListener('click', () => setFoldDir(btn.dataset.foldDir));
  });
  document.querySelectorAll('[data-tool]').forEach(btn => {
    btn.addEventListener('click', () => setFoldTool(btn.dataset.tool));
  });
  if ($('btn-mirror-toggle')) $('btn-mirror-toggle').addEventListener('click', toggleMirrorFold);
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
  function setLayerScope(scope, withToast = false) {
    state.freeLayerScope = scope;
    $('layer-all').classList.toggle('active', scope === 'all');
    $('layer-top').classList.toggle('active', scope === 'top');
    if ($('layer-bottom')) $('layer-bottom').classList.toggle('active', scope === 'bottom');
    syncQuickRail();
    updateFreeBanner();
    if (withToast) {
      showToast(scope === 'all' ? t('toastLayerAll') : t('toastLayerOne'), 2000);
    }
  }
  function toggleSingleFlapScope() {
    setLayerScope(state.freeLayerScope === 'all' ? 'top' : 'all', true);
  }
  $('layer-all').addEventListener('click', () => setLayerScope('all'));
  $('layer-top').addEventListener('click', () => setLayerScope('top'));
  if ($('layer-bottom')) $('layer-bottom').addEventListener('click', () => setLayerScope('bottom'));
  document.querySelectorAll('[data-paper-size]').forEach(btn => {
    btn.addEventListener('click', () => applyPaperSizePreset(btn.dataset.paperSize));
  });
  if ($('btn-paper-orient')) {
    $('btn-paper-orient').addEventListener('click', swapPaperOrientation);
  }
  const applyCustomPaperFromInputs = () => {
    const wVal = parseFloat($('paper-custom-w')?.value || '15');
    const hVal = parseFloat($('paper-custom-h')?.value || '15');
    if (!Number.isFinite(wVal) || !Number.isFinite(hVal) || wVal <= 0 || hVal <= 0) return;
    const spec = makePaperSpec(wVal, hVal, 0, 'custom');
    setFreePaperSize(spec, `${spec.cmW}×${spec.cmH} (${formatRatioLabel(spec)})`);
  };
  if ($('btn-paper-custom-apply')) {
    $('btn-paper-custom-apply').addEventListener('click', applyCustomPaperFromInputs);
  }
  for (const id of ['paper-custom-w', 'paper-custom-h']) {
    const el = $(id);
    if (el) el.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyCustomPaperFromInputs(); });
  }

  document.querySelectorAll('[data-macro]').forEach(btn => btn.addEventListener('click', () => applyQuickMacro(btn.dataset.macro)));
  $('btn-undo').addEventListener('click', undoFreeStep);
  $('btn-redo').addEventListener('click', redoFreeStep);
  $('btn-reset').addEventListener('click', resetFreeStudio);

  // Floating Quick-Action Rail controls (in Free Fold Canvas)
  if ($('qbtn-dir')) {
    $('qbtn-dir').addEventListener('click', () => {
      setFoldDir(state.freeFoldDir === 'mountain' ? 'valley' : 'mountain');
    });
  }
  if ($('qbtn-layer')) $('qbtn-layer').addEventListener('click', toggleSingleFlapScope);
  if ($('qbtn-mirror')) $('qbtn-mirror').addEventListener('click', toggleMirrorFold);
  if ($('qbtn-flip')) $('qbtn-flip').addEventListener('click', () => applyQuickMacro('flip'));
  if ($('qbtn-rot')) $('qbtn-rot').addEventListener('click', () => applyQuickMacro('rot45'));
  if ($('qbtn-unfold')) $('qbtn-unfold').addEventListener('click', unfoldLastFreeStep);
  if ($('qbtn-undo')) $('qbtn-undo').addEventListener('click', undoFreeStep);

  // Keyboard Shortcuts Modal controls
  if ($('btn-shortcuts')) $('btn-shortcuts').addEventListener('click', openShortcutsModal);
  if ($('shortcuts-close-btn')) $('shortcuts-close-btn').addEventListener('click', closeShortcutsModal);
  if ($('shortcuts-modal')) {
    $('shortcuts-modal').addEventListener('click', (e) => { if (e.target === $('shortcuts-modal')) closeShortcutsModal(); });
  }

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
  loadFreeDraft();
  applyStaticI18n();
  renderPaperSwatches();
  selectLibraryModel('model-crane', true);
  requestAnimationFrame(tick);
}
