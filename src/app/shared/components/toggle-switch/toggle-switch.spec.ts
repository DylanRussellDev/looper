import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { ToggleSwitch } from './toggle-switch';

describe('ToggleSwitch', () => {
  let fixture: ComponentFixture<ToggleSwitch>;
  let checkbox: HTMLInputElement;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ToggleSwitch],
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();

    fixture = TestBed.createComponent(ToggleSwitch);
    fixture.componentRef.setInput('label', 'Monitor');
    await fixture.whenStable();
    checkbox = fixture.nativeElement.querySelector('input');
  });

  it('is a labelled switch', () => {
    const label = fixture.nativeElement.querySelector('label') as HTMLLabelElement;

    expect(checkbox.getAttribute('role')).toBe('switch');
    expect(label.htmlFor).toBe(checkbox.id);
    expect(label.textContent).toContain('Monitor');
  });

  it('updates the checked model when toggled', () => {
    const changes: boolean[] = [];
    fixture.componentInstance.checked.subscribe((isChecked) => changes.push(isChecked));

    checkbox.click();

    expect(fixture.componentInstance.checked()).toBe(true);
    expect(changes).toEqual([true]);
  });
});
