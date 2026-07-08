# Keep recent application JD crawl CLI-owned and read-only

---
status: accepted
---

Recent BOSS application history and its corresponding JD crawl will be exposed as a read-only Node CLI capability, not as direct browser control from the Python sidecar or as an application action.

The CLI owns the browser session, BOSS page navigation, runtime-state extraction, job-detail DOM extraction, artifact writing, status reason codes, and redaction rules. The Python sidecar may invoke the CLI and parse its JSON stdout, but it must not directly inspect BOSS DOM, call BOSS job-detail APIs, navigate BOSS pages, or keep a parallel browser model.

The historical crawl output is Decision Evidence for preference review and future planning. It is not Application Authorization, does not issue or consume Application Authorization Tokens, and cannot authorize any future real application action. Any later real action must still pass Rule Boundary, LLM Apply Decision, Application Authorization, Job Identity Anchor, Job Match Guard, CLI `--confirm`, and audit behavior.

The primary JD enrichment strategy is normal read-only job-detail page navigation followed by DOM extraction of the "job description" section. Direct BOSS detail API requests may be used only as a guarded optimization or diagnostic path because repeated API calls can trigger platform safety responses. Safety verification, login expiration, missing chat runtime state, or unconfirmed detail pages must stop or partially complete the crawl with stable reason codes rather than retry aggressively or bypass platform safeguards.

Default artifacts must be inspectable and redacted. They may contain job titles, company names, city, position category, recruiter summary, last-message summary, JD text, capture metadata, status summaries, and preference-analysis output. They must not contain cookies, local storage, full browser state, API keys, resume image paths, or raw browser access parameters such as full `securityId` unless an explicit unsafe debug mode is added later.

**Consequences**

This keeps ADR-0009 intact: the Python Agents SDK sidecar remains an Agent Orchestrator over stable CLI contracts instead of becoming a browser bot. It also keeps the boundary between historical evidence and real action authorization explicit, so a preference precheck cannot silently become an auto-apply mechanism.

The CLI implementation needs a reusable read-only extraction module and tests around fake pages or fixture HTML. Live BOSS crawling remains an operator workflow, not a CI dependency.

The trade-off is that the CLI must handle BOSS page drift and safety-verification states itself. That is preferable to duplicating browser-control logic in the sidecar or relying on brittle direct API fetches.
