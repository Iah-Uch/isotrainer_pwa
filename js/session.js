// Module: Session lifecycle, UI updates, metrics and CSV import/export.
import { state, DEV_BYPASS_CONNECT } from './state.js';
import './session-prestart.js';
import { now, fmtMMSS, parseTimeToSeconds, clamp } from './utils.js';
import {
  resetStageSeries,
  resetSessionSeries,
  setYAxis,
  setStageXAxis,
  syncChartScales,
  plotStageSliceByIndex,
  refreshSessionSeries,
} from './charts.js';
import {
  applyPlotSettingsToDom,
  saveCompletedSession,
  getFixedPlanById,
  FLOW_TRAINING_STEPS,
  sanitizeFlowStepOrder,
} from './plans.js';

const N_PER_KGF = 9.80665;
const FLOW_MEASUREMENT_MS = 3000;
const MEASUREMENT_START_THRESHOLD_KGF = 0.5;

function ensureSessionUsesKgf(session) {
  if (!session || session.forceUnit === 'kgf') return;
  const stages = Array.isArray(session.stages) ? session.stages : [];
  if (!stages.length) {
    session.forceUnit = 'kgf';
    return;
  }
  const uppers = stages
    .map((stage) => Number(stage?.upper))
    .filter((value) => Number.isFinite(value));
  const shouldConvert =
    session.forceUnit === 'N' ||
    (!session.forceUnit && uppers.length && Math.max(...uppers) > 200);
  if (!shouldConvert) {
    session.forceUnit = 'kgf';
    return;
  }
  const toKgf = (value) => {
    if (!Number.isFinite(value)) return value;
    return Number((value / N_PER_KGF).toFixed(1));
  };
  stages.forEach((stage) => {
    if (!stage || typeof stage !== 'object') return;
    stage.lower = toKgf(Number(stage.lower));
    stage.upper = toKgf(Number(stage.upper));
  });
  if (session.sessionBounds) {
    const bounds = session.sessionBounds;
    if (bounds) {
      if (Number.isFinite(bounds.min)) bounds.min = toKgf(bounds.min);
      if (Number.isFinite(bounds.max)) bounds.max = toKgf(bounds.max);
    }
  }
  session.forceUnit = 'kgf';
}

function convertSeriesToKgfIfNeeded(series) {
  if (!Array.isArray(series) || !series.length) return;
  const forces = series
    .map((pt) => Number(pt?.y))
    .filter((value) => Number.isFinite(value));
  if (!forces.length) return;
  const maxForce = Math.max(...forces);
  if (maxForce <= 200) return;
  series.forEach((pt) => {
    if (!pt || typeof pt !== 'object') return;
    if (!Number.isFinite(pt.y)) return;
    pt.y = Number((pt.y / N_PER_KGF).toFixed(2));
  });
}

export function parseTrainingCsv(text) {
  if (!text || !text.trim()) throw new Error("O texto do CSV está vazio.");
  const lines = text
    .trim()
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2)
    throw new Error(
      "O CSV deve incluir cabeçalho + ao menos uma linha de estágio.",
    );
  const header = lines[0].split(";").map((s) => s.trim());
  if (header.length < 4)
    throw new Error("Cabeçalho deve ser: ignorado;ignorado;data;atleta");
  const date = header[2],
    athlete = header.slice(3).join(";");
  const stages = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(";").map((s) => s.trim());
    if (parts.length < 4)
      throw new Error(
        `Linha de estágio ${i + 1} deve ser: índice;HH:MM:SS;inferior;superior`,
      );
    const index = parseInt(parts[0], 10);
    const durationSec = parseTimeToSeconds(parts[1]);
    const lower = Number(parts[2]),
      upper = Number(parts[3]);
    if ([index, lower, upper].some(Number.isNaN))
      throw new Error(`Números inválidos na linha ${i + 1}.`);
    if (upper <= lower)
      throw new Error(
        `Superior deve ser maior que inferior na linha ${i + 1}.`,
      );
    stages.push({ index, durationSec, lower, upper });
  }
  const totalDurationSec = stages.reduce((a, s) => a + s.durationSec, 0);
  return { date, athlete, stages, totalDurationSec };
}

export function startTraining(session) {
  stopTraining();
  try {
    console.log('[nav] startTraining', {
      stageCount: session?.stages?.length,
      origin: state.editOrigin,
    });
  } catch { }
  state.trainingSession = session;
  ensureSessionUsesKgf(state.trainingSession);
  state.isImportedSession = false;
  state.viewSeriesGroups = [];
  state.viewSeriesActiveGroup = 0;
  try {
    renderViewSeriesFab();
  } catch { }
  state.stageIdx = 0;
  // Arm waiting state; gate actual start behind user Play.
  state.waitingForFirstSample = true;

  // Prime UI (normal mode).
  document.getElementById("sessionAthlete").textContent =
    session.athlete || "—";
  document.getElementById("sessionMeta").textContent = `${session.date}`;
  document.getElementById("stageLabel").textContent = "Aguardando força...";
  document.getElementById("stageRange").textContent = "—";
  document.getElementById("stageElapsed").textContent = "00:00";
  document.getElementById("totalRemaining").textContent = fmtMMSS(
    session.totalDurationSec,
  );

  resetStageSeries();
  resetSessionSeries();
  const firstStage = session.stages[0];
  setYAxis(firstStage.lower, firstStage.upper);
  setStageXAxis(firstStage.durationSec);
  // Initialize countdown with full stage duration.
  const stageEl = document.getElementById("stageElapsed");
  if (stageEl) stageEl.textContent = fmtMMSS(firstStage.durationSec);
  // No fullscreen HUD elements to prime.

  const allLows = session.stages.map((s) => s.lower);
  const allHighs = session.stages.map((s) => s.upper);
  const minHr = Math.min(...allLows);
  const maxHr = Math.max(...allHighs);
  const buffer = 2;
  state.trainingSession.sessionBounds = {
    min: minHr - buffer,
    max: maxHr + buffer,
  };
  syncChartScales();

  state.paused = false;
  state.pausedAtMs = null;
  state.accumulatedPauseOffset = 0;
  state.stageAccumulatedPauseOffset = 0;
  showScreen("plot");
  setTimeout(() => {
    state.chart?.resize();
    state.sessionChart?.resize();
  }, 10);

  // Ensure FAB is visible in live mode (may have been hidden by view mode).
  try {
    const fabToggle = document.getElementById("fabToggle");
    const fabMenu = document.getElementById("fabMenu");
    if (fabToggle) fabToggle.classList.remove("hidden");
    if (fabMenu) fabMenu.classList.add("hidden");
  } catch { }

  state.pulseAnimation.startTime = performance.now();
  state.pulseAnimation.handle = requestAnimationFrame(animationLoop);

  // Show prestart modal before starting session
  if (window.showPreStartModal) {
    window.onPreStartProceed = () => {
      state.waitingForFirstSample = false;
      // Start session as normal (data will arrive and tick will proceed)
    };
    window.showPreStartModal(session.stages[0]);
  } else {
    // Fallback: begin session as soon as data arrives.
    state.waitingForFirstSample = false;
  }
}

export function updateStageUI() {
  const st = state.trainingSession.stages[state.stageIdx];
  const label = `E${st.index}/${state.trainingSession.stages.length} • ${fmtMMSS(st.durationSec)}`;
  document.getElementById("stageLabel").textContent = label;
  document.getElementById("stageRange").textContent = `${st.lower}/${st.upper}`;
  // Reset stage countdown to full duration.
  const el = document.getElementById("stageElapsed");
  if (el) el.textContent = fmtMMSS(st.durationSec);
  // Reset live metrics display (both desktop and mobile targets).
  const pctEls = [
    document.getElementById("stageInTargetPct"),
    document.getElementById("stageInTargetPctMobile"),
  ].filter(Boolean);
  for (const elPct of pctEls) {
    elPct.textContent = "—";
  }
  // Hide next-stage hint when entering a new stage.
  const hint = document.getElementById("nextStageHint");
  if (hint) hint.classList.remove("show");

  // No fullscreen HUD stage text.

  setYAxis(st.lower, st.upper);
  setStageXAxis(st.durationSec);
  resetStageSeries();
}

// Live metric: percent of on-target readings for the session so far.
export function updateLiveStageInTargetPct() {
  if (!state.trainingSession || state.stageIdx < 0) return;
  const els = [
    document.getElementById("stageInTargetPct"),
    document.getElementById("stageInTargetPctMobile"),
  ].filter(Boolean);
  if (!els.length) return;
  // Build stage offsets to evaluate in-target over the entire timeline.
  const stages = state.trainingSession.stages || [];
  if (!stages.length) {
    for (const el of els) el.textContent = "—";
    return;
  }
  const offsets = [];
  let acc = 0;
  for (const s of stages) {
    offsets.push({
      start: acc,
      end: acc + s.durationSec,
      lo: s.lower,
      hi: s.upper,
    });
    acc += s.durationSec;
  }
  const series = state.sessionSeries || [];
  let total = 0,
    inTarget = 0;
  for (const p of series) {
    if (!p || typeof p.y !== "number" || !isFinite(p.y)) continue;
    total += 1;
    const x = typeof p.x === "number" ? p.x : 0;
    // Find corresponding stage by time.
    let st = null;
    for (let i = 0; i < offsets.length; i++) {
      const seg = offsets[i];
      if (x >= seg.start && x <= seg.end) {
        st = seg;
        break;
      }
    }
    if (!st) st = offsets[offsets.length - 1];
    if (st && p.y >= st.lo && p.y <= st.hi) inTarget += 1;
  }
  const pct = total ? Math.round((inTarget / total) * 100) : null;
  for (const el of els) el.textContent = pct == null ? "—" : `${pct}%`;
}

