import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { storageFilePath } from '@geekgeekrun/geek-auto-start-chat-with-boss/runtime-file-utils.mjs'
import { completes } from '@geekgeekrun/utils/gpt-request.mjs'
import {
  getDefaultGreeting,
  getEnabledLlmConfig,
  getGreetingRules,
  getResumeImagePath,
} from './config.mjs'
import { limitResumeMarkdown, summarizeCandidateProfile } from './candidate-profile.mjs'
import { extractSensitiveFragments, redactSensitiveFragments } from './sensitive-text.mjs'

export const CAPABILITY_PROFILE_SCHEMA_VERSION = 'candidate-capability-profile.v1'
export const CAPABILITY_PROFILE_PROMPT_VERSION = 'candidate-capability-profile.prompt.v1'

const cacheFileName = 'candidate-capability-profile.json'
const listLimit = 12
const summaryListLimit = 8
const summaryTextLimit = 320

export function getCapabilityProfileCachePath ({
  storageDir = storageFilePath,
  cacheFilePath,
} = {}) {
  return cacheFilePath || path.join(storageDir, cacheFileName)
}

export function readCapabilityProfileCache (options = {}) {
  const cachePath = getCapabilityProfileCachePath(options)
  if (!fs.existsSync(cachePath)) return null
  try {
    return JSON.parse(fs.readFileSync(cachePath, 'utf8'))
  } catch {
    return null
  }
}

export function inspectCapabilityProfileCache ({
  bossConfig = {},
  candidateProfile = null,
  storageDir = storageFilePath,
  cacheFilePath,
  schemaVersion = CAPABILITY_PROFILE_SCHEMA_VERSION,
  promptVersion = CAPABILITY_PROFILE_PROMPT_VERSION,
} = {}) {
  const resolvedCachePath = getCapabilityProfileCachePath({ storageDir, cacheFilePath })
  const cache = readCapabilityProfileCache({ cacheFilePath: resolvedCachePath })
  const currentSourceFingerprints = buildSourceFingerprints({ bossConfig, candidateProfile })
  const currentMetadata = {
    schemaVersion,
    promptVersion,
    sourceFingerprints: currentSourceFingerprints,
  }

  if (!cache) {
    return {
      exists: false,
      fresh: false,
      reasons: ['cache_missing'],
      cacheFilePath: resolvedCachePath,
      currentMetadata,
      metadata: null,
      summary: null,
    }
  }

  const reasons = getStaleReasons({
    cache,
    currentSourceFingerprints,
    schemaVersion,
    promptVersion,
  })

  return {
    exists: true,
    fresh: reasons.length === 0,
    reasons,
    cacheFilePath: resolvedCachePath,
    currentMetadata,
    metadata: summarizeCacheMetadata(cache),
    summary: summarizeCapabilityProfileCache(cache),
  }
}

