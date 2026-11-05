import { expect, test } from '@playwright/test';

import { Pedal } from './support/pedal';

// Longer than the 350 ms double-tap window, so consecutive presses count separately.
const TAP_GAP_MS = 450;
// Longer than the 1 s hold threshold.
const HOLD_MS = 1200;

test.describe('keyboard shortcuts', () => {
  let pedal: Pedal;

  test.beforeEach(async ({ page }) => {
    pedal = await Pedal.open(page);
    await pedal.enableAudio();
    // Shortcuts work from anywhere except form controls, so start from the page itself.
    await page.locator('h1').click();
  });

  test('records, overdubs, undoes and redoes without the mouse', async () => {
    await pedal.pressKey('1');
    await pedal.expectState(1, 'recording');
    await pedal.page.waitForTimeout(800);
    await pedal.pressKey('1');
    await pedal.expectState(1, 'playing');
    await pedal.page.waitForTimeout(TAP_GAP_MS);

    await pedal.pressKey('1');
    await pedal.expectState(1, 'overdubbing');
    await pedal.page.waitForTimeout(600);
    await pedal.pressKey('1');
    await pedal.expectState(1, 'playing');
    await expect(pedal.undoButton).toBeEnabled();

    await pedal.pressKey('z');
    await expect(pedal.undoButton).toBeDisabled();
    await expect(pedal.redoButton).toBeEnabled();
    await pedal.pressKey('y');
    await expect(pedal.undoButton).toBeEnabled();
  });

  test('stops with a double press and clears with a long press', async () => {
    await pedal.recordMasterLoop(2, 800);

    await pedal.pressKey('2');
    await pedal.pressKey('2');
    await pedal.expectState(2, 'stopped');
    await pedal.page.waitForTimeout(TAP_GAP_MS);

    // Held keys auto-repeat; the repeats must not count as more presses.
    await pedal.pressKey('2', HOLD_MS);
    await pedal.expectState(2, 'empty');
  });

  test('leaves keys alone while typing in a field', async () => {
    await pedal.latencyOffset.fill('');
    await pedal.latencyOffset.pressSequentially('12');

    await expect(pedal.latencyOffset).toHaveValue('12');
    await pedal.expectState(1, 'empty');
    await pedal.expectState(2, 'empty');
  });
});

test.describe('pedal controls', () => {
  let pedal: Pedal;

  test.beforeEach(async ({ page }) => {
    pedal = await Pedal.open(page);
    await pedal.enableAudio();
  });

  test('sweeps the loop position ring while a loop plays, and resets on clear', async () => {
    await expect(pedal.loopPosition).toContainText('No loop yet');

    await pedal.recordMasterLoop(1, 800);
    await expect(pedal.loopPosition).toContainText(/0\.[89] s loop/);
    await expect(pedal.loopPosition.locator('.ring')).toHaveClass(/is-running/);
    const sweep = pedal.loopPosition.locator('.sweep');
    const first = await sweep.getAttribute('stroke-dashoffset');
    await pedal.page.waitForTimeout(200);
    expect(await sweep.getAttribute('stroke-dashoffset')).not.toBe(first);

    await pedal.hold(1);
    await expect(pedal.loopPosition).toContainText('No loop yet');
  });

  test('turns a volume knob by dragging it', async () => {
    const knob = pedal.volume(1);
    // Mouse coordinates are in the viewport, so the knob must be on screen.
    await knob.scrollIntoViewIfNeeded();
    const box = (await knob.boundingBox())!;
    const centerX = box.x + box.width / 2;
    const centerY = box.y + box.height / 2;

    // A full turn is 150 px: dragging 75 px down takes it from 100% to 50%.
    await pedal.page.mouse.move(centerX, centerY);
    await pedal.page.mouse.down();
    await pedal.page.mouse.move(centerX, centerY + 75, { steps: 5 });
    await pedal.page.mouse.up();

    await expect(knob).toHaveValue('0.5');
    await expect(pedal.page.locator('app-track-volume').first()).toContainText('50%');
    await expect(knob).toBeFocused();
  });

  test('asks to resume audio the system paused, then carries on', async () => {
    await pedal.suspendAudio();

    await expect(pedal.suspendedAlert).toContainText('Audio was paused');
    await expect(pedal.footswitch(1)).toBeDisabled();

    await pedal.suspendedAlert.getByRole('button', { name: 'Resume audio' }).click();
    await expect(pedal.suspendedAlert).toBeEmpty();
    await expect(pedal.footswitch(1)).toBeEnabled();
  });

  test('explains why a tap does nothing without an input', async () => {
    await pedal.unplugInput();
    await pedal.tap(1);

    await expect(pedal.notice).toContainText('No input is connected');
    await pedal.expectState(1, 'empty');
  });
});

test.describe('latency calibration', () => {
  test('measures the round trip through a loopback and applies it', async ({ page }) => {
    const pedal = await Pedal.open(page, { loopbackLatencyMs: 120 });
    await pedal.enableAudio();

    await pedal.calibrateButton.click();
    await expect(pedal.calibrateButton).toHaveText('Cancel calibration');
    await expect(pedal.footswitch(1)).toBeDisabled();

    // The simulated cable forms a cycle in the audio graph (monitor -> speakers -> input),
    // which Chrome sometimes runs one 128-frame render quantum (~3 ms) late.
    await expect(pedal.calibrationStatus).toContainText(/Measured 12[0-4] ms round trip/, {
      timeout: 10_000,
    });
    await expect(pedal.latencyOffset).toHaveValue(/^12[0-4]$/);
    await expect(pedal.calibrateButton).toHaveText('Calibrate');
    await expect(pedal.footswitch(1)).toBeEnabled();
  });

  test('can be cancelled with Esc, leaving the setting alone', async ({ page }) => {
    const pedal = await Pedal.open(page, { loopbackLatencyMs: 120 });
    await pedal.enableAudio();
    await pedal.latencyOffset.fill('45');
    await pedal.latencyOffset.blur();

    await pedal.calibrateButton.click();
    await page.keyboard.press('Escape');

    await expect(pedal.calibrationStatus).toContainText('Calibration cancelled');
    await expect(pedal.latencyOffset).toHaveValue('45');
  });
});
