// Module: Web Bluetooth connection and streaming for TeraForce dynamometers.
import { state, DEV_OPTIONS } from './state.js';
import { now } from "./utils.js";
import { updateStageChart, updateSessionChart } from "./charts.js";
import {
  updateStageUI,
  updateLiveStageInTargetPct,
  processMeasurementSample,
} from './session.js';

// Known service/characteristic pairs observed on TeraForce firmwares.
// We request all candidates so Chrome grants access whichever the device exposes.
const SERVICE_CANDIDATES = [
  // Latest generations (custom 128-bit UUIDs beginning with fc52…).
  "fc52fca0-55f8-4501-afd1-f32e33e8668d",
  "fc52fca1-55f8-4501-afd1-f32e33e8668d",
  "fc52fca2-55f8-4501-afd1-f32e33e8668d",
  // Legacy 16-bit services (mapped into 128-bit space).
  "0000fca0-0000-1000-8000-00805f9b34fb",
  "0000fca1-0000-1000-8000-00805f9b34fb",
  "0000fca2-0000-1000-8000-00805f9b34fb",
  // Nordic UART fallbacks that some engineering builds used.
  "6e400001-b5a3-f393-e0a9-e50e24dcca9e",
  // Texas Instruments CC26xx profiles (firmware updater variants).
  "f000ffc0-0451-4000-b000-000000000000",
  "f000ffc1-0451-4000-b000-000000000000",
  "f000ffc2-0451-4000-b000-000000000000",
];
const NOTIFY_CHARACTERISTIC_HINTS = [
  "fc52fca2-55f8-4501-afd1-f32e33e8668d",
  "0000fca2-0000-1000-8000-00805f9b34fb",
  "6e400003-b5a3-f393-e0a9-e50e24dcca9e",
  "0000ffb2-0000-1000-8000-00805f9b34fb",
  "0000ffd4-0000-1000-8000-00805f9b34fb",
  "0000ffe1-0000-1000-8000-00805f9b34fb",
  "0000fff1-0000-1000-8000-00805f9b34fb",
  "f000ffc2-0451-4000-b000-000000000000",
];
const WRITE_CHARACTERISTIC_HINTS = [
  "fc52fca1-55f8-4501-afd1-f32e33e8668d",
  "0000fca1-0000-1000-8000-00805f9b34fb",
  "6e400002-b5a3-f393-e0a9-e50e24dcca9e",
  "0000ffb1-0000-1000-8000-00805f9b34fb",
  "0000ffd1-0000-1000-8000-00805f9b34fb",
  "f000ffc1-0451-4000-b000-000000000000",
];

const OPTIONAL_SUPPORT_SERVICES = [
  ...SERVICE_CANDIDATES,
  "0000180f-0000-1000-8000-00805f9b34fb", // Battery Service
  "0000180a-0000-1000-8000-00805f9b34fb", // Device Information
];

let lastGattSnapshot = [];
const DEV_SAMPLE_INTERVAL_MS = 900;
let devSampleTimer = null;
let devSamplePhase = 0;

function devBypassEnabled() {
  return !!DEV_OPTIONS?.bypassConnectScreen;
}

export function ensureDevMockConnection() {
  if (!devBypassEnabled()) return;
  simulateDevConnection(true);
}

export async function checkBluetoothSupport() {
  if (devBypassEnabled()) {
    simulateDevConnection(true);
    const status = document.getElementById('status');
    if (status)
      status.textContent = 'Modo desenvolvedor: conexão simulada, hardware opcional.';
    const connectBtn = document.getElementById('connectButton');
    if (connectBtn) connectBtn.disabled = false;
    return true;
  }
  if (!navigator.bluetooth) {
    document.getElementById("status").textContent =
      "Web Bluetooth indisponível. Use HTTPS/localhost e conceda permissões.";
    document.getElementById("connectButton").disabled = true;
    return false;
  }
  try {
    if (typeof navigator.bluetooth.getAvailability === "function") {
      const available = await navigator.bluetooth.getAvailability();
      if (!available) {
        document.getElementById("status").textContent =
          "Adaptador Bluetooth possivelmente indisponível. Ainda é possível tentar conectar.";
      }
    }
  } catch {
    document.getElementById("status").textContent =
      "Não foi possível verificar disponibilidade do Bluetooth. Tente conectar.";
  }
  document.getElementById("connectButton").disabled = false;
  return true;
}