export async function buildOrRefreshCapabilityProfile ({
  bossConfig = {},
  candidateProfile = null,
  llmConfig = [],
  forceRefresh = false,
  storageDir = storageFilePath,
  cacheFilePath,
  schemaVersion = CAPABILITY_PROFILE_SCHEMA_VERSION,
  promptVersion = CAPABILITY_PROFILE_PROMPT_VERSION,
  generateProfile = generateCapabilityProfileWithLlm,
  now = () => new Date(),
} = {}) {
  const resolvedCachePath = getCapabilityProfileCachePath({ storageDir, cacheFilePath })
  const status = inspectCapabilityProfileCache({
    bossConfig,
    candidateProfile,
    cacheFilePath: resolvedCachePath,
    schemaVersion,
    promptVersion,
  })

  if (status.exists && status.fresh && !forceRefresh) {
    return {
      ok: true,
      refreshed: false,
      cacheFilePath: resolvedCachePath,
      status,
      summary: status.summary,
    }
  }

  if (!getEnabledLlmConfig(llmConfig)) {
    return {
      ok: false,
      refreshed: false,
      cacheFilePath: resolvedCachePath,
      status,
      error: {
        code: 'CAPABILITY_PROFILE_LLM_UNAVAILABLE',
        message: 'No enabled LLM config is available for Candidate Capability Profile generation.',
      },
    }
  }

  let generated
  try {
    generated = await generateProfile({
      bossConfig,
      candidateProfile,
      llmConfig,
      schemaVersion,
      promptVersion,
    })
  } catch (err) {
    return capabilityProfileFailure({
      code: 'CAPABILITY_PROFILE_GENERATION_FAILED',
      message: err?.message ?? String(err),
      cacheFilePath: resolvedCachePath,
      status,
    })
  }

  if (generated?.ok === false) {
    return capabilityProfileFailure({
      code: generated.error?.code ?? 'CAPABILITY_PROFILE_GENERATION_FAILED',
      message: generated.error?.message ?? 'Candidate Capability Profile generation failed.',
      cacheFilePath: resolvedCachePath,
      status,
    })
  }

  const profile = normalizeGeneratedCapabilityProfile(generated)
  const validationErrors = validateCapabilityProfile(profile)
  if (validationErrors.length) {
    return capabilityProfileFailure({
      code: 'CAPABILITY_PROFILE_INVALID_OUTPUT',
      message: `Generated Candidate Capability Profile is incomplete: ${validationErrors.join(', ')}`,
      cacheFilePath: resolvedCachePath,
      status,
    })
  }

  const cache = {
    schemaVersion,
    promptVersion,
    generatedAt: now().toISOString(),
    sourceFingerprints: buildSourceFingerprints({ bossConfig, candidateProfile }),
    sourceSummary: buildSourceSummary({ bossConfig, candidateProfile }),
    profile,
  }

  const sensitiveLeak = findSensitiveLeak(cache, { bossConfig, candidateProfile })
  if (sensitiveLeak) {
    return capabilityProfileFailure({
      code: 'CAPABILITY_PROFILE_SENSITIVE_OUTPUT',
      message: `Generated Candidate Capability Profile contained sensitive source material: ${sensitiveLeak.kind}`,
      cacheFilePath: resolvedCachePath,
      status,
    })
  }

  fs.mkdirSync(path.dirname(resolvedCachePath), { recursive: true })
  fs.writeFileSync(resolvedCachePath, `${JSON.stringify(cache, null, 2)}\n`, 'utf8')

  const refreshedStatus = inspectCapabilityProfileCache({
    bossConfig,
    candidateProfile,
    cacheFilePath: resolvedCachePath,
    schemaVersion,
    promptVersion,
  })

  return {
    ok: true,
    refreshed: true,
    cacheFilePath: resolvedCachePath,
    status: refreshedStatus,
    summary: refreshedStatus.summary,
  }
}

export async function generateCapabilityProfileWithLlm ({
  bossConfig = {},
  candidateProfile = null,
  llmConfig = [],
} = {}) {
  const config = getEnabledLlmConfig(llmConfig)
  if (!config) {
    return {
      ok: false,
      error: {
        code: 'CAPABILITY_PROFILE_LLM_UNAVAILABLE',
        message: 'No enabled LLM config is available for Candidate Capability Profile generation.',
      },
    }
  }

  const completion = await completes({
    baseURL: config.providerCompleteApiUrl ?? config.baseURL,
    apiKey: config.providerApiSecret ?? config.apiKey,
    model: config.model,
    max_tokens: 1800,
    temperature: 0.1,
    response_format: { type: 'json_object' },
  }, [
    {
      role: 'system',
      content: [
        'Generate a non-sensitive, auditable Candidate Capability Profile.',
        'Use the resume and candidate configuration only as transient input.',
        'Return strict JSON with keys: demonstratedAbilities, supportingEvidenceSummaries, targetRoleDirection, transferableStrengths, gaps, framingBoundaries.',
        'demonstratedAbilities must be an array of objects with keys ability and evidenceSummary.',
        'Use Evidence-Based Framing: emphasize demonstrated or plausibly transferable strengths, but do not invent credentials, employers, tenure, certifications, outcomes, availability, salary, or identity details.',
        'Do not include full resume text, contact information, local filesystem paths, resume image paths, cookies, local storage, API keys, full greeting text, or other sensitive originals.',
        'Summarize evidence in your own words. Keep every string concise and audit-safe.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: JSON.stringify({
        candidateProfile: summarizeCandidateProfile(candidateProfile),
        resumeMarkdown: limitResumeMarkdown(candidateProfile),
        targetRoleIntent: {
          expectedJob: candidateProfile?.expectedJob ?? '',
          titleRegex: candidateProfile?.titleRegex ?? '',
          typeRegex: candidateProfile?.typeRegex ?? '',
          descRegex: candidateProfile?.descRegex ?? '',
          intentSignals: candidateProfile?.intentSignals ?? [],
        },
        userRequirements: summarizeUserRequirements(bossConfig),
        greetingRules: summarizeGreetingRulesForPrompt(bossConfig),
        policy: {
          cacheMustBeNonSensitive: true,
          allowedFraming: 'Evidence-Based Framing only.',
          forbiddenDurableContent: [
            'full resume text',
            'contact information',
            'local filesystem paths',
            'resume image paths',
            'cookies or local storage',
            'API keys or secrets',
            'full greeting text',
          ],
        },
      }),
    },
  ])

  const content = normalizeJsonContent(completion.choices?.[0]?.message?.content ?? '{}')
  try {
    return JSON.parse(content)
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'CAPABILITY_PROFILE_PARSE_FAILED',
        message: err?.message ?? String(err),
      },
    }
  }
}

