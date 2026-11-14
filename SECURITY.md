# Security policy

## Reporting a vulnerability

Report it privately through GitHub private vulnerability reporting:
<https://github.com/arush-sal/trail-braking-trainer/security/advisories/new>
(repository **Security** tab, then **Report a vulnerability**). Do not open a public issue or
pull request for a security problem.

Please include the affected version (the footer shows it, as does `version.json`), the
browser and OS, steps to reproduce, and the impact. You will get an acknowledgement and
follow-up through the advisory. Fixes ship in a new signed release (`docs/release-process.md`).

## Supported versions

Only the latest release is supported. There is no stable release yet (pre-`v0.1.0`).

## Scope

In scope: this repository's static web bundle (React/TypeScript and the Go WASM core), the
`_headers` security headers, and the CI/release workflows.

Out of scope: the GT7 telemetry collector (a separate repository, which needs its own
report), browser vendors' speech services, and Cloudflare or GitHub themselves.

## Design summary

The app is a static bundle with no backend. Session telemetry stays in tab memory and is
never stored or uploaded. Voice commands are opt-in, and the app warns that the browser may
process audio remotely. The only network traffic is same-origin assets and a
user-initiated WebSocket to the GT7 collector. Threat model, privacy review and header
rationale: `docs/security.md`. To verify a release: README, "Verifying a release".
