# GT7 collector input protocol (WebSocket) - DRAFT v1

- Status: **proposed**. To be frozen in Phase 5 after browser/LAN validation (see ADR 0005).
- Requirements: R-004; spec sections 1 (S5), 4.1, 4.3, 4.4, 8, 11.1.
- Implemented so far only by the **MOCK** collector (`tests/mock-collector/server.mjs`) and the
  trainer client (`apps/web/src/input/gt7/`). The real `gt7-telemetry-collector` does **not**
  implement this yet (Phase 5, separate repo, needs owner authorization).

## Transport

- Browser opens `ws://<host>:<port>/v1/inputs` (or `wss://`). Read-only stream: after `hello`
  the client sends nothing (extra messages are ignored and rate limited).
- Compact JSON, one UTF-8 text message per WebSocket message. Every message has a `type`.
- Unknown fields must be ignored by receivers; unknown `type` is a protocol error.

## Messages

### client -> server: `hello` (first and only message)

```json
{"type":"hello","protocol":"tbt-inputs","versions":[1],"pairingToken":"..."}
```

- `versions`: protocol versions the client supports. Server picks one or closes `4000`.
- `pairingToken`: optional; required when the server is configured with one. Sent **only** here,
  never in the URL or query string (URLs leak into logs, history, Referer).
- Server closes `1002` if no valid hello arrives within 5 s.

### server -> client: `welcome`

```json
{"type":"welcome","version":1,"collectorVersion":"0.3.0","sourceId":"gt7-<id>",
 "capabilities":{
   "brake":{"available":true,"rawUnit":"percent"},
   "throttle":{"available":true,"rawUnit":"percent"},
   "steering":{"available":false,"reason":"GT7 driver steering input not verified"}},
 "heartbeatMs":1000,"maxFrameBytes":4096}
```

- `rawUnit: "percent"` = 0-100, matching collector proto `brake`/`throttle` (fields 26/25).
- `steering.available` is **false** in v1. `wheel_rotation` is unconfirmed and front wheel
  steering angles are vehicle output, not driver input; neither may be mapped to steering.
  The trainer client forces steering unavailable regardless of what the server claims until a
  genuine steering-input signal is validated (spec 4.3, 14).
- `maxFrameBytes`: largest message the **server will send**. The client rejects any message
  larger than `min(64 KiB, maxFrameBytes)` before parsing (64 KiB before `welcome`) as a fatal
  protocol error. The server's own inbound limit (`hello`) is separate and not advertised.
- No frames are sent before `welcome`; a client receiving one treats it as a protocol error.

### server -> client: `frames`

```json
{"type":"frames","frames":[{"seq":1042,"ts":51234,"brake":38.5,"throttle":0}]}
```

- Batched, at most **128 frames** per message (larger batch = fatal protocol error); the server
  splits backlogs into several messages within `maxFrameBytes`.
- `seq` is a strictly increasing integer per server process (starts anywhere).
- `ts`: collector monotonic milliseconds (source timestamp, diagnostics/jitter only; the
  trainer times control on its own `performance.now()` arrival time).
- `brake`/`throttle`: number or `null` (unavailable/invalid sample). Never `0` for "missing".
- No steering field in v1.

### server -> client: `gap`

```json
{"type":"gap","fromSeq":1043,"toSeq":1101,"reason":"slow-consumer"}
```

Sent before the next `frames` when frames were dropped for this client. Inclusive range.
The client marks the next emitted frame `quality.gap=true` and counts the range as missing; if
the sequence jump describes the same hole it is counted once (max of the two), not twice.

### server -> client: `heartbeat`

```json
{"type":"heartbeat","seq":1101}
```

Every `heartbeatMs` while the client is keeping up. `seq` = last produced sequence.
Heartbeats are liveness only and never count as fresh samples.
Client marks the source **stale** after `3 x heartbeatMs` without any message, emits
`source-lost`, discards the connection and reconnects (new epoch).

### server -> client: `error`

```json
{"type":"error","code":"unauthorized","message":"pairing token missing or wrong"}
```

Sent immediately before a policy/protocol close. Codes: `bad-hello`, `hello-timeout`,
`unsupported-version`, `unauthorized`, `rate-limit`. Never echoes secrets.

## Close codes

| Code | Meaning | Client action |
|---|---|---|
| 1000 | normal | reconnect only if user still wants it |
| 1002 | protocol error (bad/missing hello) | fatal, show error |
| 1008 | policy: `unauthorized`, `rate-limit` | fatal, check token / allowlist |
| 1009 | inbound message too big | fatal |
| 1013 | server full (max connections) | retry with backoff |
| 4000 | unsupported protocol version | fatal, show versions |
| 1006 (browser) | upgrade rejected (403 bad Origin, 404) or unreachable | retry; message explains the browser cannot distinguish these |

Origin rejection happens at the HTTP upgrade (`403`), so the browser only sees `1006`.

## Flow control