export function summarizeCapabilityProfileCache (cache) {
  const profile = cache?.profile ?? null
  if (!profile) return null
  return {
    schemaVersion: cache.schemaVersion,
    promptVersion: cache.promptVersion,
    generatedAt: cache.generatedAt,
    sourceSummary: cache.sourceSummary ?? null,
    demonstratedAbilityCount: profile.demonstratedAbilities?.length ?? 0,
    demonstratedAbilities: normalizeAbilityList(profile.demonstratedAbilities, summaryListLimit),
    supportingEvidenceSummaries: normalizeStringList(profile.supportingEvidenceSummaries, summaryListLimit),
    targetRoleDirection: clipText(profile.targetRoleDirection, summaryTextLimit),
    transferableStrengths: normalizeStringList(profile.transferableStrengths, summaryListLimit),
    gaps: normalizeStringList(profile.gaps, summaryListLimit),
    framingBoundaries: normalizeStringList(profile.framingBoundaries, summaryListLimit),
  }
}

function capabilityProfileFailure ({
  code,
  message,
  cacheFilePath,
  status,
}) {
  return {
    ok: false,
    refreshed: false,
    cacheFilePath,
    status,
    error: { code, message },
  }
}

function getStaleReasons ({
  cache,
  currentSourceFingerprints,
  schemaVersion,
  promptVersion,
}) {
  const reasons = []
  if (cache.schemaVersion !== schemaVersion) reasons.push('schema_version_changed')
  if (cache.promptVersion !== promptVersion) reasons.push('prompt_version_changed')
  if (!cache.generatedAt) reasons.push('generated_time_missing')
  for (const [key, value] of Object.entries(currentSourceFingerprints)) {
    if (cache.sourceFingerprints?.[key] !== value) {
      reasons.push(`source_fingerprint_mismatch:${key}`)
    }
  }
  return reasons
}

function summarizeCacheMetadata (cache) {
  return {
    schemaVersion: cache.schemaVersion ?? '',
    promptVersion: cache.promptVersion ?? '',
    generatedAt: cache.generatedAt ?? '',
    sourceFingerprints: cache.sourceFingerprints ?? {},
  }
}

function buildSourceFingerprints ({ bossConfig = {}, candidateProfile = null } = {}) {
  const sources = buildFingerprintSources({ bossConfig, candidateProfile })
  return Object.fromEntries(
    Object.entries(sources).map(([key, value]) => [key, hashStable(value)])
  )
}

