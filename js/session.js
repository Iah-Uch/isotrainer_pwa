import { state } from './state.js';
import { now, fmtMMSS, parseTimeToSeconds } from './utils.js';
import { resetStageSeries, resetSessionSeries, setYAxis, setStageXAxis, syncChartScales, plotStageSliceByIndex } from './charts.js';
import { applyPlotSettingsToDom } from './plans.js';
import { saveCompletedSession } from './plans.js';

export function parseTrainingCsv(text) {
  if (!text || !text.trim()) throw new Error('O texto do CSV está vazio.');
  const lines = text.trim().split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) throw new Error('O CSV deve incluir cabeçalho + ao menos uma linha de estágio.');
  const header = lines[0].split(';').map(s => s.trim());
  if (header.length < 4) throw new Error('Cabeçalho deve ser: ignorado;ignorado;data;atleta');
  const date = header[2], athlete = header.slice(3).join(';');
  const stages = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(';').map(s => s.trim());
    if (parts.length < 4) throw new Error(`Linha de estágio ${i + 1} deve ser: índice;HH:MM:SS;inferior;superior`);
    const index = parseInt(parts[0], 10);
    const durationSec = parseTimeToSeconds(parts[1]);
    const lower = Number(parts[2]), upper = Number(parts[3]);
    if ([index, lower, upper].some(Number.isNaN)) throw new Error(`Números inválidos na linha ${i + 1}.`);
    if (upper <= lower) throw new Error(`Superior deve ser maior que inferior na linha ${i + 1}.`);
    stages.push({ index, durationSec, lower, upper });
  }
  const totalDurationSec = stages.reduce((a, s) => a + s.durationSec, 0);
  return { date, athlete, stages, totalDurationSec };
}

export function startTraining(session) {
  stopTraining();
  state.trainingSession = session;
  state.isImportedSession = false;
  state.stageIdx = 0;
  // Arm waiting state but gate actual start behind user Play
  state.waitingForFirstHR = true;
  state.startPending = true;

  // UI priming (normal mode)
  document.getElementById('sessionAthlete').textContent = session.athlete || '—';
  document.getElementById('sessionMeta').textContent = `${session.date}`;
  document.getElementById('stageLabel').textContent = 'Aguardando FC...';
  document.getElementById('stageRange').textContent = '—';
  document.getElementById('stageElapsed').textContent = '00:00';
  document.getElementById('totalRemaining').textContent = fmtMMSS(session.totalDurationSec);



  resetStageSeries();
  resetSessionSeries();
  const firstStage = session.stages[0];
  setYAxis(firstStage.lower, firstStage.upper);
  setStageXAxis(firstStage.durationSec);
  // Initialize countdown with full stage duration
  const stageEl = document.getElementById('stageElapsed');
  if (stageEl) stageEl.textContent = fmtMMSS(firstStage.durationSec);
  // No fullscreen HUD elements to prime

  const allLows = session.stages.map(s => s.lower);
  const allHighs = session.stages.map(s => s.upper);
  const minHr = Math.min(...allLows);
  const maxHr = Math.max(...allHighs);
  const buffer = 10;
  state.trainingSession.sessionBounds = { min: minHr - buffer, max: maxHr + buffer };
  syncChartScales();

  state.paused = false; state.pausedAtMs = null; state.accumulatedPauseOffset = 0; state.stageAccumulatedPauseOffset = 0;
  showScreen('plot');
  setTimeout(() => { state.chart?.resize(); state.sessionChart?.resize(); }, 10);

  // Ensure FAB is visible in live mode (may have been hidden by view mode previously)
  try {
    const fabToggle = document.getElementById('fabToggle');
    const fabMenu = document.getElementById('fabMenu');
    if (fabToggle) fabToggle.classList.remove('hidden');
    if (fabMenu) fabMenu.classList.add('hidden');
  } catch { }

  state.pulseAnimation.startTime = performance.now();
  state.pulseAnimation.handle = requestAnimationFrame(animationLoop);

  // Show pre-start modal so the user explicitly starts
  const pre = document.getElementById('preStartModal');
  if (pre) {
    try {
      const range = `${firstStage.lower}/${firstStage.upper} bpm`;
      const rangeEl = document.getElementById('preStartStageRange');
      const hrEl = document.getElementById('preStartHrValue');
      const guideEl = document.getElementById('preStartText');
      const scaleMinEl = document.getElementById('preStartScaleMin');
      const scaleMaxEl = document.getElementById('preStartScaleMax');
      const targetEl = document.getElementById('preStartTarget');
      // Determine scale from overall session bounds if available; else pad ±20
      let scaleMin = (state.trainingSession?.sessionBounds?.min ?? (firstStage.lower - 20));
      let scaleMax = (state.trainingSession?.sessionBounds?.max ?? (firstStage.upper + 20));
      if (!Number.isFinite(scaleMin)) scaleMin = firstStage.lower - 20;
      if (!Number.isFinite(scaleMax)) scaleMax = firstStage.upper + 20;
      if (scaleMax <= scaleMin) scaleMax = scaleMin + 40;
      // Update scale labels
      if (scaleMinEl) scaleMinEl.textContent = `${Math.max(0, Math.round(scaleMin))} bpm`;
      if (scaleMaxEl) scaleMaxEl.textContent = `${Math.max(0, Math.round(scaleMax))} bpm`;
      // Position target segment
      if (targetEl) {
        const rangeSpan = Math.max(1, scaleMax - scaleMin);
        const leftPct = Math.max(0, Math.min(100, ((firstStage.lower - scaleMin) / rangeSpan) * 100));
        const rightPct = Math.max(0, Math.min(100, ((firstStage.upper - scaleMin) / rangeSpan) * 100));
        const widthPct = Math.max(0, rightPct - leftPct);
        targetEl.style.left = `${leftPct}%`;
        targetEl.style.width = `${widthPct}%`;
      }
      if (rangeEl) rangeEl.textContent = range;
      if (hrEl) hrEl.textContent = '—';
      if (guideEl) guideEl.textContent = 'Aguardando leitura da FC...';
    } catch { }
    pre.classList.remove('hidden');
  }
}

