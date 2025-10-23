// Module: Integration layer between TeraForce and isotrainer session system

import { TeraForce } from './tera-force.js';
import { now } from './utils.js';
import { updateStageChart, updateSessionChart } from './charts.js';
import {
  updateStageUI,
  updateLiveStageInTargetPct,
  processMeasurementSample,
} from './session.js';
import { state } from './state.js';

/**
 * Start force streaming for isotrainer sessions
 */
export async function startForceStreaming() {
    const tf = TeraForce.getInstance();
    
    if (tf.status !== TeraForce.STATUS_READY) {
        throw new Error('TeraForce não está pronto. Status atual: ' + tf.status);
    }

    console.log('startForceStreaming: iniciando streaming contínuo');

    // Start continuous streaming with isotrainer integration
    await tf.startContinuousStreaming({
        onValue: (force) => {
            handleForceValue(force);
        }
    });
    
    console.log('startForceStreaming: streaming iniciado');
}

/**
 * Handle individual force values and route to isotrainer systems
 */
function handleForceValue(force) {
    if (!Number.isFinite(force)) {
        console.warn('Força inválida recebida:', force);
        return;
    }
    
    // Log first few samples for debugging
    if (!handleForceValue._sampleCount) handleForceValue._sampleCount = 0;
    handleForceValue._sampleCount++;
    if (handleForceValue._sampleCount <= 5) {
        console.log(`Amostra de força #${handleForceValue._sampleCount}:`, force, 'kgf');
    }

    try {
        // Route force sample to prestart modal if active, else to measurement
        if (
            typeof window.onPreStartForceSample === 'function' &&
            document.getElementById('preStartModal') &&
            !document.getElementById('preStartModal').classList.contains('hidden')
        ) {
            window.onPreStartForceSample(force);
        } else {
            processMeasurementSample(force);
        }
    } catch (err) {
        console.error('Erro ao processar amostra de força:', err);
    }

    // Only start timers if we're not in the prestart modal
    if (state.waitingForFirstSample && Math.abs(force) > 0.1) {
        const preStartModal = document.getElementById('preStartModal');
        const preStartActive = preStartModal && !preStartModal.classList.contains('hidden');
        
        if (!preStartActive) {
            state.waitingForFirstSample = false;
            state.sessionStartMs = now();
            state.stageStartMs = now();
            updateStageUI();
            state.timerHandle = setInterval(
                () => window.dispatchEvent(new CustomEvent('session:tick')),
                200
            );
        }
    }
    
    if (state.paused) return;

    // Update UI elements
    const currentForceValue = document.getElementById('currentForceValue');
    if (currentForceValue) {
        currentForceValue.textContent = formatForce(force);
    }

    const marker = document.getElementById('forceMarker');
    if (marker) {
        const normalized = Math.max(1, Math.abs(force));
        const period = Math.max(0.4, Math.min(2.5, 8 / normalized));
        marker.style.setProperty('--pulse-period', `${period.toFixed(2)}s`);
    }

    // Update charts
    const currentTime = now();
    updateStageChart(force, currentTime);
    updateSessionChart(force, currentTime);
    
    try {
        updateLiveStageInTargetPct();
    } catch (err) {
        console.error('Erro ao atualizar porcentagem no alvo:', err);
    }
}

function formatForce(value, { withUnit = false } = {}) {
    if (!Number.isFinite(value)) return '—';
    const rounded = value.toFixed(1);
    return withUnit ? `${rounded} kgf` : String(rounded);
}

