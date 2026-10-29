import { Component, computed, inject, signal, viewChild } from '@angular/core';

import { LevelMeter } from '@shared/components/level-meter/level-meter';
import { ToggleSwitch } from '@shared/components/toggle-switch/toggle-switch';
import { AudioEngine, MAX_LATENCY_OFFSET_MS } from '../audio/audio-engine';
import { AUDIO_ERROR_MESSAGES } from '../audio/audio-errors';
import { CALIBRATION_FAILURE_MESSAGES, CalibrationError } from '../audio/latency-calibration';
import { isClipping, toMeterLevel } from '../audio/level';
import { fromDecibels } from '../audio/noise-gate';
import { LooperStore } from '../looper-store';
import { NoiseGate } from '../noise-gate/noise-gate';
import { InputPanelLayout } from './input-panel-layout';

interface StatusMessage {
  text: string;
  isError: boolean;
}

const CALIBRATING_MESSAGE = 'Listening for the test clicks…';

@Component({
  imports: [LevelMeter, NoiseGate, ToggleSwitch],
  selector: 'app-input-panel',
  styleUrl: './input-panel.scss',
  templateUrl: './input-panel.html',
  host: {
    '(document:keydown.escape)': 'cancelCalibration()',
  },
})
export class InputPanel {
  readonly #engine = inject(AudioEngine);
  readonly #store = inject(LooperStore);
  readonly #layout = inject(InputPanelLayout);
  // viewChild can't be an ES private field.
  protected readonly noiseGate = viewChild.required(NoiseGate);

  protected readonly isCollapsed = this.#layout.isCollapsed;

  protected readonly inputDevices = this.#engine.inputDevices;
  protected readonly selectedDeviceId = this.#engine.selectedDeviceId;
  protected readonly inputGain = this.#engine.inputGain;
  protected readonly isMonitorEnabled = this.#engine.isMonitorEnabled;
  protected readonly isBuiltInMicSelected = this.#engine.isBuiltInMicSelected;
  protected readonly latencyOffsetMs = this.#engine.latencyOffsetMs;
  protected readonly reportedOutputLatencyMs = this.#engine.reportedOutputLatencyMs;
  protected readonly isCalibrating = this.#engine.isCalibrating;
  protected readonly maxLatencyOffsetMs = MAX_LATENCY_OFFSET_MS;
  protected readonly isRunning = computed(() => this.#engine.status() === 'running');
  protected readonly gainPercent = computed(() => Math.round(this.inputGain() * 100));
  protected readonly meterLevel = computed(() => toMeterLevel(this.#engine.inputLevel().peak));
  protected readonly isInputClipping = computed(() => isClipping(this.#engine.inputLevel().peak));
  // The meter reads after the input gain, so the threshold is shown there too.
  protected readonly gateMarker = computed(() => {
    const decibels = this.#engine.gateThresholdDb();
    return decibels === null ? null : toMeterLevel(fromDecibels(decibels) * this.inputGain());
  });
  protected readonly isGateClosed = computed(
    () => this.#engine.gateThresholdDb() !== null && !this.#engine.isGateOpen(),
  );
  protected readonly isGainDisabled = computed(
    () => !this.isRunning() || this.#engine.isDetectingNoise(),
  );
  protected readonly errorMessage = computed(() => {
    const error = this.#engine.error();
    return error ? AUDIO_ERROR_MESSAGES[error] : '';
  });
  protected readonly canRetryInput = computed(
    () => this.isRunning() && !this.#engine.isInputConnected(),
  );
  // Calibration would record the clicks into a take, so it waits for recording to finish.
  protected readonly calibrationBlockedReason = computed(() => {
    if (!this.isRunning() || this.#engine.isMeasuring()) {
      return '';
    }
    if (!this.#engine.isInputConnected()) {
      return 'Connect an input to calibrate.';
    }
    return this.#store.isAnyTrackCapturing() ? 'Finish recording to calibrate.' : '';
  });
  protected readonly canCalibrate = computed(
    () =>
      this.isRunning() &&
      !this.#engine.isSuspended() &&
      !this.#engine.isDetectingNoise() &&
      (this.isCalibrating() || this.calibrationBlockedReason() === ''),
  );
  protected readonly calibrationButtonLabel = computed(() =>
    this.isCalibrating() ? 'Cancel calibration' : 'Calibrate',
  );
  protected readonly calibrationMessage = signal('');
  protected readonly isCalibrationFailed = signal(false);
  protected readonly measurementMessages = computed(() => {
    const noiseGate = this.noiseGate();
    const messages: StatusMessage[] = [
      { text: this.calibrationMessage(), isError: this.isCalibrationFailed() },
      { text: noiseGate.detectionMessage(), isError: noiseGate.isDetectionFailed() },
    ];
    return messages.filter((message) => message.text !== '');
  });

  protected toggleCollapsed(): void {
    this.#layout.toggle();
  }

  protected selectDevice(deviceId: string): void {
    void this.#engine.selectDevice(deviceId);
  }

  protected setInputGain(gain: number): void {
    this.#engine.setInputGain(gain);
  }

  protected setMonitorEnabled(isEnabled: boolean): void {
    this.#engine.setMonitorEnabled(isEnabled);
  }

  protected setLatencyOffset(milliseconds: number): void {
    this.#engine.setLatencyOffset(milliseconds);
  }

  protected retryInput(): void {
    void this.#engine.reconnectInput();
  }

  /** One button both starts and cancels, so keyboard focus stays put. */
  protected toggleCalibration(): void {
    if (this.isCalibrating()) {
      this.cancelCalibration();
    } else {
      void this.#calibrate();
    }
  }

  protected cancelCalibration(): void {
    this.#engine.cancelCalibration();
  }

  async #calibrate(): Promise<void> {
    this.isCalibrationFailed.set(false);
    this.calibrationMessage.set(CALIBRATING_MESSAGE);
    try {
      const latencyMs = await this.#engine.calibrateLatency();
      this.calibrationMessage.set(`Measured ${latencyMs} ms round trip and applied it.`);
    } catch (error) {
      this.isCalibrationFailed.set(true);
      this.calibrationMessage.set(
        error instanceof CalibrationError
          ? CALIBRATION_FAILURE_MESSAGES[error.reason]
          : 'Calibration could not run. Try again.',
      );
    }
  }
}
