import { Component, input } from '@angular/core';

let nextLevelMeterId = 0;

@Component({
  imports: [],
  selector: 'app-level-meter',
  styleUrl: './level-meter.scss',
  templateUrl: './level-meter.html',
})
export class LevelMeter {
  readonly label = input.required<string>();
  /** Meter position, 0..1. */
  readonly value = input.required<number>();
  readonly isClipping = input(false);
  /** Position of a threshold line, 0..1, or null for none. Visual only: the control that
   * sets the threshold describes it. */
  readonly marker = input<number | null>(null);
  /** Fades the bar, e.g. while a gate is holding the signal back. */
  readonly isDimmed = input(false);

  protected readonly labelId = `level-meter-label-${nextLevelMeterId++}`;
}
