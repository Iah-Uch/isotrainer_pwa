import { state } from './state.js';
import { now } from './utils.js';
import { updateStageChart, updateSessionChart } from './charts.js';
import { updateStageUI, updateLiveStageInTargetPct } from './session.js';

export async function checkBluetoothSupport() {
  if (!navigator.bluetooth) {
    document.getElementById('status').textContent = 'Web Bluetooth indisponível. Use HTTPS/localhost e conceda permissões.';
    document.getElementById('connectButton').disabled = true;
    return false;
  }
  // Best-effort availability check. Some iOS WebBLE browsers do not implement it.
  try {
    if (typeof navigator.bluetooth.getAvailability === 'function') {
      const avail = await navigator.bluetooth.getAvailability();
      if (!avail) {
        // Inform the user but do not hard-block attempts; some runtimes misreport.
        document.getElementById('status').textContent = 'Adaptador Bluetooth possivelmente indisponível. Você ainda pode tentar conectar.';
      }
    }
  } catch {
    // Do not gate on errors; allow user to attempt connection in WebBLE browsers.
    document.getElementById('status').textContent = 'Não foi possível verificar disponibilidade do Bluetooth. Tente conectar.';
  }
  document.getElementById('connectButton').disabled = false;
  return true;
}

export async function connectToDevice() {
  if (!(await checkBluetoothSupport())) return;
  try {
    document.getElementById('status').textContent = 'Abrindo seletor de dispositivo...';
    document.getElementById('connectButton').disabled = true;
    // Primary path: filter by heart_rate service.
    try {
      state.device = await navigator.bluetooth.requestDevice({ filters: [{ services: ['heart_rate'] }], optionalServices: ['heart_rate'] });
    } catch (err) {
      // If filtering is unsupported or fails, fall back to acceptAllDevices and filter after connect.
      if (err?.name === 'NotFoundError') {
        // User canceled or no device selected; restore UI and exit gracefully.
        document.getElementById('status').textContent = 'Nenhum dispositivo selecionado.';
        document.getElementById('connectButton').disabled = false;
        document.getElementById('disconnectButton').disabled = true;
        document.getElementById('goToPlanButton').disabled = true;
        return;
      }
      document.getElementById('status').textContent = 'Tentando modo compatível (lista completa)...';
      state.device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: ['heart_rate'] });
    }
    document.getElementById('status').textContent = 'Conectando ao servidor GATT...';
    state.server = await state.device.gatt.connect();
    document.getElementById('status').textContent = `Conectado a ${state.device.name}`;
    document.getElementById('disconnectButton').disabled = false;
    document.getElementById('goToPlanButton').disabled = false;
    state.service = await state.server.getPrimaryService('heart_rate');
    state.characteristic = await state.service.getCharacteristic('heart_rate_measurement');
    await state.characteristic.startNotifications();
    state.characteristic.addEventListener('characteristicvaluechanged', (e) => handleHeartRateMeasurement(e.target.value));
    addDisconnectListener();
    try { window.dispatchEvent(new CustomEvent('ble:connected')); } catch { }
  } catch (err) {
    // Provide clearer guidance for common compatibility issues
    const msg = err?.message || String(err);
    document.getElementById('status').textContent = `Erro: ${msg}`;
    document.getElementById('connectButton').disabled = false;
    document.getElementById('disconnectButton').disabled = true;
    document.getElementById('goToPlanButton').disabled = true;
  }
}

export function disconnectFromDevice() { if (state.device && state.device.gatt.connected) state.device.gatt.disconnect(); }
function handleDisconnect() { const ev = new CustomEvent('ble:disconnected'); window.dispatchEvent(ev); }
function addDisconnectListener() { if (state.device) state.device.addEventListener('gattserverdisconnected', handleDisconnect, { once: true }); }

function saturateStage(hr) {
  if (state.trainingSession && state.stageIdx >= 0) {
    const { lower, upper } = state.trainingSession.stages[state.stageIdx];
    // Clamp to buffered bounds (±10) so hrChart has slack
    const lo = lower - 10;
    const hi = upper + 10;
    if (hr < lo) return lo;
    if (hr > hi) return hi;
  }
  return hr;
}

function saturateSession(hr) {
  if (!state.trainingSession || !state.trainingSession.sessionBounds) return hr;
  const { min, max } = state.trainingSession.sessionBounds;
  if (hr < min) return min;
  if (hr > max) return max;
  return hr;
}

