import { isShortcutKeyEvent } from './shortcut-keys';

function keydownOn(target: Element, init: KeyboardEventInit = {}): KeyboardEvent {
  let captured: KeyboardEvent | undefined;
  document.addEventListener('keydown', (event) => (captured = event), { once: true });
  target.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true, ...init }));
  return captured!;
}

describe('isShortcutKeyEvent', () => {
  afterEach(() => document.body.replaceChildren());

  it('accepts plain keys on the page and on buttons', () => {
    const button = document.body.appendChild(document.createElement('button'));

    expect(isShortcutKeyEvent(keydownOn(document.body))).toBe(true);
    expect(isShortcutKeyEvent(keydownOn(button))).toBe(true);
  });

  it('ignores keys typed into form controls', () => {
    for (const tag of ['input', 'select', 'textarea']) {
      const control = document.body.appendChild(document.createElement(tag));
      expect(isShortcutKeyEvent(keydownOn(control))).toBe(false);
    }
  });

  it('ignores browser and system shortcuts', () => {
    expect(isShortcutKeyEvent(keydownOn(document.body, { ctrlKey: true }))).toBe(false);
    expect(isShortcutKeyEvent(keydownOn(document.body, { metaKey: true }))).toBe(false);
    expect(isShortcutKeyEvent(keydownOn(document.body, { altKey: true }))).toBe(false);
  });
});
