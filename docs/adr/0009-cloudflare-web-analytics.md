# 0009. Allow Cloudflare Web Analytics on the production site

- Status: accepted (owner decision; narrows spec principle 5 "avoid analytics" and section 1 "no automatic analytics uploads")
- Date: 2026-11-14
- Requirements: R-027, R-030

## Context
After the v0.1.0 deploy, Cloudflare injected its Web Analytics (RUM) beacon into
the HTML served at `trail-braking-trainer.aru.sh`, and the CSP blocked it. The
owner asked to support Cloudflare Web Analytics rather than turn it off.

## Decision
- The CSP allows exactly the beacon script origin
  (`script-src https://static.cloudflareinsights.com`) and its report endpoint
  (`connect-src https://cloudflareinsights.com`). No other third-party origin.
- Cloudflare injects the beacon at the edge (automatic setup for the zone or
  site); the bundle carries no analytics code, token or snippet, so local,
  CI and e2e builds still make no third-party request.
- The beacon is cookieless and reports page views and page-load performance.
  The app sends it no input traces, session data or results.

## Consequences
- Visitors' page loads (URL, referrer subject to `Referrer-Policy: no-referrer`,
  user agent, timing) reach Cloudflare's analytics. Documented in
  `docs/security.md` and the README.
- Session data stays in memory only (R-027 unchanged): the beacon cannot read
  it beyond what any same-page script could, and it is a Cloudflare-served
  script trusted at the same level as the hosting itself.
- To remove analytics: disable Web Analytics for the hostname in Cloudflare and
  drop the two CSP sources.
