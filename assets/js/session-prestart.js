// Module: Prestart modal logic for IsoTrainer
import { state } from './state.js';

// DOM elements
const preStartModal = document.getElementById('preStartModal');
const preStartGoBtn = document.getElementById('preStartGoBtn');
const preStartCountdown = document.getElementById('preStartCountdown');
const preStartStageRange = document.getElementById('preStartStageRange');
const preStartForceValue = document.getElementById('preStartForceValue');
const preStartBar = document.getElementById('preStartBar');
const preStartTarget = document.getElementById('preStartTarget');
const preStartThumb = document.getElementById('preStartThumb');
const preStartScaleMin = document.getElementById('preStartScaleMin');
const preStartScaleMax = document.getElementById('preStartScaleMax');
const preStartText = document.getElementById('preStartText');

let preStartActive = false;
let preStartInRangeMs = 0;
let preStartLastForce = 0;
let preStartTimer = null;
let preStartAutoForwardTimer = null;
let preStartStage = null;

const AUTO_FORWARD_MS = 3000;

function showPreStartModal(stage) {
  preStartStage = stage;
  preStartActive = true;
  preStartInRangeMs = 0;
  preStartLastForce = 0;
  preStartGoBtn.disabled = state.autoForwardPrestart;
  preStartCountdown.classList.toggle('hidden', !state.autoForwardPrestart);
  preStartCountdown.textContent = state.autoForwardPrestart ? '3,0' : '';
  preStartStageRange.textContent = `${stage.lower}/${stage.upper}`;
  preStartForceValue.textContent = '—';

  // Calculate buffered min/max for the bar
  const range = stage.upper - stage.lower;
  const buffer = Math.max(2, Math.round(range * 0.2));
  const barMin = Math.max(0, stage.lower - buffer);
  const barMax = stage.upper + buffer;
  preStartScaleMin.textContent = barMin;
  preStartScaleMax.textContent = barMax;

  preStartText.textContent = 'Aguardando leitura de força...';
  preStartModal.classList.remove('hidden');
  // Delay updatePreStartBar until after modal is visible and has dimensions
  setTimeout(() => updatePreStartBar(0), 10);
  if (state.autoForwardPrestart) {
    preStartGoBtn.classList.add('disabled');
    startPreStartAutoForward();
  } else {
    preStartGoBtn.classList.remove('disabled');
  }
}

function hidePreStartModal() {
  preStartActive = false;
  preStartModal.classList.add('hidden');
  stopPreStartAutoForward();
}

function updatePreStartBar(force) {
  // Update bar and thumb position
  const min = Number(preStartScaleMin.textContent);
  const max = Number(preStartScaleMax.textContent);
  const lower = Number(preStartStage.lower);
  const upper = Number(preStartStage.upper);
  const barWidth = preStartBar.offsetWidth || 200;

  // Target range as a portion of the bar
  const totalRange = max - min;
  const targetStart = ((lower - min) / totalRange) * barWidth;
  const targetWidth = ((upper - lower) / totalRange) * barWidth;
  preStartTarget.style.left = `${targetStart}px`;
  preStartTarget.style.width = `${targetWidth}px`;

  // Thumb position
  const pct = Math.max(0, Math.min(1, (force - min) / (max - min)));
  const thumbPos = pct * barWidth;
  preStartThumb.style.left = `${thumbPos - preStartThumb.offsetWidth / 2}px`;
}

function onPreStartForceSample(force) {
  if (!preStartActive) return;
  preStartLastForce = force;
  preStartForceValue.textContent = `${force.toFixed(1)} kgf`;
  updatePreStartBar(force);

  // In range?
  const inRange = force >= preStartStage.lower && force <= preStartStage.upper;
  if (inRange) {
    if (state.autoForwardPrestart) {
      preStartText.textContent = 'Em faixa! Mantenha por 3s para iniciar.';
      if (!preStartTimer) {
        preStartInRangeMs = 0;
        preStartCountdown.classList.remove('hidden');
        preStartTimer = setInterval(() => {
          preStartInRangeMs += 100;
          const remaining = Math.max(0, AUTO_FORWARD_MS - preStartInRangeMs);
          preStartCountdown.textContent = (remaining / 1000).toFixed(1).replace('.', ',');
          if (preStartInRangeMs >= AUTO_FORWARD_MS) {
            clearInterval(preStartTimer);
            preStartTimer = null;
            preStartAutoAdvance();
          }
        }, 100);
      }
    } else {
      preStartText.textContent = 'Em faixa! Pronto para iniciar.';
    }
  } else {
    preStartText.textContent = 'Ajuste a força para entrar na faixa.';
    if (preStartTimer) {
      clearInterval(preStartTimer);
      preStartTimer = null;
      preStartInRangeMs = 0;
      preStartCountdown.textContent = '3,0';
    }
  }
}

function startPreStartAutoForward() {
  preStartGoBtn.disabled = true;
  preStartCountdown.classList.remove('hidden');
  preStartCountdown.textContent = '3,0';
  preStartInRangeMs = 0;
  if (preStartTimer) clearInterval(preStartTimer);
  preStartTimer = null;
}

function stopPreStartAutoForward() {
  if (preStartTimer) clearInterval(preStartTimer);
  preStartTimer = null;
  preStartInRangeMs = 0;
}

function preStartAutoAdvance() {
  hidePreStartModal();
  // Proceed to start the series/stage
  if (typeof window.onPreStartProceed === 'function') {
    window.onPreStartProceed();
  }
}

preStartGoBtn.addEventListener('click', () => {
  if (preStartActive && !state.autoForwardPrestart) {
    hidePreStartModal();
    if (typeof window.onPreStartProceed === 'function') {
      window.onPreStartProceed();
    }
  }
});

const preStartBackBtn = document.getElementById('preStartBackBtn');
if (preStartBackBtn) {
  preStartBackBtn.addEventListener('click', () => {
    if (typeof window.cancelActiveSession === 'function') {
      window.cancelActiveSession({ navigateHome: true });
    } else {
      // fallback: reload to home
      window.location.reload();
    }
  });
}

// Expose for session.js to call
window.showPreStartModal = showPreStartModal;
window.hidePreStartModal = hidePreStartModal;
window.onPreStartForceSample = onPreStartForceSample;
