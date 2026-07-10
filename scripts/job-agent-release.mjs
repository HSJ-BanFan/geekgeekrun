import { execFileSync } from 'node:child_process'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const sha256Pattern = /^[a-f0-9]{64}$/

export function createReleasePlan ({ version, acceptanceIssue, closeIssues = '' }) {
  const normalizedVersion = String(version ?? '').trim()
  const match = normalizedVersion.match(versionPattern)
  if (!match) throw new Error('JOB_AGENT_RELEASE_VERSION_INVALID')

  const acceptanceIssueNumber = parseIssueNumber(acceptanceIssue)
  const relatedIssues = parseIssueNumbers(closeIssues)
    .filter(issueNumber => issueNumber !== acceptanceIssueNumber)

  return {
    schemaVersion: 'job-agent-release-plan.v1',
    version: normalizedVersion,
    releaseTag: `job-agent-v${normalizedVersion}`,
    acceptanceIssue: acceptanceIssueNumber,
    relatedIssues,
    prerelease: Number(match[1]) === 0 || normalizedVersion.includes('-'),
  }
}

export function updateAcceptanceRecord (body, {
  plan,
  candidateRunId,
  installerSha256,
}) {
  const normalizedRunId = String(candidateRunId ?? '').trim()
  const normalizedHash = String(installerSha256 ?? '').trim().toLowerCase()
  if (!/^\d+$/.test(normalizedRunId)) throw new Error('JOB_AGENT_RELEASE_RUN_ID_INVALID')
  if (!sha256Pattern.test(normalizedHash)) throw new Error('JOB_AGENT_RELEASE_INSTALLER_HASH_INVALID')

  let updated = String(body ?? '')
  updated = replaceMetadataLine(updated, 'Distribution version', plan.version)
  updated = replaceMetadataLine(updated, 'Release tag', plan.releaseTag)
  updated = replaceMetadataLine(updated, 'Candidate workflow run ID', normalizedRunId)
  updated = replaceMetadataLine(updated, 'Installer SHA-256', normalizedHash)
  if (plan.relatedIssues.length > 0) {
    updated = replaceOrInsertRelatedIssues(updated, plan.relatedIssues)
  }
  return updated
}

export function extractRelatedIssueNumbers ({
  body,
  explicitCloseIssues = '',
  acceptanceIssue,
}) {
  const source = String(body ?? '')
  const issueNumbers = []
  const relatedMatch = source.match(/^[ \t]*- Related issues to close:[ \t]*(.*?)[ \t]*$/mi)
  if (relatedMatch?.[1]) issueNumbers.push(...parseIssueNumbers(relatedMatch[1]))
  issueNumbers.push(...parseIssueNumbers(explicitCloseIssues))

  const acceptanceIssueNumber = parseIssueNumber(acceptanceIssue)
  return [...new Set(issueNumbers)]
    .filter(issueNumber => issueNumber !== acceptanceIssueNumber)
    .sort((left, right) => left - right)
}

export function buildCandidateRecordComment ({
  plan,
  repository,
  candidateRunId,
  installerSha256,
}) {
  const normalizedHash = String(installerSha256).toLowerCase()
  return `<!-- job-agent-release-candidate:${plan.releaseTag} -->
Job Agent release candidate is ready for human acceptance.

- Release tag: \`${plan.releaseTag}\`
- Candidate workflow: https://github.com/${repository}/actions/runs/${candidateRunId}
- Installer SHA-256: \`${normalizedHash}\`

Complete the non-sensitive acceptance record, close this issue with \`Final outcome: pass\`, then approve the \`job-agent-release\` environment deployment. The same tested candidate will be published; no second workflow dispatch is required.`
}

export function buildFinalReleaseComment ({
  plan,
  releaseUrl,
  workflowUrl,
  assets,
}) {
  const assetLines = [...(assets ?? [])]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(asset => `- ${asset.name}: \`${asset.digest ?? 'digest unavailable'}\``)
    .join('\n')

  return `<!-- job-agent-release-finalized:${plan.releaseTag} -->
Job Agent release automation completed successfully.

- Release: ${releaseUrl}
- Workflow: ${workflowUrl}
- Acceptance issue: #${plan.acceptanceIssue}

Published assets:
${assetLines || '- No assets reported.'}`
}

