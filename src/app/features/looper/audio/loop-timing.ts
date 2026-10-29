import { MasterLoop } from '../models/track';

/**
 * Position (in frames) within the master loop at a given context frame.
 * Uses a positive modulo so frames before the anchor still map into [0, length).
 */
export function getLoopOffsetFrames(frame: number, masterLoop: MasterLoop): number {
  const elapsedFrames = frame - masterLoop.anchorFrame;
  return (
    ((elapsedFrames % masterLoop.lengthFrames) + masterLoop.lengthFrames) % masterLoop.lengthFrames
  );
}

/** The first loop boundary at or after `frame`. */
export function getNextLoopBoundaryFrame(frame: number, masterLoop: MasterLoop): number {
  const offsetFrames = getLoopOffsetFrames(frame, masterLoop);
  return offsetFrames === 0 ? frame : frame + masterLoop.lengthFrames - offsetFrames;
}

/** Rounds up so a scheduled start is never earlier than requested. */
export function toFramesCeil(seconds: number, sampleRate: number): number {
  return Math.ceil(seconds * sampleRate);
}

export function toFrames(seconds: number, sampleRate: number): number {
  return Math.round(seconds * sampleRate);
}
