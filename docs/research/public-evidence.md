# Public evidence for defaults (NOT locally verified)

Compiled 2026-11-14 from public sources. Nothing here was measured on our hardware or
browsers; every claim stays `Open` in `validation-log.md` until the T1-T8 tests in
`hardware-test-protocol.md` confirm it. Tags: **[DOC]** documented fact (spec, vendor,
source code read directly), **[COMM]** community report (forum, issue, third-party blog),
**[INF]** our inference from the above. Confidence: H / M / L.

Tool caveat: several pages were summarized by a fetch tool rather than read in full;
where a quote matters (code line, spec sentence) it was cross-checked against raw source
where noted. Re-read the linked page before relying on a number.

---

## 1. Logitech G923 (PS/PC and Xbox/PC) in browsers

**Findings**
- USB IDs [COMM, mescon driver wiki]: PS edition boots as `046d:c267`, switches to `046d:c266`
  (PC mode). Xbox edition `046d:c26d` (console-only, no input node on Linux) -> `046d:c26e`
  after mode switch. Kernel patches name the Xbox edition `c26d`. [DOC-ish: kernel patches + driver wiki]
- Raw HID polarity [COMM, mescon wiki G923 page]: "This wheel sends all three pedals inverted:
  255 with the pedal released and 0 with it flat to the floor." The Linux driver (not the
  stock kernel) corrects this; raw HID is left as the wheel sends it. "Nothing in HID marks
  an axis as inverted."
- Browser normalization [DOC, W3C Gamepad s4.1 + Chromium `raw_input_gamepad_device_win.cc`
  `NormalizeAxis`]: `2*(v-min)/(max-min)-1`. [INF] Released=255 of 0..255 therefore reads
  **+1 at rest, -1 fully pressed** on any path that passes raw HID through (Chrome/Firefox
  on Windows raw input, Chrome via Linux joydev unless a driver inverts).
- Axis order [DOC, Chromium]: Windows raw-input index = HID usage - 0x30 (X=0, Y=1, Z=2,
  Rx=3, Ry=4, Rz=5, Slider=6...). Linux joydev numbers axes in ABS code order. [INF] Wheel on
  axis 0 (X); pedals on remaining axes. Which index is throttle/brake/clutch for the G923
  was **not found** in any public source; Linux `evtest` posts show G923 PS exposing
  ABS_X/Y/Z/RX/RY/RZ all 0..255 (flat 15) plus HAT0 [COMM, Arch forum 275143], but with
  inconclusive rest values.
- Combined pedals [DOC, Logitech G HUB text]: an optional "combined pedals" setting merges
  throttle and brake into two halves of one axis. Default is separate axes.
- Xbox edition on Windows [INF, Chromium source]: Chrome treats devices whose path has
  `IG_` as XInput and reads them with XInput, producing a **standard mapping**: wheel =
  left stick X (axes[0]), triggers = buttons[6] (LT) / buttons[7] (RT), analog 0..1,
  rest 0. Chromium's XInput ID list does not include `046d:c26e`, so whether the Xbox
  G923 appears as XInput or as raw HID on PC is **unresolved**. Clutch is probably not
  exposed through XInput [INF, low].
- Linux [COMM]: PS edition works under `hid-logitech`/new-lg4ff-style drivers; Xbox
  edition support merged into `hid-logitech-hidpp` via 2021-2023 patches (Walt Holman,
  Take 2). Early notes said two pedal axes did not work (2021); later reports say force
  feedback and all buttons work.
- Rotation range [DOC, kernel `hid-logitech-hidpp.c`, G920 path]: falls back to 900 deg if
  the aperture read fails; sysfs `range` clamped 180..900. Driver wiki for G923 says
  40..900 deg. Default is not stated beyond the 900 fallback. G923 hardware lock-to-lock
  is 900 deg (vendor marketing, not re-verified).
- Button count: PS edition has 18 real buttons per the driver wiki [COMM]; Xbox count
  not stated. Browser `buttons.length` also includes hat/dpad mapped buttons - unknown.

