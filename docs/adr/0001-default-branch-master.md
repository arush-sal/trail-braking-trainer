# 0001. Default branch is `master`

- Status: accepted
- Date: 2026-11-14
- Requirements: R-032

## Context
The spec (sections 10, 12) refers to `main`. The owner confirmed this is a typo.

## Decision
`master` is the default and protected branch. Release tags must point to tested
`master` commits. Wherever the spec says `main`, read `master`.

## Consequences
Workflows, Dependabot `target-branch`, and branch/tag protection use `master`.
