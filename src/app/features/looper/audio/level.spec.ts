import { isClipping, toMeterLevel } from './level';

describe('level', () => {
  it('maps silence to 0 and full scale to 1', () => {
    expect(toMeterLevel(0)).toBe(0);
    expect(toMeterLevel(1)).toBe(1);
  });

  it('maps -30 dBFS to the middle of the meter', () => {
    expect(toMeterLevel(10 ** (-30 / 20))).toBeCloseTo(0.5);
  });

  it('clamps levels below the meter floor', () => {
    expect(toMeterLevel(10 ** (-80 / 20))).toBe(0);
  });

  it('flags peaks at full scale as clipping', () => {
    expect(isClipping(0.5)).toBe(false);
    expect(isClipping(1)).toBe(true);
  });
});
