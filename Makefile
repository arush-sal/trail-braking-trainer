SHELL := /usr/bin/env bash
.SHELLFLAGS := -euo pipefail -c
.DEFAULT_GOAL := help

VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
export VERSION
GOLANGCI := golangci-lint run --config ../.golangci.yml ./...
WASM_OUT := apps/web/public/wasm

.PHONY: help setup dev test lint build security clean \
	test-e2e test-wasm sbom verify-dist

help: ## List targets
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-12s %s\n", $$1, $$2}'

setup: ## Install pinned npm deps and verify Go modules
	npm ci
	go -C core mod download
	go -C core mod verify

dev: wasm ## Vite dev server (rebuild WASM manually with `make wasm`)
	npm run dev

test: ## Go (race) and frontend unit suites
	go -C core test -race -count=1 ./...
	npm test

lint: ## go vet (native + js/wasm), golangci-lint, eslint, typecheck
	go -C core vet ./...
	GOOS=js GOARCH=wasm go -C core vet ./...
	cd core && $(GOLANGCI)
	cd core && GOOS=js GOARCH=wasm $(GOLANGCI)
	npm run lint
	npm run typecheck

wasm:
	scripts/build-wasm.sh $(WASM_OUT)

build: wasm ## Static bundle in apps/web/dist (Go WASM + Vite)
	VITE_APP_VERSION=$(VERSION) npm run build

security: ## govulncheck, OSV-Scanner, Trivy fs, zizmor (tools must be on PATH)
	cd core && govulncheck ./...
	osv-scanner scan source --recursive .
	trivy fs --scanners vuln,secret,misconfig --severity HIGH,CRITICAL --exit-code 1 .
	zizmor --persona=regular .github/workflows

clean: ## Remove build outputs
	rm -rf apps/web/dist $(WASM_OUT)

# Declared by the spec command contract; owned by later phases.
test-e2e test-wasm: ## Not implemented yet (Phase 1/3)
	@echo "$@: not implemented until Phase 1 (see docs/requirements.md)" >&2; exit 2
sbom verify-dist: ## Not implemented yet (Phase 6)
	@echo "$@: not implemented until Phase 6 (see docs/requirements.md)" >&2; exit 2
