// Module: Integration layer between TeraForce and isotrainer session system

import { TeraForce } from './tera-force.js';
import { now } from './utils.js';
import { updateStageChart, updateSessionChart } from './charts.js';
import {
  updateStageUI,
  updateLiveStageInTargetPct,
  processMeasurementSample,
} from './session.js';
import { state, DEV_BYPASS_CONNECT } from './state.js';

// Dev mode mock data generation
const DEV_SAMPLE_INTERVAL_MS = 300;
let devSampleTimer = null;
let devSamplePhase = 0;

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

    // Update pulse animation period on marker (visual feedback)
    const marker = document.getElementById('forceMarker');
    if (marker) {
        const normalized = Math.max(1, Math.abs(force));
        const period = Math.max(0.4, Math.min(2.5, 8 / normalized));
        marker.style.setProperty('--pulse-period', `${period.toFixed(2)}s`);
    }

    // Update charts (charts.js will also update currentForceValue with smoothed data)
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

/**
 * Start mock data generation loop for dev mode
 */
export function startDevSampleLoop() {
    if (!DEV_BYPASS_CONNECT) return;
    if (devSampleTimer) return;
    
    console.log('[DEV] Starting mock force data generation');
    emitDevSample();
    devSampleTimer = setInterval(() => emitDevSample(), DEV_SAMPLE_INTERVAL_MS);
}

/**
 * Stop mock data generation loop
 */
export function stopDevSampleLoop() {
    if (devSampleTimer) {
        clearInterval(devSampleTimer);
        devSampleTimer = null;
        console.log('[DEV] Stopped mock force data generation');
    }
}

/**
 * Emit a single mock force sample
 */
function emitDevSample() {
    if (!state.device?.__mock) return;
    
    devSamplePhase += 0.4;
    const kgf = computeMockForceKgf();
    
    // Directly call handleForceValue with kgf value
    handleForceValue(kgf);
}

/**
 * Compute realistic mock force values based on current context
 */
function computeMockForceKgf() {
    const measurement = state.measurement;
    
    // During measurement phase: generate values around expected max force
    if (measurement?.active) {
        const armMax =
            measurement.arm === 'direito'
                ? state.maxDireitoKgf
                : measurement.arm === 'esquerdo'
                    ? state.maxEsquerdoKgf
                    : null;
        const target = Number.isFinite(armMax) && armMax > 20 ? armMax : 104;
        const spread = Math.max(6, target * 0.08);
        const wobble = Math.sin(devSamplePhase) * spread;
        const noise = (Math.random() - 0.5) * spread * 0.6;
        return Math.max(0, target + wobble + noise);
    }

    // During training session: generate values within stage bounds
    const session = state.trainingSession;
    if (session?.stages?.length) {
        let idx = Number(state.stageIdx);
        if (!Number.isFinite(idx) || idx < 0 || idx >= session.stages.length) idx = 0;
        const stage = session.stages[idx];
        const lower = Number(stage?.lower);
        const upper = Number(stage?.upper);
        if (Number.isFinite(lower) && Number.isFinite(upper) && upper > lower) {
            const center = (lower + upper) / 2;
            const span = Math.max(0.5, (upper - lower) / 2);
            const wobble = Math.sin(devSamplePhase) * span * Math.random();
            const noise = (Math.random() - Math.random()) * span * Math.random();
            return Math.max(0, center + wobble + noise);
        }
    }

    // Idle/default: gentle fluctuation around baseline
    const idleBase = 25 + Math.sin(devSamplePhase) * 8;
    const idleNoise = (Math.random() - 0.5) * 5;
    return Math.max(0, idleBase + idleNoise);
}

