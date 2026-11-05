import { expect, test } from '@playwright/test';

import { Pedal, getLoopPhase } from './support/pedal';

// Chrome's fake input device (see playwright.config.ts) plays a steady beep, so every
// take records real audio through the real worklet.

const MASTER_LOOP_MS = 800;
// Short enough to keep the suite quick; quantized takes wait up to one loop for a boundary.
const ONE_LOOP_TIMEOUT_MS = MASTER_LOOP_MS * 4;

test.describe('input', () => {
  test('enables audio, opens the fake device and meters its signal', async ({ page }) => {
    const pedal = await Pedal.open(page);
    await expect(pedal.footswitch(1)).toBeDisabled();

    await pedal.enableAudio();

    await expect(pedal.enableAudioButton).toBeHidden();
    await expect(pedal.inputDevice.locator('option')).not.toHaveCount(0);
    // The fake device beeps about once a second, with silence in between.
    expect(await pedal.getPeakMeterLevel(2500)).toBeGreaterThan(0);
  });
});

test.describe('looping', () => {
  let pedal: Pedal;

  test.beforeEach(async ({ page }) => {
    pedal = await Pedal.open(page);
    await pedal.enableAudio();
  });

  test('records the first loop on any track and loops it', async () => {
    await pedal.recordMasterLoop(3, MASTER_LOOP_MS);

    const [start] = await pedal.waitForStarts(1);
    expect(start!.isLooping).toBe(true);
    // Fake-device sample rate is 48 kHz; allow for click and render-quantum slop.
    expect(start!.bufferFrames).toBeGreaterThan(48_000 * (MASTER_LOOP_MS / 1000) * 0.75);
    expect(start!.bufferFrames).toBeLessThan(48_000 * (MASTER_LOOP_MS / 1000) * 1.5);
  });

  test('records the next track for exactly one loop, in phase with the first', async () => {
    await pedal.recordMasterLoop(1, MASTER_LOOP_MS);
    const [master] = await pedal.waitForStarts(1);

    await pedal.tap(2);
    await pedal.expectState(2, /armed|recording/);
    await pedal.expectState(2, 'recording', ONE_LOOP_TIMEOUT_MS);
    await pedal.expectState(2, 'playing', ONE_LOOP_TIMEOUT_MS);
    await pedal.expectState(1, 'playing');

    const [, second] = await pedal.waitForStarts(2);
    expect(second!.bufferFrames).toBe(master!.bufferFrames);
    expect(getLoopPhase(second!)).toBe(getLoopPhase(master!));
  });

  test('arms several tracks for the same boundary', async () => {
    await pedal.recordMasterLoop(1, MASTER_LOOP_MS);

    await pedal.tap(2);
    await pedal.tap(3);
    await pedal.tap(4);
    for (const trackId of [2, 3, 4]) {
      await pedal.expectState(trackId, 'playing', ONE_LOOP_TIMEOUT_MS);
    }

    const starts = await pedal.waitForStarts(4);
    const phases = new Set(starts.map(getLoopPhase));
    expect(phases.size).toBe(1);
  });

  test('stops on double-tap and restarts on the next loop boundary', async () => {
    await pedal.recordMasterLoop(1, MASTER_LOOP_MS);
    await pedal.tap(2);
    await pedal.expectState(2, 'playing', ONE_LOOP_TIMEOUT_MS);

    await pedal.doubleTap(1);
    await pedal.expectState(1, 'stopped');
    await pedal.expectState(2, 'playing');

    const startsBefore = (await pedal.getStarts()).length;
    await pedal.tap(1);
    await pedal.expectState(1, 'playing');

    const starts = await pedal.waitForStarts(startsBefore + 1);
    const restart = starts.at(-1)!;
    expect(restart.offsetFrames).toBe(0);
    expect(getLoopPhase(restart)).toBe(getLoopPhase(starts[0]!));
  });

  test('restarts immediately from the loop start when nothing else is playing', async () => {
    await pedal.recordMasterLoop(1, MASTER_LOOP_MS);
    await pedal.doubleTap(1);
    await pedal.expectState(1, 'stopped');

    await pedal.tap(1);
    await pedal.expectState(1, 'playing');

    const starts = await pedal.waitForStarts(2);
    expect(starts.at(-1)!.offsetFrames).toBe(0);
  });

  test('cancels a waiting take on double-tap', async () => {
    // A long loop so the boundary is still far away when the double-tap lands.
    await pedal.recordMasterLoop(1, 2500);

    await pedal.doubleTap(2);

    await pedal.expectState(2, 'empty');
    await pedal.expectState(1, 'playing');
  });

  test('clears a track on hold and resets the loop length once all are empty', async () => {
    await pedal.recordMasterLoop(1, MASTER_LOOP_MS);
    await pedal.tap(2);
    await pedal.expectState(2, 'playing', ONE_LOOP_TIMEOUT_MS);

    await pedal.hold(1);
    await pedal.expectState(1, 'empty');
    await pedal.expectState(2, 'playing');

    await pedal.hold(2);
    await pedal.expectState(2, 'empty');

    // With no master loop left, the next take records freely again.
    await pedal.recordMasterLoop(3, MASTER_LOOP_MS * 2);
    const starts = await pedal.getStarts();
    expect(starts.at(-1)!.bufferFrames).toBeGreaterThan(starts[0]!.bufferFrames * 1.5);
  });
});