export function assertReleaseBindings ({ releaseBody, acceptanceBody, repository, plan }) {
  const normalizedReleaseBody = String(releaseBody ?? '')
  const acceptanceUrl = `https://github.com/${repository}/issues/${plan.acceptanceIssue}`
  if (!normalizedReleaseBody.includes(acceptanceUrl)) {
    throw new Error('JOB_AGENT_RELEASE_ACCEPTANCE_MISMATCH')
  }
  const candidateRunId = normalizedReleaseBody.match(/actions\/runs\/(\d+)/)?.[1]
  const acceptanceCandidateRun = String(acceptanceBody ?? '').match(/^\s*- Candidate workflow run ID:\s*(\d+)\s*$/mi)?.[1]
  if (!candidateRunId || !acceptanceCandidateRun) {
    throw new Error('JOB_AGENT_RELEASE_CANDIDATE_RUN_MISSING')
  }
  if (candidateRunId !== acceptanceCandidateRun) {
    throw new Error('JOB_AGENT_RELEASE_CANDIDATE_RUN_MISMATCH')
  }
  return { acceptanceUrl, candidateRunId }
}

function parseIssueNumber (value) {
  const normalized = String(value ?? '').trim()
  if (!/^[1-9]\d*$/.test(normalized)) throw new Error('JOB_AGENT_RELEASE_ISSUE_INVALID')
  return Number(normalized)
}

function parseIssueNumbers (value) {
  const normalized = String(value ?? '').trim()
  if (!normalized || /^none$/i.test(normalized)) return []
  const tokens = normalized.split(/[\s,]+/).filter(Boolean)
  const issueNumbers = tokens.map(token => {
    if (!/^#?[1-9]\d*$/.test(token)) {
      throw new Error('JOB_AGENT_RELEASE_ISSUE_LIST_INVALID')
    }
    return Number(token.replace(/^#/, ''))
  })
  return [...new Set(issueNumbers)]
}

function replaceMetadataLine (body, label, value) {
  const pattern = new RegExp(`^[ \\t]*- ${escapeRegex(label)}:[ \\t]*.*$`, 'mi')
  if (!pattern.test(body)) throw new Error(`JOB_AGENT_RELEASE_ACCEPTANCE_FIELD_MISSING:${label}`)
  return body.replace(pattern, `- ${label}: ${value}`)
}

function replaceOrInsertRelatedIssues (body, issueNumbers) {
  const value = issueNumbers.map(issueNumber => `#${issueNumber}`).join(', ')
  const pattern = /^[ \t]*- Related issues to close:[ \t]*.*$/mi
  if (pattern.test(body)) return body.replace(pattern, `- Related issues to close: ${value}`)
  const candidateLine = /^[ \t]*- Candidate workflow run ID:[ \t]*.*$/mi
  if (!candidateLine.test(body)) {
    throw new Error('JOB_AGENT_RELEASE_ACCEPTANCE_FIELD_MISSING:Related issues to close')
  }
  return body.replace(candidateLine, match => `${match}\n- Related issues to close: ${value}`)
}

function escapeRegex (value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function parseCliOptions (args) {
  const options = {}
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]
    if (!token.startsWith('--')) throw new Error(`JOB_AGENT_RELEASE_ARGUMENT_INVALID:${token}`)
    const name = token.slice(2)
    const value = args[index + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`JOB_AGENT_RELEASE_ARGUMENT_MISSING:${name}`)
    }
    options[name] = value
    index += 1
  }
  return options
}

function requireOption (options, name) {
  if (!options[name]) throw new Error(`JOB_AGENT_RELEASE_ARGUMENT_MISSING:${name}`)
  return options[name]
}

