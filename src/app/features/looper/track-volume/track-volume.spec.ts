import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { TrackVolume } from './track-volume';

describe('TrackVolume', () => {
  let fixture: ComponentFixture<TrackVolume>;
  let slider: HTMLInputElement;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TrackVolume],
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();

    fixture = TestBed.createComponent(TrackVolume);
    fixture.componentRef.setInput('trackId', 2);
    fixture.componentRef.setInput('volume', 0.5);
    await fixture.whenStable();
    slider = fixture.nativeElement.querySelector('input');
  });

  it('is a labelled slider showing the volume', () => {
    const label = fixture.nativeElement.querySelector('label') as HTMLLabelElement;

    expect(label.htmlFor).toBe(slider.id);
    expect(label.textContent).toContain('track 2');
    expect(label.textContent).toContain('50%');
    expect(slider.valueAsNumber).toBe(0.5);
  });

  it('updates the volume model as it moves', () => {
    const changes: number[] = [];
    fixture.componentInstance.volume.subscribe((volume) => changes.push(volume));

    slider.value = '0.8';
    slider.dispatchEvent(new Event('input'));

    expect(changes).toEqual([0.8]);
  });

  it('turns like a knob when dragged up and down', () => {
    const changes: number[] = [];
    fixture.componentInstance.volume.subscribe((volume) => changes.push(volume));
    const drag = (type: string, clientY: number) =>
      slider.dispatchEvent(new PointerEvent(type, { button: 0, pointerId: 1, clientY }));

    drag('pointerdown', 100);
    // 150 px is a full turn, so 30 px up is +20%, then 75 px down from the start is -50%.
    drag('pointermove', 70);
    drag('pointermove', 175);
    drag('pointerup', 175);
    drag('pointermove', 0);

    expect(changes).toEqual([0.7, 0]);
  });

  it('exposes the volume as a percentage to assistive technology', () => {
    expect(slider.getAttribute('aria-valuetext')).toBe('50%');
  });
});
