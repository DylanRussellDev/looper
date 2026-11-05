import { expect, test } from '@playwright/test';

import { Pedal } from './support/pedal';

// The loop is a -30 dB tone (about 0.03 at its peak); silence is far below that.
const SILENT_PEAK = 0.001;
// Comfortably longer than the loop bus fade.
const FADE_SETTLE_MS = 200;

test.describe('mute all', () => {
  let pedal: Pedal;

  test.beforeEach(async ({ page }) => {
    pedal = await Pedal.open(page, { syntheticInputDb: -30 });
    await pedal.enableAudio();
    // Only the loops reach the output, so the output peak is the loops alone.
    await page.getByLabel('Monitor').uncheck();
    await pedal.recordMasterLoop(1, 800);
  });

  test('silences the loops while they keep running, then brings them back', async () => {
    expect(await pedal.getOutputPeak(300)).toBeGreaterThan(0.01);
    const startsBefore = (await pedal.getStarts()).length;

    await pedal.muteButton.click();
    await expect(pedal.muteButton).toHaveText(/Unmute all/);
    await expect(pedal.notice).toContainText('Loops muted');
    await expect(pedal.footswitch(1)).toContainText('Playing (muted)');
    await pedal.page.waitForTimeout(FADE_SETTLE_MS);
    expect(await pedal.getOutputPeak(300)).toBeLessThan(SILENT_PEAK);
    await expect(pedal.loopPosition.locator('.ring')).toHaveClass(/is-running/);

    await pedal.pressKey('m');
    await expect(pedal.muteButton).toHaveText(/Mute all/);
    expect(await pedal.getOutputPeak(300)).toBeGreaterThan(0.01);
    // Unmuting only lifts the volume: nothing was restarted.
    expect((await pedal.getStarts()).length).toBe(startsBefore);
  });

  test('unmutes on Master Reset', async () => {
    await pedal.muteButton.click();
    await pedal.masterResetButton.click();
    await pedal.masterResetButton.click();

    await expect(pedal.muteButton).toHaveText(/Mute all/);
  });
});
