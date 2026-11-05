// Noise gate settings and noise detection. The gate itself runs in the recorder worklet
// (public/worklets/recorder-processor.js); this file holds the main-thread maths.

export const GATE_MIN_THRESHOLD_DB = -80;
export const GATE_MAX_THRESHOLD_DB = -20;
// Detection sets the threshold this far above the loudest noise it heard. Keep it larger
// than the worklet's 3 dB hysteresis, or the noise alone would hold an open gate open.
export const NOISE_MARGIN_DB = 6;
// Louder than this isn't background noise: the player was probably playing.
const MAX_NOISE_DB = -20;
export const NOISE_DETECTION_SECONDS = 2;

export type NoiseDetectionFailure = 'no-input' | 'too-loud' | 'cancelled' | 'input-lost';

export class NoiseDetectionError extends Error {
  constructor(readonly reason: NoiseDetectionFailure) {
    super(`Noise detection failed: ${reason}`);
  }
}

export interface DetectedNoise {
  /** Loudest noise heard, in dBFS before the input gain; null for pure digital silence. */
  noiseDb: number | null;
  thresholdDb: number;
}

export type NoiseThresholdResult =
  DetectedNoise | { failure: Extract<NoiseDetectionFailure, 'too-loud'> };

export const NOISE_DETECTION_FAILURE_MESSAGES: Record<NoiseDetectionFailure, string> = {
  'no-input': 'Connect an input to detect noise.',
  'too-loud':
    'That was too loud to be background noise. Stop playing, mute your strings and try again. The gate was not changed.',
  cancelled: 'Noise detection cancelled. The gate was not changed.',
  'input-lost': 'The input was lost, so noise detection stopped. The gate was not changed.',
};

export function toDecibels(amplitude: number): number {
  return 20 * Math.log10(amplitude);
}

export function fromDecibels(decibels: number): number {
  return 10 ** (decibels / 20);
}

/** Clamps and rounds a threshold to what the slider offers. */
export function clampThresholdDb(decibels: number): number {
  return Math.min(GATE_MAX_THRESHOLD_DB, Math.max(GATE_MIN_THRESHOLD_DB, Math.round(decibels)));
}

/**
 * Picks a threshold just above the loudest sample in a quiet recording. The recording is
 * taken after the input gain, so the gain is divided back out: the gate compares the
 * signal before the gain, which keeps the threshold valid when the gain changes.
 */
export function getThresholdFromNoise(
  samples: Float32Array,
  inputGain: number,
): NoiseThresholdResult {
  let peak = 0;
  for (const sample of samples) {
    peak = Math.max(peak, Math.abs(sample));
  }
  if (peak === 0 || inputGain <= 0) {
    return { noiseDb: null, thresholdDb: GATE_MIN_THRESHOLD_DB };
  }
  const noiseDb = toDecibels(peak / inputGain);
  if (noiseDb > MAX_NOISE_DB) {
    return { failure: 'too-loud' };
  }
  return { noiseDb, thresholdDb: clampThresholdDb(noiseDb + NOISE_MARGIN_DB) };
}
