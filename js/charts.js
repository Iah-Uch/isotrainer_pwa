import { state } from './state.js';
import { fmtMMSS } from './utils.js';

/**
 * heartFollowerPlugin (hrChart only):
 *  - Keeps the heart marker following the last point on hrChart.
 *  - Draws ORIGINAL (non-buffered) bounds as solid white lines with labels.
 *  - When HR is out of bounds, ONLY the relevant line (upper or lower) gets a fast glow.
 */
const heartFollowerPlugin = {
  id: 'heartFollower',
  afterDatasetsDraw(ci) {
    // Only apply to the stage chart canvas
    if (ci.canvas?.id !== 'hrChart') return;

    const marker = document.getElementById('heartMarker');
    const series = state.series || [];

    // ----- Heart marker positioning -----
    if (!marker || series.length === 0) {
      if (marker) marker.style.opacity = '0';
      return;
    }

    const last = series[series.length - 1];
    const x = ci.scales.x.getPixelForValue(last.x);
    const y = ci.scales.y.getPixelForValue(last.y);
    const ca = ci.chartArea;

    marker.style.left = `${Math.min(Math.max(x, ca.left), ca.right)}px`;
    marker.style.top  = `${Math.min(Math.max(y, ca.top),  ca.bottom)}px`;
    marker.style.opacity = '1';

    // ----- Bound lines -----
    const bounds = state.currentStageBoundsOriginal; // { lo, hi } stored in setYAxis()
    if (!bounds) return;
    const lo = bounds.lo;
    const hi = bounds.hi;

    // Pixel positions for original bounds on the CURRENT y-scale (which is buffered)
    const yLo = ci.scales.y.getPixelForValue(lo);
    const yHi = ci.scales.y.getPixelForValue(hi);

    // Quick, heart-like phase
    const elapsed = performance.now() - (state.pulseAnimation?.startTime || 0);
    const phase = (Math.sin(elapsed / 160) + 1) / 2; // faster than before

    // Only glow on the relevant line
    const above = last.y > hi;
    const below = last.y < lo;

    // Draw helper: solid white line with optional glow and a small numeric label on the right
    const drawBound = (yPx, value, active) => {
      const ctx = ci.ctx;
      ctx.save();
      ctx.beginPath();
      ctx.lineWidth = active ? (2.5 + 0.8 * phase) : 2;
      ctx.setLineDash([]); // solid
      const baseAlpha = active ? 0.95 : 0.7;
      ctx.strokeStyle = `rgba(255,255,255,${baseAlpha})`;

      if (active) {
        // red-ish glow similar to the heart
        ctx.shadowColor = `rgba(239,68,68,${0.45 + 0.35 * phase})`;
        ctx.shadowBlur = 8 + 10 * phase;
      } else {
        ctx.shadowBlur = 0;
      }

      ctx.moveTo(ca.left + 4, Math.round(yPx) + 0.5);  // crisp 1px line alignment
      ctx.lineTo(ca.right - 28, Math.round(yPx) + 0.5);
      ctx.stroke();

      // Right-aligned small label
      ctx.shadowBlur = 0;
      ctx.fillStyle = `rgba(255,255,255,${Math.min(1, baseAlpha + 0.05)})`;
      ctx.font = '600 11px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Ubuntu';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(value), ca.right - 6, Math.round(yPx) + 0.5);
      ctx.restore();
    };

    drawBound(yHi, hi, above); // glow only if above upper
    drawBound(yLo, lo, below); // glow only if below lower
  }
};

/**
 * stageAnnotationsPlugin:
 *  - Shaded stage target bands for the session chart.
 */
const stageAnnotationsPlugin = {
  id: 'stageAnnotations',
  afterDraw(chartInstance) {
    const s = state;
    if (!s.trainingSession || !s.trainingSession.stages.length) return;

    const { ctx, scales: { x, y } } = chartInstance;
    ctx.save();

    const stageColors = [
      'rgba(59,130,246,0.15)',
      'rgba(34,197,94,0.15)',
      'rgba(234,179,8,0.15)',
      'rgba(249,115,22,0.15)',
      'rgba(239,68,68,0.15)'
    ];
    const highlightColors = [
      'rgba(59,130,246,0.5)',
      'rgba(34,197,94,0.5)',
      'rgba(234,179,8,0.5)',
      'rgba(249,115,22,0.5)',
      'rgba(239,68,68,0.5)'
    ];
    const highlightRgb = ['59,130,246', '34,197,94', '234,179,8', '249,115,22', '239,68,68'];

    const elapsed = performance.now() - s.pulseAnimation.startTime;
    const pulseCycle = (Math.sin(elapsed / 400) + 1) / 2;
    const glowBlur = 10 + (pulseCycle * 10);
    const glowAlpha = 0.2 + (pulseCycle * 0.3);

    let cumulativeDuration = 0;
    s.trainingSession.stages.forEach((stage, index) => {
      const isCurrentStage = (index === s.stageIdx);
      const xStart = x.getPixelForValue(cumulativeDuration);
      const xEnd = x.getPixelForValue(cumulativeDuration + stage.durationSec);
      const yStart = y.getPixelForValue(stage.upper);
      const yEnd = y.getPixelForValue(stage.lower);

      if (isCurrentStage) {
        const colorRgb = highlightRgb[index % highlightRgb.length];
        ctx.shadowColor = `rgba(${colorRgb}, ${glowAlpha})`;
        ctx.shadowBlur = glowBlur;
      }

      const colors = isCurrentStage ? highlightColors : stageColors;
      ctx.fillStyle = colors[index % colors.length];
      ctx.fillRect(xStart, yStart, xEnd - xStart, yEnd - yStart);

      if (isCurrentStage) {
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
      }
      cumulativeDuration += stage.durationSec;
    });

    ctx.restore();
  }
};

