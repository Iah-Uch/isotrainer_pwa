// ============================================================
// CENTRALIZED APPLICATION SETTINGS DEFAULTS
// ============================================================
// All default values for application settings in one place.
// Edit this file to change default behavior for new users
// or when localStorage is cleared.
// ============================================================

/**
 * Default settings for the application.
 * These values are used when no user preference exists in localStorage.
 */
export const SETTINGS_DEFAULTS = {
  // ===== Flow & Training Settings =====
  
  /**
   * Default order for training steps.
   * Valid values: "R1" (Right arm, series 1), "L1" (Left arm, series 1),
   *               "R2" (Right arm, series 2), "L2" (Left arm, series 2)
   * Default: ["R1", "L1", "R2", "L2"] - alternating arms
   */
  flowStepOrder: ["R1", "L1", "R2", "L2"],
  
  /**
   * Default rest interval between exercises (in seconds)
   * Range: 10-600 seconds
   * Default: 120 seconds (2 minutes)
   */
  restIntervalSec: 60,
  
  /**
   * Default rest positions (1-based indices).
   * Valid positions: 1, 2, 3
   * Empty array means no rest periods.
   * Default: [1, 3] - rest after 1st and 3rd exercises
   */
  restPositions: [1, 2, 3],
  
  /**
   * Enable skip button during rest periods.
   * If true, users can skip the rest timer.
   * Default: true
   */
  restSkipEnabled: true,
  
  // ===== Auto-forward Settings =====
  
  /**
   * Auto-forward from measurement screen to next step.
   * If true, automatically proceeds after measurement completes.
   * Default: false (manual confirmation required)
   */
  autoForwardMeasurement: true,
  
  /**
   * Auto-forward from pre-start screen to training.
   * If true, automatically starts training after countdown.
   * Default: true (streamlined workflow)
   */
  autoForwardPrestart: true,
  
  // ===== Display Settings =====
  
  /**
   * Show fixed training plans on home screen.
   * Default: true
   */
  showFixedPlans: true,
  
  /**
   * Enable trend smoothing for force graphs.
   * Default: true
   */
  trendSmoothingEnabled: true,
  
  /**
   * Trend smoothing alpha value (0-1).
   * Lower values = smoother trend line.
   * Default: 0.02
   */
  trendSmoothingAlpha: 0.02,
  
  /**
   * Enable smoothing in viewing mode for completed sessions.
   * Default: false
   */
  viewingModeSmoothingEnabled: false,
  
  /**
   * Enable visual range guidance in force chart during sessions.
   * Shows a gradient that guides users to stay centered between range lines:
   * - Green when in perfect middle
   * - Grayer when moving toward center
   * - Redder when approaching range boundaries
   * - Flashing red with glow when out of range
   * Default: true
   */
  rangeGuidanceEnabled: true,
};

