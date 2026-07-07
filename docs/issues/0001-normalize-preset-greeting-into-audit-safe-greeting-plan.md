# Normalize preset greeting into an audit-safe Greeting Plan

Labels: `ready-for-agent`

## Parent

Local PRD: [PRD: Generate personalized greetings from cached capability profiles](../prd/personalized-greetings-from-cached-capability-profiles.md)

## What to build

Introduce a unified Greeting Plan for the existing preset greeting path. The system should still choose and send the same preset greeting as today, but callers should also receive an audit-safe representation of the selected greeting: source, selected rule/template, fallback reason, short summary, character count, and safety status.

This slice is a small prefactor that makes later Personalized Greeting work easy. It should not generate new text, call an LLM for greetings, change Application Authorization, or change browser clicking behavior.

## Acceptance criteria

- [ ] Existing preset greeting selection still chooses the same greeting for the same job and configuration.
- [ ] A successful preset selection produces a Greeting Plan with source `preset`, selected rule/template metadata, safe summary, character count, and no fallback reason.
- [ ] Delivery code can still access the actual message text when it needs to send it.
- [ ] Audit-facing data does not store full greeting text, resume image paths, local paths, cookies, local storage, API keys, or other sensitive originals.
- [ ] CLI JSON output for evaluation or dry-run exposes enough safe Greeting Plan metadata to explain which preset path would be used.
- [ ] Existing `send-greeting` behavior remains delivery-only and does not become responsible for generation.
- [ ] Existing tests for preset greeting selection and browser dry-run continue to pass.
- [ ] New tests cover audit-safe Greeting Plan serialization and prove full greeting text is not written into audit records.

## Blocked by

None - can start immediately