**Sources**
- https://github.com/mescon/logitech-trueforce-linux-driver/wiki/G923 (fetched 2026-11-14)
- https://github.com/mescon/logitech-trueforce-linux-driver (2026-11-14)
- https://bbs.archlinux.org/viewtopic.php?id=275143 (2026-11-14)
- https://lkml.iu.edu/hypermail/linux/kernel/2301.1/04790.html and
  https://lore.kernel.org/r/20210527134104.217865-1-rickytaylor26@gmail.com (kernel patches)
- https://raw.githubusercontent.com/torvalds/linux/master/drivers/hid/hid-logitech-hidpp.c (G920 range code)
- https://raw.githubusercontent.com/chromium/chromium/main/device/gamepad/raw_input_gamepad_device_win.cc
  and `gamepad_id_list.cc` (read 2026-11-14)
- https://www.w3.org/TR/gamepad/ (read 2026-11-14)

**Confidence**: pedal polarity on PS edition M (one driver-author source + formula);
Xbox edition path L; axis index assignment L (not found).

**Implications**
- Pedal rest +1 (axis, invert=true... see below) is the likely G923-PS default. Our
  `defaultMapping` assumes rest -1; for G923 PS it is likely backwards.
- Keep auto-detect (Detect button) as primary; use a per-device preset only as a *suggested*
  starting point, flagged "from public info".
- Support button-pedal (0..1) path for Xbox/XInput - already supported.

**Still needs local test**: T1 on G923 PS and Xbox: axis count, indices, rest/full values,
whether Chrome/Windows uses XInput for the Xbox edition, clutch exposure.

---

## 2. Fanatec CSL DD / ClubSport DD+ and pedals

**Findings**
- VID `0x0EB7` (Endor AG). PID `0x0020` for "CSL DD / DD Pro / ClubSport DD Wheel Base"
  [COMM-driver table: gotzl/hid-fanatecff README]. Fanatec forum thread: since the CSL DD
  all bases show as "Fanatec Wheel" in Windows with PID 0020 [COMM, 403 on direct fetch;
  seen via search snippet only].
- ClubSport DD+ is **not named** in the driver table; "ClubSport DD" shares 0020. [INF] CSL DD
  and ClubSport DD(+) are **indistinguishable by USB VID/PID or the Gamepad `id`
  string**. Distinguish via Fanatec app/firmware UI or base label (matches our T-protocol
  step). Low-level: driver reads a firmware/wheelbase-id report, not exposed to browsers.
- Other PIDs [COMM, hid-fanatecff]: CSL Elite base `0E03`, CSL Elite PS4 `0005`, CSL
  Elite Pedals `6204`, CSL Pedals Loadcell `6205`, CSL Pedals LC V2 `6206`, ClubSport V2
  `0001`, V2.5 `0004`, ClubSport Pedals V3 `183b`, Podium DD1 `0006`, DD2 `0007`.
- PC mode vs compat: driver requires "PC mode" (red LED on CSL Elite/CSL DD). [DOC-ish,
  driver README]. Fanatec manuals describe a PC compatibility mode (yellow) that makes DD
  bases report as a ClubSport Wheel Base V2.5 [COMM, search snippet of manual copies]. Under
  compat mode VID/PID would differ and force feedback/axis resolution may be reduced:
  **[INF] our app must key mapping on `id` string, not assume 0020.**
- Pedals: connect via base RJ12 (appear as part of base's input) or standalone USB (separate
  HID device). Fanatec docs: pedals wired to the base give vibration motor support; USB
  standalone otherwise [COMM, driver instructions copy]. Forum: "Windows sees DD as two
  distinct devices, games only one; may swap after reconnect/firmware update" [COMM].
- Resolution [COMM, forum + product page]: load-cell brake is 12-bit via base, **16-bit
  only when connected via USB to PC**. Fanatec GT DD Pro product page: Hall sensor pedals
  12-bit. CSL DD steering reports 16-bit to Windows (downsampled from a much finer
  encoder; forum calculation ~482k CPR).
- Inversion/rest [COMM]: multiple forum threads report "pedals at 100% untouched, ->0%
  when pressed" (inverted) and "50% at rest then jumps to 100%" on CSL/V3; cause cited as
  driver invert settings, combined-pedals mode, or calibration. So polarity is a
  per-driver-setting, not fixed.
