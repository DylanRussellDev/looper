import {
  CALIBRATION_CLICK_COUNT,
  createClickSamples,
  measureClickLatency,
} from './latency-calibration';

const SAMPLE_RATE = 48_000;
const SPACING_FRAMES = 28_800;
const WINDOW_FRAMES = 24_000;
const CLICK_OFFSETS = Array.from({ length: CALIBRATION_CLICK_COUNT }, (_, i) => i * SPACING_FRAMES);

/** A recording with each click arriving `delays[i]` frames after it was played. */
function createRecording(delays: readonly (number | null)[], noise = 0): Float32Array {
  const samples = new Float32Array(SPACING_FRAMES * CALIBRATION_CLICK_COUNT);
  for (let i = 0; i < samples.length; i++) {
    samples[i] = noise * Math.sin(i * 0.37);
  }
  const click = createClickSamples(SAMPLE_RATE);
  delays.forEach((delay, index) => {
    if (delay === null) {
      return;
    }
    const start = (CLICK_OFFSETS[index] ?? 0) + delay;
    click.forEach((value, i) => (samples[start + i] = (samples[start + i] ?? 0) + value * 0.2));
  });
  return samples;
}

describe('createClickSamples', () => {
  it('starts loud and decays to near silence', () => {
    const click = createClickSamples(SAMPLE_RATE);
    const peak = Math.max(...click.slice(0, 20).map(Math.abs));

    expect(click.length).toBe(480);
    expect(peak).toBeGreaterThan(0.4);
    expect(Math.abs(click.at(-1) ?? 1)).toBeLessThan(0.01);
  });
});

describe('measureClickLatency', () => {
  it('finds the round-trip delay to within a sample', () => {
    const recording = createRecording(Array(CALIBRATION_CLICK_COUNT).fill(1200));

    const result = measureClickLatency(recording, CLICK_OFFSETS, WINDOW_FRAMES, SAMPLE_RATE);

    expect(result).toHaveProperty('latencyFrames');
    expect('latencyFrames' in result && Math.abs(result.latencyFrames - 1200)).toBeLessThanOrEqual(
      2,
    );
  });

  it('ignores a missed click and an outlier', () => {
    const recording = createRecording([1200, null, 1201, 9000, 1199, 1200]);

    const result = measureClickLatency(recording, CLICK_OFFSETS, WINDOW_FRAMES, SAMPLE_RATE);

    expect('latencyFrames' in result && Math.abs(result.latencyFrames - 1200)).toBeLessThanOrEqual(
      2,
    );
  });

  it('fails when the clicks are not heard', () => {
    const recording = createRecording(Array(CALIBRATION_CLICK_COUNT).fill(null), 0.001);

    expect(measureClickLatency(recording, CLICK_OFFSETS, WINDOW_FRAMES, SAMPLE_RATE)).toEqual({
      failure: 'no-signal',
    });
  });

  it('fails when the clicks are buried in loud noise', () => {
    const recording = createRecording(Array(CALIBRATION_CLICK_COUNT).fill(1200), 0.3);

    expect(measureClickLatency(recording, CLICK_OFFSETS, WINDOW_FRAMES, SAMPLE_RATE)).toEqual({
      failure: 'no-signal',
    });
  });

  it('fails when the detections disagree', () => {
    const recording = createRecording([500, 3000, 6000, 9000, 12_000, 15_000]);

    expect(measureClickLatency(recording, CLICK_OFFSETS, WINDOW_FRAMES, SAMPLE_RATE)).toEqual({
      failure: 'inconsistent',
    });
  });
});
