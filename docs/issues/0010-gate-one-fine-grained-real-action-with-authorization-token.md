# Gate one fine-grained real action with authorization token

Labels: `ready-for-agent`

## Parent

Local ADR: [Use Python Agents SDK as orchestration sidecar](../adr/0009-use-python-agents-sdk-as-orchestration-sidecar.md)

## What to build

Require an Application Authorization Token for one fine-grained real action tool, starting with the narrowest action that proves the model. The CLI should accept an action intent plus token, validate that the token is current and unconsumed, verify the current browser target against the Job Identity Anchor, enforce `--confirm`, execute only the authorized action, consume or update token state, and write audit evidence.

This slice should prove the CLI-owned state machine for one real action. It should not yet implement a full fine-grained application loop.

## Acceptance criteria

- [ ] The selected fine-grained real action cannot run without both `--confirm` and a valid Application Authorization Token.
- [ ] The CLI rejects missing, expired, consumed, mismatched, or unauthorized-action tokens with stable reason codes.
- [ ] The CLI verifies the current browser target against the token's Job Identity Anchor before performing the action.
- [ ] A successful action consumes or updates token state so the same action cannot be repeated accidentally.
- [ ] Action outcomes are written to audit records without storing sensitive originals.
- [ ] Dry-run mode reports planned validation and action intent without changing browser state or consuming the token.
- [ ] Tests cover valid token execution, missing token, expired token, consumed token, job mismatch, action mismatch, dry-run behavior, and audit redaction.

## Blocked by

- Local issue 0008: Issue persistent redacted Application Authorization Tokens
