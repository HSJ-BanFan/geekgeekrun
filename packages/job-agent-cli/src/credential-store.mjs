import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const helperPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'windows-credential.ps1')
const credentialTargetPattern = /^GeekGeekRun\/JobAgent\/[A-Za-z0-9._-]+$/

export function createWindowsCredentialStore ({
  platform = process.platform,
  spawnSyncImpl = spawnSync,
} = {}) {
  return {
    set ({ target, secret }) {
      if (platform !== 'win32') return unavailable()
      return invokeHelper({ action: 'set', target, secret, spawnSyncImpl })
    },
    get ({ target }) {
      if (platform !== 'win32') return unavailable()
      const result = invokeHelper({ action: 'get', target, spawnSyncImpl })
      if (!result.ok) return result
      try {
        return {
          ok: true,
          exists: true,
          reasonCode: null,
          secret: Buffer.from(result.secretBase64, 'base64').toString('utf8'),
        }
      } catch {
        return { ok: false, exists: true, reasonCode: 'CREDENTIAL_RESPONSE_INVALID' }
      }
    },
    exists ({ target }) {
      if (platform !== 'win32') return unavailable()
      return invokeHelper({ action: 'exists', target, spawnSyncImpl })
    },
    delete ({ target }) {
      if (platform !== 'win32') return unavailable()
      return invokeHelper({ action: 'delete', target, spawnSyncImpl })
    },
  }
}

function invokeHelper ({ action, target, secret = '', spawnSyncImpl }) {
  if (!['set', 'get', 'exists', 'delete'].includes(action)) {
    return { ok: false, exists: false, reasonCode: 'CREDENTIAL_ACTION_INVALID' }
  }
  if (!isValidWindowsCredentialTarget(target)) {
    return { ok: false, exists: false, reasonCode: 'CREDENTIAL_TARGET_INVALID' }
  }
  const powershellPath = path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  )
  const completed = spawnSyncImpl(powershellPath, [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-File', helperPath,
    '-Action', action,
    '-Target', target,
  ], {
    input: secret,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  })
  const parsed = parseResponse(completed.stdout)
  if (completed.status === 0 && parsed) {
    return { reasonCode: null, ...parsed }
  }
  return {
    ok: false,
    exists: parsed?.exists ?? false,
    reasonCode: parsed?.reasonCode ?? 'CREDENTIAL_STORE_OPERATION_FAILED',
  }
}

export function isValidWindowsCredentialTarget (value) {
  return credentialTargetPattern.test(String(value ?? ''))
}

export function parseWindowsCredentialReference (value) {
  const reference = String(value ?? '').trim()
  if (!reference.startsWith('windows-credential:')) return null
  const target = reference.slice('windows-credential:'.length)
  return isValidWindowsCredentialTarget(target) ? target : null
}

function parseResponse (value) {
  try {
    return JSON.parse(String(value ?? '').trim())
  } catch {
    return null
  }
}

function unavailable () {
  return { ok: false, exists: false, reasonCode: 'CREDENTIAL_STORE_UNAVAILABLE' }
}
