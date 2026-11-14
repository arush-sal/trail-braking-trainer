# 0005. Collector WebSocket protocol: compact JSON, draft v1

- Status: superseded by 0011 (the collector released its own contract, `gt7.inputs.v1`, in v0.3.0)
- Date: 2026-11-14
- Requirements: R-004

## Context
Spec 4.3 asks for a versioned WebSocket input stream from the separate GT7 collector, with
compact JSON or protobuf chosen by measurement. Phase 1 needs a client prototype against a mock
server; the collector itself is changed only in Phase 5 with owner authorization. Only
brake/throttle (percent, proto fields 25/26) are confirmed; driver steering is not.

## Decision
- Draft wire protocol v1 in `docs/input-protocol.md`: `hello` (token in body) -> `welcome`
  (version, capabilities, heartbeat, limits) -> batched `frames` with `seq` + source `ts`,
  `gap`, `heartbeat`, `error`, defined close codes.
- Compact JSON for v1: B/T at 60 Hz is ~50 bytes/frame, debuggable in browser devtools, no
  protobuf runtime in the bundle. Revisit if Phase 5 measurements show CPU/bandwidth issues.
- Steering is always `available:false` in v1; the client enforces it regardless of server claims.
- Security baseline: loopback default, explicit LAN opt-in requiring a pairing token, Origin
  allowlist at upgrade, connection/size/rate limits, bounded drop-oldest queues with `gap`.

## Consequences
- Trainer client and mock exist now; the real collector must implement the same protocol in
  Phase 5. Protocol stays "proposed" until browser/LAN tests pass, then is frozen as v1.
- JSON parsing cost per frame is accepted for now (unmeasured).

## Evidence / validation
- Automated: `apps/web/src/input/gt7/*.test.ts` against the MOCK collector only.
- Pending (manual, `docs/validation-log.md`): HTTPS page -> `ws://127.0.0.1` and -> LAN IP in
  Chrome/Firefox/Safari, Chrome Local Network Access prompt, `wss://` certificate story.
