import { extractSensitiveFragments, redactSensitiveFragments } from './sensitive-text.mjs'
import { getEnabledLlmConfig } from './config.mjs'
import { inspectCapabilityProfileCache } from './capability-profile.mjs'
import { completes } from '@geekgeekrun/utils/gpt-request.mjs'

const greetingMinCharacterCount = 80
const greetingMaxCharacterCount = 200
const promptJdMaxLength = 4000
const summaryTextLimit = 240

export function buildPresetGreetingPlan (selection = {}, { fallbackReason = null, personalization = null } = {}) {
  const message = String(selection.message ?? '')
  const characterCount = Array.from(message).length
  const selectedTemplate = normalizeSelectedTemplate(selection)
  const sensitiveFragments = extractSensitiveFragments(message)
  const reasons = []
  const summary = buildSummary({ selectedTemplate, characterCount })

  if (!message) reasons.push('empty_delivery_text')
  if (sensitiveFragments.length) reasons.push('sensitive_original_omitted_from_plan')

  return {
    source: 'preset',
    selectedTemplate,
    fallbackReason,
    guardResult: null,
    safeSummary: summary,
    summary,
    characterCount,
    safetyStatus: {
      auditSafe: true,
      deliveryTextAvailable: Boolean(message),
      originalMessageSensitive: sensitiveFragments.length > 0,
      reasons,
    },
    ...(personalization ? { personalization } : {}),
  }
}

export async function buildGuardedPersonalizedGreetingPlan (options = {}) {
  const { greetingPlan } = await resolveGuardedPersonalizedGreeting(options)
  return greetingPlan
}

export async function buildGuardedPersonalizedGreetingSelection (options = {}) {
  const fallbackGreeting = normalizeFallbackGreeting(options.fallbackGreeting)
  const fallbackPlan = options.fallbackPlan ?? buildPresetGreetingPlan(fallbackGreeting)
  const { greetingPlan, deliveryMessage } = await resolveGuardedPersonalizedGreeting({
    ...options,
    fallbackPlan,
    fallbackMessage: fallbackGreeting.message,
  })

  if (greetingPlan.source === 'personalized') {
    return {
      greeting: {
        rule: 'personalized',
        message: deliveryMessage,
        source: 'personalized',
      },
      greetingPlan,
    }
  }

  return {
    greeting: {
      rule: fallbackGreeting.rule || greetingPlan.selectedTemplate?.rule || 'default',
      message: fallbackGreeting.message,
      source: 'preset',
    },
    greetingPlan,
  }
}

export function getGreetingPlanTextSkipReason (greetingPlan, message) {
  const text = normalizeGreetingText(message)
  if (!text) return 'NO_SAFE_GREETING_TEXT'
  if (!greetingPlan || typeof greetingPlan !== 'object') return ''

  if (greetingPlan.source === 'personalized') {
    if (greetingPlan.guardResult?.passed !== true) return 'GREETING_GUARD_NOT_PASSED'
    if (Number(greetingPlan.characterCount ?? 0) <= 0) return 'NO_SAFE_GREETING_TEXT'
    return ''
  }

  if (greetingPlan.source === 'preset') {
    if (greetingPlan.safetyStatus?.deliveryTextAvailable === false) return 'NO_SAFE_GREETING_TEXT'
    if (greetingPlan.safetyStatus?.auditSafe === false) return 'GREETING_PLAN_NOT_AUDIT_SAFE'
  }

  return ''
}