export async function connectToDevice() {
  if (devBypassEnabled()) {
    simulateDevConnection();
    return;
  }
  if (!(await checkBluetoothSupport())) return;
  try {
    document.getElementById("status").textContent =
      "Abrindo seletor de dispositivo...";
    document.getElementById("connectButton").disabled = true;

    const optionalServices = Array.from(new Set(OPTIONAL_SUPPORT_SERVICES));
    const serviceFilterUuids = optionalServices.filter(
      (svc) => typeof svc === "number",
    );
    const filters = [{ namePrefix: "Tera" }, { namePrefix: "TF" }];
    if (serviceFilterUuids.length)
      filters.push({ services: serviceFilterUuids });
    try {
      state.device = await navigator.bluetooth.requestDevice({
        filters,
        optionalServices,
        acceptAllDevices: false,
      });
    } catch (err) {
      if (err?.name === "NotFoundError") {
        document.getElementById("status").textContent =
          "Nenhum dispositivo selecionado.";
        restoreButtons();
        return;
      }
      document.getElementById("status").textContent =
        "Lista completa, aguarde...";
      state.device = await navigator.bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices,
      });
    }

    document.getElementById("status").textContent =
      "Conectando ao TeraForce...";
    state.server = await state.device.gatt.connect();
    const { service, characteristic, command } =
      await resolveMeasurementCharacteristic(state.server);
    if (!service || !characteristic) {
      const snapshot = logGattSnapshot();
      const summary = snapshot
        .map((entry) => {
          const chars = entry.characteristics
            ?.map((c) => `${c.uuid}${c.properties?.length ? `(${c.properties.join(',')})` : ""}`)
            .join(", ") || "";
          if (entry.error) return `${entry.uuid || "(desconhecido)"} ✖ ${entry.error}`;
          return chars
            ? `${entry.uuid || "(desconhecido)"} → ${chars}`
            : `${entry.uuid || "(desconhecido)"}`;
        })
        .filter(Boolean)
        .join(" | ");
      const hint = summary
        ? ` Serviços acessíveis: ${summary}. Veja o console para detalhes.`
        : "";
      throw new Error(
        `Não foi possível localizar a característica de força.${hint}`,
      );
    }
    state.service = service;
    state.characteristic = characteristic;
    state.commandCharacteristic = command || null;

    await state.characteristic.startNotifications();
    state.characteristic.addEventListener("characteristicvaluechanged", (event) =>
      handleForceMeasurement(event.target.value),
    );

    resetForceCalibration();
    await startStreaming();

    document.getElementById("status").textContent =
      `Conectado a ${state.device.name || "TeraForce"}`;
    document.getElementById("disconnectButton").disabled = false;
    document.getElementById("goToPlanButton").disabled = false;
    addDisconnectListener();
    try {
      window.updateConnectUi?.();
    } catch { }
    try {
      window.dispatchEvent(new CustomEvent("ble:connected"));
    } catch { }
  } catch (err) {
    const msg = err?.message || String(err);
    document.getElementById("status").textContent = `Erro: ${msg}`;
    restoreButtons();
  }
}

function restoreButtons() {
  document.getElementById("connectButton").disabled = false;
  document.getElementById("disconnectButton").disabled = true;
  document.getElementById("goToPlanButton").disabled = true;
  state.commandCharacteristic = null;
  resetForceCalibration();
  try {
    window.updateConnectUi?.();
  } catch { }
}

