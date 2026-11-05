import { Component, input, model } from '@angular/core';

let nextToggleSwitchId = 0;

@Component({
  imports: [],
  selector: 'app-toggle-switch',
  styleUrl: './toggle-switch.scss',
  templateUrl: './toggle-switch.html',
})
export class ToggleSwitch {
  readonly label = input.required<string>();
  readonly disabled = input(false);
  readonly checked = model(false);

  protected readonly inputId = `toggle-switch-${nextToggleSwitchId++}`;

  protected setChecked(isChecked: boolean): void {
    this.checked.set(isChecked);
  }
}
