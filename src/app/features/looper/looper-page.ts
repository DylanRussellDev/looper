import { Component, computed, inject } from '@angular/core';

import { AudioEngine } from './audio/audio-engine';
import { Footswitch } from './footswitch/footswitch';
import { InputPanel } from './input-panel/input-panel';
import { InputPanelLayout } from './input-panel/input-panel-layout';
import { isShortcutKeyEvent } from './keyboard/shortcut-keys';
import { LoopPosition } from './loop-position/loop-position';
import { LooperStore } from './looper-store';
import { MasterReset } from './master-reset/master-reset';
import { FootswitchAction } from './models/track';
import { TrackVolume } from './track-volume/track-volume';

@Component({
  imports: [Footswitch, InputPanel, LoopPosition, MasterReset, TrackVolume],
  selector: 'app-looper-page',
  styleUrl: './looper-page.scss',
  templateUrl: './looper-page.html',
  host: {
    '(document:keydown)': 'handleShortcut($event)',
  },
})
export class LooperPage {
  readonly #engine = inject(AudioEngine);
  readonly #store = inject(LooperStore);
  readonly #inputPanelLayout = inject(InputPanelLayout);

  protected readonly tracks = this.#store.tracks;
  protected readonly notice = this.#store.notice;
  protected readonly lastTouchedTrackId = this.#store.lastTouchedTrackId;
  protected readonly canUndo = this.#store.canUndo;
  protected readonly canRedo = this.#store.canRedo;
  protected readonly areLoopsMuted = this.#store.areLoopsMuted;
  protected readonly isSuspended = this.#engine.isSuspended;
  protected readonly historyTargetLabel = computed(() => {
    const trackId = this.lastTouchedTrackId();
    return trackId === null ? 'Touch a track to select it' : `Acts on Track ${trackId}`;
  });
  protected readonly isAudioRunning = computed(() => this.#engine.status() === 'running');
  protected readonly isAudioStarting = computed(() => this.#engine.status() === 'starting');
  // While suspended the audio clock is frozen, so nothing could be scheduled in time.
  protected readonly areFootswitchesDisabled = computed(
    () => !this.isAudioRunning() || this.isSuspended() || this.#engine.isMeasuring(),
  );
  protected readonly startButtonLabel = computed(() =>
    this.isAudioStarting() ? 'Starting…' : 'Enable audio',
  );

  protected startAudio(): void {
    void this.#engine.start();
  }

  protected resumeAudio(): void {
    void this.#engine.resumeAudio();
  }

  protected pressFootswitch(trackId: number, action: FootswitchAction): void {
    this.#store.pressFootswitch(trackId, action);
  }

  protected resetAll(): void {
    this.#store.resetAll();
  }

  protected undo(): void {
    this.#store.undo();
  }

  protected redo(): void {
    this.#store.redo();
  }

  protected toggleMuteAll(): void {
    this.#store.toggleMuteAll();
  }

  protected setTrackVolume(trackId: number, volume: number): void {
    this.#store.setTrackVolume(trackId, volume);
  }

  /** Z, Y, M and I; the footswitches handle their own number keys. */
  protected handleShortcut(event: KeyboardEvent): void {
    if (event.repeat || !isShortcutKeyEvent(event)) {
      return;
    }
    const key = event.key.toLowerCase();
    // Showing or hiding settings is layout only, so it works before audio starts too.
    if (key === 'i') {
      this.#inputPanelLayout.toggle();
      return;
    }
    if (!this.isAudioRunning()) {
      return;
    }
    switch (key) {
      case 'z':
        this.undo();
        break;
      case 'y':
        this.redo();
        break;
      case 'm':
        this.toggleMuteAll();
        break;
    }
  }
}
