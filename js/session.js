import { state } from './state.js';
import { now, fmtMMSS, parseTimeToSeconds } from './utils.js';
import { resetStageSeries, resetSessionSeries, setYAxis, setStageXAxis, syncChartScales } from './charts.js';

export function parseTrainingCsv(text){
  if (!text || !text.trim()) throw new Error('CSV text is empty.');
  const lines = text.trim().split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) throw new Error('CSV must include header + at least one stage line.');
  const header = lines[0].split(';').map(s => s.trim());
  if (header.length < 4) throw new Error('Header must be: ignored;ignored;date;athlete');
  const date = header[2], athlete = header.slice(3).join(';');
  const stages = [];
  for (let i = 1; i < lines.length; i++){
    const parts = lines[i].split(';').map(s => s.trim());
    if (parts.length < 4) throw new Error(`Stage line ${i+1} must be: index;HH:MM:SS;lower;upper`);
    const index = parseInt(parts[0], 10);
    const durationSec = parseTimeToSeconds(parts[1]);
    const lower = Number(parts[2]), upper = Number(parts[3]);
    if ([index, lower, upper].some(Number.isNaN)) throw new Error(`Invalid numbers on line ${i+1}.`);
    if (upper <= lower) throw new Error(`Upper must be greater than lower on line ${i+1}.`);
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
  document.getElementById('stageLabel').textContent = 'Waiting for HR signal...';
  document.getElementById('stageRange').textContent = '—';
  document.getElementById('stageMinMeta').textContent = 'Waiting for HR...';
  document.getElementById('stageElapsed').textContent = '00:00';
  document.getElementById('totalRemaining').textContent = fmtMMSS(session.totalDurationSec);


  // FS HUD priming
  const fsHr = document.getElementById('fsHr');
  const fsStage = document.getElementById('fsStage');
  const fsStageElapsed = document.getElementById('fsStageElapsed');
  const fsTotalRemaining = document.getElementById('fsTotalRemaining');
  if (fsHr) fsHr.textContent = '--';
  if (fsStage) fsStage.textContent = 'Waiting…';
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
  const label = `Stage ${st.index}/${state.trainingSession.stages.length} • ${fmtMMSS(st.durationSec)}`;
  document.getElementById('stageLabel').textContent = label;
  document.getElementById('stageRange').textContent = `Target: ${st.lower}–${st.upper}`;
  document.getElementById('stageMinMeta').textContent = `S${st.index}/${state.trainingSession.stages.length} • ${fmtMMSS(st.durationSec)} • ${st.lower}–${st.upper}`;

  // FS HUD stage text
  const fsStage = document.getElementById('fsStage');
  if (fsStage) fsStage.textContent = `S${st.index}/${state.trainingSession.stages.length} • ${st.lower}–${st.upper}`;

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

export function nextStage(){ if (!state.trainingSession) return; if (state.stageIdx < state.trainingSession.stages.length - 1){ navigateToStage(state.stageIdx + 1); } else { pauseTraining(true); document.getElementById('stageLabel').textContent = `Completed • ${state.trainingSession.stages.length} stages`; } }
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
  playPauseBtn.setAttribute('aria-label', p ? 'Resume training' : 'Pause training');
}

export function showScreen(which){
  const connect = document.getElementById('connectScreen'), plan = document.getElementById('planScreen'), plot = document.getElementById('plotScreen');
  connect.classList.add('hidden'); plan.classList.add('hidden'); plot.classList.add('hidden');
  if (which==='connect') connect.classList.remove('hidden');
  if (which==='plan') plan.classList.remove('hidden');
  if (which==='plot') plot.classList.remove('hidden');
}

export function animationLoop(){
  if (state.trainingSession){
    state.sessionChart?.update('none');
    state.fsSessionChart?.update('none');
    state.pulseAnimation.handle = requestAnimationFrame(animationLoop);
  }
}