export function disconnectFromDevice() {
  if (devBypassEnabled()) {
    simulateDevDisconnect();
    return;
  }
  if (state.device && state.device.gatt.connected) {
    stopStreaming().catch(() => { });
    state.device.gatt.disconnect();
  }
  state.commandCharacteristic = null;
  resetForceCalibration();
}

function simulateDevConnection(initial = false) {
  if (!devBypassEnabled()) return;
  if (state.device?.__mock && state.device?.gatt?.connected) {
    startDevSampleLoop();
    if (!initial) {
      try {
        window.dispatchEvent(new CustomEvent('ble:connected'));
      } catch { }
    }
    return;
  }

  const mockGatt = {
    connected: true,
    disconnect: () => simulateDevDisconnect(),
    connect: async () => mockGatt,
  };

  state.device = {
    name: 'TeraForce (Simulado)',
    gatt: mockGatt,
    __mock: true,
    addEventListener() { },
    removeEventListener() { },
  };
  state.server = mockGatt;
  state.service = null;
  state.characteristic = null;
  state.commandCharacteristic = null;
  state.forceCalibration.zero = 0;
  state.forceCalibration.samples = [];
  state.forceCalibration.multiplier = 1;

  const status = document.getElementById('status');
  if (status) status.textContent = 'Conectado (modo simulação)';
  const connectBtn = document.getElementById('connectButton');
  if (connectBtn) connectBtn.disabled = true;
  const disconnectBtn = document.getElementById('disconnectButton');
  if (disconnectBtn) disconnectBtn.disabled = false;
  const goBtn = document.getElementById('goToPlanButton');
  if (goBtn) goBtn.disabled = false;

  startDevSampleLoop();
  try {
    window.updateConnectUi?.();
  } catch { }
  if (!initial) {
    try {
      window.dispatchEvent(new CustomEvent('ble:connected'));
    } catch { }
  }
}

function simulateDevDisconnect() {
  if (!state.device?.__mock) return;
  stopDevSampleLoop();
  devSamplePhase = 0;
  if (state.device?.gatt) state.device.gatt.connected = false;
  state.device = null;
  state.server = null;
  state.service = null;
  state.characteristic = null;
  state.commandCharacteristic = null;
  state.forceCalibration.zero = 0;
  state.forceCalibration.samples = [];
  state.forceCalibration.multiplier = 1;

  const status = document.getElementById('status');
  if (status) status.textContent = 'Desconectado (modo simulação)';
  const connectBtn = document.getElementById('connectButton');
  if (connectBtn) connectBtn.disabled = false;
  const disconnectBtn = document.getElementById('disconnectButton');
  if (disconnectBtn) disconnectBtn.disabled = true;
  try {
    window.updateConnectUi?.();
  } catch { }
  try {
    window.dispatchEvent(new CustomEvent('ble:disconnected'));
  } catch { }
}

function startDevSampleLoop() {
  if (devSampleTimer) return;
  emitDevSample();
  devSampleTimer = setInterval(() => emitDevSample(), DEV_SAMPLE_INTERVAL_MS);
}

function stopDevSampleLoop() {
  if (devSampleTimer) {
    clearInterval(devSampleTimer);
    devSampleTimer = null;
  }
}

function emitDevSample() {
  if (!state.device?.__mock) return;
  devSamplePhase += 0.4;
  const base = 180 + Math.sin(devSamplePhase) * 60;
  const noise = (Math.random() - 0.5) * 15;
  const sample = Math.max(0, base + noise);
  const buffer = new ArrayBuffer(2);
  const view = new DataView(buffer);
  view.setInt16(0, Math.round(sample), false);
  handleForceMeasurement(view);
}

function handleDisconnect() {
  stopStreaming().catch(() => { });
  state.commandCharacteristic = null;
  resetForceCalibration();
  const ev = new CustomEvent("ble:disconnected");
  window.dispatchEvent(ev);
}

function addDisconnectListener() {
  if (!state.device || typeof state.device.addEventListener !== 'function') return;
  state.device.addEventListener("gattserverdisconnected", handleDisconnect, {
    once: true,
  });
}

