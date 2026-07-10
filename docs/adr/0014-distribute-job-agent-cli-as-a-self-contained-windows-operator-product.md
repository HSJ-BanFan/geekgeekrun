# Distribute Job Agent CLI as a self-contained Windows operator product

---
status: accepted
---

GeekGeekRun will distribute the Job Agent CLI as a separate, self-contained product for an Agent Operator rather than as a repository-only tool or a dependency of the desktop app. The first supported target is Windows x64, delivered through one per-user installer that provides the canonical `ggr` entry point and the compatible `ggr-sidecar` entry point without requiring a repository checkout, Node, Python, pnpm, pip, or `PYTHONPATH`.

The installer will carry controlled Node and frozen Python runtimes. `ggr` will be the normal user-facing command and will dispatch agent subcommands to the sidecar without exposing the runtime split. Both runtimes will resolve trusted internal paths through an installation manifest rather than a repository root or an arbitrary executable found on `PATH`. The sidecar distribution will include only dependencies used by its current command surface; the optional OpenAI Agents SDK will not be bundled until a tested user command requires it.

The CLI will own an isolated per-user runtime home instead of silently sharing mutable desktop-app state. `ggr setup` will download and verify a pinned managed browser, or import a matching offline browser archive, create a dedicated browser profile, and require the user to complete BOSS login manually in a visible browser. Setup is idempotent: repair cannot silently reset the browser profile, and clearing a login session requires an explicit destructive command and confirmation. Desktop configuration may be imported explicitly, but browser sessions, authorization tokens, and mutable storage are not shared by default. LLM secrets will use the current Windows user's credential store rather than plaintext command arguments or ordinary configuration JSON.

Browser commands will lock the managed profile and fail safely when another process owns it; offline planning and artifact analysis remain concurrent. Explicit CDP connection remains available for advanced use, but the default accepts only loopback endpoints. Connecting to a remote browser requires an explicit high-risk option and is not part of the getting-started path.

CLI stdout remains JSON-first. Setup progress and interactive guidance go to stderr, while final results, diagnostics, artifact paths, reason codes, and next actions remain structured JSON. Default artifacts are written under the Job Agent runtime home; explicit relative output paths remain relative to the caller's working directory. Installation does not grant Application Authorization, and all existing confirmation, token, Job Identity Anchor, Job Match Guard, and audit boundaries continue to apply.

Job Agent releases use an independent `job-agent-v*` version line. The first unsigned builds may be published only as `0.x` prereleases produced from immutable tags in GitHub Actions with checksums, provenance, an integrity-verifiable install manifest, and a clean Windows VM release gate. The deterministic gate covers installation, PATH, versions, integrity, JSON contracts, sidecar isolation, artifact paths, and uninstall behavior; browser download, manual BOSS login, and one bounded read-only crawl remain a recorded human release acceptance because CI must not store BOSS credentials. Stable releases require Authenticode signing. Updates are explicit rather than automatic, and uninstall removes sensitive browser-session and token state by default while preserving configuration and redacted artifacts unless the user requests complete deletion.

**Considered Options**

- Keep requiring a pnpm workspace checkout and an editable or `PYTHONPATH`-based Python environment.
- Publish independent npm and Python installation instructions and make the operator integrate them.
- Bundle the sidecar into the existing desktop application installer.
- Ship one independent Agent Operator distribution containing both controlled runtimes.

**Consequences**

The distribution is larger and requires a dedicated Windows build, installer, browser bootstrap, integrity checks, and release acceptance workflow. In return, the documented command contract matches the installed product, the Python sidecar no longer depends on repository layout, ordinary desktop users do not inherit sidecar complexity, and Agent Operators receive one reproducible installation and usage path.
