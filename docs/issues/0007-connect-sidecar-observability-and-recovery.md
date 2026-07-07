# Connect sidecar observability and recovery

Labels: `ready-for-agent`

## Parent

Local ADR: [Use Python Agents SDK as orchestration sidecar](../adr/0009-use-python-agents-sdk-as-orchestration-sidecar.md)

## What to build

Extend the Python sidecar so a supervised run can connect Agents SDK trace metadata with the existing progress and audit records, then explain interrupted or failed runs without automatically continuing real application actions. The sidecar should make a run inspectable: what command ran, which job or batch position was current, which reason codes or failure categories occurred, and what recovery options are safe.

This slice should deliver observability and recovery explanation, not auto-resume. Continuing any real action after interruption remains out of scope until the CLI can revalidate authorization and Job Identity Anchors.

## Acceptance criteria

- [ ] A supervised run records redacted trace metadata such as tool name, `runId`, `jobId` when available, decision type, reason codes, durations, failure category, and retry or stop decisions.
- [ ] Traces do not include full job descriptions, full greetings, resume content, local paths, cookies, local storage, API keys, or other sensitive originals.
- [ ] The sidecar can read structured progress and audit records produced by the current CLI flow and correlate them with one supervised run.
- [ ] When a run is interrupted or fails, the sidecar can explain where it stopped, what completed, and why it failed using redacted evidence.
- [ ] Recovery output defaults to safe stop or rerun guidance and does not automatically continue confirmed application actions.
- [ ] Tests prove sensitive canary strings are absent from sidecar trace output and recovery summaries.
- [ ] Tests cover successful run correlation, failed subprocess correlation, missing progress or audit records, and interrupted-run explanation.

## Blocked by

- Local issue 0006: Supervise a dry-run batch from Python sidecar
