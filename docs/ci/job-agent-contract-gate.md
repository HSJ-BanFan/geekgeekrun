# Job-Agent Contract Gate

The Job-Agent Contract Gate is implemented by `.github/workflows/job-agent-contract-gate.yml`.
It is a deterministic CI gate for the Node job-agent CLI, the Python sidecar, and their JSON-first integration boundary.

## Required Checks

Configure repository branch protection or a GitHub branch ruleset to require these status checks:

- `job-agent-cli`
- `job-agent-sidecar`
- `job-agent-distribution-windows`

Recommended GitHub setup:

1. Open the repository settings.
2. Create or edit the branch ruleset for `main`.
3. Enable required status checks and add `job-agent-cli`, `job-agent-sidecar`, and `job-agent-distribution-windows`.
4. Enable pull request requirements or restrict direct pushes if direct updates to `main` should not bypass pre-merge checks.

The workflow still runs on pushes to `main` as a backstop. Required checks are what make the workflow a merge gate.

## Scope

The gate covers deterministic contract and safety checks only:

- `@geekgeekrun/job-agent-cli` syntax checks and tests on Node `20.16.0` with the pnpm version pinned by the root `packageManager` field.
- `packages/job-agent-sidecar` tests on Python `3.11`.
- A Windows x64 portable build and per-user installer with controlled Node `20.16.0` and a frozen Python `3.11` sidecar.
- A separate installed-product job that downloads the built installer and a build-job-verified pinned browser archive without setting up Node, Python, pnpm, or pip; constrains `PATH` to the installation plus System32; verifies those external toolchains are absent; and exercises manifest integrity, plan-only JSON, sidecar dispatch, offline browser import from the local fixture, controlled Market/Recent browser captures, authorization dry-run safety, and privacy-first uninstall through public launchers.
- Relevant workspace dependencies that can affect the CLI contract.

The gate intentionally excludes live BOSS login state, live BOSS network access, real external application actions, UI release builds, and operator-only workflows. Browser command coverage uses locally intercepted fixture pages and performs read-only navigation only.
