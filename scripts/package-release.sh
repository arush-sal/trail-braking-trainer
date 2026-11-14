#!/usr/bin/env bash
# Usage: scripts/package-release.sh VERSION [OUT_DIR]   (default OUT_DIR: dist-release)
# Packs DIST (default apps/web/dist) into a reproducible
# trail-braking-trainer_VERSION_web.tar.gz with build-manifest.json at the bundle
# root, then writes OUT_DIR/checksums.txt over the tarball and the two SBOMs
# (`make sbom` writes those first). Needs GNU tar, gzip, sha256sum, jq, git.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
version="${1:?usage: package-release.sh VERSION [OUT_DIR]}"
[[ $version =~ ^[0-9A-Za-z][0-9A-Za-z.+-]*$ ]] || { echo "invalid version: $version" >&2; exit 1; }
out="${2:-$root/dist-release}"
dist="${DIST:-$root/apps/web/dist}"
[ -f "$dist/index.html" ] || { echo "no bundle at $dist (run make build)" >&2; exit 1; }

name="trail-braking-trainer_${version}"
bundle="${name}_web"
for f in "${name}_web.spdx.json" "${name}_source.spdx.json"; do
  [ -f "$out/$f" ] || { echo "missing $out/$f (run make sbom)" >&2; exit 1; }
done

export SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-$(git -C "$root" log -1 --format=%ct)}"
export LC_ALL=C TZ=UTC
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
cp -R "$dist" "$stage/$bundle"

(cd "$stage/$bundle" && find . -type f -printf '%P\n' | sort | xargs -r -d '\n' sha256sum) |
  jq -Rn \
    --arg version "$version" \
    --arg commit "$(git -C "$root" rev-parse HEAD)" \
    --arg build_time "$(date -u -d "@$SOURCE_DATE_EPOCH" +%Y-%m-%dT%H:%M:%SZ)" \
    --arg go "$(go -C "$root/core" env GOVERSION)" \
    --arg node "$(node --version)" \
    '{version: $version, commit: $commit, build_time: $build_time, go: $go, node: $node,
      files: [inputs | capture("^(?<sha256>[0-9a-f]{64})  (?<path>.+)$")]}' \
    >"$stage/$bundle/build-manifest.json"

tar --sort=name --format=pax \
  --pax-option=exthdr.name=%d/PaxHeaders/%f,delete=atime,delete=ctime \
  --mtime="@$SOURCE_DATE_EPOCH" --owner=0 --group=0 --numeric-owner \
  --mode='u+rwX,go+rX,go-w' \
  -C "$stage" -cf - "$bundle" | gzip -n -9 >"$out/$bundle.tar.gz"

(cd "$out" && sha256sum "$bundle.tar.gz" "${name}_web.spdx.json" "${name}_source.spdx.json" >checksums.txt)
echo "$out/$bundle.tar.gz"