function buildFingerprintSources ({ bossConfig = {}, candidateProfile = null } = {}) {
  return {
    resumeDerivedInput: {
      resumeAvailable: Boolean(candidateProfile?.resumeAvailable),
      expectedJob: candidateProfile?.expectedJob ?? '',
      workYearDesc: candidateProfile?.workYearDesc ?? '',
      resumeMarkdown: candidateProfile?.resumeMarkdown ?? '',
      resumeSignals: candidateProfile?.resumeSignals ?? [],
    },
    targetRoleIntent: {
      expectedJob: candidateProfile?.expectedJob ?? '',
      titleRegex: candidateProfile?.titleRegex ?? '',
      typeRegex: candidateProfile?.typeRegex ?? '',
      descRegex: candidateProfile?.descRegex ?? '',
      intentSignals: candidateProfile?.intentSignals ?? [],
    },
    userRequirements: summarizeUserRequirements(bossConfig),
    greetingRules: summarizeGreetingRulesForFingerprint(bossConfig),
    candidateTarget: {
      expectedJob: candidateProfile?.expectedJob ?? '',
      workYearDesc: candidateProfile?.workYearDesc ?? '',
      recallKeywords: candidateProfile?.recallKeywords ?? [],
      titleRegex: candidateProfile?.titleRegex ?? '',
      typeRegex: candidateProfile?.typeRegex ?? '',
      descRegex: candidateProfile?.descRegex ?? '',
      expectCityList: bossConfig.expectCityList ?? [],
    },
  }
}

function buildSourceSummary ({ bossConfig = {}, candidateProfile = null } = {}) {
  return {
    resumeAvailable: Boolean(candidateProfile?.resumeAvailable),
    expectedJob: redactSensitiveFragments(clipText(candidateProfile?.expectedJob, 120)),
    workYearDesc: redactSensitiveFragments(clipText(candidateProfile?.workYearDesc, 80)),
    recallKeywordCount: candidateProfile?.recallKeywords?.length ?? 0,
    intentSignalCount: candidateProfile?.intentSignals?.length ?? 0,
    resumeSignalCount: candidateProfile?.resumeSignals?.length ?? 0,
    greetingRuleCount: getGreetingRules(bossConfig).length,
    titleRegexConfigured: Boolean(String(candidateProfile?.titleRegex ?? '').trim()),
    typeRegexConfigured: Boolean(String(candidateProfile?.typeRegex ?? '').trim()),
    descRegexConfigured: Boolean(String(candidateProfile?.descRegex ?? '').trim()),
    userRequirementFingerprint: hashStable(summarizeUserRequirements(bossConfig)),
  }
}

function summarizeUserRequirements (bossConfig = {}) {
  return {
    combineRecommendJobFilterType: bossConfig.combineRecommendJobFilterType ?? null,
    anyCombineRecommendJobFilter: bossConfig.anyCombineRecommendJobFilter ?? null,
    staticCombineRecommendJobFilterConditions: bossConfig.staticCombineRecommendJobFilterConditions ?? [],
    isSkipEmptyConditionForCombineRecommendJobFilter: bossConfig.isSkipEmptyConditionForCombineRecommendJobFilter ?? null,
    expectCityList: bossConfig.expectCityList ?? [],
    expectCityNotMatchStrategy: bossConfig.expectCityNotMatchStrategy ?? null,
    strategyScopeOptionWhenMarkJobCityNotMatch: bossConfig.strategyScopeOptionWhenMarkJobCityNotMatch ?? null,
    jobDetailRegExpMatchLogic: bossConfig.jobDetailRegExpMatchLogic ?? null,
    jobNotMatchStrategy: bossConfig.jobNotMatchStrategy ?? null,
    jobNotActiveStrategy: bossConfig.jobNotActiveStrategy ?? null,
  }
}

function summarizeGreetingRulesForPrompt (bossConfig = {}) {
  return getGreetingRules(bossConfig).map(rule => ({
    name: rule.name,
    pattern: rule.pattern,
  }))
}

function summarizeGreetingRulesForFingerprint (bossConfig = {}) {
  return getGreetingRules(bossConfig).map(rule => ({
    name: rule.name,
    pattern: rule.pattern,
    messageFingerprint: hashStable(rule.message),
  }))
}

function normalizeGeneratedCapabilityProfile (generated) {
  const source = generated?.profile && typeof generated.profile === 'object'
    ? generated.profile
    : generated
  return {
    demonstratedAbilities: normalizeAbilityList(source?.demonstratedAbilities, listLimit),
    supportingEvidenceSummaries: normalizeStringList(source?.supportingEvidenceSummaries, listLimit),
    targetRoleDirection: clipText(source?.targetRoleDirection, summaryTextLimit),
    transferableStrengths: normalizeStringList(source?.transferableStrengths, listLimit),
    gaps: normalizeStringList(source?.gaps, listLimit),
    framingBoundaries: normalizeStringList(source?.framingBoundaries, listLimit),
  }
}

