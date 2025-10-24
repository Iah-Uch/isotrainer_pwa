// Module: Charts (stage + session plots) and responsive rendering.
import { state } from "./state.js";
import { fmtMMSS } from "./utils.js";

// Helper: map series objects to ECharts tuples.
const toXY = (arr) => arr.map((p) => [p.x, p.y]);

const DEFAULT_TREND_ALPHA = 0.02;
let trendSmoothingEnabled = state.trendSmoothingEnabled !== false;
let trendSmoothingAlpha = Number(state.trendSmoothingAlpha);
if (!Number.isFinite(trendSmoothingAlpha)) trendSmoothingAlpha = DEFAULT_TREND_ALPHA;

const toSmoothedXY = (arr, alpha) => {
  let prev = null;
  return (arr || []).map((p) => {
    const rawX = p?.x;
    const x = Number(rawX);
    const raw = typeof p?.y === "number" ? p.y : null;
    if (!Number.isFinite(x) || raw == null || !Number.isFinite(raw))
      return [Number.isFinite(x) ? x : rawX ?? null, raw];
    const next = prev == null ? raw : prev + alpha * (raw - prev);
    prev = next;
    return [x, next];
  });
};

function getSessionSeriesData() {
  return trendSmoothingEnabled
    ? toSmoothedXY(state.sessionSeries, trendSmoothingAlpha)
    : toXY(state.sessionSeries);
}

function refreshStageSeriesForSmoothing() {
  // Always use viewingModeSmoothingEnabled in viewing mode
  const smoothing =
    state.isImportedSession && typeof state.viewingModeSmoothingEnabled !== "undefined"
      ? state.viewingModeSmoothingEnabled
      : trendSmoothingEnabled;
  if (state.trainingSession && state.stageIdx >= 0) {
    try {
      plotStageSliceByIndex(state.stageIdx, smoothing);
      return;
    } catch { }
  }
  if (state.chart) {
    let data = smoothing
      ? toSmoothedXY(state.series, trendSmoothingAlpha)
      : toXY(state.series);
    
    // Apply clamping to stage bounds for saturation
    const b = state.currentStageBoundsOriginal || {};
    if (typeof b.lo === "number" && typeof b.hi === "number") {
      const clampMin = b.lo - 2;
      const clampMax = b.hi + 2;
      data = data.map(([x, y]) => {
        if (!Number.isFinite(y)) return [x, y];
        if (y < clampMin) return [x, clampMin];
        if (y > clampMax) return [x, clampMax];
        return [x, y];
      });
    }
    
    try {
      state.chart.setOption({ series: [{ data }] }, false, true);
    } catch { }
  }
}

function applyTrendSmoothingSetting(enabled) {
  // Always force smoothing to the viewing mode setting in viewing mode
  if (state.isImportedSession && typeof state.viewingModeSmoothingEnabled !== "undefined") {
    trendSmoothingEnabled = !!state.viewingModeSmoothingEnabled;
    state.trendSmoothingEnabled = !!state.viewingModeSmoothingEnabled;
  } else {
    const next = !!enabled;
    trendSmoothingEnabled = next;
    state.trendSmoothingEnabled = next;
  }
  refreshStageSeriesForSmoothing();
  try {
    const data = getSessionSeriesData();
    state.sessionChart?.setOption({ series: [{ data }] }, false, true);
  } catch { }
}

function applyTrendAlphaSetting(alpha) {
  const numeric = Number(alpha);
  if (!Number.isFinite(numeric)) return;
  const clamped = Math.min(0.95, Math.max(0.02, numeric));
  if (Math.abs(clamped - trendSmoothingAlpha) < 0.0001) return;
  trendSmoothingAlpha = clamped;
  state.trendSmoothingAlpha = clamped;
  refreshStageSeriesForSmoothing();
  try {
    const data = getSessionSeriesData();
    state.sessionChart?.setOption({ series: [{ data }] }, false, true);
  } catch { }
}

