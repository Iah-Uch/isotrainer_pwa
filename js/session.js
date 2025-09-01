import { state } from './state.js';
import { now, fmtMMSS, parseTimeToSeconds } from './utils.js';
import { resetStageSeries, resetSessionSeries, setYAxis, setStageXAxis, syncChartScales } from './charts.js';

export function parseTrainingCsv(text){
  if (!text || !text.trim()) throw new Error('O texto do CSV está vazio.');
  const lines = text.trim().split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) throw new Error('O CSV deve incluir cabeçalho + ao menos uma linha de estágio.');
  const header = lines[0].split(';').map(s => s.trim());
  if (header.length < 4) throw new Error('Cabeçalho deve ser: ignorado;ignorado;data;atleta');
  const date = header[2], athlete = header.slice(3).join(';');
  const stages = [];
  for (let i = 1; i < lines.length; i++){
    const parts = lines[i].split(';').map(s => s.trim());
    if (parts.length < 4) throw new Error(`Linha de estágio ${i+1} deve ser: índice;HH:MM:SS;inferior;superior`);
    const index = parseInt(parts[0], 10);
    const durationSec = parseTimeToSeconds(parts[1]);
    const lower = Number(parts[2]), upper = Number(parts[3]);
    if ([index, lower, upper].some(Number.isNaN)) throw new Error(`Números inválidos na linha ${i+1}.`);
    if (upper <= lower) throw new Error(`Superior deve ser maior que inferior na linha ${i+1}.`);
    stages.push({ index, durationSec, lower, upper });
  }
  const totalDurationSec = stages.reduce((a,s)=>a+s.durationSec, 0);
  return { date, athlete, stages, totalDurationSec };
}

export function startTraining(session){
  stopTraining();
  state.trainingSession = session;
  state.stageIdx = 0;
  state.waitingForFirstHR = true;

  // UI priming (normal mode)
  document.getElementById('sessionAthlete').textContent = session.athlete || '—';
  document.getElementById('sessionMeta').textContent = `${session.date}`;
  document.getElementById('stageLabel').textContent = 'Aguardando sinal de FC...';
  document.getElementById('stageRange').textContent = '—';
  document.getElementById('stageMinMeta').textContent = 'Aguardando FC...';
  document.getElementById('stageElapsed').textContent = '00:00';
  document.getElementById('totalRemaining').textContent = fmtMMSS(session.totalDurationSec);


  // FS HUD priming
  const fsHr = document.getElementById('fsHr');
  const fsStage = document.getElementById('fsStage');
  const fsStageElapsed = document.getElementById('fsStageElapsed');
  const fsTotalRemaining = document.getElementById('fsTotalRemaining');
  if (fsHr) fsHr.textContent = '--';
  if (fsStage) fsStage.textContent = 'Aguardando…';
  if (fsStageElapsed) fsStageElapsed.textContent = '00:00';
  if (fsTotalRemaining) fsTotalRemaining.textContent = fmtMMSS(session.totalDurationSec);


  resetStageSeries();
  resetSessionSeries();
  const firstStage = session.stages[0];
  setYAxis(firstStage.lower, firstStage.upper);
  setStageXAxis(firstStage.durationSec);

  const allLows = session.stages.map(s => s.lower);
  const allHighs = session.stages.map(s => s.upper);
  const minHr = Math.min(...allLows);
  const maxHr = Math.max(...allHighs);
  const buffer = 10;
  state.trainingSession.sessionBounds = { min: minHr - buffer, max: maxHr + buffer };
  syncChartScales();

  state.paused = false; state.pausedAtMs = null; state.accumulatedPauseOffset = 0; state.stageAccumulatedPauseOffset = 0;
  showScreen('plot');
  setTimeout(()=>{ state.chart?.resize(); state.sessionChart?.resize(); }, 10);

  state.pulseAnimation.startTime = performance.now();
  state.pulseAnimation.handle = requestAnimationFrame(animationLoop);
}

export function updateStageUI(){
  const st = state.trainingSession.stages[state.stageIdx];
  const label = `Estágio ${st.index}/${state.trainingSession.stages.length} • ${fmtMMSS(st.durationSec)}`;
  document.getElementById('stageLabel').textContent = label;
  document.getElementById('stageRange').textContent = `Alvo: ${st.lower}–${st.upper}`;
  document.getElementById('stageMinMeta').textContent = `E${st.index}/${state.trainingSession.stages.length} • ${fmtMMSS(st.durationSec)} • ${st.lower}–${st.upper}`;

  // FS HUD stage text
  const fsStage = document.getElementById('fsStage');
  if (fsStage) fsStage.textContent = `E${st.index}/${state.trainingSession.stages.length} • ${st.lower}–${st.upper}`;

  setYAxis(st.lower, st.upper);
  setStageXAxis(st.durationSec);
  resetStageSeries();
}

export function computeTotalElapsedSec(nowMs){
  if (!state.sessionStartMs) return 0;
  return Math.max(0, (nowMs - state.sessionStartMs - state.accumulatedPauseOffset)/1000);
}

