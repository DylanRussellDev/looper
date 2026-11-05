import { Locator, Page, expect } from '@playwright/test';

import { AudioProbeOptions, ScheduledStart, installAudioProbe } from './audio-probe';

export type FootswitchState =
  'empty' | 'armed' | 'recording' | 'playing' | 'overdubbing' | 'stopped';

// Longer than the app's 1 s hold threshold.
const HOLD_MS = 1200;
// Longer than the app's 350 ms double-tap window, so the next tap counts as a new tap.
const DOUBLE_TAP_GAP_MS = 450;

/** Drives the looper like a player would, and reads back what the audio engine scheduled. */
export class Pedal {
  readonly enableAudioButton: Locator;
  readonly masterResetButton: Locator;
  readonly alert: Locator;
  readonly notice: Locator;
  readonly inputDevice: Locator;
  readonly inputMeter: Locator;
  readonly latencyOffset: Locator;
  readonly undoButton: Locator;
  readonly redoButton: Locator;
  readonly historyTarget: Locator;
  readonly calibrateButton: Locator;
  readonly calibrationStatus: Locator;
  readonly loopPosition: Locator;
  readonly suspendedAlert: Locator;
  readonly gateThreshold: Locator;
  readonly detectNoiseButton: Locator;
  readonly noiseDetectionStatus: Locator;
  readonly collapseButton: Locator;
  readonly muteButton: Locator;

  constructor(readonly page: Page) {
    this.enableAudioButton = page.getByRole('button', { name: 'Enable audio' });
    this.masterResetButton = page.locator('.master-reset');
    this.alert = page.getByRole('alert');
    this.notice = page.locator('.notice');
    this.inputDevice = page.getByLabel('Input device');
    this.inputMeter = page.locator('meter');
    this.latencyOffset = page.getByLabel('Latency compensation (ms)');
    this.undoButton = page.getByRole('button', { name: 'Undo', exact: true });
    this.redoButton = page.getByRole('button', { name: 'Redo', exact: true });
    this.historyTarget = page.locator('.history-target');
    this.calibrateButton = page.locator('.calibrate-button');
    this.calibrationStatus = page.locator('.calibration-status');
    this.loopPosition = page.locator('app-loop-position');
    this.suspendedAlert = page.locator('.suspended');
    this.gateThreshold = page.getByLabel('Noise gate');
    this.detectNoiseButton = page.locator('.detect-button');
    this.noiseDetectionStatus = page.locator('.detection-status');
    this.collapseButton = page.locator('.collapse-button');
    this.muteButton = page.locator('.mute-button');
  }

  volume(trackId: number): Locator {
    return this.page.getByLabel(`Volume track ${trackId}`);
  }

  static async open(page: Page, options: AudioProbeOptions = {}): Promise<Pedal> {
    await page.addInitScript(installAudioProbe, options);
    await page.goto('/');
    return new Pedal(page);
  }

  footswitch(trackId: number): Locator {
    return this.page
      .locator('app-footswitch')
      .nth(trackId - 1)
      .getByRole('button');
  }

  async enableAudio(): Promise<void> {
    await this.enableAudioButton.click();
    await expect(this.footswitch(1)).toBeEnabled();
    // The footswitches enable as soon as the engine runs, a moment before the input
    // stream connects; the selected device appears once it has.
    await expect(this.inputDevice).not.toHaveValue('');
  }

  /** The loudest meter reading over `durationMs`, sampled every animation frame. */
  async getPeakMeterLevel(durationMs: number): Promise<number> {
    return this.inputMeter.evaluate(
      (meter: HTMLMeterElement, duration) =>
        new Promise<number>((resolve) => {
          let peak = 0;
          const endTime = performance.now() + duration;
          const sample = () => {
            peak = Math.max(peak, meter.value);
            if (performance.now() < endTime) {
              requestAnimationFrame(sample);
            } else {
              resolve(peak);
            }
          };
          sample();
        }),
      durationMs,
    );
  }

  async tap(trackId: number): Promise<void> {
    await this.footswitch(trackId).click();
  }

  async doubleTap(trackId: number): Promise<void> {
    await this.footswitch(trackId).dblclick();
    await this.page.waitForTimeout(DOUBLE_TAP_GAP_MS);
  }

  async hold(trackId: number): Promise<void> {
    await this.footswitch(trackId).hover();
    await this.page.mouse.down();
    await this.page.waitForTimeout(HOLD_MS);
    await this.page.mouse.up();
  }

  /** Holds a key down for `durationMs`, like a foot on the switch. */
  async pressKey(key: string, durationMs = 50): Promise<void> {
    await this.page.keyboard.down(key);
    await this.page.waitForTimeout(durationMs);
    await this.page.keyboard.up(key);
  }

  async suspendAudio(): Promise<void> {
    await this.page.evaluate(() => window.audioProbe.suspendAudio());
  }

  async expectState(trackId: number, state: FootswitchState | RegExp, timeout = 5000) {
    await expect(this.footswitch(trackId)).toHaveAttribute('data-state', state, { timeout });
  }

  /** Taps, waits `lengthMs`, taps again: the first loop, which sets the master length. */
  async recordMasterLoop(trackId: number, lengthMs: number): Promise<void> {
    await this.tap(trackId);
    await this.expectState(trackId, 'recording');
    await this.page.waitForTimeout(lengthMs);
    await this.tap(trackId);
    await this.expectState(trackId, 'playing');
    await this.page.waitForTimeout(DOUBLE_TAP_GAP_MS);
  }

  async getStarts(): Promise<ScheduledStart[]> {
    return this.page.evaluate(() => window.audioProbe.starts);
  }

  /** Waits until `count` playback starts have been scheduled and returns them. */
  async waitForStarts(count: number): Promise<ScheduledStart[]> {
    await expect.poll(async () => (await this.getStarts()).length).toBeGreaterThanOrEqual(count);
    return this.getStarts();
  }

  async setInputLevel(decibels: number): Promise<void> {
    await this.page.evaluate((level) => window.audioProbe.setInputLevel(level), decibels);
  }

  async getOutputPeak(durationMs: number): Promise<number> {
    return this.page.evaluate((duration) => window.audioProbe.getOutputPeak(duration), durationMs);
  }

  async unplugInput(): Promise<void> {
    await this.page.evaluate(() => window.audioProbe.unplugInput());
  }
}

/**
 * Which point of the loop a start is aligned to: the frame (mod loop length) where its
 * buffer's first sample falls. Tracks in sync share the same phase.
 */
export function getLoopPhase(start: ScheduledStart): number {
  const length = start.bufferFrames;
  return (((start.whenFrame - start.offsetFrames) % length) + length) % length;
}
