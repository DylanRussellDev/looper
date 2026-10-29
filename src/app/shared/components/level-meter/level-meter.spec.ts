import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { LevelMeter } from './level-meter';

describe('LevelMeter', () => {
  let fixture: ComponentFixture<LevelMeter>;
  let element: HTMLElement;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [LevelMeter],
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();

    fixture = TestBed.createComponent(LevelMeter);
    fixture.componentRef.setInput('label', 'Input level');
    fixture.componentRef.setInput('value', 0.4);
    element = fixture.nativeElement;
    await fixture.whenStable();
  });

  it('renders a labelled meter with the value', () => {
    const meter = element.querySelector('meter')!;
    const labelId = meter.getAttribute('aria-labelledby')!;

    expect(meter.value).toBeCloseTo(0.4);
    expect(element.querySelector(`#${labelId}`)!.textContent).toContain('Input level');
  });

  it('draws no threshold line unless given one', async () => {
    expect(element.querySelector('.marker')).toBeNull();

    fixture.componentRef.setInput('marker', 0.25);
    await fixture.whenStable();

    const marker = element.querySelector<HTMLElement>('.marker')!;
    expect(marker.style.getPropertyValue('--marker-position')).toBe('0.25');
    expect(marker.getAttribute('aria-hidden')).toBe('true');
  });

  it('dims the bar', async () => {
    fixture.componentRef.setInput('isDimmed', true);
    await fixture.whenStable();

    expect(element.querySelector('meter')!.classList).toContain('is-dimmed');
  });

  it('lights the clip indicator', async () => {
    fixture.componentRef.setInput('isClipping', true);
    await fixture.whenStable();

    expect(element.querySelector('.clip')!.classList).toContain('is-active');
  });
});
