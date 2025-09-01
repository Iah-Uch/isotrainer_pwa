
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
  pulseAnimation: { handle: null, startTime: 0 },
};