- Linux [DOC, hid-ftec.c read from raw GitHub 2026-11-14]: driver sets no ABS inversion
  or combined-pedal logic; axes come from the device descriptor (pass-through). Range
  defaults in driver: 90..1090 ("1090 = auto"), 900 for CSL/CS V2/V2.5, 2530 (2520 max)
  for Podium DD1/DD2 and CSL DD. So CSL DD rotation range is large (up to 2520 deg
  configurable) and **degrees are not a safe default for steering normalization**.
- Axis layout in browsers: **not found** in any public source.

**Sources**
- https://github.com/gotzl/hid-fanatecff (2026-11-14)
- https://raw.githubusercontent.com/gotzl/hid-fanatecff/master/hid-ftec.c (2026-11-14)
- https://forum.fanatec.com/discussion/31124/ (search snippet only; page 403 to fetcher)
- https://manuals.plus/m/58360fbdf24d8b929f5ec230e8f3f714ca581727c9a8b6d11df41bfd6c4e3035
- https://forum.fanatec.com/discussion/comment/67243, /33230, https://bi.fanatec.com/discussion/comment/32431/
  (resolution threads, search snippets)
- https://fanatec.com//au/en/explorer/products/racing-wheels-wheel-bases/cs-dd-plus/ (manual page)

**Confidence**: VID/PID M-H; DD+ vs CSL DD indistinguishable M; axis layout L; pedal
polarity L; resolution M-L.

**Implications**
- Show vid/pid parsed from `gamepad.id` in the Devices panel and require the user to
  confirm model; never auto-assume.
- Pedal-through-base vs USB changes resolution (12 vs 16 bit) -> noise floor should be
  per-source and user-recordable.
- No fixed default pedal polarity; rely on Detect + invert toggle.

**Still needs local test**: T1/T2 on actual base: id string (record exact), pedals via base
vs USB (one or two entries), axis indices, rest values, whether PS/compat mode changes id.

---

## 3. Gamepad API: polling, timestamp, background behavior

**Findings**
- Chromium polls at 4 ms (~250 Hz) [DOC: `gamepad_provider.cc`
  `kPollingIntervalMilliseconds = 4`; configurable via Finch (commit a8f2f69)]. The page
  sees a snapshot in shared memory; `getGamepads()` only reads it. Effective JS sample
  rate is the rAF/timer rate, not the OS rate.
- Timestamp semantics [DOC: spec; Chromium source read directly]:
  - W3C: `timestamp` updated "each time the system receives new button or axis input
    values"; before data, it is the time first exposed. UAs SHOULD have >= 5 us resolution.
  - Chrome **Linux**: `pad->timestamp` set only `if (pad_updated)` after joydev/evdev reads
    (`gamepad_device_linux.cc:317`) -> **changes only on input events**. Wheels that send
    reports only on change (many do) would show a stale timestamp at rest.
  - Chrome **Windows raw input** (DirectInput-class devices, i.e. most wheels): timestamp is
    `last_update_timestamp_`, set when a HID report arrives (`raw_input_gamepad_device_win.cc`)
    -> changes per **report arrival**, and wheels vary in whether they send continuous
    reports. [INF]
  - Chrome **Windows XInput**: `pad.timestamp = CurrentTimeInMicroseconds()` on each
    successful poll -> changes **every poll**, regardless of state change.
  - Firefox: MDN says `timestamp` is "not currently supported in Firefox" [DOC-ish, MDN; may
    be stale].
  - [INF] Therefore our assumption "Chrome only changes on state change" is **platform
    specific**; never use `timestamp` equality as a staleness or duplicate signal, and
    do not use it as a rate estimate. Use `performance.now()` at poll time plus
    state-change detection.
- Timer/rAF throttling [DOC, Chrome blog 2021]: rAF pauses while page hidden. Timers in
  hidden pages: minimal throttle if page visible or audible within 30 s; 1 Hz throttling
  when hidden; intensive (1/min wake-ups) after 5 min hidden with chained timers >= 5, not
  audible 30 s, no WebRTC. WebRTC (live track/RTCDataChannel) or audio playing exempt from
  intensive throttling. WebSocket-related flag exists but not documented as exemption.
