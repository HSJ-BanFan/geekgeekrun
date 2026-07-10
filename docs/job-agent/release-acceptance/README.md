# Human Job Agent release acceptance

CI must not store BOSS credentials, automate login, bypass safety verification, or perform real application actions. Every published Job Agent release therefore needs one closed GitHub issue containing the human acceptance record for the BOSS-dependent path.

1. Push the immutable `job-agent-v*` tag. The release workflow builds and tests a candidate but does not publish it.
2. Download the candidate artifact and `SHA256SUMS.txt` from the successful tag workflow run.
3. Create an issue in `HSJ-BanFan/geekgeekrun` using [template.md](template.md), including the exact tested installer SHA-256.
4. Use a disposable or dedicated BOSS session and the candidate installer from that workflow run.
5. Record only non-sensitive environment facts, reason codes, counts, and artifact paths after checking that the paths contain no private originals.
6. Never paste passwords, Cookies, API keys, raw browser state, full resume text, or private artifact contents.
7. Perform no chat, greeting, resume upload, application, or verification bypass.
8. Resolve every checkbox and placeholder, set `Final outcome: pass`, and close the acceptance issue.
9. Manually dispatch `Release Job Agent` with the release tag, successful candidate run ID, and acceptance issue number. The workflow verifies the run commit, tested hash, completed record, and candidate files before publishing.

A release record is complete only when every required outcome is `pass`, or `not applicable` includes a concrete rationale approved by the release owner. A tag push alone can never publish a release.