function updateHalfwayNextStageHint(stageElapsedSec) {
  const hint = document.getElementById("nextStageHint");
  const label = document.getElementById("nextStageRange");
  if (!hint || !label) return;
  if (!state.trainingSession) {
    hint.classList.add("hidden");
    return;
  }
  const stages = state.trainingSession.stages || [];
  const idx = state.stageIdx;
  if (idx < 0 || idx >= stages.length - 1) {
    hint.classList.remove("show");
    return;
  }
  const cur = stages[idx];
  const next = stages[idx + 1];
  const half = (cur?.durationSec || 0) / 2;
  if (stageElapsedSec >= half) {
    label.textContent = `${next.lower}/${next.upper}`;
    hint.classList.add("show");
    // Add urgency in the last 10% of the stage
    const dur = cur?.durationSec || 0;
    if (dur > 0 && stageElapsedSec >= dur * 0.9) {
      hint.classList.add("urgent");
    } else {
      hint.classList.remove("urgent");
    }
  } else {
    hint.classList.remove("show");
    hint.classList.remove("urgent");
  }
}

export function computeTotalElapsedSec(nowMs) {
  if (!state.sessionStartMs) return 0;
  return Math.max(
    0,
    (nowMs - state.sessionStartMs - state.accumulatedPauseOffset) / 1000,
  );
}

export function tick() {
  if (!state.trainingSession || state.paused || state.waitingForFirstSample) return;
  const nowMs = now();
  const st = state.trainingSession.stages[state.stageIdx];
  const stageElapsedSec = Math.max(
    0,
    (nowMs - state.stageStartMs - state.stageAccumulatedPauseOffset) / 1000,
  );

  const stageRemainingSec = Math.max(
    0,
    st.durationSec - Math.min(stageElapsedSec, st.durationSec),
  );
  const stageElapsedText = fmtMMSS(stageRemainingSec);
  document.getElementById("stageElapsed").textContent = stageElapsedText;

  // Show next-stage bounds hint after halfway point.
  try {
    updateHalfwayNextStageHint(stageElapsedSec);
  } catch { }

  const totalElapsed = computeTotalElapsedSec(nowMs);
  const totalRemainingSec = Math.max(
    0,
    state.trainingSession.totalDurationSec - totalElapsed,
  );
  const totalRemainingText = fmtMMSS(totalRemainingSec);
  document.getElementById("totalRemaining").textContent = totalRemainingText;

  // No fullscreen HUD timers.

  if (stageElapsedSec >= st.durationSec) {
    nextStage();
  }
}

export function navigateToStage(newIndex) {
  if (
    !state.trainingSession ||
    newIndex < 0 ||
    newIndex >= state.trainingSession.stages.length
  )
    return;
  let newStageStartTimeSec = 0;
  for (let i = 0; i < newIndex; i++) {
    newStageStartTimeSec += state.trainingSession.stages[i].durationSec;
  }
  const removalIndex = state.sessionSeries.findIndex(
    (p) => p.x >= newStageStartTimeSec,
  );
  if (removalIndex !== -1) state.sessionSeries.length = removalIndex;
  const lastPoint = state.sessionSeries[state.sessionSeries.length - 1];
  if (lastPoint && lastPoint.y !== null)
    state.sessionSeries.push({ x: lastPoint.x, y: null });
  state.accumulatedPauseOffset =
    now() - state.sessionStartMs - newStageStartTimeSec * 1000;
  state.stageIdx = newIndex;
  state.stageStartMs = now();
  state.stageAccumulatedPauseOffset = 0;
  updateStageUI();
}

export function nextStage() {
  if (!state.trainingSession) return;
  if (state.stageIdx < state.trainingSession.stages.length - 1) {
    navigateToStage(state.stageIdx + 1);
  } else {
    // Finalize session
    pauseTraining(true);
    document.getElementById("stageLabel").textContent =
      `Concluída • ${state.trainingSession.stages.length} estágios`;
    const stats = computeSessionStats();
    showCompletion(stats);
    if (state.flowActive) handleFlowStepCompletion(stats);
  }
}
export function prevStage() {
  if (!state.trainingSession) return;
  navigateToStage(state.stageIdx - 1);
}
export function pauseTraining(finalize = false) {
  if (state.paused) return;
  state.paused = true;
  state.pausedAtMs = now();
  if (!finalize) setPlayPauseVisual();
}
export function resumeTraining() {
  if (!state.paused) return;
  const d = now() - state.pausedAtMs;
  state.accumulatedPauseOffset += d;
  state.stageAccumulatedPauseOffset += d;
  state.paused = false;
  state.pausedAtMs = null;
  setPlayPauseVisual();
}
export function stopTraining() {
  if (state.timerHandle) clearInterval(state.timerHandle);
  if (state.pulseAnimation.handle) {
    cancelAnimationFrame(state.pulseAnimation.handle);
    state.pulseAnimation.handle = null;
  }
  state.timerHandle = null;
  state.trainingSession = null;
  state.stageIdx = -1;
  state.sessionStartMs = state.stageStartMs = null;
  state.paused = false;
  state.pausedAtMs = null;
  state.accumulatedPauseOffset = state.stageAccumulatedPauseOffset = 0;
  state.waitingForFirstSample = false;
  state.isImportedSession = false;
}

export function setPlayPauseVisual() {
  const p = state.paused;
  const iconPause = document.getElementById("iconPause");
  const iconPlay = document.getElementById("iconPlay");
  const playPauseBtn = document.getElementById("playPauseBtn");
  iconPause.classList.toggle("hidden", p);
  iconPlay.classList.toggle("hidden", !p);
  playPauseBtn.setAttribute(
    "aria-label",
    p ? "Retomar treino" : "Pausar treino",
  );
}

export function showScreen(which) {
  const connect = document.getElementById("connectScreen");
  const home = document.getElementById("homeScreen");
  const plan = document.getElementById("planScreen");
  const plot = document.getElementById("plotScreen");
  const complete = document.getElementById("completeScreen");
  const editPlan = document.getElementById("editPlanScreen");
  const appRoot = document.getElementById("appRoot");
  const connectFabs = document.getElementById("connectFabs");
  const planFabs = document.getElementById("planFabs");
  const homeMenuWrap = document.getElementById("homeMenuWrap");
  connect.classList.add("hidden");
  if (home) home.classList.add("hidden");
  plan.classList.add("hidden");
  plot.classList.add("hidden");
  complete.classList.add("hidden");
  if (editPlan) editPlan.classList.add("hidden");
  if (which === "connect") connect.classList.remove("hidden");
  if (which === "home" && home) home.classList.remove("hidden");
  if (which === "plan") plan.classList.remove("hidden");
  if (which === "plot") plot.classList.remove("hidden");
  if (which === "complete") complete.classList.remove("hidden");
  if (which === "editPlan" && editPlan) editPlan.classList.remove("hidden");
  // Use full width only for plot screen
  if (appRoot) appRoot.classList.toggle("full-bleed", which === "plot");
  // Apply plot visibility/scaling when entering plot screen
  if (which === "plot") {
    try {
      applyPlotSettingsToDom();
    } catch { }
  }
  if (connectFabs) {
    if (which === "connect") connectFabs.classList.remove("hidden");
    else connectFabs.classList.add("hidden");
  }
  if (planFabs) {
    if (which === "plan") planFabs.classList.remove("hidden");
    else planFabs.classList.add("hidden");
  }
  // Ensure Home FAB only appears on Home; actual visibility may be further
  // constrained by Home logic (e.g., hidden until plans are imported)
  if (homeMenuWrap) {
    if (which !== "home") homeMenuWrap.classList.add("hidden");
    else homeMenuWrap.classList.remove("hidden");
  }
}

// Forcefully snap UI to Home, bypassing transient callers
// removed

export function animationLoop() {
  if (state.trainingSession) {
    if (state.sessionChart) {
      // Push latest session series to the ECharts line
      try {
        refreshSessionSeries();
      } catch { }
      // Rebuild stage bands to keep current-stage pulse/highlight in sync
      try {
        syncChartScales();
      } catch { }
    }
    state.pulseAnimation.handle = requestAnimationFrame(animationLoop);
  }
}

// Compute simple session stats from sessionSeries
export function computeSessionStats(
  session = state.trainingSession,
  points = state.sessionSeries,
) {
  const data = Array.isArray(points) ? points : [];
  if (!data.length || !session || !Array.isArray(session.stages)) {
    return { avg: 0, min: 0, max: 0, inTargetPct: 0, samples: 0 };
  }
  let sum = 0,
    count = 0,
    min = Infinity,
    max = -Infinity;
  let inTargetCount = 0;
  // Determine stage targets over time to compute in-target percentage
  // We map x (sec from start) to stage bounds using cumulative durations
  const stageOffsets = [];
  let acc = 0;
  for (const s of session.stages) {
    stageOffsets.push({
      start: acc,
      end: acc + s.durationSec,
      lo: s.lower,
      hi: s.upper,
    });
    acc += s.durationSec;
  }

  for (const p of data) {
    if (p && typeof p.y === "number") {
      const force = p.y;
      sum += force;
      count += 1;
      if (force < min) min = force;
      if (force > max) max = force;
      const x = p.x;
      const st =
        stageOffsets.find((r) => x >= r.start && x <= r.end) ||
        stageOffsets[stageOffsets.length - 1];
      if (st && force >= st.lo && force <= st.hi) inTargetCount += 1;
    }
  }
  const avg = count ? Math.round(sum / count) : 0;
  const inTargetPct = count ? Math.round((inTargetCount / count) * 100) : 0;
  return {
    avg,
    min: isFinite(min) ? min : 0,
    max: isFinite(max) ? max : 0,
    inTargetPct,
    samples: count,
  };
}