try {
  window.addEventListener("plot:trendSmoothing", (event) => {
    applyTrendSmoothingSetting(!!event?.detail?.enabled);
  });
  window.addEventListener("plot:trendSmoothingAlpha", (event) => {
    applyTrendAlphaSetting(event?.detail?.alpha);
  });
} catch { }

function getLineWidths() {
  try {
    const w = window.innerWidth || 0;
    // Light, non-intrusive scaling
    if (w >= 1536) return { stage: 3.0, session: 2.2 }; // 2xl
    if (w >= 1280) return { stage: 2.5, session: 2.0 }; // xl
    if (w >= 1024) return { stage: 2.2, session: 1.7 }; // lg
    return { stage: 2.0, session: 1.5 };
  } catch {
    return { stage: 2.0, session: 1.5 };
  }
}

function isContrast() {
  try {
    return (
      document.documentElement.classList.contains("contrast") ||
      document.body.classList.contains("contrast")
    );
  } catch {
    return false;
  }
}

// Persisted UI flag for legacy color rules
function isLegacyGalileuColorsOn() {
  try {
    const v = localStorage.getItem("isotrainer:ui:legacy-galileu-colors");
    return v === "1";
  } catch {
    return false;
  }
}

function getColors() {
  const hc = isContrast();
  return hc
    ? { stage: "#ffffff", session: "#ffe15a", axis: "rgba(255,255,255,1.0)" }
    : // Default theme ~20% brighter overall
    { stage: "#ff6b81", session: "#ffb84a", axis: "rgba(255,255,255,0.72)" };
}

function buildBoundsMarkLine(bounds, active) {
  if (!bounds) return [];
  const { lo, hi } = bounds;
  const above = active?.above || false;
  const below = active?.below || false;
  
  // Default inactiveAlpha 0.38 -> 0.46 (~+20%); contrast is very bright.
  const inactiveAlpha = isContrast() ? 0.95 : 0.46;
  const activeHiAlpha = above ? 0.98 : inactiveAlpha;
  const activeLoAlpha = below ? 0.98 : inactiveAlpha;
  
  // Enhanced dramatic effect when out of range
  const hiShadowBlur = above ? 24 : 0;  // More dramatic than before (was 14)
  const loShadowBlur = below ? 24 : 0;
  const hiShadowColor = above ? "rgba(239,68,68,0.9)" : "transparent"; // Brighter (was 0.6)
  const loShadowColor = below ? "rgba(239,68,68,0.9)" : "transparent";
  const hiLineColor = above ? "rgba(239,68,68,0.95)" : `rgba(255,255,255,${activeHiAlpha})`;
  const loLineColor = below ? "rgba(239,68,68,0.95)" : `rgba(255,255,255,${activeLoAlpha})`;
  
  return [
    {
      yAxis: lo,
      label: {
        show: true,
        position: "end",
        distance: 6,
        formatter: `${lo}`,
        color: below ? `rgba(255,255,255,1.0)` : `rgba(255,255,255,${activeLoAlpha})`,
        fontSize: 17,
        fontWeight: 600,
      },
      lineStyle: {
        color: loLineColor,
        width: 2,
        type: "solid",
        shadowBlur: loShadowBlur,
        shadowColor: loShadowColor,
      },
    },
    {
      yAxis: hi,
      label: {
        show: true,
        position: "end",
        distance: 6,
        formatter: `${hi}`,
        color: above ? `rgba(255,255,255,1.0)` : `rgba(255,255,255,${activeHiAlpha})`,
        fontSize: 17,
        fontWeight: 600,
      },
      lineStyle: {
        color: hiLineColor,
        width: 2,
        type: "solid",
        shadowBlur: hiShadowBlur,
        shadowColor: hiShadowColor,
      },
    },
  ];
}

