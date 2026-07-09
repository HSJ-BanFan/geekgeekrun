# Crawl one search sample into market-jobs.v1 raw artifact

Labels: `ready-for-agent`

## Parent

Local PRD: [Add read-only market job crawl as a CLI command](../prd/read-only-market-jobs-crawl-cli.md)

Related ADR:

- [Keep market job crawl CLI-owned and read-only](../adr/0011-keep-market-job-crawl-cli-owned-and-read-only.md)

## What to build

Add the first browser-backed `market-jobs` path for one keyword-city sample.

The command should open the BOSS geek search results page, perform read-only list scrolling, extract visible Market Job Evidence, write a `market-jobs.v1` raw artifact, and print only a JSON summary with artifact paths.

## Acceptance criteria

- [ ] `ggr market-jobs --from-browser --keyword <value> --city <value>` opens the keyword-city search results page using the existing browser launch or attach conventions.
- [ ] The list stage scrolls and extracts visible job cards until the requested limit, ordinary sample exhaustion, or a sample stop condition.
- [ ] The command does not click application/chat controls, send messages, upload resumes, or issue/consume authorization tokens.
- [ ] A raw artifact with `schemaVersion: "market-jobs.v1"`, `captureMetadata`, `sourceStrategy`, `samples[]`, `jobs[]`, and `statusSummary` is written incrementally enough to survive interruption.
- [ ] Each sample records `sampleKey`, keyword, `cityInput`, `cityCode`, status, reason code, requested limit, captured count, deduped job count, scroll count, no-new-item count, start time, and end time.
- [ ] Stdout returns summary fields such as `ok`, `command`, `sampleCount`, `jobCount`, `statusSummary`, `rawArtifactPath`, optional `analysisArtifactPath`, and `reasonCode`; stdout does not include full job lists or JD text.
- [ ] Tests use fake pages or fixture HTML and do not require live BOSS.

## Blocked by

- [Add market-jobs --plan-only CLI contract](0019-add-market-jobs-plan-only-cli-contract.md)