function showCompletion(stats) {
  const flowStep = state.flowActive ? state.pendingTrainingStep : null;
  const hasMoreFlowSteps = flowStep ? flowHasNextStep() : false;
  const set = (id, v) => {
    const el = document.getElementById(id);
    if (el) el.textContent = String(v);
  };
  set("statAvg", `${stats.avg.toFixed(1)} kgf`);
  set("statMax", `${stats.max.toFixed(1)} kgf`);
  set("statMin", `${stats.min.toFixed(1)} kgf`);
  set("statInTarget", `${stats.inTargetPct.toFixed(1)}%`);
  // Completion UI behavior (imported sessions keep modal hidden for interaction)
  const modal = document.getElementById("completeScreen");
  const fab = document.getElementById("completeRestoreFab");
  const exportBtn = document.getElementById("completeExportBtn");
  const actions = document.getElementById("completeActions");
  const planBtn = document.getElementById("completePlanBtn");
  if (hasMoreFlowSteps) {
    if (modal) modal.classList.add("hidden");
    if (fab) fab.classList.add("hidden");
    if (exportBtn) exportBtn.classList.add("hidden");
    if (actions) {
      actions.classList.remove("grid", "grid-cols-3", "gap-2");
      actions.classList.remove("flex", "justify-center");
    }
  } else if (state.isImportedSession) {
    if (modal) modal.classList.add("hidden");
    if (fab) fab.classList.remove("hidden");
    if (exportBtn) exportBtn.classList.add("hidden");
    if (actions) {
      actions.classList.remove("grid", "grid-cols-3", "gap-2");
      actions.classList.add("flex", "justify-center");
    }
  } else {
    if (modal) modal.classList.remove("hidden");
    if (fab) fab.classList.add("hidden");
    if (exportBtn) exportBtn.classList.remove("hidden");
    if (actions) {
      actions.classList.remove("flex", "justify-center", "grid-cols-3");
      actions.classList.add("grid", "grid-cols-2", "gap-2");
    }
  }
  // Show 'Carregar novo plano' only for Manual (origin = 'plan')
  try {
    if (planBtn)
      planBtn.classList.toggle(
        "hidden",
        state.editOrigin !== "plan" || !!flowStep,
      );
  } catch { }
  // Close controls modal; control FAB visibility based on view/live mode
  const controls = document.getElementById("controlsModal");
  if (controls) controls.classList.add("hidden");
  const fabToggle = document.getElementById("fabToggle");
  const fabMenu = document.getElementById("fabMenu");
  // Hide FAB only in view mode (imported). Keep visible otherwise.
  if (state.isImportedSession || hasMoreFlowSteps) {
    if (fabToggle) fabToggle.classList.add("hidden");
    if (fabMenu) fabMenu.classList.add("hidden");
  } else {
    if (fabToggle) fabToggle.classList.remove("hidden");
    if (fabMenu) fabMenu.classList.add("hidden");
  }

  // Persist completed session locally for Home tabs (only for real trainings)
  try {
    if (!state.isImportedSession) {
      const sessionData = state.trainingSession;
      if (!sessionData) return;
      const seriesPoints = Array.isArray(state.sessionSeries)
        ? state.sessionSeries
        : [];
      const csv = buildExportCsvFromState(sessionData, seriesPoints);
      const stageSnapshot = Array.isArray(sessionData.stages)
        ? sessionData.stages.map((stage) => ({ ...stage }))
        : [];
      const baseTitle = `${sessionData.date || "Sessão"} • ${Number(stageSnapshot.length)} estágios`;
      const record = {
        date: sessionData.date || "",
        athlete: sessionData.athlete || "",
        totalDurationSec: sessionData.totalDurationSec || 0,
        stagesCount: stageSnapshot.length,
        stats: { ...stats },
        isImported: false,
        csv,
        completedAt: new Date().toISOString(),
        planId: sessionData.planId || sessionData.id || null,
        planIdx: Number.isFinite(Number(sessionData.planIdx))
          ? Number(sessionData.planIdx)
          : Number.isFinite(Number(sessionData.idx))
            ? Number(sessionData.idx)
            : null,
      };
      // Tag manual flow sessions with a clear prefix in the title
      try {
        if (state.editOrigin === "plan")
          record.title = `Manual • ${baseTitle}`;
        else if (flowStep && state.flowPlan) {
          const stepLabel = flowStep?.suffix
            ? `${state.flowPlan.name || "Plano"}${flowStep.suffix}`
            : `${state.flowPlan.name || "Plano"}`;
          record.title = `Plano fixo • ${stepLabel}`;
          record.planId = state.flowPlan.id || record.planId;
          record.planIdx = flowStep.id || record.planIdx;
        }
      } catch { }
      const stepTitle = record.title || baseTitle;
      const stepStats = { ...stats };
      if (state.flowActive) {
        captureFlowStepRecord({
          title: stepTitle,
          stats: stepStats,
          stages: stageSnapshot,
          series: seriesPoints.map((p) => ({ x: p?.x ?? 0, y: p?.y ?? null })),
          totalDurationSec: record.totalDurationSec,
          stagesCount: stageSnapshot.length,
          date: record.date,
          athlete: record.athlete,
          planId: record.planId,
          planIdx: record.planIdx,
          csv,
          completedAt: record.completedAt,
          flowStepId: flowStep?.id || null,
        });
      } else {
        record.stages = stageSnapshot;
        record.steps = [
          {
            title: stepTitle,
            stats: stepStats,
            stageCount: stageSnapshot.length,
            totalDurationSec: record.totalDurationSec,
            stages: stageSnapshot,
            flowStepId: null,
          },
        ];
        saveCompletedSession(record);
        try {
          window.dispatchEvent(new CustomEvent("sessions:updated"));
        } catch { }
      }
    }
  } catch { }
}

function captureFlowStepRecord(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return;
  if (!Array.isArray(state.flowStepRecords)) state.flowStepRecords = [];
  const stages = Array.isArray(snapshot.stages)
    ? snapshot.stages.map((stage) => ({
      index: Number.isFinite(Number(stage?.index))
        ? Number(stage.index)
        : undefined,
      durationSec: Math.max(0, Number(stage?.durationSec) || 0),
      lower: Number(stage?.lower) || 0,
      upper: Number(stage?.upper) || 0,
    }))
    : [];
  const series = Array.isArray(snapshot.series)
    ? snapshot.series.map((point) => ({
      x: Number(point?.x) || 0,
      y: typeof point?.y === "number" ? point.y : null,
    }))
    : [];
  const inferredSamples = series.filter((p) => typeof p.y === "number").length;
  const stats = snapshot.stats
    ? { ...snapshot.stats }
    : { avg: 0, min: 0, max: 0, inTargetPct: 0, samples: inferredSamples };
  if (!Number.isFinite(Number(stats.samples))) stats.samples = inferredSamples;
  const durationFromStages = stages.reduce(
    (sum, st) => sum + (Number.isFinite(Number(st.durationSec)) ? Number(st.durationSec) : 0),
    0,
  );
  const totalDurationSec = Math.max(
    0,
    Number.isFinite(Number(snapshot.totalDurationSec))
      ? Number(snapshot.totalDurationSec)
      : durationFromStages,
  );
  state.flowStepRecords.push({
    title: snapshot.title || `Série ${state.flowStepRecords.length + 1}`,
    stats,
    stages,
    series,
    totalDurationSec: totalDurationSec || durationFromStages,
    stagesCount: Number.isFinite(Number(snapshot.stagesCount))
      ? Number(snapshot.stagesCount)
      : stages.length,
    date: snapshot.date || "",
    athlete: snapshot.athlete || "",
    planId: snapshot.planId || null,
    planIdx: snapshot.planIdx ?? null,
    csv: typeof snapshot.csv === "string" ? snapshot.csv : "",
    completedAt: snapshot.completedAt || new Date().toISOString(),
    flowStepId: snapshot.flowStepId || null,
  });
}

function finalizeFlowSession() {
  const steps = Array.isArray(state.flowStepRecords) ? state.flowStepRecords.slice() : [];
  if (!steps.length) return;
  const plan = state.flowPlan;
  const aggregatedStagesRaw = [];
  const combinedSeries = [];
  const stepsForRecord = [];
  let timeOffset = 0;
  let stageCursor = 1;
  let totalDurationSec = 0;

  for (const step of steps) {
    const stageList = Array.isArray(step.stages) ? step.stages : [];
    for (const stage of stageList) {
      aggregatedStagesRaw.push({
        durationSec: Math.max(0, Number(stage?.durationSec) || 0),
        lower: Number(stage?.lower) || 0,
        upper: Number(stage?.upper) || 0,
      });
    }
    const stageDuration = stageList.reduce(
      (sum, st) => sum + (Number.isFinite(Number(st?.durationSec)) ? Number(st.durationSec) : 0),
      0,
    );
    const declaredDuration = Number.isFinite(Number(step.totalDurationSec))
      ? Number(step.totalDurationSec)
      : 0;
    const stepDurationSec = declaredDuration > 0 ? declaredDuration : stageDuration;
    const seriesList = Array.isArray(step.series) ? step.series : [];
    for (const point of seriesList) {
      const x = Number(point?.x) || 0;
      const y = typeof point?.y === "number" ? point.y : null;
      combinedSeries.push({ x: x + timeOffset, y });
    }
    const startStageIndex = stageCursor;
    const endStageIndex = stageCursor + Math.max(0, stageList.length) - 1;
    stepsForRecord.push({
      title: step.title || `Série ${stepsForRecord.length + 1}`,
      stats: step.stats ? { ...step.stats } : { avg: 0, min: 0, max: 0, inTargetPct: 0, samples: 0 },
      stageCount: stageList.length,
      totalDurationSec: stepDurationSec || stageDuration,
      stages: stageList.map((stage) => ({ ...stage })),
      flowStepId: step.flowStepId || null,
      startStageIndex: stageList.length ? startStageIndex : null,
      endStageIndex: stageList.length ? endStageIndex : null,
    });
    stageCursor += Math.max(0, stageList.length);
    totalDurationSec += stepDurationSec || stageDuration;
    timeOffset += stepDurationSec || stageDuration;
  }

  if (!totalDurationSec) {
    totalDurationSec = aggregatedStagesRaw.reduce(
      (sum, st) => sum + (Number.isFinite(Number(st.durationSec)) ? Number(st.durationSec) : 0),
      0,
    );
  }

  const sessionStages = aggregatedStagesRaw.map((stage, idx) => ({
    index: idx + 1,
    durationSec: stage.durationSec,
    lower: stage.lower,
    upper: stage.upper,
  }));

  const session = {
    date: steps[0]?.date || new Date().toLocaleDateString("pt-BR"),
    athlete: plan?.name || steps[0]?.athlete || "",
    stages: sessionStages,
    totalDurationSec: totalDurationSec,
  };
  if (!session.totalDurationSec) {
    session.totalDurationSec = sessionStages.reduce(
      (sum, st) => sum + (Number.isFinite(Number(st.durationSec)) ? Number(st.durationSec) : 0),
      0,
    );
  }

  const stats = computeSessionStats(session, combinedSeries);
  const csv = buildExportCsvFromState(session, combinedSeries);
  const title = plan
    ? `Plano fixo • ${plan.name || "Plano"}`
    : steps[0]?.title || `${session.date || "Sessão"} • ${sessionStages.length} estágios`;

  const completionIso =
    steps[steps.length - 1]?.completedAt || new Date().toISOString();

  const aggregatedRecord = {
    date: session.date,
    athlete: session.athlete,
    totalDurationSec: session.totalDurationSec,
    stagesCount: sessionStages.length,
    stats,
    isImported: false,
    csv,
    completedAt: completionIso,
    planId: plan?.id || steps[0]?.planId || null,
    planIdx: steps[0]?.planIdx ?? null,
    title,
    steps: stepsForRecord,
    stages: sessionStages.map((stage) => ({ ...stage })),
    isFlowAggregate: true,
  };

  saveCompletedSession(aggregatedRecord);
  try {
    window.dispatchEvent(new CustomEvent("sessions:updated"));
  } catch { }
  state.flowStepRecords = [];
  state.flowStats = [];
}

