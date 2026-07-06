import fs from 'node:fs'
import path from 'node:path'
import { getAuditLogPath } from './config.mjs'

const redactedValue = '[REDACTED]'
const jdSummaryMaxLength = 240
const jdEvidenceSnippetMaxLength = 160
const jdEvidenceSnippetLimit = 3
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
const jdTextKeys = new Set([
  'jd',
  'jobdescription',
  'postdescription',
  'positiondescription',
  'jobdetail',
  'jobdetails',
  'positiondetail',
])
const possibleJdTextKeys = new Set([
  'description',
  'detail',
])
const evidenceSnippetKeys = new Set([
  'segment',
  'snippet',
])
const jdEvidenceCuePattern = /responsibilit|requirement|qualification|任职|岗位|职位|职责|要求|负责|熟悉|掌握|具备|优先|加分|经验|技术栈|开发|维护|搭建/i

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
  candidateProfile,
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
    candidateProfile,
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
    if (typeof item === 'string' && isJdTextKey(key, item)) {
      output[key] = summarizeJdForAudit(item)
      continue
    }
    if (typeof item === 'string' && isEvidenceSnippetKey(key)) {
      output[key] = clipAuditText(item, jdEvidenceSnippetMaxLength)
      continue
    }
    output[key] = sanitizeForAudit(item, seen)
  }
  return output
}

function isSensitiveKey (key) {
  const normalized = normalizeAuditKey(key)
  return sensitiveExactKeys.has(normalized) ||
    normalized.endsWith('secret') ||
    normalized.endsWith('apikey') ||
    normalized.endsWith('token') ||
    normalized.includes('cookie')
}

function isJdTextKey (key, value) {
  const normalized = normalizeAuditKey(key)
  return jdTextKeys.has(normalized) ||
    (possibleJdTextKeys.has(normalized) && looksLikeJdText(value))
}

function isEvidenceSnippetKey (key) {
  return evidenceSnippetKeys.has(normalizeAuditKey(key))
}

function normalizeAuditKey (key) {
  return String(key).replace(/[^a-z0-9_]/gi, '').toLowerCase()
}

function summarizeProfile (profile) {
  if (!profile) return null
  const jdAudit = summarizeJdForAudit(profile.jd)
  return {
    jobId: profile.jobId,
    title: profile.title,
    company: profile.company,
    city: profile.city,
    salary: profile.salary,
    experience: profile.experience,
    degree: profile.degree,
    labels: profile.labels,
    jdSummary: jdAudit.summary,
    jdEvidenceSnippets: jdAudit.evidenceSnippets,
    jdOriginalCharacterCount: jdAudit.originalCharacterCount,
    jdOmittedCharacterCount: jdAudit.omittedCharacterCount,
    sourceKeyword: profile.sourceKeyword,
    bossName: profile.bossName,
    bossTitle: profile.bossTitle,
  }
}

function summarizeJdForAudit (text) {
  const original = String(text ?? '')
  const normalized = normalizeAuditText(original)
  return {
    summary: clipAuditText(normalized, jdSummaryMaxLength),
    evidenceSnippets: extractJdEvidenceSnippets(normalized),
    originalCharacterCount: original.length,
    omittedCharacterCount: Math.max(0, normalized.length - jdSummaryMaxLength),
  }
}

function extractJdEvidenceSnippets (text) {
  const segments = splitJdSegments(text)
  const prioritized = segments.filter(segment => jdEvidenceCuePattern.test(segment))
  const snippets = []
  const seen = new Set()
  for (const segment of [...prioritized, ...segments]) {
    const snippet = clipAuditText(segment, jdEvidenceSnippetMaxLength)
    const key = snippet.toLowerCase()
    if (!snippet || seen.has(key)) continue
    seen.add(key)
    snippets.push(snippet)
    if (snippets.length >= jdEvidenceSnippetLimit) return snippets
  }
  return snippets
}

function splitJdSegments (text) {
  return normalizeAuditText(text)
    .split(/[\r\n。；;，,.!！?？]+/)
    .map(item => clipAuditText(item, jdEvidenceSnippetMaxLength))
    .filter(Boolean)
}

function looksLikeJdText (text) {
  const normalized = normalizeAuditText(text)
  return normalized.length > jdSummaryMaxLength || jdEvidenceCuePattern.test(normalized)
}

function normalizeAuditText (text) {
  return String(text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function clipAuditText (text, maxLength) {
  const normalized = normalizeAuditText(text).replace(/\s+/g, ' ')
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`
}
