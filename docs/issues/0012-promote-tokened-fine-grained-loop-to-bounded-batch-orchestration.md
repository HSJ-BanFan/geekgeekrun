# Promote tokened fine-grained loop to bounded batch orchestration

Labels: `ready-for-agent`

## Parent

Local ADR: [Use Python Agents SDK as orchestration sidecar](../adr/0009-use-python-agents-sdk-as-orchestration-sidecar.md)

## What to build

Promote the tokened single-job sidecar loop into a bounded batch orchestration mode. The sidecar should control candidate iteration and stopping conditions, while every real application action remains gated by CLI-issued Application Authorization Tokens, CLI state validation, Job Identity Anchor checks, `--confirm`, audit records, and redacted trace metadata.

This slice is the point where the Python sidecar begins to take over fine-grained batch orchestration. It should preserve the existing application-decision semantics and avoid increasing automation intensity beyond configured limits.

## Acceptance criteria

- [ ] The sidecar can run a bounded batch using fine-grained tokened tools with configured target count, max candidates, and candidate timeout limits.
- [ ] Batch orchestration preserves existing Rule Boundary, LLM Apply Decision, Application Authorization, Job Identity Anchor, Job Match Guard, and audit behavior.
- [ ] Real actions require sidecar strategy approval where configured, CLI `--confirm`, and valid unconsumed tokens.
- [ ] The sidecar stops on login expiration, repeated token validation failures, browser relocation failures, configured limits, approval denial, or unrecoverable CLI errors.
- [ ] Progress, audit records, and redacted trace metadata can explain each applied, skipped, failed, or stopped candidate.
- [ ] Interrupted batches can be explained and safely stopped; continuing real actions after interruption requires fresh confirmation and CLI revalidation.
- [ ] Tests cover dry-run bounded batch, confirmed bounded batch with mocked real-action boundary, stop-on-limit, stop-on-login-expired, stop-on-token-failure, approval denial, and redaction of traces and audit-facing output.

## Blocked by

- Local issue 0007: Connect sidecar observability and recovery
- Local issue 0009: Add dual confirmation for supervised confirmed batches
- Local issue 0011: Run one tokened fine-grained application loop from sidecar
