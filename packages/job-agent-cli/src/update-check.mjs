import { versionReport } from './distribution.mjs'

const officialReleaseApi = 'https://api.github.com/repos/HSJ-BanFan/geekgeekrun/releases?per_page=50'

export async function runUpdateCommand (runtimeContext, args) {
  const action = args[0] ?? 'check'
  if (action !== 'check') {
    return {
      ok: false,
      command: 'update',
      action,
      mutating: false,
      reasonCode: 'UPDATE_ACTION_UNSUPPORTED',
      availableActions: ['check'],
    }
  }
  return await checkForUpdates({
    currentVersion: versionReport(runtimeContext).distribution.version,
  })
}

export async function checkForUpdates ({
  currentVersion,
  fetchImpl = fetch,
  releaseApiUrl = officialReleaseApi,
} = {}) {
  let response
  try {
    response = await fetchImpl(releaseApiUrl, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'geekgeekrun-job-agent-update-check',
      },
    })
  } catch {
    return updateFailure('UPDATE_CHECK_NETWORK_FAILED')
  }
  if (!response?.ok) return updateFailure('UPDATE_CHECK_HTTP_FAILED')

  let releases
  try {
    releases = await response.json()
  } catch {
    return updateFailure('UPDATE_METADATA_INVALID')
  }
  if (!Array.isArray(releases)) return updateFailure('UPDATE_METADATA_INVALID')

  const candidates = releases
    .filter(release => release && !release.draft)
    .map(release => ({
      ...release,
      version: String(release.tag_name ?? '').match(/^job-agent-v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/)?.[1] ?? '',
    }))
    .filter(release => release.version)
    .sort((left, right) => compareVersions(right.version, left.version))
  const latest = candidates[0] ?? null

  return {
    ok: true,
    command: 'update',
    action: 'check',
    schemaVersion: 'job-agent-update-check.v1',
    mutating: false,
    currentVersion: String(currentVersion),
    latestVersion: latest?.version ?? null,
    updateAvailable: Boolean(latest && compareVersions(latest.version, currentVersion) > 0),
    release: latest
      ? {
          tag: latest.tag_name,
          version: latest.version,
          prerelease: Boolean(latest.prerelease),
          publishedAt: latest.published_at ?? null,
          url: latest.html_url ?? null,
        }
      : null,
    reasonCode: latest ? null : 'JOB_AGENT_RELEASE_NOT_FOUND',
  }
}

function compareVersions (left, right) {
  const leftParts = versionParts(left)
  const rightParts = versionParts(right)
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index]
  }
  if (leftParts[3] === rightParts[3]) return 0
  if (!leftParts[3]) return 1
  if (!rightParts[3]) return -1
  return leftParts[3].localeCompare(rightParts[3], 'en')
}

function versionParts (value) {
  const match = String(value ?? '').match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/)
  return match
    ? [Number(match[1]), Number(match[2]), Number(match[3]), match[4] ?? '']
    : [0, 0, 0, 'invalid']
}

function updateFailure (reasonCode) {
  return {
    ok: false,
    command: 'update',
    action: 'check',
    schemaVersion: 'job-agent-update-check.v1',
    mutating: false,
    reasonCode,
    nextActions: ['Check network access and retry; other Job Agent commands remain available'],
  }
}
