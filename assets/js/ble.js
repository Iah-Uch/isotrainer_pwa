// Module: Adapter for isotrainer to use TeraForce class
// Provides backward-compatible API while using the clean TeraForce implementation

import { TeraForce } from './tera-force.js';
import { BluetoothUtil } from './bluetooth.js';
import { startForceStreaming, startDevSampleLoop } from './ble-integration.js';
import { state, DEV_BYPASS_CONNECT } from './state.js';

export async function checkBluetoothSupport() {
    try {
        await BluetoothUtil.isBluetoothAvailable();
    const connectBtn = document.getElementById('connectButton');
    if (connectBtn) connectBtn.disabled = false;
    return true;
    } catch (err) {
        const status = document.getElementById('status');
        if (status) {
            status.textContent = err.message || 'Web Bluetooth indisponível.';
        }
        const connectBtn = document.getElementById('connectButton');
        if (connectBtn) connectBtn.disabled = true;
    return false;
    }
}

export async function connectToDevice() {
  if (!(await checkBluetoothSupport())) return;

    try {
        const status = document.getElementById('status');
        const spinner = document.getElementById('statusSpinner');
        const connectBtn = document.getElementById('connectButton');
        const disconnectBtn = document.getElementById('disconnectButton');
        const goBtn = document.getElementById('goToPlanButton');

        if (spinner) spinner.classList.remove('hidden');
        if (status) status.textContent = 'Abrindo seletor de dispositivo...';
        if (connectBtn) connectBtn.disabled = true;

        const tf = TeraForce.getInstance();
        
        // Pair with device
        await tf.pair();
        
        // Mark that a connection attempt was made
        state.connectionAttempted = true;
        
        if (status) status.textContent = 'Conectando ao TeraForce...';
        
        // Connect and get device info
        const { batteryLevel, macAddress, firmwareVersion, hardwareVersion } = await tf.connect({
            onConnectionLost: () => {
                console.log('Conexão com TeraForce perdida.');
                // Clear state
                state.device = null;
                state.server = null;
                state.deviceInfo = null;
                // Hide device info and spinner on connection loss
                updateDeviceInfoDisplay(false);
                const spinner = document.getElementById('statusSpinner');
                if (spinner) spinner.classList.add('hidden');
                try {
                    window.dispatchEvent(new CustomEvent('ble:disconnected'));
                } catch { }
            }
        });

        // Log device information
        console.log('TeraForce conectado:');
        console.log('  Bateria:', batteryLevel ? `${batteryLevel}%` : 'N/A');
        console.log('  MAC:', macAddress || 'N/A');
        console.log('  Firmware:', firmwareVersion || 'N/A');
        console.log('  Hardware:', hardwareVersion || 'N/A');

        // Store device info in state
        state.deviceInfo = {
            batteryLevel,
            macAddress,
            firmwareVersion,
            hardwareVersion
        };

        // Update state for backward compatibility with UI checks
        state.device = {
            name: 'TeraForce',
            gatt: {
                connected: true
            }
        };
        state.server = { connected: true };
        
        // Update device info UI
        updateDeviceInfoDisplay(true);

        // Auto-setup based on hardware version
        if (status) status.textContent = 'Configurando...';
        await tf.setup();
        
        if (status) status.textContent = 'Calibrando...';
        
        // Auto-calibrate
        await tf.startCalibration();
        
        if (status) status.textContent = 'Iniciando medição...';
        
        // Start force streaming with isotrainer integration
        await startForceStreaming();

        if (spinner) spinner.classList.add('hidden');
        if (status) {
            status.textContent = `Conectado a TeraForce`;
        }
        if (disconnectBtn) disconnectBtn.disabled = false;
        if (goBtn) goBtn.disabled = false;

  try {
    window.updateConnectUi?.();
  } catch { }

      try {
        window.dispatchEvent(new CustomEvent('ble:connected'));
      } catch { }
    } catch (err) {
        const msg = err?.message || String(err);
        const status = document.getElementById('status');
        const spinner = document.getElementById('statusSpinner');
        
        if (spinner) spinner.classList.add('hidden');
        if (status) status.textContent = `Erro: ${msg}`;
        
        // Clear state on error
        state.device = null;
        state.server = null;
        
  const connectBtn = document.getElementById('connectButton');
        if (connectBtn) connectBtn.disabled = false;
  const disconnectBtn = document.getElementById('disconnectButton');
        if (disconnectBtn) disconnectBtn.disabled = true;
  const goBtn = document.getElementById('goToPlanButton');
        if (goBtn) goBtn.disabled = true;

  try {
    window.updateConnectUi?.();
    } catch { }
  }
}

export function disconnectFromDevice() {
    const tf = TeraForce.getInstance();
    tf.disconnect().then(() => {
        // Clear state
  state.device = null;
  state.server = null;
  state.deviceInfo = null;

  const status = document.getElementById('status');
  const spinner = document.getElementById('statusSpinner');
        if (spinner) spinner.classList.add('hidden');
        if (status) status.textContent = 'Desconectado! Tente novamente.';
        
  const connectBtn = document.getElementById('connectButton');
  if (connectBtn) connectBtn.disabled = false;
  const disconnectBtn = document.getElementById('disconnectButton');
  if (disconnectBtn) disconnectBtn.disabled = true;
        const goBtn = document.getElementById('goToPlanButton');
        if (goBtn) goBtn.disabled = true;
        
  // Hide device info
  updateDeviceInfoDisplay(false);
        
  try {
    window.updateConnectUi?.();
  } catch { }
        
  try {
    window.dispatchEvent(new CustomEvent('ble:disconnected'));
  } catch { }
    });
}

export function ensureDevMockConnection() {
    if (!DEV_BYPASS_CONNECT) return;
    
    // Create a mock device for development
    state.device = {
        __mock: true,
        gatt: {
            connected: true
        }
    };
    
    console.log('[DEV] Mock connection enabled');
    
    // Start generating mock force data
    startDevSampleLoop();
}

function updateDeviceInfoDisplay(show = false) {
    const deviceInfo = document.getElementById('deviceInfo');
    if (!deviceInfo) return;
    
    if (show && state.deviceInfo) {
        const batteryEl = document.getElementById('deviceBattery');
        const firmwareEl = document.getElementById('deviceFirmware');
        const hardwareEl = document.getElementById('deviceHardware');
        
        if (batteryEl) {
            batteryEl.textContent = state.deviceInfo.batteryLevel 
                ? `Bateria ${state.deviceInfo.batteryLevel}%` 
                : 'Bateria —';
        }
        if (firmwareEl) {
            firmwareEl.textContent = state.deviceInfo.firmwareVersion 
                ? `FW ${state.deviceInfo.firmwareVersion}` 
                : 'FW —';
        }
        if (hardwareEl) {
            hardwareEl.textContent = state.deviceInfo.hardwareVersion 
                ? `HW ${state.deviceInfo.hardwareVersion}` 
                : 'HW —';
        }
        
        deviceInfo.classList.remove('hidden');
    } else {
        deviceInfo.classList.add('hidden');
    }
}

// Export TeraForce class and integration for direct usage
export { TeraForce };
export { startForceStreaming };
