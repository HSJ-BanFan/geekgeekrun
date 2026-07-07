import { getDefaultGreeting, getEnabledRecallKeywords, getGreetingRules, getResumeImagePath } from './config.mjs'
import { buildPresetGreetingPlan } from './greeting-plan.mjs'
import { jobText } from './job-profile.mjs'

const hardRejectPattern = /信息录入|录入员|纯兼职|运营跟播|跟播|内容审核|审核专员|AI内容|内容测评|文案撰写|销售|客服|主播|带货|推广|运营助理|数据标注|标注员|AI训练师|数据采集员|数据清洗员/i
const attentionTechnologySeedPattern = /(?<![A-Za-z])Java(?![A-Za-z])|J2EE|Spring\s*Boot|SpringBoot|(?<![A-Za-z])Spring(?![A-Za-z])|MyBatis/i
const requiredAttentionTechnologyContextPattern = /熟悉|精通|掌握|具备|要求|必须|开发|技术栈|后端|服务端|框架|经验|搭建|维护/i
const optionalAttentionTechnologyContextPattern = /加分|优先|了解|非必|不是必须|不要求|不需要|不涉及|无需|可选|bonus|plus|nice to have/i
const backgroundAttentionTechnologyContextPattern = /部门|团队|其他|已有|现有|历史|遗留|迁移|对接|服务|系统/i
const genericRecallKeywordTokens = new Set(['实习', '实习生', '远程', '线上', '居家办公', '兼职'])
const genericProfileTokens = new Set([
  '实习',
  '实习生',
  '远程',
  '线上',
  '居家办公',
  '兼职',
  '开发',
  '工程师',
  '岗位',
  '职位',
  '要求',
  '任职',
  '工作',
  '项目',
  '负责',
  '使用',
  '熟悉',
  '掌握',
  '了解',
  '经验',
  '系统',
  '平台',
  '能力',
])

const categoryRules = [
  {
    category: 'japanese_translation',
    pattern: /日语|日文|日译|中日|日中|日本语|Japanese/i,
    required: [/日语|日文|日译|中日|日中|日本语|Japanese/i],
  },
  {
    category: 'ai_agent',
    pattern: /AI|LLM|RAG|Agent|大模型|智能体/i,
    required: [/AI|LLM|RAG|Agent|大模型|智能体|Python/i],
  },
  {
    category: 'data_engineering',
    pattern: /数据工程|数据开发|数据处理|ETL|爬虫|自动化|数据仓库|数仓/i,
    required: [/数据工程|数据开发|数据处理|ETL|爬虫|自动化|数据仓库|数仓|Python/i],
  },
  {
    category: 'fullstack',
    pattern: /全栈|前后端/i,
    required: [/全栈|前后端|Python|后端/i],
  },
  {
    category: 'python_backend',
    pattern: /Python|后端|FastAPI|Django|Flask|接口|服务端/i,
    required: [/Python|FastAPI|Django|Flask|后端|接口|服务端/i],
  },
]

export function selectGreeting (job, bossConfig) {
  return selectGreetingWithPlan(job, bossConfig).greeting
}

export function selectGreetingPlan (job, bossConfig) {
  return selectGreetingWithPlan(job, bossConfig).greetingPlan
}

export function selectGreetingWithPlan (job, bossConfig) {
  const selection = selectPresetGreeting(job, bossConfig)
  return {
    greeting: { rule: selection.rule, message: selection.message },
    greetingPlan: buildPresetGreetingPlan(selection),
  }
}

function selectPresetGreeting (job, bossConfig) {
  const text = jobText(job)
  for (const rule of getGreetingRules(bossConfig)) {
    try {
      if (isJapaneseGreetingRule(rule) && !hasJapaneseSignal(text)) continue
      if (new RegExp(rule.pattern, 'im').test(text)) {
        return {
          type: 'rule',
          rule: rule.name || rule.pattern,
          name: rule.name,
          pattern: rule.pattern,
          message: rule.message,
        }
      }
    } catch {}
  }
  return {
    type: 'default',
    rule: 'default',
    name: 'default',
    pattern: '',
    message: getDefaultGreeting(bossConfig),
  }
}

