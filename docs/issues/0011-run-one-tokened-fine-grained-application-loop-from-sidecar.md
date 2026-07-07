# Run one tokened fine-grained application loop from sidecar

Labels: `ready-for-agent`

## Parent

Local ADR: [Use Python Agents SDK as orchestration sidecar](../adr/0009-use-python-agents-sdk-as-orchestration-sidecar.md)

## What to build

Let the Python sidecar run one end-to-end fine-grained application loop by submitting action intents to token-gated CLI tools. The sidecar may sequence extraction, evaluation, authorization-token inspection, and one or more authorized action intents, but the CLI must continue to own Application Authorization, token validation, Job Identity Anchor checks, dry-run/confirm behavior, and audit writes.

This slice should be a single-job tracer bullet for tokened orchestration. It should not yet promote the sidecar to multi-job batch ownership.

## Acceptance criteria

- [ ] The sidecar can run a single-job dry-run loop using fine-grained CLI tools and validated JSON schemas.
- [ ] In confirmed mode, the sidecar requires strategy approval and the CLI still requires `--confirm` plus valid tokens for real actions.
- [ ] The sidecar passes Application Authorization Tokens to action tools rather than relying on prompt memory or copied job fields.
- [ ] The CLI rejects out-of-order or unauthorized action intents through its state machine.
- [ ] The sidecar records redacted trace metadata for each tool call and correlates it with audit records.
- [ ] Failure at any action step stops the loop safely and reports structured recovery guidance without blind continuation.
- [ ] Tests cover successful dry-run loop, successful confirmed loop with mocked CLI/browser boundary, rejected token/action order, subprocess failure, schema validation failure, and safe-stop recovery.

## Blocked by

- Local issue 0006: Supervise a dry-run batch from Python sidecar
- Local issue 0008: Issue persistent redacted Application Authorization Tokens
- Local issue 0010: Gate one fine-grained real action with authorization token
