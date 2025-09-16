
// Module: App bootstrap and UI wiring.
import { state } from './state.js';
import { setupCharts } from './charts.js';
import { parseTrainingCsv, startTraining, tick, nextStage, prevStage, showScreen, pauseTraining, resumeTraining, setPlayPauseVisual, exportSessionCsv, loadCompletedSessionFromExportCsv, stopTraining } from './session.js';
import { loadPlanForEdit } from './edit-plan.js';
import { connectToDevice, disconnectFromDevice, checkBluetoothSupport } from './ble.js';
import { bindHomeNav, loadStoredPlans, isContrastOn, applyContrastToDocument, applyPlotSettingsToDom } from './plans.js';

// Boot: initialize charts and early UI preferences.
window.addEventListener('load', async () => {
  setupCharts();
  // Apply persisted UI contrast preference early.
  try { applyContrastToDocument(isContrastOn()); } catch { }
  await checkBluetoothSupport();
  try { bindHomeNav(); } catch { }
  try { showScreen('home'); } catch { }
  try { applyPlotSettingsToDom(); } catch { }
});



// Event wiring: connect/disconnect and navigation.
document.getElementById('connectButton').addEventListener('click', async () => { if (await checkBluetoothSupport()) await connectToDevice(); });
document.getElementById('disconnectButton').addEventListener('click', () => { disconnectFromDevice(); switchToConnect(); });
document.getElementById('connectBackBtn')?.addEventListener('click', () => {
  try {
    // Cancel any pending start and return to origin (editor if available).
    state.pendingIntent = null;
    const dest = state.startReturnScreen;
    state.startReturnScreen = null;
    if (dest === 'editPlan') { showScreen('editPlan'); return; }
    if (dest === 'plan') { showScreen('plan'); return; }
  } catch { }
  showScreen('home');
});
document.getElementById('goToPlanButton').addEventListener('click', () => {
  const intent = state.pendingIntent;
  if (intent && intent.type === 'startEdited' && intent.session) {
    state.pendingIntent = null;
    startTraining(intent.session);
    return;
  }
  showScreen('home');
});
document.getElementById('backToConnect').addEventListener('click', () => showScreen('home'));
document.getElementById('loadCsvBtn').addEventListener('click', () => {
  const text = document.getElementById('csvInput').value;
  const err = document.getElementById('csvError'); err.classList.add('hidden');
  try {
    const session = parseTrainingCsv(text);
    loadPlanForEdit(session, 'plan');
  } catch (e) {
    err.textContent = e.message || String(e);
    err.classList.remove('hidden');
  }
});
document.getElementById('nextStageBtn').addEventListener('click', () => nextStage());
document.getElementById('prevStageBtn').addEventListener('click', () => prevStage());
document.getElementById('backButton').addEventListener('click', () => showScreen('home'));

// Import a finished session (CSV) from Home.
const importBtn = document.getElementById('homeImportSessionBtn');
const importInput = document.getElementById('homeImportSessionInput');
importBtn?.addEventListener('click', () => importInput?.click());
importInput?.addEventListener('change', (e) => {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      loadCompletedSessionFromExportCsv(String(reader.result || ''));
    } catch (err) {
      alert('Falha ao importar sessão: ' + (err?.message || String(err)));
    }
  };
  reader.onerror = () => alert('Não foi possível ler o arquivo CSV.');
  reader.readAsText(f);
});

function switchToConnect() {
  document.getElementById('status').textContent = 'Desconectado';
  document.getElementById('connectButton').disabled = false;
  document.getElementById('disconnectButton').disabled = true;
  document.getElementById('goToPlanButton').disabled = true;
  showScreen('connect');
}

// Modal: training controls.
const modal = document.getElementById('controlsModal'), openBtn = document.getElementById('openControls');
const closeBtn = document.getElementById('closeControls'), closeBtn2 = document.getElementById('closeControls2');
let lastFocused = null;
function trapTab(e) {
  if (e.key !== 'Tab') return;
  const f = modal.querySelectorAll('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])');
  if (!f.length) return; const first = f[0], last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}
function openModal() { lastFocused = document.activeElement; modal.classList.remove('hidden'); document.getElementById('prevStageBtn').focus(); document.addEventListener('keydown', trapTab); }
function closeModal() { modal.classList.add('hidden'); if (lastFocused) lastFocused.focus(); document.removeEventListener('keydown', trapTab); }
openBtn.addEventListener('click', openModal);
closeBtn.addEventListener('click', closeModal);
modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

// Play/pause toggle.
const playPauseBtn = document.getElementById('playPauseBtn');
playPauseBtn.addEventListener('click', () => { if (!state.trainingSession) return; state.paused ? resumeTraining() : pauseTraining(); });



// Tick the session loop.
window.addEventListener('session:tick', () => tick());

// Handle BLE disconnect from other modules.
window.addEventListener('ble:disconnected', () => switchToConnect());

// Start a session from CSV text (used by QR and button flows).
export function startTrainingFromCsvText(text) {
  const err = document.getElementById('csvError'); err.classList.add('hidden');
  if (!(state.device && state.device.gatt?.connected)) {
    err.textContent = 'Conecte um dispositivo primeiro.'; err.classList.remove('hidden'); return;
  }
  try {
    const session = parseTrainingCsv(text);
    startTraining(session);
  } catch (e) {
    err.textContent = e.message || String(e);
    err.classList.remove('hidden');
  }
}

// Pre-start modal wiring.
const preStartModal = document.getElementById('preStartModal');
const preStartGoBtn = document.getElementById('preStartGoBtn');
const preStartBackBtn = document.getElementById('preStartBackBtn');
preStartGoBtn?.addEventListener('click', () => {
  // Allow session to begin on next HR notification.
  state.startPending = false;
  preStartModal?.classList.add('hidden');
});
preStartBackBtn?.addEventListener('click', () => {
  // Cancel prepared session and return to the Plan screen.
  preStartModal?.classList.add('hidden');
  stopTraining();
  try {
    const dest = state.startReturnScreen;
    state.startReturnScreen = null;
    if (dest === 'editPlan') { showScreen('editPlan'); return; }
    if (dest === 'plan') { showScreen('plan'); return; }
    showScreen('home');
  } catch {
    showScreen('home');
  }
});
// Dismiss modal on backdrop click.
preStartModal?.addEventListener('click', (e) => { if (e.target === preStartModal) preStartModal.classList.add('hidden'); });

// Completion screen actions.
document.getElementById('completeBackBtn')?.addEventListener('click', () => { showScreen('home'); });
document.getElementById('completePlanBtn')?.addEventListener('click', () => {
  showScreen('plan');
});
document.getElementById('completeExportBtn')?.addEventListener('click', () => {
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

// Do not auto-navigate on connect; user advances with Next on Connect.