function buildRangeGuidanceArea(bounds, active) {
  if (!bounds) return [];
  const { lo, hi } = bounds;
  const currentForce = active?.currentForce;
  const above = active?.above || false;
  const below = active?.below || false;
  
  // Check if range guidance is enabled
  const guidanceEnabled = typeof window !== 'undefined' && window.__rangeGuidanceEnabled === true;
  
  if (!guidanceEnabled || typeof currentForce !== 'number' || !Number.isFinite(currentForce)) {
    return [];
  }
  
  const center = (lo + hi) / 2;
  const range = hi - lo;
  const tolerance = range * 0.15; // 15% of range is "perfect center" (more tolerant)
  const transitionZone = range * 0.08; // 8% transition zone for smooth gradient switching
  
  // Calculate position relative to center (0 = center, 1 = at boundary)
  const distanceFromCenter = Math.abs(currentForce - center);
  const normalizedDistance = Math.min(1, distanceFromCenter / (range / 2));
  
  let edgeColor;
  let gradientBlend = 0; // 0 = from lines, 1 = from center
  
  if (above || below) {
    // OUT OF RANGE - Dramatic pulsing red background
    edgeColor = "rgba(239,68,68,0.25)";
    gradientBlend = 1;
  } else if (distanceFromCenter <= tolerance) {
    // PERFECT CENTER - Green glow from lines
    const greenIntensity = Math.max(0.3, 1 - (distanceFromCenter / tolerance));
    edgeColor = `rgba(34,197,94,${greenIntensity * 0.15})`;  // Green with softer opacity (was 0.2)
    gradientBlend = 0;
  } else {
    // GRADIENT: Closer to boundary = redder, closer to center = more transparent
    const redIntensity = normalizedDistance; // 0 = center, 1 = boundary
    
    // Interpolate between transparent (center) and red (boundary)
    const red = Math.round(239 * redIntensity); // 0-239 (red component only when approaching boundary)
    const green = Math.round(68 * redIntensity); // 0-68
    const blue = Math.round(68 * redIntensity);  // 0-68
    const alpha = 0.03 + (redIntensity * 0.15); // Softer: 0.03 to 0.18 (reduced max)
    
    edgeColor = `rgba(${red},${green},${blue},${alpha})`;
    
    // Calculate smooth transition: starts after tolerance, completes within transitionZone
    const distanceFromTolerance = Math.max(0, distanceFromCenter - tolerance);
    gradientBlend = Math.min(1, distanceFromTolerance / transitionZone);
  }
  
  // Create blended gradients for smooth transition
  // gradientBlend: 0 = from lines to center, 1 = from center to lines
  
  // Interpolate gradient direction smoothly
  const transparentColor = 'rgba(0,0,0,0)';
  
  // Calculate color stops that blend between two gradient directions
  const bottomStops = [
    {
      offset: 0,
      color: gradientBlend === 0 ? edgeColor : (gradientBlend === 1 ? transparentColor : interpolateColor(edgeColor, transparentColor, gradientBlend))
    },
    {
      offset: 1,
      color: gradientBlend === 0 ? transparentColor : (gradientBlend === 1 ? edgeColor : interpolateColor(transparentColor, edgeColor, gradientBlend))
    }
  ];
  
  const topStops = [
    {
      offset: 0,
      color: gradientBlend === 0 ? transparentColor : (gradientBlend === 1 ? edgeColor : interpolateColor(transparentColor, edgeColor, gradientBlend))
    },
    {
      offset: 1,
      color: gradientBlend === 0 ? edgeColor : (gradientBlend === 1 ? transparentColor : interpolateColor(edgeColor, transparentColor, gradientBlend))
    }
  ];
  
  return [
    // Bottom gradient
    [
      {
        yAxis: lo,
        itemStyle: {
          color: {
            type: 'linear',
            x: 0, y: 0, x2: 0, y2: 1,
            colorStops: bottomStops
          }
        }
      },
      { yAxis: center }
    ],
    // Top gradient
    [
      {
        yAxis: center,
        itemStyle: {
          color: {
            type: 'linear',
            x: 0, y: 0, x2: 0, y2: 1,
            colorStops: topStops
          }
        }
      },
      { yAxis: hi }
    ]
  ];
}