export function updateStageUI() {
  const st = state.trainingSession.stages[state.stageIdx];
  const label = `E${st.index}/${state.trainingSession.stages.length} • ${fmtMMSS(st.durationSec)}`;
  document.getElementById('stageLabel').textContent = label;
  document.getElementById('stageRange').textContent = `${st.lower}/${st.upper}`;
  // Reset stage countdown to full duration
  const el = document.getElementById('stageElapsed');
  if (el) el.textContent = fmtMMSS(st.durationSec);
  // Reset live metrics display (both desktop and mobile targets)
  const pctEls = [
    document.getElementById('stageInTargetPct'),
    document.getElementById('stageInTargetPctMobile')
  ].filter(Boolean);
  for (const elPct of pctEls) { elPct.textContent = '—'; }
  // Hide next-stage hint when entering a new stage
  const hint = document.getElementById('nextStageHint');
  if (hint) hint.classList.remove('show');

  // No fullscreen HUD stage text

  setYAxis(st.lower, st.upper);
  setStageXAxis(st.durationSec);
  resetStageSeries();
}

// Live metric: percentage of on-target readings for the whole session so far
export function updateLiveStageInTargetPct() {
  if (!state.trainingSession || state.stageIdx < 0) return;
  const els = [
    document.getElementById('stageInTargetPct'),
    document.getElementById('stageInTargetPctMobile')
  ].filter(Boolean);
  if (!els.length) return;
  // Build stage offsets to evaluate in-target over the entire timeline
  const stages = state.trainingSession.stages || [];
  if (!stages.length) { for (const el of els) el.textContent = '—'; return; }
  const offsets = [];
  let acc = 0;
  for (const s of stages) {
    offsets.push({ start: acc, end: acc + s.durationSec, lo: s.lower, hi: s.upper });
    acc += s.durationSec;
  }
  const series = state.sessionSeries || [];
  let total = 0, inTarget = 0;
  for (const p of series) {
    if (!p || typeof p.y !== 'number' || !isFinite(p.y)) continue;
    total += 1;
    const x = typeof p.x === 'number' ? p.x : 0;
    // Find corresponding stage by time (x)
    let st = null;
    for (let i = 0; i < offsets.length; i++) {
      const seg = offsets[i];
      if (x >= seg.start && x <= seg.end) { st = seg; break; }
    }
    if (!st) st = offsets[offsets.length - 1];
    if (st && p.y >= st.lo && p.y <= st.hi) inTarget += 1;
  }
  const pct = total ? Math.round((inTarget / total) * 100) : null;
  for (const el of els) el.textContent = (pct == null ? '—' : `${pct}%`);
}

