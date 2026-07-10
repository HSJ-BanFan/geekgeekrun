import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

import {
  assertReleaseBindings,
  buildCandidateRecordComment,
  buildFinalReleaseComment,
  createReleasePlan,
  extractRelatedIssueNumbers,
  updateAcceptanceRecord,
} from './job-agent-release.mjs'

const execFileAsync = promisify(execFile)

test('release plan derives the immutable tag and deterministic issue closure scope', () => {
  assert.deepEqual(
    createReleasePlan({
      version: '0.2.0',
      acceptanceIssue: '25',
      closeIssues: '#9, 26 27, #26',
    }),
    {
      schemaVersion: 'job-agent-release-plan.v1',
      version: '0.2.0',
      releaseTag: 'job-agent-v0.2.0',
      acceptanceIssue: 25,
      relatedIssues: [9, 26, 27],
      prerelease: true,
    }
  )
})

test('release plan rejects unsafe versions and issue identifiers', () => {
  assert.throws(
    () => createReleasePlan({ version: 'v0.2.0', acceptanceIssue: '25' }),
    /JOB_AGENT_RELEASE_VERSION_INVALID/
  )
  assert.throws(
    () => createReleasePlan({ version: '0.2.0', acceptanceIssue: 'issue-25' }),
    /JOB_AGENT_RELEASE_ISSUE_INVALID/
  )
  assert.throws(
    () => createReleasePlan({ version: '0.2.0', acceptanceIssue: '25', closeIssues: '9-12' }),
    /JOB_AGENT_RELEASE_ISSUE_LIST_INVALID/
  )
})

test('candidate recording fills machine-owned acceptance metadata without changing human evidence', () => {
  const body = `# Job Agent acceptance

## Record metadata

- Distribution version:
- Release tag:
- Candidate workflow run ID:
- Installer SHA-256:
- Related issues to close:
- Windows edition and build: Windows 11

## Supported user path

- [x] Manual evidence retained.
`
  const plan = createReleasePlan({
    version: '0.2.0',
    acceptanceIssue: '25',
    closeIssues: '#9, #26',
  })

  assert.equal(
    updateAcceptanceRecord(body, {
      plan,
      candidateRunId: '123456',
      installerSha256: 'a'.repeat(64),
    }),
    `# Job Agent acceptance

## Record metadata

- Distribution version: 0.2.0
- Release tag: job-agent-v0.2.0
- Candidate workflow run ID: 123456
- Installer SHA-256: ${'a'.repeat(64)}
- Related issues to close: #9, #26
- Windows edition and build: Windows 11

## Supported user path

- [x] Manual evidence retained.
`
  )
})

test('related issue discovery uses only the declared record metadata and explicit input', () => {
  const body = `## Parent

#9

## Record metadata

- Related issues to close: #10, 11, #10
`

  assert.deepEqual(
    extractRelatedIssueNumbers({
      body,
      explicitCloseIssues: '#12 13',
      acceptanceIssue: 11,
    }),
    [10, 12, 13]
  )
})

test('release comments carry stable markers and only non-sensitive traceability', () => {
  const plan = createReleasePlan({ version: '0.2.0', acceptanceIssue: '25' })
  const candidateComment = buildCandidateRecordComment({
    plan,
    repository: 'HSJ-BanFan/geekgeekrun',
    candidateRunId: '123456',
    installerSha256: 'b'.repeat(64),
  })
  assert.match(candidateComment, /<!-- job-agent-release-candidate:job-agent-v0\.2\.0 -->/)
  assert.match(candidateComment, /actions\/runs\/123456/)
  assert.match(candidateComment, new RegExp('b{64}'))

  const finalComment = buildFinalReleaseComment({
    plan,
    releaseUrl: 'https://github.com/HSJ-BanFan/geekgeekrun/releases/tag/job-agent-v0.2.0',
    workflowUrl: 'https://github.com/HSJ-BanFan/geekgeekrun/actions/runs/123456',
    assets: [
      { name: 'setup.exe', digest: `sha256:${'c'.repeat(64)}` },
    ],
  })
  assert.match(finalComment, /<!-- job-agent-release-finalized:job-agent-v0\.2\.0 -->/)
  assert.match(finalComment, /setup\.exe: `sha256:c{64}`/)
})