let viewFabInitialized = false;

function getViewSeriesFabElements() {
  return {
    toggle: document.getElementById('viewSeriesFabToggle'),
    menu: document.getElementById('viewSeriesFabMenu'),
  };
}

function initViewSeriesFabControls() {
  if (viewFabInitialized) return;
  const { toggle, menu } = getViewSeriesFabElements();
  if (!toggle || !menu) return;
  viewFabInitialized = true;
  toggle.addEventListener('click', (event) => {
    event.preventDefault();
    toggleViewSeriesFabMenu();
  });
  document.addEventListener('click', (event) => {
    const elements = getViewSeriesFabElements();
    if (!elements.toggle || !elements.menu) return;
    if (event.target === elements.toggle || elements.toggle.contains(event.target)) return;
    if (event.target === elements.menu || elements.menu.contains(event.target)) return;
    closeViewSeriesFabMenu();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeViewSeriesFabMenu();
  });
}

function openViewSeriesFabMenu() {
  const { toggle, menu } = getViewSeriesFabElements();
  if (!toggle || !menu) return;
  menu.classList.remove('hidden');
  toggle.setAttribute('aria-expanded', 'true');
}

function closeViewSeriesFabMenu() {
  const { toggle, menu } = getViewSeriesFabElements();
  if (!toggle || !menu) return;
  menu.classList.add('hidden');
  toggle.setAttribute('aria-expanded', 'false');
}

function toggleViewSeriesFabMenu() {
  const { menu } = getViewSeriesFabElements();
  if (!menu) return;
  if (menu.classList.contains('hidden')) openViewSeriesFabMenu();
  else closeViewSeriesFabMenu();
}

function renderViewSeriesFab() {
  const { toggle, menu } = getViewSeriesFabElements();
  if (!toggle || !menu) return;
  initViewSeriesFabControls();
  const groups = Array.isArray(state.viewSeriesGroups) ? state.viewSeriesGroups : [];
  const plotScreen = document.getElementById('plotScreen');
  if (groups.length === 0) {
    toggle.classList.add('hidden');
    closeViewSeriesFabMenu();
    menu.innerHTML = '';
    plotScreen?.classList.remove('has-view-fab');
    return;
  }
  plotScreen?.classList.add('has-view-fab');
  toggle.classList.remove('hidden');
  closeViewSeriesFabMenu();
  menu.innerHTML = '';

  // Add "Full Session" option
  const fullBtn = document.createElement('button');
  fullBtn.className = 'fab-item flex items-center justify-between gap-2';
  fullBtn.setAttribute('role', 'menuitem');
  fullBtn.dataset.groupIndex = 'full';
  const fullLabel = document.createElement('span');
  fullLabel.textContent = 'Sessão Completa';
  fullBtn.appendChild(fullLabel);
  if (state.viewSeriesActiveGroup === -1) fullBtn.classList.add('fab-item-active');
  fullBtn.addEventListener('click', () => {
    selectViewSeriesGroup('full');
  });
  menu.appendChild(fullBtn);

  groups.forEach((group, idx) => {
    const btn = document.createElement('button');
    btn.className = 'fab-item flex items-center justify-between gap-2';
    btn.setAttribute('role', 'menuitem');
    btn.dataset.groupIndex = String(idx);
    const labelSpan = document.createElement('span');
    labelSpan.textContent = group?.label || `Série ${idx + 1}`;
    btn.appendChild(labelSpan);
    const start = Number(group?.startStageIndex);
    const end = Number(group?.endStageIndex);
    if (Number.isFinite(start) && Number.isFinite(end)) {
      const meta = document.createElement('span');
      meta.className = 'text-xs text-slate-300';
      meta.textContent = start === end ? `E${start}` : `E${start}-E${end}`;
      btn.appendChild(meta);
    }
    if (idx === state.viewSeriesActiveGroup) btn.classList.add('fab-item-active');
    btn.addEventListener('click', () => {
      selectViewSeriesGroup(idx);
    });
    menu.appendChild(btn);
  });
}

function selectViewSeriesGroup(index) {
  const groups = Array.isArray(state.viewSeriesGroups) ? state.viewSeriesGroups : [];
  // "Full Session" option
  if (index === 'full') {
    state.viewSeriesActiveGroup = -1;
    closeViewSeriesFabMenu();
    renderViewSeriesFab();

    // Show full session in sessionHrChart
    try {
      const session = state.trainingSession;
      if (!session || !Array.isArray(session.stages) || !state.sessionChart) return;
      // Use all sessionSeries points
      const data = (state.sessionSeries || []).map(pt => [pt.x, pt.y]);
      state.sessionChart.setOption(
        { series: [{ data }] },
        false,
        true
      );
      state.sessionChart.setOption(
        {
          xAxis: { min: 0, max: session.totalDurationSec },
        },
        false,
        true
      );
      // Update highlight for full session
      if (typeof syncChartScales === "function") {
        syncChartScales();
      }
      // Update asides for full session
      const stats = computeSessionStats(session, state.sessionSeries);
      const set = (id, v) => {
        const el = document.getElementById(id);
        if (el) el.textContent = String(v);
      };
      set("statAvg", `${stats.avg.toFixed(1)} kgf`);
      set("statMax", `${stats.max.toFixed(1)} kgf`);
      set("statMin", `${stats.min.toFixed(1)} kgf`);
      set("statInTarget", `${stats.inTargetPct.toFixed(1)}%`);
    } catch (e) { }
    return;
  }

  if (!groups.length) return;
  const clamped = Math.max(0, Math.min(index, groups.length - 1));
  state.viewSeriesActiveGroup = clamped;
  const group = groups[clamped];
  const start = Number(group?.startStageIndex);
  closeViewSeriesFabMenu();
  if (Number.isFinite(start)) focusSessionStage(start - 1);
  else focusSessionStage(0);
  renderViewSeriesFab();

  // --- Filter sessionSeries for the selected group and update sessionHrChart ---
  try {
    const session = state.trainingSession;
    if (!session || !Array.isArray(session.stages) || !state.sessionChart) return;
    const stages = session.stages;
    const groupStart = Number(group?.startStageIndex) - 1;
    const groupEnd = Number(group?.endStageIndex) - 1;
    if (!Number.isFinite(groupStart) || !Number.isFinite(groupEnd)) return;
    // Compute time range for the group
    let startTime = 0;
    for (let i = 0; i < groupStart; i++) startTime += stages[i].durationSec;
    let endTime = startTime;
    for (let i = groupStart; i <= groupEnd; i++) endTime += stages[i].durationSec;
    // Filter sessionSeries for this time range
    const filtered = (state.sessionSeries || []).filter(
      (p) => typeof p?.x === "number" && p.x >= startTime && p.x <= endTime
    );
    // Update sessionHrChart with filtered data
    state.sessionChart.setOption(
      { series: [{ data: filtered.map(pt => [pt.x - startTime, pt.y]) }] },
      false,
      true
    );
    // Optionally, update axes
    state.sessionChart.setOption(
      {
        xAxis: { min: 0, max: endTime - startTime },
      },
      false,
      true
    );
    // Update highlight for group
    if (typeof syncChartScales === "function") {
      syncChartScales(groupStart, groupEnd, 0, endTime - startTime);
    }

    // --- Update asides (summary/statistics panels) for the selected group ---
    // Compute stats for the selected group
    const groupStages = stages.slice(groupStart, groupEnd + 1);
    // Create a temporary session object for the group
    const groupSession = {
      ...session,
      stages: groupStages,
      totalDurationSec: groupStages.reduce((a, s) => a + s.durationSec, 0),
    };
    // Compute stats for the filtered data
    const stats = computeSessionStats(groupSession, filtered);
    // Update aside DOM elements (statAvg, statMax, statMin, statInTarget)
    const set = (id, v) => {
      const el = document.getElementById(id);
      if (el) el.textContent = String(v);
    };
    set("statAvg", `${stats.avg.toFixed(1)} kgf`);
    set("statMax", `${stats.max.toFixed(1)} kgf`);
    set("statMin", `${stats.min.toFixed(1)} kgf`);
    set("statInTarget", `${stats.inTargetPct.toFixed(1)}%`);
  } catch (e) {
    // fail silently
  }
}