async function resolveGuardedPersonalizedGreeting ({
  job = {},
  bossConfig = {},
  candidateProfile = null,
  llmConfig = [],
  storageDir,
  cacheFilePath,
  fallbackPlan = buildPresetGreetingPlan(),
  fallbackMessage = '',
  generateGreeting = generatePersonalizedGreetingWithLlm,
} = {}) {
  const cacheStatus = inspectCapabilityProfileCache({
    bossConfig,
    candidateProfile,
    storageDir,
    cacheFilePath,
  })

  if (!cacheStatus.exists) {
    return buildFallbackSelection(fallbackPlan, fallbackMessage, 'cache_missing', {
      cacheStatus: summarizeCacheStatus(cacheStatus),
    })
  }

  if (!cacheStatus.fresh) {
    return buildFallbackSelection(fallbackPlan, fallbackMessage, 'cache_stale', {
      cacheStatus: summarizeCacheStatus(cacheStatus),
    })
  }

  if (!getEnabledLlmConfig(llmConfig)) {
    return buildFallbackSelection(fallbackPlan, fallbackMessage, 'llm_unavailable', {
      cacheStatus: summarizeCacheStatus(cacheStatus),
    })
  }

  let generated
  try {
    generated = await generateGreeting({
      job: summarizeJobForGreeting(job),
      capabilityProfileSummary: cacheStatus.summary,
      llmConfig,
    })
  } catch (err) {
    return buildFallbackSelection(fallbackPlan, fallbackMessage, 'generation_failed', {
      cacheStatus: summarizeCacheStatus(cacheStatus),
      error: {
        code: 'PERSONALIZED_GREETING_REQUEST_FAILED',
        message: err?.message ?? String(err),
      },
    })
  }

  if (generated?.ok === false) {
    return buildFallbackSelection(fallbackPlan, fallbackMessage, mapGenerationFailureToFallbackReason(generated.error?.code), {
      cacheStatus: summarizeCacheStatus(cacheStatus),
      error: generated.error,
    })
  }

  const message = normalizeGeneratedGreeting(generated)
  if (!message) {
    return buildFallbackSelection(fallbackPlan, fallbackMessage, 'empty_output', {
      cacheStatus: summarizeCacheStatus(cacheStatus),
    })
  }

  const guardResult = guardPersonalizedGreeting(message, {
    capabilityProfileSummary: cacheStatus.summary,
    candidateProfile,
    bossConfig,
  })

  if (!guardResult.passed) {
    return buildFallbackSelection(fallbackPlan, fallbackMessage, 'guard_rejected', {
      cacheStatus: summarizeCacheStatus(cacheStatus),
      guardResult,
    })
  }

  return {
    greetingPlan: {
      source: 'personalized',
      fallbackReason: null,
      guardResult,
      safeSummary: guardResult.safeSummary,
      summary: guardResult.safeSummary,
      characterCount: guardResult.characterCount,
      capabilityProfile: summarizeCacheStatus(cacheStatus),
    },
    deliveryMessage: message,
  }
}

export async function generatePersonalizedGreetingWithLlm ({
  job = {},
  capabilityProfileSummary = null,
  llmConfig = [],
} = {}) {
  const config = getEnabledLlmConfig(llmConfig)
  if (!config) {
    return {
      ok: false,
      error: {
        code: 'PERSONALIZED_GREETING_LLM_UNAVAILABLE',
        message: 'No enabled LLM config is available for Personalized Greeting generation.',
      },
    }
  }

  let completion
  try {
    completion = await completes({
      baseURL: config.providerCompleteApiUrl ?? config.baseURL,
      apiKey: config.providerApiSecret ?? config.apiKey,
      model: config.model,
      max_tokens: 800,
      temperature: 0.2,
      response_format: { type: 'json_object' },
    }, [
      {
        role: 'system',
        content: [
          'Generate one short Chinese Personalized Greeting for a job application preview.',
          'Use Evidence-Based Framing only. Emphasize demonstrated or transferable strengths from the Candidate Capability Profile.',
          'Do not invent employers, tenure, certifications, education, salary expectations, availability, personal history, outcomes, contact information, or local paths.',
          'Do not include full resume text, resume image paths, contact information, cookies, local storage, API keys, or secrets.',
          `Target length is ${greetingMinCharacterCount}-${greetingMaxCharacterCount} Chinese characters. Never exceed ${greetingMaxCharacterCount} Chinese characters.`,
          'Return strict JSON with one key: message.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: JSON.stringify({
          capabilityProfile: capabilityProfileSummary,
          targetJob: summarizeJobForGreeting(job),
          policy: {
            framing: 'Evidence-Based Framing only.',
            fallbackWhenUnsafe: true,
            forbiddenContent: [
              'unsupported claims',
              'fake years of experience',
              'fake company claims',
              'fake certification claims',
              'availability claims',
              'salary claims',
              'contact information',
              'local paths',
              'image paths',
              'full resume text',
            ],
          },
        }),
      },
    ])
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'PERSONALIZED_GREETING_REQUEST_FAILED',
        message: err?.message ?? String(err),
      },
    }
  }

  const content = normalizeJsonContent(completion.choices?.[0]?.message?.content ?? '{}')
  try {
    const parsed = JSON.parse(content)
    const message = normalizeGeneratedGreeting(parsed)
    if (!message) {
      return {
        ok: false,
        error: {
          code: 'PERSONALIZED_GREETING_EMPTY_OUTPUT',
          message: 'Personalized Greeting generation returned an empty message.',
        },
      }
    }
    return { message }
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'PERSONALIZED_GREETING_PARSE_FAILED',
        message: err?.message ?? String(err),
      },
    }
  }
}

