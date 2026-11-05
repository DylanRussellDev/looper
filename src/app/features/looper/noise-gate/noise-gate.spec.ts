import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { FakeAudioEngine, provideFakeAudioEngine } from '../audio/audio-engine.testing';
import { NOISE_DETECTION_FAILURE_MESSAGES, NoiseDetectionError } from '../audio/noise-gate';
import { LooperStore } from '../looper-store';
import { NoiseGate, formatDecibels } from './noise-gate';

describe('NoiseGate', () => {
  let engine: FakeAudioEngine;
  let fixture: ComponentFixture<NoiseGate>;
  let element: HTMLElement;

  const getSlider = () => element.querySelector<HTMLInputElement>('#gate-threshold')!;
  const getButton = () => element.querySelector<HTMLButtonElement>('.detect-button')!;
  const getStatus = () => element.querySelector('.detection-status')!.textContent!.trim();

  function moveSlider(value: number): void {
    getSlider().value = String(value);
    getSlider().dispatchEvent(new Event('input'));
  }

  beforeEach(async () => {
    engine = new FakeAudioEngine();
    await TestBed.configureTestingModule({
      imports: [NoiseGate],
      providers: [provideZonelessChangeDetection(), provideFakeAudioEngine(engine)],
    }).compileComponents();

    fixture = TestBed.createComponent(NoiseGate);
    element = fixture.nativeElement;
    await fixture.whenStable();
  });

  it('formats decibels with a real minus sign', () => {
    expect(formatDecibels(-52.4)).toBe('−52 dB');
    expect(formatDecibels(0)).toBe('0 dB');
  });

  it('starts off, at the bottom of the slider', () => {
    expect(getSlider().valueAsNumber).toBe(-81);
    expect(getSlider().getAttribute('aria-valuetext')).toBe('Off');
    expect(element.querySelector('output')!.textContent).toContain('Off');
  });

  it('sets the threshold from the slider, and turns off at the bottom', () => {
    moveSlider(-55);
    expect(engine.setGateThreshold).toHaveBeenLastCalledWith(-55);

    moveSlider(-81);
    expect(engine.setGateThreshold).toHaveBeenLastCalledWith(null);
  });

  it('shows the threshold in dB', async () => {
    engine.gateThresholdDb.set(-48);
    await fixture.whenStable();

    expect(getSlider().valueAsNumber).toBe(-48);
    expect(getSlider().getAttribute('aria-valuetext')).toBe('−48 dB');
  });

  it('detects the noise and reports the threshold it set', async () => {
    engine.detectNoise.mockResolvedValueOnce({ noiseDb: -63.2, thresholdDb: -57 });
    getButton().click();
    await fixture.whenStable();

    expect(engine.detectNoise).toHaveBeenCalledOnce();
    expect(getStatus()).toBe('Noise peaked at −63 dB, so the gate is set to −57 dB.');
  });

  it('reports silence', async () => {
    engine.detectNoise.mockResolvedValueOnce({ noiseDb: null, thresholdDb: -80 });
    getButton().click();
    await fixture.whenStable();

    expect(getStatus()).toBe('No noise heard, so the gate is set to −80 dB.');
  });

  it('explains a failed detection', async () => {
    engine.detectNoise.mockRejectedValueOnce(new NoiseDetectionError('too-loud'));
    getButton().click();
    await fixture.whenStable();

    expect(getStatus()).toBe(NOISE_DETECTION_FAILURE_MESSAGES['too-loud']);
    expect(element.querySelector('.detection-status')!.classList).toContain('is-error');
  });

  it('turns into a cancel button while listening, locks the slider, and Esc cancels too', async () => {
    engine.isDetectingNoise.set(true);
    await fixture.whenStable();
    expect(getButton().textContent).toContain('Cancel detection');
    expect(getSlider().disabled).toBe(true);

    getButton().click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    expect(engine.cancelNoiseDetection).toHaveBeenCalledTimes(2);
  });

  it('waits for calibration and recording to finish', async () => {
    engine.isCalibrating.set(true);
    await fixture.whenStable();
    expect(getButton().disabled).toBe(true);
    expect(getSlider().disabled).toBe(true);

    engine.isCalibrating.set(false);
    TestBed.inject(LooperStore).tapTrack(1);
    await fixture.whenStable();
    expect(getButton().disabled).toBe(true);
    expect(element.textContent).toContain('Finish recording to detect noise.');
  });

  it('needs some input gain to hear the noise', async () => {
    engine.inputGain.set(0);
    await fixture.whenStable();

    expect(getButton().disabled).toBe(true);
    expect(element.textContent).toContain('Turn up the input gain to detect noise.');
  });
});
