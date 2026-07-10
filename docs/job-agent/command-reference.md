# Job Agent command reference

## Output contract

- Final command results use JSON on stdout by default.
- Download progress, interactive prompts, and manual guidance use stderr.
- Failures use a non-zero exit code and a stable `reasonCode` where the boundary is known.
- Default artifacts are under `%USERPROFILE%\.geekgeekrun-job-agent\artifacts`.
- Explicit absolute output paths are preserved. Explicit relative paths resolve from the caller's current working directory. Reported artifact paths are absolute.

## Product and diagnosis

| Command | Purpose |
| --- | --- |
| `ggr --version` | Report distribution and independent contract versions. |
| `ggr doctor` | Verify installation and sidecar integrity without requiring browser setup. |
| `ggr doctor --require-browser` | Also require browser configuration and known-ready BOSS session status. |
| `ggr update check` | Read official `job-agent-v*` release metadata without downloading or installing anything. |
| `ggr-sidecar version` | Direct sidecar compatibility diagnostic. |
| `ggr agent version` | Verify canonical `ggr` dispatch to the installed sidecar. |

## Browser setup

| Command | Purpose |
| --- | --- |
| `ggr setup` | Download and verify the pinned managed browser, preserve the profile, then guide manual login. |
| `ggr setup --offline-archive <zip>` | Import the exact supported archive after version/checksum verification. |
| `ggr setup --system-browser <exe>` | Use an explicitly selected supported system browser. |
| `ggr setup login` | Open the configured browser visibly and refresh non-sensitive session readiness. |
| `ggr setup repair [browser option]` | Restore browser binaries/metadata without deleting the profile. |
| `ggr setup reset-profile --confirm` | Destructively remove the isolated browser profile and session status. |

`--skip-login` is intended for deterministic provisioning gates and advanced staged setup. It leaves BOSS session status not ready.

## Configuration and credentials

| Command | Purpose |
| --- | --- |
| `ggr config path` | Report the isolated configuration paths. |
| `ggr config init` | Idempotently create `operator.json`, `boss.json`, and `llm.json`. |
| `ggr config validate` | Validate configuration shape and return next actions. |
| `ggr config import-desktop --desktop-config-root <dir>` | Explicitly import configuration only. Browser sessions, tokens, mutable storage, and LLM secret values are excluded. |
| `ggr config secret set --name <name>` | Read a secret through a hidden interactive prompt and store it in Windows Credential Manager. |
| `ggr config secret status --name <name>` | Report whether the credential exists without revealing it. |
| `ggr config secret delete --name <name>` | Delete the current-user credential and its reference. |

Secret values are never accepted through `--value`, `--secret`, or `--api-key`. An LLM entry in `llm.json` can select a stored credential with `"credentialName": "openai"`; ordinary JSON stores only the reference.

## Read-only evidence

```text
ggr market-jobs --plan-only --keyword <value> --city <name-or-code> [--limit 200] [--analyze]
ggr market-jobs --from-browser --keyword <value> --city <name-or-code> [--limit 200] [--include-jd] [--analyze]
ggr recent-applications --from-browser [--limit 100] [--include-jd] [--analyze]
```

Repeat `--keyword` and `--city` to build a Cartesian sampling plan. Use `--output` and `--analysis-output` to control artifact paths.

## Existing Node command surface

The installed distribution exposes the same evaluation, greeting, authorization, controlled-action, run-once, and run-batch surface as source development:

```text
ggr snapshot
ggr capability-profile [--refresh]
ggr extract-job --job <file>
ggr extract-job --from-browser [--recall-keyword <value>] [--city <code>]
ggr evaluate-job --job <file> [--llm]
ggr greeting-preview --job <file>
ggr audit-log [--event <file>]
ggr authorization-token issue|inspect|consume ...
ggr authorized-action ...
ggr run-once ...
ggr run-batch --from-browser ...
```

Real actions remain fail-closed behind Application Authorization, token validation/consumption, Job Identity Anchor relocation, Job Match Guard verification, explicit confirmation, and redacted audit boundaries.

## Agent Orchestrator

`ggr agent <sidecar-command>` is the normal installed entry. `ggr-sidecar <sidecar-command>` remains available for compatibility and diagnostics. Development-only `--repo-root` and `--node` overrides are rejected in installed mode.

## Explicit CDP attachment

Loopback HTTP and WebSocket endpoints are accepted:

```powershell
ggr market-jobs --from-browser ... --browser-url http://127.0.0.1:9222
```

Remote endpoints are rejected by default. Advanced operators may add `--allow-remote-cdp`; the result reports `remote-high-risk`. URLs containing credentials are rejected, and remote CDP is not part of getting started.