function makeStageConfig(targetSeries) {
  return {
    type: 'line',
    data: {
      datasets: [{
        data: targetSeries,
        parsing: false,
        borderColor: '#ef4444',
        backgroundColor: 'rgba(239,68,68,0.10)',
        tension: .35,
        pointRadius: 0
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { type: 'linear', min: 0, max: 60, display: false },
        y: { min: 40, max: 180, display: false } // will be overridden by setYAxis()
      },
      plugins: { legend: { display: false }, tooltip: { enabled: false } }
    },
    plugins: [heartFollowerPlugin] // hrChart-only plugin logic
  };
}

function makeSessionConfig(targetSeries) {
  return {
    type: 'line',
    data: {
      datasets: [{
        data: targetSeries,
        parsing: false,
        borderColor: '#f59e0b',
        backgroundColor: 'rgba(245,158,11,0.1)',
        tension: .3,
        pointRadius: 0,
        borderWidth: 1.5
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: {
          type: 'linear',
          min: 0,
          max: 1,
          ticks: {
            color: 'rgba(255,255,255,0.4)',
            font: { size: 10 },
            callback: (v) => fmtMMSS(v)
          }
        },
        y: { min: 40, max: 200, ticks: { color: 'rgba(255,255,255,0.4)', font: { size: 10 } } }
      },
      plugins: { legend: { display: false }, tooltip: { enabled: false } }
    },
    plugins: [stageAnnotationsPlugin]
  };
}

export function setupCharts() {
  const c1 = document.getElementById('hrChart').getContext('2d');
  state.chart = new Chart(c1, makeStageConfig(state.series));
  const c2 = document.getElementById('sessionHrChart').getContext('2d');
  state.sessionChart = new Chart(c2, makeSessionConfig(state.sessionSeries));
}

/* --------- Fullscreen-related code removed previously --------- */

export function resetStageSeries() {
  state.series.length = 0;
  if (state.chart) {
    state.chart.data.datasets[0].data = state.series;
    state.chart.update('none');
  }
  const marker = document.getElementById('heartMarker');
  if (marker) marker.style.opacity = '0';
}

export function resetSessionSeries() {
  state.sessionSeries.length = 0;
  if (state.sessionChart) {
    state.sessionChart.data.datasets[0].data = state.sessionSeries;
    state.sessionChart.update('none');
  }
}

/**
 * setYAxis(lo, hi)
 * - Save ORIGINAL bounds and set hrChart scale to buffered [lo-10, hi+10]
 *   so the white lines (lo/hi) sit correctly on the buffered scale.
 */
export function setYAxis(lo, hi) {
  state.currentStageBoundsOriginal = { lo, hi };

  if (state.chart) {
    state.chart.options.scales.y.min = lo - 10;
    state.chart.options.scales.y.max = hi + 10;
    state.chart.update('none');
  }
}

export function setStageXAxis(sec) {
  const max = Math.max(1, sec);
  if (state.chart) {
    state.chart.options.scales.x.min = 0;
    state.chart.options.scales.x.max = max;
    state.chart.update('none');
  }
}

export function syncChartScales() {
  if (!state.trainingSession) return;
  const firstStage = state.trainingSession.stages[Math.max(0, state.stageIdx)];
  if (firstStage) setStageXAxis(firstStage.durationSec);

  const { min, max } = state.trainingSession.sessionBounds || { min: 40, max: 200 };
  if (state.sessionChart) {
    state.sessionChart.options.scales.x.max = state.trainingSession.totalDurationSec;
    state.sessionChart.options.scales.y.min = min;
    state.sessionChart.options.scales.y.max = max;
    state.sessionChart.update('none');
  }
}

export function updateStageChart(hr, tMs) {
  if (!state.stageStartMs) return;
  const x = (tMs - state.stageStartMs - state.stageAccumulatedPauseOffset) / 1000;
  state.series.push({ x: Math.max(0, x), y: hr });
  if (state.chart) {
    state.chart.data.datasets[0].data = state.series;
    state.chart.update('none');
  }
}

export function updateSessionChart(hr, tMs) {
  if (!state.sessionStartMs || state.paused) return;
  const totalElapsedSec = Math.max(0, (tMs - state.sessionStartMs - state.accumulatedPauseOffset) / 1000);
  state.sessionSeries.push({ x: Math.max(0, totalElapsedSec), y: hr });
  // session chart is updated by the animation loop elsewhere
}