- Does hidden/unfocused window keep updating? [COMM/INF, W3C gamepad issue #206
  thread 2024]: spec checks visibility not focus, but "on some platforms the system APIs
  used to access gamepad inputs have focus requirements that prevent background access",
  and different OS APIs for different pads. A WebKit visionOS bug reports stale last state
  (Safari). No authoritative statement for Chrome/Windows raw input of a wheel in a
  background window. **Treat as unknown; T5.**
- Exposure/gesture [DOC: W3C s12]: `getGamepads()` returns an empty list "before a gamepad
  user gesture has been seen"; button needs neutral default + prior false, axes need
  neutral default and crossing a UA threshold. Gesture requires document "fully active with
  user attention". Firefox: exposed "only when the user interacts with one with the page
  visible" [DOC, MDN]. Chrome source: connect events and raw-input events are gated on
  `ever_had_user_gesture_`; data is written to shared memory first.
  [INF] A wheel whose resting pedal axis is at +1 or 0.5 may not satisfy "neutral default"
  heuristics; the user may need to press a wheel button (T1 already says so).
- Secure context: W3C text fetched did not state it; MDN getGamepads page did not state it.
  [General knowledge, unverified here] Chrome restricts Gamepad API to secure contexts;
  https or localhost are fine for us either way.
- Permissions Policy [DOC: W3C s20]: feature `"gamepad"`, default allowlist `*`; if disabled
  `getGamepads()` throws SecurityError and events do not fire. Matters only if embedded
  in a cross-origin iframe with a restrictive policy.
- Safari [COMM, WebKit bug 217664]: Safari 14 `id` lacks vendor/product ids. Do not rely
  on VID/PID parsing there.

**Sources**
- https://www.w3.org/TR/gamepad/ (2026-11-14)
- https://raw.githubusercontent.com/chromium/chromium/main/device/gamepad/gamepad_provider.cc,
  `gamepad_device_linux.cc`, `raw_input_gamepad_device_win.cc`, `xinput_data_fetcher_win.cc`
  (downloaded 2026-11-14; line refs above)
- https://chromium.googlesource.com/chromium/src/+/a8f2f6979278a75d356a4baacb5b3cf1200544b7
- https://developer.chrome.com/blog/timer-throttling-in-chrome-88 (2026-11-14)
- https://developer.mozilla.org/en-US/docs/Web/API/Gamepad_API/Using_the_Gamepad_API and
  .../Gamepad/timestamp
- https://lists.w3.org/Archives/Public/public-webapps-github/2024May/0289.html (issue #206)
- https://bugs.webkit.org/show_bug.cgi?id=273631 , https://auto-bugs.webkit.org/show_bug.cgi?id=217664

**Confidence**: polling 4 ms H; timestamp per-platform H (source read); background
behaviour L; gesture rules H (spec) / M (impl).

**Implications**
- Replace "assumed" in the validation log with the per-platform facts above.
- Adapter emitting a frame per poll is fine; add a `stateChanged` flag computed by us.
- Because hidden tabs get rAF stopped and timers at 1 Hz, the training UI must clearly
  require the tab visible; treat any gap > ~100 ms as quality gap (already planned).

**Still needs local test**: T2 (timestamp advance at rest per OS/browser), T5 matrix.

---

## 4. Web Audio

**Findings**
- Autoplay [DOC, Chrome autoplay blog]: since Chrome 71 an `AudioContext` created before a
  gesture is `suspended`; call `resume()` from a user gesture (or `start()` on a node).
  Check `state` / `statechange`.
- `baseLatency` [DOC, MDN]: processing latency between graph end and OS audio subsystem;
  MDN's illustrative values: ~0.00 (interactive) vs ~0.15 (playback) - "actual values depend
  on device and browser", browser may ignore `latencyHint`. `outputLatency` is
  platform/hardware dependent and "an instantaneous value that fluctuates rapidly";
  Baseline since March 2025. Firefox `baseLatency` returns 0 (no buffering in Gecko).
  A third-party blog found Firefox `outputLatency` implausibly low.
- Measured end-to-end [COMM, Jeff Kaufman 2021-02-02, 2016 MacBook only]: Chrome ~67 ms,
  Firefox ~55 ms default; ~19 / ~14 ms with `latencyHint: 0` (+ mic processing off).
  Bluetooth headsets under-report latency. No public Windows/Linux numbers found.
