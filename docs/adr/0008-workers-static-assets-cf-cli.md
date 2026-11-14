# 0008. Host on Cloudflare Workers Static Assets, deploy with the `cf` CLI

- Status: accepted (supersedes the "Cloudflare Pages / Wrangler Direct Upload" wording in spec sections 1 S6, 2 R-032, 10)
- Date: 2026-11-14
- Requirements: R-032

## Context
Owner asked to use Cloudflare's new `cf` CLI instead of Wrangler. `cf`
(1.0.0-beta.32) deploys a prebuilt static directory with `cf deploy <dir>` as an
assets-only Worker (Workers Static Assets). Its Pages commands are raw API calls
without file upload; Cloudflare docs still route Pages Direct Upload through
Wrangler.

## Decision
- Target: Workers Static Assets, assets-only Worker `trail-braking-trainer`, no
  Worker script (no server code runs), SPA not-found handling, custom domain `trail-braking-trainer.aru.sh`, `workers.dev` on.
- Tool: `cf` pinned exactly in the root lockfile; config in
  `deploy/cloudflare.config.ts`; invoked only by `scripts/deploy.sh` from a
  bundle already verified by `scripts/verify-release.sh` (exact release bytes).
- Same `_headers` file semantics as Pages (supported by Workers Static Assets).

## Consequences
- `cf` is beta: commands/config may change; pinned version + `make test-release`
  dry-run catch breakage. Revisit when `cf` leaves beta.
- No per-branch preview deployments by default (not required by spec).
- Rollback = `rollback.yml` redeploying an earlier signed release.
