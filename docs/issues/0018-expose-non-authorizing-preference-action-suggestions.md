# Expose non-authorizing Preference Action Suggestions

## Source

Local PRD: [Build Application Preference Profiles from cleaned JD evidence and clarification sessions](../prd/application-preference-profile-from-jd-evidence.md)

## Goal

Expose non-authorizing planning suggestions derived from an Application Preference Profile for search planning, resume framing, greeting framing, and side-track query planning.

## Acceptance Criteria

- [x] Application Preference Profiles can include Preference Action Suggestions for search keywords, include signals, avoid terms, downrank hints, side-track queries, greeting framing hints, resume framing hints, and Target JD sample requests.
- [x] Suggestions can reference `excludePatterns`, `downrankPatterns`, and `sideTrackOnlyPatterns`.
- [x] Suggestions are clearly marked as non-authorizing and cannot trigger browser actions.
- [x] The MVP does not hard-delete candidate retrieval results solely from Application Preference Profile patterns.
- [x] Tests verify suggestions are emitted as metadata only.
- [x] Tests verify downstream consumers cannot treat suggestions as Application Authorization.

## Out Of Scope

- Changing BOSS search execution.
- Applying to jobs.
- Replacing Rule Boundary or LLM Apply Decision.