// Helper function to interpolate between two rgba colors
function interpolateColor(color1, color2, blend) {
  // Parse rgba values
  const parseRgba = (str) => {
    const match = str.match(/rgba?\((\d+),\s*(\d+),\s*(\d+),?\s*([\d.]+)?\)/);
    if (!match) return [0, 0, 0, 0];
    return [
      parseInt(match[1]),
      parseInt(match[2]),
      parseInt(match[3]),
      parseFloat(match[4] || 1)
    ];
  };
  
  const [r1, g1, b1, a1] = parseRgba(color1);
  const [r2, g2, b2, a2] = parseRgba(color2);
  
  const r = Math.round(r1 + (r2 - r1) * blend);
  const g = Math.round(g1 + (g2 - g1) * blend);
  const b = Math.round(b1 + (b2 - b1) * blend);
  const a = (a1 + (a2 - a1) * blend).toFixed(3);
  
  return `rgba(${r},${g},${b},${a})`;
}

function buildStageBands(groupStart = null, groupEnd = null, xOffset = 0) {
  const s = state;
  if (!s.trainingSession) return [];
  const contrast = isContrast();
  const pickColorByLower = (lo) => {
    const lower = Number(lo) || 0;
    if (lower >= 159) return "red";
    if (lower >= 152) return "orange";
    if (lower >= 142) return "yellow";
    if (lower >= 111) return "green";
    return "blue";
  };
  const colorVal = (name, strong) => {
    const op = strong ? (contrast ? 1.0 : 0.84) : contrast ? 0.65 : 0.34;
    switch (name) {
      case "blue":
        return `rgba(59,130,246,${op})`;
      case "green":
        return `rgba(34,197,94,${op})`;
      case "yellow":
        return `rgba(234,179,8,${op})`;
      case "orange":
        return `rgba(249,115,22,${op})`;
      case "red":
      default:
        return `rgba(239,68,68,${op})`;
    }
  };
  const cols = contrast
    ? [
      "rgba(59,130,246,0.65)",
      "rgba(34,197,94,0.65)",
      "rgba(234,179,8,0.65)",
      "rgba(249,115,22,0.65)",
      "rgba(239,68,68,0.65)",
    ]
    : [
      "rgba(59,130,246,0.34)",
      "rgba(34,197,94,0.34)",
      "rgba(234,179,8,0.34)",
      "rgba(249,115,22,0.34)",
      "rgba(239,68,68,0.34)",
    ];
  const hiCols = contrast
    ? [
      "rgba(59,130,246,1.0)",
      "rgba(34,197,94,1.0)",
      "rgba(234,179,8,1.0)",
      "rgba(249,115,22,1.0)",
      "rgba(239,68,68,1.0)",
    ]
    : [
      "rgba(59,130,246,0.84)",
      "rgba(34,197,94,0.84)",
      "rgba(234,179,8,0.84)",
      "rgba(249,115,22,0.84)",
      "rgba(239,68,68,0.84)",
    ];

  const stages = s.trainingSession.stages;
  let start, end;
  if (groupStart === null || groupEnd === null) {
    start = 0;
    end = stages.length - 1;
  } else {
    start = groupStart;
    end = groupEnd;
  }
  let acc = 0;
  for (let i = 0; i < start; i++) acc += stages[i].durationSec;
  const t = performance.now() - (s.pulseAnimation?.startTime || 0);
  const pulse = (Math.sin(t / 400) + 1) / 2;
  const blur = 10 + pulse * 10;
  const weakGlow = contrast ? 6 + pulse * 6 : 0;
  const strongGlow = contrast ? 22 + pulse * 16 : blur;
  const data = [];
  let x = acc;
  for (let i = start; i <= end; i++) {
    const stg = stages[i];
    const isCur = i === s.stageIdx;
    const legacy = isLegacyGalileuColorsOn();
    const base = legacy ? pickColorByLower(stg.lower) : null;
    const fillColor = legacy
      ? isCur
        ? colorVal(base, true)
        : colorVal(base, false)
      : isCur
        ? hiCols[i % hiCols.length]
        : cols[i % cols.length];
    data.push([
      {
        name: `E${stg.index}`,
        itemStyle: {
          color: fillColor,
          shadowBlur: isCur ? strongGlow : weakGlow,
          shadowColor: contrast
            ? "rgba(255,255,255,0.55)"
            : isCur
              ? "rgba(255,255,255,0.25)"
              : "transparent",
        },
        label: { show: false },
        xAxis: xOffset + x - acc,
        yAxis: stg.upper,
      },
      {
        xAxis: xOffset + x + stg.durationSec - acc,
        yAxis: stg.lower,
      },
    ]);
    x += stg.durationSec;
  }
  return data;
}

