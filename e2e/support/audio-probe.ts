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
}

export interface AudioProbeOptions {
  /** Make getUserMedia fail with this DOMException name. */
  mediaErrorName?: 'NotAllowedError' | 'NotFoundError';
  /**
   * Replace the input with everything the app plays, delayed by this many ms: a cable
   * from the output back to the input, with a known round-trip latency.
   */
  loopbackLatencyMs?: number;
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
  }

  // Everything connected to the speakers is also fed into a delay, and the delay's output
  // is what the app gets as its input source.
  function installLoopback(delaySeconds: number): void {
    const originalConnect = AudioNode.prototype.connect as (
      this: AudioNode,
      destination: AudioNode,
      output?: number,
      input?: number,
    ) => AudioNode;
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
