import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { FootswitchAction } from '../models/track';
import { Footswitch } from './footswitch';
import { HOLD_DURATION_MS } from './footswitch-gesture';

describe('Footswitch', () => {
  let fixture: ComponentFixture<Footswitch>;
  let button: HTMLButtonElement;
  let actions: FootswitchAction[];

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [Footswitch],
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();

    fixture = TestBed.createComponent(Footswitch);
    fixture.componentRef.setInput('trackId', 1);
    fixture.componentRef.setInput('state', 'playing');
    actions = [];
    fixture.componentInstance.action.subscribe((action) => actions.push(action));
    await fixture.whenStable();
    button = fixture.nativeElement.querySelector('button');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the track name and state, and exposes the state for the LED', () => {
    expect(button.textContent).toContain('Track 1');
    expect(button.textContent).toContain('Playing');
    expect(button.dataset['state']).toBe('playing');
  });

  it('dims a playing track while mute all is on, but not an empty one', async () => {
    fixture.componentRef.setInput('isMuted', true);
    await fixture.whenStable();
    expect(button.classList).toContain('is-muted');
    expect(button.textContent).toContain('Playing (muted)');

    fixture.componentRef.setInput('state', 'empty');
    await fixture.whenStable();
    expect(button.classList).not.toContain('is-muted');
    expect(button.textContent).not.toContain('(muted)');
  });

  it('emits tap on a quick pointer press', () => {
    button.dispatchEvent(new MouseEvent('pointerdown', { button: 0 }));
    button.dispatchEvent(new MouseEvent('pointerup'));

    expect(actions).toEqual(['tap']);
  });

  it('emits hold after the pointer is held', () => {
    vi.useFakeTimers();
    button.dispatchEvent(new MouseEvent('pointerdown', { button: 0 }));
    vi.advanceTimersByTime(HOLD_DURATION_MS);

    expect(actions).toEqual(['hold']);
  });

  it('works from the keyboard and ignores key repeat', () => {
    vi.useFakeTimers();
    button.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }));
    button.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', repeat: true }));
    vi.advanceTimersByTime(HOLD_DURATION_MS / 2);
    button.dispatchEvent(new KeyboardEvent('keyup', { key: ' ' }));

    expect(actions).toEqual(['tap']);
  });

  it('shows pressed feedback while held', async () => {
    button.dispatchEvent(new MouseEvent('pointerdown', { button: 0 }));
    await fixture.whenStable();
    expect(button.classList).toContain('is-pressed');

    button.dispatchEvent(new MouseEvent('pointerup'));
    await fixture.whenStable();
    expect(button.classList).not.toContain('is-pressed');
  });

  describe('keyboard shortcut', () => {
    const pressKey = (type: 'keydown' | 'keyup', init: KeyboardEventInit, target: Element) =>
      target.dispatchEvent(new KeyboardEvent(type, { bubbles: true, ...init }));

    beforeEach(async () => {
      fixture.componentRef.setInput('shortcutKey', '1');
      await fixture.whenStable();
    });

    afterEach(() => document.body.querySelectorAll('.extra').forEach((node) => node.remove()));

    it('taps from anywhere on the page and advertises the key', () => {
      pressKey('keydown', { key: '1' }, document.body);
      pressKey('keyup', { key: '1' }, document.body);

      expect(actions).toEqual(['tap']);
      expect(button.getAttribute('aria-keyshortcuts')).toBe('1');
      expect(button.querySelector('kbd')!.textContent).toContain('1');
    });

    it('double-taps and holds with the key, ignoring key repeat', () => {
      vi.useFakeTimers();
      pressKey('keydown', { key: '1' }, document.body);
      pressKey('keyup', { key: '1' }, document.body);
      pressKey('keydown', { key: '1' }, document.body);
      pressKey('keyup', { key: '1' }, document.body);
      vi.advanceTimersByTime(1000);

      pressKey('keydown', { key: '1' }, document.body);
      pressKey('keydown', { key: '1', repeat: true }, document.body);
      vi.advanceTimersByTime(HOLD_DURATION_MS);
      pressKey('keyup', { key: '1' }, document.body);

      expect(actions).toEqual(['tap', 'double-tap', 'hold']);
    });

    it('ignores the key in form controls, other keys, and while disabled', async () => {
      const field = document.body.appendChild(document.createElement('input'));
      field.className = 'extra';
      pressKey('keydown', { key: '1' }, field);
      pressKey('keyup', { key: '1' }, field);
      pressKey('keydown', { key: '2' }, document.body);
      pressKey('keyup', { key: '2' }, document.body);

      fixture.componentRef.setInput('disabled', true);
      await fixture.whenStable();
      pressKey('keydown', { key: '1' }, document.body);
      pressKey('keyup', { key: '1' }, document.body);

      expect(actions).toEqual([]);
    });
  });
});
