import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { InputPanelLayout } from './input-panel-layout';

describe('InputPanelLayout', () => {
  const createLayout = () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
    return TestBed.inject(InputPanelLayout);
  };

  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('starts expanded the first time', () => {
    expect(createLayout().isCollapsed()).toBe(false);
  });

  it('toggles, and remembers the choice for next time', () => {
    const layout = createLayout();
    layout.toggle();
    expect(layout.isCollapsed()).toBe(true);

    expect(createLayout().isCollapsed()).toBe(true);
  });

  it('still works when the browser blocks storage', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('Blocked', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Blocked', 'SecurityError');
    });
    const layout = createLayout();

    expect(layout.isCollapsed()).toBe(false);
    layout.toggle();
    expect(layout.isCollapsed()).toBe(true);
  });
});
