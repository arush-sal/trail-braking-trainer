# Trail Braking Trainer Project

## Rule

Record all session related details in ~/.obsidian/vaults/trail-braking-trainer under the respective project with proper backlinks, Making it a mesh knowledge graph.

While doing this:

    - Use Dataview to structure and query session data.
    - Use Excalidraw to capture diagrams, flows, or visual context when helpful.
    - Use Templater to apply consistent note structure across entries.

Ensure each engagement is documented in a way that supports later review, search, and cross linking inside the vault.

## Engineering execution rules

Source of truth: `trail-braking-trainer-implementation-plan.md` (spec) and
`docs/requirements.md` (ledger + status). Kickoff brief:
`CODEX_CLAUDE_KICKOFF.md`.

- Default branch is `master` (the spec's `main` is a typo; see ADR 0001).
- Work one phase at a time. Do not claim a later phase is implemented.
- TDD: failing test first. `make test` and `make lint` must pass before a
  phase is reported done.
- Orchestrator delegates bounded tasks to subagents, integrates, runs the full
  suite, and gets one peer review (Codex/Claude) per phase.
- Every PR/issue references requirement IDs (R-xxx) and acceptance criteria.
- Never mark hardware/browser/GT7 behavior as verified without evidence in
  `docs/validation-log.md`. Never fabricate a GT7 steering input.
- Do not modify `gt7-telemetry-collector`, publish, deploy, or create cloud
  resources without explicit owner authorization.
- Commits: authored by the owner, `git commit -s -S`.
- Keep toolchains/dependencies on latest versions; pin exact versions.
- Third-party GitHub Actions pinned by full commit SHA with version comment.
- Record decisions as ADRs in `docs/adr/`.
