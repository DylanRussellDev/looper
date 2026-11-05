import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { FakeAudioEngine, provideFakeAudioEngine } from '../audio/audio-engine.testing';
import { LooperStore } from '../looper-store';
import { LoopPosition } from './loop-position';

describe('LoopPosition', () => {
  let engine: FakeAudioEngine;
  let store: LooperStore;
  let fixture: ComponentFixture<LoopPosition>;
  let element: HTMLElement;
  let frameCallbacks: FrameRequestCallback[];

  beforeEach(async () => {
    frameCallbacks = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
    engine = new FakeAudioEngine();

    await TestBed.configureTestingModule({
      imports: [LoopPosition],
      providers: [provideZonelessChangeDetection(), provideFakeAudioEngine(engine)],
    }).compileComponents();

    store = TestBed.inject(LooperStore);
    fixture = TestBed.createComponent(LoopPosition);
    element = fixture.nativeElement;
    await fixture.whenStable();
  });

  afterEach(() => vi.restoreAllMocks());

  function runFrame(): void {
    const callbacks = frameCallbacks.splice(0);
    callbacks.forEach((callback) => callback(0));
  }

  /** Records a 48 000-frame (1 s) first loop on track 1, which then plays. */
  async function recordMasterLoop(): Promise<void> {
    store.pressFootswitch(1, 'tap');
    store.pressFootswitch(1, 'tap');
    engine.getLastTake().resolve({ buffer: { length: 48_000 } as AudioBuffer, startFrame: 0 });
    await fixture.whenStable();
  }

  it('shows that there is no loop yet', () => {
    expect(element.textContent).toContain('No loop yet');
    expect(element.querySelector('.ring')!.classList).not.toContain('is-running');
  });

  it('sweeps with the audible position while a loop plays', async () => {
    await recordMasterLoop();
    engine.currentFrame = 12_000;
    runFrame();
    await fixture.whenStable();

    expect(element.textContent).toContain('1.0 s loop');
    expect(element.querySelector('.ring')!.classList).toContain('is-running');
    expect(element.querySelector('.sweep')!.getAttribute('stroke-dashoffset')).toBe('0.75');
  });

  it('stops sweeping when every track is stopped', async () => {
    await recordMasterLoop();
    store.pressFootswitch(1, 'double-tap');
    runFrame();
    await fixture.whenStable();

    expect(element.querySelector('.ring')!.classList).not.toContain('is-running');
    expect(element.textContent).toContain('1.0 s loop');
  });
});
