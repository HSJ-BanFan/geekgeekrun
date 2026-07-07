# Add dual confirmation for supervised confirmed batches

Labels: `ready-for-agent`

## Parent

Local ADR: [Use Python Agents SDK as orchestration sidecar](../adr/0009-use-python-agents-sdk-as-orchestration-sidecar.md)

## What to build

Allow the Python sidecar to supervise a confirmed batch only when both confirmation layers are satisfied: Agents SDK human-in-the-loop approval as the strategy gate, and CLI `--confirm` as the non-bypassable execution gate. The sidecar should request approval for high-risk or real-action runs, then call the existing CLI confirmed path without weakening CLI ownership of browser actions or Application Authorization.

This slice should prove the confirmation model. It should not introduce fine-grained tokened action tools yet.

## Acceptance criteria

- [ ] A supervised confirmed batch requires explicit sidecar approval before any CLI command is invoked with `--confirm`.
- [ ] CLI `--confirm` remains required for real external actions; sidecar approval alone cannot perform a real action.
- [ ] Approval prompts use redacted run metadata and do not show full JD, full greeting, resume content, local paths, cookies, local storage, API keys, or other sensitive originals.
- [ ] The sidecar records approval, denial, timeout, and cancellation outcomes as redacted trace metadata.
- [ ] If approval is denied or missing, the sidecar does not call confirmed CLI commands and returns a structured stop result.
- [ ] Existing dry-run supervision remains available without human approval for real actions.
- [ ] Tests cover approved confirmed run, denied approval, approval timeout, and proof that `--confirm` is not emitted without approval.

## Blocked by

- Local issue 0006: Supervise a dry-run batch from Python sidecar
- Local issue 0007: Connect sidecar observability and recovery
