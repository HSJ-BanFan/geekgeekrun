# Add optional sequential JD enrichment from detail DOM

Labels: `ready-for-agent`

## Parent

Local PRD: [Add read-only market job crawl as a CLI command](../prd/read-only-market-jobs-crawl-cli.md)

Related ADR:

- [Keep market job crawl CLI-owned and read-only](../adr/0011-keep-market-job-crawl-cli-owned-and-read-only.md)

## What to build

Add optional `--include-jd` enrichment for `market-jobs` by sequentially navigating normal BOSS job detail pages and extracting the JD from the DOM.

JD enrichment must remain read-only, single-page, non-concurrent, and subordinate to the same platform-risk stopping behavior as list sampling.

## Acceptance criteria

- [ ] Without `--include-jd`, the command does not navigate to job detail pages for JD enrichment and records JD as not requested.
- [ ] With `--include-jd`, the command sequentially navigates detail pages using captured job identity/detail URL evidence and extracts full JD text from DOM.
- [ ] Successful JD enrichment stores JD status, source, text, character count, resolved redacted URL, and non-secret page evidence when available.
- [ ] JD enrichment does not call BOSS `/wapi/.../job/detail.json` as an MVP fast path and does not run concurrently.
- [ ] JD enrichment never clicks chat/application controls, sends messages, uploads resumes, or uses authorization tokens.
- [ ] Platform risk during JD enrichment stops the whole command and preserves a partial artifact with completed list and JD work.
- [ ] Tests cover no-JD default behavior, successful DOM JD extraction, and blocked JD enrichment.

## Blocked by

- [Preserve multi-sample observations with dedupe and identity confidence](0021-preserve-multi-sample-observations-with-dedupe-and-identity-confidence.md)
- [Stop safely and write partial artifacts on platform risk](0023-stop-safely-and-write-partial-artifacts-on-platform-risk.md)

