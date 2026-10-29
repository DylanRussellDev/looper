import { DOCUMENT, OnDestroy, Service, computed, inject, signal } from '@angular/core';
import { Observable, Subject } from 'rxjs';

import { Layer, MasterLoop } from '../models/track';
import { AudioErrorCode, toAudioErrorCode } from './audio-errors';
import {
  CALIBRATION_CLICK_COUNT,
  CALIBRATION_CLICK_SPACING_SECONDS,
  CalibrationError,
  CalibrationFailure,
  createClickSamples,
  measureClickLatency,
} from './latency-calibration';
import { getLoopOffsetFrames, toFrames, toFramesCeil } from './loop-timing';
import { RecorderCommand, RecorderEvent, RecorderOptions } from './recorder-messages';

const RECORDER_PROCESSOR_URL = 'worklets/recorder-processor.js';
const RECORDER_PROCESSOR_NAME = 'recorder-processor';
const RECORDER_CHUNK_FRAMES = 16_384;
// How far back the worklet keeps input, so a start frame that is slightly in the past
// when its message arrives can still be recorded exactly.
const RECORDER_HISTORY_SECONDS = 1;
const LEVEL_UPDATES_PER_SECOND = 30;
// Playback is scheduled slightly in the future so the audio thread receives the
// schedule before it is due, and every source starts on exactly the frame we asked for.
const PLAYBACK_LOOKAHEAD_SECONDS = 0.02;
// Starting or stopping audio mid-waveform would click, so playback and overdub edges
// fade over a few milliseconds: too short to hear as a fade.
const FADE_SECONDS = 0.004;
// Recording runs this much past the loop end; that tail is crossfaded into the loop's
// start so the jump from the last sample back to the first is smooth.
const LOOP_CROSSFADE_SECONDS = 0.005;
// Gain changes glide over ~10 ms instead of jumping, which avoids clicks and zipper noise.
const GAIN_TIME_CONSTANT_SECONDS = 0.01;
// Browsers don't expose a device's type, so the built-in mic is guessed from its label.
const BUILT_IN_MIC_PATTERN = /built-in|internal|microphone array|realtek|webcam|camera/i;
const DEFAULT_INPUT_GAIN = 1;
export const MAX_LATENCY_OFFSET_MS = 500;
// Leaves time to schedule the first calibration click before it is due.
const CALIBRATION_LEAD_IN_SECONDS = 0.1;

export type AudioEngineStatus = 'idle' | 'starting' | 'running';

/**
 * 'loop': a whole loop (the first take, or one boundary-to-boundary cycle). Its loop
 * point is crossfaded.
 * 'segment': part of an overdub pass. Raw audio; passes are stitched from segments.
 */
export type TakeKind = 'loop' | 'segment';

export interface InputDevice {
  deviceId: string;
  label: string;
}

export interface InputLevel {
  peak: number;
  rms: number;
}

export interface RecordedTake {
  buffer: AudioBuffer;
  /** Loop-timeline frame of the first sample (latency compensation already removed). */
  startFrame: number;
}

export interface RecordingStarted {
  takeId: number;
  startFrame: number;
}

export interface SegmentFades {
  fadeIn: boolean;
  fadeOut: boolean;
}

interface Calibration {
  takeId: number;
  output: GainNode;
  sources: AudioBufferSourceNode[];
  abortReason: CalibrationFailure | undefined;
}

interface AudioGraph {
  context: AudioContext;
  inputGain: GainNode;
  monitorGain: GainNode;
  loopBus: GainNode;
  recorder: AudioWorkletNode;
}

interface InputConnection {
  stream: MediaStream;
  source: MediaStreamAudioSourceNode;
}

/** Sources started together, behind one gain node so they can fade and stop together. */
interface PlaybackPart {
  gain: GainNode;
  sources: AudioBufferSourceNode[];
}

/**
 * One start of a track. Layers can gain parts while it plays (overdub segments, redo),
 * so each layer is a list of parts.
 */
interface PlaybackVoice {
  fade: GainNode;
  masterLoop: MasterLoop;
  layerIdToParts: Map<number, PlaybackPart[]>;
}

interface TrackPlayback {
  gain: GainNode;
  voice: PlaybackVoice | undefined;
}

interface PendingTake {
  /** Loop-timeline frame the take ends on. */
  stopFrame: number;
  resolve: (take: RecordedTake) => void;
  reject: (error: Error) => void;
}

interface Take {
  kind: TakeKind;
  /** Fixed when the take starts, so changing the setting mid-take can't split it. */
  latencyFrames: number;
  chunks: Float32Array[];
  pending: PendingTake | undefined;
  promise: Promise<RecordedTake> | undefined;
}

