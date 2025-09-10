
export const state = {
  // BLE
  device: null, server: null, service: null, characteristic: null,
  // Charts
  chart: null, sessionChart: null,
  // Data
  series: [], sessionSeries: [],
  // Session/timers
  trainingSession: null,
  stageIdx: -1, sessionStartMs: null, stageStartMs: null,
  timerHandle: null, paused: false, pausedAtMs: null,
  accumulatedPauseOffset: 0, stageAccumulatedPauseOffset: 0,
  waitingForFirstHR: false,
  // Pre-start gate: true means show modal and do not begin timing
  startPending: false,
  pulseAnimation: { handle: null, startTime: 0 },
  // Import flag
  isImportedSession: false,
  // Navigation intent gate (require connect first)
  pendingIntent: null, // { type: 'manual' } | { type: 'edit', sessionIndex: number }
  // From which screen did we open the editor ('home' | 'plan')
  editOrigin: null,
  // Where to return if user cancels from pre-start modal
  startReturnScreen: null, // 'editPlan' | 'plan' | 'home'
};
