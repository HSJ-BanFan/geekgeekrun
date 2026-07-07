import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { getAuthorizationTokenStorePath } from './config.mjs'
import { normalizeJobProfile } from './job-profile.mjs'
import { redactSensitiveFragments } from './sensitive-text.mjs'

const storeVersion = 1
const tokenType = 'application_authorization'
const defaultTtlMs = 10 * 60 * 1000
const jdEvidenceSnippetMaxLength = 160
const jdEvidenceSnippetLimit = 3
const summaryMaxLength = 240
const listLimit = 8
const reasonCode = {
  tokenValid: 'TOKEN_VALID',
  tokenNotFound: 'TOKEN_NOT_FOUND',
  tokenMalformed: 'TOKEN_MALFORMED',
  tokenExpired: 'TOKEN_EXPIRED',
  tokenConsumed: 'TOKEN_CONSUMED',
  tokenUnusable: 'TOKEN_UNUSABLE',
  actionNotAllowed: 'ACTION_NOT_ALLOWED',
}
const jdEvidenceCuePattern = /responsibilit|requirement|qualification|任职|岗位|职位|职责|要求|负责|熟悉|掌握|具备|优先|加分|经验|技术栈|开发|维护|搭建/i

export function issueAuthorizationToken ({
  runId,
  job,
  finalDecision,
  ruleEvaluation,
  llmEvaluation,
  allowedActions,
  ttlMs = defaultTtlMs,
  expiresAt,
  now = new Date(),
  tokenFile,
} = {}) {
  const issuedAt = normalizeDate(now)
  const profile = normalizeJobProfile(job ?? {})
  const normalizedAllowedActions = normalizeAllowedActions(allowedActions)
  const denial = getTokenIssuanceDenial({
    runId,
    profile,
    finalDecision,
    ruleEvaluation,
    llmEvaluation,
    allowedActions: normalizedAllowedActions,
  })
  if (denial) {
    return {
      ok: true,
      issued: false,
      ...denial,
    }
  }

  const token = {
    tokenId: createAuthorizationTokenId(),
    tokenType,
    issuedAt: issuedAt.toISOString(),
    expiresAt: resolveExpiresAt({ issuedAt, ttlMs, expiresAt }).toISOString(),
    runId: String(runId).trim(),
    jobId: profile.jobId,
    allowedActions: normalizedAllowedActions,
    consumption: {
      state: 'unconsumed',
      consumedAt: null,
      consumedByAction: null,
    },
    decisionEvidence: summarizeDecisionEvidence({
      profile,
      finalDecision,
      ruleEvaluation,
      llmEvaluation,
    }),
  }

  const store = readAuthorizationTokenStore({ tokenFile })
  store.tokens.push(token)
  writeAuthorizationTokenStore(store, { tokenFile })

  return {
    ok: true,
    issued: true,
    token,
    tokenFile: resolveTokenFile(tokenFile),
  }
}

export function inspectAuthorizationToken ({
  tokenId,
  tokenFile,
  now = new Date(),
  action,
} = {}) {
  const store = readAuthorizationTokenStore({ tokenFile })
  const token = store.tokens.find(item => item?.tokenId === tokenId)
  const inspectedAt = normalizeDate(now).toISOString()
  if (!token) {
    return {
      ok: true,
      status: 'unusable',
      reasonCode: reasonCode.tokenNotFound,
      inspectedAt,
      token: null,
      tokenFile: resolveTokenFile(tokenFile),
    }
  }

  const status = getTokenStatus(token, { now, action })
  return {
    ok: true,
    ...status,
    inspectedAt,
    token,
    tokenFile: resolveTokenFile(tokenFile),
  }
}

