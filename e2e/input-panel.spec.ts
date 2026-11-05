import { expect, test } from '@playwright/test';

import { Pedal } from './support/pedal';

test.describe('collapsible input settings', () => {
  let pedal: Pedal;

  test.beforeEach(async ({ page }) => {
    pedal = await Pedal.open(page);
    await pedal.enableAudio();
  });

  test('hides the settings but keeps the meter and monitor, and remembers it', async ({ page }) => {
    await expect(pedal.inputDevice).toBeVisible();

    await pedal.collapseButton.click();
    await expect(pedal.collapseButton).toHaveAttribute('aria-expanded', 'false');
    await expect(pedal.inputDevice).toBeHidden();
    await expect(pedal.gateThreshold).toBeHidden();
    await expect(pedal.calibrateButton).toBeHidden();
    await expect(pedal.inputMeter).toBeVisible();
    await expect(page.getByLabel('Monitor')).toBeVisible();

    await page.reload();
    await expect(pedal.collapseButton).toHaveAttribute('aria-expanded', 'false');
    await expect(pedal.inputDevice).toBeHidden();
  });

  test('skips the hidden controls when tabbing', async ({ page }) => {
    await pedal.collapseButton.click();
    await page.getByLabel('Monitor').focus();
    await page.keyboard.press('Tab');

    const isInSettings = await page.evaluate(
      () => document.activeElement?.closest('#input-panel-settings') !== null,
    );
    expect(isInSettings).toBe(false);
  });

  test('toggles with the I key', async ({ page }) => {
    await page.locator('h1').click();

    await pedal.pressKey('i');
    await expect(pedal.inputDevice).toBeHidden();
    await pedal.pressKey('i');
    await expect(pedal.inputDevice).toBeVisible();
  });
});

test.describe('collapsing during a measurement', () => {
  test('keeps it running, reporting under the strip', async ({ page }) => {
    // Chrome's fake mic beeps loudly; a quiet tone lets detection succeed.
    const pedal = await Pedal.open(page, { syntheticInputDb: -50 });
    await pedal.enableAudio();
    await pedal.detectNoiseButton.click();
    await pedal.collapseButton.click();

    const status = page.locator('.collapsed-status');
    await expect(status).toContainText('Listening to the noise');
    await expect(status).toContainText('so the gate is set to', { timeout: 5000 });
  });
});
