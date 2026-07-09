# Preserve multi-sample observations with dedupe and identity confidence

Labels: `ready-for-agent`

## Parent

Local PRD: [Add read-only market job crawl as a CLI command](../prd/read-only-market-jobs-crawl-cli.md)

Related ADR:

- [Keep market job crawl CLI-owned and read-only](../adr/0011-keep-market-job-crawl-cli-owned-and-read-only.md)

## What to build

Extend `market-jobs` from one sample to multiple Market Keyword and city samples while preserving per-sample observations and globally deduplicated jobs.

The artifact should keep ranking evidence from each sample without double-counting stable jobs.

## Acceptance criteria

- [ ] Multiple `--keyword` and `--city` values produce a Cartesian product of samples in browser-backed mode.
- [ ] The raw artifact preserves `samples[]` for each keyword-city sampling process and `jobs[]` for globally deduplicated jobs.
- [ ] Jobs with stable `jobId` are deduplicated globally while retaining `observations[]` that record sample key, rank, source metadata, contact-state evidence text if available, and list text.
- [ ] Jobs without stable `jobId` are retained with `jobIdentity.status = "missing"`, a temporary fingerprint, and low identity confidence.
- [ ] Low-confidence jobs remain eligible for market supply evidence but are clearly not valid Job Identity Anchors for any future action chain.
- [ ] Status summaries distinguish captured observations, deduped jobs, and low-confidence records.
- [ ] Tests cover cross-sample duplicate jobs and missing-job-id records.

## Blocked by

- [Crawl one search sample into market-jobs.v1 raw artifact](0020-crawl-one-search-sample-into-market-jobs-raw-artifact.md)