- Per-client **bounded** queue (mock: 256 frames). When the client is not keeping up
  (`bufferedAmount` over a high-water mark) frames accumulate; on overflow the **oldest** is
  dropped and the dropped range is reported with one `gap` message before the next batch.
  Never unbounded buffering.
- Client side: sequence tracking per connection epoch. Gap -> `quality.gap=true` on the next
  emitted frame + counters; duplicate and out-of-order frames are dropped and counted.
- When the connection leaves `live` (stale, reconnecting, error, closed) the trainer panel
  emits one frame with all channels `available:false`/`null` and `quality.stale=true`, so
  consumers stop presenting the last sample as live.
- Reconnect: exponential backoff (mock defaults 500 ms -> 10 s). Each connection is a new
  **epoch**; sequence state and attempt state are never merged across epochs (spec 4.4).

## Security

- **Loopback by default** (`127.0.0.1`). LAN binding is an explicit opt-in (`--host`) and the
  mock refuses a non-loopback bind without a pairing token.
- **Origin allowlist** checked first at upgrade, before parsing anything else (malformed request
  targets get `400`, malformed HTTP is dropped; the server must survive untrusted input); missing or unlisted Origin -> `403`. This is the
  CSWSH defence: any web page can open a WebSocket to `127.0.0.1`, and CORS does **not** apply
  to WebSockets, so CORS headers protect nothing here.
- **Pairing token** for LAN use, compared in constant time, sent only in `hello`, never in URLs,
  never logged, never persisted by the trainer (`type=password`, in-memory only).
- **Limits**: max connections (`1013`), max inbound message size (`1009`), inbound rate limit
  (`1008 rate-limit`), hello timeout, bounded outbound queues.
- Read-only: no commands accepted. No telemetry leaves the LAN (no Cloudflare/remote relay).
- Plain `ws://` on a LAN is unencrypted; the token can be sniffed on the local network. `wss://`
  needs a certificate trusted by the browser - open question for Phase 5.
- Production collector must additionally avoid accidental internet exposure (no `0.0.0.0`
  default, warn on public interfaces) - Phase 5.

### Mixed content and Chrome Local Network Access - ALL UNVERIFIED

Reference: <https://developer.chrome.com/docs/modern-web-guidance/guides/security/local-network-access>.
Every browser behavior below is **UNVERIFIED** pending manual tests recorded in
`docs/validation-log.md`.

- UNVERIFIED: an `https://` page (deployed trainer) opening `ws://` to a **public** hostname is
  blocked as mixed content. The client refuses this up front with an explanation.
- UNVERIFIED: per the Chrome LNA guide, `ws://` from an `https://` page is exempt from mixed
  content blocking when the host is a private/loopback IP literal, `*.localhost` or `.local`
  name, and is gated by a `local-network` / `loopback-network` permission prompt. Custom
  non-`.local` DNS names need `wss://`. The WebSocket constructor takes no `targetAddressSpace`.
- UNVERIFIED: LNA applies when crossing to a more private address space
  (public -> local -> loopback). `http://localhost` dev pages calling `127.0.0.1` do not cross.
- UNVERIFIED: the guide says LNA permissions are denied automatically in insecure (`http://`)
  top-level contexts - i.e. an `http://` LAN-hosted trainer may be unable to reach another LAN
  host in Chrome.
- UNVERIFIED: guide recommends querying `navigator.permissions.query({name:'local-network'})`
  and only connecting from a user gesture when the state is `prompt`. The prototype connects
  only from the Connect button; permission querying is not implemented yet.
- UNVERIFIED: Firefox and Safari behavior for https -> `ws://127.0.0.1` and -> LAN IP
  (Safari historically blocks mixed content even to loopback).
- A denied permission, rejected Origin and unreachable collector all look like `1006` to the
  page; the UI message lists all three causes.

## Running the MOCK collector

```bash
source ~/.nvm/nvm.sh && nvm use 26.13.1
node tests/mock-collector/server.mjs                       # 127.0.0.1:8787, origins http://localhost:5173 + http://127.0.0.1:5173
node tests/mock-collector/server.mjs --origin https://<trainer-origin> --origin http://localhost:5173
TBT_MOCK_TOKEN=... node tests/mock-collector/server.mjs --host 192.168.1.20  # LAN: token required
```

Flags: `--host`, `--port`, `--origin` (repeatable), `--token` (or `TBT_MOCK_TOKEN`, prefer the
env var to keep it out of shell history/`ps`), `--hz` (default 60), `--max-clients` (default 4).
The mock emits synthetic brake/throttle in percent (never overlapping), steering unavailable.
It is labelled MOCK everywhere and is **not** evidence of GT7 or collector behavior.

Tests: `apps/web/src/input/gt7/*.test.ts` (unit) and `gt7Client.integration.test.ts` (node
environment, starts the mock in-process on an ephemeral port; uses the `ws` client to set
`Origin`, since Node's global `WebSocket` sends none).
