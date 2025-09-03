import { state } from './state.js';
import { fmtMMSS } from './utils.js';

// Helpers
const toXY = (arr) => arr.map((p) => [p.x, p.y]);

function buildBoundsMarkLine(bounds, active) {
  if (!bounds) return [];
  const { lo, hi } = bounds;
  const above = active?.above || false;
  const below = active?.below || false;
  const inactiveAlpha = 0.38; // dimmer when in-range
  const activeHiAlpha = above ? 0.98 : inactiveAlpha;
  const activeLoAlpha = below ? 0.98 : inactiveAlpha;
  return [
    {
      yAxis: lo,
      label: { show: true, position: 'end', distance: 6, formatter: `${lo}`, color: `rgba(255,255,255,${activeLoAlpha})`, fontSize: 17, fontWeight: 600 },
      lineStyle: { color: `rgba(255,255,255,${activeLoAlpha})`, width: 2, type: 'solid', shadowBlur: below ? 14 : 0, shadowColor: below ? 'rgba(239,68,68,0.6)' : 'transparent' }
    },
    {
      yAxis: hi,
      label: { show: true, position: 'end', distance: 6, formatter: `${hi}`, color: `rgba(255,255,255,${activeHiAlpha})`, fontSize: 17, fontWeight: 600 },
      lineStyle: { color: `rgba(255,255,255,${activeHiAlpha})`, width: 2, type: 'solid', shadowBlur: above ? 14 : 0, shadowColor: above ? 'rgba(239,68,68,0.6)' : 'transparent' }
    }
  ];
}

function buildStageBands() {
  const s = state;
  if (!s.trainingSession) return [];
  const cols = [
    'rgba(59,130,246,0.15)',
    'rgba(34,197,94,0.15)',
    'rgba(234,179,8,0.15)',
    'rgba(249,115,22,0.15)',
    'rgba(239,68,68,0.15)'
  ];
  const hiCols = [
    'rgba(59,130,246,0.5)',
    'rgba(34,197,94,0.5)',
    'rgba(234,179,8,0.5)',
    'rgba(249,115,22,0.5)',
    'rgba(239,68,68,0.5)'
  ];
  let acc = 0;
  const t = performance.now() - (s.pulseAnimation?.startTime || 0);
  const pulse = (Math.sin(t / 400) + 1) / 2;
  const blur = 10 + (pulse * 10);
  const data = [];
  s.trainingSession.stages.forEach((stg, i) => {
    const isCur = i === s.stageIdx;
    data.push([
      {
        name: `E${stg.index}`,
        itemStyle: {
          color: isCur ? hiCols[i % hiCols.length] : cols[i % cols.length],
          shadowBlur: isCur ? blur : 0,
          shadowColor: isCur ? 'rgba(255,255,255,0.25)' : 'transparent'
        },
        label: { show: false },
        xAxis: acc,
        yAxis: stg.upper
      },
      {
        xAxis: acc + stg.durationSec,
        yAxis: stg.lower
      }
    ]);
    acc += stg.durationSec;
  });
  return data;
}

export function setupCharts() {
  // Stage chart
  const el1 = document.getElementById('hrChart');
  // eslint-disable-next-line no-undef
  state.chart = echarts.init(el1, null, { renderer: 'canvas' });
  state.chart.setOption({
    animation: false,
    grid: { left: 0, right: 36, top: 0, bottom: 0 },
    xAxis: { type: 'value', min: 0, max: 60, show: false },
    yAxis: { type: 'value', min: 40, max: 180, show: false },
    series: [{
      type: 'line',
      data: toXY(state.series),
      smooth: 0.3,
      showSymbol: false,
      lineStyle: { color: '#f43f5e', width: 2 },
      markLine: { symbol: 'none', data: buildBoundsMarkLine(state.currentStageBoundsOriginal) }
    }]
  });

  // Session chart
  const el2 = document.getElementById('sessionHrChart');
  // eslint-disable-next-line no-undef
  state.sessionChart = echarts.init(el2, null, { renderer: 'canvas' });
  state.sessionChart.setOption({
    animation: false,
    grid: { left: 30, right: 12, top: 10, bottom: 22 },
    xAxis: { type: 'value', min: 0, max: 1, axisLabel: { color: 'rgba(255,255,255,0.6)', formatter: (v) => fmtMMSS(v) }, axisLine: { show: false }, splitLine: { show: false }, axisTick: { show: false } },
    yAxis: { type: 'value', min: 40, max: 200, axisLabel: { color: 'rgba(255,255,255,0.6)' }, axisLine: { show: false }, splitLine: { show: false }, axisTick: { show: false } },
    series: [{
      type: 'line',
      data: toXY(state.sessionSeries),
      smooth: 0.3,
      showSymbol: false,
      lineStyle: { color: '#f59e0b', width: 1.5 },
      markArea: { data: [], silent: true }
    }]
  });

  // Attach responsive behavior for mobile: resize on viewport/container changes
  attachChartResizers();
}

