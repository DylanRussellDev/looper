import { FootswitchAction } from '../models/track';
import { DOUBLE_TAP_WINDOW_MS, FootswitchGesture, HOLD_DURATION_MS } from './footswitch-gesture';

describe('FootswitchGesture', () => {
  let gesture: FootswitchGesture;
  let actions: FootswitchAction[];

  function tap(): void {
    gesture.press();
    vi.advanceTimersByTime(50);
    gesture.release();
  }

  beforeEach(() => {
    vi.useFakeTimers();
    gesture = new FootswitchGesture();
    actions = [];
    gesture.actions$.subscribe((action) => actions.push(action));
  });

  afterEach(() => {
    gesture.destroy();
    vi.useRealTimers();
  });

  it('emits tap immediately on release', () => {
    tap();
    expect(actions).toEqual(['tap']);
  });

  it('emits double-tap (not a second tap) for two quick taps', () => {
    tap();
    vi.advanceTimersByTime(100);
    tap();

    expect(actions).toEqual(['tap', 'double-tap']);
  });

  it('treats taps further apart than the window as separate taps', () => {
    tap();
    vi.advanceTimersByTime(DOUBLE_TAP_WINDOW_MS + 10);
    tap();

    expect(actions).toEqual(['tap', 'tap']);
  });

  it('starts a new double-tap after a completed one', () => {
    tap();
    tap();
    tap();

    expect(actions).toEqual(['tap', 'double-tap', 'tap']);
  });

  it('emits hold while still held, and ignores the later release', () => {
    gesture.press();
    vi.advanceTimersByTime(HOLD_DURATION_MS);
    expect(actions).toEqual(['hold']);

    gesture.release();
    expect(actions).toEqual(['hold']);
  });

  it('emits hold when the second press of a double-tap is held', () => {
    tap();
    gesture.press();
    vi.advanceTimersByTime(HOLD_DURATION_MS);

    expect(actions).toEqual(['tap', 'hold']);
  });

  it('emits nothing when the press is cancelled', () => {
    gesture.press();
    gesture.cancel();
    vi.advanceTimersByTime(HOLD_DURATION_MS * 2);
    gesture.release();

    expect(actions).toEqual([]);
  });
});
