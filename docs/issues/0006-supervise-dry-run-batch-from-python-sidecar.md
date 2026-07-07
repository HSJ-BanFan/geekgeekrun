# Supervise a dry-run batch from Python sidecar

Labels: `ready-for-agent`

## Parent

Local ADR: [Use Python Agents SDK as orchestration sidecar](../adr/0009-use-python-agents-sdk-as-orchestration-sidecar.md)

## What to build

Introduce the first OpenAI Agents SDK for Python sidecar as a supervisory wrapper over the existing JSON-first Node CLI. The sidecar should invoke the current CLI through subprocess execution, parse stdout JSON through Pydantic schemas, and run a dry-run batch without changing existing application-decision semantics or browser action ownership.

This slice should prove the Python Agent Orchestrator can call the existing CLI safely. It should not replace `run-batch`, introduce a long-running RPC/MCP transport, perform confirmed application actions, or let Python directly operate browser state.

## Acceptance criteria

- [ ] A Python sidecar entry point can start a dry-run batch by invoking the Node CLI through subprocess execution.
- [ ] The sidecar parses CLI stdout JSON with Pydantic schemas and reports structured validation errors when parsing fails.
- [ ] CLI JSON contracts remain the source of truth; the Python sidecar does not introduce alternate field names for job, decision, or action concepts.
- [ ] The sidecar captures subprocess timeout, exit code, stdout parse failure, and stderr diagnostics as structured tool results.
- [ ] The sidecar can run without `--confirm` and cannot perform real external actions in this slice.
- [ ] Existing Node CLI behavior and tests continue to pass unchanged.
- [ ] Python-side tests cover successful CLI parsing, malformed JSON, non-zero exit, and timeout handling.

## Blocked by

None - can start immediately
