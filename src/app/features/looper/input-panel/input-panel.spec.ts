import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { FakeAudioEngine, provideFakeAudioEngine } from '../audio/audio-engine.testing';
import { AUDIO_ERROR_MESSAGES } from '../audio/audio-errors';
import { CALIBRATION_FAILURE_MESSAGES, CalibrationError } from '../audio/latency-calibration';
import { NOISE_DETECTION_FAILURE_MESSAGES, NoiseDetectionError } from '../audio/noise-gate';
import { LooperStore } from '../looper-store';
import { InputPanel } from './input-panel';

describe('InputPanel', () => {
  let engine: FakeAudioEngine;
  let fixture: ComponentFixture<InputPanel>;
  let element: HTMLElement;

  beforeEach(async () => {
    localStorage.clear();
    engine = new FakeAudioEngine();
    engine.inputDevices.set([
      { deviceId: 'interface', label: 'Focusrite USB Audio' },
      { deviceId: 'laptop', label: 'Microphone Array' },
    ]);
    engine.selectedDeviceId.set('interface');

    await TestBed.configureTestingModule({
      imports: [InputPanel],
      providers: [provideZonelessChangeDetection(), provideFakeAudioEngine(engine)],
    }).compileComponents();

    fixture = TestBed.createComponent(InputPanel);
    element = fixture.nativeElement;
    await fixture.whenStable();
  });

  it('lists input devices with the selected one chosen', () => {
    const select = element.querySelector<HTMLSelectElement>('#input-device')!;

    expect(select.options).toHaveLength(2);
    expect(select.value).toBe('interface');
  });

  it('switches device when a new one is chosen', () => {
    const select = element.querySelector<HTMLSelectElement>('#input-device')!;
    select.value = 'laptop';
    select.dispatchEvent(new Event('change'));

    expect(engine.selectDevice).toHaveBeenCalledWith('laptop');
  });

  it('disables the controls until audio is running', async () => {
    engine.status.set('idle');
    await fixture.whenStable();

    expect(element.querySelector<HTMLSelectElement>('#input-device')!.disabled).toBe(true);
    expect(element.querySelector<HTMLInputElement>('#input-gain')!.disabled).toBe(true);
  });

  it('shows the error message with a retry when the input is missing', async () => {
    engine.error.set('permission-denied');
    engine.isInputConnected.set(false);
    await fixture.whenStable();

    const alert = element.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain(AUDIO_ERROR_MESSAGES['permission-denied']);

    alert.querySelector('button')!.click();
    expect(engine.reconnectInput).toHaveBeenCalledOnce();
  });

  it('warns about feedback when a built-in mic is selected', async () => {
    engine.isBuiltInMicSelected.set(true);
    await fixture.whenStable();

    expect(element.textContent).toContain('Built-in microphone selected');
  });

  it('forwards the monitor toggle to the engine', () => {
    const toggle = element.querySelector<HTMLInputElement>('input[role="switch"]')!;
    toggle.click();

    expect(engine.setMonitorEnabled).toHaveBeenCalledWith(false);
  });

  describe('collapsing', () => {
    const getButton = () => element.querySelector<HTMLButtonElement>('.collapse-button')!;
    const getSettings = () => element.querySelector<HTMLElement>('#input-panel-settings')!;
    const getCollapsedStatus = () => element.querySelector('.collapsed-status')!;

    async function collapse(): Promise<void> {
      getButton().click();
      await fixture.whenStable();
    }

    it('starts expanded, with the button controlling the settings', () => {
      expect(getButton().getAttribute('aria-expanded')).toBe('true');
      expect(getButton().getAttribute('aria-controls')).toBe('input-panel-settings');
      expect(getSettings().inert).toBe(false);
    });

    it('hides the settings but keeps the meter and monitor toggle', async () => {
      await collapse();

      expect(getButton().getAttribute('aria-expanded')).toBe('false');
      expect(getSettings().inert).toBe(true);
      expect(getSettings().classList).toContain('is-collapsed');
      expect(getSettings().querySelector('#input-device')).not.toBeNull();
      expect(getSettings().querySelector('meter')).toBeNull();
      expect(getSettings().querySelector('input[role="switch"]')).toBeNull();
      expect(element.querySelector('meter')).not.toBeNull();

      await collapse();
      expect(getSettings().inert).toBe(false);
    });

    it('still shows errors while collapsed', async () => {
      await collapse();
      engine.error.set('device-unplugged');
      engine.isInputConnected.set(false);
      await fixture.whenStable();

      const alert = element.querySelector('[role="alert"]')!;
      expect(getSettings().contains(alert)).toBe(false);
      expect(alert.textContent).toContain(AUDIO_ERROR_MESSAGES['device-unplugged']);
    });

    it('shows measurement progress and results under the strip while collapsed', async () => {
      expect(getCollapsedStatus().textContent!.trim()).toBe('');
      await collapse();

      engine.calibrateLatency.mockResolvedValueOnce(23);
      element.querySelector<HTMLButtonElement>('.calibrate-button')!.click();
      await fixture.whenStable();
      expect(getCollapsedStatus().textContent).toContain('Measured 23 ms round trip');

      engine.detectNoise.mockRejectedValueOnce(new NoiseDetectionError('too-loud'));
      element.querySelector<HTMLButtonElement>('.detect-button')!.click();
      await fixture.whenStable();
      const error = getCollapsedStatus().querySelector('.is-error')!;
      expect(error.textContent).toContain(NOISE_DETECTION_FAILURE_MESSAGES['too-loud']);
    });
  });

  describe('noise gate', () => {
    const getMarker = () => element.querySelector<HTMLElement>('.marker');

    it('marks the threshold on the meter, after the input gain', async () => {
      expect(getMarker()).toBeNull();

      engine.gateThresholdDb.set(-48);
      engine.inputGain.set(2);
      await fixture.whenStable();

      // -48 dB plus 6 dB of gain sits at -42 dB: 0.3 of the way up a -60..0 dB meter.
      const position = Number(getMarker()!.style.getPropertyValue('--marker-position'));
      expect(position).toBeCloseTo(0.3, 2);
    });

    it('dims the meter while the gate is closed', async () => {
      engine.isGateOpen.set(false);
      await fixture.whenStable();
      expect(element.querySelector('meter')!.classList).not.toContain('is-dimmed');

      engine.gateThresholdDb.set(-48);
      await fixture.whenStable();
      expect(element.querySelector('meter')!.classList).toContain('is-dimmed');
    });

    it('locks the gain and calibration while detecting noise', async () => {
      engine.isDetectingNoise.set(true);
      await fixture.whenStable();

      expect(element.querySelector<HTMLInputElement>('#input-gain')!.disabled).toBe(true);
      expect(element.querySelector<HTMLButtonElement>('.calibrate-button')!.disabled).toBe(true);
    });
  });

  describe('latency calibration', () => {
    const getButton = () => element.querySelector<HTMLButtonElement>('.calibrate-button')!;
    const getStatus = () => element.querySelector('.calibration-status')!.textContent!.trim();

    it('measures, applies, and reports the latency', async () => {
      engine.calibrateLatency.mockResolvedValueOnce(23);
      getButton().click();
      await fixture.whenStable();

      expect(engine.calibrateLatency).toHaveBeenCalledOnce();
      expect(getStatus()).toBe('Measured 23 ms round trip and applied it.');
    });

    it('explains a failed calibration', async () => {
      engine.calibrateLatency.mockRejectedValueOnce(new CalibrationError('no-signal'));
      getButton().click();
      await fixture.whenStable();

      expect(getStatus()).toBe(CALIBRATION_FAILURE_MESSAGES['no-signal']);
    });

    it('turns into a cancel button while running, and Esc cancels too', async () => {
      engine.isCalibrating.set(true);
      await fixture.whenStable();
      expect(getButton().textContent).toContain('Cancel calibration');

      getButton().click();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

      expect(engine.cancelCalibration).toHaveBeenCalledTimes(2);
    });

    it('waits for recording to finish', async () => {
      TestBed.inject(LooperStore).tapTrack(1);
      await fixture.whenStable();

      expect(getButton().disabled).toBe(true);
      expect(element.textContent).toContain('Finish recording to calibrate.');
    });
  });
});
