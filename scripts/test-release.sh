#!/usr/bin/env bash
# Assertions for package-release.sh / verify-release.sh / deploy.sh (run: make test-release).
# Uses a synthetic dist so it needs neither a web build nor syft/cosign.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
V=9.8.7
name="trail-braking-trainer_${V}"
fails=0
ok() { echo "ok   $*"; }
bad() { echo "FAIL $*" >&2; fails=$((fails + 1)); }
expect_fail() { # desc, expected stderr fragment, cmd...
  local desc=$1 frag=$2; shift 2
  if out="$("$@" 2>&1)"; then bad "$desc: succeeded"; return; fi
  if [[ $out == *"$frag"* ]]; then ok "$desc"; else bad "$desc: missing '$frag' in: $out"; fi
}

mkdir -p "$tmp/dist/assets"
echo '<html></html>' >"$tmp/dist/index.html"
echo 'console.log(1)' >"$tmp/dist/assets/app.js"
printf '\0asm' >"$tmp/dist/assets/core-0123456789abcdef.wasm"

pkg() { # outdir
  mkdir -p "$1"
  echo '{"spdxVersion":"SPDX-2.3"}' >"$1/${name}_web.spdx.json"
  echo '{"spdxVersion":"SPDX-2.3"}' >"$1/${name}_source.spdx.json"
  DIST="$tmp/dist" "$root/scripts/package-release.sh" "$V" "$1" >/dev/null
}

pkg "$tmp/a"
touch -d '2001-01-01' "$tmp/dist/index.html" # mtime must not leak into the archive
pkg "$tmp/b"
tb="${name}_web.tar.gz"
if cmp -s "$tmp/a/$tb" "$tmp/b/$tb"; then ok "tarball reproducible"; else bad "tarball differs between builds"; fi

listing="$(tar -tvzf "$tmp/a/$tb" --numeric-owner)"
if ! grep -qv ' 0/0 ' <<<"$listing"; then ok "owner 0/0"; else bad "non-root owner: $listing"; fi
names="$(tar -tzf "$tmp/a/$tb")"
if [[ $names == "$(LC_ALL=C sort <<<"$names")" ]]; then ok "sorted entries"; else bad "unsorted: $names"; fi
if ! grep -qv "^${name}_web/" <<<"$names"; then ok "single bundle root"; else bad "entry outside root: $names"; fi
epoch="$(git -C "$root" log -1 --format=%ct)"
mt="$(tar -xOzf "$tmp/a/$tb" "${name}_web/build-manifest.json" | jq -r '.build_time')"
[[ $mt == "$(date -u -d "@$epoch" +%Y-%m-%dT%H:%M:%SZ)" ]] && ok "build_time = commit time" || bad "build_time $mt"
m="$(tar -xOzf "$tmp/a/$tb" "${name}_web/build-manifest.json")"
jq -e --arg v "$V" --arg c "$(git -C "$root" rev-parse HEAD)" \
  '.version == $v and .commit == $c and (.go | length > 0) and (.node | length > 0)
   and ([.files[].path] == ["assets/app.js", "assets/core-0123456789abcdef.wasm", "index.html"])
   and (.files[0].sha256 | test("^[0-9a-f]{64}$"))' <<<"$m" >/dev/null &&
  ok "manifest fields" || bad "manifest: $m"
[[ "$(od -An -tx1 -j4 -N4 "$tmp/a/$tb" | tr -d ' ')" == 00000000 ]] && ok "gzip -n (no mtime)" || bad "gzip mtime set"
for f in "$tb" "${name}_web.spdx.json" "${name}_source.spdx.json"; do
  grep -q "  $f\$" "$tmp/a/checksums.txt" || bad "checksums.txt lacks $f"
done

verify() { "$root/scripts/verify-release.sh" --local "$@"; }
verify "$V" "$tmp/a" >/dev/null && ok "verify --local passes" || bad "verify --local failed on good release"

