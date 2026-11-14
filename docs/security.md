# Security and privacy review (Phase 6)

Date: 2026-11-14. Scope: spec sections 1.1, 4.3, 4.4, 6.2, 8, 10 and 11.1; requirements
R-001, R-005, R-027, R-029, R-031. Reporting process: `SECURITY.md`. Release chain:
`docs/release-process.md`.

The trainer is a static bundle (HTML, JS, CSS, Go `core.wasm` + `wasm_exec.js`). It has no
backend, accounts, cookies, analytics, or storage. Everything below is checked against this
repository at the date above. Hardware and real-browser behavior is still unverified
(`docs/validation-log.md`).

## Assets

| Asset | Where it lives | Why it matters |
|---|---|---|
| Session input traces and results | JS + Go memory in one tab. Gone on reload or reset | Personal training data. Spec 1.1 and R-027 forbid keeping or uploading it |
| Microphone audio (voice commands, opt-in) | The browser's SpeechRecognition engine (may be a remote service) | Privacy. Spec 6.2 |
| Collector pairing token (GT7, opt-in) | A React state variable. Sent only inside the WebSocket hello message | Gives access to the user's collector on the LAN |
| Bundle integrity | GitHub Release, then Cloudflare | Users run whatever code is served |
| Release signing identity | GitHub OIDC -> Sigstore, plus the Cloudflare API token in the `production` environment | Supply chain |

## Trust boundaries

1. **Page <-> browser.** The page runs with the Gamepad, Web Audio, SpeechSynthesis and
   (opt-in) SpeechRecognition APIs. The CSP and Permissions-Policy below limit what injected
   code could reach.
2. **Browser <-> GT7 collector (LAN).** The connection is user-initiated `ws://`/`wss://` to a
   URL the user types in. The collector is a separate repository. Its required controls are
   in spec 4.3: loopback by default, Origin allowlist, pairing, frame and connection caps.
   The trainer treats everything the collector sends as untrusted. It enforces a message
   size cap, validates the schema and sequence numbers, and always reports steering as
   unavailable.
3. **Browser <-> CDN (Cloudflare Workers Static Assets, ADR 0008).** The CDN serves
   same-origin static files and the `_headers` response headers. The app never sends
   telemetry to it.
4. **CI/release (GitHub Actions).** A tag runs the gates, the bundle is built once, then
   signed and attested, and those same bytes are deployed. See `docs/release-process.md`.
5. **Browser speech service.** SpeechRecognition may send microphone audio to the browser
   vendor. That is outside our control, so we disclose it in the UI.

## Threat model (STRIDE-lite)

