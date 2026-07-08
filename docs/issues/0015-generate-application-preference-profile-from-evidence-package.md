# Generate Application Preference Profile from evidence package

## Source

Local PRD: [Build Application Preference Profiles from cleaned JD evidence and clarification sessions](../prd/application-preference-profile-from-jd-evidence.md)

Related ADR:

- [Split application preference profiling between repo contracts and agent skill](../adr/0012-split-application-preference-profiling-between-repo-contracts-and-agent-skill.md)

## Goal

Generate a strict JSON Application Preference Profile from a Preference Evidence Package using LLM analysis, then validate and persist the redacted profile artifact.

## Acceptance Criteria

- [x] A sidecar command or callable module accepts a Preference Evidence Package path and produces an Application Preference Profile artifact.
- [x] The generated profile uses a strict schema with `schemaVersion`, `profileId`, `generatedAt`, `profileConfidence`, `evidenceStrength`, `mainTrackPreferences`, `sideTrackPreferences`, `sideTrackOnlyPatterns`, `excludePatterns`, `downrankPatterns`, `uncertainties`, `preferenceActionSuggestions`, `summary`, and freshness metadata.
- [x] Every preference item includes `label`, `track`, `rationale`, `evidenceRefs`, `confidence`, `constraints`, and `negativeSignals`.
- [x] Profile validation rejects unknown or invented `evidenceRefs`.
- [x] Profile validation rejects malformed LLM output and does not write a misleading fresh profile.
- [x] The profile records `promptVersion`, `cleanerVersion`, evidence package id, source fingerprints, and stale reasons when applicable.
- [x] Default artifacts do not persist full LLM prompt inputs or raw unvalidated model responses.
- [x] The profile states that it is Decision Evidence only and does not grant Application Authorization.
- [x] Tests cover valid profile generation with fixture evidence.
- [x] Tests cover schema failure, invented evidence refs, and unsafe artifact persistence.

## Implementation Notes

- Added `generate_application_preference_profile_from_file` as the callable module entry point.
- Added `ggr-sidecar generate-application-preference-profile --evidence-package <path> --output <path>`.
- The CLI uses OpenAI-compatible environment variables by default: `GGR_OPENAI_API_KEY` or `OPENAI_API_KEY`, plus `GGR_OPENAI_MODEL` or `OPENAI_MODEL`. `GGR_OPENAI_BASE_URL` or `OPENAI_BASE_URL` may override the default base URL.
- `--llm-response <path>` is available for tests and offline validation of a pre-generated model response without persisting that raw response into the profile artifact.
- The persisted artifact is only the validated, redacted Application Preference Profile. Full prompt input and raw unvalidated model output are not written by default.
- Validation enforces strict schema fields, metadata consistency with the evidence package, non-authorizing preference action suggestions, and evidence refs that exist in the input evidence index.

## Verification

- `python -m pytest tests/test_application_preference_profile.py tests/test_preference_evidence_package.py`
- `python -m pytest`

## Out Of Scope

- Building the Preference Evidence Package.
- Asking clarification questions.
- Updating search or application behavior.
- Granting or consuming Application Authorization.
