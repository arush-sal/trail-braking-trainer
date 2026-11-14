# 0011. Adopt the collector-owned `gt7.inputs.v1` contract

- Status: accepted (supersedes ADR 0005)
- Date: 2026-11-14
- Requirements: R-004, R-037

## Context
ADR 0005 drafted our own collector protocol (`hello` with an in-body token, `welcome`,
batched `frames`, `gap`, `heartbeat`). The collector session then designed and released its
own browser stream in gt7-telemetry-collector **v0.3.0**: `gt7.inputs.v1`, negotiated as a
WebSocket subprotocol, server-to-client only, with a JSON Schema, valid/invalid fixtures and
recorded transcripts (`browserstream/testdata/v1/`). The collector owns that contract.

## Decision
- The trainer consumes `gt7.inputs.v1` as released in v0.3.0 and drops the ADR 0005 draft
  entirely (no compatibility shim). `docs/input-protocol.md` describes how we consume it.
- Fixtures are copied verbatim (tag v0.3.0, commit `378eb89`) into
  `apps/web/src/input/gt7/testdata/v1/`; no code dependency on the collector repo. Updates are
  re-copies of a newer tag.
- Token only via the `gt7.token.<token>` subprotocol entry; the client never sends a message;
  it asserts the negotiated subprotocol.
- Percent 0..100 -> normalized 0..1; `null` -> channel `available:false` with null values (the
  core rejects an available channel without values); steering forced unavailable;
  `sourceGap || droppedSincePrevious > 0` -> `quality.gap`; `source_stale` -> SOURCE_LOST;
  `sessionId` tracked per connection, no stitching across reconnects.
- Parsing: strict per field for known messages, but following collector ADR 0002 rule 6
  (confirmed by the collector owner): unknown `type`, unknown fields and unknown `status.state`
  are ignored; a `hello` claiming `steering.available: true` is accepted with steering forced
  off; `inputs.steering` in a sample is ignored, never rejected. So 3 schema-invalid fixtures
  (`unknown.type`, `hello.steering-available`, `sample.steering-zero`) are tolerated and the
  other 9 in `invalid/` are rejected. `sessionId` is fixed per collector process: a mismatch on
  one connection is fatal.
- 1006 before open: only an LNA state of `denied` is treated as a browser block; anything else
  (including `prompt`) gets the collector-rejection hint with the exact
  `--ws-origin=<location.origin>`. No `/healthz` probe (CSP `connect-src` stays `ws:`/`wss:`).
- Reconnect backoff: 500 ms doubling, capped at 30 s.
- The token never reaches the UI: fixed subprotocol-mismatch text and redaction of every
  server-controlled string the panel renders.
- The MOCK collector is rewritten to speak `gt7.inputs.v1` for integration and e2e tests.

## Consequences
- ADR 0005's heartbeat-based client staleness is gone; staleness comes from the collector's
  `source_stale` (and the session runner's own 250 ms frame-freshness check).
- `InputFrame.sequence` is omitted when the collector sequence exceeds 2^53 (informational).
- Wrong token / Origin / capacity are indistinguishable in the browser (1006) and are retried
  with backoff rather than treated as fatal.

## Evidence / validation
- Automated: every v0.3.0 valid/invalid fixture and all four transcripts (`protocol.test.ts`,
  `gt7Client.test.ts`); client against the MOCK in Node and in Chromium/Firefox/WebKit
  (`gt7Client.integration.test.ts`, `tests/e2e/gt7.spec.ts`). See `docs/validation-log.md`.
- Not verified from this app: live PS5, an HTTPS-origin page, LAN / `wss://`, Safari.
