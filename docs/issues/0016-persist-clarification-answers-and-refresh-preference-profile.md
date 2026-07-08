# Persist clarification answers and refresh preference profile

## Source

Local PRD: [Build Application Preference Profiles from cleaned JD evidence and clarification sessions](../prd/application-preference-profile-from-jd-evidence.md)

## Goal

Add support for Preference Clarification Session outputs as durable input evidence, then refresh Preference Evidence Packages and Application Preference Profiles when clarification answers materially change preferences.

## Acceptance Criteria

- [x] Clarification Answers are stored as independent redacted artifacts or cache records.
- [x] Each answer stores an answer id, question text, recommended answer shown, user answer, affected fields, created time, and stable evidence reference.
- [x] Clarification Answers can be included as input when building a Preference Evidence Package.
- [x] Source fingerprints include Clarification Answers so stale profiles can be detected.
- [x] Refreshing a profile after a material clarification produces a new profile artifact rather than mutating opaque LLM text in place.
- [x] The session asks one targeted question at a time.
- [x] Questions are derived from profile uncertainties or evidence package gaps.
- [x] Tests cover persisted answers becoming evidence references in a refreshed package/profile.
- [x] Tests cover profile staleness when answers change.

## Implementation Notes

- Added `PreferenceClarificationAnswer` and `PreferenceClarificationAnswersArtifact` contracts.
- Added `ggr-sidecar record-preference-clarification-answer` to append or replace one redacted answer in a durable artifact.
- Added `--clarification-answers` to `ggr-sidecar build-preference-evidence`; answers become `clarification_answer` entries in `evidenceIndex`.
- Preference Evidence Package `sourceFingerprints` now includes `clarificationAnswers` when present, and the package id is derived from the combined source fingerprints.
- Added `ggr-sidecar clarify-application-preferences` to emit one targeted question from profile uncertainties or package gaps.
- Added `ggr-sidecar check-application-preference-profile-freshness` and `evaluate_application_preference_profile_staleness` to detect stale profiles when clarification answers change.

## Verification

- `python -m pytest tests/test_preference_evidence_package.py tests/test_application_preference_profile.py`
- `python -m pytest`

## Out Of Scope

- Generic career coaching.
- Full interactive UI polish.
- Real application actions.