export function setupCharts() {
  // Stage chart
  const el1 = document.getElementById("forceChart");
  // eslint-disable-next-line no-undef
  state.chart = echarts.init(el1, null, { renderer: "canvas" });
  const lw = getLineWidths();
  const initialStageData = trendSmoothingEnabled
    ? toSmoothedXY(state.series, trendSmoothingAlpha)
    : toXY(state.series);
  state.chart.setOption({
    animation: false,
    grid: { left: 0, right: 36, top: 0, bottom: 0 },
    xAxis: { type: "value", min: 0, max: 60, show: false },
    yAxis: { type: "value", min: 40, max: 180, show: false },
    series: [
      {
        type: "line",
        data: initialStageData,
        smooth: 0.3,
        showSymbol: false,
        lineStyle: {
          color: getColors().stage,
          width: lw.stage,
          shadowBlur: isContrast() ? 16 : 0,
          shadowColor: isContrast() ? "rgba(255,255,255,0.8)" : "transparent",
        },
        markLine: {
          symbol: "none",
          data: buildBoundsMarkLine(state.currentStageBoundsOriginal),
        },
        markArea: {
          silent: true,
          data: buildRangeGuidanceArea(state.currentStageBoundsOriginal, {}),
        },
      },
    ],
  });

  // Session chart.
  const el2 = document.getElementById("sessionHrChart");
  // eslint-disable-next-line no-undef
  state.sessionChart = echarts.init(el2, null, { renderer: "canvas" });
  state.sessionChart.setOption({
    animation: false,
    grid: { left: 30, right: 12, top: 10, bottom: 22 },
    xAxis: {
      type: "value",
      min: 0,
      max: 1,
      axisLabel: {
        color: getColors().axis || "rgba(255,255,255,0.6)",
        formatter: (v) => fmtMMSS(v),
      },
      axisLine: { show: false },
      splitLine: { show: false },
      axisTick: { show: false },
    },
    yAxis: {
      type: "value",
      min: 40,
      max: 200,
      axisLabel: { color: getColors().axis || "rgba(255,255,255,0.6)" },
      axisLine: { show: false },
      splitLine: { show: false },
      axisTick: { show: false },
    },
    series: [
      {
        type: "line",
        data: getSessionSeriesData(),
        smooth: 0.3,
        showSymbol: false,
        lineStyle: {
          color: getColors().session,
          width: lw.session,
          shadowBlur: isContrast() ? 14 : 0,
          shadowColor: isContrast() ? "rgba(255,255,255,0.7)" : "transparent",
        },
        markArea: { data: [], silent: true },
      },
    ],
  });

  // Attach responsive behavior for mobile: resize on viewport/container changes.
  attachChartResizers();

  // Click anywhere on the session chart to select a stage by time.
  try {
    const handleClick = (offsetX, offsetY) => {
      if (!state.trainingSession || !state.sessionSeries?.length) return;
      let x = null;
      try {
        const xy = state.sessionChart.convertFromPixel(
          { xAxisIndex: 0, yAxisIndex: 0 },
          [offsetX, offsetY],
        );
        x = Array.isArray(xy) ? xy[0] : null;
      } catch { }
      if (typeof x !== "number" || !isFinite(x)) return;
      const stages = state.trainingSession.stages || [];
      let acc = 0;
      let idx = -1;
      for (let i = 0; i < stages.length; i++) {
        const start = acc;
        const end = acc + stages[i].durationSec;
        acc = end;
        if (x >= start && x <= end) {
          idx = i;
          break;
        }
      }
      if (idx === -1) idx = stages.length - 1;
      if (idx < 0) return;
      window.dispatchEvent(
        new CustomEvent("session:stageSelected", { detail: { index: idx } }),
      );
    };
    // Prefer ZRender click for reliability.
    state.sessionChart
      .getZr()
      .on("click", (e) => handleClick(e.offsetX, e.offsetY));
    // Fallback: ECharts click.
    state.sessionChart.on("click", (params) => {
      const ev = params?.event;
      if (!ev) return;
      handleClick(ev.offsetX, ev.offsetY);
    });
  } catch { }
}