export function evaluateJobWithRules (job, bossConfig, candidateProfile = null) {
  const text = jobContentText(job)
  const hardReject = findHardReject(job, text)
  const attentionTechnologyAssessment = assessAttentionTechnology(job, text)
  const configuredRegexResult = testConfiguredRegex(job, bossConfig)
  const category = inferCategory(text)
  const recallKeyword = matchConfiguredRecallKeyword(job, bossConfig)
  const profileFit = matchCandidateProfile(job, candidateProfile)
  const jdMatches = matchJdRequirements(text, category)
  const remoteFit = hasRemoteSignal(text)
  const greeting = selectPresetGreeting(job, bossConfig)
  const greetingPlan = buildPresetGreetingPlan(greeting)
  const requiresLlmFinalDecision = Boolean(candidateProfile?.requiresLlmForFinalDecision)
  const configuredRegexMatched = Boolean(configuredRegexResult.configured && configuredRegexResult.pass)
  const hasTargetFit = Boolean(
    category ||
    configuredRegexMatched ||
    profileFit.expectedJobMatched ||
    profileFit.intentSignalMatches.length ||
    profileFit.resumeSignalMatches.length
  )

  const reasons = []
  if (hardReject) reasons.push(`hard reject pattern matched: ${hardReject.match}`)
  if (attentionTechnologyAssessment.requiresLlm) {
    reasons.push(`attention technology needs llm explanation: ${attentionTechnologyAssessment.terms.join(', ')}`)
  }
  if (configuredRegexResult.configured) reasons.push(configuredRegexResult.reason)
  if (requiresLlmFinalDecision) reasons.push('llm final decision required for resume, intent, recall keyword, and JD fit')
  if (!hasTargetFit) reasons.push('no lexical candidate profile fit matched')
  if (profileFit.expectedJobMatched) reasons.push(`matched resume expected job: ${candidateProfile?.expectedJob ?? ''}`)
  if (profileFit.intentSignalMatches.length) {
    reasons.push(`matched candidate intent signals: ${profileFit.intentSignalMatches.slice(0, 5).join(', ')}`)
  }
  if (profileFit.recallKeywordMatches.length) {
    reasons.push(`matched recall keyword trace: ${profileFit.recallKeywordMatches.slice(0, 3).join(', ')}`)
  }
  if (remoteFit) reasons.push('remote/online signal matched')

  let score = 0
  if (category) score += 20
  if (profileFit.expectedJobMatched) score += 20
  if (profileFit.intentSignalMatches.length) score += Math.min(20, profileFit.intentSignalMatches.length * 5)
  if (profileFit.resumeSignalMatches.length) score += Math.min(15, profileFit.resumeSignalMatches.length * 3)
  if (configuredRegexMatched) score += 15
  if (jdMatches.matched.length) score += 10
  if (remoteFit) score += 5
  if (job.salary) score += 5
  if (hardReject || !hasTargetFit || !configuredRegexResult.valid) score = Math.min(score, 30)

  let decision = 'uncertain'
  if (hardReject) {
    decision = 'skip'
  } else if (requiresLlmFinalDecision || attentionTechnologyAssessment.requiresLlm || !configuredRegexResult.valid) {
    decision = 'uncertain'
  } else if (!configuredRegexResult.pass || !hasTargetFit) {
    decision = 'skip'
  } else if (score >= 65) {
    decision = 'apply'
  }

  return {
    decision,
    score,
    hardReject,
    requiresLlmFinalDecision,
    category: category?.category ?? 'unknown',
    recallKeyword,
    configuredRegex: configuredRegexResult,
    profileFit,
    jdMatch: jdMatches,
    remoteFit,
    attentionTechnologyAssessment,
    greetingTemplate: greeting.rule,
    greetingMessage: greeting.message,
    greetingPlan,
    resumeImagePath: getResumeImagePath(bossConfig),
    reasons,
    presetTasks: buildPresetTasks({ decision, greeting, greetingPlan, bossConfig, attentionTechnologyAssessment, requiresLlmFinalDecision }),
  }
}