export function guardPersonalizedGreeting (message, {
  capabilityProfileSummary = null,
  candidateProfile = null,
  bossConfig = {},
} = {}) {
  const text = normalizeGreetingText(message)
  const reasons = []
  const characterCount = Array.from(text).length
  const evidenceText = normalizeEvidenceText(capabilityProfileSummary)

  if (!text) addReason(reasons, 'empty_output')
  if (characterCount < greetingMinCharacterCount) {
    addReason(reasons, 'too_short', `${characterCount} characters`)
  }
  if (characterCount > greetingMaxCharacterCount) {
    addReason(reasons, 'too_long', `${characterCount} characters`)
  }
  if (text && !/[\u4e00-\u9fff]/.test(text)) {
    addReason(reasons, 'not_chinese')
  }

  addSensitiveFragmentReasons(reasons, text)
  addFullResumeLeakageReasons(reasons, text, candidateProfile)
  addUnsupportedClaimReasons(reasons, text, evidenceText)
  addImagePathReasons(reasons, text, bossConfig)

  const passed = reasons.length === 0
  return {
    passed,
    reasons,
    characterCount,
    safeSummary: passed
      ? `Personalized greeting passed Greeting Guard; ${characterCount} characters.`
      : `Personalized greeting failed Greeting Guard; ${characterCount} characters; ${reasons.map(reason => reason.code).join(', ')}.`,
  }
}

function normalizeSelectedTemplate (selection) {
  const type = selection.type === 'default' ? 'default' : 'rule'
  const rule = redactSensitiveFragments(selection.rule || (type === 'default' ? 'default' : selection.pattern))
  return {
    type,
    rule,
    name: redactSensitiveFragments(selection.name || rule),
    pattern: type === 'default' ? '' : redactSensitiveFragments(selection.pattern),
  }
}

function buildSummary ({ selectedTemplate, characterCount }) {
  const template = selectedTemplate.rule || selectedTemplate.type
  return `Preset greeting selected from ${template}; ${characterCount} characters.`
}

function buildFallbackPlan (fallbackPlan, fallbackReason, personalization = {}) {
  return {
    ...fallbackPlan,
    fallbackReason,
    personalization: {
      status: 'fallback',
      reason: fallbackReason,
      ...personalization,
    },
  }
}

function buildFallbackSelection (fallbackPlan, fallbackMessage, fallbackReason, personalization = {}) {
  return {
    greetingPlan: buildFallbackPlan(fallbackPlan, fallbackReason, personalization),
    deliveryMessage: fallbackMessage,
  }
}

function normalizeFallbackGreeting (greeting = {}) {
  return {
    rule: String(greeting?.rule ?? greeting?.name ?? '').trim(),
    message: String(greeting?.message ?? '').trim(),
  }
}

function summarizeCacheStatus (cacheStatus) {
  return {
    exists: Boolean(cacheStatus?.exists),
    fresh: Boolean(cacheStatus?.fresh),
    reasons: cacheStatus?.reasons ?? [],
    metadata: cacheStatus?.metadata ?? null,
    summary: cacheStatus?.summary
      ? {
          generatedAt: cacheStatus.summary.generatedAt,
          demonstratedAbilityCount: cacheStatus.summary.demonstratedAbilityCount,
          targetRoleDirection: cacheStatus.summary.targetRoleDirection,
        }
      : null,
  }
}

function mapGenerationFailureToFallbackReason (code) {
  if (code === 'PERSONALIZED_GREETING_LLM_UNAVAILABLE') return 'llm_unavailable'
  if (code === 'PERSONALIZED_GREETING_PARSE_FAILED') return 'malformed_json'
  if (code === 'PERSONALIZED_GREETING_EMPTY_OUTPUT') return 'empty_output'
  return 'generation_failed'
}

function normalizeGeneratedGreeting (generated) {
  if (typeof generated === 'string') return normalizeGreetingText(generated)
  return normalizeGreetingText(
    generated?.message ??
    generated?.greeting ??
    generated?.personalizedGreeting ??
    generated?.text ??
    ''
  )
}

function summarizeJobForGreeting (job = {}) {
  return {
    jobId: clipText(job.jobId, 120),
    title: clipText(job.title, 160),
    company: clipText(job.company, 160),
    city: clipText(job.city, 80),
    salary: clipText(job.salary, 80),
    experience: clipText(job.experience, 80),
    degree: clipText(job.degree, 80),
    labels: Array.isArray(job.labels) ? job.labels.map(item => clipText(item, 80)).filter(Boolean).slice(0, 20) : [],
    jd: clipText(job.jd, promptJdMaxLength),
    recallKeyword: clipText(job.recallKeyword, 120),
  }
}

function normalizeGreetingText (text) {
  return String(text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n+/g, '')
    .trim()
}

