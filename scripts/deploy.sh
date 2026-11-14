#!/usr/bin/env bash
# Cloudflare Workers Static Assets deploys with the cf CLI (ADR 0008, ADR 0010). Never builds.
#
#   scripts/deploy.sh [--dry-run] SITE_DIR
#       Upload and deploy an extracted, verified release bundle in one step (rollback).
#   scripts/deploy.sh --preview [--dry-run] SITE_DIR
#       Upload the bundle as a new Worker version WITHOUT routing traffic to it. Prints
#       version_id=, preview_url= and alias_url= (also appended to $GITHUB_OUTPUT when set).
#       Refuses to upload unless a Cloudflare Access application protects the Worker's
#       preview URLs (fail closed).
#   scripts/deploy.sh --promote VERSION_ID X.Y.Z
#       Route 100% of traffic to an uploaded version, after checking it is tagged vX.Y.Z.
#
# Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID (not for --dry-run).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
worker=trail-braking-trainer
api=https://api.cloudflare.com/client/v4

need_creds() {
  : "${CLOUDFLARE_API_TOKEN:?deploy.sh: CLOUDFLARE_API_TOKEN not set}"
  : "${CLOUDFLARE_ACCOUNT_ID:?deploy.sh: CLOUDFLARE_ACCOUNT_ID not set}"
}
cfapi() { # path -> JSON result (fails on success=false)
  curl -fsS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "$api/accounts/$CLOUDFLARE_ACCOUNT_ID/$1" |
    jq -e 'if .success then .result else error("Cloudflare API: \(.errors)") end'
}
bundle() { # dir -> absolute dir; exits unless it is a release bundle
  local d=$1
  [[ -f $d/index.html && -f $d/build-manifest.json ]] && compgen -G "$d/assets/core-*.wasm" >/dev/null ||
    { echo "deploy.sh: $d is not a release bundle (index.html, assets/core-*.wasm, build-manifest.json)" >&2; exit 2; }
  (cd "$d" && pwd)
}
# Access apps JSON, preview domain, Worker tag -> exit 0 if an app protects the preview URLs:
# either a self-hosted app on the wildcard domain, or the dashboard's "preview_worker" destination.
access_covers() {
  jq -e --arg d "$2" --arg t "$3" 'any(.[]; .domain == $d or any(.self_hosted_domains[]?; . == $d)
    or any(.destinations[]?; .type == "preview_worker" and .worker_id == $t))' <<<"$1" >/dev/null
}
manifest_version() { node -p 'require(process.argv[1]).version' "$1/build-manifest.json"; }

mode=deploy
case ${1:-} in
  --access-check) access_covers "$2" "$3" "$4"; exit ;; # test hook for the predicate
  --preview) mode=preview; shift ;;
  --promote) mode=promote; shift ;;
esac

if [[ $mode == promote ]]; then
  id=${1:-} version=${2:-}
  [[ $id =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || { echo "deploy.sh: invalid version id '$id'" >&2; exit 2; }
  [[ $version =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || { echo "deploy.sh: invalid version '$version'" >&2; exit 2; }
  need_creds
  tag="$(cfapi "workers/scripts/$worker/versions/$id" | jq -r '.metadata.annotations["workers/tag"] // .annotations["workers/tag"] // empty')"
  [[ $tag == "v$version" ]] || { echo "deploy.sh: version $id is tagged '$tag', expected v$version" >&2; exit 1; }
  cd "$root/deploy"
  exec npx --no-install cf workers deployments create --worker "$worker" --strategy percentage \
    --versions "[{\"version_id\":\"$id\",\"percentage\":100}]"
fi

dry=()
if [[ ${1:-} == --dry-run ]]; then dry=(--dry-run); shift; fi
site="$(bundle "${1:?usage: scripts/deploy.sh [--preview] [--dry-run] SITE_DIR}")"
((${#dry[@]})) || need_creds
version="$(manifest_version "$site")"
cd "$root/deploy"

if [[ $mode == deploy ]]; then
  exec npx --no-install cf deploy "$site" "${dry[@]}" --tag "v$version" --message "release v$version"
fi

# --preview
alias="v${version//./-}"
if ((${#dry[@]} == 0)); then
  sub="$(cfapi workers/subdomain | jq -r .subdomain)"
  domain="*-$worker.$sub.workers.dev"
  tag="$(cfapi workers/scripts | jq -r --arg w "$worker" '.[] | select(.id == $w) | .tag')"
  access_covers "$(cfapi access/apps)" "$domain" "$tag" ||
    { echo "deploy.sh: no Cloudflare Access application protects $domain; refusing to publish a preview" >&2; exit 1; }
fi
out="$(npx --no-install cf workers versions create "$site" "${dry[@]}" --tag "v$version" \
  --message "release v$version (preview)" --preview-alias "$alias" 2>&1)" || { echo "$out" >&2; exit 1; }
echo "$out"
((${#dry[@]} == 0)) || exit 0
id="$(sed -n 's/.*Worker Version ID: *\([0-9a-f-]\{36\}\).*/\1/p' <<<"$out" | head -1)"
url="$(sed -n 's/.*Version Preview URL: *\(https:[^ ]*\).*/\1/p' <<<"$out" | head -1)"
aurl="$(sed -n 's/.*Version Preview Alias URL: *\(https:[^ ]*\).*/\1/p' <<<"$out" | head -1)"
[[ -n $id && -n $url ]] || { echo "deploy.sh: could not read version id / preview URL from cf output" >&2; exit 1; }
printf 'version_id=%s\npreview_url=%s\nalias_url=%s\n' "$id" "$url" "$aurl" | tee -a "${GITHUB_OUTPUT:-/dev/null}"
