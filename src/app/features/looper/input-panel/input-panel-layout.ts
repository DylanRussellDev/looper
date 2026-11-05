import { DOCUMENT, Service, inject, signal } from '@angular/core';

const STORAGE_KEY = 'looper.inputPanelCollapsed';

/**
 * Whether the Input section is collapsed to its compact strip. Shared by the panel's
 * button and the page's I shortcut, and remembered in this browser: a layout preference,
 * unlike the audio settings, which reset on reload.
 */
@Service()
export class InputPanelLayout {
  readonly #storage = this.#getStorage();
  readonly #isCollapsed = signal(this.#read());

  readonly isCollapsed = this.#isCollapsed.asReadonly();

  toggle(): void {
    this.setCollapsed(!this.#isCollapsed());
  }

  setCollapsed(isCollapsed: boolean): void {
    this.#isCollapsed.set(isCollapsed);
    try {
      this.#storage?.setItem(STORAGE_KEY, String(isCollapsed));
    } catch {
      // Storage can be full or blocked; the choice then lasts until reload.
    }
  }

  #read(): boolean {
    try {
      return this.#storage?.getItem(STORAGE_KEY) === 'true';
    } catch {
      return false;
    }
  }

  #getStorage(): Storage | undefined {
    const view = inject(DOCUMENT).defaultView;
    // Even reading localStorage throws when the browser blocks site data.
    try {
      return view?.localStorage;
    } catch {
      return undefined;
    }
  }
}
