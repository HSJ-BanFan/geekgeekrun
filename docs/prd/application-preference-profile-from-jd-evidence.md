# PRD: Build Application Preference Profiles from cleaned JD evidence and clarification sessions

## Problem Statement

GeekGeekRun needs a standard way to understand a job seeker's real application preferences before future searches or real application actions. Recent BOSS application history plus JD crawl can reveal useful patterns, but the raw data is noisy: users may have mass-applied to mismatched roles, mixed main career goals with side-income goals, or have too little historical data to infer preferences from applications alone.

The current `recent-applications` PRD focuses on read-only JD crawling and deterministic preference analysis. That is necessary but not sufficient. The system needs a higher-level Application Preference Profile that combines cleaned JD evidence, the user's explicit statements, capability evidence, optional target JD samples, and conversational clarification. This profile must remain advisory Decision Evidence: it can guide search planning and LLM Apply Decision context, but it must not authorize real application actions.

## Solution

Add a preference-profiling capability with two layers:

1. Repository-owned contracts and tools for deterministic cleaning, Preference Evidence Package construction, strict JSON Application Preference Profile output, artifact persistence, schema validation, freshness metadata, and tests.
2. An agent skill for Preference Clarification Sessions: a conversational process that asks one targeted question at a time to resolve missing, noisy, or conflicting preference evidence.

The system will first normalize available inputs into a Preference Evidence Package. The LLM then generates a schema-validated Application Preference Profile from that package. If the profile contains uncertainty that would change search or preference planning, the agent runs a Preference Clarification Session and refreshes the profile with the clarification answers.

## Inputs

Required inputs:

- Candidate Statement: explicit user preferences and constraints gathered through conversation.
- Candidate Capability Profile or safe capability summary: demonstrated abilities, evidence, gaps, and framing boundaries.

Optional strengthening inputs:

- Recent Application Evidence: redacted read-only historical applications and JD crawl output.
- Target JD Samples: user-provided or selected representative JDs for roles the user may want or reject.
- Clarification Answers: persisted answers from prior Preference Clarification Sessions.

The system must support cold start. If Recent Application Evidence is missing, the profile can still be generated from Candidate Statement, Candidate Capability Profile, Target JD Samples, and Clarification Answers, but profile confidence must be lower and missing evidence must be explicit.

Default artifacts must not persist the full LLM prompt input. They should persist the redacted Preference Evidence Package, prompt version, model scene name, schema version, cleaner version, source fingerprints, validation result, and redacted Application Preference Profile. Saving full prompt inputs or raw model responses should require an explicit unsafe/debug mode if it is ever added.

## Preference Evidence Package

The Preference Evidence Package is the deterministic, redacted, normalized input boundary for LLM analysis. LLM profile generation must not read raw uncleaned history directly.

It should include:

- Source metadata: package id, schema version, generated time, source artifact ids, sample sizes.
- Input coverage: which required and optional inputs are present.
- Normalized counts: title categories, JD terms, city, remote, internship/new-grad, degree, experience, salary bands when available.
- Role clusters: possible main-track clusters, side-track clusters, side-track-only clusters, downrank clusters, exclude clusters.
- Representative examples: title, company, city, position category, redacted snippets, why selected.
- Conflict signals: user statement vs historical applications, capability evidence vs target direction, main-track vs side-track mixing.
- Missing data and uncertainty candidates.
- Preference Evidence References for downstream profile items.
- Persisted Clarification Answers with stable evidence ids.

By default it should contain summaries, labels, counts, and representative snippets rather than full JD text. Full JD text remains in the raw crawl artifact and should only be loaded selectively when deeper inspection is necessary.

The MVP cleaner should use repository-owned fixed classification rules and expose a `cleanerVersion` in package/profile metadata. User-configurable classification rules are intentionally deferred until the schema, evidence references, and main-track/side-track/side-track-only/downrank/exclude separation have proven stable.

Representative examples should be selected deterministically across three selection reasons:

- `strongest`: examples with the strongest signal within a cluster.
- `boundary`: examples that sit between tracks or categories, such as AI-titled roles whose JD is mostly data annotation, or remote side-track roles with real technical content.
- `contradiction`: examples that conflict with Candidate Statement or capability evidence, such as mass-applied generic roles when the stated main track is AI backend.

Each representative example should carry an example id, cluster id, selection reason, title, company, city, normalized signals, redacted snippets, and evidence references.

## Application Preference Profile

The Application Preference Profile is a strict JSON artifact with a human-readable summary. It should include:

- `schemaVersion`
- `profileId`
- `generatedAt`
- `profileConfidence`: `low | medium | high`
- `evidenceStrength` by input type
- `mainTrackPreferences`
- `sideTrackPreferences`
- `sideTrackOnlyPatterns`
- `excludePatterns`
- `downrankPatterns`
- `uncertainties`
- `preferenceActionSuggestions`
- `summary`
- metadata for freshness: prompt version, cleaner version, evidence package id, source fingerprints, stale reasons

Each preference item must include:

- `label`
- `track`: `main | side | side_track_only | downrank | exclude`
- `rationale`
- `evidenceRefs`
- `confidence`
- `constraints`
- `negativeSignals`

The LLM must not invent evidence references. Every `evidenceRefs` value in an Application Preference Profile must reference an id present in the input Preference Evidence Package evidence index. Unknown evidence references invalidate the profile. If the LLM cannot support a preference item with existing evidence, it should place the issue in `uncertainties` or `requestedEvidence` instead of fabricating support.

The profile can inform future search planning, preference review, resume/greeting framing, and LLM Apply Decision context. It must distinguish hard exclusions, lower-priority downrank patterns, and side-track-only patterns so that valid side-income goals are not mislabeled as noise. It must not grant Application Authorization, replace per-job evaluation, bypass Rule Boundary, or substitute for Candidate Capability Profile.

## Main Track And Side Track

The profile must separate main-track and side-track preferences.

Main-track preferences are optimized for career direction, skill growth, internship or full-time positioning, and future application-decision context.

Side-track preferences are valid secondary goals such as remote language/localization work, MTPE/LQA, AI translation evaluation, flexible part-time cash-flow roles, or other user-approved side-income categories.

Side-track preferences must not pollute main-track matching. A role can be valid for side-track purposes while still being downranked or excluded from main-track application decisions.

The profile should separate three different negative or bounded categories:

- `excludePatterns`: hard exclusions the user does not accept, or constraints that should strongly block a role from planning.
- `downrankPatterns`: lower-priority patterns that may still be inspected, such as weak AI labels, pure annotation, generic audit, or roles with limited growth value.
- `sideTrackOnlyPatterns`: roles that are valid for side-track goals but should not be treated as main-track evidence, such as remote MTPE/localization or language-data work.

## Preference Clarification Session

The agent skill should run a Preference Clarification Session when evidence is sparse, noisy, or conflicting.

Rules:

- Ask one question at a time.
- Prefer questions that would change the Application Preference Profile.
- Do not ask questions that can be answered from artifacts or existing profile data.
- Include a recommended answer with each question.
- Stop when main-track preferences, side-track preferences, side-track-only patterns, downrank patterns, exclude patterns, required constraints, and major conflicts are sufficiently resolved for the next planning step.

The session should not become generic career coaching. It exists to generate or refresh an Application Preference Profile.

## Preference Action Suggestions

The profile may include non-authorizing suggestions:

- Search keywords
- Include signals
- Downrank signals
- Side-track queries
- Greeting framing hints
- Resume framing hints
- Target JD sample requests

These suggestions must not trigger real browser actions or Application Authorization.

Preference Action Suggestions may use `excludePatterns` to propose avoid terms, `downrankPatterns` to propose scoring hints, and `sideTrackOnlyPatterns` to propose separate side-track search queries. They should not directly hard-delete candidates during retrieval because noisy job titles and platform search behavior can cause false negatives; per-job evaluation still belongs to downstream Rule Boundary and LLM Apply Decision flows.

## Proposed Commands

MVP command shape can be refined during implementation, but the capability should support:

```text
ggr-sidecar build-preference-evidence --recent-applications <path> --candidate-statement <path> --capability-profile <path> --target-jd-samples <path>
ggr-sidecar generate-application-preference-profile --evidence-package <path>
ggr-sidecar clarify-application-preferences --profile <path>
```

The existing `review-application-preferences` command should remain as a legacy/local-db quick review. The new `build-preference-evidence` command is the formal contract for Preference Evidence Package generation. Existing behavior should not be broken.

## User Stories

1. As a job seeker, I want the system to distinguish my main career target from side-income roles, so that remote part-time work does not pollute my main application matching.
2. As a job seeker, I want the system to work even if I have no historical applications, so that I can start from conversation and target JD samples.
3. As a job seeker, I want historical applications treated carefully, so that mass-applied noise does not become my inferred preference.
4. As a job seeker, I want the system to ask clarifying questions one at a time, so that I can correct ambiguous preference evidence.
5. As a job seeker, I want the profile to explain why it believes a preference is real, so that I can trust or correct it.
6. As a job seeker, I want side-track preferences such as remote localization or MTPE preserved, so that valid cash-flow goals are not labeled as noise.
7. As a job seeker, I want hard exclusions separated from downranked roles and side-track-only roles, so that the system does not over-block valid secondary goals.
8. As a maintainer, I want deterministic cleaning before LLM analysis, so that profile generation is based on a testable evidence package.
9. As a maintainer, I want strict JSON schemas and evidence references, so that sidecar code can validate and consume the profile safely.
10. As a maintainer, I want profile freshness metadata, so that stale profiles can be detected when candidate statements, capability profiles, JD samples, or crawl artifacts change.
11. As an auditor, I want preference profiles to remain Decision Evidence only, so that they cannot authorize real applications.

