import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

export function validateCdpEndpoint (value, { allowRemote = false } = {}) {
  let endpoint
  try {
    endpoint = new URL(String(value ?? '').trim())
  } catch {
    throw browserRuntimeError('CDP_ENDPOINT_INVALID', 'CDP endpoint must be a valid HTTP or WebSocket URL')
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(endpoint.protocol)) {
    throw browserRuntimeError('CDP_ENDPOINT_PROTOCOL_UNSUPPORTED', 'CDP endpoint must use HTTP, HTTPS, WS, or WSS')
  }
  if (endpoint.username || endpoint.password) {
    throw browserRuntimeError(
      'CDP_ENDPOINT_CREDENTIALS_FORBIDDEN',
      'CDP endpoint credentials are not accepted in command-line URLs'
    )
  }
  const loopback = isLoopbackHost(endpoint.hostname)
  if (!loopback && !allowRemote) {
    throw browserRuntimeError(
      'REMOTE_CDP_REJECTED',
      'Remote CDP endpoints require the explicit --allow-remote-cdp high-risk option'
    )
  }
  return {
    endpoint: endpoint.toString(),
    connectionMode: loopback ? 'loopback' : 'remote-high-risk',
    highRisk: !loopback,
  }
}

export function acquireBrowserProfileLock (runtimeContext, {
  pid = process.pid,
  now = new Date(),
  isProcessAlive = defaultIsProcessAlive,
} = {}) {
  fs.mkdirSync(runtimeContext.browserRoot, { recursive: true })
  const lockPath = path.join(runtimeContext.browserRoot, 'profile.lock')
  const lockId = crypto.randomUUID()
  const record = {
    schemaVersion: 'job-agent-browser-profile-lock.v1',
    pid,
    lockId,
    acquiredAt: now.toISOString(),
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = fs.openSync(lockPath, 'wx')
      try {
        fs.writeFileSync(descriptor, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
      } finally {
        fs.closeSync(descriptor)
      }
      return {
        path: lockPath,
        record,
        release: releaseOnce(lockPath, lockId),
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      const owner = readLockRecord(lockPath)
      if (owner?.pid && isProcessAlive(Number(owner.pid))) {
        throw browserRuntimeError(
          'BROWSER_PROFILE_IN_USE',
          'The managed browser profile is already owned by another Job Agent process'
        )
      }
      fs.rmSync(lockPath, { force: true })
    }
  }

  throw browserRuntimeError('BROWSER_PROFILE_LOCK_FAILED', 'The managed browser profile lock could not be acquired')
}

export function browserRuntimeError (reasonCode, message) {
  const error = new Error(message)
  error.reasonCode = reasonCode
  return error
}

function isLoopbackHost (value) {
  const host = String(value ?? '').replace(/^\[|\]$/g, '').toLowerCase()
  if (host === 'localhost' || host === '::1') return true
  return /^127(?:\.\d{1,3}){3}$/.test(host)
}

function defaultIsProcessAlive (pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

function readLockRecord (lockPath) {
  try {
    return JSON.parse(fs.readFileSync(lockPath, 'utf8'))
  } catch {
    return null
  }
}

function releaseOnce (lockPath, lockId) {
  let released = false
  return () => {
    if (released) return
    released = true
    const current = readLockRecord(lockPath)
    if (current?.lockId === lockId) fs.rmSync(lockPath, { force: true })
  }
}