let resizeAttached = false;
function attachChartResizers() {
  if (resizeAttached) return;
  resizeAttached = true;
  let raf = 0;
  const schedule = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      doResize();
    });
  };
  const doResize = () => {
    try {
      state.chart?.resize();
    } catch { }
    try {
      state.sessionChart?.resize();
    } catch { }
    // Lightly scale line widths and colors with viewport/contrast
    try {
      const lw = getLineWidths();
      const col = getColors();
      if (state.chart)
        state.chart.setOption(
          {
            series: [
              {
                lineStyle: {
                  width: lw.stage,
                  color: col.stage,
                  shadowBlur: isContrast() ? 16 : 0,
                  shadowColor: isContrast()
                    ? "rgba(255,255,255,0.8)"
                    : "transparent",
                },
              },
            ],
          },
          false,
          true,
        );
      if (state.sessionChart)
        state.sessionChart.setOption(
          {
            series: [
              {
                lineStyle: {
                  width: lw.session,
                  color: col.session,
                  shadowBlur: isContrast() ? 14 : 0,
                  shadowColor: isContrast()
                    ? "rgba(255,255,255,0.7)"
                    : "transparent",
                },
              },
            ],
          },
          false,
          true,
        );
    } catch { }
    const last = state.series?.[state.series.length - 1];
    if (last) updateForceMarker(last.x, last.y);
  };
  window.addEventListener("resize", schedule, { passive: true });
  window.addEventListener("orientationchange", schedule, { passive: true });
  // Observe container size changes.
  try {
    const ro = new ResizeObserver(schedule);
    const el1 = document.getElementById("forceChart");
    const el2 = document.getElementById("sessionHrChart");
    if (el1) ro.observe(el1.parentElement || el1);
    if (el2) ro.observe(el2.parentElement || el2);
  } catch { }
  // Re-resize when route navigates to plot.
  window.addEventListener("router:navigate", (e) => {
    const route = e.detail?.route;
    if (route === "plot") schedule();
  });
  // Update when legacy color rule toggles.
  window.addEventListener("ui:legacyColors", () => {
    try {
      syncChartScales();
    } catch { }
  });
}

export function resetStageSeries() {
  state.series.length = 0;
  if (state.chart)
    state.chart.setOption(
      { series: [{ data: toXY(state.series) }] },
      false,
      true,
    );
  const marker = document.getElementById("forceMarker");
  if (marker) marker.style.opacity = "0";
}

export function resetSessionSeries() {
  state.sessionSeries.length = 0;
  if (state.sessionChart)
    state.sessionChart.setOption(
      { series: [{ data: getSessionSeriesData() }] },
      false,
      true,
    );
}

export function setYAxis(lo, hi) {
  state.currentStageBoundsOriginal = { lo, hi };
  const lower = Number(lo);
  const upper = Number(hi);
  if (!Number.isFinite(lower) || !Number.isFinite(upper)) return;
  const span = Math.max(0.5, Math.abs(upper - lower));
  const padding = Math.max(0.5, span * 0.25);
  if (state.chart)
    state.chart.setOption(
      {
        yAxis: { min: lower - padding, max: upper + padding },
        series: [
          {
            markLine: {
              symbol: "none",
              data: buildBoundsMarkLine(state.currentStageBoundsOriginal),
            },
            markArea: {
              silent: true,
              data: buildRangeGuidanceArea(state.currentStageBoundsOriginal, {}),
            },
          },
        ],
      },
      false,
      true,
    );
}