function updateHalfwayNextStageHint(stageElapsedSec) {
  const hint = document.getElementById('nextStageHint');
  const label = document.getElementById('nextStageRange');
  if (!hint || !label) return;
  if (!state.trainingSession) { hint.classList.add('hidden'); return; }
  const stages = state.trainingSession.stages || [];
  const idx = state.stageIdx;
  if (idx < 0 || idx >= stages.length - 1) { hint.classList.remove('show'); return; }
  const cur = stages[idx];
  const next = stages[idx + 1];
  const half = (cur?.durationSec || 0) / 2;
  if (stageElapsedSec >= half) {
    label.textContent = `${next.lower}/${next.upper}`;
    hint.classList.add('show');
    // Add urgency in the last 10% of the stage
    const dur = cur?.durationSec || 0;
    if (dur > 0 && stageElapsedSec >= dur * 0.9) { hint.classList.add('urgent'); }
    else { hint.classList.remove('urgent'); }
  } else {
    hint.classList.remove('show');
    hint.classList.remove('urgent');
  }
}

export function computeTotalElapsedSec(nowMs) {
  if (!state.sessionStartMs) return 0;
  return Math.max(0, (nowMs - state.sessionStartMs - state.accumulatedPauseOffset) / 1000);
}

export function tick() {
  if (!state.trainingSession || state.paused || state.waitingForFirstHR) return;
  const nowMs = now();
  const st = state.trainingSession.stages[state.stageIdx];
  const stageElapsedSec = Math.max(0, (nowMs - state.stageStartMs - state.stageAccumulatedPauseOffset) / 1000);

  const stageRemainingSec = Math.max(0, st.durationSec - Math.min(stageElapsedSec, st.durationSec));
  const stageElapsedText = fmtMMSS(stageRemainingSec);
  document.getElementById('stageElapsed').textContent = stageElapsedText;

  // Show next-stage bounds hint after halfway point
  try { updateHalfwayNextStageHint(stageElapsedSec); } catch { }

  const totalElapsed = computeTotalElapsedSec(nowMs);
  const totalRemainingSec = Math.max(0, state.trainingSession.totalDurationSec - totalElapsed);
  const totalRemainingText = fmtMMSS(totalRemainingSec);
  document.getElementById('totalRemaining').textContent = totalRemainingText;

  // No fullscreen HUD timers

  if (stageElapsedSec >= st.durationSec) { nextStage(); }
}

export function navigateToStage(newIndex) {
  if (!state.trainingSession || newIndex < 0 || newIndex >= state.trainingSession.stages.length) return;
  let newStageStartTimeSec = 0;
  for (let i = 0; i < newIndex; i++) { newStageStartTimeSec += state.trainingSession.stages[i].durationSec; }
  const removalIndex = state.sessionSeries.findIndex(p => p.x >= newStageStartTimeSec);
  if (removalIndex !== -1) state.sessionSeries.length = removalIndex;
  const lastPoint = state.sessionSeries[state.sessionSeries.length - 1];
  if (lastPoint && lastPoint.y !== null) state.sessionSeries.push({ x: lastPoint.x, y: null });
  state.accumulatedPauseOffset = now() - state.sessionStartMs - (newStageStartTimeSec * 1000);
  state.stageIdx = newIndex; state.stageStartMs = now(); state.stageAccumulatedPauseOffset = 0; updateStageUI();
}

export function nextStage() {
  if (!state.trainingSession) return;
  if (state.stageIdx < state.trainingSession.stages.length - 1) {
    navigateToStage(state.stageIdx + 1);
  } else {
    // Finalize session
    pauseTraining(true);
    document.getElementById('stageLabel').textContent = `Concluída • ${state.trainingSession.stages.length} estágios`;
    const stats = computeSessionStats();
    showCompletion(stats);
  }
}
export function prevStage() { if (!state.trainingSession) return; navigateToStage(state.stageIdx - 1); }
export function pauseTraining(finalize = false) { if (state.paused) return; state.paused = true; state.pausedAtMs = now(); if (!finalize) setPlayPauseVisual(); }
export function resumeTraining() { if (!state.paused) return; const d = now() - state.pausedAtMs; state.accumulatedPauseOffset += d; state.stageAccumulatedPauseOffset += d; state.paused = false; state.pausedAtMs = null; setPlayPauseVisual(); }
export function stopTraining() {
  if (state.timerHandle) clearInterval(state.timerHandle);
  if (state.pulseAnimation.handle) { cancelAnimationFrame(state.pulseAnimation.handle); state.pulseAnimation.handle = null; }
  state.timerHandle = null; state.trainingSession = null; state.stageIdx = -1;
  state.sessionStartMs = state.stageStartMs = null; state.paused = false; state.pausedAtMs = null;
  state.accumulatedPauseOffset = state.stageAccumulatedPauseOffset = 0; state.waitingForFirstHR = false;
  state.isImportedSession = false;
}