| Threat | Boundary | Mitigation in this repo | Residual / owner |
|---|---|---|---|
| **S**poofed collector, or another site's page driving the user's collector (CSWSH) | 2 | The token goes only in the hello message, never in the URL. The URL is rejected if it contains credentials. Mixed content is refused for public hosts. Protocol version check | The collector's Origin allowlist and pairing check are in the collector repo (Phase 5, not done) |
| **S**poofed release or CDN content | 3, 4 | Cosign bundles, GitHub attestations, `checksums.txt`, and deploy of the verified Release assets (`docs/release-process.md`) | Users have to verify. See README "Verifying a release" |
| **T**ampered or hostile collector frames | 2 | `CLIENT_MAX_MESSAGE_BYTES` cap. Strict parser (`protocol.ts`). Duplicate and out-of-order frames are dropped. Gaps are counted. Go `Decode` rejects malformed frames. Steering is forced unavailable | - |
| **T**ampered bundle in transit | 3 | HTTPS (`workers.dev` sits under the HSTS-preloaded `.dev` TLD; HSTS for the custom domain is a Cloudflare zone setting). `nosniff`. CSP `script-src 'self'` | No SRI. All scripts are same-origin, so it would add nothing |
| **R**epudiation | - | Not applicable: no accounts and no server-side actions | - |
| **I**nformation disclosure: telemetry or session data leaves the device | 1, 3 | No storage APIs, no network calls from app code except same-origin assets and the user-initiated WS. Production only: Cloudflare Web Analytics beacon, injected at the edge, page-load metrics only (ADR 0009). CSP `connect-src 'self' ws: wss: https://cloudflareinsights.com` blocks all other third-party HTTP. `Referrer-Policy: no-referrer` | `ws:`/`wss:` lets injected code open a WebSocket to any host (trade-off below) |
| **I**nformation disclosure: microphone | 5 | Voice is off by default. A privacy notice must be acknowledged before enabling. On-device recognition is used only when the browser reports it. Status shows whether processing may be remote. `Permissions-Policy: microphone=(self)` | Browser vendor processing (disclosed) |
| **I**nformation disclosure: secrets in the bundle | 3, 4 | No secrets exist client-side. The Cloudflare token lives only in the `production` environment. Bundle scan below | - |
| **D**oS: collector flood, huge frames | 2 | Message size cap. Bounded reconnect backoff. UI refreshes at 4-10 Hz, not per sample. Session memory is capped in the core (`maxSamplesPerRound`) | - |
| **E**levation: XSS leading to script execution | 1 | React escaping. No `dangerouslySetInnerHTML`, `eval` or `new Function`. CSP without `'unsafe-inline'` or `'unsafe-eval'`. `object-src`/`base-uri` `'none'` | Trusted Types not enforced (see gaps) |
| **E**levation: clickjacking | 1 | `frame-ancestors 'none'` | - |
| **E**levation: CI/release compromise | 4 | Actions pinned by SHA, per-job least-privilege tokens, zizmor, protected tag + environment (`docs/release-process.md`) | Branch and tag protection settings live in GitHub and are owner-managed |

## Privacy review findings

Checked on 2026-11-14 against `apps/web/src` and a production `make build`:

| Check | Result |
|---|---|
| `localStorage`, `sessionStorage`, `indexedDB`, `serviceWorker`, `caches`, `document.cookie`, `sendBeacon` in `apps/web/src` and `apps/web/dist` | None found |
| Network calls in source | Only `fetch` of the same-origin, content-hashed `assets/core-<hash>.wasm`, a `<script>` for same-origin `assets/wasm_exec-<hash>.js`, and `new WebSocket(url)` after the user clicks Connect (`gt7Client.ts`). No other `fetch`, `XMLHttpRequest` or `EventSource` |
| Third-party requests at runtime | From app code: none. On the production host Cloudflare injects its Web Analytics beacon (`static.cloudflareinsights.com` script, reports to `cloudflareinsights.com`; cookieless, page views and load timing, no session data; ADR 0009). The e2e specs assert that no third-party origins are requested, and the CSP blocks them (verified below) |
| Secrets in the bundle | None. The only `https://` strings in `dist/assets/*.js` are React error-docs and namespace URLs, plus two public research links rendered as `<a>`. `core.wasm` contains only `https://go.dev/doc/godebug` and no local paths |
| Tokens in URLs | None. The pairing token is sent only in the hello message. `checkUrl` rejects URLs that carry credentials (`protocol.test.ts`) |
| Test hooks in production | `make test-e2e` fails if `__tbtTest` appears in `apps/web/dist`. Re-checked: 0 matches |
| Network TTS voices | Automatic voice choice uses only `localService` voices. Network voices are listed but disabled until the user ticks "Allow network voices" (in memory only, resets on reload) because spoken summaries contain results. With no local voice, summaries stay silent and a notice is shown; countdown/alerts use the browser default (`announcer.test.ts`, `ControlsPanel.test.tsx`) |
| Voice privacy notice | `ControlsPanel`: notice and acknowledgement before enabling. Remote vs on-device status shown. Keys and buttons always work (`ControlsPanel.test.tsx`) |
| Clipboard | "Copy diagnostics report" writes device ids, mappings and the user agent to the clipboard, and only when the user clicks it. Nothing is sent anywhere |

