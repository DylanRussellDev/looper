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

  protected readonly labelId = `level-meter-label-${nextLevelMeterId++}`;
}