/**
 * Owns everything Web Audio: the AudioContext, the recorder worklet, input routing and
 * loop playback. It knows nothing about looper rules; LooperStore drives it.
 *
 * Signal flow:
 *   mic/interface -> source -> inputGain -+-> recorder worklet (records + meters)
 *                                         +-> monitorGain -> speakers
 *   loop buffers -> part gain -> voice fade -> track volume -> loopBus -> speakers
 */
@Service()
export class AudioEngine implements OnDestroy {
  readonly #document = inject(DOCUMENT);

  readonly #status = signal<AudioEngineStatus>('idle');
  readonly #error = signal<AudioErrorCode | null>(null);
  readonly #inputDevices = signal<InputDevice[]>([]);
  readonly #selectedDeviceId = signal('');
  readonly #isInputConnected = signal(false);
  readonly #inputGain = signal(DEFAULT_INPUT_GAIN);
  readonly #isMonitorEnabled = signal(true);
  readonly #inputLevel = signal<InputLevel>({ peak: 0, rms: 0 });
  readonly #latencyOffsetMs = signal(0);
  readonly #reportedOutputLatencyMs = signal<number | null>(null);
  readonly #isCalibrating = signal(false);
  readonly #isSuspended = signal(false);
  readonly #inputInterrupted = new Subject<void>();
  readonly #recordingStarted = new Subject<RecordingStarted>();

