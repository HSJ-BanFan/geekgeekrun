# Package recent BOSS applications with JD crawl as a CLI command

Labels: `ready-for-agent`

## Parent

Local PRD: [Package recent BOSS applications with JD crawl as a CLI command](../prd/package-applied-job-jd-crawl-as-cli.md)

Related ADRs:

- [Use Python Agents SDK as orchestration sidecar](../adr/0009-use-python-agents-sdk-as-orchestration-sidecar.md)
- [Keep recent application JD crawl CLI-owned and read-only](../adr/0010-keep-recent-application-jd-crawl-cli-owned-and-read-only.md)

## What to build

Package the proven read-only “recent BOSS applications + JD” crawler into the `ggr` CLI.

The CLI should fetch the latest N BOSS chat/application records from the logged-in browser session, enrich them with JD text from the corresponding BOSS job detail page, write a raw storage artifact, optionally write a deterministic preference analysis artifact, and print a stable JSON summary to stdout.

The feature is read-only. It must not send messages, start or continue chats, upload resumes, issue Application Authorization, consume Application Authorization Tokens, or perform any other real application action.

Suggested command shape:

```text
ggr recent-applications --from-browser --limit 100 --include-jd --analyze
```

## Key implementation notes

- Use the BOSS chat page runtime state, especially `chatStore.friendInfos`, as the primary source for recent application/conversation records.
- Sort records by `lastTS`, `updateTime`, or equivalent recent-message timestamp descending.
- Normalize each record into a stable schema containing rank, job/company/recruiter fields, city, position category, last-message fields, and Job Identity Anchor evidence.
- Prefer job detail DOM extraction for JD: navigate the normal `job_detail` page and extract the “职位描述” section text.
- Treat the BOSS detail API as optional or guarded only. The tracer bullet showed that repeated direct API fetches can trigger `code:37` / `code:36` safety responses.
- Stop safely on BOSS safety verification, login expiration, missing chat store, or unconfirmed detail page state. Write partial output and report stable reason codes.
- Store artifacts incrementally in the existing storage directory.
- Default artifacts must not include cookies, local storage, full browser state, resume paths, API keys, or raw `securityId`.
- The Python sidecar may call this command and parse stdout JSON, but must not directly operate the browser.

## Acceptance criteria

- [ ] `ggr recent-applications --from-browser --limit 100 --include-jd` returns JSON with `ok`, command name, record count, JD status summary, and raw artifact path.
- [ ] The command can crawl recent records from `chatStore.friendInfos` in timestamp order.
- [ ] The command can enrich records with JD text from BOSS job detail DOM.
- [ ] The command writes a raw artifact with schema version, capture metadata, source strategy, status summary, and records.
- [ ] `--analyze` writes a deterministic preference analysis artifact and includes its path in stdout JSON.
- [ ] Preference analysis reports title category counts, JD term counts, top cities, top position categories, core target examples, mixed/noisy examples, likely noise examples, and recruiter-last-message examples.
- [ ] The command performs no real application actions: no start chat, no continue chat, no send message, no image upload, no resume delivery.
- [ ] The command does not issue, consume, or require Application Authorization Tokens.
- [ ] BOSS safety verification stops the crawl with a stable reason code and partial artifact instead of retrying aggressively.
- [ ] Login expiration and missing chat store fail closed with stable reason codes.
- [ ] Default artifacts omit or redact raw `securityId`, cookies, local storage, full browser state, resume paths, and API keys.
- [ ] CLI tests cover successful list extraction, successful JD DOM extraction, analysis output, partial blocked output, missing login/chat-store failure, `--limit`, and artifact redaction.
- [ ] Browser extraction tests use fake pages or fixture HTML rather than live BOSS.
- [ ] Sidecar integration, if added in this slice, consumes only the CLI JSON contract.

## Out of scope

- Sending or continuing recruiter messages.
- Applying to jobs or uploading resumes.
- Bypassing BOSS safety verification or captcha.
- Letting historical crawl output authorize future real actions.
- Python sidecar direct browser control.
- Replacing Rule Boundary, LLM Apply Decision, Application Authorization, Job Identity Anchor, or Job Match Guard behavior.
