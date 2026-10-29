/**
 * 'armed' is a short-lived extra state: the take is waiting for the next loop boundary
 * before it starts recording.
 */
export type TrackState = 'empty' | 'armed' | 'recording' | 'playing' | 'overdubbing' | 'stopped';

export type FootswitchAction = 'tap' | 'double-tap' | 'hold';

/** One record or overdub pass. Playback sums a track's layers. */
export interface Layer {
  layerId: number;
  /** One master length each; usually a single buffer. */
  buffers: readonly AudioBuffer[];
}

export interface Track {
  trackId: number;
  state: TrackState;
  layers: readonly Layer[];
  redoLayers: readonly Layer[];
  volume: number;
}

/** The shared loop every track locks to, measured in audio-context frames. */
export interface MasterLoop {
  /** Frame where a loop cycle started; all playback is phased against it. */
  anchorFrame: number;
  lengthFrames: number;
}
