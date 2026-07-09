# Stop safely and write partial artifacts on platform risk

Labels: `ready-for-agent`

## Parent

Local PRD: [Add read-only market job crawl as a CLI command](../prd/read-only-market-jobs-crawl-cli.md)

Related ADR:

- [Keep market job crawl CLI-owned and read-only](../adr/0011-keep-market-job-crawl-cli-owned-and-read-only.md)

## What to build

Harden `market-jobs` so platform-level risk stops the command safely while preserving a partial artifact.

Ordinary list exhaustion should end only the current sample, but login, safety verification, abnormal environment, and unconfirmed page states must stop the whole command.

## Acceptance criteria

- [ ] Login expiration returns or records `BOSS_LOGIN_REQUIRED`, stops the command, and writes a readable partial artifact.
- [ ] Safety verification returns or records `BOSS_SAFETY_VERIFICATION_REQUIRED`, stops the command, and writes a readable partial artifact.
- [ ] Abnormal environment or equivalent platform risk returns or records `BOSS_ABNORMAL_ENVIRONMENT`, stops the command, and writes a readable partial artifact.
- [ ] Missing or unconfirmed search list DOM after navigation stops safely with a stable reason code.
- [ ] Reaching the requested limit, no-new-items threshold, or ordinary sample exhaustion ends only the current sample and allows subsequent samples to continue.
- [ ] Status summaries expose stopped/blocked/partial counts and the blocking reason.
- [ ] Tests use fake page states and assert partial artifact contents.

## Blocked by

- [Crawl one search sample into market-jobs.v1 raw artifact](0020-crawl-one-search-sample-into-market-jobs-raw-artifact.md)

