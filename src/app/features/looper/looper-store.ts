import { Service, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { AudioEngine } from './audio/audio-engine';
import { getLoopOffsetFrames, getNextLoopBoundaryFrame } from './audio/loop-timing';
import { FootswitchAction, Layer, MasterLoop, Track, TrackState } from './models/track';

export const TRACK_COUNT = 4;
export const DEFAULT_TRACK_VOLUME = 1;

// States in which a track is audible or about to be, so new takes and restarts must wait
// for a loop boundary to stay in time with it.
const ACTIVE_STATES: ReadonlySet<TrackState> = new Set([
  'armed',
  'recording',
  'playing',
  'overdubbing',
]);

// States in which input is being (or about to be) captured.
const CAPTURING_STATES: ReadonlySet<TrackState> = new Set(['armed', 'recording', 'overdubbing']);

const NO_INPUT_NOTICE = 'No input is connected, so nothing can be recorded. Choose an input above.';
const RECORDING_DISCARDED_NOTICE =
  'The input changed during recording, so that take was discarded. Your other loops kept playing.';

/**
 * 'master': the first take, ended by a tap; its length becomes the master length.
 * 'cycle': a take of exactly one master length, started at a loop boundary.
 */
type TakeKind = 'master' | 'cycle';

interface TrackTake {
  takeId: number;
  kind: TakeKind;
}

/**
 * An overdub in progress. It is recorded as a chain of segments that each end on a loop
 * boundary, so each finished segment can join playback straight away: what you played
 * on the last pass around the loop is heard on the next, and layers stack audibly.
 * When the pass ends, its segments are mixed into the single buffer of a new layer.
 */
interface OverdubPass {
  layerId: number;
  /** The segment being recorded now. */
  takeId: number;
  segments: AudioBuffer[];
  isEnding: boolean;
  shouldUndoAfterCommit: boolean;
}

function createEmptyTracks(): Track[] {
  return Array.from({ length: TRACK_COUNT }, (_, index) => ({
    trackId: index + 1,
    state: 'empty',
    layers: [],
    redoLayers: [],
    volume: DEFAULT_TRACK_VOLUME,
  }));
}

/**
 * Looper rules: the per-track state machine, layers, undo/redo and master loop length.
 * Holds no audio nodes; every sound-producing step is delegated to AudioEngine.
 */
@Service()
export class LooperStore {
  readonly #engine = inject(AudioEngine);

  readonly #tracks = signal<Track[]>(createEmptyTracks());
  readonly #masterLoop = signal<MasterLoop | null>(null);
  readonly #lastTouchedTrackId = signal<number | null>(null);
  readonly #notice = signal('');

  readonly tracks = this.#tracks.asReadonly();
  readonly masterLoop = this.#masterLoop.asReadonly();
  /** The track Undo and Redo act on. */
  readonly lastTouchedTrackId = this.#lastTouchedTrackId.asReadonly();
  readonly notice = this.#notice.asReadonly();
  readonly isAnyTrackActive = computed(() =>
    this.#tracks().some((track) => ACTIVE_STATES.has(track.state)),
  );
  readonly isAnyTrackCapturing = computed(() =>
    this.#tracks().some((track) => CAPTURING_STATES.has(track.state)),
  );
  readonly #lastTouchedTrack = computed(() =>
    this.#tracks().find((track) => track.trackId === this.#lastTouchedTrackId()),
  );
  // The first layer is the track's base recording; Clear removes that, Undo never does.
  readonly canUndo = computed(() => {
    const track = this.#lastTouchedTrack();
    if (!track) {
      return false;
    }
    if (track.state === 'overdubbing') {
      return true;
    }
    return (track.state === 'playing' || track.state === 'stopped') && track.layers.length > 1;
  });
  readonly canRedo = computed(() => {
    const track = this.#lastTouchedTrack();
    return (
      track !== undefined &&
      (track.state === 'playing' || track.state === 'stopped') &&
      track.redoLayers.length > 0
    );
  });

  // Takes and passes in flight per track. A result is used only if it still belongs to
  // the track's current take or pass when it arrives, so clears and resets can simply
  // drop the entry.
  readonly #trackIdToTake = new Map<number, TrackTake>();
  readonly #trackIdToPass = new Map<number, OverdubPass>();
  readonly #finishingTrackIds = new Set<number>();
  readonly #trackIdsToStopAfterTake = new Set<number>();
  #lastLayerId = 0;

  constructor() {
    this.#engine.inputInterrupted$.pipe(takeUntilDestroyed()).subscribe(() => this.#discardTakes());
    this.#engine.recordingStarted$
      .pipe(takeUntilDestroyed())
      .subscribe(({ takeId }) => this.#markRecordingStarted(takeId));
  }

  pressFootswitch(trackId: number, action: FootswitchAction): void {
    // Calibration and noise detection own the input and output until they finish.
    if (this.#engine.isMeasuring()) {
      return;
    }
    this.#notice.set('');
    this.#lastTouchedTrackId.set(trackId);
    switch (action) {
      case 'tap':
        this.tapTrack(trackId);
        break;
      case 'double-tap':
        this.stopTrack(trackId);
        break;
      case 'hold':
        this.clearTrack(trackId);
        break;
    }
  }

  tapTrack(trackId: number): void {
    const track = this.#getTrack(trackId);
    if (!track) {
      return;
    }
    switch (track.state) {
      case 'empty':
        this.#startRecording(trackId);
        break;
      case 'recording':
        // A cycle take ends on its own after exactly one master length.
        if (this.#trackIdToTake.get(trackId)?.kind === 'master') {
          void this.#finishMasterTake(trackId);
        }
        break;
      case 'playing':
        this.#startOverdub(trackId);
        break;
      case 'overdubbing':
        this.#endOverdub(trackId);
        break;
      case 'stopped':
        this.#restartTrack(track);
        break;
      case 'armed':
        // Already waiting for the boundary to record.
        break;
    }
  }

  /**
   * Double-tap. Because the first tap of a double-tap has already acted, this also undoes
   * whatever that tap started (a take or an overdub).
   */
  stopTrack(trackId: number): void {
    const track = this.#getTrack(trackId);
    if (!track) {
      return;
    }
    switch (track.state) {
      case 'armed':
      case 'recording':
        if (this.#finishingTrackIds.has(trackId)) {
          // The first tap ended the master take; stop the loop as soon as it lands.
          this.#trackIdsToStopAfterTake.add(trackId);
          return;
        }
        this.#cancelTake(trackId);
        this.#updateTrack(trackId, (current) => ({
          ...current,
          state: current.layers.length > 0 ? 'stopped' : 'empty',
        }));
        this.#resetMasterLoopIfAllEmpty();
        break;
      case 'overdubbing':
        this.#discardPass(trackId);
        this.#engine.stopTrack(trackId);
        this.#updateTrack(trackId, (current) => ({ ...current, state: 'stopped' }));
        break;
      case 'playing':
        // A pass that is just finishing still commits its layer; it's simply not heard.
        this.#engine.stopTrack(trackId);
        this.#updateTrack(trackId, (current) => ({ ...current, state: 'stopped' }));
        break;
      case 'empty':
      case 'stopped':
        break;
    }
  }

  /** Permanent: drops every layer and the redo history. The track's volume is kept. */
  clearTrack(trackId: number): void {
    if (!this.#getTrack(trackId)) {
      return;
    }
    this.#cancelTake(trackId);
    this.#discardPass(trackId);
    this.#engine.stopTrack(trackId);
    this.#updateTrack(trackId, (track) => ({
      ...track,
      state: 'empty',
      layers: [],
      redoLayers: [],
    }));
    if (this.#lastTouchedTrackId() === trackId) {
      this.#lastTouchedTrackId.set(null);
    }
    this.#resetMasterLoopIfAllEmpty();
  }

  /** Removes the last-touched track's newest layer (ending an overdub in progress first). */
  undo(): void {
    const trackId = this.#lastTouchedTrackId();
    if (trackId === null || !this.canUndo()) {
      return;
    }
    const pass = this.#trackIdToPass.get(trackId);
    if (pass) {
      pass.shouldUndoAfterCommit = true;
      this.#endOverdub(trackId);
      return;
    }
    this.#undoTrack(trackId);
  }

  /** Restores the last-touched track's most recently undone layer. */
  redo(): void {
    const trackId = this.#lastTouchedTrackId();
    const track = this.#lastTouchedTrack();
    if (trackId === null || !track || !this.canRedo()) {
      return;
    }
    const layer = track.redoLayers.at(-1);
    if (!layer) {
      return;
    }
    this.#updateTrack(trackId, (current) => ({
      ...current,
      layers: [...current.layers, layer],
      redoLayers: current.redoLayers.slice(0, -1),
    }));
    this.#engine.addLayerBuffers(trackId, layer.layerId, layer.buffers);
  }

  setTrackVolume(trackId: number, volume: number): void {
    this.#lastTouchedTrackId.set(trackId);
    this.#updateTrack(trackId, (track) => ({ ...track, volume }));
    this.#engine.setTrackVolume(trackId, volume);
  }

  /**
   * Where in the master loop you are hearing right now, 0..1, or null while nothing is
   * playing (a restart then re-anchors the loop, so there is no position to show).
   */
  getLoopProgress(): number | null {
    const masterLoop = this.#masterLoop();
    if (!masterLoop || !this.isAnyTrackActive()) {
      return null;
    }
    const offset = getLoopOffsetFrames(this.#engine.getAudibleFrame(), masterLoop);
    return offset / masterLoop.lengthFrames;
  }

  /** Stops and clears everything, back to a fresh launch. Input settings are untouched. */
  resetAll(): void {
    for (const { trackId } of this.#tracks()) {
      this.#cancelTake(trackId);
      this.#discardPass(trackId);
      this.#engine.stopTrack(trackId);
      this.#engine.setTrackVolume(trackId, DEFAULT_TRACK_VOLUME);
    }
    this.#tracks.set(createEmptyTracks());
    this.#masterLoop.set(null);
    this.#lastTouchedTrackId.set(null);
    this.#notice.set('');
  }

  #startRecording(trackId: number): void {
    if (!this.#engine.isInputConnected()) {
      this.#notice.set(NO_INPUT_NOTICE);
      return;
    }

    const masterLoop = this.#masterLoop();
    if (masterLoop === null) {
      // Only one take can define the master length; other tracks wait for it to finish.
      if (this.#trackIdToTake.size > 0) {
        return;
      }
      const takeId = this.#engine.startRecording();
      this.#trackIdToTake.set(trackId, { takeId, kind: 'master' });
      this.#updateTrack(trackId, (track) => ({ ...track, state: 'recording' }));
      return;
    }

    const nowFrame = this.#engine.getCurrentFrame();
    if (this.isAnyTrackActive()) {
      void this.#recordCycle(trackId, getNextLoopBoundaryFrame(nowFrame, masterLoop), masterLoop);
    } else {
      // Nothing is audible, so waiting for an invisible boundary would just feel laggy:
      // record now and move the loop's start to this moment. The length never changes.
      const reanchoredLoop = { ...masterLoop, anchorFrame: nowFrame };
      this.#masterLoop.set(reanchoredLoop);
      void this.#recordCycle(trackId, nowFrame, reanchoredLoop);
    }
  }

  async #recordCycle(trackId: number, startFrame: number, masterLoop: MasterLoop): Promise<void> {
    const takeId = this.#engine.startRecording(startFrame);
    this.#trackIdToTake.set(trackId, { takeId, kind: 'cycle' });
    this.#updateTrack(trackId, (track) => ({ ...track, state: 'armed' }));

    try {
      // The stop frame is known up front, so the worklet records exactly one cycle.
      const take = await this.#engine.stopRecording(takeId, startFrame + masterLoop.lengthFrames);
      if (this.#isCurrentTake(trackId, takeId)) {
        this.#completeTake(trackId, take.buffer);
      }
    } catch {
      this.#abandonFailedTake(trackId, takeId);
    }
  }

  async #finishMasterTake(trackId: number): Promise<void> {
    const trackTake = this.#trackIdToTake.get(trackId);
    if (!trackTake || this.#finishingTrackIds.has(trackId)) {
      return;
    }
    this.#finishingTrackIds.add(trackId);

    try {
      const take = await this.#engine.stopRecording(trackTake.takeId);
      if (this.#isCurrentTake(trackId, trackTake.takeId)) {
        // The first take defines the loop: its start frame is the phase anchor every
        // later playback is aligned to, and its length is the master length.
        this.#masterLoop.set({ anchorFrame: take.startFrame, lengthFrames: take.buffer.length });
        this.#completeTake(trackId, take.buffer);
      }
    } catch {
      this.#abandonFailedTake(trackId, trackTake.takeId);
    } finally {
      this.#finishingTrackIds.delete(trackId);
    }
  }

  #completeTake(trackId: number, buffer: AudioBuffer): void {
    this.#trackIdToTake.delete(trackId);
    const masterLoop = this.#masterLoop();
    if (!masterLoop) {
      return;
    }
    const layers = [this.#createLayer([buffer])];
    if (this.#trackIdsToStopAfterTake.delete(trackId)) {
      this.#updateTrack(trackId, (track) => ({
        ...track,
        state: 'stopped',
        layers,
        redoLayers: [],
      }));
      return;
    }
    this.#updateTrack(trackId, (track) => ({ ...track, state: 'playing', layers, redoLayers: [] }));
    this.#engine.playTrack(trackId, layers, masterLoop);
  }

  #abandonFailedTake(trackId: number, takeId: number): void {
    if (!this.#isCurrentTake(trackId, takeId)) {
      return;
    }
    this.#trackIdToTake.delete(trackId);
    this.#trackIdsToStopAfterTake.delete(trackId);
    this.#updateTrack(trackId, (track) => ({ ...track, state: 'empty' }));
    this.#resetMasterLoopIfAllEmpty();
  }

  #startOverdub(trackId: number): void {
    if (!this.#engine.isInputConnected()) {
      this.#notice.set(NO_INPUT_NOTICE);
      return;
    }
    // A pass that's still finishing must commit before the next one can start.
    if (!this.#masterLoop() || this.#trackIdToPass.has(trackId)) {
      return;
    }
    const pass: OverdubPass = {
      layerId: ++this.#lastLayerId,
      takeId: 0,
      segments: [],
      isEnding: false,
      shouldUndoAfterCommit: false,
    };
    this.#trackIdToPass.set(trackId, pass);
    this.#updateTrack(trackId, (track) => ({ ...track, state: 'overdubbing' }));
    void this.#recordSegment(trackId, pass, this.#engine.getCurrentFrame());
  }

  /** Records from `startFrame` to the next loop boundary, then chains the next segment. */
  async #recordSegment(trackId: number, pass: OverdubPass, startFrame: number): Promise<void> {
    const masterLoop = this.#masterLoop();
    if (!masterLoop) {
      return;
    }
    const isFirstSegment = pass.segments.length === 0;
    const takeId = this.#engine.startRecording(startFrame, 'segment');
    pass.takeId = takeId;

    try {
      const take = await this.#engine.stopRecording(
        takeId,
        getNextLoopBoundaryFrame(startFrame + 1, masterLoop),
      );
      if (!this.#isCurrentPass(trackId, pass) || pass.takeId !== takeId) {
        return;
      }
      const segment = this.#engine.createLayerSegment(take, masterLoop, {
        fadeIn: isFirstSegment,
        fadeOut: pass.isEnding,
      });
      pass.segments.push(segment);
      this.#engine.addLayerBuffers(trackId, pass.layerId, [segment]);

      if (pass.isEnding) {
        this.#commitPass(trackId, pass);
      } else {
        // The next segment starts on exactly the frame this one ended, so there is no gap.
        void this.#recordSegment(trackId, pass, take.startFrame + take.buffer.length);
      }
    } catch {
      // Ending an overdub right on a boundary can leave the last segment empty.
      if (this.#isCurrentPass(trackId, pass) && pass.takeId === takeId && pass.isEnding) {
        this.#commitPass(trackId, pass);
      }
    }
  }

  #endOverdub(trackId: number): void {
    const pass = this.#trackIdToPass.get(trackId);
    if (!pass || pass.isEnding) {
      return;
    }
    pass.isEnding = true;
    // Pulls the current segment's end in to now; it then commits the pass.
    void this.#engine.stopRecording(pass.takeId).catch(() => undefined);
    this.#updateTrack(trackId, (track) => ({ ...track, state: 'playing' }));
  }

  #commitPass(trackId: number, pass: OverdubPass): void {
    this.#trackIdToPass.delete(trackId);
    if (pass.segments.length === 0) {
      return;
    }
    const buffer =
      pass.segments.length === 1 ? pass.segments[0]! : this.#engine.mixBuffers(pass.segments);
    if (pass.segments.length > 1) {
      // Frees the per-segment buffers without any audible change.
      this.#engine.replaceLayerBuffers(trackId, pass.layerId, [buffer]);
    }
    // A new layer makes the undone ones unreachable, so the redo history goes.
    const layer: Layer = { layerId: pass.layerId, buffers: [buffer] };
    this.#updateTrack(trackId, (track) => ({
      ...track,
      layers: [...track.layers, layer],
      redoLayers: [],
    }));
    if (pass.shouldUndoAfterCommit) {
      this.#undoTrack(trackId);
    }
  }

  #discardPass(trackId: number): void {
    const pass = this.#trackIdToPass.get(trackId);
    if (!pass) {
      return;
    }
    this.#trackIdToPass.delete(trackId);
    this.#engine.cancelRecording(pass.takeId);
    this.#engine.removeLayer(trackId, pass.layerId);
  }

  #undoTrack(trackId: number): void {
    const track = this.#getTrack(trackId);
    const layer = track?.layers.at(-1);
    if (!track || !layer || track.layers.length <= 1) {
      return;
    }
    this.#updateTrack(trackId, (current) => ({
      ...current,
      layers: current.layers.slice(0, -1),
      redoLayers: [...current.redoLayers, layer],
    }));
    this.#engine.removeLayer(trackId, layer.layerId);
  }

  /**
   * From the loop start, in time with the other tracks: at the next boundary if anything
   * else is active, otherwise right away (and the loop's start moves to now).
   */
  #restartTrack(track: Track): void {
    const masterLoop = this.#masterLoop();
    if (!masterLoop || track.layers.length === 0) {
      return;
    }
    const startFrame = this.#engine.getPlaybackStartFrame();
    if (this.isAnyTrackActive()) {
      this.#engine.playTrack(
        track.trackId,
        track.layers,
        masterLoop,
        getNextLoopBoundaryFrame(startFrame, masterLoop),
      );
    } else {
      const reanchoredLoop = { ...masterLoop, anchorFrame: startFrame };
      this.#masterLoop.set(reanchoredLoop);
      this.#engine.playTrack(track.trackId, track.layers, reanchoredLoop, startFrame);
    }
    this.#updateTrack(track.trackId, (current) => ({ ...current, state: 'playing' }));
  }

  #markRecordingStarted(takeId: number): void {
    for (const [trackId, trackTake] of this.#trackIdToTake) {
      if (trackTake.takeId === takeId && this.#getTrack(trackId)?.state === 'armed') {
        this.#updateTrack(trackId, (track) => ({ ...track, state: 'recording' }));
      }
    }
  }

  #discardTakes(): void {
    const takeTrackIds = [...this.#trackIdToTake.keys()];
    const passTrackIds = [...this.#trackIdToPass.keys()];
    if (takeTrackIds.length === 0 && passTrackIds.length === 0) {
      return;
    }
    for (const trackId of takeTrackIds) {
      this.#cancelTake(trackId);
      this.#updateTrack(trackId, (track) => ({
        ...track,
        state: track.layers.length > 0 ? 'playing' : 'empty',
      }));
    }
    for (const trackId of passTrackIds) {
      this.#discardPass(trackId);
      this.#updateTrack(trackId, (track) =>
        track.state === 'overdubbing' ? { ...track, state: 'playing' } : track,
      );
    }
    this.#resetMasterLoopIfAllEmpty();
    this.#notice.set(RECORDING_DISCARDED_NOTICE);
  }

  #cancelTake(trackId: number): void {
    const trackTake = this.#trackIdToTake.get(trackId);
    this.#trackIdToTake.delete(trackId);
    this.#finishingTrackIds.delete(trackId);
    this.#trackIdsToStopAfterTake.delete(trackId);
    if (trackTake) {
      this.#engine.cancelRecording(trackTake.takeId);
    }
  }

  #createLayer(buffers: AudioBuffer[]): Layer {
    return { layerId: ++this.#lastLayerId, buffers };
  }

  #resetMasterLoopIfAllEmpty(): void {
    if (this.#tracks().every((track) => track.state === 'empty')) {
      this.#masterLoop.set(null);
    }
  }

  #isCurrentTake(trackId: number, takeId: number): boolean {
    return this.#trackIdToTake.get(trackId)?.takeId === takeId;
  }

  #isCurrentPass(trackId: number, pass: OverdubPass): boolean {
    return this.#trackIdToPass.get(trackId) === pass;
  }

  #getTrack(trackId: number): Track | undefined {
    return this.#tracks().find((track) => track.trackId === trackId);
  }

  #updateTrack(trackId: number, update: (track: Track) => Track): void {
    this.#tracks.update((tracks) =>
      tracks.map((track) => (track.trackId === trackId ? update(track) : track)),
    );
  }
}
