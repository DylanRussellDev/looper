import { Component, DestroyRef, computed, inject, input, output, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { isShortcutKeyEvent } from '../keyboard/shortcut-keys';
import { FootswitchAction, TrackState } from '../models/track';
import { FootswitchGesture } from './footswitch-gesture';

const TRACK_STATE_LABELS: Record<TrackState, string> = {
  empty: 'Empty',
  armed: 'Waiting',
  recording: 'Recording',
  playing: 'Playing',
  overdubbing: 'Overdubbing',
  stopped: 'Stopped',
};

/** What started the current press; only the same source can release it. */
type PressSource = 'pointer' | 'focus-key' | 'shortcut';

@Component({
  imports: [],
  selector: 'app-footswitch',
  styleUrl: './footswitch.scss',
  templateUrl: './footswitch.html',
  host: {
    '(document:keydown)': 'pressShortcut($event)',
    '(document:keyup)': 'releaseShortcut($event)',
    // Switching windows mid-press would swallow the key-up and leave a hold running.
    '(window:blur)': 'cancel()',
  },
})
export class Footswitch {
  readonly trackId = input.required<number>();
  readonly state = input.required<TrackState>();
  readonly disabled = input(false);
  /** The last-touched track, which Undo and Redo act on. */
  readonly isSelected = input(false);
  /** Key that works this footswitch from anywhere on the page, e.g. '1'. */
  readonly shortcutKey = input<string>();
  /** Id of the text explaining tap, double-tap and hold, shared by all footswitches. */
  readonly describedBy = input<string>();

  readonly action = output<FootswitchAction>();

  readonly #gesture = new FootswitchGesture();
  #pressSource: PressSource | null = null;
  protected readonly isPressed = signal(false);
  protected readonly stateLabel = computed(() => TRACK_STATE_LABELS[this.state()]);

  constructor() {
    this.#gesture.actions$
      .pipe(takeUntilDestroyed())
      .subscribe((action) => this.action.emit(action));
    inject(DestroyRef).onDestroy(() => this.#gesture.destroy());
  }

  protected pressPointer(event: PointerEvent): void {
    if (event.button !== 0) {
      return;
    }
    // Capturing the pointer means the release still reaches this button if the finger or
    // mouse slides off it; otherwise a missed release would turn a tap into a hold.
    if (event.currentTarget instanceof Element) {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    }
    this.#press('pointer');
  }

  protected pressKey(event: Event): void {
    event.preventDefault();
    // Auto-repeat would re-press while the key is held, breaking hold detection.
    if (event instanceof KeyboardEvent && event.repeat) {
      return;
    }
    this.#press('focus-key');
  }

  protected pressShortcut(event: KeyboardEvent): void {
    if (
      event.key !== this.shortcutKey() ||
      event.repeat ||
      this.disabled() ||
      !isShortcutKeyEvent(event)
    ) {
      return;
    }
    event.preventDefault();
    this.#press('shortcut');
  }

  protected releaseShortcut(event: KeyboardEvent): void {
    // No form-control check: a key pressed on the page and released in a field still ends.
    if (event.key === this.shortcutKey() && this.#pressSource === 'shortcut') {
      this.release();
    }
  }

  protected release(): void {
    if (!this.isPressed()) {
      return;
    }
    this.#pressSource = null;
    this.isPressed.set(false);
    this.#gesture.release();
  }

  protected cancel(): void {
    if (!this.isPressed()) {
      return;
    }
    this.#pressSource = null;
    this.isPressed.set(false);
    this.#gesture.cancel();
  }

  #press(source: PressSource): void {
    if (this.isPressed()) {
      return;
    }
    this.#pressSource = source;
    this.isPressed.set(true);
    this.#gesture.press();
  }
}
