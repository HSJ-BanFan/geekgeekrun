# Cache non-sensitive Candidate Capability Profile

Labels: `ready-for-agent`

## Parent

Local PRD: [PRD: Generate personalized greetings from cached capability profiles](../prd/personalized-greetings-from-cached-capability-profiles.md)

## What to build

Add a reusable Candidate Capability Profile cache. The profile should be derived from the candidate's Candidate Profile, Target Role Intent, user requirements, and greeting rules, then stored as a non-sensitive, auditable summary. It should be refreshed only when relevant inputs or schema/prompt versions change.

This slice should make the capability profile buildable and inspectable through the CLI, but it should not generate per-job greetings or change `run-once` delivery behavior yet.

## Acceptance criteria

- [ ] The CLI can build or refresh a Candidate Capability Profile from current candidate inputs.
- [ ] `snapshot` or a dedicated command reports whether a cached Candidate Capability Profile exists, whether it is fresh, and a safe summary of its contents.
- [ ] The cache includes freshness metadata such as schema version, prompt version, generated time, and source fingerprints.
- [ ] The cache is invalidated when resume-derived input, Target Role Intent, user requirements, greeting rules, candidate target, schema version, or prompt version changes.
- [ ] The cached profile contains demonstrated abilities, supporting evidence summaries, target-role direction, transferable strengths, gaps, and framing boundaries.
- [ ] The cached profile does not persist full resume text, contact information, local filesystem paths, resume image paths, cookies, local storage, API keys, full greeting text, or other sensitive originals.
- [ ] If LLM capability-profile generation is unavailable, the CLI fails safely with structured JSON and does not write a misleading fresh cache.
- [ ] Tests use sensitive canary strings in resume-like input and prove those strings are absent from cache files, audit-safe output, and snapshot output.
- [ ] Existing candidate profile and snapshot behavior remains compatible for current callers.

## Blocked by

None - can start immediately
