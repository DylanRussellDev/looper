import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { AudioEngine } from './audio-engine';
import { CALIBRATION_CLICK_COUNT, createClickSamples } from './latency-calibration';
import { RecorderCommand, RecorderEvent } from './recorder-messages';

// Minimal Web Audio stand-ins: enough surface for the engine's routing calls.
function createFakeNode(context: FakeAudioContext) {
  return {
    context,
    gain: {
      value: 1,
      setTargetAtTime: vi.fn(),
      setValueAtTime: vi.fn(),
      linearRampToValueAtTime: vi.fn(),
      cancelScheduledValues: vi.fn(),
    },
    connect: vi.fn(),
    disconnect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    onended: null as (() => void) | null,
    buffer: null as AudioBuffer | null,
    loop: false,
    channelCount: 2,
    channelCountMode: 'max',
    channelInterpretation: 'speakers',
  };
}

const contexts: FakeAudioContext[] = [];
const workletNodes: FakeAudioWorkletNode[] = [];

class FakeAudioContext {
  currentTime = 1;
  state: AudioContextState = 'running';
  onstatechange: (() => void) | null = null;
  baseLatency = 0.01;
  outputLatency = 0.02;
  sampleRate = 48_000;
  destination = {};
  audioWorklet = { addModule: vi.fn(async () => undefined) };
  resume = vi.fn(async () => undefined);
  close = vi.fn(async () => undefined);
  createGain = vi.fn(() => createFakeNode(this));
  createMediaStreamSource = vi.fn(() => createFakeNode(this));
  createBufferSource = vi.fn(() => createFakeNode(this));
  createBuffer = vi.fn((_channels: number, length: number) => {
    const data = new Float32Array(length);
    return { length, getChannelData: () => data };
  });

  constructor() {
    contexts.push(this);
  }
}

class FakeAudioWorkletNode {
  port = {
    postMessage: vi.fn(),
    close: vi.fn(),
    onmessage: null as ((event: { data: RecorderEvent }) => void) | null,
  };
  connect = vi.fn();
  disconnect = vi.fn();
  onprocessorerror: (() => void) | null = null;

  constructor() {
    workletNodes.push(this);
  }

  emit(data: RecorderEvent): void {
    this.port.onmessage?.({ data });
  }
}

function createFakeTrack(deviceId: string) {
  const listeners: Record<string, () => void> = {};
  return {
    stop: vi.fn(),
    getSettings: () => ({ deviceId }),
    addEventListener: (type: string, listener: () => void) => (listeners[type] = listener),
    fire: (type: string) => listeners[type]?.(),
  };
}

function createFakeStream(track: ReturnType<typeof createFakeTrack>) {
  return { getAudioTracks: () => [track], getTracks: () => [track] };
}

