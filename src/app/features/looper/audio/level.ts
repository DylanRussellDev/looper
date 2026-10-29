// Meters read in decibels because loudness is perceived logarithmically: a linear meter
// would sit near the bottom for most of a guitar's dynamic range.
const METER_FLOOR_DB = -60;
const CLIP_THRESHOLD = 0.99;

/** Maps a linear peak (0..1) to a 0..1 meter position on a -60 dBFS..0 dBFS scale. */
export function toMeterLevel(peak: number): number {
  if (peak <= 0) {
    return 0;
  }
  const decibels = 20 * Math.log10(peak);
  return Math.min(1, Math.max(0, (decibels - METER_FLOOR_DB) / -METER_FLOOR_DB));
}

export function isClipping(peak: number): boolean {
  return peak >= CLIP_THRESHOLD;
}
