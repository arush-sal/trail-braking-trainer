# Performance measurements (Phase 6)

Spec 11.1 asks to track bundle size, cold-start load, CPU, memory and cross-language
overhead; spec 11.2 proposes targets "subject to measurement". Run `make perf`
(builds, then `tests/perf/perf.spec.ts`); it writes `test-results/perf.json` and applies the
soft budgets below. CI runs it in the `check` job and uploads `perf.json`.

**Label for every number below: headless Chromium 158.0.8127.18 (Playwright 1.65), Linux 7.0,
AMD Ryzen 7 PRO 5850U x16, MOCK input, no audio hardware, no real wheel. A desktop that is also
running other work. These are not product claims and say nothing about Firefox, Safari,
real audio output, or real devices.**

## Results (this machine, 2026-11-14, commit 5849fe4 + Phase 6 working tree)

| Metric | Value | Notes |
|---|---|---|
| JS (2 files incl. wasm_exec.js) | 358,200 B raw / 111,509 B gzip | `apps/web/dist` |
| CSS | 3,951 B raw / 1,337 B gzip | |
| core.wasm | 4,868,698 B raw / 1,353,020 B gzip | Go runtime dominates; gzip is what a CDN would send |
| Cold start, navigation to WASM ready | median 211 ms (197 / 211 / 218) | 3 fresh contexts, local preview server, no network latency |
| WASM load (fetch + compile + instantiate), app-reported | median 74 ms | |
| Cross-language call (JS -> Go -> JS, `validateFrame`, 1000 calls) | mean 320 us, p95 800 us | p95 is quantised by the browser's coarse timer; per-frame cost at 60 Hz is about 2% of one core |
| 8-round MOCK guided session ("Full trail brake", 1 s rest, 1 s countdown, 55 s) | | |
| - JS heap after GC, start / end | 4.6 MiB / 6.6 MiB (growth 2.0 MiB) | peak sample 19.4 MiB before GC |
| - main thread busy / script | 11.7% / 10.0% of wall time | CDP `TaskDuration` / `ScriptDuration` |
| - long tasks (>50 ms) | 6, total 471 ms, max 138 ms | Chromium `longtask` observer, session window only |
| - audio control-update latency (scene time to parameter update scheduled) | p50 11.6 ms, p95 12.2 ms, max 78.7 ms (n=2000, ring buffer) | engine-side only; NOT acoustic latency |
| - alert scheduling latency | p50 15.8 ms, p95 78 ms (n=17) | |

Numbers vary run to run (an earlier run on the same tree: cold start 233 ms, heap growth 2.3 MiB,
long tasks 10 / 142 ms max). Treat them as an order of magnitude, not a benchmark.

## What this does and does not show against spec 11.2

- Target "p95 input-event-to-sound control-update under ~100 ms": the engine-side
  control-update p95 here is about 12 ms. The remaining path (audio output buffer, OS mixer,
  device) is unmeasured; acoustic latency needs a loopback capture on target hardware (T6 in
  `docs/hardware-test-protocol.md`). Not claimed.
- "No audible glitches", "stable sound output": not measurable headless; needs a person
  listening on hardware.
- "Bounded CPU/memory growth": heap growth over eight rounds was about 2 MiB after GC;
  CPU about 12% of one core's wall time. One eight-round run is a smoke measurement, not a
  soak test; run a longer session on the target machine before saying "bounded".
- Long tasks up to ~140 ms occur during the session (likely end-of-round results work and
  GC); they were not correlated with audio glitches because audio was not heard.
- Background/hidden tab behaviour is not measured here (separately reported capability).

## Proposed budgets (soft; fail only on gross regressions)

Enforced by the last test in `tests/perf/perf.spec.ts` (`BUDGET`). Roughly 2-25x current values on
purpose: they should catch a runaway bundle or leak, not noise. All are PROPOSED; revisit after
measuring on target machines and in CI.

| Budget | Threshold | Current |
|---|---|---|
| core.wasm size | <= 6 MiB | 4.64 MiB |
| JS gzip size | <= 250 KiB | 108.9 KiB |
| JS heap growth over 8 rounds (after GC) | <= 50 MiB | 2.0 MiB |

Reported but not enforced (too noisy for a hard gate): cold start, main-thread busy fraction,
long tasks, audio control-update latency. A reasonable first gate once target-machine data
exists: cold start under 2 s, p95 control update under 100 ms (spec 11.2).

## Not covered

Firefox and WebKit performance (the Phase 6 matrix only runs functional tests there; see
`docs/validation-log.md`; Firefox showed severe main-thread stalls in this environment),
real network conditions, mobile, throttled CPU, real audio output.
