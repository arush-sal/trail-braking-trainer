# Phase 1 manual hardware and browser test protocol

Purpose: collect evidence for R-003, R-028, R-029, R-037 and the gates in
`validation-log.md`. Automated tests use fakes; only this protocol can verify
real devices. Record every run as a row in `validation-log.md`, and paste the
"Copy diagnostics report" JSON into `docs/evidence/<date>-<device>-<browser>.json`.

## Setup
1. `make build && npm run preview -w apps/web` (or `make dev`), open the URL.
2. Note OS, kernel/driver, browser + version, wheel/pedal model and firmware,
   wheel mode (PC / compat), USB hub vs direct.
3. Fanatec: record exact base model (CSL DD vs ClubSport DD+) from the base's
   label or Fanatec app, and pedal model.

## T1 Device discovery and axis layout (per browser: Chrome, Firefox; Safari if macOS)
1. Connect device(s), press a button (browsers expose gamepads only after input).
2. Devices panel: record device name/index, axes count, buttons count.
3. For brake, throttle, steering: use "Detect", move only that control.
   Record axis/button index, raw value at rest and at full travel, inversion.
4. Pedals on a separate USB device from the wheel: confirm both appear and
   can be mapped independently.

## T2 Resolution, rate, noise
1. Leave controls at rest 30 s: record raw jitter (min/max) per axis.
2. Move each control slowly full range: note visible step size (resolution).
3. Record measured device Hz and poll interval p50/p95/max.

## T3 Calibration is optional
1. Without calibration: confirm B/T read 0% at rest and ~100% at full travel,
   or record what they read instead (do not "fix" in code without evidence).
2. With calibration (range capture, center, deadzone): record improvement.

## T4 Disconnect / reconnect (R-029)
1. Unplug the mapped device mid-stream: channel must show n/a and a loss event.
2. Plug a different controller: it must NOT take over the mapping.
3. Replug the original: mapping restores.

## T5 Background behavior (validation gate)
For each: visible + focused, visible + unfocused (click another window),
hidden tab, minimized window, full-screen game in front, laptop on battery saver.
Record poll interval stats, gap count, whether values keep updating, and
whether the tone keeps tracking input. Do not assume any of these work.

## T6 Audio
1. "Enable audio", test tone, select brake: pitch tracks pedal.
2. Record control-update latency p50/p95 from the panel.
3. Acoustic end-to-end latency (optional): record pedal + headphone/speaker
   audio with a phone at 240 fps or a mic next to the pedal; measure onset gap.
4. Note any glitches, clicks, or suspended audio after tab switches.

## T7 Capabilities
Record SpeechRecognition presence (and whether it is on-device), secure
context, AudioContext base/output latency.

## T8 GT7 collector over WebSocket (mock now, real in Phase 5)
1. `node tests/mock-collector/server.mjs --origin <app origin>`; connect from
   the app on http://localhost and from the HTTPS preview/prod origin.
2. Repeat against the LAN IP (`--host 0.0.0.0`) from another device.
3. Record: connection allowed/blocked, any Local Network Access prompt,
   mixed-content errors, per browser.
