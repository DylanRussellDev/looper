import { Observable, Subject, Subscription, timer } from 'rxjs';

import { FootswitchAction } from '../models/track';

export const HOLD_DURATION_MS = 1000;
export const DOUBLE_TAP_WINDOW_MS = 350;

/**
 * Turns raw press/release signals into footswitch actions. Kept free of DOM details so
 * pointer, keyboard and (later) global shortcut input can all share it.
 *
 * - Released before HOLD_DURATION_MS: 'tap', fired immediately on release. Taps are
 *   never delayed to wait for a possible double-tap, because recording timing matters.
 * - A second tap within DOUBLE_TAP_WINDOW_MS of the first: 'double-tap' instead of 'tap'.
 * - Held for HOLD_DURATION_MS: 'hold', fired while still held; the release is ignored.
 */
export class FootswitchGesture {
  readonly #actions = new Subject<FootswitchAction>();
  readonly actions$: Observable<FootswitchAction> = this.#actions.asObservable();

  #isPressed = false;
  #isHeld = false;
  #holdTimer: Subscription | undefined;
  #doubleTapWindow: Subscription | undefined;

  press(): void {
    if (this.#isPressed) {
      return;
    }
    this.#isPressed = true;
    this.#isHeld = false;
    this.#holdTimer = timer(HOLD_DURATION_MS).subscribe(() => {
      this.#isHeld = true;
      this.#closeDoubleTapWindow();
      this.#actions.next('hold');
    });
  }

  release(): void {
    if (!this.#isPressed) {
      return;
    }
    this.#isPressed = false;
    this.#holdTimer?.unsubscribe();
    if (this.#isHeld) {
      return;
    }

    if (this.#isDoubleTapWindowOpen()) {
      this.#closeDoubleTapWindow();
      this.#actions.next('double-tap');
      return;
    }
    this.#actions.next('tap');
    this.#doubleTapWindow = timer(DOUBLE_TAP_WINDOW_MS).subscribe();
  }

  cancel(): void {
    this.#isPressed = false;
    this.#holdTimer?.unsubscribe();
  }

  destroy(): void {
    this.cancel();
    this.#closeDoubleTapWindow();
    this.#actions.complete();
  }

  #isDoubleTapWindowOpen(): boolean {
    return this.#doubleTapWindow !== undefined && !this.#doubleTapWindow.closed;
  }

  #closeDoubleTapWindow(): void {
    this.#doubleTapWindow?.unsubscribe();
    this.#doubleTapWindow = undefined;
  }
}
