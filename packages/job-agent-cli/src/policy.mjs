import { getDefaultGreeting, getEnabledSearchKeywords, getGreetingRules, getResumeImagePath } from './config.mjs'
import { jobText } from './job-profile.mjs'

const hardRejectPattern = /Java|J2EE|Spring\s*Boot|SpringBoot|Spring|MyBatis|信息录入|录入员|纯兼职|运营跟播|跟播|内容审核|审核专员|AI内容|内容测评|文案撰写|销售|客服|主播|带货|推广|运营助理|数据标注|标注员|AI训练师|数据采集员|数据清洗员/i
const genericKeywordTokens = new Set(['实习', '实习生', '远程', '线上', '居家办公', '兼职'])

const categoryRules = [
  {
    category: 'japanese_translation',
    pattern: /日语|日文|日译|中日|日中|翻译|本地化|字幕|游戏本地化/i,
    required: [/日语|日文|翻译|本地化|字幕/i],
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
  const text = jobText(job)
  for (const rule of getGreetingRules(bossConfig)) {
    try {
      if (new RegExp(rule.pattern, 'im').test(text)) {
        return { rule: rule.name || rule.pattern, message: rule.message }
      }
    } catch {}
  }
  return { rule: 'default', message: getDefaultGreeting(bossConfig) }
}

export function evaluateJobWithRules (job, bossConfig) {
  const text = jobText(job)
  const rejectionText = text
  const hardReject = hardRejectPattern.exec(rejectionText)
  const configuredRegexResult = testConfiguredRegex(job, bossConfig)
  const category = inferCategory(text)
  const keywordMatch = matchConfiguredKeyword(job, bossConfig)
  const jdMatches = matchJdRequirements(text, category)
  const remoteFit = /远程|线上|居家|不坐班|remote|work from home/i.test(text)
  const greeting = selectGreeting(job, bossConfig)

  const reasons = []
  if (hardReject) reasons.push(`hard reject pattern matched: ${hardReject[0]}`)
  if (!configuredRegexResult.pass) reasons.push(configuredRegexResult.reason)
  if (!category) reasons.push('no supported category matched')
  if (keywordMatch.keyword) reasons.push(`matched source keyword: ${keywordMatch.keyword}`)
  if (remoteFit) reasons.push('remote/online signal matched')

  let score = 0
  if (category) score += 35
  if (configuredRegexResult.pass) score += 20
  if (keywordMatch.keyword) score += 15
  if (jdMatches.matched.length) score += 15
  if (remoteFit) score += 10
  if (job.salary) score += 5
  if (hardReject || !configuredRegexResult.pass || !category) score = Math.min(score, 30)

  const decision = hardReject || !configuredRegexResult.pass || !category
    ? 'skip'
    : score >= 65
      ? 'apply'
      : 'uncertain'

  return {
    decision,
    score,
    category: category?.category ?? 'unknown',
    keywordMatch,
    configuredRegex: configuredRegexResult,
    jdMatch: jdMatches,
    remoteFit,
    greetingTemplate: greeting.rule,
    greetingMessage: greeting.message,
    resumeImagePath: getResumeImagePath(bossConfig),
    reasons,
    presetTasks: buildPresetTasks({ decision, greeting, bossConfig }),
  }
}

function buildPresetTasks ({ decision, greeting, bossConfig }) {
  if (decision === 'skip') {
    return [{ type: 'mark_not_suit', dryRun: true }]
  }
  if (decision === 'uncertain') {
    return [{ type: 'manual_review', dryRun: true }]
  }
  const tasks = [
    { type: 'start_chat', dryRun: true },
    { type: 'send_greeting', template: greeting.rule, dryRun: true },
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

function matchConfiguredKeyword (job, bossConfig) {
  const text = jobText(job).toLowerCase()
  const keywords = getEnabledSearchKeywords(bossConfig)
  if (job.sourceKeyword && keywords.includes(job.sourceKeyword)) {
    return { keyword: job.sourceKeyword, tokenMatches: job.sourceKeyword.split(/\s+/).filter(Boolean).length }
  }
  let best = null
  let bestScore = 0
  for (const keyword of keywords) {
    const tokens = keyword.toLowerCase().split(/\s+/).filter(Boolean)
    const signalTokens = tokens.filter(token => !genericKeywordTokens.has(token))
    if (!signalTokens.length) continue
    if (!signalTokens.every(token => text.includes(token))) continue
    const score = tokens.filter(token => text.includes(token)).length
    if (score > bestScore) {
      best = keyword
      bestScore = score
    }
  }
  return { keyword: best, tokenMatches: bestScore }
}

function testConfiguredRegex (job, bossConfig) {
  const pattern = String(bossConfig.expectJobNameRegExpStr ?? '').trim()
  if (!pattern) return { pass: true, reason: 'no configured title regex' }
  try {
    const pass = new RegExp(pattern, 'im').test(job.title)
    return { pass, reason: pass ? 'title regex matched' : 'title regex did not match' }
  } catch (err) {
    return { pass: false, reason: `invalid configured title regex: ${err?.message ?? err}` }
  }
}
