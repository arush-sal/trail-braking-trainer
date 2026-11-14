# 0004. Toolchain pins and security overrides

- Status: accepted
- Date: 2026-11-14
- Requirements: R-030, R-031

## Context
Owner rule: always latest toolchains and dependencies. Initial scans found
GO-2026-6859 (stdlib `net/http`, fixed in Go 1.27.4) and GHSA-g3hv-75wg-m249
(`minimatch` 10.2.6 via eslint/typescript-eslint, fixed in 11.0.1).
typescript-eslint 8.72.2 (latest) supports TypeScript `<6.1`, but TypeScript
7.0.2 is latest.

## Decision
- `core/go.mod`: `go 1.27.4`. Node `26.13.1` (LTS) in `.node-version`.
- Root `package.json` `overrides.minimatch = 11.0.1`.
- `apps/web` depends on TypeScript 7.0.2 (`tsc` typecheck). The root pins
  TypeScript 6.0.3 for typescript-eslint's peer range (`<6.1`), so lint
  parses with TS 6 (2026-11-14: replaced the former `typescript7` npm alias,
  Dependabot PR #1).

## Consequences
- Drop the root TypeScript 6 pin and the minimatch override once upstream
  typescript-eslint/eslint support them (Dependabot will surface updates).
- Lint parses with TS 6 semantics; typecheck enforces TS 7.
- npm deps pinned exactly (`.npmrc` `save-exact=true`); `engines.npm` =
  npm bundled with the pinned Node, enforced by `engine-strict=true`.