- `latencyHint`: `"interactive"` (default), `"balanced"`, `"playback"`, or seconds.
- Background tab [COMM]: Safari/iOS use an extra `"interrupted"` state when page leaves
  foreground; `resume()` may throw or never resolve (WebKit bugs 273511, 281955, 276016).
  Chrome hidden-tab behavior: no authoritative source found; Chrome blog says audible pages
  are exempt from intensive timer throttling, implying a playing context keeps its timers.
  The audio thread is separate from main-thread timers, but **our control updates come from
  main-thread polling**, which is throttled when hidden (see section 3).

**Sources**: https://developer.chrome.com/blog/autoplay ;
https://developer.mozilla.org/en-US/docs/Web/API/AudioContext/baseLatency ;
https://www.jefftk.com/p/browser-audio-latency ;
https://bugs.webkit.org/show_bug.cgi?id=273511 ;
https://developer.mozilla.org/en-US/docs/Web/API/BaseAudioContext/state (all 2026-11-14).

**Confidence**: autoplay H; latency numbers L (one 2016 laptop); background M for Safari, L for Chrome.

**Implications**
- Use `latencyHint: "interactive"` and display `baseLatency + outputLatency`; do not claim
  an absolute latency figure. Budget: assume tens of ms; spec target must be measured (T6).
- Handle `suspended` and `interrupted` and surface a "tap to resume audio" state.

**Still needs local test**: T6 (control-update p50/p95, acoustic loopback), T5 audio during hidden/unfocused.

---

## 5. SpeechRecognition

**Findings**
- Support [DOC-ish, MDN + caniuse snapshots; they disagree]: MDN "Limited availability".
  caniuse (as seen in search snippet): Chrome 25+ partial (webkit prefix), Safari 14.1+
  partial (not in SFSafariViewController / Home Screen web apps), Firefox not supported. The
  web-platform-dx feature page marks all three unsupported (Baseline none). Re-check caniuse
  directly before documenting versions.
- Privacy [DOC, MDN]: default is server-based; "audio is sent to a web service ... won't work
  offline" (Chrome uses Google service).
- On-device [DOC, MDN, Edge docs, Chromium source files `on_device_speech_recognition_impl`]:
  `recognition.processLocally = true`; `SpeechRecognition.available({langs, processLocally,
  quality})` -> `available | downloadable | downloading | unavailable`; `SpeechRecognition.install(...)`
  -> Promise<boolean>. `start()` with `processLocally=true` and no pack fails with
  `language-not-supported`. Gated by Permissions-Policy `on-device-speech-recognition`
  (default `self`). `quality` default `command`; `dictation`, `conversation`. Pack shows as
  "SODA en-US Models" in chrome://components [COMM]. Brave bug 55414: `available()` stuck
  at `downloading`, `install()` never resolves [COMM] - behavior differs across Chromium
  derivatives. Spec: https://webaudio.github.io/web-speech-api/ (older drafts used
  `availableOnDevice/installOnDevice`; old examples are outdated).
- Continuous mode [COMM + source]: Chromium `speech_recognizer_impl.cc` has a ~15 s
  no-speech cutoff in continuous mode (as reported via search snippet, not verified in
  file); users report sessions ending after 30-120 s; common fix is restart in `onend`
  with backoff; unguarded restarts can loop. Android Chrome continuous is unreliable.
- Confidence field [no authoritative source]: `confidence` is engine-provided; Chrome
  returns values but they are not calibrated. Safari/others may return 0.

**Sources**: https://developer.mozilla.org/docs/Web/API/SpeechRecognition/available_static ;
.../install_static ; https://developer.mozilla.org/en-US/docs/Web/API/Web_Speech_API/Using_the_Web_Speech_API ;
https://learn.microsoft.com/en-us/microsoft-edge/web-platform/speech-recognition-api ;
https://github.com/brave/brave-browser/issues/55414 ;
https://chromium.googlesource.com/chromium/src/+/lkgr/content/browser/speech/speech_recognizer_impl.cc ;
https://caniuse.com/speech-recognition (2026-11-14).