function focusSessionStage(index) {
  const session = state.trainingSession;
  if (!session || !Array.isArray(session.stages) || !session.stages.length) return;
  const stages = session.stages;
  let target = Number.isFinite(Number(index)) ? Number(index) : 0;
  if (target < 0) target = 0;
  if (target >= stages.length) target = stages.length - 1;
  state.stageIdx = target;
  const stage = stages[target];
  const labelEl = document.getElementById('stageLabel');
  if (labelEl)
    labelEl.textContent = `E${stage?.index || target + 1}/${stages.length} • ${fmtMMSS(
      Number(stage?.durationSec) || 0,
    )}`;
  const rangeEl = document.getElementById('stageRange');
  if (rangeEl)
    rangeEl.textContent = `${stage?.lower ?? '—'}/${stage?.upper ?? '—'}`;
  const elapsedEl = document.getElementById('stageElapsed');
  if (elapsedEl) elapsedEl.textContent = fmtMMSS(Number(stage?.durationSec) || 0);
  const totalEl = document.getElementById('totalRemaining');
  if (totalEl)
    totalEl.textContent = fmtMMSS(Number(session?.totalDurationSec) || 0);
  const pctEls = [
    document.getElementById('stageInTargetPct'),
    document.getElementById('stageInTargetPctMobile'),
  ].filter(Boolean);
  for (const el of pctEls) el.textContent = '—';
  try {
    plotStageSliceByIndex(target);
  } catch { }
}

function hydrateViewSeriesGroups(session, stepsMeta) {
  if (!session || !Array.isArray(session.stages)) {
    state.viewSeriesGroups = [];
    state.viewSeriesActiveGroup = -1;
    renderViewSeriesFab();
    return;
  }
  const groups = [];
  if (Array.isArray(stepsMeta) && stepsMeta.length) {
    let cursor = 1;
    stepsMeta.forEach((step, idx) => {
      const declaredCount = Number(step?.stageCount);
      const stageList = Array.isArray(step?.stages) ? step.stages : [];
      const count = Number.isFinite(declaredCount) && declaredCount > 0 ? declaredCount : stageList.length;
      const start = cursor;
      const end = count > 0 ? cursor + count - 1 : cursor;
      groups.push({
        label: step?.title || `Série ${idx + 1}`,
        startStageIndex: start,
        endStageIndex: Math.max(start, end),
      });
      cursor = Math.max(end + 1, cursor + 1);
    });
  }
  state.viewSeriesGroups = groups;
  state.viewSeriesActiveGroup = groups.length ? 0 : -1;
  renderViewSeriesFab();
}

function formatNumber(n, digits = 1) {
  if (typeof n !== "number" || !isFinite(n)) return "";
  return n.toFixed(digits);
}

function computePerStageStats(
  session = state.trainingSession,
  points = state.sessionSeries,
) {
  if (!session || !Array.isArray(session.stages)) return [];
  const stages = session.stages || [];
  const offsets = [];
  let acc = 0;
  for (const s of stages) {
    offsets.push({
      start: acc,
      end: acc + s.durationSec,
      lo: s.lower,
      hi: s.upper,
    });
    acc += s.durationSec;
  }

  const per = stages.map((s) => ({
    durationSec: s.durationSec,
    lower: s.lower,
    upper: s.upper,
    sum: 0,
    min: Infinity,
    max: -Infinity,
    count: 0,
    inTarget: 0,
  }));
  const pts = Array.isArray(points) ? points : [];
  for (const p of pts) {
    if (!p || typeof p.y !== "number") continue;
    const x = p.x;
    let idx = offsets.findIndex((r) => x >= r.start && x <= r.end);
    if (idx === -1) idx = stages.length - 1;
    const st = per[idx];
    const force = p.y;
    st.sum += force;
    st.count += 1;
    if (force < st.min) st.min = force;
    if (force > st.max) st.max = force;
    const lo = stages[idx].lower,
      hi = stages[idx].upper;
    if (force >= lo && force <= hi) st.inTarget += 1;
  }
  return per.map((s, i) => ({
    index: i + 1,
    durationSec: stages[i].durationSec,
    lower: stages[i].lower,
    upper: stages[i].upper,
    avg: s.count ? Number((s.sum / s.count).toFixed(1)) : 0,
    min: isFinite(s.min) ? Number(s.min.toFixed(1)) : 0,
    max: isFinite(s.max) ? Number(s.max.toFixed(1)) : 0,
    inTargetPct: s.count ? Number(((s.inTarget / s.count) * 100).toFixed(1)) : 0,
    samples: s.count,
  }));
}