## Implementation Slices

### Slice 1: Build Preference Evidence Package

- Accept a recent-applications-with-JD artifact as input.
- Normalize titles, categories, JD terms, location, remote/part-time, internship/new-grad, language/localization, AI/LLM/Agent, backend/data, annotation/evaluation, and generic non-target signals.
- Select representative examples and snippets.
- Detect conflicts and missing data.
- Emit a redacted Preference Evidence Package with stable evidence references.
- Do not call LLM.

### Slice 2: Generate Application Preference Profile

- Accept a Preference Evidence Package.
- Call LLM with a strict schema.
- Validate output before writing a fresh profile artifact.
- Include profile confidence, evidence strength, main-track preferences, side-track preferences, side-track-only patterns, exclude patterns, downrank patterns, uncertainties, and Preference Action Suggestions.
- Refuse to write a fresh profile on schema failure or unsafe output.

### Slice 3: Clarify Preferences

- Read profile uncertainties and evidence package gaps.
- Ask one targeted question at a time through the agent skill.
- Persist Clarification Answers as independent profile input evidence with question text, recommended answer shown, user answer, affected fields, timestamp, and stable evidence reference.
- Refresh the Preference Evidence Package and Application Preference Profile after material clarification.

### Slice 4: Cold Start

- Support profile generation without Recent Application Evidence.
- Use Candidate Statement, Candidate Capability Profile, Target JD Samples, and Clarification Answers.
- Report lower Preference Confidence and explicit missing historical evidence.

### Slice 5: Integrate With Planning

- Expose Preference Action Suggestions for search planning, resume framing, and greeting framing.
- Pass the Application Preference Profile as context to future LLM Apply Decision flows without replacing per-job evaluation.

## Testing Decisions

- Tests should verify deterministic cleaner output from fixture historical applications and JD samples.
- Tests should verify raw JD text is not included in the Preference Evidence Package by default.
- Tests should verify every preference item has evidence references.
- Tests should verify profile validation rejects unknown or invented evidence references.
- Tests should verify main-track preferences, side-track preferences, side-track-only patterns, downrank patterns, and exclude patterns remain separated.
- Tests should verify cold-start profiles report low or medium confidence and missing historical evidence.
- Tests should verify schema validation rejects malformed LLM output.
- Tests should verify profile artifacts omit sensitive originals such as full resume text, full raw chat transcript, cookies, local storage, API keys, resume image paths, and browser access parameters.
- Tests should verify default artifacts do not persist full LLM prompt inputs or raw unvalidated model responses.
- Tests should verify Preference Action Suggestions are non-authorizing metadata.
- Existing `review-application-preferences` tests should continue to pass.

## Out Of Scope

- Sending messages, starting chats, applying to jobs, or uploading resumes.
- Granting or consuming Application Authorization.
- Replacing Rule Boundary, LLM Apply Decision, Job Identity Anchor, Job Match Guard, or CLI confirmation.
- Hard-deleting candidate retrieval results solely from Application Preference Profile patterns in the MVP.
- Treating historical applications as current authorization.
- Persisting raw uncleaned JD dumps inside the Preference Evidence Package.
- Persisting full LLM prompt inputs by default.
- Relying on an external agent skill as the only source of cleaning rules, schemas, or persistence.
- Generic career coaching unrelated to building or refreshing an Application Preference Profile.
- User-configurable preference-cleaning rule files in the MVP.

## References

- [ADR-0008: Generate greetings from cached capability profiles](../adr/0008-generate-greetings-from-cached-capability-profiles.md)
- [ADR-0009: Use Python Agents SDK as orchestration sidecar](../adr/0009-use-python-agents-sdk-as-orchestration-sidecar.md)
- [ADR-0010: Keep recent application JD crawl CLI-owned and read-only](../adr/0010-keep-recent-application-jd-crawl-cli-owned-and-read-only.md)
- [ADR-0012: Split application preference profiling between repo contracts and agent skill](../adr/0012-split-application-preference-profiling-between-repo-contracts-and-agent-skill.md)
- [PRD: Package recent BOSS applications with JD crawl as a CLI command](./package-applied-job-jd-crawl-as-cli.md)