**Confidence**: API shape H; Chrome version where `processLocally` shipped not found;
continuous timings L.

**Implications**: feature-detect `SpeechRecognition || webkitSpeechRecognition`, then
`available({processLocally:true})`; if not `available`, offer install (user gesture) or
explicitly warn "cloud" before enabling; never default to cloud. Auto-restart with
backoff; treat voice as optional, never required for core flow. Do not threshold on `confidence`.

**Observed locally**: headless Chromium (Playwright 1.65) renderer crash on SpeechRecognition.available({processLocally:true}); real Chrome unverified - call only on user gesture.

**Still needs local test**: T7 on target Chrome/Safari; actual offline behavior; pack install size/time.

---

## 6. Chrome Local Network Access (LNA) and WebSocket

**Findings**
- Timeline [DOC]: LNA prompt launched Chrome 142 (Chrome blog update 2025-09-29) for fetch,
  subresources, subframe navigations. WebSockets were "planned soon"; blink-dev intent to
  experiment lists flag `local-network-access-check-websockets` / Finch
  `LocalNetworkAccessChecksWebSockets`, DevTrial Chrome 142. **Chrome 147 release notes
  (stable 2026-04-07): "LNA restrictions are expanding to include WebSockets. WebSockets
  connections to local addresses now trigger permission prompts."** WebTransport also.
  Enterprise policies (`LocalNetworkAccessAllowedForUrls`, `...BlockedForUrls`,
  `...RestrictionsTemporaryOptOut`) apply.
- Permissions [DOC, Chrome LNA guide]: `local-network` (public -> RFC1918/link-local/ULA/.local)
  and `loopback-network` (public or local -> 127.0.0.0/8, ::1, localhost). Do not query the
  legacy `local-network-access` name (crashed the renderer in older Chrome). Third-party:
  split happened in Chrome 145 [COMM, low].
- Mixed content [DOC, Chrome guide]: `ws://` from `https://` is exempt from mixed-content
  blocking when host is a private/loopback IP literal, `localhost`, or `.local`, and is gated
  by the permission prompt; custom non-.local DNS names need `wss://`. WebSocket constructor
  has no `targetAddressSpace`.
- Insecure contexts [DOC]: LNA permissions are "denied automatically in insecure (http://)
  top-level contexts"; guide makes https mandatory for local/loopback requests. A vendor
  (QZ) says Chrome 147 blocks WebSocket to private addresses from insecure pages [COMM].
  So an `http://` LAN-hosted trainer reaching `ws://<other LAN host>` is likely **blocked**
  in current Chrome; `http://localhost` -> `ws://127.0.0.1` has the same address space (no
  crossing) and should not prompt [INF - the guide says LNA applies when crossing to a more
  private space].
- Permissions-Policy [DOC]: both permissions default allowlist `self`; iframes need
  `allow="local-network; loopback-network"`.
- Firefox [COMM/DOC, Mozilla support page via search snippet]: LNA prompt exists; "gradually
  rolled out to all Firefox users beginning with Firefox 151" per a localized page;
  `network.lna.blocking` pref (true) and `network.lna.skip-domains`; enterprise policy
  `LocalNetworkAccess` with `EnablePrompting`. Bugzilla 2021626: blocked localhost request +
  reload can show state "prompt" with no prompt. WebSocket/mixed-content specifics not found.
  Firefox has historically treated `127.0.0.1`/`localhost` as potentially trustworthy for
  mixed content (Bugzilla 1370861 era) [L, not re-read].
- Safari/WebKit [COMM]: bug 171934 (loopback not treated as trustworthy) and 173161 ->
  `ws://127.0.0.1` from https rejected as mixed content; bug 279249 reports Safari 18
  beta blocking localhost loads again. A 2025-26 blog says Safari blocks `ws://` from HTTPS
  and allows `wss://`. Current status unverified.
- Spec: Mixed Content / "potentially trustworthy" treat 127.0.0.0/8, ::1 and `*.localhost` as
  trustworthy, so https page -> `ws://127.0.0.1` should not be blocked as mixed content in
  engines that implement it [DOC, W3C Secure Contexts - not re-fetched; INF].

