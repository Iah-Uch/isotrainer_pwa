import { state } from './state.js';
import { now } from './utils.js';
import { updateStageChart, updateSessionChart } from './charts.js';
import { updateStageUI } from './session.js';

export async function checkBluetoothSupport(){
  if (!navigator.bluetooth){
    document.getElementById('status').textContent = 'Web Bluetooth indisponível. Use HTTPS/localhost e conceda permissões.';
    document.getElementById('connectButton').disabled = true;
    return false;
  }
  try{
    const avail = await navigator.bluetooth.getAvailability();
    if (!avail){
      document.getElementById('status').textContent = 'Adaptador Bluetooth não disponível.';
      document.getElementById('connectButton').disabled = true;
      return false;
    }
  }catch{
    document.getElementById('status').textContent = 'Erro ao verificar disponibilidade do Bluetooth.';
    document.getElementById('connectButton').disabled = true;
    return false;
  }
  return true;
}

export async function connectToDevice(){
  if (!(await checkBluetoothSupport())) return;
  try{
    document.getElementById('status').textContent = 'Abrindo seletor de dispositivo...';
    document.getElementById('connectButton').disabled = true;
    state.device = await navigator.bluetooth.requestDevice({ filters:[{ services:['heart_rate'] }], optionalServices:['heart_rate'] });
    document.getElementById('status').textContent = 'Conectando ao servidor GATT...';
    state.server = await state.device.gatt.connect();
    document.getElementById('status').textContent = `Conectado a ${state.device.name}`;
    document.getElementById('disconnectButton').disabled = false;
    document.getElementById('goToPlanButton').disabled = false;
    state.service = await state.server.getPrimaryService('heart_rate');
    state.characteristic = await state.service.getCharacteristic('heart_rate_measurement');
    await state.characteristic.startNotifications();
    state.characteristic.addEventListener('characteristicvaluechanged', (e)=>handleHeartRateMeasurement(e.target.value));
    addDisconnectListener();
  }catch(err){
    document.getElementById('status').textContent = `Erro: ${err.message}`;
    document.getElementById('connectButton').disabled = false;
    document.getElementById('disconnectButton').disabled = true;
    document.getElementById('goToPlanButton').disabled = true;
  }
}

export function disconnectFromDevice(){ if (state.device && state.device.gatt.connected) state.device.gatt.disconnect(); }
function handleDisconnect(){ const ev = new CustomEvent('ble:disconnected'); window.dispatchEvent(ev); }
function addDisconnectListener(){ if (state.device) state.device.addEventListener('gattserverdisconnected', handleDisconnect, { once:true }); }

function saturateStage(hr){
  if (state.trainingSession && state.stageIdx >= 0){
    const { lower, upper } = state.trainingSession.stages[state.stageIdx];
    // Clamp to buffered bounds (±10) so hrChart has slack
    const lo = lower - 10;
    const hi = upper + 10;
    if (hr < lo) return lo;
    if (hr > hi) return hi;
  }
  return hr;
}

function saturateSession(hr){
  if (!state.trainingSession || !state.trainingSession.sessionBounds) return hr;
  const { min, max } = state.trainingSession.sessionBounds;
  if (hr < min) return min;
  if (hr > max) return max;
  return hr;
}

function handleHeartRateMeasurement(value){
  const dv = new DataView(value.buffer);
  const flags = dv.getUint8(0);
  const hr = ((flags & 1) === 0) ? dv.getUint8(1) : dv.getUint16(1, true);

  if (state.waitingForFirstHR && hr > 0){
    state.waitingForFirstHR = false;
    state.sessionStartMs = now();
    state.stageStartMs = now();
    updateStageUI();
    state.timerHandle = setInterval(()=>window.dispatchEvent(new CustomEvent('session:tick')), 200);
  }
  if (state.paused) return;

  // NORMAL HUD
  const hrText = `${hr} bpm`;
  const currentHr = document.getElementById('currentHr');
  if (currentHr) currentHr.textContent = hrText;

  // FULLSCREEN HUD (bigger)
  const fsHr = document.getElementById('fsHr');
  if (fsHr) fsHr.textContent = String(hr);

  const marker = document.getElementById('heartMarker');
  if (marker){
    const period = Math.max(.3, Math.min(3.0, 60/Math.max(hr,1)));
    marker.style.setProperty('--pulse-period', `${period.toFixed(2)}s`);
  }

  const currentTime = now();
  updateStageChart(saturateStage(hr), currentTime);
  updateSessionChart(saturateSession(hr), currentTime);
}
