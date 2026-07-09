# Job-Agent Contract Gate

The Job-Agent Contract Gate is implemented by `.github/workflows/job-agent-contract-gate.yml`.
It is a deterministic CI gate for the Node job-agent CLI, the Python sidecar, and their JSON-first integration boundary.

## Required Checks

Configure repository branch protection or a GitHub branch ruleset to require these status checks:

- `job-agent-cli`
- `job-agent-sidecar`

Recommended GitHub setup:

1. Open the repository settings.
2. Create or edit the branch ruleset for `main`.
3. Enable required status checks and add `job-agent-cli` and `job-agent-sidecar`.
4. Enable pull request requirements or restrict direct pushes if direct updates to `main` should not bypass pre-merge checks.

The workflow still runs on pushes to `main` as a backstop. Required checks are what make the workflow a merge gate.

## Scope

The gate covers deterministic contract and safety checks only:

- `@geekgeekrun/job-agent-cli` syntax checks and tests on Node `20.16.0` with pnpm `8.15.9`.
- `packages/job-agent-sidecar` tests on Python `3.11`.
- Relevant workspace dependencies that can affect the CLI contract.

The gate intentionally excludes live BOSS login state, real browser actions, UI release builds, and operator-only workflows.