export function tick(){
  if (!state.trainingSession || state.paused || state.waitingForFirstHR) return;
  const nowMs = now();
  const st = state.trainingSession.stages[state.stageIdx];
  const stageElapsedSec = Math.max(0, (nowMs - state.stageStartMs - state.stageAccumulatedPauseOffset)/1000);

  const stageElapsedText = fmtMMSS(Math.min(stageElapsedSec, st.durationSec));
  document.getElementById('stageElapsed').textContent = stageElapsedText;

  const totalElapsed = computeTotalElapsedSec(nowMs);
  const totalRemainingSec = Math.max(0, state.trainingSession.totalDurationSec - totalElapsed);
  const totalRemainingText = fmtMMSS(totalRemainingSec);
  document.getElementById('totalRemaining').textContent = totalRemainingText;

  // FS HUD timers
  const fsStageElapsed = document.getElementById('fsStageElapsed');
  const fsTotalRemaining = document.getElementById('fsTotalRemaining');
  if (fsStageElapsed) fsStageElapsed.textContent = stageElapsedText;
  if (fsTotalRemaining) fsTotalRemaining.textContent = totalRemainingText;

  if (stageElapsedSec >= st.durationSec){ nextStage(); }
}

export function navigateToStage(newIndex){
  if (!state.trainingSession || newIndex < 0 || newIndex >= state.trainingSession.stages.length) return;
  let newStageStartTimeSec = 0;
  for (let i=0;i<newIndex;i++){ newStageStartTimeSec += state.trainingSession.stages[i].durationSec; }
  const removalIndex = state.sessionSeries.findIndex(p => p.x >= newStageStartTimeSec);
  if (removalIndex !== -1) state.sessionSeries.length = removalIndex;
  const lastPoint = state.sessionSeries[state.sessionSeries.length-1];
  if (lastPoint && lastPoint.y !== null) state.sessionSeries.push({ x:lastPoint.x, y:null });
  state.accumulatedPauseOffset = now() - state.sessionStartMs - (newStageStartTimeSec * 1000);
  state.stageIdx = newIndex; state.stageStartMs = now(); state.stageAccumulatedPauseOffset = 0; updateStageUI();
}

export function nextStage(){
  if (!state.trainingSession) return;
  if (state.stageIdx < state.trainingSession.stages.length - 1){
    navigateToStage(state.stageIdx + 1);
  } else {
    // Finalize session
    pauseTraining(true);
    document.getElementById('stageLabel').textContent = `Concluída • ${state.trainingSession.stages.length} estágios`;
    const stats = computeSessionStats();
    showCompletion(stats);
  }
}
export function prevStage(){ if (!state.trainingSession) return; navigateToStage(state.stageIdx - 1); }
export function pauseTraining(finalize=false){ if (state.paused) return; state.paused = true; state.pausedAtMs = now(); if (!finalize) setPlayPauseVisual(); }
export function resumeTraining(){ if (!state.paused) return; const d = now() - state.pausedAtMs; state.accumulatedPauseOffset += d; state.stageAccumulatedPauseOffset += d; state.paused = false; state.pausedAtMs = null; setPlayPauseVisual(); }
export function stopTraining(){
  if (state.timerHandle) clearInterval(state.timerHandle);
  if (state.pulseAnimation.handle){ cancelAnimationFrame(state.pulseAnimation.handle); state.pulseAnimation.handle = null; }
  state.timerHandle = null; state.trainingSession = null; state.stageIdx = -1;
  state.sessionStartMs = state.stageStartMs = null; state.paused = false; state.pausedAtMs = null;
  state.accumulatedPauseOffset = state.stageAccumulatedPauseOffset = 0; state.waitingForFirstHR = false;
}

export function setPlayPauseVisual(){
  const p = state.paused;
  const iconPause = document.getElementById('iconPause');
  const iconPlay  = document.getElementById('iconPlay');
  const playPauseBtn = document.getElementById('playPauseBtn');
  iconPause.classList.toggle('hidden', p);
  iconPlay.classList.toggle('hidden', !p);
  playPauseBtn.setAttribute('aria-label', p ? 'Retomar treino' : 'Pausar treino');
}

export function showScreen(which){
  const connect = document.getElementById('connectScreen');
  const plan = document.getElementById('planScreen');
  const plot = document.getElementById('plotScreen');
  const complete = document.getElementById('completeScreen');
  connect.classList.add('hidden'); plan.classList.add('hidden'); plot.classList.add('hidden'); complete.classList.add('hidden');
  if (which==='connect') connect.classList.remove('hidden');
  if (which==='plan') plan.classList.remove('hidden');
  if (which==='plot') plot.classList.remove('hidden');
  if (which==='complete') complete.classList.remove('hidden');
}

export function animationLoop(){
  if (state.trainingSession){
    state.sessionChart?.update('none');
    state.fsSessionChart?.update('none');
    state.pulseAnimation.handle = requestAnimationFrame(animationLoop);
  }
}

// Compute simple session stats from sessionSeries
export function computeSessionStats(){
  const points = state.sessionSeries || [];
  if (!points.length || !state.trainingSession){
    return { avg: 0, min: 0, max: 0, inTargetPct: 0 };
  }
  let sum = 0, count = 0, min = Infinity, max = -Infinity;
  let inTargetCount = 0;
  // Determine stage targets over time to compute in-target percentage
  // We map x (sec from start) to stage bounds using cumulative durations
  const stageOffsets = [];
  let acc = 0; for (const s of state.trainingSession.stages){ stageOffsets.push({ start: acc, end: acc + s.durationSec, lo: s.lower, hi: s.upper }); acc += s.durationSec; }

  for (const p of points){
    if (p && typeof p.y === 'number'){
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

function showCompletion(stats){
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = String(v); };
  set('statAvg', `${stats.avg} bpm`);
  set('statMax', `${stats.max} bpm`);
  set('statMin', `${stats.min} bpm`);
  set('statInTarget', `${stats.inTargetPct}%`);
  showScreen('complete');
}
