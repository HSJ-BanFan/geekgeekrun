# Generate deterministic market-jobs-analysis.v1 artifact

Labels: `ready-for-agent`

## Parent

Local PRD: [Add read-only market job crawl as a CLI command](../prd/read-only-market-jobs-crawl-cli.md)

Related ADR:

- [Keep market job crawl CLI-owned and read-only](../adr/0011-keep-market-job-crawl-cli-owned-and-read-only.md)

## What to build

Add deterministic `--analyze` output for `market-jobs`.

The analysis should consume the raw market artifact shape, focus default market-demand counts on uncontacted jobs, retain low-confidence supply signal, and separately report actionable jobs with stable identity.

## Acceptance criteria

- [ ] `--analyze` writes an analysis artifact with `schemaVersion: "market-jobs-analysis.v1"` and includes its path in stdout.
- [ ] Analysis is deterministic and does not call any LLM.
- [ ] Analysis reports the existing role/noise category baseline: AI/LLM/Agent/AIGC, full-stack, Python/backend/data engineering, frontend/React/Vue, Java/traditional backend, data annotation/AI training, translation/localization/Japanese, testing/IT generic, product/operations/audit/data entry, remote/part-time, and internship/new-grad.
- [ ] Analysis reports market-specific counts for salary buckets, experience buckets, degree buckets, city, company industry, company size, financing stage, contact state, identity confidence, actionable job count, and sample breakdown.
- [ ] Market supply counts default to `contactState = uncontacted` while low-identity-confidence jobs remain counted in supply and separated in identity-confidence breakdown.
- [ ] Salary analysis keeps original salary text and avoids annual-compensation inference.
- [ ] Experience and degree normalization use explicit fields only, not JD prose inference.
- [ ] Tests cover deterministic category counts, buckets, examples, sample breakdown, and actionable job count.

## Blocked by

- [Preserve multi-sample observations with dedupe and identity confidence](0021-preserve-multi-sample-observations-with-dedupe-and-identity-confidence.md)
- [Classify market job contact state from visible page evidence](0022-classify-market-job-contact-state-from-visible-page-evidence.md)

