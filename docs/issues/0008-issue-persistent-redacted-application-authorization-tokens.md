# Issue persistent redacted Application Authorization Tokens

Labels: `ready-for-agent`

## Parent

Local ADR: [Use Python Agents SDK as orchestration sidecar](../adr/0009-use-python-agents-sdk-as-orchestration-sidecar.md)

## What to build

Add CLI support for issuing an Application Authorization Token after a job receives Application Authorization. The token should be a short-lived, consumable authorization artifact that binds a specific `runId`, Job Identity Anchor, allowed action set, summarized Decision Evidence, expiration, and consumption state.

This slice should make tokens issueable, persistable, inspectable, and redacted. It should not yet require action tools to consume tokens or let the Python sidecar run a fine-grained application loop.

## Acceptance criteria

- [ ] After a valid Application Authorization, the CLI can issue an Application Authorization Token bound to `runId`, `jobId`, allowed actions, expiration, and initial consumption state.
- [ ] No token is issued for skip, uncertain, malformed, incomplete, or rule-denied decisions.
- [ ] Token records are persisted for recovery and audit.
- [ ] Persistent token records contain only non-secret authorization metadata and summarized Decision Evidence.
- [ ] Token records do not contain full job descriptions, full greetings, resume image paths, cookies, local storage, API keys, local filesystem paths, or other sensitive originals.
- [ ] The CLI can report whether a token is valid, expired, consumed, or unusable with stable reason codes.
- [ ] Tests cover token issuance, no-token denied paths, expiration, consumption state, redaction, and audit-safe inspection.

## Blocked by

None - can start immediately
