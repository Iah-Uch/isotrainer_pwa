// Module: App bootstrap and UI wiring.
import { state } from './state.js';
import { setupCharts } from "./charts.js";
import {
  parseTrainingCsv,
  startTraining,
  tick,
  nextStage,
  prevStage,
  showScreen,
  pauseTraining,
  resumeTraining,
  setPlayPauseVisual,
  exportSessionCsv,
  loadCompletedSessionFromExportCsv,
  prepareFixedPlanFlow,
  cancelActiveSession,
} from "./session.js";
import { loadPlanForEdit } from "./edit-plan.js";
import {
  connectToDevice,
  disconnectFromDevice,
  checkBluetoothSupport,
  ensureDevMockConnection,
} from "./ble.js";
import {
  bindHomeNav,
  isContrastOn,
  applyContrastToDocument,
  applyPlotSettingsToDom,
  getPlanProfiles,
  getActiveProfileId,
  setActiveProfileId,
  isProfileSelectionRequired,
  openProfileSelectionScreen,
} from "./plans.js";

const DEBUG_NAV = true;
const logNav = (...args) => {
  if (!DEBUG_NAV) return;
  try {
    console.log('[nav]', ...args);
  } catch { }
};

function isPhysicalDeviceConnected() {
  return !!(state.device && state.device.gatt?.connected);
}

function hasEffectiveConnection() {
  if (state.device?.__mock) return true;
  return isPhysicalDeviceConnected();
}

function updateConnectUi() {
  const statusEl = document.getElementById('status');
  const connectBtn = document.getElementById('connectButton');
  const disconnectBtn = document.getElementById('disconnectButton');
  const goBtn = document.getElementById('goToPlanButton');
  const effective = hasEffectiveConnection();
  const physical = isPhysicalDeviceConnected();
  const isMock = Boolean(state.device?.__mock);
  if (statusEl) {
    if (effective) {
      if (isMock || !physical) {
        statusEl.textContent = 'Conectado (modo simulação)';
      } else {
        statusEl.textContent = `Conectado a ${state.device?.name || 'TeraForce'}`;
      }
    } else {
      statusEl.textContent = 'Desconectado';
    }
  }
  if (connectBtn) connectBtn.disabled = isPhysicalDeviceConnected();
  if (disconnectBtn)
    disconnectBtn.disabled = !Boolean(state.device?.__mock || isPhysicalDeviceConnected());
  if (goBtn) {
    goBtn.disabled = !effective;
    goBtn.setAttribute('aria-disabled', effective ? 'false' : 'true');
  }
}

function launchPreparedTraining() {
  const intent = state.pendingIntent;
  if (intent && intent.type === 'startEdited' && intent.session) {
    logNav('Launching edited session');
    state.pendingIntent = null;
    state.startReturnScreen = null;
    startTraining(intent.session);
    return true;
  }
  if (intent && intent.type === 'startFixedPlan' && intent.planId) {
    logNav('Launching fixed plan', intent.planId);
    state.pendingIntent = null;
    state.startReturnScreen = null;
    prepareFixedPlanFlow(intent.planId, intent.sourceSession);
    return true;
  }
  return false;
}

function tryLaunchPreparedTraining() {
  if (!state.pendingIntent) {
    logNav('No pending intent to launch');
    return false;
  }
  if (!hasEffectiveConnection()) {
    logNav('Pending intent blocked: device not connected');
    return false;
  }
  logNav('Launching intent now');
  return launchPreparedTraining();
}

if (typeof window !== 'undefined') {
  window.updateConnectUi = updateConnectUi;
  window.showConnectScreen = switchToConnect;
}

function loadPersistedAutoForwardSettings() {
  // Measurement
  const persistedMeasurement = localStorage.getItem("isotrainer:autoForwardMeasurement");
  if (persistedMeasurement !== null) {
    state.autoForwardMeasurement = persistedMeasurement === "true";
  }
  const measurementToggle = document.getElementById("autoForwardMeasurementToggle");
  if (measurementToggle) {
    measurementToggle.checked = !!state.autoForwardMeasurement;
    measurementToggle.addEventListener("change", function () {
      state.autoForwardMeasurement = !!measurementToggle.checked;
      localStorage.setItem("isotrainer:autoForwardMeasurement", state.autoForwardMeasurement ? "true" : "false");
    });
  }
  // Prestart
  const persistedPrestart = localStorage.getItem("isotrainer:autoForwardPrestart");
  if (persistedPrestart !== null) {
    state.autoForwardPrestart = persistedPrestart === "true";
  }
  const prestartToggle = document.getElementById("autoForwardPrestartToggle");
  if (prestartToggle) {
    prestartToggle.checked = !!state.autoForwardPrestart;
    prestartToggle.addEventListener("change", function () {
      state.autoForwardPrestart = !!prestartToggle.checked;
      localStorage.setItem("isotrainer:autoForwardPrestart", state.autoForwardPrestart ? "true" : "false");
    });
  }
}

