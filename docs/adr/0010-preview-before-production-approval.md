# 0010. Access-protected preview version before production approval

- Status: accepted (owner request, 2026-11-14)
- Date: 2026-11-14
- Requirements: R-031, R-032

## Context
The `production` environment approval had nothing to review: the deploy job
uploaded and went live in one step. The owner asked for a preview link at the
approval step, gated behind Cloudflare Zero Trust.

## Decision
- New `preview` job (environment `preview`, tags `v*` only, no reviewer): verifies the
  published Release assets, then `scripts/deploy.sh --preview` uploads them with
  `cf workers versions create` as a Worker version that receives **no production
  traffic**, tagged `vX.Y.Z`, preview alias `vX-Y-Z`. The preview URL is the
  `preview` environment URL and is written to the run summary.
- `deploy` (environment `production`, required reviewer) no longer uploads:
  `scripts/deploy.sh --promote VERSION_ID X.Y.Z` checks the version's tag and routes
  100% of traffic to exactly the version that was reviewed.
- Preview URLs (`*-trail-braking-trainer.<subdomain>.workers.dev`) are protected by a
  Cloudflare Access self-hosted application allowing `tbt-admin@aru.sh`.
  `deploy.sh --preview` fails closed if no Access application covers that domain.
- `deploy/cloudflare.config.ts` sets `previewUrls: true` explicitly.
- Rollback still redeploys an earlier Release in one step (`scripts/deploy.sh`).

## Consequences
- The API token also needs Access read (fail-closed check); creating or editing
  the Access application needs Access: Apps and Policies Edit (one-time, owner).
- Secrets exist in both `preview` and `production` environments.
- A rejected release leaves an unrouted Worker version behind; harmless.