function normalizeAbilityList (items, limit) {
  if (!Array.isArray(items)) return []
  const normalized = []
  for (const item of items) {
    const ability = clipText(item?.ability ?? item?.name ?? item, 160)
    const evidenceSummary = clipText(item?.evidenceSummary ?? item?.evidence ?? item?.summary ?? '', summaryTextLimit)
    if (!ability && !evidenceSummary) continue
    normalized.push({ ability, evidenceSummary })
    if (normalized.length >= limit) break
  }
  return normalized
}

function normalizeStringList (items, limit) {
  if (!Array.isArray(items)) return []
  const output = []
  for (const item of items) {
    const value = clipText(item, summaryTextLimit)
    if (!value) continue
    output.push(value)
    if (output.length >= limit) break
  }
  return output
}

function validateCapabilityProfile (profile) {
  const errors = []
  if (!profile.demonstratedAbilities.length) errors.push('demonstratedAbilities')
  if (!profile.supportingEvidenceSummaries.length) errors.push('supportingEvidenceSummaries')
  if (!profile.targetRoleDirection) errors.push('targetRoleDirection')
  if (!profile.transferableStrengths.length) errors.push('transferableStrengths')
  if (!profile.gaps.length) errors.push('gaps')
  if (!profile.framingBoundaries.length) errors.push('framingBoundaries')
  return errors
}

function findSensitiveLeak (value, { bossConfig = {}, candidateProfile = null } = {}) {
  const outputStrings = collectStrings(value)
  const sensitiveSources = collectSensitiveSources({ bossConfig, candidateProfile })
  for (const source of sensitiveSources) {
    if (!source.value) continue
    for (const output of outputStrings) {
      if (output.includes(source.value)) return source
    }
  }
  return null
}

function collectSensitiveSources ({ bossConfig = {}, candidateProfile = null } = {}) {
  const rawTexts = [
    candidateProfile?.resumeMarkdown,
    getResumeImagePath(bossConfig),
    getDefaultGreeting(bossConfig),
    ...getGreetingRules(bossConfig).map(rule => rule.message),
  ].map(item => String(item ?? '')).filter(Boolean)

  const sources = []
  for (const text of rawTexts) {
    for (const match of extractSensitiveFragments(text)) {
      sources.push(match)
    }
    for (const line of text.split(/\r?\n/)) {
      const normalized = line.trim()
      if (normalized.length >= 80) {
        sources.push({ kind: 'resume_original_line', value: normalized })
      }
    }
  }
  return dedupeSensitiveSources(sources)
}

function dedupeSensitiveSources (sources) {
  const seen = new Set()
  const output = []
  for (const source of sources) {
    const key = `${source.kind}\n${source.value}`
    if (seen.has(key)) continue
    seen.add(key)
    output.push(source)
  }
  return output
}

function collectStrings (value, seen = new WeakSet()) {
  if (value == null) return []
  if (typeof value === 'string') return [value]
  if (typeof value !== 'object') return []
  if (seen.has(value)) return []
  seen.add(value)
  if (Array.isArray(value)) return value.flatMap(item => collectStrings(item, seen))
  return Object.values(value).flatMap(item => collectStrings(item, seen))
}

function clipText (text, maxLength) {
  const normalized = String(text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`
}

function hashStable (value) {
  return crypto
    .createHash('sha256')
    .update(stableSerialize(value))
    .digest('hex')
}

function stableSerialize (value) {
  if (value == null) return 'null'
  if (typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(item => stableSerialize(item)).join(',')}]`
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`
}

function normalizeJsonContent (content) {
  const text = String(content ?? '').trim()
  const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(text)
  const candidate = fenced ? fenced[1].trim() : text
  return extractFirstJsonObject(candidate) ?? candidate
}

function extractFirstJsonObject (text) {
  const source = String(text ?? '')
  const start = source.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < source.length; index++) {
    const char = source[index]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') depth += 1
    if (char === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, index + 1)
    }
  }
  return null
}