export function setPlayPauseVisual() {
  const p = state.paused;
  const iconPause = document.getElementById('iconPause');
  const iconPlay = document.getElementById('iconPlay');
  const playPauseBtn = document.getElementById('playPauseBtn');
  iconPause.classList.toggle('hidden', p);
  iconPlay.classList.toggle('hidden', !p);
  playPauseBtn.setAttribute('aria-label', p ? 'Retomar treino' : 'Pausar treino');
}

export function showScreen(which) {
  const connect = document.getElementById('connectScreen');
  const home = document.getElementById('homeScreen');
  const plan = document.getElementById('planScreen');
  const plot = document.getElementById('plotScreen');
  const complete = document.getElementById('completeScreen');
  const editPlan = document.getElementById('editPlanScreen');
  const appRoot = document.getElementById('appRoot');
  const connectFabs = document.getElementById('connectFabs');
  const planFabs = document.getElementById('planFabs');
  const homeMenuWrap = document.getElementById('homeMenuWrap');
  connect.classList.add('hidden'); if (home) home.classList.add('hidden'); plan.classList.add('hidden'); plot.classList.add('hidden'); complete.classList.add('hidden');
  if (editPlan) editPlan.classList.add('hidden');
  if (which === 'connect') connect.classList.remove('hidden');
  if (which === 'home' && home) home.classList.remove('hidden');
  if (which === 'plan') plan.classList.remove('hidden');
  if (which === 'plot') plot.classList.remove('hidden');
  if (which === 'complete') complete.classList.remove('hidden');
  if (which === 'editPlan' && editPlan) editPlan.classList.remove('hidden');
  // Use full width only for plot screen
  if (appRoot) appRoot.classList.toggle('full-bleed', which === 'plot');
  // Apply plot visibility/scaling when entering plot screen
  if (which === 'plot') { try { applyPlotSettingsToDom(); } catch { } }
  if (connectFabs) {
    if (which === 'connect') connectFabs.classList.remove('hidden');
    else connectFabs.classList.add('hidden');
  }
  if (planFabs) {
    if (which === 'plan') planFabs.classList.remove('hidden');
    else planFabs.classList.add('hidden');
  }
  // Ensure Home FAB only appears on Home; actual visibility may be further
  // constrained by Home logic (e.g., hidden until plans are imported)
  if (homeMenuWrap) {
    if (which !== 'home') homeMenuWrap.classList.add('hidden');
    else homeMenuWrap.classList.remove('hidden');
  }
}

// Forcefully snap UI to Home, bypassing transient callers
// removed

export function animationLoop() {
  if (state.trainingSession) {
    if (state.sessionChart) {
      // Push latest session series to the ECharts line
      const data = (state.sessionSeries || []).map(p => [p.x, p.y]);
      try { state.sessionChart.setOption({ series: [{ data }] }, false, true); } catch { }
      // Rebuild stage bands to keep current-stage pulse/highlight in sync
      try { syncChartScales(); } catch { }
    }
    state.pulseAnimation.handle = requestAnimationFrame(animationLoop);
  }
}

// Compute simple session stats from sessionSeries
export function computeSessionStats() {
  const points = state.sessionSeries || [];
  if (!points.length || !state.trainingSession) {
    return { avg: 0, min: 0, max: 0, inTargetPct: 0 };
  }
  let sum = 0, count = 0, min = Infinity, max = -Infinity;
  let inTargetCount = 0;
  // Determine stage targets over time to compute in-target percentage
  // We map x (sec from start) to stage bounds using cumulative durations
  const stageOffsets = [];
  let acc = 0; for (const s of state.trainingSession.stages) { stageOffsets.push({ start: acc, end: acc + s.durationSec, lo: s.lower, hi: s.upper }); acc += s.durationSec; }

  for (const p of points) {
    if (p && typeof p.y === 'number') {
      const hr = p.y;
      sum += hr; count += 1; if (hr < min) min = hr; if (hr > max) max = hr;
      const x = p.x;
      const st = stageOffsets.find(r => x >= r.start && x <= r.end) || stageOffsets[stageOffsets.length - 1];
      if (st && hr >= st.lo && hr <= st.hi) inTargetCount += 1;
    }
  }
  const avg = count ? Math.round((sum / count)) : 0;
  const inTargetPct = count ? Math.round((inTargetCount / count) * 100) : 0;
  return { avg, min: isFinite(min) ? min : 0, max: isFinite(max) ? max : 0, inTargetPct };
}