**Sources**: https://developer.chrome.com/docs/modern-web-guidance/guides/security/local-network-access ;
https://developer.chrome.com/blog/local-network-access (updated 2025-09-29) ;
https://developer.chrome.com/release-notes/147 ;
https://groups.google.com/a/chromium.org/g/blink-dev/c/4gx2y5jPGbU (2025-09-18) ;
https://support.mozilla.org/en-US/kb/control-personal-device-local-network-permissions-firefox (snippet) ;
https://firefox-admin-docs.mozilla.org/reference/policies/localnetworkaccess/ ;
https://bugzilla.mozilla.org/show_bug.cgi?id=2021626 ;
https://bugs.webkit.org/show_bug.cgi?id=171934 , /173161 , /279249 (all 2026-11-14).

**Confidence**: Chrome behavior H (primary docs); Firefox M-L; Safari L.

**Implications**
- Host the trainer on https (or localhost) for LNA contexts; our doc statement stays valid.
- Implement `navigator.permissions.query({name:'loopback-network'|'local-network'})` in
  try/catch; connect only from a user gesture; do not query legacy name.
- A denied prompt, bad Origin and unreachable collector all look like `1006`; keep the
  three-cause message.
- Document a `wss://` fallback and `http://localhost` dev path; Safari likely needs one.

**Still needs local test**: T8 matrix in Chrome (>= 147), Firefox, Safari; record prompt text and permission name.

---

## 7. GT7 telemetry steering / pedals / rate

**Findings**
- Packet [COMM, MacManley/gt7-udp + Nenkai/PDTools, both community-decoded,
  unofficial]: UDP, Salsa20 encrypted, heartbeat required (send `A`, `B` or `~` to the
  console). Types: A 296 bytes, B 316 bytes (not in Sport Mode), `~` 344 bytes (not in
  replays), C 368 bytes; "Frequency: 60 Hz" for each (MacManley README).
- Throttle/brake [COMM]: `uint8` 0-255 at offsets 0x91 (145) and 0x92 (146) (PDTools
  `Throttle (0-255)`, `Brake Pedal (0-255)`); `~` packet adds filtered throttle/brake.
  Clutch pedal and engagement are floats 0.0-1.0.
- Steering [COMM]: **packet B/`~` has `wheelRotation` (float, radians)** ("Calculates the
  wheel rotation in radians" MacManley; PDTools: `WheelRotation`, "In radians. GT7 and
  Heartbeat 'B' or '~' only", read when length >= 0x13C; a community spreadsheet puts
  `wheelRotationRadians` at 0x128 and labels it steering angle). Packet C adds
  `wheelSteeringAngle[2]` = front wheel steering angles (vehicle output). Nothing in the
  public docs states that `wheelRotation` is the **driver's physical input** versus the
  car model's steering-wheel angle (which is vehicle-side, may be filtered, speed-sensitive
  or capped by the car's lock-to-lock). None document calibration to degrees.
- Offsets disagree between sources (0x124 computed vs 0x128 spreadsheet) - hand-computed
  offsets from PDTools were flagged by the fetcher as 4 bytes uncertain. Do not hard-code
  from these without a real capture.
- License note: the PDTools source file header says "AI usage and consumption is prohibited
  (AGENTS.md)". We only used it for facts; do not copy its code or layouts verbatim.

**Sources**: https://github.com/MacManley/gt7-udp ;
https://github.com/Nenkai/PDTools (SimulatorPacket.cs) ;
https://github.com/SHWotever/SimHub/issues/2254 ;
https://docs.google.com/spreadsheets/d/1Ll9nTdGbhBcseDykq1IUXFBlOsX89L8oPqfhPhSU3BY ;
https://www.gtplanet.net/forum/threads/overview-of-gt7-telemetry-software.418011/ (2026-11-14).

**Confidence**: pedal units/rate M-H; existence of wheelRotation M; whether it is driver
input L.

**Implications**
- Our `steering.available=false` stance remains right. Add a **candidate** field
  `gt7.wheelRotationRad` as diagnostics-only, never mapped to steering until a capture
  correlates it with a known physical input.
- Pedals: 0-255 -> 0..1 divide by 255 (the collector's `rawUnit:"percent"` then needs the
  collector to convert; confirm collector proto fields 25/26 units locally).