function addSensitiveFragmentReasons (reasons, text) {
  for (const fragment of extractSensitiveFragments(text)) {
    if (fragment.kind === 'email' || fragment.kind === 'phone') {
      addReason(reasons, 'contact_information', fragment.kind)
    } else if (fragment.kind === 'windows_path' || fragment.kind === 'unix_path') {
      addReason(reasons, 'local_path', fragment.kind)
    } else {
      addReason(reasons, 'sensitive_original', fragment.kind)
    }
  }
  if (/微信|wechat|电话|手机|邮箱|邮件|QQ/i.test(text)) {
    addReason(reasons, 'contact_information', 'contact cue')
  }
  if (/[A-Z]:\/[^\s"'<>|]+/i.test(text)) {
    addReason(reasons, 'local_path', 'windows_path')
  }
}

function addFullResumeLeakageReasons (reasons, text, candidateProfile) {
  const sources = collectResumeLeakSources(candidateProfile)
  for (const source of sources) {
    if (!source || !text.includes(source)) continue
    addReason(reasons, 'full_resume_leakage')
    return
  }
}

function collectResumeLeakSources (candidateProfile) {
  const resumeMarkdown = String(candidateProfile?.resumeMarkdown ?? '')
  const sources = []
  for (const fragment of extractSensitiveFragments(resumeMarkdown)) {
    if (fragment.value) sources.push(fragment.value)
  }
  for (const line of resumeMarkdown.split(/\r?\n/)) {
    const normalized = normalizeGreetingText(line)
    if (normalized.length >= 24) sources.push(normalized)
  }
  return [...new Set(sources)]
}

function addUnsupportedClaimReasons (reasons, text, evidenceText) {
  for (const claim of matchAllText(text, /(?:\d+|[一二两三四五六七八九十]+)\s*年(?:以上|\+)?[^，。；;,.!?！？]{0,12}(?:经验|经历|开发|工作|从业)/ig)) {
    if (!isSupportedByEvidence(claim, evidenceText)) {
      addReason(reasons, 'unsupported_years_of_experience_claim', clipText(claim, 60))
    }
  }

  const companyClaimPattern = /(?:(?:曾在|就职于|任职于|供职于|来自|在)\s*[\u4e00-\u9fffA-Za-z0-9_. -]{2,40}(?:公司|科技|集团|实验室|团队|Lab|Inc|Co)|(?:字节跳动|阿里巴巴|阿里|腾讯|百度|美团|华为|微软|Google|Meta|Amazon)[^，。；;,.!?！？]{0,16}(?:经验|经历|任职|就职|工作))/ig
  for (const claim of matchAllText(text, companyClaimPattern)) {
    if (!isSupportedByEvidence(claim, evidenceText)) {
      addReason(reasons, 'unsupported_company_claim', clipText(claim, 80))
    }
  }

  for (const claim of matchAllText(text, /(?:持有|获得|通过)?\s*(?:AWS Certified|PMP|CPA|CFA|阿里云认证|腾讯云认证|认证|证书|持证)/ig)) {
    if (!isSupportedByEvidence(claim, evidenceText)) {
      addReason(reasons, 'unsupported_certification_claim', clipText(claim, 80))
    }
  }

  for (const claim of matchAllText(text, /随时到岗|立即到岗|本周到岗|下周到岗|可马上入职|马上入职|到岗时间|入职时间/ig)) {
    if (!isSupportedByEvidence(claim, evidenceText)) {
      addReason(reasons, 'unsupported_availability_claim', claim)
    }
  }

  for (const claim of matchAllText(text, /期望薪资|薪资期望|月薪|年薪|工资|薪水|\d+\s*[kK]\b|\d+\s*万/ig)) {
    if (!isSupportedByEvidence(claim, evidenceText)) {
      addReason(reasons, 'unsupported_salary_claim', claim)
    }
  }

  for (const claim of matchAllText(text, /精通|资深|专家|架构师|主导|带领|获奖|第一名|毕业于|硕士|博士/ig)) {
    if (!isSupportedByEvidence(claim, evidenceText)) {
      addReason(reasons, 'unsupported_claim', claim)
    }
  }
}

function addImagePathReasons (reasons, text, bossConfig) {
  const resumeImagePath = String(bossConfig?.autoStartChatGreetingImagePath ?? '')
  if (
    /\.(?:png|jpe?g|gif|webp|bmp|svg|pdf|docx?)(?:$|[\\/"'\s。；;,.!?！？])/i.test(text) ||
    (resumeImagePath && text.includes(resumeImagePath))
  ) {
    addReason(reasons, 'image_path')
  }
}

function normalizeEvidenceText (value) {
  return JSON.stringify(value ?? {}).toLowerCase()
}

function isSupportedByEvidence (claim, evidenceText) {
  const normalizedClaim = String(claim ?? '').trim().toLowerCase()
  return Boolean(normalizedClaim && evidenceText.includes(normalizedClaim))
}

function matchAllText (text, pattern) {
  return [...String(text ?? '').matchAll(pattern)].map(match => match[0])
}

function addReason (reasons, code, detail = '') {
  const key = `${code}\n${detail}`
  if (reasons.some(reason => `${reason.code}\n${reason.detail ?? ''}` === key)) return
  reasons.push(detail ? { code, detail } : { code })
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