export function exportSessionCsv() {
  const csv = buildExportCsvFromState();
  if (!csv) return;
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const dateSlug = String(state.trainingSession?.date || "").replace(
    /[\s:\/]/g,
    "_",
  );
  const clientSlug = String(state.trainingSession?.athlete || "session").replace(
    /[\s:\/]/g,
    "_",
  );
  a.href = url;
  a.download = `isotrainer_${clientSlug}_${dateSlug}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function buildExportCsvFromState(
  session = state.trainingSession,
  points = state.sessionSeries,
) {
  if (!session || !Array.isArray(session.stages)) return;
  const stats = computeSessionStats(session, points);
  const perStages = computePerStageStats(session, points);

  // Enhanced header with units in column names
  const header = [
    "type",
    "date",
    "client",
    "stage",
    "duration_sec",
    "lower_kgf",
    "upper_kgf",
    "avg_kgf",
    "min_kgf",
    "max_kgf",
    "in_target_pct",
    "samples",
    "elapsed_sec",
    "stage_elapsed_sec",
    "force_kgf",
    "in_target",
  ];
  const rows = [];
  
  // Summary row
  rows.push([
    "summary",
    session.date || "",
    session.athlete || "",
    "",
    session.totalDurationSec || "",
    "",
    "",
    formatNumber(stats.avg),
    formatNumber(stats.min),
    formatNumber(stats.max),
    formatNumber(stats.inTargetPct),
    stats.samples || "",
    "",
    "",
    "",
    "",
  ]);
  
  // Per-stage rows
  for (const s of perStages) {
    rows.push([
      "stage",
      session.date || "",
      session.athlete || "",
      s.index,
      s.durationSec,
      formatNumber(s.lower),
      formatNumber(s.upper),
      formatNumber(s.avg),
      formatNumber(s.min),
      formatNumber(s.max),
      formatNumber(s.inTargetPct),
      s.samples,
      "",
      "",
      "",
      "",
    ]);
  }
  
  // Time series rows
  const offsets = [];
  let acc = 0;
  for (const s of session.stages) {
    offsets.push({
      start: acc,
      end: acc + s.durationSec,
      lo: s.lower,
      hi: s.upper,
    });
    acc += s.durationSec;
  }
  const seriesPoints = Array.isArray(points) ? points : [];
  for (const p of seriesPoints) {
    const t = typeof p.x === "number" ? p.x : 0;
    const force = typeof p.y === "number" ? p.y : "";
    let idx = offsets.findIndex((r) => t >= r.start && t <= r.end);
    if (idx === -1) idx = session.stages.length - 1;
    const stage = session.stages[idx];
    const stageElapsed = Math.max(0, t - offsets[idx].start);
    const inTarget =
      typeof force === "number"
        ? force >= stage.lower && force <= stage.upper
          ? 1
          : 0
        : "";
    rows.push([
      "series",
      session.date || "",
      session.athlete || "",
      idx + 1,
      stage.durationSec,
      formatNumber(stage.lower),
      formatNumber(stage.upper),
      "",
      "",
      "",
      "",
      "",
      formatNumber(t, 2),
      formatNumber(stageElapsed, 2),
      typeof force === "number" ? formatNumber(force) : "",
      inTarget,
    ]);
  }

  return [header.join(";"), ...rows.map((r) => r.join(";"))].join("\n");
}

// Load a previously exported session CSV and render it as a finished session
export function loadCompletedSessionFromExportCsv(text, stepsMeta = null) {
  if (!text || !text.trim()) throw new Error("O CSV está vazio.");
  const lines = text
    .trim()
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) throw new Error("CSV inválido.");
  const header = lines[0].split(";").map((s) => s.trim());
  const colIdx = (name) => {
    const i = header.indexOf(name);
    if (i === -1) throw new Error(`Coluna ausente no CSV: ${name}`);
    return i;
  };
  const colIdxAny = (...names) => {
    for (const name of names) {
      const idx = header.indexOf(name);
      if (idx !== -1) return idx;
    }
    throw new Error(`Coluna ausente no CSV: ${names.join(" | ")}`);
  };
  // Detect exported format (support both old and new column names)
  const hasType = header.includes("type");
  if (!hasType)
    throw new Error(
      "Formato não suportado. Importe um CSV exportado do IsoTrainer.",
    );

  const TYPE = colIdx("type");
  const DATE = colIdx("date");
  const ATHLETE = colIdxAny("client", "athlete");
  const STAGE_INDEX = colIdxAny("stage", "stage_index");
  const DURATION = colIdxAny("duration_sec");
  const LOWER = colIdxAny("lower_kgf", "lower");
  const UPPER = colIdxAny("upper_kgf", "upper");
  const ELAPSED = colIdxAny("elapsed_sec");
  const FORCE = colIdxAny("force_kgf", "force");

  // Detect if this is a full export (multiple sessions concatenated under a single header)
  let summaryCount = 0;
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(";");
    const typeVal = (parts[TYPE] || "").trim();
    if (typeVal === "summary") summaryCount += 1;
  }
  if (summaryCount > 1) {
    try {
      const imported = importAllCompletedSessionsFromCsv(text);
      try {
        window.dispatchEvent(new CustomEvent("sessions:updated"));
      } catch { }
      alert(
        `Exportação completa detectada. ${imported} sessão(ões) importadas.`,
      );
      // Stay on Home screen; do not navigate to Plot
      return;
    } catch (err) {
      throw err;
    }
  }

  let date = "";
  let athlete = "";
  let totalDurationSec = 0;
  const stages = [];
  const series = [];

  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(";");
    if (!parts.length) continue;
    const t = (parts[TYPE] || "").trim();
    if (t === "summary") {
      date = (parts[DATE] || "").trim();
      athlete = (parts[ATHLETE] || "").trim();
      totalDurationSec = Math.max(0, Number(parts[DURATION] || 0) || 0);
    } else if (t === "stage") {
      const idx = Number(parts[STAGE_INDEX] || 0);
      const dur = Math.max(0, Number(parts[DURATION] || 0) || 0);
      const lo = Number(parts[LOWER] || NaN);
      const hi = Number(parts[UPPER] || NaN);
      stages.push({ index: idx, durationSec: dur, lower: lo, upper: hi });
    } else if (t === "series") {
      const x = Number(parts[ELAPSED] || 0);
      const y = Number(parts[FORCE] || NaN);
      if (isFinite(x) && isFinite(y)) series.push({ x, y });
    }
  }

  if (!stages.length) throw new Error("Nenhum estágio encontrado no CSV.");
  if (!series.length)
    throw new Error("Nenhuma série de força encontrada no CSV.");
  if (!totalDurationSec) {
    totalDurationSec = stages.reduce((a, s) => a + s.durationSec, 0);
  }

  // Prepare session state without starting timers
  stopTraining();
  const session = { date, athlete, stages, totalDurationSec };
  ensureSessionUsesKgf(session);
  convertSeriesToKgfIfNeeded(series);
  state.trainingSession = session;
  state.stageIdx = 0;
  state.waitingForFirstSample = false;
  state.isImportedSession = true;
  // Viewing mode: set smoothing based on setting and update both charts
  if (typeof window !== "undefined") {
    if (typeof trendSmoothingEnabled !== "undefined") {
      trendSmoothingEnabled = state.viewingModeSmoothingEnabled;
    }
    if (typeof applyTrendSmoothingSetting === "function") {
      applyTrendSmoothingSetting(state.viewingModeSmoothingEnabled);
    }
  }
  state.sessionStartMs = null;
  state.stageStartMs = null;
  state.paused = true;
  state.accumulatedPauseOffset = 0;
  state.stageAccumulatedPauseOffset = 0;

  // UI priming
  document.getElementById("sessionAthlete").textContent =
    session.athlete || "—";
  document.getElementById("sessionMeta").textContent = `${session.date || "—"}`;

  // Series + chart scales
  resetStageSeries();
  resetSessionSeries();
  state.sessionSeries.push(...series.sort((a, b) => a.x - b.x));

  const allLows = session.stages.map((s) => s.lower);
  const allHighs = session.stages.map((s) => s.upper);
  const minHr = Math.min(...allLows);
  const maxHr = Math.max(...allHighs);
  const buffer = 2;
  state.trainingSession.sessionBounds = {
    min: minHr - buffer,
    max: maxHr + buffer,
  };
  syncChartScales();
  try {
    // Push series to chart now
    refreshSessionSeries();
  } catch { }

  hydrateViewSeriesGroups(session, stepsMeta);
  const groups = Array.isArray(state.viewSeriesGroups)
    ? state.viewSeriesGroups
    : [];
  const initialStage = groups.length
    ? Math.max(0, Number(groups[0]?.startStageIndex || 1) - 1)
    : 0;
  focusSessionStage(initialStage);

  // --- Filter sessionSeries for the initial group and update sessionHrChart ---
  try {
    if (groups.length && state.sessionChart) {
      const group = groups[0];
      const stages = session.stages;
      const groupStart = Number(group?.startStageIndex) - 1;
      const groupEnd = Number(group?.endStageIndex) - 1;
      if (Number.isFinite(groupStart) && Number.isFinite(groupEnd)) {
        let startTime = 0;
        for (let i = 0; i < groupStart; i++) startTime += stages[i].durationSec;
        let endTime = startTime;
        for (let i = groupStart; i <= groupEnd; i++) endTime += stages[i].durationSec;
        const filtered = (state.sessionSeries || []).filter(
          (p) => typeof p?.x === "number" && p.x >= startTime && p.x <= endTime
        );
        state.sessionChart.setOption(
          { series: [{ data: filtered.map(pt => [pt.x - startTime, pt.y]) }] },
          false,
          true
        );
        state.sessionChart.setOption(
          {
            xAxis: { min: 0, max: endTime - startTime },
          },
          false,
          true
        );
      }
    }
  } catch (e) {
    // fail silently
  }

  // Navigate to plot and show completion stats
  showScreen("plot");
  setTimeout(() => {
    try {
      state.chart?.resize();
      state.sessionChart?.resize();
    } catch { }
  }, 10);
  const stats = computeSessionStats();
  showCompletion(stats);

  // Explicitly hide FAB in view mode
  try {
    const fabToggle = document.getElementById("fabToggle");
    const fabMenu = document.getElementById("fabMenu");
    if (fabToggle) fabToggle.classList.add("hidden");
    if (fabMenu) fabMenu.classList.add("hidden");
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
      csv: String(text || ""),
      completedAt: new Date().toISOString(),
      planId: null,
      planIdx: null,
      title: `Importado • ${date || "Sessão"} • ${stages.length} estágios`,
    };
    saveCompletedSession(record);
    try {
      window.dispatchEvent(new CustomEvent("sessions:updated"));
    } catch { }
  } catch { }
}

// Import multiple completed sessions from a combined export CSV (single header, many sessions)
function importAllCompletedSessionsFromCsv(text) {
  const raw = String(text || "").trim();
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) throw new Error("CSV inválido.");
  const header = lines[0].split(";").map((s) => s.trim());
  const colIdx = (name) => {
    const i = header.indexOf(name);
    if (i === -1) throw new Error(`Coluna ausente no CSV: ${name}`);
    return i;
  };
  const colIdxAny = (...names) => {
    for (const name of names) {
      const idx = header.indexOf(name);
      if (idx !== -1) return idx;
    }
    throw new Error(`Coluna ausente no CSV: ${names.join(" | ")}`);
  };
  const TYPE = colIdx("type");
  const DATE = colIdx("date");
  const ATHLETE = colIdxAny("client", "athlete");
  const STAGE_INDEX = colIdxAny("stage", "stage_index");
  const DURATION = colIdxAny("duration_sec");
  const LOWER = colIdxAny("lower_kgf", "lower");
  const UPPER = colIdxAny("upper_kgf", "upper");
  const ELAPSED = colIdxAny("elapsed_sec");
  const FORCE = colIdxAny("force_kgf", "force");

  // Group lines by session, delimited by 'summary'
  const sessions = [];
  let current = null;
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(";");
    const t = (parts[TYPE] || "").trim();
    if (t === "summary") {
      // start a new session
      if (current) sessions.push(current);
      current = {
        date: (parts[DATE] || "").trim(),
        athlete: (parts[ATHLETE] || "").trim(),
        totalDurationSec: Math.max(0, Number(parts[DURATION] || 0) || 0),
        stages: [],
        series: [],
        csvLines: [lines[0], lines[i]], // include header and this summary line
      };
      continue;
    }
    if (!current) continue; // ignore preface lines, if any
    if (t === "stage") {
      const idx = Number(parts[STAGE_INDEX] || 0);
      const dur = Math.max(0, Number(parts[DURATION] || 0) || 0);
      const lo = Number(parts[LOWER] || NaN);
      const hi = Number(parts[UPPER] || NaN);
      current.stages.push({
        index: idx,
        durationSec: dur,
        lower: lo,
        upper: hi,
      });
      current.csvLines.push(lines[i]);
    } else if (t === "series") {
      const x = Number(parts[ELAPSED] || 0);
      const y = Number(parts[FORCE] || NaN);
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
    ensureSessionUsesKgf(s);
    convertSeriesToKgfIfNeeded(s.series);
    if (!s.totalDurationSec) {
      s.totalDurationSec = s.stages.reduce(
        (a, st) => a + Math.max(0, Number(st.durationSec) || 0),
        0,
      );
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
      csv: s.csvLines.join("\n"),
      completedAt: new Date().toISOString(),
      planId: null,
      planIdx: null,
      title: `Importado • ${s.date || "Sessão"} • ${s.stages.length} estágios`,
    };
    try {
      saveCompletedSession(record);
      imported += 1;
    } catch { }
  }
  return imported;
}

function computeStatsForSeries(series, stages) {
  const points = Array.isArray(series) ? series : [];
  if (!points.length || !stages?.length) {
    return { avg: 0, min: 0, max: 0, inTargetPct: 0 };
  }
  let sum = 0,
    count = 0,
    min = Infinity,
    max = -Infinity,
    inTarget = 0;
  const offsets = [];
  let acc = 0;
  for (const st of stages) {
    offsets.push({
      start: acc,
      end: acc + st.durationSec,
      lo: st.lower,
      hi: st.upper,
    });
    acc += st.durationSec;
  }
  for (const p of points) {
    if (!p || typeof p.y !== "number") continue;
    const force = p.y;
    sum += force;
    count += 1;
    if (force < min) min = force;
    if (force > max) max = force;
    const x = typeof p.x === "number" ? p.x : 0;
    const idx = Math.max(
      0,
      offsets.findIndex((r) => x >= r.start && x <= r.end),
    );
    const st = offsets[idx] || offsets[offsets.length - 1];
    if (st && force >= st.lo && force <= st.hi) inTarget += 1;
  }
  return {
    avg: count ? Math.round(sum / count) : 0,
    min: isFinite(min) ? min : 0,
    max: isFinite(max) ? max : 0,
    inTargetPct: count ? Math.round((inTarget / count) * 100) : 0,
  };
}

// ============= Fixed Plan Guided Flow ============= //

function getArmShortLabel(arm) {
  if (arm === 'direito') return 'Braço Direito';
  if (arm === 'esquerdo') return 'Braço Esquerdo';
  return 'Braço';
}

function getActiveRestSlots() {
  const raw = Array.isArray(state.restPositions) ? state.restPositions : [];
  const set = new Set();
  raw.forEach((value) => {
    const slot = Number(value);
    if (Number.isFinite(slot)) set.add(Math.trunc(slot));
  });
  return set;
}

function flowHasNextStep() {
  if (!state.flowActive) return false;
  const seq = Array.isArray(state.flowSequence) ? state.flowSequence : [];
  return state.currentStepIndex < seq.length - 1;
}

function hasArmMax(arm) {
  if (arm === 'direito')
    return Number.isFinite(state.maxDireitoN) && state.maxDireitoN > 0;
  if (arm === 'esquerdo')
    return Number.isFinite(state.maxEsquerdoN) && state.maxEsquerdoN > 0;
  return false;
}

function ensureFlowSequence() {
  const order = sanitizeFlowStepOrder(state.flowStepOrder);
  const mapped = order
    .map((id) => FLOW_TRAINING_STEPS.find((step) => step.id === id))
    .filter(Boolean);
  if (mapped.length) return mapped;
  return FLOW_TRAINING_STEPS.slice();
}

export function prepareFixedPlanFlow(planId) {
  const plan = getFixedPlanById(planId);
  if (!plan) {
    alert('Plano fixo não encontrado.');
    return;
  }
  if (!DEV_BYPASS_CONNECT && !(state.device?.gatt?.connected)) {
    alert('Conecte um dinamômetro TeraForce para iniciar o plano.');
    return;
  }
  stopMeasurement();
  stopRestTimer();
  state.flowPlan = plan;
  state.flowActive = true;
  state.flowSequence = ensureFlowSequence();
  state.currentStepIndex = 0;
  state.flowStats = [];
  state.flowStepRecords = [];
  state.viewSeriesGroups = [];
  state.viewSeriesActiveGroup = 0;
  state.pendingTrainingStep = null;
  state.flowArm = null;
  showScreen('plot');
  startFlowStep();
}

function startFlowStep() {
  if (!state.flowActive) return;
  const seq = Array.isArray(state.flowSequence) ? state.flowSequence : [];
  const step = seq[state.currentStepIndex];
  if (!step) {
    finishFlow();
    return;
  }
  state.pendingTrainingStep = step;
  state.flowArm = step.arm;
  if (step.captureMax || !hasArmMax(step.arm)) {
    beginMeasurement(step);
  } else {
    beginFlowTraining(step);
  }
}

function beginMeasurement(step) {
  const modal = document.getElementById('armMaxModal');
  if (!modal) {
    beginFlowTraining(step);
    return;
  }
  stopMeasurement();
  const { arm } = step;
  const measurement = state.measurement;
  measurement.active = true;
  measurement.started = false;
  measurement.complete = false;
  measurement.arm = arm;
  measurement.startMs = null;
  measurement.durationMs = FLOW_MEASUREMENT_MS;
  measurement.peakN = 0;
  measurement.currentN = 0;
  measurement.forceElapsedMs = 0;
  measurement.lastFrameMs = 0;
  const title = document.getElementById('armMaxTitle');
  const subtitle = document.getElementById('armMaxSubtitle');
  const currentEl = document.getElementById('armMaxCurrent');
  const peakEl = document.getElementById('armMaxPeak');
  const progressEl = document.getElementById('armMaxProgress');
  const countdownEl = document.getElementById('armMaxCountdown');
  const proceedBtn = document.getElementById('armMaxProceedBtn');
  if (title) title.textContent = `Medição de força máxima (${getArmShortLabel(arm)})`;
  if (subtitle)
    subtitle.textContent = 'Mantenha o braço estável e aplique força máxima por 3 segundos.';
  if (currentEl) currentEl.textContent = '0,0 kgf';
  if (peakEl) peakEl.textContent = '0,0 kgf';
  if (progressEl) progressEl.style.width = '0%';
  if (countdownEl) countdownEl.textContent = 'Aguardando força acima de 0,5 kgf...';
  if (proceedBtn) proceedBtn.disabled = true;
  modal.classList.remove('hidden');
}

function updateMeasurementProgress(timestamp) {
  const measurement = state.measurement;
  if (!measurement?.active || !measurement.started || measurement.startMs == null) return;
  const elapsed = timestamp - measurement.startMs;
  measurement.forceElapsedMs = elapsed;
  measurement.lastFrameMs = timestamp;
  const remainingMs = Math.max(0, measurement.durationMs - elapsed);
  const progress = clamp((elapsed / measurement.durationMs) * 100, 0, 100);
  const progressEl = document.getElementById('armMaxProgress');
  if (progressEl) progressEl.style.width = `${progress.toFixed(1)}%`;
  const countdownEl = document.getElementById('armMaxCountdown');
  if (countdownEl) {
    const seconds = remainingMs / 1000;
    const label = seconds <= 0 ? 'Tempo concluído' : `${seconds.toFixed(1).replace('.', ',')}s restantes`;
    countdownEl.textContent = label;
  }
  if (remainingMs <= 0 && !measurement.complete) finalizeMeasurement();
  if (!measurement.complete) {
    measurement.rafHandle = requestAnimationFrame(updateMeasurementProgress);
  }
}

let measurementAutoForwardTimer = null;

function getOrCreateArmMaxCountdownSide() {
  let side = document.getElementById('armMaxCountdownSide');
  const proceedBtn = document.getElementById('armMaxProceedBtn');
  if (!side && proceedBtn) {
    side = document.createElement('span');
    side.id = 'armMaxCountdownSide';
    side.className = 'ml-2 text-xs text-slate-300';
    proceedBtn.appendChild(side);
  }
  return side;
}

function finalizeMeasurement() {
  const measurement = state.measurement;
  if (!measurement) return;
  measurement.complete = true;
  const countdownEl = document.getElementById('armMaxCountdown');
  const proceedBtn = document.getElementById('armMaxProceedBtn');
  const sideCountdown = getOrCreateArmMaxCountdownSide();
  // Make the progress bar green
  const progressEl = document.getElementById('armMaxProgress');
  if (progressEl) {
    progressEl.style.background = 'rgb(0 171 76)'; // olive green
  }
  if (state.autoForwardMeasurement) {
    if (proceedBtn) proceedBtn.disabled = true;
    let ms = 3000;
    if (countdownEl) {
      countdownEl.textContent = 'Avançando em 3,0s...';
      countdownEl.classList.remove('hidden');
    }
    if (sideCountdown) {
      sideCountdown.textContent = '3,0s';
      sideCountdown.style.display = '';
    }
    if (measurementAutoForwardTimer) clearInterval(measurementAutoForwardTimer);
    measurementAutoForwardTimer = setInterval(() => {
      ms -= 100;
      const txt = `${(ms / 1000).toFixed(1).replace('.', ',')}s`;
      if (countdownEl) {
        countdownEl.textContent = `Avançando em ${txt}...`;
      }
      if (sideCountdown) {
        sideCountdown.textContent = txt;
        sideCountdown.style.display = '';
      }
      if (ms <= 0) {
        clearInterval(measurementAutoForwardTimer);
        measurementAutoForwardTimer = null;
        if (proceedBtn) proceedBtn.disabled = false;
        if (sideCountdown) sideCountdown.textContent = '';
        // Auto-proceed
        handleMeasurementProceed();
      }
    }, 100);
  } else {
    if (countdownEl) countdownEl.textContent = 'Pronto para prosseguir';
    if (proceedBtn) proceedBtn.disabled = false;
    if (sideCountdown) sideCountdown.textContent = '';
  }
}

export function processMeasurementSample(force) {
  const measurement = state.measurement;
  if (!measurement?.active) return;
  const absolute = Math.abs(force);
  if (!measurement.started && absolute >= MEASUREMENT_START_THRESHOLD_KGF) {
    measurement.started = true;
    measurement.startMs = performance.now();
    measurement.forceElapsedMs = 0;
    measurement.lastFrameMs = measurement.startMs;
    const countdownEl = document.getElementById('armMaxCountdown');
    if (countdownEl) countdownEl.textContent = '3,0s restantes';
    const progressEl = document.getElementById('armMaxProgress');
    if (progressEl) {
      progressEl.style.width = '0%';
      progressEl.style.background = ''; // reset to default (amber)
    }
    measurement.rafHandle = requestAnimationFrame(updateMeasurementProgress);
  }
  measurement.currentN = absolute;
  if (absolute > measurement.peakN) measurement.peakN = absolute;
  const currentEl = document.getElementById('armMaxCurrent');
  const peakEl = document.getElementById('armMaxPeak');
  const currentKgf = absolute;
  const peakKgf = measurement.peakN;
  if (currentEl) currentEl.textContent = `${currentKgf.toFixed(1).replace('.', ',')} kgf`;
  if (peakEl) peakEl.textContent = `${peakKgf.toFixed(1).replace('.', ',')} kgf`;
}

function handleMeasurementCancel() {
  cancelFlow();
}

function handleMeasurementProceed() {
  const measurement = state.measurement;
  if (!measurement?.complete) return;
  const peakN = measurement.peakN;
  if (!Number.isFinite(peakN) || peakN <= 0) {
    alert('Não foi possível capturar a força máxima. Tente novamente.');
    return;
  }
  if (measurement.arm === 'direito') {
    state.maxDireitoKgf = Number(peakN.toFixed(2));
    state.maxDireitoN = Math.round(peakN * N_PER_KGF);
  } else if (measurement.arm === 'esquerdo') {
    state.maxEsquerdoKgf = Number(peakN.toFixed(2));
    state.maxEsquerdoN = Math.round(peakN * N_PER_KGF);
  }
  stopMeasurement();
  const modal = document.getElementById('armMaxModal');
  modal?.classList.add('hidden');
  const step = state.pendingTrainingStep;
  if (step) {
    beginFlowTraining(step);
  } else {
    finishFlow();
  }
}

function beginFlowTraining(step) {
  const session = buildFlowSession(step);
  if (!session) {
    alert('Não foi possível montar a sessão. Verifique as medições de força.');
    finishFlow();
    return;
  }
  state.editOrigin = 'fixedPlan';
  state.startReturnScreen = 'home';
  startTraining(session);
}

function buildFlowSession(step) {
  const plan = state.flowPlan;
  if (!plan) return null;
  const stages = Array.isArray(plan.stages) ? plan.stages : [];
  const maxForceKgf = step.arm === 'direito' ? state.maxDireitoKgf : state.maxEsquerdoKgf;
  if (!Number.isFinite(maxForceKgf) || maxForceKgf <= 0) return null;
  const mappedStages = stages.map((stage, index) => {
    const lower = Math.round(
      Math.max(0, maxForceKgf * (Number(stage.lowerPct) || 0)),
    );
    const upper = Math.round(
      Math.max(lower + 1, maxForceKgf * (Number(stage.upperPct) || 0)),
    );
    return {
      index: index + 1,
      durationSec: Math.max(0, Number(stage.durationSec) || 0),
      lower,
      upper,
    };
  });
  const totalDurationSec = mappedStages.reduce((acc, st) => acc + st.durationSec, 0);
  const sessionDate = new Date().toLocaleDateString('pt-BR');
  const athleteLabel = `${plan.name || 'Plano fixo'}${step.suffix || ''}`;
  return {
    id: `flow_${plan.id || 'plan'}_${step.id}_${Date.now()}`,
    date: sessionDate,
    athlete: athleteLabel,
    stages: mappedStages,
    totalDurationSec,
    planId: plan.id || null,
    planIdx: step.id || null,
    flowStepId: step.id || null,
    flowArm: step.arm,
    forceUnit: 'kgf',
  };
}

function handleFlowStepCompletion(stats) {
  const sequence = Array.isArray(state.flowSequence) ? state.flowSequence : [];
  const step = sequence[state.currentStepIndex];
  if (step) {
    try {
      state.flowStats.push({ stepId: step.id, stats });
    } catch { }
  }
  stopTraining();
  state.pendingTrainingStep = null;
  const completedIndex = state.currentStepIndex;
  state.currentStepIndex += 1;
  if (state.currentStepIndex >= sequence.length) {
    finalizeFlowSession();
    finishFlow();
    return;
  }
  if (shouldRestAfterStep(completedIndex)) {
    startRestPeriod();
  } else {
    startFlowStep();
  }
}

function shouldRestAfterStep(index) {
  const slots = getActiveRestSlots();
  const slotId = index + 1;
  const maxSlot = Math.max(0, (state.flowSequence?.length || 0) - 1);
  if (slotId > maxSlot) return false;
  return slots.has(slotId);
}

function startRestPeriod() {
  const overlay = document.getElementById('restOverlay');
  const countdownEl = document.getElementById('restCountdown');
  const infoEl = document.getElementById('restNextInfo');
  const skipBtn = document.getElementById('restSkipBtn');
  const nextStep = state.flowSequence?.[state.currentStepIndex];
  const restSeconds = clamp(Number(state.restIntervalSec) || 0, 10, 600);
  if (!restSeconds || !nextStep) {
    startFlowStep();
    return;
  }
  if (skipBtn) {
    skipBtn.classList.toggle('hidden', !state.restSkipEnabled);
    skipBtn.disabled = !state.restSkipEnabled;
  }
  if (infoEl)
    infoEl.textContent = `Próximo: ${nextStep.label || getArmShortLabel(nextStep.arm)}`;
  if (countdownEl) countdownEl.textContent = fmtMMSS(restSeconds);
  overlay?.classList.remove('hidden');
  stopRestTimer();
  const endMs = now() + restSeconds * 1000;
  state.restTimer.active = true;
  state.restTimer.endMs = endMs;
  state.restTimer.stepId = nextStep.id || null;
  state.restTimer.handle = setInterval(updateRestCountdown, 250);
  updateRestCountdown();
}

function updateRestCountdown() {
  if (!state.restTimer?.active) return;
  const countdownEl = document.getElementById('restCountdown');
  const remainingMs = Math.max(0, state.restTimer.endMs - now());
  const seconds = Math.ceil(remainingMs / 1000);
  if (countdownEl) countdownEl.textContent = fmtMMSS(seconds);
  if (remainingMs <= 0) finishRestPeriod(false);
}

function finishRestPeriod(skipped) {
  stopRestTimer();
  const overlay = document.getElementById('restOverlay');
  overlay?.classList.add('hidden');
  if (skipped) state.restTimer.stepId = null;
  startFlowStep();
}

function stopRestTimer() {
  if (state.restTimer?.handle) {
    clearInterval(state.restTimer.handle);
  }
  state.restTimer.handle = null;
  state.restTimer.active = false;
}

function stopMeasurement() {
  const measurement = state.measurement;
  if (!measurement) return;
  measurement.active = false;
  measurement.started = false;
  measurement.complete = false;
  measurement.arm = null;
  measurement.startMs = null;
  measurement.forceElapsedMs = 0;
  measurement.lastFrameMs = 0;
  measurement.currentN = 0;
  measurement.peakN = 0;
  if (measurement.timerHandle) {
    clearInterval(measurement.timerHandle);
    measurement.timerHandle = null;
  }
  if (measurement.rafHandle) {
    cancelAnimationFrame(measurement.rafHandle);
    measurement.rafHandle = null;
  }
}

function finishFlow() {
  stopMeasurement();
  stopRestTimer();
  state.flowActive = false;
  state.flowSequence = [];
  state.currentStepIndex = 0;
  state.pendingTrainingStep = null;
  state.flowPlan = null;
  state.flowArm = null;
  state.flowStats = [];
  state.flowStepRecords = [];
  state.viewSeriesGroups = [];
  state.viewSeriesActiveGroup = 0;
  try {
    renderViewSeriesFab();
  } catch { }
}

function cancelFlow() {
  cancelActiveSession({ navigateHome: true });
}

export function cancelActiveSession({ navigateHome = false } = {}) {
  stopMeasurement();
  stopRestTimer();
  const modal = document.getElementById('armMaxModal');
  modal?.classList.add('hidden');
  const restOverlay = document.getElementById('restOverlay');
  restOverlay?.classList.add('hidden');
  if (state.flowActive) finishFlow();
  else {
    state.pendingTrainingStep = null;
    state.flowPlan = null;
    state.flowArm = null;
    state.flowSequence = [];
    state.currentStepIndex = 0;
  }
  stopTraining();
  state.pendingIntent = null;
  state.startReturnScreen = null;
  state.editOrigin = null;
  const controls = document.getElementById('controlsModal');
  controls?.classList.add('hidden');
  const fabMenu = document.getElementById('fabMenu');
  fabMenu?.classList.add('hidden');
  const fabToggle = document.getElementById('fabToggle');
  fabToggle?.classList.remove('hidden');
  state.viewSeriesGroups = [];
  state.viewSeriesActiveGroup = 0;
  try {
    renderViewSeriesFab();
  } catch { }
  if (navigateHome) showScreen('home');
}

function ensureFlowUiBindings() {
  const cancelBtn = document.getElementById('armMaxCancelBtn');
  const proceedBtn = document.getElementById('armMaxProceedBtn');
  const skipBtn = document.getElementById('restSkipBtn');
  cancelBtn?.addEventListener('click', handleMeasurementCancel);
  proceedBtn?.addEventListener('click', handleMeasurementProceed);
  skipBtn?.addEventListener('click', () => finishRestPeriod(true));
}

if (typeof document !== 'undefined') {
  ensureFlowUiBindings();
}

// Handle stage selection from session plot clicks
if (typeof window !== 'undefined') {
  window.addEventListener('session:stageSelected', (e) => {
    if (!state.trainingSession || !state.isImportedSession) return;
    let idx;
    const stages = state.trainingSession.stages || [];
    if (state.viewSeriesActiveGroup !== -1) {
      // Map index from event (relative to group) to global stage index
      const groups = Array.isArray(state.viewSeriesGroups) ? state.viewSeriesGroups : [];
      const group = groups[state.viewSeriesActiveGroup];
      if (group) {
        const groupStart = Number(group?.startStageIndex) - 1;
        const groupEnd = Number(group?.endStageIndex) - 1;
        const relIdx = e?.detail?.index ?? 0;
        idx = Math.max(groupStart, Math.min(groupStart + relIdx, groupEnd));
      }
    } else {
      // Full session: use index from event, clamped to all stages
      idx = Math.max(
        0,
        Math.min(e?.detail?.index ?? 0, stages.length - 1)
      );
    }
    state.stageIdx = idx;
    updateStageUI();
    try {
      plotStageSliceByIndex(idx);
    } catch { }
    try {
      syncChartScales();
    } catch { }

    // --- Re-apply group filtering to sessionHrChart and asides if a group is selected ---
    if (state.viewSeriesActiveGroup !== -1) {
      const groups = Array.isArray(state.viewSeriesGroups) ? state.viewSeriesGroups : [];
      const group = groups[state.viewSeriesActiveGroup];
      if (group) {
        const session = state.trainingSession;
        const stages = session.stages;
        const groupStart = Number(group?.startStageIndex) - 1;
        const groupEnd = Number(group?.endStageIndex) - 1;
        if (Number.isFinite(groupStart) && Number.isFinite(groupEnd) && state.sessionChart) {
          let startTime = 0;
          for (let i = 0; i < groupStart; i++) startTime += stages[i].durationSec;
          let endTime = startTime;
          for (let i = groupStart; i <= groupEnd; i++) endTime += stages[i].durationSec;
          const filtered = (state.sessionSeries || []).filter(
            (p) => typeof p?.x === "number" && p.x >= startTime && p.x <= endTime
          );
          state.sessionChart.setOption(
            { series: [{ data: filtered.map(pt => [pt.x - startTime, pt.y]) }] },
            false,
            true
          );
          state.sessionChart.setOption(
            {
              xAxis: { min: 0, max: endTime - startTime },
            },
            false,
            true
          );
          // Update highlight for group
          if (typeof syncChartScales === "function") {
            syncChartScales(groupStart, groupEnd, 0, endTime - startTime);
          }
          // Update asides for the group
          const groupStages = stages.slice(groupStart, groupEnd + 1);
          const groupSession = {
            ...session,
            stages: groupStages,
            totalDurationSec: groupStages.reduce((a, s) => a + s.durationSec, 0),
          };
          const stats = computeSessionStats(groupSession, filtered);
          const set = (id, v) => {
            const el = document.getElementById(id);
            if (el) el.textContent = String(v);
          };
          set("statAvg", `${stats.avg.toFixed(1)} kgf`);
          set("statMax", `${stats.max.toFixed(1)} kgf`);
          set("statMin", `${stats.min.toFixed(1)} kgf`);
          set("statInTarget", `${stats.inTargetPct.toFixed(1)}%`);
        }
      }
    } else {
      // Full session: update highlight
      if (typeof syncChartScales === "function") {
        syncChartScales();
      }
    }
  });
}