test('published release reconciliation remains bound to its original acceptance and candidate run', () => {
  const plan = createReleasePlan({ version: '0.2.0', acceptanceIssue: '25' })
  const releaseBody = `Human acceptance record: https://github.com/HSJ-BanFan/geekgeekrun/issues/25
Candidate workflow: https://github.com/HSJ-BanFan/geekgeekrun/actions/runs/123456`
  const acceptanceBody = '- Candidate workflow run ID: 123456'

  assert.deepEqual(
    assertReleaseBindings({
      releaseBody,
      acceptanceBody,
      repository: 'HSJ-BanFan/geekgeekrun',
      plan,
    }),
    { acceptanceUrl: 'https://github.com/HSJ-BanFan/geekgeekrun/issues/25', candidateRunId: '123456' }
  )
  assert.throws(
    () => assertReleaseBindings({
      releaseBody,
      acceptanceBody,
      repository: 'HSJ-BanFan/geekgeekrun',
      plan: createReleasePlan({ version: '0.2.0', acceptanceIssue: '26' }),
    }),
    /JOB_AGENT_RELEASE_ACCEPTANCE_MISMATCH/
  )
  assert.throws(
    () => assertReleaseBindings({
      releaseBody,
      acceptanceBody: '- Candidate workflow run ID: 999999',
      repository: 'HSJ-BanFan/geekgeekrun',
      plan,
    }),
    /JOB_AGENT_RELEASE_CANDIDATE_RUN_MISMATCH/
  )
  assert.throws(
    () => assertReleaseBindings({
      releaseBody: 'Human acceptance record: https://github.com/HSJ-BanFan/geekgeekrun/issues/25',
      acceptanceBody,
      repository: 'HSJ-BanFan/geekgeekrun',
      plan,
    }),
    /JOB_AGENT_RELEASE_CANDIDATE_RUN_MISSING/
  )
})

test('release workflow exposes one dispatch and pauses publication at the protected environment', () => {
  const workflow = fs.readFileSync('.github/workflows/release-job-agent.yml', 'utf8')
  const dispatchContract = workflow.match(/workflow_dispatch:[\s\S]*?\npermissions:/)?.[0] ?? ''

  assert.match(dispatchContract, /version:/)
  assert.match(dispatchContract, /acceptance_issue:/)
  assert.match(dispatchContract, /close_issues:/)
  assert.doesNotMatch(dispatchContract, /candidate_run_id:/)
  assert.doesNotMatch(workflow, /push:\s*\n\s*tags:/)
  assert.match(workflow, /environment:\s*\n\s*name: job-agent-release/)
  assert.match(workflow, /record-candidate/)
  assert.match(workflow, /finalize/)
})

test('release workflow reuses a previously tested candidate and requires a successful main push gate', () => {
  const workflow = fs.readFileSync('.github/workflows/release-job-agent.yml', 'utf8')

  assert.match(workflow, /reuse_candidate/)
  assert.match(workflow, /candidate_run_id/)
  assert.match(workflow, /run-id: \$\{\{ needs\.preflight\.outputs\.candidate_run_id \}\}/)
  assert.match(workflow, /\.event == "push"/)
  assert.match(workflow, /\.headBranch == "main"/)
})

test('acceptance validation rejects missing checklist evidence and not-applicable outcomes without rationale', async () => {
  const validBody = completedAcceptanceBody()
  await assert.doesNotReject(() => runAcceptanceValidator(validBody))
  await assert.rejects(
    runAcceptanceValidator(validBody.replace(
      '- Login expiration: not applicable. Rationale: session remained active',
      '- Login expiration: not applicable. Rationale:'
    )),
    /RELEASE_ACCEPTANCE_NOT_APPLICABLE_RATIONALE_MISSING/
  )
  await assert.rejects(
    runAcceptanceValidator(validBody.replace(
      '- [x] Per-user install completed without elevation.\n',
      ''
    )),
    /RELEASE_ACCEPTANCE_REQUIRED_CHECK_MISSING/
  )
  await assert.rejects(
    runAcceptanceValidator(validBody.replace(
      '- Plan-only remained usable while the managed browser profile was locked: pass',
      '- Plan-only remained usable while the managed browser profile was locked: fail'
    )),
    /RELEASE_ACCEPTANCE_REQUIRED_OUTCOME_INVALID/
  )
  await assert.rejects(
    runAcceptanceValidator(validBody.replace(
      '- Operator: release owner',
      '- Operator:'
    )),
    /RELEASE_ACCEPTANCE_REQUIRED_METADATA_MISSING/
  )
})

