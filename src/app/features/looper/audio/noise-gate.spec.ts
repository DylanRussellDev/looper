import { clampThresholdDb, fromDecibels, getThresholdFromNoise, toDecibels } from './noise-gate';

function noiseWithPeak(peak: number): Float32Array {
  const samples = new Float32Array(1000).fill(peak / 4);
  samples[500] = -peak;
  return samples;
}

describe('noise gate', () => {
  it('converts between decibels and amplitude', () => {
    expect(toDecibels(0.1)).toBeCloseTo(-20);
    expect(fromDecibels(-40)).toBeCloseTo(0.01);
  });

  it('clamps and rounds thresholds to the slider range', () => {
    expect(clampThresholdDb(-95)).toBe(-80);
    expect(clampThresholdDb(-10)).toBe(-20);
    expect(clampThresholdDb(-52.4)).toBe(-52);
  });

  it('sets the threshold 6 dB above the loudest noise', () => {
    const result = getThresholdFromNoise(noiseWithPeak(fromDecibels(-60)), 1);

    expect(result).toEqual({ noiseDb: expect.closeTo(-60), thresholdDb: -54 });
  });

  it('measures the noise before the input gain', () => {
    // Recorded at twice the gain (+6 dB): the noise itself is still at -60 dB.
    const result = getThresholdFromNoise(noiseWithPeak(2 * fromDecibels(-60)), 2);

    expect(result).toEqual({ noiseDb: expect.closeTo(-60), thresholdDb: -54 });
  });

  it('uses the lowest threshold for pure silence', () => {
    expect(getThresholdFromNoise(new Float32Array(1000), 1)).toEqual({
      noiseDb: null,
      thresholdDb: -80,
    });
  });

  it('refuses noise louder than -20 dB, which is probably playing', () => {
    expect(getThresholdFromNoise(noiseWithPeak(fromDecibels(-15)), 1)).toEqual({
      failure: 'too-loud',
    });
  });

  it('caps the threshold for loud but plausible noise', () => {
    const result = getThresholdFromNoise(noiseWithPeak(fromDecibels(-23)), 1);

    expect(result).toMatchObject({ thresholdDb: -20 });
  });
});