function buildPresetTasks ({ decision, greeting, greetingPlan, bossConfig, attentionTechnologyAssessment, requiresLlmFinalDecision }) {
  if (decision === 'skip') {
    return [{ type: 'mark_not_suit', dryRun: true }]
  }
  if (decision === 'uncertain') {
    const tasks = []
    if (requiresLlmFinalDecision) {
      tasks.push({
        type: 'evaluate_job_llm',
        reason: 'candidate_profile_final_decision_required',
        dryRun: true,
      })
    }
    if (attentionTechnologyAssessment?.requiresLlm) {
      tasks.push({
        type: 'evaluate_job_llm',
        reason: 'attention_technology_explanation_required',
        terms: attentionTechnologyAssessment.terms,
        dryRun: true,
      })
    }
    tasks.push({ type: 'manual_review', dryRun: true })
    return tasks
  }
  const tasks = [
    { type: 'start_chat', dryRun: true },
    { type: 'send_greeting', template: greeting.rule, greetingPlan, dryRun: true },
  ]
  if (getResumeImagePath(bossConfig)) {
    tasks.push({ type: 'upload_resume_image', dryRun: true })
  }
  tasks.push({ type: 'audit_log', dryRun: true })
  return tasks
}

function inferCategory (text) {
  return categoryRules.find(rule => rule.pattern.test(text)) ?? null
}

function findHardReject (job, text) {
  const nonTechReject = hardRejectPattern.exec(text)
  if (nonTechReject) return { match: nonTechReject[0], type: 'job_type' }
  return null
}

function assessAttentionTechnology (job, text) {
  const evidence = []
  for (const term of findAttentionTechnologyTerms(job.title ?? '')) {
    evidence.push({
      term,
      segment: job.title,
      context: 'title',
    })
  }

  for (const segment of splitRequirementSegments(text)) {
    for (const term of findAttentionTechnologyTerms(segment)) {
      evidence.push({
        term,
        segment,
        context: classifyAttentionTechnologyMention(segment),
      })
    }
  }

  const dedupedEvidence = dedupeAttentionTechnologyEvidence(evidence)
  const terms = [...new Set(dedupedEvidence.map(item => item.term))]
  return {
    requiresLlm: terms.length > 0,
    terms,
    preliminaryVerdict: getPreliminaryAttentionTechnologyVerdict(dedupedEvidence),
    evidence: dedupedEvidence,
    instruction: terms.length
      ? 'LLM must explain whether these Attention Technology terms are core/required skills, optional/background mentions, and whether they match the candidate resume and intent.'
      : '',
  }
}

function findAttentionTechnologyTerms (text) {
  const regex = new RegExp(attentionTechnologySeedPattern.source, 'ig')
  return [...String(text ?? '').matchAll(regex)].map(match => match[0])
}

function classifyAttentionTechnologyMention (segment) {
  if (isOptionalOrBackgroundAttentionTechnologyMention(segment)) return 'optional_or_background'
  if (requiredAttentionTechnologyContextPattern.test(segment) || hasMultipleAttentionTechnologySignals(segment)) {
    return 'requirement_like'
  }
  return 'mentioned'
}

