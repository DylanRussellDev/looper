import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import {
  ControlledTake,
  FakeAudioEngine,
  createFakeAudioBuffer,
  provideFakeAudioEngine,
} from './audio/audio-engine.testing';
import { DEFAULT_TRACK_VOLUME, LooperStore, TRACK_COUNT } from './looper-store';

describe('LooperStore', () => {
  let engine: FakeAudioEngine;
  let store: LooperStore;
  let takes: ControlledTake[];

  const getTrack = (trackId: number) => store.tracks().find((track) => track.trackId === trackId)!;
  const flush = () => new Promise((resolve) => setTimeout(resolve));

  beforeEach(() => {
    engine = new FakeAudioEngine();
    takes = engine.takes;
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), provideFakeAudioEngine(engine)],
    });
    store = TestBed.inject(LooperStore);
  });

  /** Records the master loop on a track: 48 000 frames starting at frame 1000. */
  async function recordMasterLoop(trackId = 1): Promise<void> {
    engine.currentFrame = 1000;
    store.tapTrack(trackId);
    store.tapTrack(trackId);
    takes.at(-1)!.resolve({ buffer: createFakeAudioBuffer(48_000), startFrame: 1000 });
    await flush();
  }

  describe('first loop', () => {
    it('starts with four empty tracks and no master loop', () => {
      expect(store.tracks()).toHaveLength(TRACK_COUNT);
      expect(store.tracks().every((track) => track.state === 'empty')).toBe(true);
      expect(store.masterLoop()).toBeNull();
    });

    it('records immediately on any track and sets the master loop on the next tap', async () => {
      await recordMasterLoop(3);

      expect(store.masterLoop()).toEqual({ anchorFrame: 1000, lengthFrames: 48_000 });
      expect(getTrack(3).state).toBe('playing');
      expect(engine.playTrack).toHaveBeenCalledWith(3, getTrack(3).layers, store.masterLoop());
    });

    it('does not record without a connected input', () => {
      engine.isInputConnected.set(false);
      store.tapTrack(1);

      expect(engine.startRecording).not.toHaveBeenCalled();
    });

    it('ignores other tracks while the master loop is being recorded', () => {
      store.tapTrack(1);
      store.tapTrack(2);

      expect(engine.startRecording).toHaveBeenCalledOnce();
      expect(getTrack(2).state).toBe('empty');
    });

    it('returns to empty if the take fails', async () => {
      store.tapTrack(1);
      store.tapTrack(1);
      takes[0]!.reject(new Error('Recording was empty'));
      await flush();

      expect(getTrack(1).state).toBe('empty');
      expect(store.masterLoop()).toBeNull();
    });
  });

  describe('boundary-quantized recording', () => {
    beforeEach(async () => {
      await recordMasterLoop(1);
    });

    it('arms at the next loop boundary and records exactly one master length', () => {
      engine.currentFrame = 70_000;
      store.tapTrack(2);

      // Loop cycles start at 1000, 49 000, 97 000 …
      expect(engine.startRecording).toHaveBeenLastCalledWith(97_000);
      expect(engine.stopRecording).toHaveBeenLastCalledWith(2, 97_000 + 48_000);
      expect(getTrack(2).state).toBe('armed');
    });

    it('shows recording once the take reaches its boundary', () => {
      store.tapTrack(2);
      engine.recordingStarted.next({ takeId: 2, startFrame: 49_000 });

      expect(getTrack(2).state).toBe('recording');
    });

    it('auto-switches to playing after the cycle', async () => {
      store.tapTrack(2);
      takes.at(-1)!.resolve({ buffer: createFakeAudioBuffer(48_000), startFrame: 49_000 });
      await flush();

      expect(getTrack(2).state).toBe('playing');
      expect(engine.playTrack).toHaveBeenLastCalledWith(2, getTrack(2).layers, store.masterLoop());
      expect(store.masterLoop()).toEqual({ anchorFrame: 1000, lengthFrames: 48_000 });
    });

    it('lets several tracks arm for the same boundary', () => {
      engine.currentFrame = 20_000;
      store.tapTrack(2);
      store.tapTrack(4);

      expect(engine.startRecording).toHaveBeenNthCalledWith(2, 49_000);
      expect(engine.startRecording).toHaveBeenNthCalledWith(3, 49_000);
      expect(getTrack(2).state).toBe('armed');
      expect(getTrack(4).state).toBe('armed');
    });

    it('records straight away and re-anchors the loop when nothing is playing', () => {
      store.stopTrack(1);
      engine.currentFrame = 70_000;
      store.tapTrack(2);

      expect(engine.startRecording).toHaveBeenLastCalledWith(70_000);
      expect(store.masterLoop()).toEqual({ anchorFrame: 70_000, lengthFrames: 48_000 });
    });

    it('cancels an armed take on double-tap', () => {
      store.tapTrack(2);
      store.pressFootswitch(2, 'double-tap');

      expect(engine.cancelRecording).toHaveBeenCalledWith(2);
      expect(getTrack(2).state).toBe('empty');
    });
  });

  describe('stop and restart', () => {
    beforeEach(async () => {
      await recordMasterLoop(1);
    });

    it('stops a playing track on double-tap and keeps its audio', () => {
      store.pressFootswitch(1, 'double-tap');

      expect(engine.stopTrack).toHaveBeenCalledWith(1);
      expect(getTrack(1).state).toBe('stopped');
      expect(getTrack(1).layers).toHaveLength(1);
      expect(store.masterLoop()).not.toBeNull();
    });

    it('stops the new loop when the double-tap ends the master take', async () => {
      store.clearTrack(1);
      store.tapTrack(1);
      store.pressFootswitch(1, 'tap');
      store.pressFootswitch(1, 'double-tap');
      takes.at(-1)!.resolve({ buffer: createFakeAudioBuffer(1000), startFrame: 0 });
      await flush();

      expect(getTrack(1).state).toBe('stopped');
      expect(engine.playTrack).toHaveBeenCalledTimes(1);
    });

    it('restarts at the next boundary while another track plays', async () => {
      store.tapTrack(2);
      takes.at(-1)!.resolve({ buffer: createFakeAudioBuffer(48_000), startFrame: 49_000 });
      await flush();
      store.stopTrack(1);

      engine.currentFrame = 60_000;
      store.tapTrack(1);

      // Playback can start from 61 000; the next boundary after that is 97 000.
      expect(engine.playTrack).toHaveBeenLastCalledWith(
        1,
        getTrack(1).layers,
        store.masterLoop(),
        97_000,
      );
      expect(getTrack(1).state).toBe('playing');
    });

    it('restarts from the loop start right away when nothing else plays', () => {
      store.stopTrack(1);
      engine.currentFrame = 60_000;
      store.tapTrack(1);

      expect(store.masterLoop()).toEqual({ anchorFrame: 61_000, lengthFrames: 48_000 });
      expect(engine.playTrack).toHaveBeenLastCalledWith(
        1,
        getTrack(1).layers,
        store.masterLoop(),
        61_000,
      );
    });
  });

  describe('clearing', () => {
    it('clears a track and resets the master loop once every track is empty', async () => {
      await recordMasterLoop(1);
      store.pressFootswitch(1, 'hold');

      expect(engine.stopTrack).toHaveBeenCalledWith(1);
      expect(getTrack(1)).toMatchObject({ state: 'empty', layers: [], redoLayers: [], volume: 1 });
      expect(store.masterLoop()).toBeNull();
    });

    it('keeps the master length when the master track is cleared but others have audio', async () => {
      await recordMasterLoop(1);
      store.tapTrack(2);
      takes.at(-1)!.resolve({ buffer: createFakeAudioBuffer(48_000), startFrame: 49_000 });
      await flush();

      store.clearTrack(1);

      expect(store.masterLoop()).toEqual({ anchorFrame: 1000, lengthFrames: 48_000 });
      expect(getTrack(2).state).toBe('playing');
    });

    it('cancels an in-progress take and ignores its late result', async () => {
      store.tapTrack(1);
      store.tapTrack(1);
      store.clearTrack(1);
      takes[0]!.resolve({ buffer: createFakeAudioBuffer(1000), startFrame: 0 });
      await flush();

      expect(engine.cancelRecording).toHaveBeenCalledWith(1);
      expect(getTrack(1).state).toBe('empty');
      expect(engine.playTrack).not.toHaveBeenCalled();
    });

    it('starts a cleared track from a fresh state', async () => {
      await recordMasterLoop(1);
      store.clearTrack(1);
      engine.currentFrame = 9000;
      store.tapTrack(1);
      store.tapTrack(1);
      takes.at(-1)!.resolve({ buffer: createFakeAudioBuffer(24_000), startFrame: 9000 });
      await flush();

      expect(store.masterLoop()).toEqual({ anchorFrame: 9000, lengthFrames: 24_000 });
      expect(getTrack(1).layers).toHaveLength(1);
    });
  });

  describe('master reset', () => {
    it('stops and clears everything and cancels pending takes', async () => {
      await recordMasterLoop(1);
      store.tapTrack(2);

      store.resetAll();

      expect(engine.cancelRecording).toHaveBeenCalledWith(2);
      for (let trackId = 1; trackId <= TRACK_COUNT; trackId++) {
        expect(engine.stopTrack).toHaveBeenCalledWith(trackId);
        expect(getTrack(trackId)).toMatchObject({ state: 'empty', layers: [], volume: 1 });
      }
      expect(store.masterLoop()).toBeNull();
    });

    it('ignores takes that finish after the reset, and records afresh', async () => {
      await recordMasterLoop(1);
      store.tapTrack(2);
      store.resetAll();
      takes.at(-1)!.resolve({ buffer: createFakeAudioBuffer(48_000), startFrame: 49_000 });
      await flush();

      expect(getTrack(2).state).toBe('empty');

      store.tapTrack(2);
      expect(getTrack(2).state).toBe('recording');
    });
  });

  describe('input interruption', () => {
    it('discards takes, keeps loops playing, and shows a notice', async () => {
      await recordMasterLoop(1);
      store.tapTrack(2);
      engine.inputInterrupted.next();

      expect(engine.cancelRecording).toHaveBeenCalledWith(2);
      expect(getTrack(2).state).toBe('empty');
      expect(getTrack(1).state).toBe('playing');
      expect(store.notice()).not.toBe('');
    });

    it('does nothing when no take is in progress', async () => {
      await recordMasterLoop(1);
      engine.inputInterrupted.next();

      expect(engine.cancelRecording).not.toHaveBeenCalled();
      expect(store.notice()).toBe('');
    });

    it('discards an overdub in progress and returns to playing', async () => {
      await recordMasterLoop(1);
      store.pressFootswitch(1, 'tap');
      const segmentTakeId = engine.getLastTake().takeId;

      engine.inputInterrupted.next();

      expect(engine.cancelRecording).toHaveBeenCalledWith(segmentTakeId);
      expect(engine.removeLayer).toHaveBeenCalled();
      expect(getTrack(1).state).toBe('playing');
      expect(getTrack(1).layers).toHaveLength(1);
    });
  });

  describe('overdub', () => {
    beforeEach(async () => {
      await recordMasterLoop(1);
      engine.currentFrame = 20_000;
    });

    /** Resolves the current overdub segment as covering [startFrame, startFrame + frames). */
    async function finishSegment(startFrame: number, frames: number): Promise<void> {
      engine.getLastTake().resolve({ buffer: createFakeAudioBuffer(frames), startFrame });
      await flush();
    }

    it('starts immediately on a tap while playing, up to the next loop boundary', () => {
      store.pressFootswitch(1, 'tap');

      expect(getTrack(1).state).toBe('overdubbing');
      expect(engine.startRecording).toHaveBeenLastCalledWith(20_000, 'segment');
      expect(engine.stopRecording).toHaveBeenLastCalledWith(engine.getLastTake().takeId, 49_000);
    });

    it('plays each finished segment and chains the next from the boundary', async () => {
      store.pressFootswitch(1, 'tap');
      await finishSegment(20_000, 29_000);

      expect(engine.createLayerSegment).toHaveBeenLastCalledWith(
        expect.objectContaining({ startFrame: 20_000 }),
        store.masterLoop(),
        { fadeIn: true, fadeOut: false },
      );
      expect(engine.addLayerBuffers).toHaveBeenCalledOnce();
      expect(engine.startRecording).toHaveBeenLastCalledWith(49_000, 'segment');
      expect(engine.stopRecording).toHaveBeenLastCalledWith(engine.getLastTake().takeId, 97_000);
    });

    it('commits the pass as one new layer when tapped again', async () => {
      store.pressFootswitch(1, 'tap');
      await finishSegment(20_000, 29_000);
      engine.currentFrame = 60_000;
      store.pressFootswitch(1, 'tap');

      expect(getTrack(1).state).toBe('playing');
      expect(engine.stopRecording).toHaveBeenLastCalledWith(engine.getLastTake().takeId);
      await finishSegment(49_000, 11_000);

      expect(engine.createLayerSegment).toHaveBeenLastCalledWith(
        expect.anything(),
        store.masterLoop(),
        { fadeIn: false, fadeOut: true },
      );
      expect(engine.mixBuffers).toHaveBeenCalledOnce();
      expect(engine.replaceLayerBuffers).toHaveBeenCalledOnce();
      expect(getTrack(1).layers).toHaveLength(2);
      expect(engine.startRecording).toHaveBeenCalledTimes(3);
    });

    it('discards the pass and stops on double-tap', async () => {
      store.pressFootswitch(1, 'tap');
      const segmentTakeId = engine.getLastTake().takeId;
      store.pressFootswitch(1, 'double-tap');

      expect(engine.cancelRecording).toHaveBeenCalledWith(segmentTakeId);
      expect(engine.removeLayer).toHaveBeenCalled();
      expect(getTrack(1).state).toBe('stopped');
      expect(getTrack(1).layers).toHaveLength(1);
    });

    it('drops the pass when the track is cleared', async () => {
      store.pressFootswitch(1, 'tap');
      store.pressFootswitch(1, 'hold');
      await finishSegment(20_000, 29_000);

      expect(getTrack(1)).toMatchObject({ state: 'empty', layers: [] });
      expect(engine.addLayerBuffers).not.toHaveBeenCalled();
    });
  });

  describe('undo and redo', () => {
    async function overdubLayer(trackId = 1): Promise<void> {
      store.pressFootswitch(trackId, 'tap');
      store.pressFootswitch(trackId, 'tap');
      engine.getLastTake().resolve({ buffer: createFakeAudioBuffer(100), startFrame: 20_000 });
      await flush();
    }

    beforeEach(async () => {
      await recordMasterLoop(1);
      engine.currentFrame = 20_000;
    });

    it('acts on the last-touched track and is disabled until it has an overdub', () => {
      expect(store.lastTouchedTrackId()).toBeNull();
      store.pressFootswitch(1, 'double-tap');

      expect(store.lastTouchedTrackId()).toBe(1);
      expect(store.canUndo()).toBe(false);
      expect(store.canRedo()).toBe(false);
    });

    it('undoes the newest layer and redoes it', async () => {
      await overdubLayer();
      const layerCount = getTrack(1).layers.length;
      const newest = getTrack(1).layers.at(-1)!;
      expect(store.canUndo()).toBe(true);

      store.undo();
      expect(getTrack(1).layers).toHaveLength(layerCount - 1);
      expect(engine.removeLayer).toHaveBeenLastCalledWith(1, newest.layerId);
      expect(store.canRedo()).toBe(true);

      store.redo();
      expect(getTrack(1).layers.at(-1)).toBe(newest);
      expect(engine.addLayerBuffers).toHaveBeenLastCalledWith(1, newest.layerId, newest.buffers);
      expect(store.canRedo()).toBe(false);
    });

    it('never undoes the base recording', async () => {
      await overdubLayer();
      store.undo();
      store.undo();
      store.undo();

      expect(getTrack(1).layers).toHaveLength(1);
      expect(store.canUndo()).toBe(false);
    });

    it('clears the redo history when a new layer is recorded', async () => {
      await overdubLayer();
      store.undo();
      await overdubLayer();

      expect(store.canRedo()).toBe(false);
      expect(getTrack(1).redoLayers).toHaveLength(0);
    });

    it('ends an overdub in progress and undoes it', async () => {
      await overdubLayer();
      const layerCount = getTrack(1).layers.length;
      store.pressFootswitch(1, 'tap');
      expect(store.canUndo()).toBe(true);

      store.undo();
      expect(getTrack(1).state).toBe('playing');
      engine.getLastTake().resolve({ buffer: createFakeAudioBuffer(100), startFrame: 20_000 });
      await flush();

      expect(getTrack(1).layers).toHaveLength(layerCount);
      expect(getTrack(1).redoLayers).toHaveLength(1);
    });

    it('is disabled after the last-touched track is cleared', async () => {
      await overdubLayer();
      store.pressFootswitch(1, 'hold');

      expect(store.lastTouchedTrackId()).toBeNull();
      expect(store.canUndo()).toBe(false);
      store.undo();
      expect(engine.removeLayer).not.toHaveBeenCalled();
    });

    it('follows the track touched most recently', async () => {
      await overdubLayer();
      store.pressFootswitch(2, 'tap');

      expect(store.lastTouchedTrackId()).toBe(2);
      expect(store.canUndo()).toBe(false);
    });
  });

  describe('volume', () => {
    it('sets a track volume and selects that track', () => {
      store.setTrackVolume(3, 0.4);

      expect(getTrack(3).volume).toBe(0.4);
      expect(engine.setTrackVolume).toHaveBeenCalledWith(3, 0.4);
      expect(store.lastTouchedTrackId()).toBe(3);
    });

    it('keeps the volume when a track is cleared and resets it on Master Reset', () => {
      store.setTrackVolume(2, 0.5);
      store.clearTrack(2);
      expect(getTrack(2).volume).toBe(0.5);

      store.resetAll();
      expect(getTrack(2).volume).toBe(DEFAULT_TRACK_VOLUME);
      expect(engine.setTrackVolume).toHaveBeenLastCalledWith(4, DEFAULT_TRACK_VOLUME);
      expect(store.lastTouchedTrackId()).toBeNull();
    });
  });

  describe('input, calibration and loop position', () => {
    it('explains why nothing records without an input', () => {
      engine.isInputConnected.set(false);
      store.pressFootswitch(1, 'tap');

      expect(store.notice()).toContain('No input is connected');
    });

    it('ignores the footswitches while calibrating', () => {
      engine.isCalibrating.set(true);
      store.pressFootswitch(1, 'tap');

      expect(engine.startRecording).not.toHaveBeenCalled();
      expect(store.lastTouchedTrackId()).toBeNull();
    });

    it('ignores the footswitches while detecting noise', () => {
      engine.isDetectingNoise.set(true);
      store.pressFootswitch(1, 'tap');

      expect(engine.startRecording).not.toHaveBeenCalled();
    });

    it('reports when any track is capturing input', async () => {
      expect(store.isAnyTrackCapturing()).toBe(false);
      store.tapTrack(1);
      expect(store.isAnyTrackCapturing()).toBe(true);
      store.tapTrack(1);
      takes.at(-1)!.resolve({ buffer: createFakeAudioBuffer(48_000), startFrame: 1000 });
      await flush();
      expect(store.isAnyTrackCapturing()).toBe(false);
    });

    it('reports the audible position in the loop while something plays', async () => {
      expect(store.getLoopProgress()).toBeNull();
      await recordMasterLoop();

      engine.currentFrame = 1000 + 36_000;
      expect(store.getLoopProgress()).toBe(0.75);

      store.stopTrack(1);
      expect(store.getLoopProgress()).toBeNull();
    });
  });
});
