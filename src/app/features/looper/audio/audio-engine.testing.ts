import { Provider, computed, signal } from '@angular/core';
import { Subject } from 'rxjs';

import { Layer, MasterLoop } from '../models/track';
import {
  AudioEngine,
  AudioEngineStatus,
  InputDevice,
  InputLevel,
  RecordedTake,
  RecordingStarted,
  SegmentFades,
  TakeKind,
} from './audio-engine';
import { AudioErrorCode } from './audio-errors';
import { DetectedNoise } from './noise-gate';

/** A stopRecording result the test resolves or rejects by hand. */
export interface ControlledTake {
  takeId: number;
  promise: Promise<RecordedTake>;
  resolve: (take: RecordedTake) => void;
  reject: (error: Error) => void;
}

export function createControlledTake(takeId: number): ControlledTake {
  let resolve: (take: RecordedTake) => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<RecordedTake>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  // Rejections a test never awaits shouldn't surface as unhandled.
  promise.catch(() => undefined);
  return { takeId, promise, resolve, reject };
}

export function createFakeAudioBuffer(lengthFrames: number): AudioBuffer {
  return { length: lengthFrames } as AudioBuffer;
}

/**
 * Signal-backed stand-in for AudioEngine; tests drive its state directly. Every take's
 * stopRecording returns one ControlledTake (repeat calls get the same one, as in the
 * real engine), collected in `takes`.
 */
export class FakeAudioEngine {
  readonly status = signal<AudioEngineStatus>('running');
  readonly error = signal<AudioErrorCode | null>(null);
  readonly inputDevices = signal<InputDevice[]>([]);
  readonly selectedDeviceId = signal('');
  readonly isInputConnected = signal(true);
  readonly inputGain = signal(1);
  readonly isMonitorEnabled = signal(true);
  readonly inputLevel = signal<InputLevel>({ peak: 0, rms: 0 });
  readonly latencyOffsetMs = signal(0);
  readonly reportedOutputLatencyMs = signal<number | null>(null);
  readonly isBuiltInMicSelected = signal(false);
  readonly isCalibrating = signal(false);
  readonly isDetectingNoise = signal(false);
  readonly isMeasuring = computed(() => this.isCalibrating() || this.isDetectingNoise());
  readonly gateThresholdDb = signal<number | null>(null);
  readonly isGateOpen = signal(true);
  readonly isSuspended = signal(false);
  readonly inputInterrupted = new Subject<void>();
  readonly inputInterrupted$ = this.inputInterrupted.asObservable();
  readonly recordingStarted = new Subject<RecordingStarted>();
  readonly recordingStarted$ = this.recordingStarted.asObservable();

  /** Audio clock position returned by getCurrentFrame; playback can start 1000 frames later. */
  currentFrame = 0;
  readonly takes: ControlledTake[] = [];
  #lastTakeId = 0;

  readonly start = vi.fn(async () => undefined);
  readonly selectDevice = vi.fn<(deviceId: string) => Promise<void>>(async () => undefined);
  readonly reconnectInput = vi.fn(async () => undefined);
  readonly resumeAudio = vi.fn(async () => undefined);
  readonly calibrateLatency = vi.fn<() => Promise<number>>(async () => 0);
  readonly cancelCalibration = vi.fn();
  readonly detectNoise = vi.fn<() => Promise<DetectedNoise>>(async () => ({
    noiseDb: -70,
    thresholdDb: -64,
  }));
  readonly cancelNoiseDetection = vi.fn();
  readonly setGateThreshold = vi.fn<(decibels: number | null) => void>();
  readonly getSampleRate = vi.fn(() => 48_000);
  readonly getAudibleFrame = vi.fn(() => this.currentFrame);
  readonly setInputGain = vi.fn();
  readonly setMonitorEnabled = vi.fn();
  readonly setLatencyOffset = vi.fn<(milliseconds: number) => void>();
  readonly setTrackVolume = vi.fn<(trackId: number, volume: number) => void>();
  readonly getCurrentFrame = vi.fn(() => this.currentFrame);
  readonly getPlaybackStartFrame = vi.fn(() => this.currentFrame + 1000);
  readonly startRecording = vi.fn<(startFrame?: number, kind?: TakeKind) => number>(
    () => ++this.#lastTakeId,
  );
  readonly stopRecording = vi.fn<(takeId: number, stopFrame?: number) => Promise<RecordedTake>>(
    (takeId) => {
      let take = this.takes.find((existing) => existing.takeId === takeId);
      if (!take) {
        take = createControlledTake(takeId);
        this.takes.push(take);
      }
      return take.promise;
    },
  );
  readonly cancelRecording = vi.fn<(takeId: number) => void>();
  readonly createLayerSegment = vi.fn<
    (take: RecordedTake, masterLoop: MasterLoop, fades: SegmentFades) => AudioBuffer
  >((_take, masterLoop) => createFakeAudioBuffer(masterLoop.lengthFrames));
  readonly mixBuffers = vi.fn<(buffers: readonly AudioBuffer[]) => AudioBuffer>((buffers) =>
    createFakeAudioBuffer(buffers[0]?.length ?? 0),
  );
  readonly playTrack =
    vi.fn<
      (
        trackId: number,
        layers: readonly Layer[],
        masterLoop: MasterLoop,
        startFrame?: number,
      ) => void
    >();
  readonly addLayerBuffers =
    vi.fn<(trackId: number, layerId: number, buffers: readonly AudioBuffer[]) => void>();
  readonly replaceLayerBuffers =
    vi.fn<(trackId: number, layerId: number, buffers: readonly AudioBuffer[]) => void>();
  readonly removeLayer = vi.fn<(trackId: number, layerId: number) => void>();
  readonly stopTrack = vi.fn<(trackId: number) => void>();

  /** The take most recently started. */
  getLastTake(): ControlledTake {
    const takeId = this.#lastTakeId;
    return this.takes.find((take) => take.takeId === takeId) ?? createControlledTake(takeId);
  }
}

export function provideFakeAudioEngine(engine: FakeAudioEngine): Provider {
  return { provide: AudioEngine, useValue: engine };
}