function showCompletion(stats) {
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = String(v); };
  set('statAvg', `${stats.avg} bpm`);
  set('statMax', `${stats.max} bpm`);
  set('statMin', `${stats.min} bpm`);
  set('statInTarget', `${stats.inTargetPct}%`);
  // Completion UI behavior (imported sessions keep modal hidden for interaction)
  const modal = document.getElementById('completeScreen');
  const fab = document.getElementById('completeRestoreFab');
  const exportBtn = document.getElementById('completeExportBtn');
  const actions = document.getElementById('completeActions');
  const planBtn = document.getElementById('completePlanBtn');
  if (state.isImportedSession) {
    if (modal) modal.classList.add('hidden');
    if (fab) fab.classList.remove('hidden');
    if (exportBtn) exportBtn.classList.add('hidden');
    if (actions) {
      actions.classList.remove('grid', 'grid-cols-3', 'gap-2');
      actions.classList.add('flex', 'justify-center');
    }
  } else {
    if (modal) modal.classList.remove('hidden');
    if (fab) fab.classList.add('hidden');
    if (exportBtn) exportBtn.classList.remove('hidden');
    if (actions) {
      actions.classList.remove('flex', 'justify-center', 'grid-cols-3');
      actions.classList.add('grid', 'grid-cols-2', 'gap-2');
    }
  }
  // Show 'Carregar novo plano' only for Manual (origin = 'plan')
  try {
    if (planBtn) planBtn.classList.toggle('hidden', state.editOrigin !== 'plan');
  } catch { }
  // Close controls modal; control FAB visibility based on view/live mode
  const controls = document.getElementById('controlsModal');
  if (controls) controls.classList.add('hidden');
  const fabToggle = document.getElementById('fabToggle');
  const fabMenu = document.getElementById('fabMenu');
  // Hide FAB only in view mode (imported). Keep visible otherwise.
  if (state.isImportedSession) {
    if (fabToggle) fabToggle.classList.add('hidden');
    if (fabMenu) fabMenu.classList.add('hidden');
  } else {
    if (fabToggle) fabToggle.classList.remove('hidden');
    if (fabMenu) fabMenu.classList.add('hidden');
  }

  // Persist completed session locally for Home tabs (only for real trainings)
  try {
    if (!state.isImportedSession) {
      const csv = buildExportCsvFromState();
      const baseTitle = `${state.trainingSession?.date || 'Sessão'} • ${Number(state.trainingSession?.stages?.length || 0)} estágios`;
      const record = {
        date: state.trainingSession?.date || '',
        athlete: state.trainingSession?.athlete || '',
        totalDurationSec: state.trainingSession?.totalDurationSec || 0,
        stagesCount: state.trainingSession?.stages?.length || 0,
        stats,
        isImported: false,
        csv,
        completedAt: new Date().toISOString(),
        planId: state.trainingSession?.planId || state.trainingSession?.id || null,
        planIdx: (Number.isFinite(Number(state.trainingSession?.planIdx)) ? Number(state.trainingSession?.planIdx)
          : (Number.isFinite(Number(state.trainingSession?.idx)) ? Number(state.trainingSession?.idx) : null)),
      };
      // Tag manual flow sessions with a clear prefix in the title
      try {
        if (state.editOrigin === 'plan') record.title = `Manual • ${baseTitle}`;
      } catch { }
      saveCompletedSession(record);
      // Notify Home to refresh Done tab immediately
      try { window.dispatchEvent(new CustomEvent('sessions:updated')); } catch { }
    }
  } catch { }
}

function formatNumber(n, digits = 0) {
  if (typeof n !== 'number' || !isFinite(n)) return '';
  return digits ? n.toFixed(digits) : String(n);
}

function computePerStageStats() {
  if (!state.trainingSession) return [];
  const stages = state.trainingSession.stages || [];
  const offsets = [];
  let acc = 0;
  for (const s of stages) { offsets.push({ start: acc, end: acc + s.durationSec, lo: s.lower, hi: s.upper }); acc += s.durationSec; }

  const per = stages.map((s) => ({ durationSec: s.durationSec, lower: s.lower, upper: s.upper, sum: 0, min: Infinity, max: -Infinity, count: 0, inTarget: 0 }));
  const pts = state.sessionSeries || [];
  for (const p of pts) {
    if (!p || typeof p.y !== 'number') continue;
    const x = p.x;
    let idx = offsets.findIndex(r => x >= r.start && x <= r.end);
    if (idx === -1) idx = stages.length - 1;
    const st = per[idx];
    const hr = p.y;
    st.sum += hr; st.count += 1; if (hr < st.min) st.min = hr; if (hr > st.max) st.max = hr;
    const lo = stages[idx].lower, hi = stages[idx].upper;
    if (hr >= lo && hr <= hi) st.inTarget += 1;
  }
  return per.map((s, i) => ({
    index: i + 1,
    durationSec: stages[i].durationSec,
    lower: stages[i].lower,
    upper: stages[i].upper,
    avg: s.count ? Math.round(s.sum / s.count) : 0,
    min: isFinite(s.min) ? s.min : 0,
    max: isFinite(s.max) ? s.max : 0,
    inTargetPct: s.count ? Math.round((s.inTarget / s.count) * 100) : 0,
    samples: s.count
  }));
}

