import { Component, computed, inject, signal } from '@angular/core';

import { AudioEngine } from '../audio/audio-engine';
import {
  GATE_MAX_THRESHOLD_DB,
  GATE_MIN_THRESHOLD_DB,
  NOISE_DETECTION_FAILURE_MESSAGES,
  NOISE_DETECTION_SECONDS,
  NoiseDetectionError,
} from '../audio/noise-gate';
import { LooperStore } from '../looper-store';

// The slider's lowest position, one step below the quietest threshold, turns the gate off.
const OFF_POSITION = GATE_MIN_THRESHOLD_DB - 1;
const DETECTING_MESSAGE = 'Listening to the noise… stay quiet.';

/** Formats decibels with a real minus sign, which reads better and is read out as "minus". */
export function formatDecibels(decibels: number): string {
  const rounded = Math.round(decibels);
  return `${rounded < 0 ? '−' : ''}${Math.abs(rounded)} dB`;
}

@Component({
  imports: [],
  selector: 'app-noise-gate',
  styleUrl: './noise-gate.scss',
  templateUrl: './noise-gate.html',
  host: {
    '(document:keydown.escape)': 'cancelDetection()',
  },
})
export class NoiseGate {
  readonly #engine = inject(AudioEngine);
  readonly #store = inject(LooperStore);

  protected readonly offPosition = OFF_POSITION;
  protected readonly maxThresholdDb = GATE_MAX_THRESHOLD_DB;
  protected readonly detectionSeconds = NOISE_DETECTION_SECONDS;
  protected readonly isDetecting = this.#engine.isDetectingNoise;
  protected readonly isRunning = computed(() => this.#engine.status() === 'running');
  protected readonly sliderPosition = computed(
    () => this.#engine.gateThresholdDb() ?? OFF_POSITION,
  );
  protected readonly thresholdLabel = computed(() => {
    const decibels = this.#engine.gateThresholdDb();
    return decibels === null ? 'Off' : formatDecibels(decibels);
  });
  protected readonly isSliderDisabled = computed(
    () => !this.isRunning() || this.#engine.isMeasuring(),
  );
  // Detection records the input, so like calibration it waits for recording to finish.
  protected readonly detectionBlockedReason = computed(() => {
    if (!this.isRunning() || this.#engine.isMeasuring()) {
      return '';
    }
    if (!this.#engine.isInputConnected()) {
      return 'Connect an input to detect noise.';
    }
    if (this.#engine.inputGain() === 0) {
      return 'Turn up the input gain to detect noise.';
    }
    return this.#store.isAnyTrackCapturing() ? 'Finish recording to detect noise.' : '';
  });
  protected readonly canDetect = computed(
    () =>
      this.isRunning() &&
      !this.#engine.isSuspended() &&
      !this.#engine.isCalibrating() &&
      (this.isDetecting() || this.detectionBlockedReason() === ''),
  );
  protected readonly detectButtonLabel = computed(() =>
    this.isDetecting() ? 'Cancel detection' : 'Detect noise',
  );
  /** Read by the Input panel, which repeats it while its settings are collapsed. */
  readonly detectionMessage = signal('');
  readonly isDetectionFailed = signal(false);

  protected setThreshold(position: number): void {
    this.#engine.setGateThreshold(position <= OFF_POSITION ? null : position);
  }

  /** One button both starts and cancels, so keyboard focus stays put. */
  protected toggleDetection(): void {
    if (this.isDetecting()) {
      this.cancelDetection();
    } else {
      void this.#detect();
    }
  }

  protected cancelDetection(): void {
    this.#engine.cancelNoiseDetection();
  }

  async #detect(): Promise<void> {
    this.isDetectionFailed.set(false);
    this.detectionMessage.set(DETECTING_MESSAGE);
    try {
      const { noiseDb, thresholdDb } = await this.#engine.detectNoise();
      const threshold = formatDecibels(thresholdDb);
      this.detectionMessage.set(
        noiseDb === null
          ? `No noise heard, so the gate is set to ${threshold}.`
          : `Noise peaked at ${formatDecibels(noiseDb)}, so the gate is set to ${threshold}.`,
      );
    } catch (error) {
      this.isDetectionFailed.set(true);
      this.detectionMessage.set(
        error instanceof NoiseDetectionError
          ? NOISE_DETECTION_FAILURE_MESSAGES[error.reason]
          : 'Noise detection could not run. Try again.',
      );
    }
  }
}