// Boot: initialize charts and early UI preferences.
window.addEventListener("load", async () => {
  setupCharts();
  // Apply persisted UI contrast preference early.
  try {
    applyContrastToDocument(isContrastOn());
  } catch { }
  await checkBluetoothSupport();
  try {
    ensureDevMockConnection();
  } catch { }
  try {
    bindHomeNav();
  } catch { }
  try {
    applyPlotSettingsToDom();
  } catch { }
  try {
    updateConnectUi();
  } catch { }
  // Load auto-forward settings after DOM is ready
  try {
    loadPersistedAutoForwardSettings();
  } catch { }
  // Decide initial screen (profile selection or home)
  try {
    decideInitialScreen();
  } catch {
    try {
      showScreen('home');
    } catch { }
  }
});

function decideInitialScreen() {
  const profiles = getPlanProfiles();
  let activeId = getActiveProfileId();
  const hasProfiles = profiles.length > 0;
  const activeIsValid =
    activeId && profiles.some((p) => p.id === activeId);
  if (!activeIsValid && hasProfiles) {
    activeId = setActiveProfileId(profiles[0].id);
  }
  const shouldShowSelector =
    (!hasProfiles && isProfileSelectionRequired()) ||
    (profiles.length > 1 && isProfileSelectionRequired());
  if (shouldShowSelector) {
    openProfileSelectionScreen();
    return;
  }
  showScreen('home');
}

// Event wiring: connect/disconnect and navigation.
document.getElementById("connectButton").addEventListener("click", async () => {
  if (await checkBluetoothSupport()) await connectToDevice();
});
document.getElementById("disconnectButton").addEventListener("click", () => {
  cancelActiveSession();
  disconnectFromDevice();
  switchToConnect();
});
document.getElementById("connectBackBtn")?.addEventListener("click", () => {
  try {
    // Cancel any pending start and return to origin (editor if available).
    state.pendingIntent = null;
    const dest = state.startReturnScreen;
    state.startReturnScreen = null;
    if (dest === "editPlan") {
      showScreen("editPlan");
      return;
    }
    if (dest === "plan") {
      showScreen("plan");
      return;
    }
  } catch { }
  showScreen("home");
});
document.getElementById("goToPlanButton").addEventListener("click", () => {
  logNav('Go button pressed', {
    hasIntent: Boolean(state.pendingIntent),
    startReturn: state.startReturnScreen,
    effectiveConnection: hasEffectiveConnection(),
  });
  const hadIntent = Boolean(state.pendingIntent);
  if (tryLaunchPreparedTraining()) return;
  if (hadIntent) {
    // Still waiting on a connection; keep user on Connect and refresh UI state.
    updateConnectUi();
    const status = document.getElementById('status');
    if (status && !hasEffectiveConnection())
      status.textContent = 'Conecte um dinamômetro TeraForce para iniciar a sessão.';
    return;
  }
  const dest = state.startReturnScreen;
  state.startReturnScreen = null;
  if (dest === 'editPlan') {
    showScreen('editPlan');
    return;
  }
  if (dest === 'plan') {
    showScreen('plan');
    return;
  }
  showScreen('home');
});
document
  .getElementById("backToConnect")
  .addEventListener("click", () => showScreen("home"));
document.getElementById("loadCsvBtn").addEventListener("click", () => {
  logNav('loadCsvBtn clicked');
  const text = document.getElementById("csvInput").value;
  const err = document.getElementById("csvError");
  err.classList.add("hidden");
  try {
    const session = parseTrainingCsv(text);
    loadPlanForEdit(session, "plan");
  } catch (e) {
    err.textContent = e.message || String(e);
    err.classList.remove("hidden");
  }
});
document
  .getElementById("nextStageBtn")
  .addEventListener("click", () => nextStage());
document
  .getElementById("prevStageBtn")
  .addEventListener("click", () => prevStage());
