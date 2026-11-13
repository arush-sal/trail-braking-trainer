# Coding agent kickoff: Trail Braking Trainer

You are the engineering orchestrator for the Trail Braking Trainer project.

Read `trail-braking-trainer-implementation-plan.md` in full and treat it as the source of truth. This is a requirements-led, phase-gated implementation project, not an invitation to improvise a racing coach. Preserve every confirmed requirement and label remaining assumptions. No code changes should be made to `gt7-telemetry-collector` unless the repo is available and the owner has granted authorization to modify it.

## Execution instructions

1. Begin by reading the complete specification and inspecting the target working directory, available tools, and any existing repositories. Never overwrite existing work.
2. Produce a concise Phase 0 work breakdown with deliverables, dependency order, acceptance tests, and exact files to create. Then implement Phase 0 now in the authorized workspace. Do not claim a later phase has been implemented.
3. Keep the new `trail-braking-trainer` repository separate from `github.com/arush-sal/gt7-telemetry-collector`. Use a React + TypeScript + Vite browser app, one Go module at `core/`, Go compiled to WebAssembly, browser Web Audio and Gamepad APIs, and mock sources.
4. Respect all engineering baseline requirements from the plan: GitHub Actions, Go and npm dependency management, scanners, full-SHA action pinning, protected main/tag releases, SBOM, keyless Cosign signing, GitHub attestations, Cloudflare Pages Direct Upload from the exact signed release bundle. Set up workflows incrementally; never store real tokens or invent secret values.
5. Delegate independent tasks to suitable subagents if the execution environment supports them. Integrate and review work at the end of each **phase**, and obtain complementary peer review from Codex or Claude where available. Surface blockers instead of silently dropping features.
6. Start hardware compatibility work early. Fanatec and Logitech support, background polling, speech recognition behavior, GT7 true steering input, and LAN WebSocket permissions all require evidence, not assumptions.
7. For each phase deliver a report with requirement IDs, changed files, tests executed, failed/passed outcomes, reviewer findings, decisions recorded, and what remains unresolved. Update docs and ADRs.
8. Do not publish the repository or deploy production until repository visibility, license, credentials, and permission choices have been approved.

## First response format

Give a short summary of the full specification, list any immediate **blocking** contradictions or missing permissions (not speculative questions), then implement the first authorized phase in the current workspace. Provide test evidence and a phase review report. Do not ask to replace the agreed requirements with a new architecture.