describe('AudioEngine', () => {
  let engine: AudioEngine;
  let mediaDevices: {
    getUserMedia: ReturnType<typeof vi.fn>;
    enumerateDevices: ReturnType<typeof vi.fn>;
    addEventListener: ReturnType<typeof vi.fn>;
    removeEventListener: ReturnType<typeof vi.fn>;
  };
  let track: ReturnType<typeof createFakeTrack>;

  function setMediaDevices(value: unknown): void {
    Object.defineProperty(window.navigator, 'mediaDevices', { value, configurable: true });
  }

  beforeEach(() => {
    contexts.length = 0;
    workletNodes.length = 0;
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode);

    track = createFakeTrack('interface');
    mediaDevices = {
      getUserMedia: vi.fn(async () => createFakeStream(track)),
      enumerateDevices: vi.fn(async () => [
        { kind: 'audioinput', deviceId: 'interface', label: 'Focusrite USB Audio' },
        { kind: 'audioinput', deviceId: 'laptop', label: 'Microphone Array (Realtek Audio)' },
        { kind: 'audiooutput', deviceId: 'speakers', label: 'Speakers' },
      ]),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    setMediaDevices(mediaDevices);

    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
    engine = TestBed.inject(AudioEngine);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setMediaDevices(undefined);
  });

  it('reports an unsupported browser', async () => {
    setMediaDevices(undefined);
    await engine.start();

    expect(engine.status()).toBe('idle');
    expect(engine.error()).toBe('unsupported');
  });

  it('starts, opens the input with voice processing off, and lists input devices', async () => {
    await engine.start();

    expect(engine.status()).toBe('running');
    expect(engine.isInputConnected()).toBe(true);
    expect(engine.selectedDeviceId()).toBe('interface');
    expect(engine.inputDevices().map((device) => device.deviceId)).toEqual(['interface', 'laptop']);
    expect(mediaDevices.getUserMedia).toHaveBeenCalledWith({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    expect(engine.isMonitorEnabled()).toBe(true);
  });

  it('turns monitoring off when a built-in mic is selected', async () => {
    await engine.start();
    const laptopTrack = createFakeTrack('laptop');
    mediaDevices.getUserMedia.mockResolvedValueOnce(createFakeStream(laptopTrack));

    await engine.selectDevice('laptop');

    expect(engine.isBuiltInMicSelected()).toBe(true);
    expect(engine.isMonitorEnabled()).toBe(false);
    expect(track.stop).toHaveBeenCalled();
  });

  it('reports a blocked permission and keeps the engine running', async () => {
    mediaDevices.getUserMedia.mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError'));
    await engine.start();

    expect(engine.status()).toBe('running');
    expect(engine.isInputConnected()).toBe(false);
    expect(engine.error()).toBe('permission-denied');
  });

  it('reports an unplugged device and signals the interruption', async () => {
    await engine.start();
    const interrupted = vi.fn();
    engine.inputInterrupted$.subscribe(interrupted);

    track.fire('ended');

    expect(engine.error()).toBe('device-unplugged');
    expect(engine.isInputConnected()).toBe(false);
    expect(interrupted).toHaveBeenCalledOnce();
  });

  describe('recording', () => {
    // 5 ms at 48 kHz.
    const crossfadeFrames = 240;

    it('records past the loop end and crossfades that tail into the loop start', async () => {
      await engine.start();
      const recorder = workletNodes[0]!;

      const takeId = engine.startRecording(48_000);
      expect(recorder.port.postMessage).toHaveBeenCalledWith(
        { type: 'record', takeId, startFrame: 48_000 },
        [],
      );

      const take = engine.stopRecording(takeId, 48_300);
      expect(recorder.port.postMessage).toHaveBeenCalledWith(
        { type: 'stop', takeId, stopFrame: 48_300 + crossfadeFrames },
        [],
      );

      // 300 loop frames at 0.5, then the 240-frame tail at 0.25, split over two chunks.
      const first = new Float32Array(256).fill(0.5);
      const second = new Float32Array(512);
      second.fill(0.5, 0, 44);
      second.fill(0.25, 44, 284);
      recorder.emit({ type: 'chunk', takeId, chunk: first, length: 256 });
      recorder.emit({ type: 'chunk', takeId, chunk: second, length: 284 });
      recorder.emit({ type: 'recorded', takeId, startFrame: 48_000, lengthFrames: 540 });

      const { buffer, startFrame } = await take;
      const samples = buffer.getChannelData(0);
      expect(startFrame).toBe(48_000);
      expect(buffer.length).toBe(300);
      // The first sample is pure tail (continuing on from the last), blending into the start.
      expect(samples[0]).toBeCloseTo(0.25);
      expect(samples[120]).toBeCloseTo(0.5 * Math.SQRT1_2 + 0.25 * Math.SQRT1_2);
      expect(samples[crossfadeFrames]).toBe(0.5);
      expect(samples[299]).toBe(0.5);
    });

    it('keeps concurrent takes apart and recycles every chunk', async () => {
      await engine.start();
      const recorder = workletNodes[0]!;
      const firstTakeId = engine.startRecording(0);
      const secondTakeId = engine.startRecording(0);
      const firstTake = engine.stopRecording(firstTakeId, 4);
      const secondTake = engine.stopRecording(secondTakeId, 4);

      recorder.emit({
        type: 'chunk',
        takeId: secondTakeId,
        chunk: new Float32Array(4).fill(2),
        length: 4,
      });
      recorder.emit({
        type: 'chunk',
        takeId: firstTakeId,
        chunk: new Float32Array(4).fill(1),
        length: 4,
      });
      recorder.emit({ type: 'recorded', takeId: firstTakeId, startFrame: 0, lengthFrames: 4 });
      recorder.emit({ type: 'recorded', takeId: secondTakeId, startFrame: 0, lengthFrames: 4 });

      expect((await firstTake).buffer.getChannelData(0)[3]).toBe(1);
      expect((await secondTake).buffer.getChannelData(0)[3]).toBe(2);
      const recycled = recorder.port.postMessage.mock.calls.filter(
        ([command]) => (command as { type: string }).type === 'recycle',
      );
      expect(recycled).toHaveLength(2);
    });

    it('reports when a take actually starts', async () => {
      await engine.start();
      const started = vi.fn();
      engine.recordingStarted$.subscribe(started);
      const takeId = engine.startRecording(96_000);

      workletNodes[0]!.emit({ type: 'started', takeId, startFrame: 96_000 });

      expect(started).toHaveBeenCalledWith({ takeId, startFrame: 96_000 });
    });

    it('rejects the pending take when recording is cancelled', async () => {
      await engine.start();
      const takeId = engine.startRecording();
      const take = engine.stopRecording(takeId);

      engine.cancelRecording(takeId);

      await expect(take).rejects.toThrow('Recording cancelled');
      expect(workletNodes[0]!.port.postMessage).toHaveBeenCalledWith(
        { type: 'cancel', takeId },
        [],
      );
    });
  });

  describe('playback', () => {
    const masterLoop = { anchorFrame: 0, lengthFrames: 48_000 };
    const buffer = { length: 48_000 } as AudioBuffer;
    const layers = [{ layerId: 1, buffers: [buffer] }];

    function getLastSource() {
      const context = contexts[0]!;
      return context.createBufferSource.mock.results.at(-1)!.value as ReturnType<
        typeof createFakeNode
      >;
    }

    it('starts as soon as possible, at the matching position in the loop', async () => {
      await engine.start();
      engine.playTrack(1, layers, masterLoop);

      // currentTime is 1 s; with the 20 ms lookahead that is frame 48 960, 960 into the loop.
      const source = getLastSource();
      expect(source.loop).toBe(true);
      expect(source.start).toHaveBeenCalledWith(48_960 / 48_000, 960 / 48_000);
    });

    it('starts from the top of the loop on a scheduled boundary', async () => {
      await engine.start();
      engine.playTrack(1, layers, masterLoop, 96_000);

      expect(getLastSource().start).toHaveBeenCalledWith(2, 0);
    });

    it('fades out, stops and then disconnects a track', async () => {
      await engine.start();
      engine.playTrack(1, layers, masterLoop);
      const source = getLastSource();

      engine.stopTrack(1);

      expect(source.stop).toHaveBeenCalledWith(1.004);
      expect(source.disconnect).not.toHaveBeenCalled();
      source.onended?.();
      expect(source.disconnect).toHaveBeenCalled();
    });

    it('adds buffers to a playing layer in phase, fading in', async () => {
      await engine.start();
      engine.playTrack(1, layers, masterLoop);

      engine.addLayerBuffers(1, 2, [buffer]);

      const source = getLastSource();
      expect(source.start).toHaveBeenCalledWith(48_960 / 48_000, 960 / 48_000);
      const partGain = contexts[0]!.createGain.mock.results.at(-1)!.value as ReturnType<
        typeof createFakeNode
      >;
      expect(partGain.gain.linearRampToValueAtTime).toHaveBeenCalledWith(1, 1.024);
    });

    it('ignores layer changes on a track that is not playing', async () => {
      await engine.start();
      const sourcesBefore = contexts[0]!.createBufferSource.mock.calls.length;

      engine.addLayerBuffers(1, 2, [buffer]);
      engine.replaceLayerBuffers(1, 2, [buffer]);
      engine.removeLayer(1, 2);

      expect(contexts[0]!.createBufferSource.mock.calls.length).toBe(sourcesBefore);
    });

    it('swaps a layer on exactly the frame the new buffers start', async () => {
      await engine.start();
      engine.playTrack(1, layers, masterLoop);
      const oldSource = getLastSource();

      engine.replaceLayerBuffers(1, 1, [buffer]);

      const newSource = getLastSource();
      expect(newSource).not.toBe(oldSource);
      expect(oldSource.stop).toHaveBeenCalledWith(48_960 / 48_000);
      expect(newSource.start).toHaveBeenCalledWith(48_960 / 48_000, 960 / 48_000);
    });

    it('fades out and stops only the removed layer', async () => {
      await engine.start();
      engine.playTrack(1, [...layers, { layerId: 2, buffers: [buffer] }], masterLoop);
      const [baseSource, overdubSource] = contexts[0]!.createBufferSource.mock.results
        .slice(-2)
        .map((result) => result.value as ReturnType<typeof createFakeNode>);

      engine.removeLayer(1, 2);

      expect(overdubSource!.stop).toHaveBeenCalledWith(1.004);
      expect(baseSource!.stop).not.toHaveBeenCalled();
    });

    it('ramps a track volume', async () => {
      await engine.start();
      engine.setTrackVolume(1, 0.5);

      const trackGain = contexts[0]!.createGain.mock.results.at(-1)!.value as ReturnType<
        typeof createFakeNode
      >;
      expect(trackGain.gain.setTargetAtTime).toHaveBeenCalledWith(0.5, 1, 0.01);
    });
  });

  describe('overdub segments', () => {
    const masterLoop = { anchorFrame: 0, lengthFrames: 1000 };

    function createTakeBuffer(samples: number[]): AudioBuffer {
      const data = Float32Array.from(samples);
      return { length: data.length, getChannelData: () => data } as unknown as AudioBuffer;
    }

    it('records segments raw, with no crossfade tail', async () => {
      await engine.start();
      const recorder = workletNodes[0]!;
      const takeId = engine.startRecording(100, 'segment');
      const take = engine.stopRecording(takeId, 400);

      expect(recorder.port.postMessage).toHaveBeenCalledWith(
        { type: 'stop', takeId, stopFrame: 400 },
        [],
      );
      recorder.emit({ type: 'chunk', takeId, chunk: new Float32Array(300).fill(0.5), length: 300 });
      recorder.emit({ type: 'recorded', takeId, startFrame: 100, lengthFrames: 300 });

      const { buffer } = await take;
      expect(buffer.length).toBe(300);
      expect(buffer.getChannelData(0)[0]).toBe(0.5);
    });

    it('can end a take earlier, and returns the same result', async () => {
      await engine.start();
      const takeId = engine.startRecording(0, 'segment');
      const first = engine.stopRecording(takeId, 1000);
      const second = engine.stopRecording(takeId, 600);
      const later = engine.stopRecording(takeId, 900);

      expect(second).toBe(first);
      expect(later).toBe(first);
      expect(workletNodes[0]!.port.postMessage).toHaveBeenLastCalledWith(
        { type: 'stop', takeId, stopFrame: 600 },
        [],
      );
    });

    it('places a segment at its loop position, wrapping past the loop end', async () => {
      await engine.start();
      const segment = engine.createLayerSegment(
        { buffer: createTakeBuffer([1, 2, 3, 4]), startFrame: 2998 },
        masterLoop,
        { fadeIn: false, fadeOut: false },
      );

      const samples = segment.getChannelData(0);
      expect(segment.length).toBe(1000);
      expect([samples[998], samples[999], samples[0], samples[1], samples[2]]).toEqual([
        1, 2, 3, 4, 0,
      ]);
    });

    it('fades the start and end of a pass', async () => {
      await engine.start();
      const segment = engine.createLayerSegment(
        { buffer: createTakeBuffer(new Array(1000).fill(1)), startFrame: 0 },
        masterLoop,
        { fadeIn: true, fadeOut: true },
      );

      const samples = segment.getChannelData(0);
      expect(samples[0]).toBe(0);
      expect(samples[500]).toBe(1);
      expect(samples[999]).toBe(0);
    });

    it('mixes buffers by summing them', async () => {
      await engine.start();
      const mix = engine.mixBuffers([createTakeBuffer([1, 2, 0]), createTakeBuffer([0.5, 0, 3])]);

      expect(Array.from(mix.getChannelData(0))).toEqual([1.5, 2, 3]);
    });
  });

  describe('latency compensation', () => {
    it('records later by the offset and reports loop-timeline frames', async () => {
      await engine.start();
      const recorder = workletNodes[0]!;
      engine.setLatencyOffset(10);

      // 10 ms at 48 kHz is 480 frames.
      const takeId = engine.startRecording(48_000);
      expect(recorder.port.postMessage).toHaveBeenCalledWith(
        { type: 'record', takeId, startFrame: 48_480 },
        [],
      );
      const take = engine.stopRecording(takeId, 48_300);
      expect(recorder.port.postMessage).toHaveBeenCalledWith(
        { type: 'stop', takeId, stopFrame: 48_300 + 480 + 240 },
        [],
      );

      recorder.emit({ type: 'chunk', takeId, chunk: new Float32Array(540), length: 540 });
      recorder.emit({ type: 'recorded', takeId, startFrame: 48_480, lengthFrames: 540 });
      const { startFrame, buffer } = await take;
      expect(startFrame).toBe(48_000);
      expect(buffer.length).toBe(300);
    });

    it('clamps the offset to a sensible range', () => {
      engine.setLatencyOffset(-20);
      expect(engine.latencyOffsetMs()).toBe(0);
      engine.setLatencyOffset(10_000);
      expect(engine.latencyOffsetMs()).toBe(500);
      engine.setLatencyOffset(Number.NaN);
      expect(engine.latencyOffsetMs()).toBe(0);
    });

    it('reports the browser output latency as a starting point', async () => {
      await engine.start();
      expect(engine.reportedOutputLatencyMs()).toBe(30);
    });
  });

  describe('latency calibration', () => {
    // Playback can start at frame 48 960 (1 s + 20 ms lookahead); the first click is 100 ms later.
    const firstClickFrame = 53_760;
    const spacingFrames = 28_800;
    const windowFrames = 24_000;

    function getCalibrationTakeId(): number {
      const record = workletNodes[0]!.port.postMessage.mock.calls
        .map(([command]) => command as RecorderCommand)
        .find((command) => command.type === 'record');
      return record && record.type === 'record' ? record.takeId : 0;
    }

    /** Delivers a recording in which every click comes back `delayFrames` later. */
    function deliverRecording(takeId: number, delayFrames: number | null): void {
      const lengthFrames = (CALIBRATION_CLICK_COUNT - 1) * spacingFrames + windowFrames;
      const samples = new Float32Array(lengthFrames);
      const click = createClickSamples(48_000);
      for (let i = 0; delayFrames !== null && i < CALIBRATION_CLICK_COUNT; i++) {
        samples.set(click, i * spacingFrames + delayFrames);
      }
      const recorder = workletNodes[0]!;
      recorder.emit({ type: 'chunk', takeId, chunk: samples, length: lengthFrames });
      recorder.emit({ type: 'recorded', takeId, startFrame: firstClickFrame, lengthFrames });
    }

    it('plays clicks, measures the round trip and applies it as the offset', async () => {
      await engine.start();
      engine.setLatencyOffset(200);
      const result = engine.calibrateLatency();
      expect(engine.isCalibrating()).toBe(true);

      const takeId = getCalibrationTakeId();
      // Recorded on the raw clock, ignoring the current offset.
      expect(workletNodes[0]!.port.postMessage).toHaveBeenCalledWith(
        { type: 'record', takeId, startFrame: firstClickFrame },
        [],
      );
      // 25 ms at 48 kHz.
      deliverRecording(takeId, 1200);

      await expect(result).resolves.toBe(25);
      expect(engine.latencyOffsetMs()).toBe(25);
      expect(engine.isCalibrating()).toBe(false);
    });

    it('fails without changing the offset when the clicks are not heard', async () => {
      await engine.start();
      engine.setLatencyOffset(40);
      const result = engine.calibrateLatency();

      deliverRecording(getCalibrationTakeId(), null);

      await expect(result).rejects.toMatchObject({ reason: 'no-signal' });
      expect(engine.latencyOffsetMs()).toBe(40);
      expect(engine.isCalibrating()).toBe(false);
    });

    it('can be cancelled', async () => {
      await engine.start();
      const result = engine.calibrateLatency();

      engine.cancelCalibration();

      await expect(result).rejects.toMatchObject({ reason: 'cancelled' });
      expect(engine.isCalibrating()).toBe(false);
    });

    it('stops when the input is unplugged', async () => {
      await engine.start();
      const result = engine.calibrateLatency();

      track.fire('ended');

      await expect(result).rejects.toMatchObject({ reason: 'input-lost' });
    });

    it('needs a connected input', async () => {
      mediaDevices.getUserMedia.mockRejectedValueOnce(
        new DOMException('denied', 'NotAllowedError'),
      );
      await engine.start();

      await expect(engine.calibrateLatency()).rejects.toMatchObject({ reason: 'no-input' });
    });
  });

  describe('failures', () => {
    it('reports when the browser or system suspends audio, and resumes it', async () => {
      await engine.start();
      const context = contexts[0]!;

      context.state = 'suspended';
      context.onstatechange?.();
      expect(engine.isSuspended()).toBe(true);

      await engine.resumeAudio();
      context.state = 'running';
      context.onstatechange?.();
      expect(context.resume).toHaveBeenCalledTimes(2);
      expect(engine.isSuspended()).toBe(false);
    });

    it('discards takes and reports it when the recorder crashes', async () => {
      await engine.start();
      const interrupted = vi.fn();
      engine.inputInterrupted$.subscribe(interrupted);
      const take = engine.stopRecording(engine.startRecording());

      workletNodes[0]!.onprocessorerror?.();

      expect(engine.error()).toBe('recorder-failed');
      expect(interrupted).toHaveBeenCalledOnce();
      await expect(take).rejects.toThrow('Recorder failed');
    });
  });

  it('reports the audible position, behind the clock by the output latency', async () => {
    await engine.start();

    // 1 s minus 30 ms of output latency.
    expect(engine.getAudibleFrame()).toBe(46_560);
  });

  it('releases the microphone and closes the context on destroy', async () => {
    await engine.start();

    engine.ngOnDestroy();

    expect(track.stop).toHaveBeenCalled();
    expect(workletNodes[0]!.port.close).toHaveBeenCalled();
    expect(contexts[0]!.close).toHaveBeenCalled();
    expect(mediaDevices.removeEventListener).toHaveBeenCalled();
  });
});
