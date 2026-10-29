import { expect, test } from '@playwright/test';

import { Pedal } from './support/pedal';

// The synthetic input starts as a quiet tone, like hum from a guitar left plugged in.
const NOISE_DB = -50;
// Longer than the gate's 50 ms hold plus 100 ms fade, so a closing gate has finished.
const GATE_SETTLE_MS = 300;
// -50 dB is about 0.003 at its peak: anything well below that means the gate is shut.
const SILENT_PEAK = 0.0003;

test.describe('noise gate', () => {
  let pedal: Pedal;

  test.beforeEach(async ({ page }) => {
    pedal = await Pedal.open(page, { syntheticInputDb: NOISE_DB });
    await pedal.enableAudio();
  });

  test('silences noise below the threshold and lets playing through', async () => {
    expect(await pedal.getOutputPeak(200)).toBeGreaterThan(0.002);

    await pedal.gateThreshold.fill('-44');
    await expect(pedal.page.locator('label[for="gate-threshold"]')).toContainText('−44 dB');
    await expect(pedal.inputMeter).toHaveClass(/is-dimmed/);
    await pedal.page.waitForTimeout(GATE_SETTLE_MS);
    expect(await pedal.getOutputPeak(300)).toBeLessThan(SILENT_PEAK);

    // Playing: well above the threshold.
    await pedal.setInputLevel(-30);
    await expect(pedal.inputMeter).not.toHaveClass(/is-dimmed/);
    expect(await pedal.getOutputPeak(200)).toBeGreaterThan(0.02);
  });

  test('keeps matching the noise when the input gain changes', async () => {
    await pedal.gateThreshold.fill('-44');
    await pedal.page.getByLabel('Input gain').fill('2');
    await pedal.page.waitForTimeout(GATE_SETTLE_MS);

    // The noise is louder after the gain, but so is the threshold: it stays shut.
    expect(await pedal.getOutputPeak(300)).toBeLessThan(SILENT_PEAK);
  });

  test('detects the noise and sets the gate just above it', async () => {
    await pedal.detectNoiseButton.click();
    await expect(pedal.detectNoiseButton).toHaveText('Cancel detection');
    await expect(pedal.footswitch(1)).toBeDisabled();
    await expect(pedal.gateThreshold).toBeDisabled();

    await expect(pedal.noiseDetectionStatus).toHaveText(
      'Noise peaked at −50 dB, so the gate is set to −44 dB.',
      { timeout: 5000 },
    );
    await expect(pedal.gateThreshold).toHaveValue('-44');
    await expect(pedal.detectNoiseButton).toHaveText('Detect noise');
    await expect(pedal.footswitch(1)).toBeEnabled();
  });

  test('refuses to treat playing as noise', async () => {
    await pedal.setInputLevel(-10);
    await pedal.detectNoiseButton.click();

    await expect(pedal.noiseDetectionStatus).toContainText('too loud to be background noise', {
      timeout: 5000,
    });
    await expect(pedal.gateThreshold).toHaveValue('-81');
  });

  test('can be cancelled with Esc', async () => {
    await pedal.detectNoiseButton.click();
    await pedal.page.keyboard.press('Escape');

    await expect(pedal.noiseDetectionStatus).toHaveText(
      'Noise detection cancelled. The gate was not changed.',
    );
    await expect(pedal.footswitch(1)).toBeEnabled();
  });
});
