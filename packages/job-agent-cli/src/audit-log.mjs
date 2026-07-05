import fs from 'node:fs'
import path from 'node:path'
import { getAuditLogPath } from './config.mjs'

const redactedValue = '[REDACTED]'
const sensitiveExactKeys = new Set([
  'apikey',
  'api_key',
  'authorization',
  'greetingmessage',
  'imagepath',
  'localstorage',
  'password',
  'providerapisecret',
  'resumeimagepath',
  'secret',
  'token',
])

export function createRunId () {
  return `job-agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export function appendAuditLog (entry, { auditFile } = {}) {
  const filePath = auditFile || getAuditLogPath()
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const record = sanitizeForAudit({
    timestamp: new Date().toISOString(),
    ...entry,
  })
  fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, 'utf8')
  return {
    dryRun: false,
    auditFile: filePath,
    record,
  }
}

export function buildAuditRecord ({
  runId,
  command,
  dryRun,
  extraction,
  profile,
  ruleEvaluation,
  llmEvaluation,
  finalDecision,
  actions = [],
  errors = [],
}) {
  return {
    runId,
    command,
    dryRun: Boolean(dryRun),
    extraction: extraction
      ? {
          source: extraction.source,
          rawUrl: extraction.raw?.url,
          pageQuery: extraction.raw?.pageQuery,
        }
      : null,
    profile: summarizeProfile(profile ?? extraction?.profile),
    ruleEvaluation,
    llmEvaluation,
    finalDecision,
    actions,
    errors,
  }
}

export function sanitizeForAudit (value, seen = new WeakSet()) {
  if (value == null) return value
  if (typeof value !== 'object') return value
  if (seen.has(value)) return '[Circular]'
  seen.add(value)
  if (Array.isArray(value)) {
    return value.map(item => sanitizeForAudit(item, seen))
  }
  const output = {}
  for (const [key, item] of Object.entries(value)) {
    if (isSensitiveKey(key)) {
      output[key] = redactedValue
      continue
    }
    output[key] = sanitizeForAudit(item, seen)
  }
  return output
}

function isSensitiveKey (key) {
  const normalized = String(key).replace(/[^a-z0-9_]/gi, '').toLowerCase()
  return sensitiveExactKeys.has(normalized) ||
    normalized.endsWith('secret') ||
    normalized.endsWith('apikey') ||
    normalized.endsWith('token') ||
    normalized.includes('cookie')
}

function summarizeProfile (profile) {
  if (!profile) return null
  return {
    jobId: profile.jobId,
    title: profile.title,
    company: profile.company,
    city: profile.city,
    salary: profile.salary,
    experience: profile.experience,
    degree: profile.degree,
    labels: profile.labels,
    jd: profile.jd,
    sourceKeyword: profile.sourceKeyword,
    bossName: profile.bossName,
    bossTitle: profile.bossTitle,
  }
}
