#!/usr/bin/env bash
# Usage: scripts/verify-release.sh [--local] VERSION [DIR]   (default DIR: .)
# Verifies a release directory: checksums.txt, Cosign keyless bundles (identity
# = this repo's release.yml at tag vVERSION), GitHub provenance + SBOM
# attestations, and every bundle file against build-manifest.json.
# --local skips the Cosign/attestation checks (unsigned local builds; `make verify-dist`).
# Needs sha256sum, GNU tar, jq; plus cosign and gh (GH_TOKEN) without --local.
set -euo pipefail

repo=arush-sal/trail-braking-trainer
local_only=false
[[ ${1:-} == --local ]] && { local_only=true; shift; }
version="${1:?usage: verify-release.sh [--local] VERSION [DIR]}"
[[ $version =~ ^[0-9A-Za-z][0-9A-Za-z.+-]*$ ]] || { echo "invalid version: $version" >&2; exit 1; }
dir="${2:-.}"
die() { echo "verify-release: $*" >&2; exit 1; }

name="trail-braking-trainer_${version}"
bundle="${name}_web"
tarball="$bundle.tar.gz"
artifacts=("$tarball" "${name}_web.spdx.json" "${name}_source.spdx.json")
signed=("${artifacts[@]}" checksums.txt)
need=("${signed[@]}")
$local_only || for f in "${signed[@]}"; do need+=("$f.sigstore.json"); done
for f in "${need[@]}"; do [ -f "$dir/$f" ] || die "missing $f in $dir"; done

# 1. Checksums: every artifact must be listed (a sparse checksums.txt would pass -c).
for f in "${artifacts[@]}"; do
  grep -qE "^[0-9a-f]{64}  $(sed 's/[.+]/\\&/g' <<<"$f")\$" "$dir/checksums.txt" || die "checksums.txt lacks $f"
done
(cd "$dir" && sha256sum --strict --quiet -c checksums.txt) || die "checksum mismatch"
echo "checksums OK"

# 2. Signatures and attestations, pinned to the release workflow at this tag.
if ! $local_only; then
  identity="^https://github\.com/$repo/\.github/workflows/release\.yml@refs/tags/v$(sed 's/[.+]/\\&/g' <<<"$version")\$"
  for f in "${signed[@]}"; do
    cosign verify-blob --bundle "$dir/$f.sigstore.json" \
      --certificate-identity-regexp "$identity" \
      --certificate-oidc-issuer https://token.actions.githubusercontent.com \
      "$dir/$f" || die "cosign signature invalid for $f"
  done
  att=(--repo "$repo" --signer-workflow "$repo/.github/workflows/release.yml" --source-ref "refs/tags/v$version")
  for f in "${artifacts[@]}"; do
    gh attestation verify "$dir/$f" "${att[@]}" >/dev/null || die "provenance attestation invalid for $f"
  done
  gh attestation verify "$dir/$tarball" "${att[@]}" --predicate-type https://spdx.dev/Document/v2.3 >/dev/null ||
    die "SBOM attestation invalid for $tarball"
  echo "signatures and attestations OK"
fi

# 3. Bundle contents: only regular files/dirs under the bundle root, all and only
#    the files listed in build-manifest.json, with matching hashes.
listing="$(tar -tvzf "$dir/$tarball")" || die "unreadable $tarball"
grep -qv '^[-d]' <<<"$listing" && die "$tarball contains links or special files"
names="$(tar -tzf "$dir/$tarball")"
while IFS= read -r n; do # literal prefix: the version's dots are not wildcards
  [[ $n == "$bundle" || $n == "$bundle/"* ]] || die "$tarball has entries outside $bundle/: $n"
done <<<"$names"
grep -qE '(^|/)\.\.(/|$)' <<<"$names" && die "$tarball has .. entries"
x="$(mktemp -d)"
trap 'rm -rf "$x"' EXIT
tar -xzf "$dir/$tarball" -C "$x" --no-same-owner
m="$x/$bundle/build-manifest.json"
[ -f "$m" ] || die "build-manifest.json missing from bundle"
[[ "$(jq -r .version "$m")" == "$version" ]] || die "manifest version is not $version"
want="$(jq -r '.files[] | "\(.sha256)  \(.path)"' "$m")"
have="$(cd "$x/$bundle" && find . -type f ! -path ./build-manifest.json -printf '%P\n' | LC_ALL=C sort | xargs -r -d '\n' sha256sum)"
[[ $want == "$have" ]] || die "manifest mismatch: $(diff <(echo "$want") <(echo "$have") | grep '^[<>]' | head -5 | tr '\n' ' ')"
echo "bundle manifest OK ($(jq '.files | length' "$m") files, commit $(jq -r .commit "$m"))"