let resizeAttached = false;
function attachChartResizers(){
  if (resizeAttached) return; resizeAttached = true;
  let raf = 0;
  const schedule = () => {
    if (raf) return; raf = requestAnimationFrame(() => { raf = 0; doResize(); });
  };
  const doResize = () => {
    try { state.chart?.resize(); } catch {}
    try { state.sessionChart?.resize(); } catch {}
    const last = state.series?.[state.series.length - 1];
    if (last) updateHeartMarker(last.x, last.y);
  };
  window.addEventListener('resize', schedule, { passive: true });
  window.addEventListener('orientationchange', schedule, { passive: true });
  // Observe container size changes
  try{
    const ro = new ResizeObserver(schedule);
    const el1 = document.getElementById('hrChart');
    const el2 = document.getElementById('sessionHrChart');
    if (el1) ro.observe(el1.parentElement || el1);
    if (el2) ro.observe(el2.parentElement || el2);
  }catch{}
  // Re-resize when route navigates to plot
  window.addEventListener('router:navigate', (e) => {
    const route = e.detail?.route; if (route === 'plot') schedule();
  });
}

export function resetStageSeries() {
  state.series.length = 0;
  if (state.chart) state.chart.setOption({ series: [{ data: toXY(state.series) }] }, false, true);
  const marker = document.getElementById('heartMarker');
  if (marker) marker.style.opacity = '0';
}

export function resetSessionSeries() {
  state.sessionSeries.length = 0;
  if (state.sessionChart) state.sessionChart.setOption({ series: [{ data: toXY(state.sessionSeries) }] }, false, true);
}

export function setYAxis(lo, hi) {
  state.currentStageBoundsOriginal = { lo, hi };
  if (state.chart) state.chart.setOption({
    yAxis: { min: lo - 10, max: hi + 10 },
    series: [{ markLine: { symbol: 'none', data: buildBoundsMarkLine(state.currentStageBoundsOriginal) } }]
  }, false, true);
}

export function setStageXAxis(sec) {
  const max = Math.max(1, sec);
  if (state.chart) state.chart.setOption({ xAxis: { min: 0, max } }, false, true);
}

export function syncChartScales() {
  if (!state.trainingSession) return;
  const firstStage = state.trainingSession.stages[Math.max(0, state.stageIdx)];
  if (firstStage) setStageXAxis(firstStage.durationSec);
  const { min, max } = state.trainingSession.sessionBounds || { min: 40, max: 200 };
  if (state.sessionChart) state.sessionChart.setOption({
    xAxis: { max: state.trainingSession.totalDurationSec },
    yAxis: { min, max },
    series: [{ markArea: { data: buildStageBands(), silent: true } }]
  }, false, true);
}

function updateHeartMarker(x, y) {
  const marker = document.getElementById('heartMarker');
  if (!marker || !state.chart) return;
  // eslint-disable-next-line no-undef
  const [px, py] = state.chart.convertToPixel({ xAxisIndex: 0, yAxisIndex: 0 }, [x, y]);
  const rect = state.chart.getDom().getBoundingClientRect();
  const left = Math.min(Math.max(px, 0), rect.width);
  const top = Math.min(Math.max(py, 0), rect.height);
  marker.style.left = `${left}px`;
  marker.style.top = `${top}px`;
  marker.style.opacity = '1';
}

export function updateStageChart(hr, tMs) {
  if (!state.stageStartMs) return;
  const x = (tMs - state.stageStartMs - state.stageAccumulatedPauseOffset) / 1000;
  const pt = { x: Math.max(0, x), y: hr };
  state.series.push(pt);
  if (state.chart) {
    state.chart.setOption({ series: [{ data: toXY(state.series) }] }, false, true);
    const b = state.currentStageBoundsOriginal || {};
    const above = typeof b.hi === 'number' && hr > b.hi;
    const below = typeof b.lo === 'number' && hr < b.lo;
    state.chart.setOption({ series: [{ markLine: { symbol: 'none', data: buildBoundsMarkLine(b, { above, below }) } }] }, false, true);
    updateHeartMarker(pt.x, pt.y);
  }
}

export function updateSessionChart(hr, tMs) {
  if (!state.sessionStartMs || state.paused) return;
  const totalElapsedSec = Math.max(0, (tMs - state.sessionStartMs - state.accumulatedPauseOffset) / 1000);
  state.sessionSeries.push({ x: Math.max(0, totalElapsedSec), y: hr });
}
