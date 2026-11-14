SHELL := /usr/bin/env bash
.SHELLFLAGS := -euo pipefail -c
.DEFAULT_GOAL := help

VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
export VERSION
GOLANGCI := golangci-lint run --config ../.golangci.yml ./...
WASM_OUT := apps/web/public/wasm
# chromium | firefox | webkit (CI runs each)
E2E_PROJECT ?= chromium
RELEASE_DIR := dist-release
REL_VERSION = $(patsubst v%,%,$(VERSION))
REL_NAME = trail-braking-trainer_$(REL_VERSION)
SYFT_SKIP := $(foreach d,.git .worktrees node_modules **/node_modules apps/web/dist apps/web/dist-e2e \
	$(RELEASE_DIR) test-results playwright-report,--exclude './$(d)')
export SYFT_CHECK_FOR_APP_UPDATE := false

.PHONY: help setup dev test lint build security clean \
	test-e2e test-wasm perf sbom verify-dist package test-release test-dist scan-dist

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
	scripts/test-release.sh

test-release: ## Packaging/verification script assertions (reproducible tarball, failure paths)
	scripts/test-release.sh

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
	rm -rf apps/web/dist apps/web/dist-e2e $(WASM_OUT) $(RELEASE_DIR)

test-wasm: wasm ## Shared frame fixtures + TS mock frames through the built core.wasm (Node)
	npm run test:wasm -w apps/web

test-e2e: build ## Playwright tests against an e2e-mode bundle (E2E_PROJECT, default Chromium); checks prod has no test hooks
	@if grep -rq __tbtTest apps/web/dist; then echo "production bundle contains test hooks" >&2; exit 1; fi
	VITE_APP_VERSION=$(VERSION) npm run build -w apps/web -- --mode e2e --outDir dist-e2e
	npx playwright test --project=$(E2E_PROJECT)

sbom: ## Syft SPDX JSON in dist-release/: source (all npm incl. dev, Go, Actions) + web bundle (prod npm, Go)
	mkdir -p $(RELEASE_DIR)
	SYFT_JAVASCRIPT_INCLUDE_DEV_DEPENDENCIES=true syft scan dir:. -q $(SYFT_SKIP) \
		--source-name trail-braking-trainer --source-version $(REL_VERSION) \
		-o spdx-json=$(RELEASE_DIR)/$(REL_NAME)_source.spdx.json
	syft scan dir:. -q $(SYFT_SKIP) --select-catalogers -github \
		--source-name trail-braking-trainer-web --source-version $(REL_VERSION) \
		-o spdx-json=$(RELEASE_DIR)/$(REL_NAME)_web.spdx.json
	@for f in $(RELEASE_DIR)/$(REL_NAME)_{source,web}.spdx.json; do \
		jq -e '[.packages[].externalRefs[]?.referenceLocator] | (any(startswith("pkg:golang/github.com/arush-sal/trail-braking-trainer/core")) and any(startswith("pkg:npm/react@")))' $$f >/dev/null \
			|| { echo "$$f lacks Go core or npm components" >&2; exit 1; }; done

package: sbom ## Reproducible release tarball + checksums.txt from apps/web/dist (run make build first)
	scripts/package-release.sh $(REL_VERSION) $(RELEASE_DIR)

verify-dist: ## Recheck checksums.txt and every bundle file against build-manifest.json
	scripts/verify-release.sh --local $(REL_VERSION) $(RELEASE_DIR)

test-dist: ## Hook-free Playwright gates (smoke, csp, version, recovery) on the PRODUCTION apps/web/dist, no rebuild
	@[ -f apps/web/dist/index.html ] || { echo "no apps/web/dist (run make build)" >&2; exit 1; }
	@if grep -rq __tbtTest apps/web/dist; then echo "production bundle contains test hooks" >&2; exit 1; fi
	E2E_DIST=dist npx playwright test --project=$(E2E_PROJECT) --grep-invert @hooks \
		smoke.spec csp.spec version.spec recovery.spec

scan-dist: ## Blocking Trivy (vuln+secret, HIGH/CRITICAL) on the packaged bundle's contents and the web SBOM
	d="$$(mktemp -d)"; trap 'rm -rf "$$d"' EXIT; \
	tar -xzf $(RELEASE_DIR)/$(REL_NAME)_web.tar.gz -C "$$d" --no-same-owner; \
	trivy fs --scanners vuln,secret --severity HIGH,CRITICAL --exit-code 1 "$$d"
	trivy sbom --severity HIGH,CRITICAL --exit-code 1 $(RELEASE_DIR)/$(REL_NAME)_web.spdx.json

perf: build ## Performance measurements (headless Chromium) -> test-results/perf.json; soft budget check
	VITE_APP_VERSION=$(VERSION) npm run build -w apps/web -- --mode e2e --outDir dist-e2e
	npx playwright test --project=perf
