// Module: Charts (stage + session plots) and responsive rendering.
import { state } from "./state.js";
import { fmtMMSS } from "./utils.js";

// Helper: map series objects to ECharts tuples.
const toXY = (arr) => arr.map((p) => [p.x, p.y]);

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
  const inactiveAlpha = isContrast() ? 0.95 : 0.46; // super bright in contrast mode
  const activeHiAlpha = above ? 0.98 : inactiveAlpha;
  const activeLoAlpha = below ? 0.98 : inactiveAlpha;
  return [
    {
      yAxis: lo,
      label: {
        show: true,
        position: "end",
        distance: 6,
        formatter: `${lo}`,
        color: `rgba(255,255,255,${activeLoAlpha})`,
        fontSize: 17,
        fontWeight: 600,
      },
      lineStyle: {
        color: `rgba(255,255,255,${activeLoAlpha})`,
        width: 2,
        type: "solid",
        shadowBlur: below ? 14 : 0,
        shadowColor: below ? "rgba(239,68,68,0.6)" : "transparent",
      },
    },
    {
      yAxis: hi,
      label: {
        show: true,
        position: "end",
        distance: 6,
        formatter: `${hi}`,
        color: `rgba(255,255,255,${activeHiAlpha})`,
        fontSize: 17,
        fontWeight: 600,
      },
      lineStyle: {
        color: `rgba(255,255,255,${activeHiAlpha})`,
        width: 2,
        type: "solid",
        shadowBlur: above ? 14 : 0,
        shadowColor: above ? "rgba(239,68,68,0.6)" : "transparent",
      },
    },
  ];
}

function buildStageBands() {
  const s = state;
  if (!s.trainingSession) return [];
  const contrast = isContrast();
  // Map color using ONLY the lower bound (lo)
  // Thresholds (choose the highest threshold <= lower):
  // - >= 159: Red
  // - >= 152: Orange
  // - >= 142: Yellow
  // - >= 111: Green
  // - else: Blue
  const pickColorByLower = (lo) => {
    const lower = Number(lo) || 0;
    if (lower >= 159) return "red";
    if (lower >= 152) return "orange";
    if (lower >= 142) return "yellow";
    if (lower >= 111) return "green";
    return "blue";
  };
  const colorVal = (name, strong) => {
    // Tailwind-ish palette with adjusted opacity for themes
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
  // Fallback palette for non-legacy (index-cycled).
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

  let acc = 0;
  const t = performance.now() - (s.pulseAnimation?.startTime || 0);
  const pulse = (Math.sin(t / 400) + 1) / 2;
  const blur = 10 + pulse * 10;
  const weakGlow = contrast ? 6 + pulse * 6 : 0;
  const strongGlow = contrast ? 22 + pulse * 16 : blur;
  const data = [];
  s.trainingSession.stages.forEach((stg, i) => {
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
        xAxis: acc,
        yAxis: stg.upper,
      },
      {
        xAxis: acc + stg.durationSec,
        yAxis: stg.lower,
      },
    ]);
    acc += stg.durationSec;
  });
  return data;
}

export function setupCharts() {
  // Stage chart
  const el1 = document.getElementById("forceChart");
  // eslint-disable-next-line no-undef
  state.chart = echarts.init(el1, null, { renderer: "canvas" });
  const lw = getLineWidths();
  state.chart.setOption({
    animation: false,
    grid: { left: 0, right: 36, top: 0, bottom: 0 },
    xAxis: { type: "value", min: 0, max: 60, show: false },
    yAxis: { type: "value", min: 40, max: 180, show: false },
    series: [
      {
        type: "line",
        data: toXY(state.series),
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
        data: toXY(state.sessionSeries),
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
      { series: [{ data: toXY(state.sessionSeries) }] },
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

export function syncChartScales() {
  if (!state.trainingSession) return;
  const firstStage = state.trainingSession.stages[Math.max(0, state.stageIdx)];
  if (firstStage) setStageXAxis(firstStage.durationSec);
  const { min, max } = state.trainingSession.sessionBounds || {
    min: 40,
    max: 200,
  };
  if (state.sessionChart)
    state.sessionChart.setOption(
      {
        xAxis: { max: state.trainingSession.totalDurationSec },
        yAxis: { min, max },
        series: [{ markArea: { data: buildStageBands(), silent: true } }],
      },
      false,
      true,
    );
}

function updateForceMarker(x, y) {
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

export function updateStageChart(force, tMs) {
  if (!state.stageStartMs) return;
  const x =
    (tMs - state.stageStartMs - state.stageAccumulatedPauseOffset) / 1000;
  const pt = { x: Math.max(0, x), y: force };
  state.series.push(pt);
  if (state.chart) {
    state.chart.setOption(
      { series: [{ data: toXY(state.series) }] },
      false,
      true,
    );
    const b = state.currentStageBoundsOriginal || {};
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
          },
        ],
      },
      false,
      true,
    );
    updateForceMarker(pt.x, pt.y);
  }
}

export function updateSessionChart(force, tMs) {
  if (!state.sessionStartMs || state.paused) return;
  const totalElapsedSec = Math.max(
    0,
    (tMs - state.sessionStartMs - state.accumulatedPauseOffset) / 1000,
  );
  state.sessionSeries.push({ x: Math.max(0, totalElapsedSec), y: force });
}

// Plot only the points for a given stage index into the stage chart (forceChart).
export function plotStageSliceByIndex(index) {
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
    state.series.push({ x: Math.max(0, p.x - start), y: p.y });
  }
  if (state.chart)
    state.chart.setOption(
      { series: [{ data: toXY(state.series) }] },
      false,
      true,
    );
}
