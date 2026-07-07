# Harden confirmed delivery and audit for Personalized Greeting

Labels: `ready-for-agent`

## Parent

Local PRD: [PRD: Generate personalized greetings from cached capability profiles](../prd/personalized-greetings-from-cached-capability-profiles.md)

## What to build

Complete the confirmed delivery path for Greeting Plans and harden audit records. When an authorized `apply` job reaches the action phase, the browser action should send text only when the selected Greeting Plan has safe sendable text. If no safe text exists, the system may still perform the authorized `start_chat` action, but it must skip text sending. Resume image upload should continue to follow existing configuration.

Audit records must explain the greeting path without storing full greeting text or sensitive originals.

## Acceptance criteria

- [ ] Confirmed `run-once` sends a personalized greeting only when the selected Greeting Plan is safe and sendable.
- [ ] Confirmed `run-once` uses the preset greeting fallback when personalization fails but the fallback Greeting Plan is safe and sendable.
- [ ] When no safe greeting text exists, confirmed `run-once` may continue with authorized `start_chat`, skips text sending, and records the skip reason.
- [ ] Resume image upload behavior remains controlled by existing configuration and does not depend on personalization success.
- [ ] Confirmed browser actions still fail closed on missing Job Identity Anchor, relocation not found, detail mismatch, or unconfirmed detail.
- [ ] Audit records store greeting source, Guard outcome, fallback reason, safe summary, character count, and action outcomes.
- [ ] Audit records do not store full generated greeting text, full preset greeting text, full resume text, contact information, resume image paths, local paths, cookies, local storage, API keys, or other sensitive originals.
- [ ] Tests cover confirmed personalized send, confirmed preset fallback send, no-safe-text skip, image upload preservation, and audit redaction.
- [ ] Existing browser action, audit-log, final-decision, policy, and candidate-profile tests continue to pass.
- [ ] The package check and test commands for the job-agent CLI pass.

## Blocked by

- Local draft 0004: Orchestrate Personalized Greeting in `run-once` after final apply
