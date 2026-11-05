import {
  getLoopOffsetFrames,
  getNextLoopBoundaryFrame,
  toFrames,
  toFramesCeil,
} from './loop-timing';

describe('loop timing', () => {
  const masterLoop = { anchorFrame: 1000, lengthFrames: 48_000 };

  it('returns 0 at the anchor and at every loop boundary', () => {
    expect(getLoopOffsetFrames(1000, masterLoop)).toBe(0);
    expect(getLoopOffsetFrames(49_000, masterLoop)).toBe(0);
    expect(getLoopOffsetFrames(97_000, masterLoop)).toBe(0);
  });

  it('returns the position within the current cycle', () => {
    expect(getLoopOffsetFrames(1500, masterLoop)).toBe(500);
    expect(getLoopOffsetFrames(49_250, masterLoop)).toBe(250);
  });

  it('wraps frames before the anchor into the loop range', () => {
    expect(getLoopOffsetFrames(999, masterLoop)).toBe(47_999);
  });

  it('finds the next loop boundary at or after a frame', () => {
    expect(getNextLoopBoundaryFrame(1000, masterLoop)).toBe(1000);
    expect(getNextLoopBoundaryFrame(1001, masterLoop)).toBe(49_000);
    expect(getNextLoopBoundaryFrame(48_999, masterLoop)).toBe(49_000);
    expect(getNextLoopBoundaryFrame(0, masterLoop)).toBe(1000);
  });

  it('converts seconds to frames', () => {
    expect(toFrames(0.5, 48_000)).toBe(24_000);
    expect(toFramesCeil(0.000001, 48_000)).toBe(1);
  });
});
