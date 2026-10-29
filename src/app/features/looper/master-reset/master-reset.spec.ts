import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { CONFIRM_WINDOW_MS, MasterReset } from './master-reset';

describe('MasterReset', () => {
  let fixture: ComponentFixture<MasterReset>;
  let button: HTMLButtonElement;
  let confirmations: number;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [MasterReset],
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();

    fixture = TestBed.createComponent(MasterReset);
    confirmations = 0;
    fixture.componentInstance.confirmed.subscribe(() => confirmations++);
    await fixture.whenStable();
    button = fixture.nativeElement.querySelector('button');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('arms on the first click without resetting', async () => {
    button.click();
    await fixture.whenStable();

    expect(confirmations).toBe(0);
    expect(button.textContent).toContain('Confirm reset');
    expect(fixture.nativeElement.querySelector('[role="status"]').textContent).toContain(
      'Press again',
    );
  });

  it('confirms on the second click and disarms', async () => {
    button.click();
    button.click();
    await fixture.whenStable();

    expect(confirmations).toBe(1);
    expect(button.textContent).toContain('Master Reset');
  });

  it('disarms after the confirm window', async () => {
    vi.useFakeTimers();
    button.click();
    vi.advanceTimersByTime(CONFIRM_WINDOW_MS);
    button.click();

    expect(confirmations).toBe(0);
  });

  it('disarms when focus leaves', () => {
    button.click();
    button.dispatchEvent(new FocusEvent('blur'));
    button.click();

    expect(confirmations).toBe(0);
  });
});