test.describe('master reset', () => {
  test('needs a confirming second click, then clears everything', async ({ page }) => {
    const pedal = await Pedal.open(page);
    await pedal.enableAudio();
    await pedal.recordMasterLoop(1, MASTER_LOOP_MS);
    await pedal.tap(2);

    await pedal.masterResetButton.click();
    await expect(pedal.masterResetButton).toHaveText('Confirm reset');
    await pedal.expectState(1, 'playing');

    await pedal.masterResetButton.click();
    await expect(pedal.masterResetButton).toHaveText('Master Reset');
    for (const trackId of [1, 2, 3, 4]) {
      await pedal.expectState(trackId, 'empty');
    }

    // Like a fresh launch: input stays ready and the next take sets a new master loop.
    await pedal.tap(4);
    await pedal.expectState(4, 'recording');
  });

  test('disarms if not confirmed in time', async ({ page }) => {
    const pedal = await Pedal.open(page);
    await pedal.enableAudio();

    await pedal.masterResetButton.click();
    await expect(pedal.masterResetButton).toHaveText('Confirm reset');
    await expect(pedal.masterResetButton).toHaveText('Master Reset', { timeout: 4000 });
  });
});

test.describe('errors', () => {
  test('explains a blocked microphone permission', async ({ page }) => {
    const pedal = await Pedal.open(page, { mediaErrorName: 'NotAllowedError' });
    await pedal.enableAudioButton.click();

    await expect(pedal.alert).toContainText('Microphone access is blocked');
    await expect(pedal.alert.getByRole('button', { name: 'Try again' })).toBeVisible();
  });

  test('explains a missing input device', async ({ page }) => {
    const pedal = await Pedal.open(page, { mediaErrorName: 'NotFoundError' });
    await pedal.enableAudioButton.click();

    await expect(pedal.alert).toContainText('No audio input was found');
  });

  test('discards a take when the device is unplugged, and keeps loops playing', async ({
    page,
  }) => {
    const pedal = await Pedal.open(page);
    await pedal.enableAudio();
    await pedal.recordMasterLoop(1, MASTER_LOOP_MS);
    await pedal.tap(2);
    await pedal.expectState(2, /armed|recording/);

    await pedal.unplugInput();

    await pedal.expectState(2, 'empty');
    await pedal.expectState(1, 'playing');
    await expect(pedal.alert).toContainText('disconnected');
    await expect(pedal.notice).toContainText('discarded');
  });
});
