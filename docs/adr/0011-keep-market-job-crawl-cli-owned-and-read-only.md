# Keep market job crawl CLI-owned and read-only

---
status: accepted
---

Market job crawling will be exposed as a read-only Node CLI capability for bounded market sampling, not as an application action and not as direct browser control from the Python sidecar. The CLI owns BOSS search-page navigation, list scrolling, optional job-detail JD enrichment, artifact writing, status reason codes, and redaction rules; the sidecar may invoke the CLI and parse JSON, but must not directly inspect BOSS DOM, call BOSS APIs, or navigate BOSS pages.

The first supported source is keyword and city search results, not personalized recommendation feeds. Samples are bounded by a default limit of 200 jobs per keyword-city sample and a single-command maximum of 500 per sample, with a `--plan-only` mode for inspecting the expanded sample grid before any browser access.

Market Job Evidence may include contacted jobs so the sample remains faithful to the visible market, but market-demand analysis defaults to uncontacted jobs and reports actionable job counts separately from market supply. Market Job Evidence is Decision Evidence for market review only; it is not Application Authorization, does not issue or consume Application Authorization Tokens, and cannot authorize any future real application action.

Any platform-level risk signal such as login expiration, safety verification, abnormal environment response, or unconfirmed page state stops the command after writing a partial artifact. The crawler must not retry aggressively, skip past risk states, click application or chat controls, upload resumes, send messages, or bypass BOSS safeguards.

**Consequences**

This preserves ADR-0009's sidecar boundary and extends ADR-0010's read-only crawl pattern from historical applications to search-market sampling. The trade-off is that large market studies must be split into bounded, repeatable samples, and partial artifacts are expected when BOSS requires manual verification.
