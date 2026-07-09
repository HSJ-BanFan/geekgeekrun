# Build Preference Evidence Package from JD artifact

## Source

Local PRD: [Build Application Preference Profiles from cleaned JD evidence and clarification sessions](../prd/application-preference-profile-from-jd-evidence.md)

Related ADRs:

- [Split application preference profiling between repo contracts and agent skill](../adr/0012-split-application-preference-profiling-between-repo-contracts-and-agent-skill.md)
- [Keep recent application JD crawl CLI-owned and read-only](../adr/0010-keep-recent-application-jd-crawl-cli-owned-and-read-only.md)

## Goal

Add the first formal preference-profiling slice: a deterministic cleaner that reads a recent-applications-with-JD artifact and emits a redacted Preference Evidence Package.

This issue must not call an LLM. Its job is to make a stable, testable evidence boundary for later profile generation.

## Acceptance Criteria

- [x] A sidecar command or callable module can build a Preference Evidence Package from a recent-applications-with-JD JSON artifact.
- [x] The package includes `schemaVersion`, `packageId`, `generatedAt`, `cleanerVersion`, source metadata, input coverage, sample counts, and source fingerprints.
- [x] The cleaner extracts normalized counts for title/category/JD signals, city, remote/part-time, internship/new-grad, language/localization, AI/LLM/Agent, backend/data, annotation/evaluation, and generic non-target signals.
- [x] The cleaner separates possible main-track clusters, side-track clusters, side-track-only clusters, downrank clusters, and exclude clusters.
- [x] Representative examples are selected deterministically with `strongest`, `boundary`, and `contradiction` selection reasons.
- [x] Each representative example includes an id, cluster id, selection reason, title, company, city, normalized signals, redacted snippets, and evidence references.
- [x] The package includes conflict signals and missing data signals.
- [x] The package includes an `evidenceIndex` whose ids can later be referenced by an Application Preference Profile.
- [x] Full raw JD text is not included in the Preference Evidence Package by default.
- [x] The output is redacted and does not contain cookies, local storage, browser access parameters, API keys, local paths, resume image paths, or full raw chat transcripts.
- [x] Tests cover main/side/side-track-only/downrank/exclude separation.
- [x] Tests cover representative example selection reasons.
- [x] Tests prove no LLM is called.
- [x] Existing `review-application-preferences` tests continue to pass.

## Implementation Notes

- Implemented in `60664fd Build preference evidence package`.
- Added the repository-owned Preference Evidence Package contracts and deterministic cleaner in the sidecar.
- Added a sidecar CLI path for building preference evidence from recent application JD artifacts.
- Added redaction, source fingerprint, evidence index, representative example, conflict signal, and missing data support.
- Added regression tests for evidence packaging and application preference behavior.

## Verification

- `python -m pytest tests/test_preference_evidence_package.py tests/test_application_preferences.py`
- `python -m pytest`

## Out Of Scope

- Calling an LLM.
- Generating an Application Preference Profile.
- Running a Preference Clarification Session.
- Sending messages, applying to jobs, or any browser action.
- User-configurable cleaning rule files.