export function setStageXAxis(sec) {
  const max = Math.max(1, sec);
  if (state.chart)
    state.chart.setOption({ xAxis: { min: 0, max } }, false, true);
}

export function syncChartScales(groupStart = null, groupEnd = null, xOffset = 0, xMax = null) {
  if (!state.trainingSession) return;
  const firstStage = state.trainingSession.stages[Math.max(0, state.stageIdx)];
  if (firstStage) setStageXAxis(firstStage.durationSec);
  const { min, max } = state.trainingSession.sessionBounds || {
    min: 40,
    max: 200,
  };
  let markAreaData, xAxisMax;
  if (groupStart !== null && groupEnd !== null) {
    markAreaData = buildStageBands(groupStart, groupEnd, xOffset);
    xAxisMax = xMax;
  } else {
    markAreaData = buildStageBands(0, state.trainingSession.stages.length - 1, 0);
    xAxisMax = state.trainingSession.totalDurationSec;
  }
  if (state.sessionChart)
    state.sessionChart.setOption(
      {
        xAxis: { max: xAxisMax },
        yAxis: { min, max },
        series: [{ markArea: { data: markAreaData, silent: true } }],
      },
      false,
      true,
    );
}

function updateForceMarker(x, y) {
  if (state.isImportedSession) {
    // Hide marker in viewing mode
    const marker = document.getElementById("forceMarker");
    if (marker) marker.style.opacity = "0";
    return;
  }
  const marker = document.getElementById("forceMarker");
  if (!marker || !state.chart) return;
  // eslint-disable-next-line no-undef
  const [px, py] = state.chart.convertToPixel(
    { xAxisIndex: 0, yAxisIndex: 0 },
    [x, y],
  );
  const rect = state.chart.getDom().getBoundingClientRect();
  const left = Math.min(Math.max(px, 0), rect.width);
  const top = Math.min(Math.max(py, 0), rect.height);
  marker.style.left = `${left}px`;
  marker.style.top = `${top}px`;
  marker.style.opacity = "1";
}

// FIX: local formatter to mirror the numeric box style (integer, unitless)
function formatForceForDisplay(v) {
  if (!Number.isFinite(v)) return "—";
  return String(Math.round(v));
}

export function updateStageChart(force, tMs) {
  if (!state.stageStartMs) return;
  // Clamp negative values to 0 - samples below 0 should be treated as 0
  if (force < 0) {
    force = 0;
  }
  const x =
    (tMs - state.stageStartMs - state.stageAccumulatedPauseOffset) / 1000;
  const pt = { x: Math.max(0, x), y: force };
  state.series.push(pt);
  if (state.chart) {
    // Apply smoothing first, then clamp to respect stage bounds
    let data = trendSmoothingEnabled
      ? toSmoothedXY(state.series, trendSmoothingAlpha)
      : toXY(state.series);
    
    // Clamp smoothed data to stage bounds for visual saturation
    const b = state.currentStageBoundsOriginal || {};
    if (typeof b.lo === "number" && typeof b.hi === "number") {
      const clampMin = b.lo - 2;
      const clampMax = b.hi + 2;
      data = data.map(([x, y]) => {
        if (!Number.isFinite(y)) return [x, y];
        if (y < clampMin) return [x, clampMin];
        if (y > clampMax) return [x, clampMax];
        return [x, y];
      });
    }
    
    state.chart.setOption({ series: [{ data }] }, false, true);
    const above = typeof b.hi === "number" && force > b.hi;
    const below = typeof b.lo === "number" && force < b.lo;
    state.chart.setOption(
      {
        series: [
          {
            markLine: {
              symbol: "none",
              data: buildBoundsMarkLine(b, { above, below }),
            },
            markArea: {
              silent: true,
              data: buildRangeGuidanceArea(b, { above, below, currentForce: force }),
            },
          },
        ],
      },
      false,
      true,
    );
    const displayY = data[data.length - 1]?.[1] ?? pt.y;
    if (Number.isFinite(displayY)) {
      updateForceMarker(pt.x, displayY);
      // FIX: keep the numeric readout in sync with what the chart shows
      try {
        const el = document.getElementById("currentForceValue");
        if (el) el.textContent = formatForceForDisplay(displayY);
      } catch { }
    }
  }
}