document
  .getElementById("backButton")
  .addEventListener("click", () => {
    cancelActiveSession();
    showScreen("home");
  });

// Import a finished session (CSV) from Home.
const importBtn = document.getElementById("homeImportSessionBtn");
const importInput = document.getElementById("homeImportSessionInput");
importBtn?.addEventListener("click", () => importInput?.click());
importInput?.addEventListener("change", (e) => {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      loadCompletedSessionFromExportCsv(String(reader.result || ""));
    } catch (err) {
      alert("Falha ao importar sessão: " + (err?.message || String(err)));
    }
  };
  reader.onerror = () => alert("Não foi possível ler o arquivo CSV.");
  reader.readAsText(f);
});

function switchToConnect() {
  logNav('Switching to connect screen');
  updateConnectUi();
  showScreen("connect");
}

// Modal: training controls.
const modal = document.getElementById("controlsModal"),
  openBtn = document.getElementById("openControls");
const closeBtn = document.getElementById("closeControls"),
  closeBtn2 = document.getElementById("closeControls2");
let lastFocused = null;
function trapTab(e) {
  if (e.key !== "Tab") return;
  const f = modal.querySelectorAll(
    'button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])',
  );
  if (!f.length) return;
  const first = f[0],
    last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}
function openModal() {
  lastFocused = document.activeElement;
  modal.classList.remove("hidden");
  document.getElementById("prevStageBtn").focus();
  document.addEventListener("keydown", trapTab);
}
function closeModal() {
  modal.classList.add("hidden");
  if (lastFocused) lastFocused.focus();
  document.removeEventListener("keydown", trapTab);
}
openBtn.addEventListener("click", openModal);
closeBtn.addEventListener("click", closeModal);
modal.addEventListener("click", (e) => {
  if (e.target === modal) closeModal();
});

// Play/pause toggle.
const playPauseBtn = document.getElementById("playPauseBtn");
playPauseBtn.addEventListener("click", () => {
  if (!state.trainingSession) return;
  state.paused ? resumeTraining() : pauseTraining();
});

// Tick the session loop.
window.addEventListener("session:tick", () => tick());

// Handle BLE disconnect from other modules.
window.addEventListener("ble:disconnected", () => {
  logNav('BLE disconnected');
  cancelActiveSession();
  switchToConnect();
});
window.addEventListener('ble:connected', () => {
  logNav('BLE connected event');
  updateConnectUi();
});

// Start a session from CSV text (used by QR and button flows).
export function startTrainingFromCsvText(text) {
  const err = document.getElementById("csvError");
  err.classList.add("hidden");
  if (!hasEffectiveConnection()) {
    err.textContent = "Conecte um dispositivo primeiro.";
    err.classList.remove("hidden");
    return;
  }
  try {
    const session = parseTrainingCsv(text);
    startTraining(session);
  } catch (e) {
    err.textContent = e.message || String(e);
    err.classList.remove("hidden");
  }
}

// Completion screen actions.
document.getElementById("completeBackBtn")?.addEventListener("click", () => {
  cancelActiveSession();
  showScreen("home");
});
document.getElementById("completePlanBtn")?.addEventListener("click", () => {
  cancelActiveSession();
  showScreen("plan");
});
document.getElementById("completeExportBtn")?.addEventListener("click", () => {
  exportSessionCsv();
});
document
  .getElementById("completeMinimizeIcon")
  ?.addEventListener("click", () => {
    const modal = document.getElementById("completeScreen");
    if (modal) modal.classList.add("hidden");
    const fab = document.getElementById("completeRestoreFab");
    if (fab) fab.classList.remove("hidden");
  });

document.getElementById("completeRestoreFab")?.addEventListener("click", () => {
  const modal = document.getElementById("completeScreen");
  const fab = document.getElementById("completeRestoreFab");
  if (modal) modal.classList.remove("hidden");
  if (fab) fab.classList.add("hidden");
});

// Do not auto-navigate on connect; user advances with Next on Connect.

// Expose state and smoothing functions for settings menu persistence
window.state = state;
try {
  const { applyTrendSmoothingSetting, refreshStageSeriesForSmoothing, plotStageSliceByIndex } = await import('./charts.js');
  window.applyTrendSmoothingSetting = applyTrendSmoothingSetting;
  window.refreshStageSeriesForSmoothing = refreshStageSeriesForSmoothing;
  window.plotStageSliceByIndex = plotStageSliceByIndex;
} catch { }
