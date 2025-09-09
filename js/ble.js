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
}
