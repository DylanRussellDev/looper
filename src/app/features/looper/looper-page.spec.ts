import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { FakeAudioEngine, provideFakeAudioEngine } from './audio/audio-engine.testing';
import { LooperPage } from './looper-page';
import { LooperStore } from './looper-store';

describe('LooperPage', () => {
  let engine: FakeAudioEngine;
  let fixture: ComponentFixture<LooperPage>;
  let element: HTMLElement;

  beforeEach(async () => {
    localStorage.clear();
    engine = new FakeAudioEngine();
    engine.status.set('idle');

    await TestBed.configureTestingModule({
      imports: [LooperPage],
      providers: [provideZonelessChangeDetection(), provideFakeAudioEngine(engine)],
    }).compileComponents();

    fixture = TestBed.createComponent(LooperPage);
    element = fixture.nativeElement;
    await fixture.whenStable();
  });

  it('asks for a gesture to start audio', () => {
    const button = element.querySelector<HTMLButtonElement>('.start-button')!;
    button.click();

    expect(engine.start).toHaveBeenCalledOnce();
  });

  it('hides the start prompt and enables the footswitch once audio runs', async () => {
    engine.status.set('running');
    await fixture.whenStable();

    expect(element.querySelector('.start-button')).toBeNull();
    expect(element.querySelector<HTMLButtonElement>('.footswitch')!.disabled).toBe(false);
  });

  it('records when the footswitch is tapped', async () => {
    engine.status.set('running');
    await fixture.whenStable();

    const footswitch = element.querySelector<HTMLButtonElement>('.footswitch')!;
    footswitch.dispatchEvent(new MouseEvent('pointerdown', { button: 0 }));
    footswitch.dispatchEvent(new MouseEvent('pointerup'));
    await fixture.whenStable();

    expect(engine.startRecording).toHaveBeenCalledOnce();
    expect(footswitch.dataset['state']).toBe('recording');
  });

  it('shows four footswitches, each with a volume control', () => {
    expect(element.querySelectorAll('app-footswitch')).toHaveLength(4);
    expect(element.querySelectorAll('app-track-volume input[type="range"]')).toHaveLength(4);
  });

  it('marks the touched track as selected for undo and redo', async () => {
    engine.status.set('running');
    await fixture.whenStable();
    const [undo, redo] = Array.from(element.querySelectorAll<HTMLButtonElement>('.control-button'));
    expect(undo!.disabled).toBe(true);
    expect(redo!.disabled).toBe(true);
    expect(element.querySelector('.history-target')!.textContent).toContain('Touch a track');

    const footswitch = element.querySelectorAll<HTMLButtonElement>('.footswitch')[2]!;
    footswitch.dispatchEvent(new MouseEvent('pointerdown', { button: 0 }));
    footswitch.dispatchEvent(new MouseEvent('pointerup'));
    await fixture.whenStable();

    expect(element.querySelector('.history-target')!.textContent).toContain('Track 3');
    expect(footswitch.classList).toContain('is-selected');
  });

  it('sends volume changes to the engine', async () => {
    engine.status.set('running');
    await fixture.whenStable();

    const slider = element.querySelector<HTMLInputElement>('#track-volume-2')!;
    slider.value = '0.3';
    slider.dispatchEvent(new Event('input'));

    expect(engine.setTrackVolume).toHaveBeenCalledWith(2, 0.3);
  });

  it('stops every track after a confirmed Master Reset', async () => {
    engine.status.set('running');
    await fixture.whenStable();

    const reset = element.querySelector<HTMLButtonElement>('.master-reset')!;
    reset.click();
    expect(engine.stopTrack).not.toHaveBeenCalled();
    reset.click();

    expect(engine.stopTrack).toHaveBeenCalledTimes(4);
  });

  describe('keyboard and failures', () => {
    beforeEach(async () => {
      engine.status.set('running');
      await fixture.whenStable();
    });

    const pressKey = (key: string, target: Element = document.body, init: KeyboardEventInit = {}) =>
      target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }));

    it('undoes with Z and redoes with Y, except in form controls or with modifiers', () => {
      const store = TestBed.inject(LooperStore);
      const undo = vi.spyOn(store, 'undo');
      const redo = vi.spyOn(store, 'redo');

      pressKey('z');
      pressKey('Y');
      pressKey('z', element.querySelector('#input-device')!);
      pressKey('z', document.body, { ctrlKey: true });
      pressKey('z', document.body, { repeat: true });

      expect(undo).toHaveBeenCalledOnce();
      expect(redo).toHaveBeenCalledOnce();
    });

    it('mutes all loops with the button or M, and lights the button', async () => {
      const button = element.querySelector<HTMLButtonElement>('.mute-button')!;
      expect(button.textContent).toContain('Mute all');

      button.click();
      await fixture.whenStable();
      expect(engine.areLoopsMuted()).toBe(true);
      expect(button.textContent).toContain('Unmute all');
      expect(button.classList).toContain('is-active');

      pressKey('m');
      await fixture.whenStable();
      expect(engine.areLoopsMuted()).toBe(false);
      pressKey('M', element.querySelector('#input-device')!);
      expect(engine.areLoopsMuted()).toBe(false);
    });

    it('shows and hides the input settings with I, even before audio starts', async () => {
      engine.status.set('idle');
      const button = () => element.querySelector('.collapse-button')!;

      pressKey('i');
      await fixture.whenStable();
      expect(button().getAttribute('aria-expanded')).toBe('false');

      pressKey('I');
      pressKey('i', element.querySelector('#latency-offset')!);
      await fixture.whenStable();
      expect(button().getAttribute('aria-expanded')).toBe('true');
    });

    it('gives each footswitch its number key', () => {
      const keys = Array.from(element.querySelectorAll('.footswitch')).map((footswitch) =>
        footswitch.getAttribute('aria-keyshortcuts'),
      );

      expect(keys).toEqual(['1', '2', '3', '4']);
    });

    it('offers to resume suspended audio and disables the footswitches meanwhile', async () => {
      engine.isSuspended.set(true);
      await fixture.whenStable();

      const alert = element.querySelector('.suspended')!;
      expect(alert.textContent).toContain('Audio was paused');
      expect(element.querySelector<HTMLButtonElement>('.footswitch')!.disabled).toBe(true);

      alert.querySelector('button')!.click();
      expect(engine.resumeAudio).toHaveBeenCalledOnce();
    });

    it('disables the footswitches while calibrating', async () => {
      engine.isCalibrating.set(true);
      await fixture.whenStable();

      expect(element.querySelector<HTMLButtonElement>('.footswitch')!.disabled).toBe(true);
    });
  });
});
