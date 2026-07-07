# Generate guarded Personalized Greeting preview with fallback

Labels: `ready-for-agent`

## Parent

Local PRD: [PRD: Generate personalized greetings from cached capability profiles](../prd/personalized-greetings-from-cached-capability-profiles.md)

## What to build

Add the ability to generate a per-job Personalized Greeting plan from a fresh Candidate Capability Profile and a target JD. The generated greeting must use Evidence-Based Framing and pass Greeting Guard before it can be selected. If generation is unavailable or unsafe, the system must produce a preset Greeting Plan fallback instead.

This slice should be verifiable as a preview or planning capability. It should not send text, click browser actions, or integrate into confirmed `run-once` delivery yet.

## Acceptance criteria

- [ ] Given a fresh Candidate Capability Profile and a target job, the CLI can produce a Personalized Greeting plan.
- [ ] Personalized Greeting generation uses the current enabled LLM configuration for MVP and does not introduce OpenAI Agents SDK.
- [ ] The per-job greeting-generation request uses the cached capability summary and target job information, not full resume original text.
- [ ] Greeting Guard blocks unsupported claims, fake years of experience, fake company claims, fake certification claims, fabricated availability or salary claims, contact information, local paths, image paths, and full resume leakage.
- [ ] Greeting Guard enforces a short Chinese opening message target, roughly 80 to 160 characters, with structured reasons when it fails.
- [ ] Generated output that passes Guard produces a Greeting Plan with source `personalized`, guard result, safe summary, and character count.
- [ ] Missing cache, stale cache, no enabled LLM config, LLM request failure, malformed JSON, empty output, or Guard failure all fall back to the preset Greeting Plan.
- [ ] Fallback output records the fallback reason without treating personalization failure as Application Authorization failure.
- [ ] Tests cover successful personalization, missing/stale profile fallback, LLM unavailable fallback, parse failure fallback, and Guard rejection fallback.
- [ ] No cache, audit-safe output, or durable record stores full generated greeting text.

## Blocked by

- Local draft 0001: Normalize preset greeting into an audit-safe Greeting Plan
- Local draft 0002: Cache non-sensitive Candidate Capability Profile