async function resolveMeasurementCharacteristic(server) {
  lastGattSnapshot = [];

  for (const uuid of SERVICE_CANDIDATES) {
    const detail = await inspectServiceByUuid(server, uuid);
    if (detail) return detail;
  }

  try {
    const services = await server.getPrimaryServices();
    for (const service of services) {
      const detail = await inspectExistingService(service);
      if (detail) return detail;
    }
  } catch (err) {
    lastGattSnapshot.push({ uuid: "getPrimaryServices", error: err?.message || String(err) });
  }

  return { service: null, characteristic: null, command: null };
}

async function inspectServiceByUuid(server, uuid) {
  try {
    const service = await server.getPrimaryService(uuid);
    return await inspectExistingService(service);
  } catch (err) {
    lastGattSnapshot.push({ uuid, error: err?.message || String(err) });
    return null;
  }
}

async function inspectExistingService(service) {
  if (!service) return null;
  let notifyCandidate = null;
  let writeCandidate = null;
  const info = {
    uuid: service.uuid,
    characteristics: [],
    matched: null,
    command: null,
  };
  try {
    const chars = await service.getCharacteristics();
    for (const characteristic of chars) {
      const props = Object.entries(characteristic.properties || {})
        .filter(([, enabled]) => Boolean(enabled))
        .map(([key]) => key);
      info.characteristics.push({ uuid: characteristic.uuid, properties: props });
      if (!notifyCandidate) {
        const isHint = NOTIFY_CHARACTERISTIC_HINTS.includes(characteristic.uuid);
        if (isHint || characteristic.properties?.notify || characteristic.properties?.indicate) {
          notifyCandidate = characteristic;
          info.matched = characteristic.uuid;
        }
      }
      if (!writeCandidate) {
        const isCommand = WRITE_CHARACTERISTIC_HINTS.includes(characteristic.uuid);
        if (isCommand || characteristic.properties?.write || characteristic.properties?.writeWithoutResponse) {
          writeCandidate = characteristic;
          info.command = characteristic.uuid;
        }
      }
    }
  } catch (err) {
    info.error = err?.message || String(err);
  }
  lastGattSnapshot.push(info);
  if (notifyCandidate)
    return { service, characteristic: notifyCandidate, command: writeCandidate ?? null };
  return null;
}

function logGattSnapshot() {
  if (!lastGattSnapshot.length) return [];
  try {
    console.groupCollapsed("TeraForce BLE serviços detectados");
    for (const entry of lastGattSnapshot) {
      if (entry.error) {
        console.warn(entry.uuid, "erro:", entry.error);
        continue;
      }
      console.group(entry.uuid || "(uuid desconhecido)");
      entry.characteristics?.forEach((char) => {
        console.info(
          char.uuid,
          Array.isArray(char.properties) && char.properties.length
            ? `props: ${char.properties.join(", ")}`
            : "props: —",
          entry.matched === char.uuid ? "← notify" : "",
          entry.command === char.uuid ? "(cmd)" : "",
        );
      });
      console.groupEnd();
    }
    console.groupEnd();
  } catch { }
  return lastGattSnapshot;
}

function clampStage(force) {
  if (state.trainingSession && state.stageIdx >= 0) {
    const { lower, upper } = state.trainingSession.stages[state.stageIdx];
    const lo = lower - 10;
    const hi = upper + 10;
    if (force < lo) return lo;
    if (force > hi) return hi;
  }
  return force;
}

function clampSession(force) {
  if (!state.trainingSession || !state.trainingSession.sessionBounds) return force;
  const { min, max } = state.trainingSession.sessionBounds;
  if (force < min) return min;
  if (force > max) return max;
  return force;
}