function dedupeAttentionTechnologyEvidence (evidence) {
  const seen = new Set()
  const result = []
  for (const item of evidence) {
    const key = `${item.term}\n${item.segment}\n${item.context}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(item)
  }
  return result
}

function getPreliminaryAttentionTechnologyVerdict (evidence) {
  if (!evidence.length) return 'none'
  if (evidence.some(item => item.context === 'title' || item.context === 'requirement_like')) {
    return 'possible_core_or_required'
  }
  if (evidence.every(item => item.context === 'optional_or_background')) {
    return 'likely_optional_or_background'
  }
  return 'mentioned'
}

function splitRequirementSegments (text) {
  return String(text ?? '')
    .split(/[\r\n。；;，,.!！?？]+/)
    .map(item => item.trim())
    .filter(Boolean)
}

function isOptionalOrBackgroundAttentionTechnologyMention (segment) {
  return optionalAttentionTechnologyContextPattern.test(segment) ||
    (
      backgroundAttentionTechnologyContextPattern.test(segment) &&
      !requiredAttentionTechnologyContextPattern.test(segment.replace(attentionTechnologySeedPattern, ''))
    )
}

function hasMultipleAttentionTechnologySignals (segment) {
  const matches = segment.match(new RegExp(attentionTechnologySeedPattern.source, 'ig')) ?? []
  return matches.length >= 2
}

function matchCandidateProfile (job, candidateProfile) {
  const empty = {
    profileAvailable: false,
    expectedJobMatched: false,
    expectedJobMatches: [],
    intentSignalMatches: [],
    resumeSignalMatches: [],
    recallKeywordMatches: [],
    regexMatches: [],
  }
  if (!candidateProfile) return empty

  const text = normalizeSearchText(jobContentText(job))
  const titleText = normalizeSearchText(job.title ?? '')
  const jdText = normalizeSearchText(job.jd ?? '')
  const regexMatches = matchCandidateRegexes({ titleText, jdText, fullText: text }, candidateProfile)
  const expectedJobMatches = matchSignals(splitSignalText(candidateProfile.expectedJob), text, 12)
  const intentSignalMatches = matchSignals(candidateProfile.intentSignals ?? [], text, 20)
  const resumeSignalMatches = matchSignals(candidateProfile.resumeSignals ?? [], text, 20)
  const recallKeywordMatches = matchCandidateRecallKeywords(job, candidateProfile, text)

  return {
    profileAvailable: true,
    expectedJobMatched: Boolean(expectedJobMatches.length || regexMatches.some(item => item.matched)),
    expectedJobMatches,
    intentSignalMatches,
    resumeSignalMatches,
    recallKeywordMatches,
    regexMatches,
  }
}

function matchCandidateRegexes ({ titleText, jdText, fullText }, candidateProfile) {
  const checks = [
    ['titleRegex', candidateProfile.titleRegex, titleText],
    ['typeRegex', candidateProfile.typeRegex, fullText],
    ['descRegex', candidateProfile.descRegex, jdText || fullText],
  ]
  return checks
    .filter(([, pattern]) => String(pattern ?? '').trim())
    .map(([name, pattern, text]) => {
      try {
        return { name, matched: new RegExp(pattern, 'im').test(text), pattern }
      } catch (err) {
        return { name, matched: false, pattern, error: err?.message ?? String(err) }
      }
    })
}

function matchCandidateRecallKeywords (job, candidateProfile, normalizedJobText) {
  const result = []
  const recallKeyword = String(job.recallKeyword ?? '').trim()
  const recallKeywords = candidateProfile.recallKeywords ?? []
  if (recallKeyword && recallKeywords.includes(recallKeyword)) {
    result.push(recallKeyword)
  }
  for (const recallKeyword of recallKeywords) {
    if (result.includes(recallKeyword)) continue
    const tokens = splitSignalText(recallKeyword).filter(token => !genericRecallKeywordTokens.has(token))
    if (!tokens.length) continue
    const matchedTokens = matchSignals(tokens, normalizedJobText, tokens.length)
    if (matchedTokens.length && matchedTokens.length === tokens.length) {
      result.push(recallKeyword)
    }
  }
  return result.slice(0, 20)
}

function matchSignals (signals, normalizedJobText, limit) {
  const result = []
  const seen = new Set()
  for (const rawSignal of signals) {
    for (const signal of splitSignalText(rawSignal)) {
      const normalized = normalizeSignal(signal)
      const key = normalized.toLowerCase()
      if (!isUsefulProfileSignal(normalized) || seen.has(key)) continue
      if (!signalAppearsInText(normalized, normalizedJobText)) continue
      seen.add(key)
      result.push(normalized)
      if (result.length >= limit) return result
    }
  }
  return result
}

function splitSignalText (text) {
  const source = String(text ?? '')
    .replace(/[\\^$.*+?()[\]{}|]/g, ' ')
  return source.match(/[A-Za-z][A-Za-z0-9+#._-]*|[\u4e00-\u9fff]{2,}/g) ?? []
}

function normalizeSignal (signal) {
  return String(signal ?? '')
    .trim()
    .replace(/^[^\u4e00-\u9fffA-Za-z0-9+#._-]+|[^\u4e00-\u9fffA-Za-z0-9+#._-]+$/g, '')
}

function isUsefulProfileSignal (signal) {
  const normalized = signal.toLowerCase()
  return signal.length >= 2 &&
    !genericProfileTokens.has(signal) &&
    !genericProfileTokens.has(normalized)
}

function signalAppearsInText (signal, normalizedJobText) {
  const normalized = normalizeSearchText(signal)
  if (!normalized) return false
  if (/^[a-z0-9+#._-]+$/i.test(signal)) {
    return new RegExp(`(^|[^a-z0-9+#._-])${escapeRegExp(normalized)}($|[^a-z0-9+#._-])`, 'i').test(normalizedJobText)
  }
  return normalizedJobText.includes(normalized)
}

function normalizeSearchText (text) {
  return String(text ?? '').toLowerCase()
}

function escapeRegExp (text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function matchJdRequirements (text, category) {
  if (!category) return { matched: [], missing: [] }
  const matched = []
  const missing = []
  for (const pattern of category.required) {
    if (pattern.test(text)) matched.push(pattern.source)
    else missing.push(pattern.source)
  }
  return { matched, missing }
}

function matchConfiguredRecallKeyword (job, bossConfig) {
  const text = jobText(job).toLowerCase()
  const recallKeywords = getEnabledRecallKeywords(bossConfig)
  if (job.recallKeyword && recallKeywords.includes(job.recallKeyword)) {
    return { value: job.recallKeyword, tokenMatches: job.recallKeyword.split(/\s+/).filter(Boolean).length }
  }
  let best = null
  let bestScore = 0
  for (const recallKeyword of recallKeywords) {
    const tokens = recallKeyword.toLowerCase().split(/\s+/).filter(Boolean)
    const signalTokens = tokens.filter(token => !genericRecallKeywordTokens.has(token))
    if (!signalTokens.length) continue
    if (!signalTokens.every(token => text.includes(token))) continue
    const score = tokens.filter(token => text.includes(token)).length
    if (score > bestScore) {
      best = recallKeyword
      bestScore = score
    }
  }
  return { value: best, tokenMatches: bestScore }
}

function testConfiguredRegex (job, bossConfig) {
  const checks = [
    ['title', bossConfig.expectJobNameRegExpStr ?? bossConfig.expectJobRegExpStr, job.title],
    ['type', bossConfig.expectJobTypeRegExpStr, jobContentText(job)],
    ['description', bossConfig.expectJobDescRegExpStr, job.jd],
  ]
    .map(([name, pattern, text]) => ({
      name,
      pattern: String(pattern ?? '').trim(),
      text: String(text ?? ''),
    }))
    .filter(item => item.pattern)

  if (!checks.length) {
    return {
      configured: false,
      valid: true,
      pass: true,
      matches: [],
      errors: [],
      reason: 'no configured job regex',
    }
  }

  const matches = []
  const errors = []
  for (const check of checks) {
    try {
      if (new RegExp(check.pattern, 'im').test(check.text)) {
        matches.push({ name: check.name, pattern: check.pattern })
      }
    } catch (err) {
      errors.push({ name: check.name, pattern: check.pattern, error: err?.message ?? String(err) })
    }
  }

  const valid = errors.length === 0
  const pass = valid && matches.length > 0
  return {
    configured: true,
    valid,
    pass,
    matches,
    errors,
    reason: !valid
      ? `invalid configured job regex: ${errors.map(item => `${item.name}: ${item.error}`).join('; ')}`
      : pass
        ? `configured job regex matched: ${matches.map(item => item.name).join(', ')}`
        : 'configured job regex did not match',
  }
}

function hasRemoteSignal (text) {
  return /远程|居家|不坐班|remote|work from home/i.test(text) ||
    (/线上/i.test(text) && !/线上线下/i.test(text))
}

function jobContentText (job) {
  return [
    job.title,
    job.company,
    job.city,
    job.salary,
    job.experience,
    job.degree,
    job.labels?.join?.(' '),
    job.jd,
  ].filter(Boolean).join('\n')
}

function isJapaneseGreetingRule (rule) {
  return /日语|日文|日译|中日|日中|Japanese/i.test(`${rule.name}\n${rule.pattern}`)
}

function hasJapaneseSignal (text) {
  return /日语|日文|日译|中日|日中|日本语|Japanese/i.test(text)
}
