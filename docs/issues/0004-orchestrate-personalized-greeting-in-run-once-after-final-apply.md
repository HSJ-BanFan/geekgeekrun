# Orchestrate Personalized Greeting in `run-once` after final apply

Labels: `ready-for-agent`

## Parent

Local PRD: [PRD: Generate personalized greetings from cached capability profiles](../prd/personalized-greetings-from-cached-capability-profiles.md)

## What to build

Wire Greeting Plan selection into `run-once`. After the existing Rule Boundary and LLM Apply Decision flow resolves a Final Decision, `run-once` should attempt Personalized Greeting generation only when the final decision is `apply`. Jobs that resolve to `skip` or `uncertain` must not trigger greeting generation.

This slice should support dry-run planning and browser-from-page planning while preserving the existing Job Identity Anchor relocation and verification behavior.

## Acceptance criteria

- [ ] `run-once` attempts Personalized Greeting generation only after Final Decision is `apply`.
- [ ] `run-once` does not attempt Personalized Greeting generation for `skip`, `uncertain`, hard reject, missing LLM judgment, malformed LLM judgment, or incomplete final-decision paths.
- [ ] Dry-run output reports the selected Greeting Plan source, fallback reason if any, Guard result, safe summary, and character count.
- [ ] Dry-run output never clicks, sends text, uploads images, or moves browser state because of greeting generation.
- [ ] Browser `run-once --from-browser` keeps using the authorized job's Job Identity Anchor for action-phase relocation and verification.
- [ ] The existing preset greeting remains the fallback when personalization is unavailable or unsafe.
- [ ] `send-greeting` remains delivery-only and does not generate Personalized Greetings by itself.
- [ ] Tests prove apply-only generation gating, skip/uncertain no-generation behavior, fallback behavior, and no regression in Job Identity Anchor browser action tests.
- [ ] The package check and test commands for the job-agent CLI pass.

## Blocked by

- Local draft 0003: Generate guarded Personalized Greeting preview with fallback