function handleForceMeasurement(value) {
  const dv = value instanceof DataView ? value : new DataView(value.buffer);
  const samples = decodeForceSamples(dv);
  if (!samples.length) return;

  for (const force of samples) {
    if (!Number.isFinite(force)) continue;

    try {
      processMeasurementSample(force);
    } catch { }

    if (state.waitingForFirstSample && Math.abs(force) > 0.1) {
      state.waitingForFirstSample = false;
      state.sessionStartMs = now();
      state.stageStartMs = now();
      updateStageUI();
      state.timerHandle = setInterval(
        () => window.dispatchEvent(new CustomEvent("session:tick")),
        200,
      );
    }
    if (state.paused) break;

    const currentForceValue = document.getElementById("currentForceValue");
    if (currentForceValue) currentForceValue.textContent = formatForce(force);

    const marker = document.getElementById("forceMarker");
    if (marker) {
      const normalized = Math.max(1, Math.abs(force));
      const period = Math.max(0.4, Math.min(2.5, 8 / normalized));
      marker.style.setProperty("--pulse-period", `${period.toFixed(2)}s`);
    }

    const currentTime = now();
    updateStageChart(clampStage(force), currentTime);
    updateSessionChart(clampSession(force), currentTime);
    try {
      updateLiveStageInTargetPct();
    } catch { }

  }
}

const DEFAULT_MULTIPLIER_FIRMWARE_1 = (8.65 / 235) * 9.80665; // N per ADC delta
const DEFAULT_MULTIPLIER_FIRMWARE_2 = (45 / 3800) * 9.80665;

function resetForceCalibration() {
  state.forceCalibration.zero = null;
  state.forceCalibration.samples = [];
  state.forceCalibration.multiplier = null;
}

function deriveMultiplier() {
  if (state.forceCalibration.multiplier) return state.forceCalibration.multiplier;
  if (state.service?.uuid?.startsWith("fc52")) {
    state.forceCalibration.multiplier = DEFAULT_MULTIPLIER_FIRMWARE_2;
  } else {
    state.forceCalibration.multiplier = DEFAULT_MULTIPLIER_FIRMWARE_1;
  }
  return state.forceCalibration.multiplier;
}

function applyCalibration(rawSample) {
  const cal = state.forceCalibration;
  if (!Number.isFinite(rawSample)) return NaN;

  if (cal.zero === null) {
    cal.samples.push(rawSample);
    if (cal.samples.length >= 80) {
      const sorted = [...cal.samples].sort((a, b) => a - b);
      const middle = sorted.slice(20, sorted.length - 20);
      cal.zero = middle.reduce((acc, v) => acc + v, 0) / middle.length;
      cal.samples = [];
    }
    return 0;
  }

  const multiplier = deriveMultiplier();
  let force = (rawSample - cal.zero) * multiplier;
  if (!Number.isFinite(force)) force = 0;
  return force;
}

function decodeForceSamples(dataView) {
  if (!dataView || dataView.byteLength < 2) return [];
  const result = [];
  for (let offset = 0; offset + 1 < dataView.byteLength; offset += 2) {
    let raw;
    try {
      raw = dataView.getInt16(offset, false);
    } catch {
      continue;
    }
    const calibrated = applyCalibration(raw);
    result.push(calibrated);
  }
  return result;
}

async function sendCommand(bytes) {
  const characteristic = state.commandCharacteristic;
  if (!characteristic || !bytes) return;
  try {
    if (typeof characteristic.writeValueWithoutResponse === "function")
      await characteristic.writeValueWithoutResponse(bytes);
    else if (typeof characteristic.writeValue === "function")
      await characteristic.writeValue(bytes);
  } catch (err) {
    console.warn("Falha ao enviar comando para o TeraForce:", err?.message || err);
  }
}

async function startStreaming() {
  await sendCommand(new Uint8Array([1]));
}

async function stopStreaming() {
  await sendCommand(new Uint8Array([0]));
}

function formatForce(value, { withUnit = false } = {}) {
  if (!Number.isFinite(value)) return "—";
  const formatted = value.toFixed(1);
  return withUnit ? `${formatted} N` : formatted;
}
