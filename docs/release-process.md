# Release process

Requirements: R-031, R-032. Spec section 10. The spec's `main` is `master` (ADR 0001).

Production changes only through a protected `vX.Y.Z` tag on a tested `master`
commit. The bundle is built **once**, then checksummed, SBOM'd, signed and
attested, published as a GitHub Release, and those exact bytes are deployed.

## Flow (`.github/workflows/release.yml`)

| Job | Does | Token permissions |
|---|---|---|
| `verify-tag` | Tag matches `v[0-9]+.[0-9]+.[0-9]+` (no leading zeros); tag commit is an ancestor of `origin/master` (`git merge-base --is-ancestor`); `apps/web/package.json` `version` equals the tag without `v`. | `contents: read` |
| `gates` | No caches (setup-go/setup-node/golangci-lint caching off, Trivy DB fetched fresh): `make security setup lint test test-wasm test-e2e`. `test-e2e` is an **additional** gate: the full hook-based Playwright suite runs on an e2e-mode build (`dist-e2e`, test hooks) of the same commit, so it tests a different build from the one released. | `contents: read` |
| `build` | With `VERSION=X.Y.Z` (= `VITE_APP_VERSION`): `make build` **once** into `apps/web/dist`; `make test-dist` runs the hook-free Playwright gates (smoke, CSP, version, recovery; tests tagged `@hooks` excluded) against **that** directory (`E2E_DIST=dist` webServer, no rebuild, rejects `__tbtTest`); `make package verify-dist` packs that same directory; `make scan-dist` runs blocking Trivy (vuln+secret, HIGH/CRITICAL) on the extracted tarball and `trivy sbom` on the web SBOM. Only then Cosign keyless `sign-blob --bundle` for tarball, both SBOMs and `checksums.txt`, `actions/attest-build-provenance` over `checksums.txt` subjects, `actions/attest-sbom` (web SBOM on the tarball; a separate attestation with a different predicate, not a duplicate of the provenance), then `scripts/verify-release.sh` against the workflow identity. Uploads `dist-release/`. | `contents: read`, `id-token: write`, `attestations: write` |
| `release` | Re-checks `checksums.txt`, `gh release create vX.Y.Z` with all files. | `contents: write` |
| `preview` | Environment `preview` (tags `v*`, no reviewer). Downloads the **Release assets** (not the build artifact, not a rebuild), runs `scripts/verify-release.sh`, extracts, `scripts/deploy.sh --preview` uploads them as a Worker version with **no production traffic** behind Cloudflare Access (ADR 0010). The preview URL is the environment URL and is in the run summary. | `contents: read`, `attestations: read` |
| `deploy` | Environment `production` (required reviewer: review the preview first). `scripts/deploy.sh --promote <version id> X.Y.Z` checks the version tag and routes 100% of traffic to exactly the previewed version. No upload. | `contents: read` |

`scripts/deploy.sh [--dry-run] <bundle dir>` deploys the verified bundle to
Cloudflare **Workers Static Assets** with the lockfile-pinned `cf` CLI
(ADR 0008): assets-only Worker `trail-braking-trainer` (config:
`deploy/cloudflare.config.ts`), no Worker code, single-page-app fallback,
custom domain `trail-braking-trainer.aru.sh` (zone `aru.sh`, same account) plus the `workers.dev` route. The Worker version is tagged `vX.Y.Z`. It refuses a
directory that is not a release bundle and requires `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` (except `--dry-run`). `make test-release` dry-runs it.

Tests in `smoke`, `csp`, `version` or `recovery` specs that need the e2e
test hooks (`window.__tbtTest`) must carry `{ tag: '@hooks' }`, or
`make test-dist` fails on the production bundle.

Release files (`dist-release/` locally):

```text
trail-braking-trainer_X.Y.Z_web.tar.gz            bundle root trail-braking-trainer_X.Y.Z_web/ + build-manifest.json
trail-braking-trainer_X.Y.Z_web.spdx.json         shipped components: production npm deps + Go core module
trail-braking-trainer_X.Y.Z_source.spdx.json      all npm (incl. dev), Go modules, GitHub Actions
checksums.txt                                     sha256 of the three files above
*.sigstore.json                                   Cosign bundles for all four files
```

`build-manifest.json` holds version, commit, build time (= commit time,
`SOURCE_DATE_EPOCH`), Go and Node versions, and every bundle file's sha256.
The tarball is reproducible: sorted entries, owner/group 0, mtime =
`SOURCE_DATE_EPOCH`, normalized modes, `gzip -n`. `make test-release` asserts
this plus the verifier's failure paths. Syft cannot read Go build info from
`core.wasm`, so the Go component comes from `core/go.mod`; the Go toolchain
version that compiled the WASM is in `build-manifest.json`.

Pinned tools: Syft 1.57.1 (`go install -ldflags "-X main.version=1.57.1"
github.com/anchore/syft/cmd/syft@v1.57.1`), Cosign v3.1.4 (via
`sigstore/cosign-installer` v4.1.3), Trivy v0.76.2, govulncheck v1.9.0,
osv-scanner v2.7.1, zizmor 1.32.0, golangci-lint v2.15.0.

## Cutting a release

