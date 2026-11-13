#!/usr/bin/env bash
# Usage: scripts/build-wasm.sh [OUT_DIR]   (default apps/web/public/wasm; VERSION env, default dev)
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out="${1:-$root/apps/web/public/wasm}"
mkdir -p "$out"
out="$(cd "$out" && pwd)"
VERSION="${VERSION:-dev}"

GOOS=js GOARCH=wasm CGO_ENABLED=0 go -C "$root/core" build -trimpath \
  -ldflags "-s -w -buildid= -X main.version=$VERSION" \
  -o "$out/core.wasm" ./cmd/wasm

goroot="$(go -C "$root/core" env GOROOT)" # same toolchain that built core.wasm
exec_js="$goroot/lib/wasm/wasm_exec.js"
[ -f "$exec_js" ] || exec_js="$goroot/misc/wasm/wasm_exec.js"
cp "$exec_js" "$out/wasm_exec.js"
