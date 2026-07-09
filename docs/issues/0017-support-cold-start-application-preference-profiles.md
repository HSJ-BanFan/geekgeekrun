# Support cold-start Application Preference Profiles

## Source

Local PRD: [Build Application Preference Profiles from cleaned JD evidence and clarification sessions](../prd/application-preference-profile-from-jd-evidence.md)

## Goal

Allow Application Preference Profile generation when the user has no Recent Application Evidence, using Candidate Statement, Candidate Capability Profile, Target JD Samples, and Clarification Answers.

## Acceptance Criteria

- [x] Preference Evidence Package generation supports missing Recent Application Evidence.
- [x] Candidate Statement and Candidate Capability Profile inputs are treated as required for cold start.
- [x] Target JD Samples can be included as optional strengthening evidence.
- [x] Cold-start profiles report lower `profileConfidence` when historical evidence is missing.
- [x] `evidenceStrength.recentApplicationEvidence` can be `none`.
- [x] Missing evidence and requested evidence are explicit in the output.
- [x] Tests cover cold-start package generation without recent applications.
- [x] Tests cover cold-start profile generation with low or medium confidence and missing historical evidence.

## Implementation Notes

- `ggr-sidecar build-preference-evidence` now accepts cold-start inputs with `--candidate-statement`, `--capability-profile`, and optional `--target-jd-samples` without requiring `--recent-applications`.
- Cold-start evidence packages include Candidate Statement, Candidate Capability Profile, Target JD Sample evidence refs, explicit `missingDataSignals`, and `requestedEvidence`.
- Profile validation rejects `high` confidence when Recent Application Evidence is absent and accepts `evidenceStrength.recentApplicationEvidence: "none"`.

## Verification

- `python -m pytest packages\job-agent-sidecar\tests`

## Out Of Scope

- Crawling JD history.
- Inferring strong historical preferences when no history exists.
- Real application actions.
