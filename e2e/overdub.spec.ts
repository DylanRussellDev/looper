import { expect, test } from '@playwright/test';

import { Pedal, getLoopPhase } from './support/pedal';

const MASTER_LOOP_MS = 800;
// Longer than the 350 ms double-tap window, so consecutive taps count separately.
const TAP_GAP_MS = 450;

let pedal: Pedal;

test.beforeEach(async ({ page }) => {
  pedal = await Pedal.open(page);
  await pedal.enableAudio();
  await pedal.recordMasterLoop(1, MASTER_LOOP_MS);
});

/**
 * Overdubs on a playing track for `durationMs`, then taps back to playing. The duration
 * must exceed the double-tap window, or the second tap stops the track instead.
 */
async function overdub(trackId: number, durationMs: number): Promise<void> {
  await pedal.tap(trackId);
  await pedal.expectState(trackId, 'overdubbing');
  await pedal.page.waitForTimeout(durationMs);
  await pedal.tap(trackId);
  await pedal.expectState(trackId, 'playing');
  await pedal.page.waitForTimeout(TAP_GAP_MS);
}

test.describe('overdub', () => {
  test('stacks across loop wraps and plays every pass in phase with the loop', async () => {
    const [master] = await pedal.waitForStarts(1);

    // Two and a half loops: the pass is heard back on each wrap while it continues.
    await pedal.tap(1);
    await pedal.expectState(1, 'overdubbing');
    await expect
      .poll(async () => (await pedal.getStarts()).length, { timeout: MASTER_LOOP_MS * 4 })
      .toBeGreaterThanOrEqual(3);
    await pedal.page.waitForTimeout(MASTER_LOOP_MS);
    await pedal.tap(1);
    await pedal.expectState(1, 'playing');
    await pedal.page.waitForTimeout(TAP_GAP_MS);

    const starts = await pedal.getStarts();
    expect(starts.length).toBeGreaterThanOrEqual(4);
    for (const start of starts) {
      expect(start.isLooping).toBe(true);
      expect(start.bufferFrames).toBe(master!.bufferFrames);
      expect(getLoopPhase(start)).toBe(getLoopPhase(master!));
    }
  });

  test('marks the track as selected and enables undo once a pass is committed', async () => {
    await expect(pedal.footswitch(1)).toContainText('Selected');
    await expect(pedal.historyTarget).toHaveText('Acts on Track 1');
    await expect(pedal.undoButton).toBeDisabled();

    await overdub(1, 600);

    await expect(pedal.undoButton).toBeEnabled();
    await expect(pedal.redoButton).toBeDisabled();
  });

  test('stops and discards the pass on double-tap', async () => {
    await pedal.doubleTap(1);

    await pedal.expectState(1, 'stopped');
    await expect(pedal.undoButton).toBeDisabled();
  });
});

test.describe('undo and redo', () => {
  test('undoes the newest layer, redoes it in phase, and never removes the base', async () => {
    await overdub(1, 600);
    await overdub(1, 600);

    await pedal.undoButton.click();
    await expect(pedal.undoButton).toBeEnabled();
    await pedal.undoButton.click();
    await expect(pedal.undoButton).toBeDisabled();
    await expect(pedal.redoButton).toBeEnabled();
    await pedal.expectState(1, 'playing');

    const startsBefore = (await pedal.getStarts()).length;
    await pedal.redoButton.click();
    const starts = await pedal.waitForStarts(startsBefore + 1);
    expect(getLoopPhase(starts.at(-1)!)).toBe(getLoopPhase(starts[0]!));
    await expect(pedal.undoButton).toBeEnabled();
  });

  test('ends an overdub in progress and undoes it', async () => {
    await pedal.tap(1);
    await pedal.expectState(1, 'overdubbing');
    await pedal.page.waitForTimeout(300);

    await pedal.undoButton.click();

    await pedal.expectState(1, 'playing');
    await expect(pedal.redoButton).toBeEnabled();
    await expect(pedal.undoButton).toBeDisabled();
  });

  test('forgets the redo history when a new layer is recorded', async () => {
    await overdub(1, 600);
    await pedal.undoButton.click();
    await expect(pedal.redoButton).toBeEnabled();

    await overdub(1, 600);

    await expect(pedal.redoButton).toBeDisabled();
  });

  test('is disabled after the selected track is cleared', async () => {
    await overdub(1, 600);
    await pedal.hold(1);

    await pedal.expectState(1, 'empty');
    await expect(pedal.undoButton).toBeDisabled();
    await expect(pedal.historyTarget).toHaveText('Touch a track to select it');
    await expect(pedal.footswitch(1)).not.toContainText('Selected');
  });
});

test.describe('mix and latency', () => {
  test('sets a per-track volume, kept on clear and reset by Master Reset', async () => {
    await pedal.volume(1).fill('0.4');
    await expect(pedal.page.locator('app-track-volume').first()).toContainText('40%');

    await pedal.hold(1);
    await expect(pedal.volume(1)).toHaveValue('0.4');

    await pedal.masterResetButton.click();
    await pedal.masterResetButton.click();
    await expect(pedal.volume(1)).toHaveValue('1');
  });

  test('keeps compensated recordings on the loop timeline', async () => {
    await pedal.latencyOffset.fill('120');
    await pedal.latencyOffset.blur();
    await expect(pedal.latencyOffset).toHaveValue('120');

    await pedal.tap(2);
    await pedal.expectState(2, 'playing', MASTER_LOOP_MS * 5);

    const [master, second] = await pedal.waitForStarts(2);
    expect(second!.bufferFrames).toBe(master!.bufferFrames);
    expect(getLoopPhase(second!)).toBe(getLoopPhase(master!));
  });

  test('keeps the latency offset through Master Reset', async () => {
    await pedal.latencyOffset.fill('45');
    await pedal.latencyOffset.blur();

    await pedal.masterResetButton.click();
    await pedal.masterResetButton.click();

    await expect(pedal.latencyOffset).toHaveValue('45');
  });
});