export function exportSessionCsv() {
  const csv = buildExportCsvFromState();
  if (!csv) return;
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const dateSlug = String(state.trainingSession?.date || '').replace(/\s+/g, '_');
  a.href = url; a.download = `cardiomax_${dateSlug || 'session'}.csv`;
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}

function buildExportCsvFromState() {
  if (!state.trainingSession) return;
  const session = state.trainingSession;
  const stats = computeSessionStats();
  const perStages = computePerStageStats();

  // Single, normalized table with a 'type' discriminator
  const header = [
    'type', 'date', 'athlete', 'stage_index', 'duration_sec', 'lower', 'upper', 'avg_bpm', 'min_bpm', 'max_bpm', 'in_target_pct', 'samples', 'elapsed_sec', 'stage_elapsed_sec', 'hr', 'in_target'
  ];
  const rows = [];
  // Summary row
  rows.push(['summary', session.date, session.athlete, '', session.totalDurationSec, '', '', stats.avg, stats.min, stats.max, stats.inTargetPct, '', '', '', '', '']);
  // Per-stage rows
  for (const s of perStages) {
    rows.push(['stage', session.date, session.athlete, s.index, s.durationSec, s.lower, s.upper, s.avg, s.min, s.max, s.inTargetPct, s.samples, '', '', '', '']);
  }
  // Time series rows
  const offsets = [];
  let acc = 0; for (const s of session.stages) { offsets.push({ start: acc, end: acc + s.durationSec, lo: s.lower, hi: s.upper }); acc += s.durationSec; }
  for (const p of (state.sessionSeries || [])) {
    const t = typeof p.x === 'number' ? p.x : 0;
    const hr = typeof p.y === 'number' ? p.y : '';
    let idx = offsets.findIndex(r => t >= r.start && t <= r.end);
    if (idx === -1) idx = session.stages.length - 1;
    const stage = session.stages[idx];
    const stageElapsed = Math.max(0, t - offsets[idx].start);
    const inTarget = typeof hr === 'number' ? (hr >= stage.lower && hr <= stage.upper ? 1 : 0) : '';
    rows.push(['series', session.date, session.athlete, idx + 1, stage.durationSec, stage.lower, stage.upper, '', '', '', '', '', formatNumber(t, 2), formatNumber(stageElapsed, 2), hr, inTarget]);
  }

  return [header.join(';'), ...rows.map(r => r.join(';'))].join('\n');
}