```sh
# on master, after CI is green: bump apps/web/package.json "version" to X.Y.Z via PR, merge
git tag -s vX.Y.Z -m vX.Y.Z <master commit>
git push origin vX.Y.Z
# open the preview URL from the run summary (Cloudflare Access sign-in), then
# approve the production environment deployment when the deploy job waits
```

Local dry run (unsigned): `make build package verify-dist VERSION=X.Y.Z`
(needs `syft`, `jq`, GNU `tar`).

## Required GitHub settings (owner)

The repository is public, so GitHub artifact attestations
(`actions/attest-build-provenance`, `actions/attest-sbom`, `gh attestation
verify`) are supported; no plan upgrade is needed.

1. **Tag ruleset** `v*` (target: tags): restrict creation, update and deletion
   to the owner/maintainers; block force pushes. Tags are immutable once pushed.
2. **Branch ruleset / protection** for `master`: require a PR, require signed
   commits, block force pushes and deletion, require status checks (strict, up to date):
   - `Lint, test and build` (Tests)
   - `Govulncheck`, `OSV-Scanner`, `Trivy filesystem`, `Zizmor GitHub Actions audit` (Security)
   - `Analyze (go)`, `Analyze (javascript-typescript)` (CodeQL)
   - `DCO`
3. **Environment** `production`: required reviewer (owner; leave "prevent
   self-review" off while there is a single maintainer); deployment branches
   and tags limited to tags `v*` and branch `master` (for `rollback.yml`).
4. **Environment secrets** on `preview` and `production` only (never repository-wide, never
   to fork PR jobs): `CLOUDFLARE_API_TOKEN` (minimum: Account > Workers Scripts: Edit; Zone aru.sh > Workers Routes: Edit + DNS: Edit for the custom domain; Account > Access: Apps and Policies: Read for the fail-closed preview check),
   `CLOUDFLARE_ACCOUNT_ID`.
5. Actions settings: workflow `GITHUB_TOKEN` default read-only; Actions may not
   create or approve PRs; immutable releases enabled if available.

## Verifying a release

See README "Verifying a release". `scripts/verify-release.sh X.Y.Z DIR` does all
of it: `sha256sum -c`, `cosign verify-blob` with identity
`https://github.com/arush-sal/trail-braking-trainer/.github/workflows/release.yml@refs/tags/vX.Y.Z`
and issuer `https://token.actions.githubusercontent.com`, `gh attestation
verify` (provenance for all three files, SPDX SBOM predicate for the tarball,
signer workflow `release.yml`, source ref `refs/tags/vX.Y.Z`), then rejects
links, paths outside the bundle root, and any file missing from, extra to, or
differing from `build-manifest.json`.

## Rollback

Actions -> Rollback -> Run workflow (branch `master`), input `tag: vX.Y.Z` of an
earlier Release. It downloads that Release's assets, verifies them with
`scripts/verify-release.sh`, and redeploys via `scripts/deploy.sh` under the
`production` environment (same approval). No rebuild. Shares the `production`
concurrency group with the release deploy job.

To withdraw a bad release: roll back first, then mark the GitHub Release as
pre-release or delete its assets; never move or reuse a tag. Ship the fix as a
new patch version.

## Scanner finding exception policy

Release gates (source scans in `gates`, built-bundle + SBOM scans in `build`) block unreviewed HIGH/CRITICAL actionable findings (Trivy, OSV-Scanner,
govulncheck, CodeQL, zizmor). An exception is a reviewed PR that records, next
to the suppression (`.trivyignore`, `osv-scanner.toml`, zizmor `# zizmor: ignore[...]`,
CodeQL dismissal comment) and in this section's log:

- **False positive**: why the finding does not apply (code path unreachable,
  dev-only dependency not shipped, etc.), with evidence. No expiry; re-reviewed
  on dependency changes.
- **Accepted risk**: impact assessment, mitigation, owner, and an **expiry date**
  (max 90 days). Expired exceptions fail review and must be renewed or fixed.
- **Patch availability**: when no fix exists, link the upstream advisory/issue;
  upgrade within 7 days of a fix being released (Dependabot surfaces it).
  Prefer an override (see ADR 0004) to a suppression when a fixed version exists.

Exception log: none.

## Applied repository settings (2026-11-14)

Applied by the orchestrator with owner approval: `master` protection (the
required checks above, linear history, no force-push/deletion; admins not
enforced so signed fast-forward merges remain possible), tag ruleset
`release tags v*` (no deletion/update/non-fast-forward; repository admins may
bypass), environment `production` (owner as required reviewer; branch
`master` and tags `v*`) with the two Cloudflare secrets, default workflow
token read-only, secret scanning + push protection, private vulnerability
reporting.

Actions policy (2026-11-14, owner request): "Allow arush-sal, and select
non-arush-sal, actions and reusable workflows" (`allowed_actions=selected`,
GitHub-owned allowed, verified creators not auto-allowed). Third-party
allowlist: `aquasecurity/setup-trivy@*`, `aquasecurity/trivy-action@*`,
`golangci/golangci-lint-action@*`, `sigstore/cosign-installer@*`,
`zizmorcore/zizmor-action@*`. Nested composite uses are GitHub-owned
(`actions/cache`, `actions/checkout`, `actions/attest`,
`github/codeql-action/upload-sarif`) or listed. A new third-party action
fails at startup until added via
`gh api -X PUT repos/arush-sal/trail-braking-trainer/actions/permissions/selected-actions`.
