# Audit decisions without storing sensitive originals

Job-agent audit records preserve Decision Evidence and action outcomes, but they do not store sensitive originals such as cookies, local storage, API keys, full resume text, greeting text, local resume image paths, or private local paths. The audit trail should explain why a job was skipped, deferred, or applied to without becoming a second copy of the candidate's private configuration.

This reduces debugging detail compared with raw logs, but it keeps real-application traceability without expanding the privacy and secret-leakage surface.