## Response headers (`apps/web/public/_headers`)

Vite copies the file to the bundle root. Cloudflare Pages and Workers Static Assets read the
same format. Cloudflare applies every matching rule: `/x/*` is a prefix match, and a header
set by two rules is comma-joined, so `Cache-Control` is never set on `/*`.

| Header | Value / reason |
|---|---|
| CSP `script-src 'self' 'wasm-unsafe-eval' https://static.cloudflareinsights.com` | Go WASM needs `'wasm-unsafe-eval'` to compile. The Cloudflare origin is the Web Analytics beacon only (ADR 0009). `'unsafe-eval'` is **not** needed (verified). There are no inline scripts |
| CSP `style-src 'self'` | React's `style={}` goes through CSSOM, which CSP allows. Verified: 0 violations through the results graphs |
| CSP `img-src`/`font-src` `'self'`, `default-src 'none'`, `object-src 'none'`, `base-uri 'none'`, `form-action 'none'`, `frame-ancestors 'none'`, `manifest-src 'self'` | Lock-down |
| CSP `connect-src 'self' ws: wss:` | Trade-off: the collector URL is user-supplied and may be any LAN IP. CSP cannot express "private addresses only", so `ws://127.0.0.1:* ws://localhost:*` alone would break LAN use. HTTP(S) to third parties stays blocked. If LAN use is dropped, narrow this to `ws://127.0.0.1:* ws://localhost:*` |
| No `upgrade-insecure-requests` | It would rewrite `ws://127.0.0.1` to `wss://` and break the local collector |
| `X-Content-Type-Options: nosniff` | `core.wasm` must be served as `application/wasm`. Cloudflare does this by extension. `coreBridge` also falls back to buffered instantiate if a host sends the wrong type |
| `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy: same-origin` | No referrer leak to linked research pages. Isolates the browsing context |
| `Permissions-Policy` | `gamepad=(self)` and `microphone=(self)`. Camera, geolocation, USB, HID, serial, Bluetooth, MIDI, payment, display-capture, wake-lock and XR are off |
| Caching | `/assets/*` is `public, max-age=31536000, immutable`; it holds every content-hashed file, including `wasm_exec-<hash>.js` and `core-<hash>.wasm` (`apps/web/vite/wasmAssets.ts`). `/`, `/index.html` and `/version.json` are `no-cache`. Each `index.html` names, through its hashed app JS, exactly the runtime and core it was built with, so caching cannot mix versions. Revalidation alone would not guarantee that: a `no-cache` runtime and core could still update between page load and core fetch. A tab opened before a deploy keeps its own set; if a deploy removed those files, the core-load alert or boot message asks for a reload (`docs/architecture.md`) |

### CSP verification evidence

`tests/e2e/csp.spec.ts` serves the **production** `apps/web/dist` through a Playwright route.
It applies `_headers` the way Cloudflare does, with per-path rules and correct MIME types.
Run on 2026-11-14 (Linux, Playwright 1.65, headless):

| Test | Chromium | Firefox |
|---|---|---|
| App loads, Go core reports its version, session audio reaches `running`, 0 CSP violations, no console errors | pass | pass |
| `new WebSocket('ws://127.0.0.1:9/...')` is allowed by CSP. `fetch('https://example.com/')` is blocked, with exactly one `connect-src` violation | pass | pass |
| Control: the same CSP without `'wasm-unsafe-eval'` blocks the core, and the app shows the core-load alert | pass | pass |
| MOCK session to results graphs under CSP, 0 violations | pass | skipped (see below) |

WebKit could not launch on this host (missing system libraries). It runs in the CI matrix.
The unit test `apps/web/src/app/headers.test.ts` checks the directives statically.

## Error recovery paths (spec 8)