// Load a previously exported session CSV and render it as a finished session
export function loadCompletedSessionFromExportCsv(text) {
  if (!text || !text.trim()) throw new Error('O CSV está vazio.');
  const lines = text.trim().split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) throw new Error('CSV inválido.');
  const header = lines[0].split(';').map(s => s.trim());
  const colIdx = (name) => {
    const i = header.indexOf(name);
    if (i === -1) throw new Error(`Coluna ausente no CSV: ${name}`);
    return i;
  };
  // Detect exported format
  const hasType = header.includes('type');
  if (!hasType) throw new Error('Formato não suportado. Importe um CSV exportado do CardioMax.');

  const TYPE = colIdx('type');
  const DATE = colIdx('date');
  const ATHLETE = colIdx('athlete');
  const STAGE_INDEX = colIdx('stage_index');
  const DURATION = colIdx('duration_sec');
  const LOWER = colIdx('lower');
  const UPPER = colIdx('upper');
  const ELAPSED = colIdx('elapsed_sec');
  const HR = colIdx('hr');

  // Detect if this is a full export (multiple sessions concatenated under a single header)
  let summaryCount = 0;
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(';');
    if ((parts[TYPE] || '').trim() === 'summary') summaryCount += 1;
  }
  if (summaryCount > 1) {
    try {
      const imported = importAllCompletedSessionsFromCsv(text);
      try { window.dispatchEvent(new CustomEvent('sessions:updated')); } catch { }
      alert(`Exportação completa detectada. ${imported} sessão(ões) importadas.`);
      // Stay on Home screen; do not navigate to Plot
      return;
    } catch (err) {
      throw err;
    }
  }

  let date = '';
  let athlete = '';
  let totalDurationSec = 0;
  const stages = [];
  const series = [];

  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(';');
    if (!parts.length) continue;
    const t = (parts[TYPE] || '').trim();
    if (t === 'summary') {
      date = (parts[DATE] || '').trim();
      athlete = (parts[ATHLETE] || '').trim();
      totalDurationSec = Math.max(0, Number(parts[DURATION] || 0) || 0);
    } else if (t === 'stage') {
      const idx = Number(parts[STAGE_INDEX] || 0);
      const dur = Math.max(0, Number(parts[DURATION] || 0) || 0);
      const lo = Number(parts[LOWER] || NaN);
      const hi = Number(parts[UPPER] || NaN);
      stages.push({ index: idx, durationSec: dur, lower: lo, upper: hi });
    } else if (t === 'series') {
      const x = Number(parts[ELAPSED] || 0);
      const y = Number(parts[HR] || NaN);
      if (isFinite(x) && isFinite(y)) series.push({ x, y });
    }
  }

  if (!stages.length) throw new Error('Nenhum estágio encontrado no CSV.');
  if (!series.length) throw new Error('Nenhuma série de frequência cardíaca encontrada no CSV.');
  if (!totalDurationSec) { totalDurationSec = stages.reduce((a, s) => a + s.durationSec, 0); }

  // Prepare session state without starting timers
  stopTraining();
  const session = { date, athlete, stages, totalDurationSec };
  state.trainingSession = session;
  state.stageIdx = 0;
  state.waitingForFirstHR = false;
  state.isImportedSession = true;
  state.sessionStartMs = null;
  state.stageStartMs = null;
  state.paused = true;
  state.accumulatedPauseOffset = 0;
  state.stageAccumulatedPauseOffset = 0;

  // UI priming
  const firstStage = stages[0];
  document.getElementById('sessionAthlete').textContent = session.athlete || '—';
  document.getElementById('sessionMeta').textContent = `${session.date || '—'}`;
  document.getElementById('stageLabel').textContent = `Concluída • ${stages.length} estágios`;
  document.getElementById('stageRange').textContent = `${firstStage?.lower ?? '—'}/${firstStage?.upper ?? '—'}`;
  document.getElementById('stageElapsed').textContent = '00:00';
  document.getElementById('totalRemaining').textContent = '00:00';

  // Series + chart scales
  resetStageSeries();
  resetSessionSeries();
  state.sessionSeries.push(...series.sort((a, b) => a.x - b.x));

  const allLows = stages.map(s => s.lower);
  const allHighs = stages.map(s => s.upper);
  const minHr = Math.min(...allLows);
  const maxHr = Math.max(...allHighs);
  const buffer = 10;
  state.trainingSession.sessionBounds = { min: minHr - buffer, max: maxHr + buffer };
  syncChartScales();
  try {
    // Push series to chart now
    const data = (state.sessionSeries || []).map(p => [p.x, p.y]);
    state.sessionChart?.setOption({ series: [{ data }] }, false, true);
  } catch { }

  // Navigate to plot and show completion stats
  showScreen('plot');
  setTimeout(() => { try { state.chart?.resize(); state.sessionChart?.resize(); } catch { } }, 10);
  try { plotStageSliceByIndex(0); } catch { }
  const stats = computeSessionStats();
  showCompletion(stats);

  // Explicitly hide FAB in view mode
  try {
    const fabToggle = document.getElementById('fabToggle');
    const fabMenu = document.getElementById('fabMenu');
    if (fabToggle) fabToggle.classList.add('hidden');
    if (fabMenu) fabMenu.classList.add('hidden');
  } catch { }

  // Also persist imported sessions into Done list for Home
  try {
    const record = {
      date,
      athlete,
      totalDurationSec,
      stagesCount: stages.length,
      stats,
      isImported: true,
      csv: String(text || ''),
      completedAt: new Date().toISOString(),
      planId: null,
      planIdx: null,
      title: `Importado • ${date || 'Sessão'} • ${stages.length} estágios`
    };
    saveCompletedSession(record);
    try { window.dispatchEvent(new CustomEvent('sessions:updated')); } catch { }
  } catch { }
}

