import { Component, DOCUMENT, DestroyRef, computed, inject, signal } from '@angular/core';

import { AudioEngine } from '../audio/audio-engine';
import { LooperStore } from '../looper-store';

/**
 * A ring that sweeps once per master loop, shared by every track. It is redrawn every
 * animation frame from the audio clock, so it tracks what you hear rather than a timer.
 */
@Component({
  imports: [],
  selector: 'app-loop-position',
  styleUrl: './loop-position.scss',
  templateUrl: './loop-position.html',
})
export class LoopPosition {
  readonly #engine = inject(AudioEngine);
  readonly #store = inject(LooperStore);

  /** 0..1 through the loop, or null while nothing is playing. */
  protected readonly progress = signal<number | null>(null);
  protected readonly dashOffset = computed(() => 1 - (this.progress() ?? 0));
  protected readonly lengthLabel = computed(() => {
    const masterLoop = this.#store.masterLoop();
    if (!masterLoop) {
      return 'No loop yet';
    }
    const seconds = masterLoop.lengthFrames / this.#engine.getSampleRate();
    return `${seconds.toFixed(1)} s loop`;
  });

  constructor() {
    const view = inject(DOCUMENT).defaultView;
    if (!view?.requestAnimationFrame) {
      return;
    }
    let frameId = 0;
    const update = () => {
      this.progress.set(this.#store.getLoopProgress());
      frameId = view.requestAnimationFrame(update);
    };
    frameId = view.requestAnimationFrame(update);
    inject(DestroyRef).onDestroy(() => view.cancelAnimationFrame(frameId));
  }
}
