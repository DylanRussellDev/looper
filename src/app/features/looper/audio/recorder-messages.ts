// Message protocol between AudioEngine and public/worklets/recorder-processor.js.
// Keep both sides in sync when changing a message.

export interface RecorderOptions {
  chunkFrames: number;
  historyFrames: number;
  levelIntervalFrames: number;
  gateAttackFrames: number;
  gateHoldFrames: number;
  gateReleaseFrames: number;
}

export type RecorderCommand =
  | { type: 'record'; takeId: number; startFrame: number }
  | { type: 'stop'; takeId: number; stopFrame: number }
  | { type: 'cancel'; takeId: number }
  | { type: 'recycle'; chunk: Float32Array }
  /** Linear level the input (after the input gain) must reach to open the gate; 0 = off. */
  | { type: 'gate'; threshold: number };

export type RecorderEvent =
  | { type: 'started'; takeId: number; startFrame: number }
  | { type: 'chunk'; takeId: number; chunk: Float32Array; length: number }
  | { type: 'recorded'; takeId: number; startFrame: number; lengthFrames: number }
  /** Levels are measured before the gate; isGateOpen says whether it let anything through. */
  | { type: 'level'; peak: number; rms: number; isGateOpen: boolean };
