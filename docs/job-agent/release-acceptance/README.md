# Human Job Agent release acceptance

CI must not store BOSS credentials, automate login, bypass safety verification, or perform real application actions. Every published Job Agent release therefore needs one closed GitHub issue containing the human acceptance record for the BOSS-dependent path.

## One-time repository setup

Create a GitHub Environment named `job-agent-release` and configure at least one required reviewer. Leave self-review enabled when the repository has only one release owner. Treat this repository setting as part of the release safety boundary; `GITHUB_TOKEN` cannot administer or prove the reviewer configuration from inside the workflow.

Create an active repository tag ruleset for `refs/tags/job-agent-v*` that blocks tag updates and deletions. The workflow creates a missing release tag only after the exact `main` push Contract Gate succeeds, but repository rules are what prevent a maintainer or token from later moving that tag.

The environment approval is the publication decision. GitHub pauses the publish job without consuming a runner while the operator completes the manual acceptance record.

## One-dispatch release path

1. Update all distribution version fields and merge the release commit into `main`.
2. Wait for the Job-Agent Contract Gate on that exact commit to pass.
3. Create an open acceptance issue from [template.md](template.md). Fill `Related issues to close` with `none` or the explicit `#123, #124` list that publication should complete. Keep the issue open until the workflow records the tested candidate hash.
4. Dispatch the workflow once:

   ```powershell
   gh workflow run release-job-agent.yml `
     --repo HSJ-BanFan/geekgeekrun `
     -f version=0.2.0 `
     -f acceptance_issue=25
   ```

   `close_issues` is an optional override for an older acceptance record:

   ```powershell
   gh workflow run release-job-agent.yml `
     --repo HSJ-BanFan/geekgeekrun `
     -f version=0.2.0 `
     -f acceptance_issue=25 `
     -f close_issues="#9, #26, #27"
   ```

5. The workflow validates the version, successful Contract Gate, and acceptance issue. It then creates or verifies the immutable `job-agent-v*` tag, builds one candidate, generates checksums and provenance, and passes the isolated installed-product Windows gate.
6. After the deterministic gates pass, the workflow writes the candidate run ID and exact installer SHA-256 into the acceptance issue. Download the `job-agent-release-candidate` artifact from that run.
7. Use a disposable or dedicated BOSS session and complete every human checklist item. Record only non-sensitive environment facts, reason codes, counts, and artifact paths.
8. Set `Final outcome: pass`, remove every placeholder, and close the acceptance issue with reason `completed`.
9. Approve the pending `job-agent-release` environment deployment. Do not dispatch another workflow.
10. The paused workflow revalidates the closed record against the same candidate hash, publishes the prerelease or signed stable release, writes release evidence back to the acceptance and related issues, and closes any still-open related issues as `completed`.

## Safety and reruns

- Never paste passwords, Cookies, API keys, raw browser state, full resume text, or private artifact contents.
- Perform no chat, greeting, resume upload, application, or verification bypass during acceptance.
- A tag is created only after the source Contract Gate passes. A tag alone cannot publish a release; publication still requires the closed acceptance record and the protected environment deployment.
- Re-running before publication discovers and reuses the latest unexpired candidate whose build and installed-product jobs succeeded for the same tagged commit. Re-running an already published version does not move its tag or rebuild assets; it only revalidates the original acceptance link and reconciles missing comments or declared issue closures.
- Candidate and final comments contain stable markers, so reruns update the existing automation comment instead of creating duplicates.
- Any failed gate or invalid acceptance record stops publication and leaves related issues open.

A release record is complete only when every required outcome is `pass`, or `not applicable` includes a concrete rationale approved by the release owner.