function handleHeartRateMeasurement(value) {
  const dv = new DataView(value.buffer);
  const flags = dv.getUint8(0);
  const hr = ((flags & 1) === 0) ? dv.getUint8(1) : dv.getUint16(1, true);

  if (state.waitingForFirstHR && !state.startPending && hr > 0) {
    state.waitingForFirstHR = false;
    state.sessionStartMs = now();
    state.stageStartMs = now();
    updateStageUI();
    state.timerHandle = setInterval(() => window.dispatchEvent(new CustomEvent('session:tick')), 200);
  }
  if (state.paused) return;

  // NORMAL HUD
  const currentHrValue = document.getElementById('currentHrValue');
  if (currentHrValue) {
    currentHrValue.textContent = String(hr);
  } else {
    // Backward compatibility if layout not updated
    const currentHr = document.getElementById('currentHr');
    if (currentHr) currentHr.textContent = `${hr} bpm`;
  }

  const marker = document.getElementById('heartMarker');
  if (marker) {
    const period = Math.max(.3, Math.min(3.0, 60 / Math.max(hr, 1)));
    marker.style.setProperty('--pulse-period', `${period.toFixed(2)}s`);
  }

  const currentTime = now();
  updateStageChart(saturateStage(hr), currentTime);
  updateSessionChart(saturateSession(hr), currentTime);
  try { updateLiveStageInTargetPct(); } catch { }

  // Update Pre-Start modal guidance while user prepares
  try {
    if (state.startPending && state.trainingSession && state.trainingSession.stages?.length) {
      const first = state.trainingSession.stages[0];
      const hrEl = document.getElementById('preStartHrValue');
      const guideText = document.getElementById('preStartText');
      const guideWrap = document.getElementById('preStartGuidance');
      const iconEl = document.getElementById('preStartIcon');
      const rangeEl = document.getElementById('preStartStageRange');
      const targetEl = document.getElementById('preStartTarget');
      const thumbEl = document.getElementById('preStartThumb');
      const scaleMinEl = document.getElementById('preStartScaleMin');
      const scaleMaxEl = document.getElementById('preStartScaleMax');
      if (hrEl) hrEl.textContent = `${hr} bpm`;
      if (rangeEl) rangeEl.textContent = `${first.lower}/${first.upper} bpm`;
      // Compute scale from session bounds if present
      let scaleMin = (state.trainingSession?.sessionBounds?.min ?? (first.lower - 20));
      let scaleMax = (state.trainingSession?.sessionBounds?.max ?? (first.upper + 20));
      if (!Number.isFinite(scaleMin)) scaleMin = first.lower - 20;
      if (!Number.isFinite(scaleMax)) scaleMax = first.upper + 20;
      if (scaleMax <= scaleMin) scaleMax = scaleMin + 40;
      const span = Math.max(1, scaleMax - scaleMin);
      if (scaleMinEl) scaleMinEl.textContent = `${Math.max(0, Math.round(scaleMin))} bpm`;
      if (scaleMaxEl) scaleMaxEl.textContent = `${Math.max(0, Math.round(scaleMax))} bpm`;
      if (targetEl) {
        const leftPct = Math.max(0, Math.min(100, ((first.lower - scaleMin) / span) * 100));
        const rightPct = Math.max(0, Math.min(100, ((first.upper - scaleMin) / span) * 100));
        targetEl.style.left = `${leftPct}%`;
        targetEl.style.width = `${Math.max(0, rightPct - leftPct)}%`;
      }
      if (thumbEl) {
        const p = Math.max(0, Math.min(100, ((hr - scaleMin) / span) * 100));
        thumbEl.style.left = `calc(${p}% - 10px)`; // center the 20px thumb
      }
      if (guideText && iconEl && guideWrap && thumbEl) {
        let msg = 'Aguardando leitura da FC...';
        let colorClass = 'text-slate-300';
        let iconSvg = '';
        if (hr > 0) {
          if (hr < first.lower) {
            msg = 'Aumente a intensidade até entrar no alvo.';
            colorClass = 'text-amber-400';
            iconSvg = '<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 24 24" fill="currentColor"><path d="M4 12l1.41 1.41L11 7.83V20h2V7.83l5.59 5.58L20 12l-8-8-8 8z"/></svg>';
          } else if (hr > first.upper) {
            msg = 'Reduza a intensidade até entrar no alvo.';
            colorClass = 'text-amber-400';
            iconSvg = '<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 24 24" fill="currentColor"><path d="M20 12l-1.41-1.41L13 16.17V4h-2v12.17l-5.59-5.58L4 12l8 8 8-8z"/></svg>';
          } else {
            msg = 'Pronto! Você está no alvo. Você pode iniciar.';
            colorClass = 'text-emerald-400';
            iconSvg = '<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.2l-3.5-3.5L4 14.2l5 5 12-12-1.5-1.5z"/></svg>';
          }
        }
        guideText.textContent = msg;
        iconEl.innerHTML = iconSvg;
        guideWrap.classList.remove('text-slate-300', 'text-amber-400', 'text-emerald-400', 'text-rose-400');
        guideWrap.classList.add(colorClass);
        // Also color the thumb for quick visual cue
        thumbEl.classList.remove('text-slate-400', 'text-amber-400', 'text-emerald-400');
        if (colorClass === 'text-emerald-400') thumbEl.classList.add('text-emerald-400');
        else thumbEl.classList.add('text-amber-400');
      }
    }
  } catch { }
}