export function consumeAuthorizationToken ({
  tokenId,
  tokenFile,
  now = new Date(),
  action,
} = {}) {
  const store = readAuthorizationTokenStore({ tokenFile })
  const index = store.tokens.findIndex(item => item?.tokenId === tokenId)
  const inspectedAt = normalizeDate(now).toISOString()
  if (index === -1) {
    return {
      ok: true,
      consumed: false,
      status: 'unusable',
      reasonCode: reasonCode.tokenNotFound,
      inspectedAt,
      token: null,
      tokenFile: resolveTokenFile(tokenFile),
    }
  }

  const token = store.tokens[index]
  const status = getTokenStatus(token, { now, action })
  if (status.status !== 'valid') {
    return {
      ok: true,
      consumed: false,
      ...status,
      inspectedAt,
      token,
      tokenFile: resolveTokenFile(tokenFile),
    }
  }

  token.consumption = {
    state: 'consumed',
    consumedAt: inspectedAt,
    consumedByAction: action ? String(action).trim() : null,
  }
  writeAuthorizationTokenStore(store, { tokenFile })
  return {
    ok: true,
    consumed: true,
    status: 'consumed',
    reasonCode: reasonCode.tokenConsumed,
    inspectedAt,
    token,
    tokenFile: resolveTokenFile(tokenFile),
  }
}

export function readAuthorizationTokenStore ({ tokenFile } = {}) {
  const filePath = resolveTokenFile(tokenFile)
  if (!fs.existsSync(filePath)) {
    return { version: storeVersion, tokens: [] }
  }
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  return {
    version: parsed?.version === storeVersion ? parsed.version : storeVersion,
    tokens: Array.isArray(parsed?.tokens) ? parsed.tokens : [],
  }
}

