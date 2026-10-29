import { Component, computed, input, model } from '@angular/core';

// Dragging this far (up or right) turns the knob from silent to full.
const DRAG_PIXELS_FOR_FULL_TURN = 150;
const VOLUME_STEP = 0.01;

interface KnobDrag {
  pointerId: number;
  startX: number;
  startY: number;
  startVolume: number;
}

/**
 * Per-track volume knob. Under the drawn knob sits a real (invisible) range input, so
 * keyboard, screen readers and form tools get a native slider; the pointer turns it by
 * dragging up/down or left/right, as on hardware, rather than jumping to the click.
 */
@Component({
  imports: [],
  selector: 'app-track-volume',
  styleUrl: './track-volume.scss',
  templateUrl: './track-volume.html',
})
export class TrackVolume {
  readonly trackId = input.required<number>();
  readonly disabled = input(false);
  /** 0..1 (silent to unity gain). */
  readonly volume = model(1);

  protected readonly inputId = computed(() => `track-volume-${this.trackId()}`);
  protected readonly volumePercent = computed(() => Math.round(this.volume() * 100));
  #drag: KnobDrag | undefined;

  protected setVolume(volume: number): void {
    this.volume.set(volume);
  }

  protected startDrag(event: PointerEvent): void {
    if (event.button !== 0 || this.disabled() || !(event.target instanceof HTMLInputElement)) {
      return;
    }
    // Stops the native slider jumping to where the knob was clicked.
    event.preventDefault();
    event.target.focus();
    event.target.setPointerCapture?.(event.pointerId);
    this.#drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startVolume: this.volume(),
    };
  }

  protected drag(event: PointerEvent): void {
    const drag = this.#drag;
    if (!drag || event.pointerId !== drag.pointerId) {
      return;
    }
    // Screen y grows downwards, so moving up turns the knob up.
    const distance = event.clientX - drag.startX + (drag.startY - event.clientY);
    const volume = drag.startVolume + distance / DRAG_PIXELS_FOR_FULL_TURN;
    const stepped = Math.round(volume / VOLUME_STEP) * VOLUME_STEP;
    const clamped = Math.min(1, Math.max(0, Number(stepped.toFixed(2))));
    if (clamped !== this.volume()) {
      this.volume.set(clamped);
    }
  }

  protected endDrag(): void {
    this.#drag = undefined;
  }
}