- 60 Hz = 16.7 ms period; our staleness timeout must exceed one period plus jitter.

**Still needs local test**: capture a real GT7 session with a wheel; correlate
`wheelRotation` with physical steering; check range at full lock and during understeer.

---

## 8. Sensor noise, resolution, and noise-floor defaults

**Findings**
- Public documented quantization [INF unless stated]:
  - G923 PS pedals appear 8-bit (0..255 per Linux evtest, COMM) -> LSB = 1/255 = 0.39% of travel.
  - Fanatec Hall pedals 12-bit (4096 steps, LSB 0.024%) per Fanatec product page [DOC];
    Fanatec LC brake 12-bit via base, 16-bit via USB [COMM] -> LSB 0.0015%.
  - Steering: CSL DD reports 16-bit [COMM]; G923 wheel unknown (G923 axis range 0..255 on
    all axes in the evtest post suggests possibly 8-bit **or** a normalized view; unverified).
  - Browser normalization divides by logical range, so Chrome values are linear in raw units.
- Jitter: **no public measurements** of resting jitter for G923 or Fanatec pedals through
  HID were found. Load-cell pedals commonly show a few LSB of flicker (community lore, no
  source). Inference: resting jitter is on the order of +-1-3 LSB, so
  +-0.4-1.2% for 8-bit pedals, <0.1% for 12-bit/16-bit.
- Fanatec kernel/driver details do not add deadzone; Linux evtest shows "flat 15" for G923
  axes (a kernel input-subsystem hint, ~6% of 0..255) - this is a hint to applications,
  not applied by the browser.

**Sources**: https://bbs.archlinux.org/viewtopic.php?id=275143 ;
https://forum.fanatec.com/discussion/comment/67243 ; https://fanatec.com/us-en/detail/index/sArticle/1466 ;
https://forum.fanatec.com/discussion/comment/33230/ (2026-11-14).

**Confidence**: quantization M-L; jitter L (no data).

**Implications (defaults)**
- `OverlapConfig.NoiseFloor` default 0 -> **0.005** (0.5%): roughly one 8-bit LSB, safely below
  `ExitThreshold` 0.02. Fluctuation `NoiseFloor` is also 0 now (amplitude 3%); set 0.005 too (effective swing threshold 3.5%). Calibrate by T2 (record 30 s at rest; set floor = max(p99-p1, 1 LSB)).
- Keep Primary enter 8% / exit 3% (>> 1 LSB for 8-bit).
- Expose measured noise per source in the diagnostics report so defaults can become
  per-device.

**Still needs local test**: T2 jitter and step-size capture on every device/path.

---

## Summary of proposed changes (not applied)

See the report message; mirrored here for reviewers.

1. `normalize.ts` / device presets: add optional "suggested preset" table keyed by
   `vid:pid` parsed from `gamepad.id`; seed `046d:c266` (G923 PS PC mode) pedals as axis,
   rest +1 (`invert: true` under current semantics), flagged `source: public-info,
   unverified`. Update the comment above `defaultMapping` (currently asserts rest -1).
2. Generic default stays Detect-first. Do not seed Fanatec polarity.
3. Adapter: stop assuming Chrome `timestamp` changes only on state change; record
   `performance.now()` per poll and compute our own `changed` flag. Never treat equal
   `timestamp` as stale data.
4. Parse `Vendor: xxxx Product: yyyy` (Chrome) and `xxxx-yyyy-name` (Firefox) from `id`;
   Safari may omit - UI must show raw `id`.
5. Overlap `NoiseFloor` default 0 -> 0.005; document as provisional.
6. LNA: add `permissions.query` for `loopback-network`/`local-network` in try/catch; never
   the legacy name; connect only on gesture; surface "needs https/localhost, Chrome >= 147
   prompts for WebSocket".
7. SpeechRecognition: gate on `available({processLocally:true})`; install on gesture; show
   explicit cloud warning otherwise.
8. Audio: handle `interrupted`, show `baseLatency + outputLatency`; require visible tab.
9. GT7: leave steering unavailable; optionally log `wheelRotation` (packet B/`~`) as
   diagnostics.
