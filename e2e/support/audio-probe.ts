// Runs inside the page (via addInitScript) before the app loads. It watches the Web Audio
// and media APIs from the outside, so the app needs no test hooks.

export interface ScheduledStart {
  /** Frame the source was scheduled to start on. */
  whenFrame: number;
  /** Where in the buffer it starts, in frames. */
  offsetFrames: number;
  bufferFrames: number;
  isLooping: boolean;
}

export interface AudioProbe {
  starts: ScheduledStart[];
  /** Fires 'ended' on the live input track, as the browser does when a device is unplugged. */
  unplugInput(): void;
  /** Suspends audio, as the browser or OS does when e.g. the output device changes. */
  suspendAudio(): Promise<void>;
  /** With syntheticInputDb: changes the input tone's level. */
  setInputLevel(decibels: number): void;
  /** With syntheticInputDb: the loudest sample sent to the speakers over `durationMs`. */
  getOutputPeak(durationMs: number): Promise<number>;
}

export interface AudioProbeOptions {
  /** Make getUserMedia fail with this DOMException name. */
  mediaErrorName?: 'NotAllowedError' | 'NotFoundError';
  /**
   * Replace the input with everything the app plays, delayed by this many ms: a cable
   * from the output back to the input, with a known round-trip latency.
   */
  loopbackLatencyMs?: number;
  /**
   * Replace the input with a steady tone peaking at this level (dBFS), changeable with
   * setInputLevel, and watch what reaches the speakers with getOutputPeak.
   */
  syntheticInputDb?: number;
}

declare global {
  interface Window {
    audioProbe: AudioProbe;
  }
}

export function installAudioProbe(options: AudioProbeOptions): void {
  const inputTracks: MediaStreamTrack[] = [];
  const contexts: AudioContext[] = [];
  const probe: AudioProbe = {
    starts: [],
    unplugInput: () => {
      for (const track of inputTracks) {
        track.dispatchEvent(new Event('ended'));
      }
    },
    suspendAudio: async () => {
      await Promise.all(contexts.map((context) => context.suspend()));
    },
    setInputLevel: () => undefined,
    getOutputPeak: async () => 0,
  };
  window.audioProbe = probe;

  const OriginalAudioContext = window.AudioContext;
  window.AudioContext = class extends OriginalAudioContext {
    constructor(contextOptions?: AudioContextOptions) {
      super(contextOptions);
      contexts.push(this);
    }
  };

  if (options.loopbackLatencyMs !== undefined) {
    installLoopback(options.loopbackLatencyMs / 1000);
  } else if (options.syntheticInputDb !== undefined) {
    installSyntheticInput(options.syntheticInputDb);
  }

  function getOriginalConnect() {
    return AudioNode.prototype.connect as (
      this: AudioNode,
      destination: AudioNode,
      output?: number,
      input?: number,
    ) => AudioNode;
  }

  // The input is a sine whose level the test sets; everything connected to the speakers
  // is also fed into an analyser, so the test can read what the player would hear.
  function installSyntheticInput(initialDb: number): void {
    const originalConnect = getOriginalConnect();
    const toAmplitude = (decibels: number) => 10 ** (decibels / 20);
    const levels: GainNode[] = [];
    const contextToAnalyser = new WeakMap<BaseAudioContext, AnalyserNode>();
    const analysers: AnalyserNode[] = [];
    let level = toAmplitude(initialDb);

    const getAnalyser = (context: BaseAudioContext): AnalyserNode => {
      let analyser = contextToAnalyser.get(context);
      if (!analyser) {
        analyser = new AnalyserNode(context, { fftSize: 2048 });
        contextToAnalyser.set(context, analyser);
        analysers.push(analyser);
      }
      return analyser;
    };

    AudioNode.prototype.connect = function (
      this: AudioNode,
      destination: AudioNode,
      output?: number,
      input?: number,
    ): AudioNode {
      const result = originalConnect.call(this, destination, output, input);
      if (destination instanceof AudioDestinationNode) {
        originalConnect.call(this, getAnalyser(this.context));
      }
      return result;
    } as typeof AudioNode.prototype.connect;

    AudioContext.prototype.createMediaStreamSource = function (
      this: AudioContext,
    ): MediaStreamAudioSourceNode {
      const tone = new OscillatorNode(this, { frequency: 220 });
      const gain = new GainNode(this, { gain: level });
      originalConnect.call(tone, gain);
      tone.start();
      levels.push(gain);
      return gain as unknown as MediaStreamAudioSourceNode;
    };

    probe.setInputLevel = (decibels) => {
      level = toAmplitude(decibels);
      for (const gain of levels) {
        gain.gain.value = level;
      }
    };
    probe.getOutputPeak = (durationMs) =>
      new Promise((resolve) => {
        const samples = new Float32Array(2048);
        let peak = 0;
        // The analyser holds the last 2048 frames (~43 ms), so reading every 20 ms sees all.
        const timer = setInterval(() => {
          for (const analyser of analysers) {
            analyser.getFloatTimeDomainData(samples);
            for (const sample of samples) {
              peak = Math.max(peak, Math.abs(sample));
            }
          }
        }, 20);
        setTimeout(() => {
          clearInterval(timer);
          resolve(peak);
        }, durationMs);
      });
  }

  // Everything connected to the speakers is also fed into a delay, and the delay's output
  // is what the app gets as its input source.
  function installLoopback(delaySeconds: number): void {
    const originalConnect = getOriginalConnect();
    const contextToLoopback = new WeakMap<BaseAudioContext, DelayNode>();
    const getLoopback = (context: BaseAudioContext): DelayNode => {
      let loopback = contextToLoopback.get(context);
      if (!loopback) {
        loopback = new DelayNode(context, { delayTime: delaySeconds, maxDelayTime: 1 });
        contextToLoopback.set(context, loopback);
      }
      return loopback;
    };

    AudioNode.prototype.connect = function (
      this: AudioNode,
      destination: AudioNode,
      output?: number,
      input?: number,
    ): AudioNode {
      const result = originalConnect.call(this, destination, output, input);
      if (destination instanceof AudioDestinationNode) {
        originalConnect.call(this, getLoopback(this.context));
      }
      return result;
    } as typeof AudioNode.prototype.connect;

    AudioContext.prototype.createMediaStreamSource = function (
      this: AudioContext,
    ): MediaStreamAudioSourceNode {
      const source = this.createGain();
      originalConnect.call(getLoopback(this), source);
      return source as unknown as MediaStreamAudioSourceNode;
    };
  }

  const originalStart = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function (
    this: AudioBufferSourceNode,
    when = 0,
    offset = 0,
    duration?: number,
  ): void {
    const { sampleRate } = this.context;
    probe.starts.push({
      whenFrame: Math.round(when * sampleRate),
      offsetFrames: Math.round(offset * sampleRate),
      bufferFrames: this.buffer?.length ?? 0,
      isLooping: this.loop,
    });
    if (duration === undefined) {
      originalStart.call(this, when, offset);
    } else {
      originalStart.call(this, when, offset, duration);
    }
  };

  const mediaDevices = navigator.mediaDevices;
  const originalGetUserMedia = mediaDevices.getUserMedia.bind(mediaDevices);
  mediaDevices.getUserMedia = async (constraints) => {
    if (options.mediaErrorName) {
      throw new DOMException('Simulated failure', options.mediaErrorName);
    }
    const stream = await originalGetUserMedia(constraints);
    inputTracks.push(...stream.getAudioTracks());
    return stream;
  };

  if (options.mediaErrorName === 'NotFoundError') {
    mediaDevices.enumerateDevices = async () => [];
  }
}