expect_fail "bad version arg" "invalid version" verify '1.0;rm' "$tmp/a"
cp -r "$tmp/a" "$tmp/c" && rm "$tmp/c/${name}_web.spdx.json"
expect_fail "missing file" "missing ${name}_web.spdx.json" verify "$V" "$tmp/c"
cp -r "$tmp/a" "$tmp/d" && echo x >>"$tmp/d/${name}_source.spdx.json"
expect_fail "bad checksum" "checksum mismatch" verify "$V" "$tmp/d"
cp -r "$tmp/a" "$tmp/e" && sed -i "/$tb/d" "$tmp/e/checksums.txt"
expect_fail "checksums.txt omits tarball" "checksums.txt lacks $tb" verify "$V" "$tmp/e"

# Tampered bundle with recomputed checksums: manifest must catch it.
mkdir "$tmp/x" && tar -xzf "$tmp/a/$tb" -C "$tmp/x"
echo evil >>"$tmp/x/${name}_web/assets/app.js"
cp -r "$tmp/a" "$tmp/f" && tar -czf "$tmp/f/$tb" -C "$tmp/x" "${name}_web"
(cd "$tmp/f" && sha256sum "$tb" "${name}_web.spdx.json" "${name}_source.spdx.json" >checksums.txt)
expect_fail "tampered bundle file" "manifest mismatch" verify "$V" "$tmp/f"
mkdir "$tmp/y" && tar -xzf "$tmp/a/$tb" -C "$tmp/y" && echo extra >"$tmp/y/${name}_web/extra.js"
cp -r "$tmp/a" "$tmp/g" && tar -czf "$tmp/g/$tb" -C "$tmp/y" "${name}_web"
(cd "$tmp/g" && sha256sum "$tb" "${name}_web.spdx.json" "${name}_source.spdx.json" >checksums.txt)
expect_fail "unlisted bundle file" "manifest mismatch" verify "$V" "$tmp/g"
expect_fail "version mismatch" "missing trail-braking-trainer_1.2.3_web.tar.gz" verify 1.2.3 "$tmp/a"
# Root whose name only matches the version with '.' as a regex wildcard (9X8Y7 vs 9.8.7).
mkdir "$tmp/z" && cp -r "$tmp/x/${name}_web" "$tmp/z/trail-braking-trainer_9X8Y7_web"
cp -r "$tmp/a" "$tmp/h" && tar -czf "$tmp/h/$tb" -C "$tmp/z" trail-braking-trainer_9X8Y7_web
(cd "$tmp/h" && sha256sum "$tb" "${name}_web.spdx.json" "${name}_source.spdx.json" >checksums.txt)
expect_fail "malformed bundle root" "entries outside ${name}_web/" verify "$V" "$tmp/h"

# Signature mode needs the bundles before calling cosign.
expect_fail "missing sigstore bundle" "missing $tb.sigstore.json" "$root/scripts/verify-release.sh" "$V" "$tmp/a"

# deploy.sh: refuses non-bundles and missing credentials; dry-runs a real bundle.
expect_fail "deploy non-bundle" "is not a release bundle" "$root/scripts/deploy.sh" "$tmp/a"
mkdir -p "$tmp/site" && tar -xzf "$tmp/a/$tb" -C "$tmp/site" --no-same-owner
site="$tmp/site/${tb%.tar.gz}"
expect_fail "deploy without token" "CLOUDFLARE_API_TOKEN not set" env -u CLOUDFLARE_API_TOKEN "$root/scripts/deploy.sh" "$site"
if out=$(env -u CLOUDFLARE_API_TOKEN "$root/scripts/deploy.sh" --dry-run "$site" 2>&1) && grep -q "dry-run: exiting now" <<<"$out"; then
  ok "deploy dry-run"
else
  bad "deploy dry-run: $out"
fi

((fails == 0)) && echo "release tests passed" || { echo "$fails release test(s) failed" >&2; exit 1; }
