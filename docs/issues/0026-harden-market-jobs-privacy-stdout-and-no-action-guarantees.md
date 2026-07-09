# Harden market-jobs privacy, stdout, and no-action guarantees

Labels: `ready-for-agent`

## Parent

Local PRD: [Add read-only market job crawl as a CLI command](../prd/read-only-market-jobs-crawl-cli.md)

Related ADR:

- [Keep market job crawl CLI-owned and read-only](../adr/0011-keep-market-job-crawl-cli-owned-and-read-only.md)

## What to build

Add final safety, privacy, and no-action regression coverage for `market-jobs` across the full MVP.

This slice should make the command ready for agent use by proving stdout remains summary-only, artifacts are redacted, and no application-action path is reachable from market sampling.

## Acceptance criteria

- [ ] Stdout never includes complete job arrays, full observations, or JD text; it only includes summary fields and artifact paths.
- [ ] Default artifacts do not contain cookies, local storage, raw `securityId`, API keys, resume paths, avatar URLs, personal homepage URLs, chat-entry parameters, or full browser state.
- [ ] Raw artifact metadata explicitly states the command is read-only and neither issues nor consumes Application Authorization Tokens.
- [ ] Tests prove `market-jobs` does not call send-message, start-chat, upload-resume/image, authorized-action, authorization-token issue, or authorization-token consume paths.
- [ ] Tests prove contact state is not sourced from chat history or `recent-applications`.
- [ ] Tests cover combined `--from-browser --include-jd --analyze` behavior through fake pages or fixtures.
- [ ] Existing relevant job-agent CLI tests continue passing.

## Blocked by

- [Stop safely and write partial artifacts on platform risk](0023-stop-safely-and-write-partial-artifacts-on-platform-risk.md)
- [Add optional sequential JD enrichment from detail DOM](0024-add-optional-sequential-jd-enrichment-from-detail-dom.md)
- [Generate deterministic market-jobs-analysis.v1 artifact](0025-generate-deterministic-market-jobs-analysis-artifact.md)

