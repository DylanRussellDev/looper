// Latency calibration: play clicks, record the input, and find how long each click takes
// to come back. That round trip (output latency + input latency) is exactly how late
// your playing reaches the recorder relative to the loop you hear, so it is the value
// the latency compensation setting needs.

export const CALIBRATION_CLICK_COUNT = 6;
export const CALIBRATION_CLICK_SPACING_SECONDS = 0.6;
// A click must agree with the median this closely to count.
const AGREEMENT_SECONDS = 0.002;
// At least this many clicks must agree, so a stray noise can't produce a value.
const MIN_AGREEING_CLICKS = 4;
// Quieter than this (about -40 dBFS) counts as not heard.
const MIN_CLICK_PEAK = 0.01;
// The click must stand this far above the window's average level, or it is just noise.
const MIN_PEAK_TO_AVERAGE = 8;
// The onset is where the signal first reaches this fraction of the click's peak.
const ONSET_FRACTION = 0.3;

const CLICK_SECONDS = 0.01;
const CLICK_FREQUENCY_HZ = 2000;
const CLICK_DECAY_SECONDS = 0.002;
const CLICK_AMPLITUDE = 0.5;

export type CalibrationFailure =
  'no-input' | 'no-signal' | 'inconsistent' | 'cancelled' | 'input-lost';

export class CalibrationError extends Error {
  constructor(readonly reason: CalibrationFailure) {
    super(`Latency calibration failed: ${reason}`);
  }
}

export type ClickLatencyResult =
  | { latencyFrames: number }
  | { failure: Extract<CalibrationFailure, 'no-signal' | 'inconsistent'> };

/**
 * A short tone burst that starts at full level and dies away fast. The instant attack
 * gives a sharp, easy-to-find onset; the tone survives speakers and mics better than a
 * single-sample impulse would.
 */
export function createClickSamples(sampleRate: number): Float32Array {
  const samples = new Float32Array(Math.round(CLICK_SECONDS * sampleRate));
  for (let i = 0; i < samples.length; i++) {
    const time = i / sampleRate;
    samples[i] =
      CLICK_AMPLITUDE *
      Math.sin(2 * Math.PI * CLICK_FREQUENCY_HZ * time) *
      Math.exp(-time / CLICK_DECAY_SECONDS);
  }
  return samples;
}

/**
 * Finds each click in the recording and returns the agreed round-trip latency.
 * `clickOffsets` are where each click was played, in frames from the recording's start;
 * each is searched for in the `windowFrames` after it.
 */
export function measureClickLatency(
  samples: Float32Array,
  clickOffsets: readonly number[],
  windowFrames: number,
  sampleRate: number,
): ClickLatencyResult {
  const detections = clickOffsets
    .map((offset) => findOnset(samples, offset, windowFrames))
    .filter((delay) => delay !== null);
  if (detections.length < MIN_AGREEING_CLICKS) {
    return { failure: 'no-signal' };
  }

  // The median ignores a click or two masked by noise; the rest must agree with it.
  const median = getMedian(detections);
  const tolerance = AGREEMENT_SECONDS * sampleRate;
  const agreeing = detections.filter((delay) => Math.abs(delay - median) <= tolerance);
  if (agreeing.length < MIN_AGREEING_CLICKS) {
    return { failure: 'inconsistent' };
  }
  return { latencyFrames: Math.round(getMedian(agreeing)) };
}

/** Frames from `offset` to the click's onset in the window, or null if there is no click. */
function findOnset(samples: Float32Array, offset: number, windowFrames: number): number | null {
  const end = Math.min(samples.length, offset + windowFrames);
  let peak = 0;
  let sum = 0;
  for (let i = offset; i < end; i++) {
    const level = Math.abs(samples[i] ?? 0);
    peak = Math.max(peak, level);
    sum += level;
  }
  const average = sum / Math.max(1, end - offset);
  if (peak < MIN_CLICK_PEAK || peak < average * MIN_PEAK_TO_AVERAGE) {
    return null;
  }

  // Absolute level, because some interfaces invert polarity.
  const threshold = peak * ONSET_FRACTION;
  for (let i = offset; i < end; i++) {
    if (Math.abs(samples[i] ?? 0) >= threshold) {
      return i - offset;
    }
  }
  return null;
}

function getMedian(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? 0)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

export const CALIBRATION_FAILURE_MESSAGES: Record<CalibrationFailure, string> = {
  'no-input': 'Connect an input before calibrating.',
  'no-signal':
    "The test clicks weren't heard on the input. Connect your interface's output to its input with a cable, or turn your speakers up near the mic, then try again. With headphones, set the value by hand instead.",
  inconsistent:
    'The measurements disagreed, probably because of background noise. Mute the strings, keep the room quiet, and try again.',
  cancelled: 'Calibration cancelled. The latency setting was not changed.',
  'input-lost': 'The input was lost during calibration. The latency setting was not changed.',
};
