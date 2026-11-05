import { Component, DestroyRef, computed, inject, input, output, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subscription, timer } from 'rxjs';

export const CONFIRM_WINDOW_MS = 3000;

/**
 * Two-step button: the first press arms it, a second press within CONFIRM_WINDOW_MS
 * confirms. Clearing everything can't be undone, so one stray click must not do it.
 */
@Component({
  imports: [],
  selector: 'app-master-reset',
  styleUrl: './master-reset.scss',
  templateUrl: './master-reset.html',
})
export class MasterReset {
  readonly #destroyRef = inject(DestroyRef);

  readonly disabled = input(false);

  readonly confirmed = output<void>();

  protected readonly isArmed = signal(false);
  protected readonly label = computed(() => (this.isArmed() ? 'Confirm reset' : 'Master Reset'));
  protected readonly statusMessage = computed(() =>
    this.isArmed() ? 'Press again within 3 seconds to stop and clear all tracks.' : '',
  );
  #disarmTimer: Subscription | undefined;

  protected press(): void {
    if (this.isArmed()) {
      this.disarm();
      this.confirmed.emit();
      return;
    }
    this.isArmed.set(true);
    this.#disarmTimer = timer(CONFIRM_WINDOW_MS)
      .pipe(takeUntilDestroyed(this.#destroyRef))
      .subscribe(() => this.disarm());
  }

  protected disarm(): void {
    this.#disarmTimer?.unsubscribe();
    this.isArmed.set(false);
  }
}