function runGh (args, { json = false } = {}) {
  let stdout
  try {
    stdout = execFileSync('gh', args, {
      encoding: 'utf8',
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    const stderr = String(error.stderr ?? '').trim()
    throw new Error(`JOB_AGENT_RELEASE_GITHUB_COMMAND_FAILED:${stderr || args.join(' ')}`)
  }
  return json ? JSON.parse(stdout) : stdout.trim()
}

function readIssue (repository, issueNumber) {
  return runGh([
    'issue', 'view', String(issueNumber),
    '--repo', repository,
    '--json', 'number,title,body,state,url',
  ], { json: true })
}

function upsertIssueComment ({ repository, issueNumber, marker, body }) {
  const pages = runGh([
    'api', `repos/${repository}/issues/${issueNumber}/comments`,
    '--paginate', '--slurp',
  ], { json: true })
  const comments = pages.flat()
  const existing = comments.find(comment => String(comment.body ?? '').includes(marker))
  if (existing) {
    runGh([
      'api', '--method', 'PATCH',
      `repos/${repository}/issues/comments/${existing.id}`,
      '-f', `body=${body}`,
    ])
    return 'updated'
  }
  runGh([
    'issue', 'comment', String(issueNumber),
    '--repo', repository,
    '--body', body,
  ])
  return 'created'
}

function recordCandidate ({
  repository,
  plan,
  candidateRunId,
  installerSha256,
}) {
  const issue = readIssue(repository, plan.acceptanceIssue)
  const updatedBody = updateAcceptanceRecord(issue.body, {
    plan,
    candidateRunId,
    installerSha256,
  })
  if (issue.state === 'CLOSED' && updatedBody !== issue.body) {
    throw new Error('JOB_AGENT_RELEASE_CLOSED_ACCEPTANCE_MISMATCH')
  }
  if (issue.state === 'OPEN' && updatedBody !== issue.body) {
    runGh([
      'issue', 'edit', String(plan.acceptanceIssue),
      '--repo', repository,
      '--body', updatedBody,
    ])
  }
  const comment = buildCandidateRecordComment({
    plan,
    repository,
    candidateRunId,
    installerSha256,
  })
  const commentAction = upsertIssueComment({
    repository,
    issueNumber: plan.acceptanceIssue,
    marker: `<!-- job-agent-release-candidate:${plan.releaseTag} -->`,
    body: comment,
  })
  return {
    ok: true,
    command: 'record-candidate',
    acceptanceIssue: plan.acceptanceIssue,
    acceptanceUrl: issue.url,
    candidateRunId: String(candidateRunId),
    installerSha256: String(installerSha256).toLowerCase(),
    commentAction,
  }
}

function finalizeRelease ({ repository, plan, explicitCloseIssues, workflowUrl }) {
  const release = runGh([
    'release', 'view', plan.releaseTag,
    '--repo', repository,
    '--json', 'url,isDraft,isPrerelease,tagName,body,assets',
  ], { json: true })
  if (release.isDraft || release.tagName !== plan.releaseTag) {
    throw new Error('JOB_AGENT_RELEASE_NOT_PUBLISHED')
  }
  if (Boolean(release.isPrerelease) !== plan.prerelease) {
    throw new Error('JOB_AGENT_RELEASE_PRERELEASE_STATE_INVALID')
  }

  const acceptance = readIssue(repository, plan.acceptanceIssue)
  if (acceptance.state !== 'CLOSED') throw new Error('JOB_AGENT_RELEASE_ACCEPTANCE_NOT_CLOSED')
  assertReleaseBindings({ releaseBody: release.body, acceptanceBody: acceptance.body, repository, plan })
  const relatedIssues = extractRelatedIssueNumbers({
    body: acceptance.body,
    explicitCloseIssues,
    acceptanceIssue: plan.acceptanceIssue,
  })
  const comment = buildFinalReleaseComment({
    plan,
    releaseUrl: release.url,
    workflowUrl,
    assets: release.assets,
  })
  const marker = `<!-- job-agent-release-finalized:${plan.releaseTag} -->`
  upsertIssueComment({
    repository,
    issueNumber: plan.acceptanceIssue,
    marker,
    body: comment,
  })

  const closedIssues = []
  const alreadyClosedIssues = []
  for (const issueNumber of relatedIssues) {
    const issue = readIssue(repository, issueNumber)
    upsertIssueComment({ repository, issueNumber, marker, body: comment })
    if (issue.state === 'OPEN') {
      runGh([
        'issue', 'close', String(issueNumber),
        '--repo', repository,
        '--reason', 'completed',
      ])
      closedIssues.push(issueNumber)
    } else {
      alreadyClosedIssues.push(issueNumber)
    }
  }

  return {
    ok: true,
    command: 'finalize',
    releaseTag: plan.releaseTag,
    releaseUrl: release.url,
    acceptanceIssue: plan.acceptanceIssue,
    closedIssues,
    alreadyClosedIssues,
  }
}

function writeJson (value) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

function main () {
  const [command, ...args] = process.argv.slice(2)
  const options = parseCliOptions(args)
  if (command === 'plan') {
    writeJson(createReleasePlan({
      version: requireOption(options, 'version'),
      acceptanceIssue: requireOption(options, 'acceptance-issue'),
      closeIssues: options['close-issues'] ?? '',
    }))
    return
  }

  const repository = requireOption(options, 'repository')
  const plan = createReleasePlan({
    version: requireOption(options, 'version'),
    acceptanceIssue: requireOption(options, 'acceptance-issue'),
    closeIssues: options['close-issues'] ?? '',
  })
  if (command === 'record-candidate') {
    writeJson(recordCandidate({
      repository,
      plan,
      candidateRunId: requireOption(options, 'run-id'),
      installerSha256: requireOption(options, 'installer-sha256'),
    }))
    return
  }
  if (command === 'finalize') {
    writeJson(finalizeRelease({
      repository,
      plan,
      explicitCloseIssues: options['close-issues'] ?? '',
      workflowUrl: requireOption(options, 'workflow-url'),
    }))
    return
  }
  throw new Error(`JOB_AGENT_RELEASE_COMMAND_UNSUPPORTED:${command ?? ''}`)
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : ''
if (import.meta.url === invokedPath) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error.message })}\n`)
    process.exitCode = 1
  }
}
