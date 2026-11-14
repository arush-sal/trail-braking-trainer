# GT7 collector input stream: consuming `gt7.inputs.v1`

- Status: **adopted** (ADR 0011, supersedes the draft protocol of ADR 0005).
- Requirements: R-004; spec sections 1 (S5), 4.1, 4.3, 4.4, 8, 11.1.
- Contract owner: **gt7-telemetry-collector**. The authoritative reference is its
  [browser streaming doc](https://github.com/arush-sal/gt7-telemetry-collector/blob/v0.3.0/docs/content/docs/browser-streaming.md)
  and ADRs
  [0001](https://github.com/arush-sal/gt7-telemetry-collector/blob/v0.3.0/docs/adr/0001-optional-websocket-browser-sink.md),
  [0002](https://github.com/arush-sal/gt7-telemetry-collector/blob/v0.3.0/docs/adr/0002-browser-input-contract-v1.md),
  [0003](https://github.com/arush-sal/gt7-telemetry-collector/blob/v0.3.0/docs/adr/0003-websocket-threat-model.md)
  at tag **v0.3.0**. If this page and those disagree, the collector docs win. The trainer
  consumes the contract and does not change it.
- Fixtures: verbatim snapshot in `apps/web/src/input/gt7/testdata/v1/` (v0.3.0, commit
  `378eb89`; do not edit, re-copy to update).
- Code: `apps/web/src/input/gt7/{protocol.ts,gt7Client.ts,Gt7Panel.tsx}`.

## Running the collector for the trainer

```sh
gt7-collector --ps5=<ps5-ip> --rtps=none --ws-listen=127.0.0.1:8765 --ws-origin=<page origin>
```

- `<page origin>` is the trainer page's `location.origin`, exact match, no trailing slash or
  path: `http://localhost:5173` for `make dev`, `https://trail-braking-trainer.aru.sh` for
  production. The GT7 panel prints the exact command for the page you are on.
- Optional: `--ws-max-clients` (default 4), `--ws-client-buffer` (64), `--ws-write-timeout`
  (2s), `--ws-source-timeout` (2s). Token: `GT7_WS_TOKEN` environment variable (32-256 of
  `[A-Za-z0-9._~-]`, e.g. `openssl rand -hex 32`), optional on loopback, required for LAN binds.
- Trainer default URL: `ws://127.0.0.1:8765/v1/stream`. `GET /healthz` returns
  `{"status":"ok"}` (the trainer does not use it).
- Replay without a PS5: the collector CLI has **no** replay flag. Replay is only available
  through the collector's Go library (`replay.Open` + `Source.Play` into `ingest.NewPipeline`).
  That is collector-side work; the trainer does not build it.

## Handshake and authentication

- `new WebSocket(url, ["gt7.inputs.v1"])`, or with a token
  `new WebSocket(url, ["gt7.inputs.v1", "gt7.token." + token])`.
- The token travels **only** in that subprotocol entry: never in the URL (the client rejects
  URLs carrying credentials or `?token=`), never in a message, never persisted (password field,
  React state only). The collector negotiates only `gt7.inputs.v1` and never echoes the token.
- After open the client asserts `ws.protocol === "gt7.inputs.v1"`; anything else is a fatal
  error (not a v0.3.0+ collector).
- **Read-only.** The client never sends a message. The collector closes `1008 read_only_stream`
  if one arrives.

## Messages (server to client)

JSON text frames. Every message has `type`, `protocol: "gt7.inputs.v1"` and `sessionId`
(32 lowercase hex, per collector process).

| Type | Fields the trainer uses | Trainer handling |
|---|---|---|
| `hello` (first, once per connection) | `collectorVersion`, `canonicalSchemaVersion`, `capabilities`, `status` | Shown in the panel. `status` maps to `waiting` / `live` / `stale`. Brake/throttle capability must be `{available:true, unit:"percent", min:0, max:100}`. |
| `sample` | `sequence` (decimal string, parsed with `BigInt`), `packageId`, `source`, `recvTimestamp`, `sourceGap`, `droppedSincePrevious`, `inputs` | Mapped to an `InputFrame` (below). |
| `status` | `state`, `reason` | `source_stale` -> panel `stale` + `source-lost` (session SOURCE_LOST path); `source_live` -> `live`. Unknown states ignored. |

Parsing rules (`parseServerMessage`, tested over every v0.3.0 fixture and transcript):

- Any `protocol` other than `gt7.inputs.v1` is rejected. Unknown `type` is ignored. Unknown
  fields are ignored.
- Known messages are checked field by field against the schema (session id pattern, sequence
  `^(0|[1-9][0-9]{0,19})$` and <= 2^64-1, `packageId` uint32, `source` enum, RFC 3339 UTC
  `recvTimestamp`, percent 0..100 or `null`, `droppedSincePrevious >= 0`). A violation is a
  fatal protocol error for that connection.
- Schema-invalid but consumer-tolerated (collector ADR 0002 rule 6: apply the rules, do not
  hard-fail on full schema validation; confirmed by the collector owner 2026-11-14). Three of the
  12 `invalid/` fixtures are therefore accepted or ignored; the other 9 are rejected:
  - `unknown.type.json`: unknown `type` is ignored.
  - `hello.steering-available.json`: accepted, steering forced unavailable (spec 4.3).
  - `sample.steering-zero.json`: `inputs.steering` is ignored (never mapped); the sample is
    accepted. It would only matter if a hello advertised steering, which v0.3.0 never does and
    which the trainer's steering gate overrides anyway.
- Per connection: `hello` must come first and only once; every later message must carry the
  hello's `sessionId` (mismatch = fatal). Duplicate or decreasing `sequence` values are
  dropped and counted.

## Mapping to `InputFrame`

| `InputFrame` | From |
|---|---|
| `source`, `sourceId` | `"gt7"`, `"gt7:" + sessionId` |
| `brake`, `throttle` | `rawValue` = percent, `rawUnit: "percent"`, `normalized` = percent / 100. `null` (no reading) -> `available:false` with `rawValue`/`normalized` `null` (never 0): the core requires values when available, so a required channel going null invalidates the attempt |
| `steering` | Always `{available:false, rawValue:null, normalized:null}`, regardless of server claims |
| `sequence` | `Number(sequence)` when <= 2^53-1, otherwise omitted (informational only) |
| `sourceTimestampMs` | `Date.parse(recvTimestamp)` (collector wall clock, diagnostics only) |
| `receivedMonoMs` | `performance.now()` on arrival (control timing) |
| `quality.gap` | `sourceGap` (loss upstream of the collector) **or** `droppedSincePrevious > 0` (loss inside the collector). The core invalidates the attempt on a gap frame. |

Counters in the panel: frames, gaps / missing (from `droppedSincePrevious`), source gaps,
duplicates, out-of-order, reconnects.

When the panel leaves `live` (stale, reconnecting, error, closed) it emits one frame with all
channels unavailable and `quality.stale=true`, so consumers stop treating the last sample as
live. A reconnect is a new epoch with a fresh `hello` (the `sessionId` may change); sequence
state is never carried across connections (spec 4.4, contract "no stitching").

## Close codes and failures

| Code / case | Meaning | Client action |
|---|---|---|
| 1001 `collector_shutdown` | Collector stopping or restarting (also token rotation) | Reconnect with backoff (500 ms doubling, capped at 30 s) |
| 1008 `read_only_stream` | Client sent data (trainer bug) | Fatal |
| 1009 | Client frame over the 1 KiB read limit | Fatal |
| 4000 `slow_consumer` | Tab missed `--ws-write-timeout` | Reconnect |
| Negotiated protocol != `gt7.inputs.v1` | Not a v0.3.0+ collector | Fatal |
| No `hello` within 5 s | Hung server | Reconnect |
| 1006 before open | See below | Retry with backoff, show hint |
| Any other close after open | Connection lost | Reconnect |

A browser sees only `1006` for every pre-upgrade HTTP rejection (403 Origin, 401 token,
400 subprotocol, 421 Host, 503 too many clients), for a collector that is not running, and for
a Local Network Access block. The panel picks the hint from the LNA permission state it queried
at Connect (`rejectionHint`, unit tested):

- `denied`: the panel does not connect; it says how to re-allow local network access in the
  site settings.
- anything else, including `prompt`: collector rejection. Only `denied` is treated as blocked;
  Chrome also reports `prompt` where no prompt applies (`http://localhost` -> `127.0.0.1` is one
  address space). Collector rejection - not running, Origin not allowed (with the exact
  `--ws-origin=<location.origin>`), token missing/wrong, too many clients; check the collector
  DEBUG log or devtools Network.

Known limitation: the page cannot tell "collector down" from "collector rejected this page"
(both are 1006). A `/healthz` probe could separate them, but CSP `connect-src` allows only
`ws:`/`wss:` (no `http://127.0.0.1`) and is deliberately not widened, so the trainer does not
probe. The hint lists both.

Token hygiene: the client redacts the token from every string it hands the UI (error
messages, close reasons, hello `collectorVersion` / steering reason, status reason), and the
subprotocol-mismatch error uses fixed text, so a server that selects the offered
`gt7.token.<token>` entry cannot surface it.

## Browsers, HTTPS and local network access - ALL UNVERIFIED

Everything in this section is **UNVERIFIED** for this app (public information only; see
`docs/research/public-evidence.md` section 6 and the collector's validation log). Only the
`http://localhost` page -> `ws://127.0.0.1` path has automated evidence, against the MOCK.

- Chrome / Edge (147+): a WebSocket from an `https://` public site to `127.0.0.1` or a LAN IP
  shows a Local Network Access permission prompt (`loopback-network` / `local-network`); it is
  not blocked as mixed content for loopback/private IP literals, `localhost` and `.local`.
  Other hostnames need `wss://`. `http://` LAN-hosted pages are auto-denied LNA.
- Firefox: normally allows loopback `ws://` from an HTTPS page; LNA prompting is rolling out
  (151+, `network.lna.blocking`).
- Safari: likely blocks `ws://` from an HTTPS page even to `127.0.0.1` (WebKit bugs 171934,
  173161, 279249). Use `wss://` via collector `--ws-tls-cert` / `--ws-tls-key` with a
  certificate trusted for `127.0.0.1`, or open the trainer from `http://localhost`. The panel
  shows this warning for Safari on HTTPS.
- The client refuses `https://` page -> `ws://` to a public hostname up front (mixed content).
- On Connect (a user gesture) the panel queries
  `navigator.permissions.query({name: 'loopback-network' | 'local-network'})` best-effort and
  shows the state; it never queries the legacy `local-network-access` name.

## MOCK collector (tests only)

`tests/mock-collector/server.mjs` is a **MOCK** speaking `gt7.inputs.v1` closely enough to
exercise the client (subprotocol + optional token checks, Origin allowlist, hello / sample /
status, stale and resume, `droppedSincePrevious` from a bounded drop-oldest queue, 1008 on any
client message, 1009 over 1 KiB, 503 at capacity, 1001 on close, `/healthz`). It is not the
collector and not evidence of collector or GT7 behavior.

```bash
node tests/mock-collector/server.mjs   # 127.0.0.1:8765/v1/stream, origins http://localhost:5173 + http://127.0.0.1:5173
node tests/mock-collector/server.mjs --origin https://<trainer-origin> --source-timeout-ms 2000
GT7_WS_TOKEN=$(openssl rand -hex 32) node tests/mock-collector/server.mjs --host 192.168.1.20  # LAN: token required
```

Tests: `protocol.test.ts` (every fixture), `gt7Client.test.ts` (all four transcripts, close
codes, session tracking), `gt7Client.integration.test.ts` (client against the MOCK in Node),
`tests/e2e/gt7.spec.ts` (real browser WebSocket against the MOCK).
