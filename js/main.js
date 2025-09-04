
import { state } from './state.js';
import { setupCharts } from './charts.js';
import { parseTrainingCsv, startTraining, tick, nextStage, prevStage, showScreen, pauseTraining, resumeTraining, setPlayPauseVisual, exportSessionCsv, loadCompletedSessionFromExportCsv } from './session.js';
import { loadPlanForEdit } from './edit-plan.js';
import { connectToDevice, disconnectFromDevice, checkBluetoothSupport } from './ble.js';

// Boot
window.addEventListener('load', async ()=>{
  setupCharts();
  await checkBluetoothSupport();
});



// UI wiring
document.getElementById('connectButton').addEventListener('click', async ()=>{ if (await checkBluetoothSupport()) await connectToDevice(); });
document.getElementById('disconnectButton').addEventListener('click', ()=>{ disconnectFromDevice(); switchToConnect(); });
document.getElementById('goToPlanButton').addEventListener('click', ()=>{ if (state.device && state.device.gatt?.connected) showScreen('plan'); });
document.getElementById('backToConnect').addEventListener('click', ()=>showScreen('connect'));
document.getElementById('loadCsvBtn').addEventListener('click', ()=>{
  const text = document.getElementById('csvInput').value;
  const err = document.getElementById('csvError'); err.classList.add('hidden');
  if (!(state.device && state.device.gatt?.connected)){
    err.textContent = 'Conecte um dispositivo primeiro.'; err.classList.remove('hidden'); return;
  }
  try{
    const session = parseTrainingCsv(text);
    loadPlanForEdit(session);
  }catch(e){
    err.textContent = e.message || String(e);
    err.classList.remove('hidden');
  }
});
document.getElementById('nextStageBtn').addEventListener('click', ()=> nextStage());
document.getElementById('prevStageBtn').addEventListener('click', ()=> prevStage());
document.getElementById('backButton').addEventListener('click', ()=>switchToConnect());

// Import finished session (CSV) on connect screen
const importBtn = document.getElementById('importSessionBtn');
const importInput = document.getElementById('importSessionInput');
importBtn?.addEventListener('click', ()=> importInput?.click());
importInput?.addEventListener('change', (e)=>{
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  const reader = new FileReader();
  reader.onload = () => {
    try{
      loadCompletedSessionFromExportCsv(String(reader.result || ''));
    }catch(err){
      alert('Falha ao importar sessão: ' + (err?.message || String(err)));
    }
  };
  reader.onerror = () => alert('Não foi possível ler o arquivo CSV.');
  reader.readAsText(f);
});

function switchToConnect(){
  document.getElementById('status').textContent = 'Desconectado';
  document.getElementById('connectButton').disabled = false;
  document.getElementById('disconnectButton').disabled = true;
  document.getElementById('goToPlanButton').disabled = true;
  showScreen('connect');
}

// modal
const modal = document.getElementById('controlsModal'), openBtn = document.getElementById('openControls');
const closeBtn = document.getElementById('closeControls'), closeBtn2 = document.getElementById('closeControls2');
let lastFocused = null;
function trapTab(e){
  if (e.key !== 'Tab') return;
  const f = modal.querySelectorAll('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])');
  if (!f.length) return; const first = f[0], last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first){ e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last){ e.preventDefault(); first.focus(); }
}
function openModal(){ lastFocused = document.activeElement; modal.classList.remove('hidden'); document.getElementById('prevStageBtn').focus(); document.addEventListener('keydown', trapTab); }
function closeModal(){ modal.classList.add('hidden'); if (lastFocused) lastFocused.focus(); document.removeEventListener('keydown', trapTab); }
openBtn.addEventListener('click', openModal);
closeBtn.addEventListener('click', closeModal);
modal.addEventListener('click', (e)=>{ if (e.target === modal) closeModal(); });

// Play/Pause
const playPauseBtn = document.getElementById('playPauseBtn');
playPauseBtn.addEventListener('click', ()=>{ if (!state.trainingSession) return; state.paused ? resumeTraining() : pauseTraining(); });



// Session events fan-out
window.addEventListener('session:tick', ()=>tick());

// Simple helpers for other modules
window.addEventListener('ble:disconnected', ()=>switchToConnect());

// Exported helper for QR and button flows
export function startTrainingFromCsvText(text){
  const err = document.getElementById('csvError'); err.classList.add('hidden');
  if (!(state.device && state.device.gatt?.connected)){
    err.textContent = 'Conecte um dispositivo primeiro.'; err.classList.remove('hidden'); return;
  }
  try{
    const session = parseTrainingCsv(text);
    startTraining(session);
  }catch(e){
    err.textContent = e.message || String(e);
    err.classList.remove('hidden');
  }
}

// Completion navigation buttons
document.getElementById('completeBackBtn')?.addEventListener('click', ()=>{
  showScreen('connect');
});
document.getElementById('completePlanBtn')?.addEventListener('click', ()=>{
  showScreen('plan');
});
document.getElementById('completeExportBtn')?.addEventListener('click', ()=>{
  exportSessionCsv();
});
document.getElementById('completeMinimizeIcon')?.addEventListener('click', () => {
  const modal = document.getElementById('completeScreen');
  if (modal) modal.classList.add('hidden');
  const fab = document.getElementById('completeRestoreFab');
  if (fab) fab.classList.remove('hidden');
});

document.getElementById('completeRestoreFab')?.addEventListener('click', () => {
  const modal = document.getElementById('completeScreen');
  const fab = document.getElementById('completeRestoreFab');
  if (modal) modal.classList.remove('hidden');
  if (fab) fab.classList.add('hidden');
});
