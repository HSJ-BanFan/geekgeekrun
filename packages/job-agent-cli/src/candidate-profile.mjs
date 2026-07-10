import { getEnabledRecallKeywords, getGreetingRules, readRuntimeConfigFile } from './config.mjs'
import { isSensitiveProfileSignal, redactSensitiveFragments } from './sensitive-text.mjs'

const genericIntentTokens = new Set([
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

const maxSignalCount = 120

export function buildCandidateProfile (bossConfig = {}, { resume = readPrimaryResume() } = {}) {
  const recallKeywords = getEnabledRecallKeywords(bossConfig)
  const titleRegex = String(bossConfig.expectJobNameRegExpStr ?? bossConfig.expectJobRegExpStr ?? '').trim()
  const typeRegex = String(bossConfig.expectJobTypeRegExpStr ?? '').trim()
  const descRegex = String(bossConfig.expectJobDescRegExpStr ?? '').trim()
  const greetingRules = getGreetingRules(bossConfig).map(rule => ({
    name: rule.name,
    pattern: rule.pattern,
  }))
  const resumeMarkdown = resume ? formatResumeForMatching(resume) : ''
  const intentText = [
    resume?.content?.expectJob,
    resume?.content?.userDescription,
    greetingRules.map(rule => `${rule.name}\n${rule.pattern}`).join('\n'),
  ].filter(Boolean).join('\n')

  return {
    resumeAvailable: Boolean(resume),
    expectedJob: String(resume?.content?.expectJob ?? '').trim(),
    workYearDesc: String(resume?.content?.workYearDesc ?? '').trim(),
    recallKeywords,
    titleRegex,
    typeRegex,
    descRegex,
    greetingRules,
    intentSignals: extractIntentSignals(intentText),
    resumeSignals: extractResumeSignals(resumeMarkdown),
    resumeMarkdown,
    requiresLlmForFinalDecision: Boolean(resume || recallKeywords.length || titleRegex || typeRegex || descRegex),
  }
}

export function summarizeCandidateProfile (candidateProfile) {
  return {
    resumeAvailable: Boolean(candidateProfile?.resumeAvailable),
    expectedJob: sanitizeSummaryText(candidateProfile?.expectedJob ?? ''),
    workYearDesc: sanitizeSummaryText(candidateProfile?.workYearDesc ?? ''),
    recallKeywordCount: candidateProfile?.recallKeywords?.length ?? 0,
    recallKeywords: candidateProfile?.recallKeywords ?? [],
    titleRegex: sanitizeSummaryText(candidateProfile?.titleRegex ?? ''),
    typeRegex: sanitizeSummaryText(candidateProfile?.typeRegex ?? ''),
    descRegex: sanitizeSummaryText(candidateProfile?.descRegex ?? ''),
    intentSignals: sanitizeProfileSignals(candidateProfile?.intentSignals ?? []),
    resumeSignalCount: candidateProfile?.resumeSignals?.length ?? 0,
    resumeSignals: sanitizeProfileSignals(candidateProfile?.resumeSignals ?? []).slice(0, 40),
    requiresLlmForFinalDecision: Boolean(candidateProfile?.requiresLlmForFinalDecision),
  }
}

export function limitResumeMarkdown (candidateProfile, maxLength = 8000) {
  const text = String(candidateProfile?.resumeMarkdown ?? '').trim()
  if (text.length <= maxLength) return text
  return `${text.slice(0, maxLength)}\n\n[TRUNCATED]`
}

function readPrimaryResume () {
  const resumes = readRuntimeConfigFile('resumes.json')
  return Array.isArray(resumes) ? resumes[0] ?? null : null
}

function formatResumeForMatching (resume) {
  const content = resume?.content ?? {}
  const sections = [
    ['# 工作年限', content.workYearDesc],
    ['# 期望职位', content.expectJob],
    ['# 个人优势', content.userDescription],
    ['# 工作经历', formatWorkExperiences(content.geekWorkExpList)],
    ['# 项目经历', formatProjectExperiences(content.geekProjExpList)],
  ]
  return sections
    .filter(([, value]) => String(value ?? '').trim())
    .map(([heading, value]) => `${heading}\n${String(value).trim()}`)
    .join('\n\n')
}

function formatWorkExperiences (items) {
  if (!Array.isArray(items)) return ''
  return items
    .filter(item => String(item?.company ?? item?.positionName ?? item?.workDescription ?? '').trim())
    .map(item => [
      `## ${String(item.company ?? '').trim()}`.trim(),
      String(item.positionName ?? '').trim() ? `职务\n${String(item.positionName).trim()}` : '',
      String(item.workDescription ?? '').trim() ? `工作描述\n${String(item.workDescription).trim()}` : '',
      String(item.performance ?? '').trim() ? `工作业绩\n${String(item.performance).trim()}` : '',
    ].filter(Boolean).join('\n\n'))
    .join('\n\n')
}

function formatProjectExperiences (items) {
  if (!Array.isArray(items)) return ''
  return items
    .filter(item => String(item?.name ?? item?.roleName ?? item?.projectDescription ?? '').trim())
    .map(item => [
      `## ${String(item.name ?? '').trim()}`.trim(),
      String(item.roleName ?? '').trim() ? `项目角色\n${String(item.roleName).trim()}` : '',
      String(item.projectDescription ?? '').trim() ? `工作描述\n${String(item.projectDescription).trim()}` : '',
      String(item.performance ?? '').trim() ? `工作业绩\n${String(item.performance).trim()}` : '',
    ].filter(Boolean).join('\n\n'))
    .join('\n\n')
}

function extractIntentSignals (text) {
  return extractSignals(text).slice(0, 80)
}

function extractResumeSignals (text) {
  return extractSignals(text).slice(0, maxSignalCount)
}

function extractSignals (text) {
  const source = String(text ?? '')
    .replace(/[\\^$.*+?()[\]{}|]/g, ' ')
  const tokens = source.match(/[A-Za-z][A-Za-z0-9+#._-]*|[\u4e00-\u9fff]{2,}/g) ?? []
  const result = []
  const seen = new Set()
  for (const rawToken of tokens) {
    const token = normalizeSignal(rawToken)
    const key = token.toLowerCase()
    if (!token || seen.has(key) || genericIntentTokens.has(token) || genericIntentTokens.has(key)) continue
    seen.add(key)
    result.push(token)
  }
  return result
}

function normalizeSignal (token) {
  return String(token ?? '')
    .trim()
    .replace(/^[^\u4e00-\u9fffA-Za-z0-9+#._-]+|[^\u4e00-\u9fffA-Za-z0-9+#._-]+$/g, '')
}

function sanitizeProfileSignals (signals) {
  return signals.filter(signal => !isSensitiveProfileSignal(signal))
}

function sanitizeSummaryText (text) {
  return redactSensitiveFragments(text)
}
