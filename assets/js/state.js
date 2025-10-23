// Module: Central app state shared across modules.
import { SETTINGS_DEFAULTS } from './settings-defaults.js';

// Toggle manually when developing without hardware.
export const DEV_OPTIONS = {
  bypassConnectScreen: false,
};

export const DEV_BYPASS_CONNECT = !!DEV_OPTIONS.bypassConnectScreen;

export const state = {
  // Viewing mode smoothing setting
  viewingModeSmoothingEnabled: SETTINGS_DEFAULTS.viewingModeSmoothingEnabled,
  // Active profile for multi-athlete support
  activeProfileId: null,
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
  // Track if connection was ever attempted (to show appropriate message)
  connectionAttempted: false,
  // Where to return if user cancels from pre-start modal.
  startReturnScreen: null, // 'editPlan' | 'plan' | 'home'
  // Guided flow context (fixed plans + measurements).
  currentStepIndex: 0, // Sequence cursor for flow steps (0-based)
  maxDireitoKgf: null,
  maxEsquerdoKgf: null,
  maxDireitoN: null,
  maxEsquerdoN: null,
  flowSequence: [],
  flowStepOrder: SETTINGS_DEFAULTS.flowStepOrder,
  pendingTrainingStep: null,
  restIntervalSec: SETTINGS_DEFAULTS.restIntervalSec,
  restPositions: SETTINGS_DEFAULTS.restPositions,
  restSkipEnabled: SETTINGS_DEFAULTS.restSkipEnabled,
  showFixedPlans: SETTINGS_DEFAULTS.showFixedPlans,
  flowActive: false,
  flowPlan: null,
  flowSourceSession: null,  // Original scheduled session (for fixed plan references)
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
  trendSmoothingEnabled: SETTINGS_DEFAULTS.trendSmoothingEnabled,
  trendSmoothingAlpha: SETTINGS_DEFAULTS.trendSmoothingAlpha,
  // Auto-forward settings for modals
  autoForwardMeasurement: SETTINGS_DEFAULTS.autoForwardMeasurement,
  autoForwardPrestart: SETTINGS_DEFAULTS.autoForwardPrestart,
  // Visual range guidance
  rangeGuidanceEnabled: SETTINGS_DEFAULTS.rangeGuidanceEnabled,
  // Current force position for gradient calculation
  currentForce: null,
};
