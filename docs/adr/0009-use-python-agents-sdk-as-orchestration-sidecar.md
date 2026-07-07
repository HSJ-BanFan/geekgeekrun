# Use Python Agents SDK as orchestration sidecar

---
status: accepted
---

The job-seeker agent will use OpenAI Agents SDK for Python as an outer orchestration sidecar over the existing JSON-first Node CLI, rather than replacing the Node CLI or letting the Python runtime directly operate the browser. This keeps browser automation, profile handling, Job Identity Anchor checks, dry-run/confirm boundaries, and audit behavior inside the proven CLI action layer while adding an agent runtime for tools, guardrails, sessions, tracing, handoffs, and human-in-the-loop control.

**Considered Options**

- Keep the current Node CLI loop without an Agents SDK runtime.
- Use OpenAI Agents SDK for JavaScript/TypeScript inside the existing pnpm workspace.
- Use OpenAI Agents SDK for Python as a sidecar that invokes CLI tools.

**Consequences**

The Python sidecar may call only stable CLI contracts and must treat CLI JSON output as the integration boundary. The Node CLI remains the sole owner of external browser actions, local BOSS session state, and Application Authorization; the sidecar may choose candidates, call tools, stop, retry, or request human confirmation, but it must not independently grant permission to perform real application actions. Choosing Python avoids forcing the current Node 20/Electron workspace onto the JavaScript Agents SDK runtime requirement immediately, but it introduces a second runtime that must be kept thin and contract-driven.

The sidecar may use fine-grained CLI tools instead of only coarse `run-once` or `run-batch` commands, but fine-grained tools are not permissionless browser primitives. Any real action tool must require a current Application Authorization and must preserve the same Job Identity Anchor, Job Match Guard, dry-run/confirm, and audit boundaries as the coarse CLI flow.

The CLI owns the application-action state machine. The Python sidecar submits action intent, but the CLI must validate whether an Application Authorization exists, whether the authorized job is still anchored by the same `jobId`, whether the requested action has already been consumed, and whether the current failure state allows any next action.

Fine-grained action tools must pass an Application Authorization Token issued by the CLI, not rely on the Python sidecar remembering a previous evaluation result. The token binds `runId`, `jobId`, authorized action set, decision evidence summary, expiration, and consumption state; the CLI validates the token against the current browser target before any real external action.

Application Authorization Tokens are persisted for recovery and audit, but they remain short-lived and consumable. Persistent token records must be redacted: they may store non-secret authorization metadata and summarized Decision Evidence, but must not store full job descriptions, full greetings, resume image paths, cookies, local storage, API keys, or other sensitive originals.

The first sidecar integration calls the Node CLI through subprocess execution and parses stdout JSON. It does not introduce a long-running local RPC service or MCP server until the CLI contracts, timeout behavior, and tool schema have proven stable enough to justify a persistent transport.

Node CLI JSON contracts are the source of truth for tool inputs and outputs. The Python sidecar uses Pydantic schemas to validate CLI inputs and stdout JSON, but it must not invent parallel field names or a separate job-application domain model; tests should cover CLI output parsing through the Python schemas.

Human confirmation exists at two layers with different meanings. CLI `--confirm` is the non-bypassable execution gate for any real external action, while Agents SDK human-in-the-loop approval is a strategy gate for high-risk decisions, uncertainty, exception recovery, or batch-control moments; sidecar approval can permit a confirmed CLI call, but it cannot replace the CLI confirmation gate.

The first Python sidecar is supervisory rather than a replacement for `run-batch`. It may inspect configuration and login state, invoke existing coarse CLI flows, read progress and audit records, and request human confirmation around failures or limits; it should take over the fine-grained application loop only after authorization tokens, CLI-owned state validation, and schema tests are stable.

The first success criterion is orchestration observability and control, not increased automation intensity. A successful MVP can start a controlled batch through existing CLI flows, read structured progress, detect login expiration, failures, and configured limits, request human approval when needed, and connect one run's trace with its audit records without changing the existing application-decision semantics.

Agents SDK tracing is enabled only with redacted orchestration metadata. Traces may include tool names, `runId`, `jobId`, decision type, reason codes, durations, failure categories, retry decisions, and human approval outcomes, but must not include full job descriptions, full greetings, resume content, local paths, cookies, local storage, API keys, or other sensitive originals.

Interrupted runs are resumable for explanation and safe shutdown before they are resumable for continued application actions. The sidecar may read progress, audit, and token state to explain where a run stopped, which tokens were consumed, and why it failed, but continuing any real action after interruption requires a fresh confirmation path and CLI revalidation of the Job Identity Anchor.