export function updateSessionChart(force, tMs) {
  if (!state.sessionStartMs || state.paused) return;
  // Clamp negative values to 0 - samples below 0 should be treated as 0
  if (force < 0) {
    force = 0;
  }
  const totalElapsedSec = Math.max(
    0,
    (tMs - state.sessionStartMs - state.accumulatedPauseOffset) / 1000,
  );
  state.sessionSeries.push({ x: Math.max(0, totalElapsedSec), y: force });
}

export function refreshSessionSeries() {
  if (!state.sessionChart) return;
  try {
    let data = getSessionSeriesData();
    // Apply clamping to session chart data for saturation
    const session = state.trainingSession;
    if (session?.sessionBounds) {
      const { min, max } = session.sessionBounds;
      if (Number.isFinite(min) && Number.isFinite(max)) {
        data = data.map(([x, y]) => {
          if (!Number.isFinite(y)) return [x, y];
          if (y < min) return [x, min];
          if (y > max) return [x, max];
          return [x, y];
        });
      }
    }
    state.sessionChart.setOption(
      { series: [{ data }] },
      false,
      true,
    );
  } catch { }
}

// Plot only the points for a given stage index into the stage chart (forceChart).
export function plotStageSliceByIndex(index, overrideSmoothing = null) {
  if (!state.trainingSession || !Array.isArray(state.trainingSession.stages))
    return;
  const stages = state.trainingSession.stages;
  if (index < 0 || index >= stages.length) return;
  let start = 0;
  for (let i = 0; i < index; i++) start += stages[i].durationSec;
  const duration = stages[index].durationSec;
  const end = start + duration;
  const lo = stages[index].lower,
    hi = stages[index].upper;
  // Set axes and bounds for this stage.
  setYAxis(lo, hi);
  setStageXAxis(duration);
  // Fill series with slice from sessionSeries.
  const slice = (state.sessionSeries || []).filter(
    (p) => typeof p?.x === "number" && p.x >= start && p.x <= end,
  );
  state.series.length = 0;
  for (const p of slice) {
    const y = typeof p?.y === "number" ? p.y : null;
    state.series.push({ x: Math.max(0, p.x - start), y });
  }
  // Always use viewingModeSmoothingEnabled in viewing mode
  const smoothing =
    state.isImportedSession && typeof state.viewingModeSmoothingEnabled !== "undefined"
      ? state.viewingModeSmoothingEnabled
      : (overrideSmoothing !== null ? overrideSmoothing : trendSmoothingEnabled);
  if (state.chart) {
    let data = smoothing
      ? toSmoothedXY(state.series, trendSmoothingAlpha)
      : toXY(state.series);
    
    // Clamp smoothed data to stage bounds for visual saturation
    if (Number.isFinite(lo) && Number.isFinite(hi)) {
      const clampMin = lo - 2;
      const clampMax = hi + 2;
      data = data.map(([x, y]) => {
        if (!Number.isFinite(y)) return [x, y];
        if (y < clampMin) return [x, clampMin];
        if (y > clampMax) return [x, clampMax];
        return [x, y];
      });
    }
    
    state.chart.setOption({ series: [{ data }] }, false, true);
    const last = data[data.length - 1];
    if (
      last &&
      Number.isFinite(last[0]) &&
      Number.isFinite(last[1])
    ) {
      updateForceMarker(last[0], last[1]);
      // FIX: also sync numeric readout when jumping between slices
      try {
        const el = document.getElementById("currentForceValue");
        if (el) el.textContent = formatForceForDisplay(last[1]);
      } catch { }
    }
  }
}