function completedAcceptanceBody () {
  return fs.readFileSync('docs/job-agent/release-acceptance/template.md', 'utf8')
    .replace('<version>', '0.2.0')
    .replace('- Distribution version:', '- Distribution version: 0.2.0')
    .replace('- Release tag:', '- Release tag: job-agent-v0.2.0')
    .replace('- Candidate workflow run ID:', '- Candidate workflow run ID: 123456')
    .replace('- Installer SHA-256:', `- Installer SHA-256: ${'d'.repeat(64)}`)
    .replace('- Related issues to close:', '- Related issues to close: none')
    .replace('- Installer SHA-256 verified: pass / fail', '- Installer SHA-256 verified: pass')
    .replace('- Windows edition and build:', '- Windows edition and build: Windows 11')
    .replace('- Browser product and version:', '- Browser product and version: Chrome for Testing 140')
    .replace('- Test environment: clean VM / dedicated machine', '- Test environment: dedicated machine')
    .replace('- Operator:', '- Operator: release owner')
    .replace('- Started at (UTC):', '- Started at (UTC): 2026-07-10T00:00:00Z')
    .replace('- Completed at (UTC):', '- Completed at (UTC): 2026-07-10T01:00:00Z')
    .replaceAll('- [ ]', '- [x]')
    .replace('completed through: online / offline verified archive.', 'completed through: offline verified archive.')
    .replace(
      '- Login expiration: pass / not applicable. Reason/rationale:',
      '- Login expiration: not applicable. Rationale: session remained active'
    )
    .replace(
      '- Safety verification stop: pass / not applicable. Reason/rationale:',
      '- Safety verification stop: not applicable. Rationale: no safety challenge appeared'
    )
    .replace(
      '- Competing process returned `BROWSER_PROFILE_IN_USE`: pass / not applicable. Reason/rationale:',
      '- Competing process returned `BROWSER_PROFILE_IN_USE`: pass. Rationale: public-command gate passed'
    )
    .replace('- Plan-only remained usable while the managed browser profile was locked: pass / fail', '- Plan-only remained usable while the managed browser profile was locked: pass')
    .replace('- No Application Authorization Token was issued or consumed by read-only capture: pass / fail', '- No Application Authorization Token was issued or consumed by read-only capture: pass')
    .replace('- No chat, greeting, upload, application, or verification-bypass action occurred: pass / fail', '- No chat, greeting, upload, application, or verification-bypass action occurred: pass')
    .replace('- Final outcome: pass / fail', '- Final outcome: pass')
    .replace('- Stable reason codes observed:', '- Stable reason codes observed: BROWSER_PROFILE_IN_USE')
    .replace('- Follow-up issues:', '- Follow-up issues: none')
}

async function runAcceptanceValidator (body) {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ggr-release-acceptance-'))
  const fixtureScript = path.join(fixtureRoot, 'gh-fixture.mjs')
  const shellShim = path.join(fixtureRoot, 'gh')
  const cmdShim = path.join(fixtureRoot, 'gh.cmd')
  fs.writeFileSync(fixtureScript, 'process.stdout.write(process.env.GGR_ACCEPTANCE_FIXTURE_JSON)\n')
  fs.writeFileSync(shellShim, `#!/usr/bin/env sh\nexec node "$(dirname "$0")/gh-fixture.mjs" "$@"\n`)
  fs.chmodSync(shellShim, 0o755)
  fs.writeFileSync(cmdShim, '@node "%~dp0\\gh-fixture.mjs" %*\r\n')
  const executable = process.platform === 'win32' ? 'powershell' : 'pwsh'
  const args = [
    '-NoProfile',
    ...(process.platform === 'win32' ? ['-ExecutionPolicy', 'Bypass'] : []),
    '-File', path.resolve('scripts/validate-job-agent-release-acceptance.ps1'),
    '-Repository', 'HSJ-BanFan/geekgeekrun',
    '-IssueNumber', '25',
    '-ReleaseTag', 'job-agent-v0.2.0',
    '-DistributionVersion', '0.2.0',
    '-InstallerSha256', 'd'.repeat(64),
    '-CandidateRunId', '123456',
  ]
  try {
    return await execFileAsync(executable, args, {
      env: {
        ...process.env,
        PATH: `${fixtureRoot}${path.delimiter}${process.env.PATH}`,
        GGR_ACCEPTANCE_FIXTURE_JSON: JSON.stringify({
          number: 25,
          title: 'Job Agent 0.2.0 acceptance',
          body,
          state: 'CLOSED',
          url: 'https://example.invalid/issues/25',
        }),
      },
    })
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true })
  }
}
