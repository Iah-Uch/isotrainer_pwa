// Module: Central app state shared across modules.

// Toggle manually when developing without hardware.
export const DEV_OPTIONS = {
  bypassConnectScreen: true,
};

export const DEV_BYPASS_CONNECT = !!DEV_OPTIONS.bypassConnectScreen;

export const state = {
  // Viewing mode smoothing setting (default: false)
  viewingModeSmoothingEnabled: false,
  // BLE.
  device: null,
  server: null,
  service: null,
  characteristic: null,
  commandCharacteristic: null,
  // Charts.
  chart: null,
  sessionChart: null,
  // Data.
  series: [],
  sessionSeries: [],
  // Session/timers.
  trainingSession: null,
  stageIdx: -1,
  sessionStartMs: null,
  stageStartMs: null,
  timerHandle: null,
  paused: false,
  pausedAtMs: null,
  accumulatedPauseOffset: 0,
  stageAccumulatedPauseOffset: 0,
  waitingForFirstSample: false,
  pulseAnimation: { handle: null, startTime: 0 },
  // Import flag.
  isImportedSession: false,
  // Force calibration context for TeraForce dynamometers.
  forceCalibration: {
    zero: null,
    samples: [],
    multiplier: null,
  },
  // Navigation intent gate (requires connect first).
  pendingIntent: null, // { type: 'manual' } | { type: 'edit', sessionIndex: number }
  // From which screen we opened the editor ('home' | 'plan').
  editOrigin: null,
  // Where to return if user cancels from pre-start modal.
  startReturnScreen: null, // 'editPlan' | 'plan' | 'home'
  // Guided flow context (fixed plans + measurements).
  currentStepIndex: 0, // Sequence cursor for flow steps (0-based)
  maxDireitoKgf: null,
  maxEsquerdoKgf: null,
  maxDireitoN: null,
  maxEsquerdoN: null,
  flowSequence: [],
  flowStepOrder: ["R1","L1","R2","L2"],
  pendingTrainingStep: null,
  restIntervalSec: 120,
  restPositions: [1,2,3],
  restSkipEnabled: true,
  showFixedPlans: true,
  flowActive: false,
  flowPlan: null,
  flowArm: null,
  flowStats: [],
  flowStepRecords: [],
  viewSeriesGroups: [],
  viewSeriesActiveGroup: 0,
  measurement: {
    active: false,
    started: false,
    arm: null,
    startMs: null,
    durationMs: 3000,
    peakN: 0,
    currentN: 0,
    timerHandle: null,
    rafHandle: null,
    complete: false,
    forceElapsedMs: 0,
    lastFrameMs: 0,
  },
  restTimer: {
    active: false,
    endMs: 0,
    handle: null,
    stepId: null,
  },
  trendSmoothingEnabled: true,
  trendSmoothingAlpha: 0.02,
  // New: Auto-forward settings for modals
  autoForwardMeasurement: false,
  autoForwardPrestart: false,
};