  readonly status = this.#status.asReadonly();
  readonly error = this.#error.asReadonly();
  readonly inputDevices = this.#inputDevices.asReadonly();
  readonly selectedDeviceId = this.#selectedDeviceId.asReadonly();
  readonly isInputConnected = this.#isInputConnected.asReadonly();
  readonly inputGain = this.#inputGain.asReadonly();
  readonly isMonitorEnabled = this.#isMonitorEnabled.asReadonly();
  readonly inputLevel = this.#inputLevel.asReadonly();
  readonly latencyOffsetMs = this.#latencyOffsetMs.asReadonly();
  /** What the browser says its own output path adds; a starting point for the offset. */
  readonly reportedOutputLatencyMs = this.#reportedOutputLatencyMs.asReadonly();
  readonly isCalibrating = this.#isCalibrating.asReadonly();
  /** The browser or OS paused audio (e.g. the output device changed); the clock is stopped. */
  readonly isSuspended = this.#isSuspended.asReadonly();
  readonly isBuiltInMicSelected = computed(() => {
    const device = this.#inputDevices().find(
      (inputDevice) => inputDevice.deviceId === this.#selectedDeviceId(),
    );
    return device !== undefined && BUILT_IN_MIC_PATTERN.test(device.label);
  });
  /** Emits when the input source changes or disappears, so in-progress takes can be discarded. */
  readonly inputInterrupted$: Observable<void> = this.#inputInterrupted.asObservable();
  /** Emits when a take actually begins capturing (e.g. when a quantized take reaches its boundary). */
  readonly recordingStarted$: Observable<RecordingStarted> = this.#recordingStarted.asObservable();

  #graph: AudioGraph | undefined;
  #input: InputConnection | undefined;
  readonly #trackIdToPlayback = new Map<number, TrackPlayback>();
  readonly #takeIdToTake = new Map<number, Take>();
  #lastTakeId = 0;
  #calibration: Calibration | undefined;

  /** Must be called from a user gesture: browsers only let audio start after one. */
  async start(): Promise<void> {
    if (this.#status() !== 'idle') {
      return;
    }
    const mediaDevices = this.#getMediaDevices();
    if (mediaDevices === undefined || typeof AudioWorkletNode === 'undefined') {
      this.#error.set('unsupported');
      return;
    }

    this.#status.set('starting');
    this.#error.set(null);
    let context: AudioContext | undefined;
    try {
      // 'interactive' asks for the smallest output buffer the device supports.
      context = new AudioContext({ latencyHint: 'interactive' });
      // resume() is called before any await so it still counts as part of the click.
      await Promise.all([context.resume(), context.audioWorklet.addModule(RECORDER_PROCESSOR_URL)]);
      this.#graph = this.#createGraph(context);
    } catch {
      void context?.close();
      this.#status.set('idle');
      this.#error.set('start-failed');
      return;
    }

    const outputLatencySeconds = context.baseLatency + (context.outputLatency || 0);
    this.#reportedOutputLatencyMs.set(Math.round(outputLatencySeconds * 1000));
    mediaDevices.addEventListener('devicechange', this.#refreshDevicesOnChange);
    // Watched only from here on: the context is legitimately suspended while starting.
    context.onstatechange = () => this.#isSuspended.set(context.state !== 'running');
    this.#status.set('running');
    await this.#connectInput();
  }

  async selectDevice(deviceId: string): Promise<void> {
    if (this.#status() !== 'running' || deviceId === this.#selectedDeviceId()) {
      return;
    }
    // Any take in progress would mix two devices, so it is discarded before the switch.
    this.#abortCalibration('input-lost');
    this.#inputInterrupted.next();
    await this.#connectInput(deviceId);
  }

  async reconnectInput(): Promise<void> {
    if (this.#status() !== 'running') {
      return;
    }
    await this.#connectInput(this.#selectedDeviceId() || undefined);
  }

  /** Resumes audio the browser or OS suspended. Must be called from a user gesture. */
  async resumeAudio(): Promise<void> {
    try {
      await this.#graph?.context.resume();
    } catch {
      this.#error.set('start-failed');
    }
  }

  setInputGain(gain: number): void {
    this.#inputGain.set(gain);
    if (this.#graph) {
      this.#rampGain(this.#graph.inputGain, gain);
    }
  }

  setMonitorEnabled(isEnabled: boolean): void {
    this.#isMonitorEnabled.set(isEnabled);
    // Calibration keeps the monitor muted; the new setting applies once it finishes.
    if (this.#graph && !this.#calibration) {
      this.#rampGain(this.#graph.monitorGain, isEnabled ? 1 : 0);
    }
  }

  /**
   * Your playing reaches the recorder later than the loop you hear it against: by the
   * output latency (loop to your ears) plus the input latency (guitar to the recorder).
   * Recording that much later lines new audio up with the loop.
   */
  setLatencyOffset(milliseconds: number): void {
    const clamped = Math.min(MAX_LATENCY_OFFSET_MS, Math.max(0, Math.round(milliseconds)));
    this.#latencyOffsetMs.set(Number.isFinite(clamped) ? clamped : 0);
  }

  setTrackVolume(trackId: number, volume: number): void {
    if (!this.#graph) {
      return;
    }
    this.#rampGain(this.#getTrackPlayback(trackId).gain, volume);
  }

  /**
   * Measures the round trip from output to input and applies it as the latency offset.
   * Plays a few clicks and listens for them on the input, so the output must reach the
   * input: a cable from the interface's output to its input, or a mic near the speakers.
   * Loops keep running in time but are muted meanwhile, as is the monitor (it would echo
   * the clicks). Resolves to the offset in ms; rejects with a CalibrationError.
   */
  async calibrateLatency(): Promise<number> {
    const graph = this.#requireGraph();
    if (this.#calibration) {
      throw new Error('Calibration is already running');
    }
    if (!this.#isInputConnected()) {
      throw new CalibrationError('no-input');
    }
    const { context } = graph;
    const { sampleRate } = context;

    const clickSamples = createClickSamples(sampleRate);
    const click = context.createBuffer(1, clickSamples.length, sampleRate);
    click.getChannelData(0).set(clickSamples);

    const spacingFrames = toFrames(CALIBRATION_CLICK_SPACING_SECONDS, sampleRate);
    const firstClickFrame =
      this.getPlaybackStartFrame() + toFrames(CALIBRATION_LEAD_IN_SECONDS, sampleRate);
    const clickOffsets = Array.from(
      { length: CALIBRATION_CLICK_COUNT },
      (_, index) => index * spacingFrames,
    );
    // Each click is searched for over the longest offset the setting allows.
    const windowFrames = toFrames(MAX_LATENCY_OFFSET_MS / 1000, sampleRate);

    // Straight to the speakers: the loop bus and monitor are muted below.
    const output = context.createGain();
    output.connect(context.destination);
    const sources = clickOffsets.map((offset) => {
      const source = context.createBufferSource();
      source.buffer = click;
      source.connect(output);
      source.start((firstClickFrame + offset) / sampleRate);
      return source;
    });
    this.#rampGain(graph.monitorGain, 0);
    this.#rampGain(graph.loopBus, 0);

    // Recorded on the raw audio clock: no latency offset, since that's what is measured.
    const takeId = this.#startTake(firstClickFrame, 'segment', 0);
    const calibration: Calibration = { takeId, output, sources, abortReason: undefined };
    this.#calibration = calibration;
    this.#isCalibrating.set(true);

    try {
      const lastClickOffset = clickOffsets.at(-1) ?? 0;
      const take = await this.stopRecording(
        takeId,
        firstClickFrame + lastClickOffset + windowFrames,
      );
      const result = measureClickLatency(
        take.buffer.getChannelData(0),
        clickOffsets,
        windowFrames,
        sampleRate,
      );
      if ('failure' in result) {
        throw new CalibrationError(result.failure);
      }
      this.setLatencyOffset((result.latencyFrames / sampleRate) * 1000);
      return this.#latencyOffsetMs();
    } catch (error) {
      throw error instanceof CalibrationError
        ? error
        : new CalibrationError(calibration.abortReason ?? 'cancelled');
    } finally {
      this.#finishCalibration(calibration);
    }
  }

  cancelCalibration(): void {
    this.#abortCalibration('cancelled');
  }

  getSampleRate(): number {
    return this.#requireGraph().context.sampleRate;
  }

  /** The current audio-clock position, in frames since the context started. */
  getCurrentFrame(): number {
    const context = this.#requireGraph().context;
    return toFrames(context.currentTime, context.sampleRate);
  }

  /**
   * The audio-clock frame you are hearing right now. Output passes through buffers on its
   * way to the speakers, so what you hear lags the clock by the output latency.
   */
  getAudibleFrame(): number {
    const { context } = this.#requireGraph();
    const outputLatencySeconds = context.baseLatency + (context.outputLatency || 0);
    return toFrames(context.currentTime - outputLatencySeconds, context.sampleRate);
  }

  /** The earliest frame playback can be scheduled on reliably. */
  getPlaybackStartFrame(): number {
    const context = this.#requireGraph().context;
    return toFramesCeil(context.currentTime + PLAYBACK_LOOKAHEAD_SECONDS, context.sampleRate);
  }

  /**
   * Begins a take at loop-timeline frame `startFrame` (now, or a future loop boundary)
   * and returns its id. Several takes can run at once.
   */
  startRecording(startFrame = this.getCurrentFrame(), kind: TakeKind = 'loop'): number {
    const context = this.#requireGraph().context;
    return this.#startTake(
      startFrame,
      kind,
      toFrames(this.#latencyOffsetMs() / 1000, context.sampleRate),
    );
  }

  #startTake(startFrame: number, kind: TakeKind, latencyFrames: number): number {
    const takeId = ++this.#lastTakeId;
    this.#takeIdToTake.set(takeId, {
      kind,
      latencyFrames,
      chunks: [],
      pending: undefined,
      promise: undefined,
    });
    this.#postToRecorder({ type: 'record', takeId, startFrame: startFrame + latencyFrames });
    return takeId;
  }

  /**
   * Ends a take at loop-timeline frame `stopFrame` and resolves once the worklet has
   * delivered every sample. Can be called right after startRecording with a future frame
   * to record an exact length, and called again to end it earlier (the same promise is
   * returned).
   */
  stopRecording(takeId: number, stopFrame = this.getCurrentFrame()): Promise<RecordedTake> {
    const take = this.#takeIdToTake.get(takeId);
    const graph = this.#graph;
    if (!take || !graph) {
      return Promise.reject(new Error('No recording in progress'));
    }
    if (take.pending && take.promise) {
      if (stopFrame < take.pending.stopFrame) {
        take.pending.stopFrame = stopFrame;
        this.#postStop(takeId, take, graph.context);
      }
      return take.promise;
    }

    take.promise = new Promise((resolve, reject) => {
      take.pending = { stopFrame, resolve, reject };
    });
    // Callers that drop a take (e.g. on teardown) shouldn't trigger unhandled-rejection
    // noise; anyone awaiting it still sees the rejection.
    take.promise.catch(() => undefined);
    this.#postStop(takeId, take, graph.context);
    return take.promise;
  }

  cancelRecording(takeId: number): void {
    const take = this.#takeIdToTake.get(takeId);
    if (!take) {
      return;
    }
    this.#takeIdToTake.delete(takeId);
    this.#postToRecorder({ type: 'cancel', takeId });
    take.pending?.reject(new Error('Recording cancelled'));
  }

  /**
   * Places an overdub segment at its position in the loop, in a buffer one master length
   * long (silent elsewhere). A segment never spans a loop boundary, so it fits.
   * Fades soften the very start and end of an overdub pass, where the audio starts or
   * stops abruptly.
   */
  createLayerSegment(take: RecordedTake, masterLoop: MasterLoop, fades: SegmentFades): AudioBuffer {
    const context = this.#requireGraph().context;
    const { lengthFrames } = masterLoop;
    const segment = context.createBuffer(1, lengthFrames, context.sampleRate);
    const output = segment.getChannelData(0);
    const input = take.buffer.getChannelData(0);
    const fadeFrames = Math.min(
      toFrames(FADE_SECONDS, context.sampleRate),
      Math.floor(input.length / 2),
    );
    const position = getLoopOffsetFrames(take.startFrame, masterLoop);

    for (let i = 0; i < input.length; i++) {
      let gain = 1;
      if (fades.fadeIn && i < fadeFrames) {
        gain = i / fadeFrames;
      } else if (fades.fadeOut && i >= input.length - fadeFrames) {
        gain = (input.length - 1 - i) / fadeFrames;
      }
      const outputIndex = (position + i) % lengthFrames;
      output[outputIndex] = (output[outputIndex] ?? 0) + (input[i] ?? 0) * gain;
    }
    return segment;
  }

  /** Sums equal-length buffers into one, e.g. an overdub pass's segments into its layer. */
  mixBuffers(buffers: readonly AudioBuffer[]): AudioBuffer {
    const context = this.#requireGraph().context;
    const lengthFrames = buffers[0]?.length ?? 0;
    const mix = context.createBuffer(1, Math.max(1, lengthFrames), context.sampleRate);
    const output = mix.getChannelData(0);
    for (const buffer of buffers) {
      const input = buffer.getChannelData(0);
      for (let i = 0; i < lengthFrames; i++) {
        output[i] = (output[i] ?? 0) + (input[i] ?? 0);
      }
    }
    return mix;
  }

  /**
   * Starts looping a track's layers, phase-locked to the master loop, at `startFrame`
   * (a loop boundary) or as soon as possible.
   *
   * Each buffer gets its own looping AudioBufferSourceNode. Looping sources wrap inside
   * the audio thread with no gap, so loop points are seamless. All of them are started
   * with the same `when` and `offset`, which keeps every layer and track sample-aligned.
   */
  playTrack(
    trackId: number,
    layers: readonly Layer[],
    masterLoop: MasterLoop,
    startFrame?: number,
  ): void {
    const { context } = this.#requireGraph();
    this.stopTrack(trackId);
    const playback = this.#getTrackPlayback(trackId);

    const earliestFrame = this.getPlaybackStartFrame();
    const playFrame = Math.max(startFrame ?? earliestFrame, earliestFrame);
    const when = playFrame / context.sampleRate;

    const fade = context.createGain();
    fade.gain.value = 0;
    fade.gain.setValueAtTime(0, when);
    fade.gain.linearRampToValueAtTime(1, when + FADE_SECONDS);
    fade.connect(playback.gain);

    const voice: PlaybackVoice = { fade, masterLoop, layerIdToParts: new Map() };
    for (const layer of layers) {
      voice.layerIdToParts.set(layer.layerId, [
        this.#startPart(context, voice, layer.buffers, playFrame, false),
      ]);
    }
    playback.voice = voice;
  }

  /**
   * Adds buffers to a layer of a playing track (an overdub segment, or a redone layer),
   * fading in so joining mid-waveform doesn't click. Does nothing if the track isn't playing.
   */
  addLayerBuffers(trackId: number, layerId: number, buffers: readonly AudioBuffer[]): void {
    const voice = this.#trackIdToPlayback.get(trackId)?.voice;
    if (!voice) {
      return;
    }
    const { context } = voice.fade;
    const part = this.#startPart(context, voice, buffers, this.getPlaybackStartFrame(), true);
    voice.layerIdToParts.set(layerId, [...(voice.layerIdToParts.get(layerId) ?? []), part]);
  }

  /**
   * Swaps a playing layer's buffers for equivalent ones (an overdub pass's segments for
   * their mix). The old sources stop on exactly the frame the new ones start, so the
   * output doesn't change at all.
   */
  replaceLayerBuffers(trackId: number, layerId: number, buffers: readonly AudioBuffer[]): void {
    const voice = this.#trackIdToPlayback.get(trackId)?.voice;
    const oldParts = voice?.layerIdToParts.get(layerId);
    if (!voice || !oldParts) {
      return;
    }
    const { context } = voice.fade;
    const swapFrame = this.getPlaybackStartFrame();
    const part = this.#startPart(context, voice, buffers, swapFrame, false);
    this.#stopParts(oldParts, swapFrame / context.sampleRate);
    voice.layerIdToParts.set(layerId, [part]);
  }

  /** Fades one layer out of a playing track (undo, or a discarded overdub). */
  removeLayer(trackId: number, layerId: number): void {
    const voice = this.#trackIdToPlayback.get(trackId)?.voice;
    const parts = voice?.layerIdToParts.get(layerId);
    if (!voice || !parts) {
      return;
    }
    voice.layerIdToParts.delete(layerId);
    const now = voice.fade.context.currentTime;
    for (const part of parts) {
      this.#fadeOut(part.gain, now);
    }
    this.#stopParts(parts, now + FADE_SECONDS);
  }

  /** Fades the track out and stops it; nothing is cleared. */
  stopTrack(trackId: number): void {
    const playback = this.#trackIdToPlayback.get(trackId);
    const voice = playback?.voice;
    if (!playback || !voice) {
      return;
    }
    playback.voice = undefined;

    const { context } = voice.fade;
    const now = context.currentTime;
    this.#fadeOut(voice.fade, now);
    const parts = [...voice.layerIdToParts.values()].flat();
    this.#stopParts(parts, now + FADE_SECONDS, voice.fade);
  }

  ngOnDestroy(): void {
    this.#abortCalibration('cancelled');
    for (const playback of this.#trackIdToPlayback.values()) {
      if (playback.voice) {
        this.#disconnectParts([...playback.voice.layerIdToParts.values()].flat());
        playback.voice.fade.disconnect();
      }
      playback.gain.disconnect();
    }
    this.#trackIdToPlayback.clear();
    for (const take of this.#takeIdToTake.values()) {
      take.pending?.reject(new Error('Audio engine destroyed'));
    }
    this.#takeIdToTake.clear();
    this.#disconnectInput();
    this.#getMediaDevices()?.removeEventListener('devicechange', this.#refreshDevicesOnChange);

    if (this.#graph) {
      const { context, inputGain, monitorGain, loopBus, recorder } = this.#graph;
      recorder.port.onmessage = null;
      recorder.onprocessorerror = null;
      context.onstatechange = null;
      recorder.port.close();
      for (const node of [inputGain, monitorGain, loopBus, recorder]) {
        node.disconnect();
      }
      void context.close();
      this.#graph = undefined;
    }
    this.#inputInterrupted.complete();
    this.#recordingStarted.complete();
  }

  #createGraph(context: AudioContext): AudioGraph {
    // Interfaces usually put the guitar on input 1 of a stereo pair. A normal stereo-to-
    // mono mix would halve its level, so 'discrete' + 1 channel keeps only channel 1.
    const inputGain = context.createGain();
    inputGain.channelCount = 1;
    inputGain.channelCountMode = 'explicit';
    inputGain.channelInterpretation = 'discrete';
    inputGain.gain.value = this.#inputGain();

    const monitorGain = context.createGain();
    monitorGain.gain.value = this.#isMonitorEnabled() ? 1 : 0;

    const loopBus = context.createGain();

    const recorderOptions: RecorderOptions = {
      chunkFrames: RECORDER_CHUNK_FRAMES,
      historyFrames: Math.round(context.sampleRate * RECORDER_HISTORY_SECONDS),
      levelIntervalFrames: Math.round(context.sampleRate / LEVEL_UPDATES_PER_SECOND),
    };
    // The recorder outputs silence, but it is still wired to the destination: Chrome only
    // runs nodes the destination "pulls" on, so this keeps process() being called.
    const recorder = new AudioWorkletNode(context, RECORDER_PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: recorderOptions,
    });
    recorder.port.onmessage = (event: MessageEvent<RecorderEvent>) =>
      this.#handleRecorderEvent(event.data);
    recorder.onprocessorerror = () => this.#handleRecorderFailure();

    inputGain.connect(recorder);
    inputGain.connect(monitorGain);
    monitorGain.connect(context.destination);
    recorder.connect(context.destination);
    loopBus.connect(context.destination);

    return { context, inputGain, monitorGain, loopBus, recorder };
  }

  async #connectInput(deviceId?: string): Promise<void> {
    const mediaDevices = this.#getMediaDevices();
    const graph = this.#graph;
    if (!mediaDevices || !graph) {
      return;
    }

    // Browser voice processing is built for calls and wrecks instrument audio
    // (gating, pumping, and filtering), so it is all switched off.
    const constraints: MediaTrackConstraints = {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    };

    let stream: MediaStream;
    try {
      stream = await mediaDevices.getUserMedia({ audio: constraints });
    } catch (error) {
      this.#disconnectInput();
      this.#error.set(toAudioErrorCode(error));
      await this.#refreshDevices();
      return;
    }

    this.#disconnectInput();
    const source = graph.context.createMediaStreamSource(stream);
    source.connect(graph.inputGain);
    this.#input = { stream, source };

    const [track] = stream.getAudioTracks();
    track?.addEventListener('ended', () => this.#handleInputEnded(stream));

    this.#selectedDeviceId.set(track?.getSettings().deviceId ?? deviceId ?? '');
    this.#isInputConnected.set(true);
    this.#error.set(null);
    await this.#refreshDevices();
    // Monitoring a built-in mic through speakers squeals, so it defaults off there.
    this.setMonitorEnabled(!this.isBuiltInMicSelected());
  }

  #disconnectInput(): void {
    if (!this.#input) {
      return;
    }
    this.#input.source.disconnect();
    for (const track of this.#input.stream.getTracks()) {
      track.stop();
    }
    this.#input = undefined;
    this.#isInputConnected.set(false);
  }

  #handleInputEnded(stream: MediaStream): void {
    if (this.#input?.stream !== stream) {
      return;
    }
    this.#disconnectInput();
    this.#error.set('device-unplugged');
    this.#abortCalibration('input-lost');
    this.#inputInterrupted.next();
    void this.#refreshDevices();
  }

  /**
   * The worklet threw and has stopped for good, so nothing more can be recorded. Takes in
   * progress are discarded; existing loops play on, since playback doesn't use it.
   */
  #handleRecorderFailure(): void {
    this.#error.set('recorder-failed');
    this.#abortCalibration('input-lost');
    this.#inputInterrupted.next();
    for (const [takeId, take] of this.#takeIdToTake) {
      this.#takeIdToTake.delete(takeId);
      take.pending?.reject(new Error('Recorder failed'));
    }
  }

  #abortCalibration(reason: CalibrationFailure): void {
    const calibration = this.#calibration;
    if (!calibration || calibration.abortReason) {
      return;
    }
    calibration.abortReason = reason;
    this.cancelRecording(calibration.takeId);
  }

  #finishCalibration(calibration: Calibration): void {
    for (const source of calibration.sources) {
      source.stop();
      source.disconnect();
    }
    calibration.output.disconnect();
    this.#calibration = undefined;
    this.#isCalibrating.set(false);
    if (this.#graph) {
      this.#rampGain(this.#graph.monitorGain, this.#isMonitorEnabled() ? 1 : 0);
      this.#rampGain(this.#graph.loopBus, 1);
    }
  }

  readonly #refreshDevicesOnChange = (): void => {
    void this.#refreshDevices();
  };

  async #refreshDevices(): Promise<void> {
    const mediaDevices = this.#getMediaDevices();
    if (!mediaDevices) {
      return;
    }
    const devices = await mediaDevices.enumerateDevices();
    const inputDevices = devices
      .filter((device) => device.kind === 'audioinput')
      .map((device, index) => ({
        deviceId: device.deviceId,
        label: device.label || `Input ${index + 1}`,
      }));
    this.#inputDevices.set(inputDevices);

    if (inputDevices.length === 0 && !this.#input) {
      this.#error.set('no-input-device');
    }
  }

  #postStop(takeId: number, take: Take, context: AudioContext): void {
    if (!take.pending) {
      return;
    }
    // Loop takes record a little extra for the loop-point crossfade.
    const crossfadeFrames =
      take.kind === 'loop' ? toFrames(LOOP_CROSSFADE_SECONDS, context.sampleRate) : 0;
    this.#postToRecorder({
      type: 'stop',
      takeId,
      stopFrame: take.pending.stopFrame + take.latencyFrames + crossfadeFrames,
    });
  }

  #handleRecorderEvent(event: RecorderEvent): void {
    switch (event.type) {
      case 'level':
        this.#inputLevel.set({ peak: event.peak, rms: event.rms });
        break;
      case 'started': {
        const take = this.#takeIdToTake.get(event.takeId);
        if (take) {
          this.#recordingStarted.next({
            takeId: event.takeId,
            startFrame: event.startFrame - take.latencyFrames,
          });
        }
        break;
      }
      case 'chunk':
        // Copy the audio out, then hand the original back so the worklet can reuse it.
        // Chunks from a cancelled take are dropped but still recycled.
        this.#takeIdToTake.get(event.takeId)?.chunks.push(event.chunk.slice(0, event.length));
        this.#postToRecorder({ type: 'recycle', chunk: event.chunk }, [event.chunk.buffer]);
        break;
      case 'recorded':
        this.#completeTake(event.takeId, event.startFrame, event.lengthFrames);
        break;
    }
  }

  #completeTake(takeId: number, capturedStartFrame: number, lengthFrames: number): void {
    const take = this.#takeIdToTake.get(takeId);
    const pending = take?.pending;
    if (!take || !pending) {
      return;
    }
    this.#takeIdToTake.delete(takeId);

    // Back onto the loop timeline: the audio captured at frame F + latency belongs at F.
    const startFrame = capturedStartFrame - take.latencyFrames;
    const takeFrames = Math.min(lengthFrames, pending.stopFrame - startFrame);
    if (takeFrames <= 0 || !this.#graph) {
      pending.reject(new Error('Recording was empty'));
      return;
    }
    const { context } = this.#graph;
    const samples = this.#joinChunks(take.chunks, lengthFrames);
    const buffer =
      take.kind === 'loop'
        ? this.#createLoopBuffer(context, samples, takeFrames)
        : this.#createRawBuffer(context, samples, takeFrames);
    pending.resolve({ buffer, startFrame });
  }

  #joinChunks(chunks: Float32Array[], lengthFrames: number): Float32Array {
    const samples = new Float32Array(lengthFrames);
    let offset = 0;
    for (const chunk of chunks) {
      if (offset >= lengthFrames) {
        break;
      }
      const count = Math.min(chunk.length, lengthFrames - offset);
      samples.set(chunk.subarray(0, count), offset);
      offset += count;
    }
    return samples;
  }

  #createRawBuffer(
    context: AudioContext,
    samples: Float32Array,
    lengthFrames: number,
  ): AudioBuffer {
    const buffer = context.createBuffer(1, lengthFrames, context.sampleRate);
    buffer.getChannelData(0).set(samples.subarray(0, lengthFrames));
    return buffer;
  }

  /**
   * Builds the loop buffer and smooths its loop point.
   *
   * When a loop wraps, its last sample is followed by its first, and those two are
   * usually far apart: an audible click. The few ms recorded just after the loop end are
   * the natural continuation of the last sample, so blending them into the start
   * (fading the tail out while the real start fades in) makes the wrap continuous.
   * Equal-power curves (sin/cos) keep the loudness steady through the blend.
   */
  #createLoopBuffer(context: AudioContext, samples: Float32Array, loopFrames: number): AudioBuffer {
    const buffer = this.#createRawBuffer(context, samples, loopFrames);
    const channel = buffer.getChannelData(0);

    const crossfadeFrames = Math.min(
      samples.length - loopFrames,
      toFrames(LOOP_CROSSFADE_SECONDS, context.sampleRate),
      loopFrames,
    );
    for (let i = 0; i < crossfadeFrames; i++) {
      const position = (i / crossfadeFrames) * (Math.PI / 2);
      const startSample = samples[i] ?? 0;
      const tailSample = samples[loopFrames + i] ?? 0;
      channel[i] = startSample * Math.sin(position) + tailSample * Math.cos(position);
    }
    return buffer;
  }

  #startPart(
    context: BaseAudioContext,
    voice: PlaybackVoice,
    buffers: readonly AudioBuffer[],
    playFrame: number,
    shouldFadeIn: boolean,
  ): PlaybackPart {
    const when = playFrame / context.sampleRate;
    const offset = getLoopOffsetFrames(playFrame, voice.masterLoop) / context.sampleRate;

    const gain = context.createGain();
    if (shouldFadeIn) {
      gain.gain.value = 0;
      gain.gain.setValueAtTime(0, when);
      gain.gain.linearRampToValueAtTime(1, when + FADE_SECONDS);
    }
    gain.connect(voice.fade);

    const sources = buffers.map((buffer) => {
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      source.connect(gain);
      source.start(when, offset);
      return source;
    });
    return { gain, sources };
  }

  /** Stops parts at `when`, then disconnects them (and `extraNode`) once they've ended. */
  #stopParts(parts: readonly PlaybackPart[], when: number, extraNode?: AudioNode): void {
    const firstSource = parts.flatMap((part) => part.sources)[0];
    const disconnect = () => {
      this.#disconnectParts(parts);
      extraNode?.disconnect();
    };
    if (!firstSource) {
      disconnect();
      return;
    }
    // All sources stop at the same moment, so one 'ended' covers them all.
    firstSource.onended = disconnect;
    for (const part of parts) {
      for (const source of part.sources) {
        source.stop(when);
      }
    }
  }

  #disconnectParts(parts: readonly PlaybackPart[]): void {
    for (const part of parts) {
      for (const source of part.sources) {
        source.onended = null;
        source.disconnect();
      }
      part.gain.disconnect();
    }
  }

  #fadeOut(node: GainNode, now: number): void {
    node.gain.cancelScheduledValues(now);
    // setTargetAtTime approaches 0 exponentially; three time constants is ~95% of the way.
    node.gain.setTargetAtTime(0, now, FADE_SECONDS / 3);
  }

  #getTrackPlayback(trackId: number): TrackPlayback {
    const existing = this.#trackIdToPlayback.get(trackId);
    if (existing) {
      return existing;
    }
    const { context, loopBus } = this.#requireGraph();
    const gain = context.createGain();
    gain.connect(loopBus);
    const playback: TrackPlayback = { gain, voice: undefined };
    this.#trackIdToPlayback.set(trackId, playback);
    return playback;
  }

  #rampGain(node: GainNode, value: number): void {
    node.gain.setTargetAtTime(value, node.context.currentTime, GAIN_TIME_CONSTANT_SECONDS);
  }

  #postToRecorder(command: RecorderCommand, transfer: Transferable[] = []): void {
    this.#graph?.recorder.port.postMessage(command, transfer);
  }

  #requireGraph(): AudioGraph {
    if (!this.#graph) {
      throw new Error('AudioEngine.start() must be called first');
    }
    return this.#graph;
  }

  #getMediaDevices(): MediaDevices | undefined {
    return this.#document.defaultView?.navigator.mediaDevices;
  }
}