| Failure | What the user gets | Audible | Recovery | Tests |
|---|---|---|---|---|
| No Gamepad API | Alert in Input devices: use a current browser over HTTPS/localhost, or MOCK/GT7 | Start is refused aloud ("Cannot start. Brake not available from this source.") | Change browser or source | `DevicesPanel.test.tsx` |
| No device connected | "No gamepads detected" with steps: press a pedal (gesture gating), reconnect, check the OS | Same spoken refusal | Connect, then Detect/map | `DevicesPanel.test.tsx`, e2e `recovery.spec.ts` |
| Microphone denied | Mic status: allow in site settings or use keys/buttons | "Microphone denied. Use buttons." | Site settings. Keys/buttons always work | `ControlsPanel.test.tsx`, `services.test.ts` |
| Voice API unsupported | "Not supported in this browser. Use keys and buttons." | - (never enabled) | Keys/buttons | `ControlsPanel.test.tsx` |
| Speech service unreachable / mic error | Mic status text | "Voice service unreachable. Use buttons." / "Microphone error..." | Keys/buttons. Re-enable | `services.test.ts` (denied case; same transition code) |
| Audio suspended / interrupted / closed | Alert under "Enable session audio" saying which one | "Audio paused. Press enable audio." (speech does not use the AudioContext) | Enable session audio, or reload if closed | `recovery.test.ts`, `services.test.ts` |
| Collector unreachable / refused / version mismatch | GT7 panel alert listing the likely causes | During a session: source-lost alert + speech | Auto-reconnect with backoff (non-fatal). Fix token/allowlist (fatal) | `protocol.test.ts`, `gt7Client*.test.ts` |
| Local-network permission denied | GT7 panel alert: site settings -> allow local network, reload | - (before session) | Site settings | `Gt7Panel.test.tsx` |
| Missing steering (GT7) | Capability table shows steering "no" with a reason. Starting a steering drill shows "Steering is not available... (the GT7 collector never provides steering). Pick a selection or drill without steering" | "Cannot start. Steering not available from this source." | Choose B, T, or a B/T drill | `recovery.test.ts`, `sessionRunner.test.ts` |
| WebAssembly unsupported, blocked or failed to fetch | Core status alert with cause and fix. The session section points to it. Diagnostics and audio check keep working | - (no session possible) | Retry (no reload), or reload / change browser | `WasmStatus.test.tsx`, e2e `recovery.spec.ts`, `csp.spec.ts` |
| Slow input (< 20 Hz, PROPOSED, matches the core's 50 ms smoothness limit) | Alert under the readout: keep the tab visible, close heavy apps, check the connection | - (not a loss. A real loss is audible via source-lost) | As stated | `recovery.test.ts`, `App.unavailable.test.tsx` |
| Offline / static file failed | JS failed: the static boot message in `index.html` stays ("check your connection and reload"). WASM failed: Retry as above | - | Reconnect and reload. No offline mode by design (no service worker) | e2e `recovery.spec.ts` |

## Known gaps

- **Trusted Types are not enforced.** `coreBridge` assigns `script.src` for `wasm_exec.js`.
  `require-trusted-types-for 'script'` would need a policy or a module import of the runtime.
  Low value while `script-src 'self'` is in place.
- **`connect-src ws: wss:` is broad** (trade-off above).
- **The collector security controls** (Origin allowlist, pairing, caps) are not built yet.
  They belong to the collector repository (Phase 5). The trainer client only covers its own side.
- **Headless Firefox on the agent host** delivered MOCK input at about 18 Hz idle and about
  1 Hz during a session. That is main-thread load, not the CSP. The new slow-input warning
  shows it, and the session-to-results CSP test is skipped on Firefox. Logged in
  `docs/validation-log.md`. Real-browser Firefox performance is unmeasured.
- HSTS and TLS settings are Cloudflare zone settings, not repository settings.
