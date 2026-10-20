/**
 * Calibration constants — QUALIFICATION §2 / RULINGS C-2.
 *
 * "228 words → 75.1 s at the measured 3.035 words/s". The measured constant is
 * the approximation; every derived duration is exact arithmetic on it.
 */
export const NARRATION_WORDS_PER_SECOND = 3.035;

/** Target narration duration for Milestone A (R-009-1). */
export const DEFAULT_TARGET_DURATION_S = 75;

/** ±5 % acceptance band for actual narration duration (R-009-3). */
export const DURATION_BAND_RATIO = 0.05;

export interface WordBudget {
  readonly target_words: number;
  readonly min_words: number;
  readonly max_words: number;
}

/** The word budget for a target duration, rounded exactly as QUALIFICATION §2 states it. */
export function wordBudget(targetDurationS: number = DEFAULT_TARGET_DURATION_S): WordBudget {
  const targetWords = Math.round(targetDurationS * NARRATION_WORDS_PER_SECOND);
  return {
    target_words: targetWords,
    min_words: Math.round(targetWords * (1 - DURATION_BAND_RATIO)),
    max_words: Math.round(targetWords * (1 + DURATION_BAND_RATIO)),
  };
}

/** The ±5 % duration band in seconds for a target duration (R-009-3). */
export function durationBand(targetDurationS: number = DEFAULT_TARGET_DURATION_S): {
  min_s: number;
  max_s: number;
} {
  return {
    min_s: Number((targetDurationS * (1 - DURATION_BAND_RATIO)).toFixed(1)),
    max_s: Number((targetDurationS * (1 + DURATION_BAND_RATIO)).toFixed(1)),
  };
}