// Import multiple completed sessions from a combined export CSV (single header, many sessions)
function importAllCompletedSessionsFromCsv(text) {
  const raw = String(text || '').trim();
  const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) throw new Error('CSV inválido.');
  const header = lines[0].split(';').map(s => s.trim());
  const colIdx = (name) => {
    const i = header.indexOf(name);
    if (i === -1) throw new Error(`Coluna ausente no CSV: ${name}`);
    return i;
  };
  const TYPE = colIdx('type');
  const DATE = colIdx('date');
  const ATHLETE = colIdx('athlete');
  const STAGE_INDEX = colIdx('stage_index');
  const DURATION = colIdx('duration_sec');
  const LOWER = colIdx('lower');
  const UPPER = colIdx('upper');
  const ELAPSED = colIdx('elapsed_sec');
  const HR = colIdx('hr');

  // Group lines by session, delimited by 'summary'
  const sessions = [];
  let current = null;
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(';');
    const t = (parts[TYPE] || '').trim();
    if (t === 'summary') {
      // start a new session
      if (current) sessions.push(current);
      current = {
        date: (parts[DATE] || '').trim(),
        athlete: (parts[ATHLETE] || '').trim(),
        totalDurationSec: Math.max(0, Number(parts[DURATION] || 0) || 0),
        stages: [],
        series: [],
        csvLines: [lines[0], lines[i]] // include header and this summary line
      };
      continue;
    }
    if (!current) continue; // ignore preface lines, if any
    if (t === 'stage') {
      const idx = Number(parts[STAGE_INDEX] || 0);
      const dur = Math.max(0, Number(parts[DURATION] || 0) || 0);
      const lo = Number(parts[LOWER] || NaN);
      const hi = Number(parts[UPPER] || NaN);
      current.stages.push({ index: idx, durationSec: dur, lower: lo, upper: hi });
      current.csvLines.push(lines[i]);
    } else if (t === 'series') {
      const x = Number(parts[ELAPSED] || 0);
      const y = Number(parts[HR] || NaN);
      if (isFinite(x) && isFinite(y)) current.series.push({ x, y });
      current.csvLines.push(lines[i]);
    } else {
      // Unknown type; include raw line for fidelity
      current.csvLines.push(lines[i]);
    }
  }
  if (current) sessions.push(current);

  // Compute stats for each and persist
  let imported = 0;
  for (const s of sessions) {
    if (!s || !s.stages?.length) continue;
    if (!s.totalDurationSec) {
      s.totalDurationSec = s.stages.reduce((a, st) => a + Math.max(0, Number(st.durationSec) || 0), 0);
    }
    // Stats
    const stats = computeStatsForSeries(s.series, s.stages);
    const record = {
      date: s.date,
      athlete: s.athlete,
      totalDurationSec: s.totalDurationSec,
      stagesCount: s.stages.length,
      stats,
      isImported: true,
      csv: s.csvLines.join('\n'),
      completedAt: new Date().toISOString(),
      planId: null,
      planIdx: null,
      title: `Importado • ${s.date || 'Sessão'} • ${s.stages.length} estágios`
    };
    try { saveCompletedSession(record); imported += 1; } catch { }
  }
  return imported;
}

function computeStatsForSeries(series, stages) {
  const points = Array.isArray(series) ? series : [];
  if (!points.length || !stages?.length) {
    return { avg: 0, min: 0, max: 0, inTargetPct: 0 };
  }
  let sum = 0, count = 0, min = Infinity, max = -Infinity, inTarget = 0;
  const offsets = [];
  let acc = 0;
  for (const st of stages) { offsets.push({ start: acc, end: acc + st.durationSec, lo: st.lower, hi: st.upper }); acc += st.durationSec; }
  for (const p of points) {
    if (!p || typeof p.y !== 'number') continue;
    const hr = p.y;
    sum += hr; count += 1; if (hr < min) min = hr; if (hr > max) max = hr;
    const x = typeof p.x === 'number' ? p.x : 0;
    const idx = Math.max(0, offsets.findIndex(r => x >= r.start && x <= r.end));
    const st = offsets[idx] || offsets[offsets.length - 1];
    if (st && hr >= st.lo && hr <= st.hi) inTarget += 1;
  }
  return {
    avg: count ? Math.round(sum / count) : 0,
    min: isFinite(min) ? min : 0,
    max: isFinite(max) ? max : 0,
    inTargetPct: count ? Math.round((inTarget / count) * 100) : 0
  };
}

// Handle stage selection from session plot clicks
window.addEventListener('session:stageSelected', (e) => {
  if (!state.trainingSession || !state.isImportedSession) return;
  const idx = Math.max(0, Math.min((e?.detail?.index ?? 0), state.trainingSession.stages.length - 1));
  state.stageIdx = idx;
  updateStageUI();
  try { plotStageSliceByIndex(idx); } catch { }
  try { syncChartScales(); } catch { }
});
