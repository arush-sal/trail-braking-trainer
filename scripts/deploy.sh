#!/usr/bin/env bash
# Usage: scripts/deploy.sh [--dry-run] SITE_DIR
# Uploads an already-verified, extracted release bundle to Cloudflare Workers
# Static Assets with the cf CLI (ADR 0008). Never builds anything.
# Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID (not for --dry-run).
set -euo pipefail

dry=()
if [[ ${1:-} == --dry-run ]]; then dry=(--dry-run); shift; fi
site=${1:?usage: scripts/deploy.sh [--dry-run] SITE_DIR}
[[ -f $site/index.html && -f $site/build-manifest.json ]] && compgen -G "$site/assets/core-*.wasm" >/dev/null \
  || { echo "deploy.sh: $site is not a release bundle (index.html, assets/core-*.wasm, build-manifest.json)" >&2; exit 2; }
if ((${#dry[@]} == 0)); then
  : "${CLOUDFLARE_API_TOKEN:?deploy.sh: CLOUDFLARE_API_TOKEN not set}"
  : "${CLOUDFLARE_ACCOUNT_ID:?deploy.sh: CLOUDFLARE_ACCOUNT_ID not set}"
fi

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
site="$(cd "$site" && pwd)"
version="$(node -p 'require(process.argv[1]).version' "$site/build-manifest.json")"

cd "$root/deploy"
exec npx --no-install cf deploy "$site" "${dry[@]}" --tag "v$version" --message "release v$version"
