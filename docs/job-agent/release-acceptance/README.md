# Human Job Agent release acceptance

CI must not store BOSS credentials, automate login, bypass safety verification, or perform real application actions. Every published Job Agent release therefore needs one human acceptance record for the BOSS-dependent path.

1. Copy [template.md](template.md) to `job-agent-<version>-windows-x64.md`.
2. Use a disposable or dedicated BOSS session and the installer produced from the immutable release tag.
3. Record only non-sensitive environment facts, reason codes, counts, and artifact paths after checking that the paths contain no private originals.
4. Never paste passwords, Cookies, API keys, raw browser state, full resume text, or private artifact contents.
5. Perform no chat, greeting, resume upload, application, or verification bypass.

A release record is complete only when every required outcome is `pass`, or `not applicable` includes a concrete rationale approved by the release owner.