function writeAuthorizationTokenStore (store, { tokenFile } = {}) {
  const filePath = resolveTokenFile(tokenFile)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify({
    version: storeVersion,
    tokens: Array.isArray(store?.tokens) ? store.tokens : [],
  }, null, 2)}\n`, 'utf8')
}

function getTokenIssuanceDenial ({
  runId,
  profile,
  finalDecision,
  ruleEvaluation,
  llmEvaluation,
  allowedActions,
}) {
  if (!String(runId ?? '').trim()) {
    return { reasonCode: 'RUN_ID_MISSING', reason: 'runId is required to issue an Application Authorization Token' }
  }
  if (!profile?.jobId) {
    return { reasonCode: 'JOB_IDENTITY_ANCHOR_MISSING', reason: 'jobId is required as the Job Identity Anchor' }
  }
  if (!allowedActions.length) {
    return { reasonCode: 'ACTION_SET_MISSING', reason: 'at least one allowed action is required' }
  }
  if (!finalDecision || typeof finalDecision !== 'object' || typeof finalDecision.decision !== 'string') {
    return { reasonCode: 'FINAL_DECISION_MALFORMED', reason: 'finalDecision must be a structured decision object' }
  }
  const decision = String(finalDecision.decision).trim().toLowerCase()
  if (decision !== 'apply') {
    return { reasonCode: 'FINAL_DECISION_NOT_APPLY', reason: `final decision is ${decision || 'missing'}` }
  }
  if (String(finalDecision.source ?? '').trim().toLowerCase() !== 'llm') {
    return { reasonCode: 'AUTHORIZATION_NOT_GRANTED_BY_LLM', reason: 'Application Authorization must come from an LLM Apply Decision' }
  }
  if (ruleEvaluation?.hardReject || String(ruleEvaluation?.decision ?? '').trim().toLowerCase() === 'skip') {
    return { reasonCode: 'RULE_BOUNDARY_DENIED', reason: 'Rule Boundary denial cannot receive Application Authorization' }
  }
  if (!isCompleteLlmApplyDecision(llmEvaluation)) {
    return { reasonCode: 'LLM_DECISION_INCOMPLETE', reason: 'LLM Apply Decision is missing required judgment evidence' }
  }
  return null
}

function getTokenStatus (token, { now, action } = {}) {
  if (!isWellFormedTokenRecord(token)) {
    return { status: 'unusable', reasonCode: reasonCode.tokenMalformed }
  }
  if (token.consumption?.state === 'consumed') {
    return { status: 'consumed', reasonCode: reasonCode.tokenConsumed }
  }
  if (Number.isNaN(Date.parse(token.expiresAt)) || new Date(token.expiresAt).getTime() <= normalizeDate(now).getTime()) {
    return { status: 'expired', reasonCode: reasonCode.tokenExpired }
  }
  const requestedAction = String(action ?? '').trim()
  if (requestedAction && !token.allowedActions.includes(requestedAction)) {
    return { status: 'unusable', reasonCode: reasonCode.actionNotAllowed }
  }
  return { status: 'valid', reasonCode: reasonCode.tokenValid }
}

function isWellFormedTokenRecord (token) {
  return Boolean(
    token &&
    token.tokenType === tokenType &&
    typeof token.tokenId === 'string' &&
    token.tokenId &&
    typeof token.runId === 'string' &&
    token.runId &&
    typeof token.jobId === 'string' &&
    token.jobId &&
    Array.isArray(token.allowedActions) &&
    token.allowedActions.length &&
    token.consumption &&
    typeof token.consumption.state === 'string' &&
    typeof token.expiresAt === 'string'
  )
}

function isCompleteLlmApplyDecision (llmEvaluation) {
  const decision = String(llmEvaluation?.decision ?? '').trim().toLowerCase()
  if (decision !== 'apply') return false
  return Boolean(
    hasEvidenceText(llmEvaluation?.resume_fit ?? llmEvaluation?.resumeFit) &&
    hasEvidenceText(llmEvaluation?.intent_fit ?? llmEvaluation?.intentFit) &&
    hasEvidenceText(llmEvaluation?.recall_context ?? llmEvaluation?.recallContext) &&
    hasEvidenceText(
      llmEvaluation?.attention_technology_assessment?.explanation ??
      llmEvaluation?.attentionTechnologyAssessment?.explanation
    )
  )
}

function summarizeDecisionEvidence ({
  profile,
  finalDecision,
  ruleEvaluation,
  llmEvaluation,
}) {
  return {
    job: summarizeJob(profile),
    finalDecision: summarizeFinalDecision(finalDecision),
    ruleEvaluation: summarizeRuleEvaluation(ruleEvaluation),
    llmEvaluation: summarizeLlmEvaluation(llmEvaluation),
  }
}

function summarizeJob (profile) {
  const jdSummary = summarizeJd(profile?.jd)
  return {
    jobId: safeString(profile?.jobId, 120),
    title: safeString(profile?.title, 120),
    company: safeString(profile?.company, 120),
    city: safeString(profile?.city, 80),
    salary: safeString(profile?.salary, 80),
    experience: safeString(profile?.experience, 80),
    degree: safeString(profile?.degree, 80),
    labels: safeStringList(profile?.labels, listLimit, 80),
    jdSummary: jdSummary.summary,
    jdEvidenceSnippets: jdSummary.evidenceSnippets,
    jdOriginalCharacterCount: String(profile?.jd ?? '').length,
    jdOmittedCharacterCount: jdSummary.omittedCharacterCount,
    recallKeyword: safeString(profile?.recallKeyword, 120),
    bossName: safeString(profile?.bossName, 80),
    bossTitle: safeString(profile?.bossTitle, 80),
  }
}

function summarizeFinalDecision (finalDecision) {
  if (!finalDecision || typeof finalDecision !== 'object') return null
  return {
    decision: safeString(finalDecision.decision, 40),
    source: safeString(finalDecision.source, 40),
    reason: safeString(finalDecision.reason, summaryMaxLength),
  }
}

function summarizeRuleEvaluation (ruleEvaluation) {
  if (!ruleEvaluation || typeof ruleEvaluation !== 'object') return null
  return {
    decision: safeString(ruleEvaluation.decision, 40),
    score: safeNumber(ruleEvaluation.score),
    hardReject: Boolean(ruleEvaluation.hardReject),
    requiresLlmFinalDecision: Boolean(ruleEvaluation.requiresLlmFinalDecision),
    reasons: safeStringList(ruleEvaluation.reasons, listLimit, summaryMaxLength),
    profileFit: summarizeProfileFit(ruleEvaluation.profileFit),
    recallKeyword: summarizeRecallKeyword(ruleEvaluation.recallKeyword),
    attentionTechnologyAssessment: summarizeAttentionTechnologyAssessment(ruleEvaluation.attentionTechnologyAssessment),
    greetingPlan: summarizeGreetingPlan(ruleEvaluation.greetingPlan),
  }
}

function summarizeLlmEvaluation (llmEvaluation) {
  if (!llmEvaluation || typeof llmEvaluation !== 'object') return null
  return {
    decision: safeString(llmEvaluation.decision, 40),
    score: safeNumber(llmEvaluation.score),
    category: safeString(llmEvaluation.category, 80),
    reason: safeString(llmEvaluation.reason, summaryMaxLength),
    jdMatchSummary: safeString(llmEvaluation.jd_match_summary ?? llmEvaluation.jdMatchSummary, summaryMaxLength),
    resumeFit: safeString(llmEvaluation.resume_fit ?? llmEvaluation.resumeFit, summaryMaxLength),
    intentFit: safeString(llmEvaluation.intent_fit ?? llmEvaluation.intentFit, summaryMaxLength),
    recallContext: safeString(llmEvaluation.recall_context ?? llmEvaluation.recallContext, summaryMaxLength),
    matchedRequirements: safeStringList(llmEvaluation.matched_requirements ?? llmEvaluation.matchedRequirements, listLimit, 120),
    missingRequirements: safeStringList(llmEvaluation.missing_requirements ?? llmEvaluation.missingRequirements, listLimit, 120),
    riskFlags: safeStringList(llmEvaluation.risk_flags ?? llmEvaluation.riskFlags, listLimit, 120),
    attentionTechnologyAssessment: summarizeAttentionTechnologyAssessment(
      llmEvaluation.attention_technology_assessment ?? llmEvaluation.attentionTechnologyAssessment
    ),
  }
}

function summarizeProfileFit (profileFit) {
  if (!profileFit || typeof profileFit !== 'object') return null
  return {
    intentMatches: safeStringList(profileFit.intentMatches, listLimit, 80),
    resumeMatches: safeStringList(profileFit.resumeMatches, listLimit, 80),
    recallKeywordMatches: safeStringList(profileFit.recallKeywordMatches, listLimit, 80),
  }
}

function summarizeRecallKeyword (recallKeyword) {
  if (!recallKeyword || typeof recallKeyword !== 'object') return null
  return {
    value: safeString(recallKeyword.value, 120),
    tokenMatches: safeNumber(recallKeyword.tokenMatches),
  }
}

function summarizeAttentionTechnologyAssessment (assessment) {
  if (!assessment || typeof assessment !== 'object') return null
  return {
    requiresLlm: typeof assessment.requiresLlm === 'boolean' ? assessment.requiresLlm : undefined,
    isCoreRequired: typeof assessment.is_core_required === 'boolean'
      ? assessment.is_core_required
      : typeof assessment.isCoreRequired === 'boolean'
        ? assessment.isCoreRequired
        : null,
    explanation: safeString(assessment.explanation, summaryMaxLength),
    terms: safeStringList(assessment.terms, listLimit, 80),
    mismatchedCoreRequiredAttentionTechnologies: safeStringList(
      assessment.mismatched_core_required_attention_technologies ?? assessment.mismatchedCoreRequiredAttentionTechnologies,
      listLimit,
      80
    ),
    evidence: summarizeEvidenceList(assessment.evidence),
  }
}

function summarizeGreetingPlan (greetingPlan) {
  if (!greetingPlan || typeof greetingPlan !== 'object') return null
  return {
    source: safeString(greetingPlan.source, 40),
    fallbackReason: safeString(greetingPlan.fallbackReason, 80),
    safeSummary: safeString(greetingPlan.safeSummary ?? greetingPlan.summary, summaryMaxLength),
    characterCount: safeNumber(greetingPlan.characterCount),
    guardPassed: typeof greetingPlan.guardResult?.passed === 'boolean' ? greetingPlan.guardResult.passed : undefined,
    deliveryTextAvailable: typeof greetingPlan.safetyStatus?.deliveryTextAvailable === 'boolean'
      ? greetingPlan.safetyStatus.deliveryTextAvailable
      : undefined,
  }
}

function summarizeEvidenceList (items) {
  if (!Array.isArray(items)) return []
  return items.slice(0, listLimit).map(item => {
    if (typeof item === 'string') return safeString(item, jdEvidenceSnippetMaxLength)
    if (!item || typeof item !== 'object') return safeString(item, jdEvidenceSnippetMaxLength)
    return {
      term: safeString(item.term, 80),
      segment: safeString(item.segment ?? item.snippet, jdEvidenceSnippetMaxLength),
      explanation: safeString(item.explanation, summaryMaxLength),
    }
  })
}

function summarizeJd (text) {
  const normalized = normalizeAuditText(text)
  const evidenceSnippets = extractJdEvidenceSnippets(normalized)
  const summarySource = evidenceSnippets.length
    ? evidenceSnippets.join(' ')
    : splitJdSegments(normalized).slice(0, 1).join(' ')
  const summary = safeString(summarySource, summaryMaxLength)
  return {
    summary,
    evidenceSnippets,
    omittedCharacterCount: Math.max(0, normalized.length - summary.length),
  }
}

function extractJdEvidenceSnippets (text) {
  const segments = splitJdSegments(text)
  const prioritized = segments.filter(segment => jdEvidenceCuePattern.test(segment))
  const snippets = []
  const seen = new Set()
  const candidates = prioritized.length ? prioritized : segments.slice(0, 1)
  for (const segment of candidates) {
    const snippet = safeString(segment, jdEvidenceSnippetMaxLength)
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
    .map(item => safeString(item, jdEvidenceSnippetMaxLength))
    .filter(Boolean)
}

function normalizeAllowedActions (actions) {
  const source = Array.isArray(actions) ? actions : actions == null ? [] : [actions]
  const seen = new Set()
  const result = []
  for (const action of source.flatMap(item => String(item ?? '').split(','))) {
    const key = action.trim()
    if (!key || seen.has(key)) continue
    seen.add(key)
    result.push(key)
  }
  return result
}

function resolveExpiresAt ({ issuedAt, ttlMs, expiresAt }) {
  if (expiresAt) return normalizeDate(expiresAt)
  const normalizedTtlMs = Number.isFinite(Number(ttlMs)) && Number(ttlMs) > 0
    ? Number(ttlMs)
    : defaultTtlMs
  return new Date(issuedAt.getTime() + normalizedTtlMs)
}

function normalizeDate (value) {
  const date = value instanceof Date ? value : new Date(value ?? Date.now())
  if (Number.isNaN(date.getTime())) throw new Error(`INVALID_DATE:${value}`)
  return date
}

function createAuthorizationTokenId () {
  return `aat_${crypto.randomBytes(18).toString('base64url')}`
}

function resolveTokenFile (tokenFile) {
  return tokenFile ? path.resolve(String(tokenFile)) : getAuthorizationTokenStorePath()
}

function safeStringList (items, limit, maxLength) {
  if (!Array.isArray(items)) return []
  return items
    .slice(0, limit)
    .map(item => safeString(item, maxLength))
    .filter(Boolean)
}

function safeString (value, maxLength) {
  if (value == null) return ''
  return clipText(redactSensitiveFragments(String(value)), maxLength)
}

function safeNumber (value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function hasEvidenceText (value) {
  if (typeof value === 'string') return Boolean(value.trim())
  if (!value || typeof value !== 'object') return false
  return Object.values(value).some(item => {
    if (Array.isArray(item)) return item.length > 0
    if (typeof item === 'string') return Boolean(item.trim())
    return item != null
  })
}

function normalizeAuditText (text) {
  return String(text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function clipText (text, maxLength) {
  const normalized = normalizeAuditText(text).replace(/\s+/g, ' ')
  if (!Number.isFinite(maxLength) || normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`
}
