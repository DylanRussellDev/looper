# Looper project memory

Short project context for new sessions: read this instead of re-exploring the code.
Update it after every feature (what changed, decisions, gotchas).

## What it is

Browser 4-track guitar loop pedal. Angular 22, Web Audio + AudioWorklet. Desktop
Chrome/Edge only. Spec: `../looper-context.md`; coding standards: `../angular-22-context.md`.
Out of scope: effects, BPM, save/export of loops, MIDI, mobile.

## Rules (from the user)

- Standalone components (don't set `standalone: true`); OnPush is the default (don't set it).
  Signals, `inject()`, `@Service()`, `#private` members (except `viewChild`, which Angular
  forbids as ES private, so use `protected`). Four files per component. Use `@if`/`@for` with
  `track`; no ngClass/ngStyle.
- No Material, CDK, Tailwind or NgRx. SCSS only. WCAG 2.2 AA.
- Use `ng generate` for scaffolding. `ng build`, `ng test`, `ng lint` and Prettier must be clean.
- Stop after each feature or milestone for review. Ask before deviating from the spec.
  Commit only when asked, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- New features are usually designed first through a grill-me Q&A, then built.

## Commands

`npm start` (port 4200), `npm test` (Vitest), `npm run e2e` (Playwright on port 4300, using
the installed Chrome, one worker), `npm run lint`, `npx tsc -p e2e --noEmit`,
`npx prettier --check "src/**/*.{ts,html,scss}" "e2e/**/*.ts" "public/**/*.js"`.
Git: local repo on `main` with no remote.

## Layout (`src/app/features/looper/`)

- `audio/audio-engine.ts`: all Web Audio (context, worklet, routing, devices, playback, takes,
  calibration, noise detection). Driven by the store; knows no looper rules.
  `audio-engine.testing.ts` holds `FakeAudioEngine`, which is signal-backed and uses vi.fn.
- `public/worklets/recorder-processor.js`: AudioWorklet. Meters the input, applies the noise
  gate, keeps a 1 s history ring, records takes into pooled chunks sent as transferables.
  The protocol is mirrored in `audio/recorder-messages.ts`.
- Pure helpers: `audio/loop-timing.ts`, `level.ts`, `latency-calibration.ts`, `noise-gate.ts`,
  `audio-errors.ts`, `keyboard/shortcut-keys.ts`, `footswitch/footswitch-gesture.ts`.
- `looper-store.ts`: track state machine, master loop, layers, undo/redo, notices.
- Components: `looper-page` (layout, Z/Y/I shortcuts, suspended banner), `input-panel`
  (+ `input-panel-layout.ts`, the collapse state service), `noise-gate`, `footswitch`,
  `track-volume` (knob), `loop-position` (ring), `master-reset`; shared `level-meter`,
  `toggle-switch`.
- e2e: `e2e/support/pedal.ts` (page helper), `e2e/support/audio-probe.ts` (init script that
  records playback starts, simulates unplug and suspend, a `loopbackLatencyMs` cable, and a
  `syntheticInputDb` tone with `setInputLevel` and `getOutputPeak`).

## Signal flow

mic → source → inputGain → recorder worklet (meter → gate → history/takes → output) →
monitorGain → speakers. Loops: buffers → part gain → voice fade → track gain → loopBus →
speakers. Monitoring depends on the worklet, so a worklet crash also cuts monitoring.

## Features built

1. **M1:** project setup, device select, input gain, meter + clip, monitor toggle (off by default
   for built-in mics, detected by a label heuristic), errors (permission, no device,
   unplugged), single-track record/play/clear.
2. **M2:** 4 tracks with a master loop. The first loop sets the length; later recordings
   quantize to loop boundaries ("armed"/Waiting state). Footswitch tap, double-tap (350 ms)
   = stop, hold (1 s) = clear. Track volumes. Master reset with two-click confirm. The
   master resets when every track is empty.
3. **M3:** overdub (recorded in segments per loop cycle, then mixed into one layer),
   layers with undo/redo on the last-touched track, latency compensation, loop-point
   crossfade, fades on start/stop.
4. **M4:**
   - Pedal UI: knob volumes (150 px drag = full turn), loop position ring, enclosure styling,
     LED glow, keycaps.
   - Shortcuts: 1–4 (tap, double-tap, hold), Z/Y. Ignored in form controls (sliders and knobs
     included) and with Ctrl/Alt/Meta; key repeat ignored.
   - Calibration: 6 clicks, median of at least 4 agreeing, recorded on the raw clock; loops
     and monitor muted meanwhile.
   - Errors: suspended-audio banner with Resume, recorder crash, no-input notice.
5. **Noise gate** (commit e21e7b5):
   - The gate is in the worklet after metering. Fixed timing: 1 ms attack, 50 ms hold,
     100 ms release, 3 dB hysteresis.
   - The threshold compares the signal before the input gain: the engine sends
     threshold × gain to the worklet.
   - Slider: Off (position −81), then −80…−20 dB. The meter shows a marker and dims while
     the gate is closed.
   - Detect noise: listens 2 s after a 250 ms lead-in with loops muted, then sets
     threshold = loudest noise + 6 dB. Refuses noise above −20 dB. Bypassed during
     calibration.
   - Calibration and detection share `#beginMeasurement`/`#finishMeasurement`;
     `isMeasuring` blocks the footswitches.
   - Gotcha: the hysteresis must stay smaller than the 6 dB margin, or the noise holds the
     gate open.
6. **Collapsible Input section** (committed together with this memory.md):
   - The Settings button (`aria-expanded`, I key) hides device, gain, noise gate, latency and
     calibrate. The meter and Monitor toggle stay in the strip.
   - Collapsed settings are `inert` and `visibility: hidden` after a 200 ms grid-rows slide
     (instant with reduced motion).
   - Errors and warnings stay visible. Measurement progress and results repeat in
     `.collapsed-status` while collapsed.
   - Starts expanded. The choice is saved in localStorage key `looper.inputPanelCollapsed`,
     with try/catch.
   - I works even before audio starts.

## Known limits / open items

- Settings other than the collapse state reset on reload (nothing is persisted).
- No cap on the first recording's length (about 11 MB per minute).
- Calibration needs the output to reach the input (cable or mic), so it can't work with
  headphones.
- The meter floor is −60 dB, so gate markers below that sit at the left edge.
- The simulated loopback in e2e can read about 3 ms long (one render quantum); the test
  allows 120–124 ms.
- Chrome's fake mic in e2e is a loud beep: use `syntheticInputDb` for anything level-sensitive.
- The built-in preview browser can't grant microphone access, so real-audio testing is
  done by the user.

## Test counts (latest)

190 unit (20 files), 41 e2e.
