# Add deterministic job-agent contract gate

---
status: accepted
---

GeekGeekRun will add a deterministic Job-Agent Contract Gate for changes that can affect the JSON-first Node CLI, the Python sidecar, or their integration boundary. The gate runs on pull requests and on pushes to the main branch, scoped by paths to job-agent code, workspace packages that can affect the CLI contract, dependency manifests, workflow files, and related contract documentation.

The gate is intentionally not a live BOSS smoke test, real browser-action test, UI release build, or operator workflow. It protects the contract and safety boundaries that can be tested without account state: Node CLI syntax checks and tests, plus Python sidecar tests that validate sidecar behavior against the CLI contract.

**Consequences**

The gate uses the project-declared baseline runtimes rather than local developer versions: Node `20.16.0` with the exact pnpm version declared by the root `packageManager` field, and Python `3.11` for the sidecar job. CLI and sidecar checks run as separate jobs because they have different runtimes and dependency installation paths, and because separate failures make contract regressions easier to diagnose. The original pnpm `8.15.9` baseline was superseded when the root workspace pin moved to pnpm 10; the manifest pin is now the single source of truth.

The CLI job installs the pnpm workspace with the frozen lockfile before running the `@geekgeekrun/job-agent-cli` check and test scripts. The sidecar job installs `packages/job-agent-sidecar` with its `test` extra and runs `pytest`; the Python dependency set remains governed by `pyproject.toml` until dependency drift justifies introducing a Python lockfile.

The GitHub workflow is necessary but not sufficient as a gate. Repository branch protection or a GitHub Ruleset must require stable status check names before the gate can block merges or protected-branch pushes. The workflow is named `Job-Agent Contract Gate`, the workflow file is `.github/workflows/job-agent-contract-gate.yml`, and ADR-0014 extends the required checks with the isolated installed-product Windows gate in addition to `job-agent-cli` and `job-agent-sidecar`.
