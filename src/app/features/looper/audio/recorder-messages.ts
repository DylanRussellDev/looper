// Message protocol between AudioEngine and public/worklets/recorder-processor.js.
// Keep both sides in sync when changing a message.

export interface RecorderOptions {
  chunkFrames: number;
  historyFrames: number;
  levelIntervalFrames: number;
}

export type RecorderCommand =
  | { type: 'record'; takeId: number; startFrame: number }
  | { type: 'stop'; takeId: number; stopFrame: number }
  | { type: 'cancel'; takeId: number }
  | { type: 'recycle'; chunk: Float32Array };

export type RecorderEvent =
  | { type: 'started'; takeId: number; startFrame: number }
  | { type: 'chunk'; takeId: number; chunk: Float32Array; length: number }
  | { type: 'recorded'; takeId: number; startFrame: number; lengthFrames: number }
  | { type: 'level'; peak: number; rms: number };
