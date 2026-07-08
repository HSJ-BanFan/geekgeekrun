import fs from 'node:fs'
import path from 'node:path'
import puppeteer from 'puppeteer'
import { storageFilePath } from '@geekgeekrun/geek-auto-start-chat-with-boss/runtime-file-utils.mjs'
import { openBrowser } from './browser-actions.mjs'

const chatPageUrl = 'https://www.zhipin.com/web/geek/chat'
const artifactSchemaVersion = 'recent-applications.v1'
const defaultLimit = 100
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

export async function runRecentApplications ({
  fromBrowser = false,
  limit = defaultLimit,
  includeJd = false,
  analyze = false,
  outputPath = '',
  analysisOutputPath = '',
  headless = false,
  browserUrl = '',
  cdpPort = '',
  now = new Date(),
} = {}) {
  if (!fromBrowser) {
    return {
      ok: false,
      command: 'recent-applications',
      reasonCode: 'FROM_BROWSER_REQUIRED',
      error: 'recent-applications requires --from-browser',
    }
  }

  const opened = await openRecentApplicationsBrowser({ headless, browserUrl, cdpPort })
  try {
    return await runRecentApplicationsOnOpenPage(opened.page, {
      limit,
      includeJd,
      analyze,
      outputPath,
      analysisOutputPath,
      now,
    })
  } finally {
    if (opened.shouldClose) await opened.browser?.close?.().catch(() => {})
  }
}

export async function runRecentApplicationsOnOpenPage (page, {
  limit = defaultLimit,
  includeJd = false,
  analyze = false,
  outputPath = '',
  analysisOutputPath = '',
  now = new Date(),
} = {}) {
  const captureTime = toIso(now)
  const resolvedLimit = toPositiveInt(limit, defaultLimit)
  const rawArtifactPath = resolveRecentApplicationsOutputPath(outputPath, captureTime)
  const artifact = createBaseArtifact({
    captureTime,
    limit: resolvedLimit,
    includeJd,
  })

  await writeArtifact(rawArtifactPath, artifact)
  await openChatPage(page)
  const listResult = await extractRecentApplicationListFromChatStore(page, { limit: resolvedLimit })

  if (!listResult.ok) {
    artifact.ok = false
    artifact.reasonCode = listResult.reasonCode
    artifact.statusSummary = summarizeRecords([])
    await writeArtifact(rawArtifactPath, artifact)
    return buildCommandSummary({
      artifact,
      rawArtifactPath,
      analysisArtifactPath: null,
    })
  }

  artifact.records = listResult.records.map(record => omitRuntimeFields(record))
  artifact.statusSummary = summarizeRecords(artifact.records)
  await writeArtifact(rawArtifactPath, artifact)

  for (let index = 0; index < listResult.records.length; index += 1) {
    const runtimeRecord = listResult.records[index]
    let record = artifact.records[index]

    if (!includeJd) {
      record = {
        ...record,
        status: 'skipped',
        reasonCode: 'JD_NOT_REQUESTED',
        jd: { status: 'skipped', reasonCode: 'JD_NOT_REQUESTED' },
      }
      artifact.records[index] = record
      continue
    }

    if (!runtimeRecord._detailUrl) {
      record = {
        ...record,
        status: 'failed',
        reasonCode: 'MISSING_JOB_IDENTITY_ANCHOR',
        jd: { status: 'failed', reasonCode: 'MISSING_JOB_IDENTITY_ANCHOR' },
      }
      artifact.records[index] = record
      artifact.statusSummary = summarizeRecords(artifact.records)
      await writeArtifact(rawArtifactPath, artifact)
      continue
    }

    const jd = await extractJobDescriptionFromDetailPage(page, runtimeRecord._detailUrl)
    if (jd.status === 'blocked') {
      record = {
        ...record,
        status: 'blocked',
        reasonCode: jd.reasonCode,
        jd,
      }
      artifact.records[index] = record
      artifact.ok = false
      artifact.reasonCode = jd.reasonCode
      artifact.statusSummary = summarizeRecords(artifact.records)
      await writeArtifact(rawArtifactPath, artifact)
      break
    }

    record = {
      ...record,
      status: jd.status === 'ok' ? 'ok' : 'failed',
      reasonCode: jd.status === 'ok' ? undefined : jd.reasonCode,
      jd,
    }
    artifact.records[index] = record
    artifact.statusSummary = summarizeRecords(artifact.records)
    await writeArtifact(rawArtifactPath, artifact)
  }

  artifact.statusSummary = summarizeRecords(artifact.records)
  if (!artifact.reasonCode && artifact.statusSummary.blocked > 0) {
    artifact.ok = false
    artifact.reasonCode = firstBlockedReason(artifact.records)
  }
  if (!artifact.reasonCode) {
    artifact.ok = true
  }
  await writeArtifact(rawArtifactPath, artifact)

  let analysisArtifactPath = null
  if (analyze) {
    const analysis = analyzeApplicationPreferences(artifact.records)
    analysisArtifactPath = resolveAnalysisOutputPath(analysisOutputPath, rawArtifactPath)
    await writeArtifact(analysisArtifactPath, {
      schemaVersion: 'recent-application-preferences.v1',
      generatedAt: captureTime,
      sourceArtifactPath: rawArtifactPath,
      ...analysis,
    })
  }

  return buildCommandSummary({
    artifact,
    rawArtifactPath,
    analysisArtifactPath,
  })
}

export async function extractRecentApplicationListFromChatStore (page, { limit = defaultLimit } = {}) {
  const raw = await page.evaluate(readChatStoreStateInPage)

  if (!raw?.ok) {
    return {
      ok: false,
      reasonCode: raw?.reasonCode ?? 'BOSS_CHAT_STORE_UNAVAILABLE',
      records: [],
    }
  }

  const records = raw.friendInfos
    .map(normalizeFriendInfo)
    .filter(record => record.timestamp > 0 || record.title || record.company || record.conversationId)
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, toPositiveInt(limit, defaultLimit))
    .map((record, index) => ({
      ...record,
      rank: index + 1,
    }))

  return { ok: true, records }
}

export async function extractJobDescriptionFromDetailPage (page, detailUrl) {
  await page.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {})
  await page.waitForFunction?.(() => document.readyState === 'complete', { timeout: 60000 }).catch(() => {})
  await sleep(1200)

  const detail = await page.evaluate(readJobDetailStateInPage)

  const safetyReason = detectBlockingReason(detail?.visibleText, detail?.url)
  if (safetyReason) {
    return {
      status: 'blocked',
      reasonCode: safetyReason,
      resolvedUrl: redactUrl(detail?.url ?? page.url?.() ?? detailUrl),
    }
  }

  const jdText = String(detail?.jdText ?? '').trim()
  if (!jdText) {
    return {
      status: 'failed',
      reasonCode: 'JD_DOM_EXTRACTION_FAILED',
      resolvedUrl: redactUrl(detail?.url ?? page.url?.() ?? detailUrl),
      pageTitle: detail?.pageTitle ?? '',
    }
  }

  return {
    status: 'ok',
    source: 'boss_job_detail_dom',
    text: jdText,
    characterCount: Array.from(jdText).length,
    resolvedUrl: redactUrl(detail?.url ?? page.url?.() ?? detailUrl),
    pageTitle: detail?.pageTitle ?? '',
    salary: detail?.salary ?? '',
    companyDescription: detail?.companyDescription ?? '',
  }
}

// Both readers below run inside the BOSS page via page.evaluate, so they must
// stay self-contained: no references to module-scope helpers or constants.
// Keep their login/safety text checks in sync with detectBlockingReason.
export function readChatStoreStateInPage () {
  const bodyText = document.body?.innerText ?? ''
  const url = location.href
  if (/登录\/注册|请登录|扫码登录|验证码登录|登录后继续/.test(bodyText)) {
    return { ok: false, reasonCode: 'BOSS_LOGIN_REQUIRED', url, visibleText: bodyText.slice(0, 500) }
  }
  if (/安全验证|环境异常|验证后继续|拖动滑块/.test(bodyText)) {
    return { ok: false, reasonCode: 'BOSS_SAFETY_VERIFICATION_REQUIRED', url, visibleText: bodyText.slice(0, 500) }
  }
  const friendInfos = window.chatStore?.friendInfos
  if (!friendInfos) {
    return { ok: false, reasonCode: 'BOSS_CHAT_STORE_UNAVAILABLE', url, visibleText: bodyText.slice(0, 500) }
  }
  const values = Array.isArray(friendInfos) ? friendInfos : Object.values(friendInfos)
  return { ok: true, url, friendInfos: values }
}

export function readJobDetailStateInPage () {
  const bodyText = document.body?.innerText ?? ''
  const url = location.href
  const pageTitle = document.title ?? ''
  const visibleText = bodyText.slice(0, 1200)
  const selectors = [
    '.job-detail-section .job-sec-text',
    '.job-sec .job-sec-text',
    '.job-detail-box .job-sec-text',
    '[class*="job-sec-text"]',
  ]
  let jdText = ''
  for (const selector of selectors) {
    const text = document.querySelector(selector)?.innerText?.trim?.()
    if (text) {
      jdText = text
      break
    }
  }
  if (!jdText) {
    const headings = [...document.querySelectorAll('h1,h2,h3,h4,.job-sec-title,.title,[class*="title"]')]
    const heading = headings.find(el => /职位描述|岗位职责|工作职责|职位详情/.test(el.textContent ?? ''))
    const section = heading?.closest?.('.job-detail-section,.job-sec,section,div')
    jdText = section?.querySelector?.('.job-sec-text,[class*="text"],p')?.innerText?.trim?.() ??
      section?.innerText?.replace(/职位描述|岗位职责|工作职责|职位详情/, '').trim?.() ??
      ''
  }
  const salary = document.querySelector('.salary,.job-salary,[class*="salary"]')?.innerText?.trim?.() ?? ''
  const companyDescription = document.querySelector('.company-info,.sider-company,[class*="company"] .text')?.innerText?.trim?.() ?? ''
  return { url, pageTitle, visibleText, jdText, salary, companyDescription }
}

export function analyzeApplicationPreferences (records) {
  const titleCategoryCounts = Object.fromEntries(categoryDefinitions.map(item => [item.key, 0]))
  const jdTermCounts = Object.fromEntries(jdTerms.map(term => [term.key, 0]))
  const cityCounts = new Map()
  const positionCategoryCounts = new Map()
  const coreTargetExamples = []
  const mixedNoisyExamples = []
  const likelyNoiseExamples = []
  const recruiterLastMessageExamples = []

  for (const record of records ?? []) {
    const title = String(record?.title ?? '')
    const jdText = String(record?.jd?.text ?? record?.jdText ?? '')
    const categoryHaystack = `${title}\n${record?.positionCategory ?? ''}`.toLowerCase()
    const termHaystack = `${title}\n${record?.positionCategory ?? ''}\n${jdText}`.toLowerCase()
    const matchedCategories = []
    for (const category of categoryDefinitions) {
      if (category.pattern.test(categoryHaystack)) {
        titleCategoryCounts[category.key] += 1
        matchedCategories.push(category.key)
      }
    }
    for (const term of jdTerms) {
      if (term.pattern.test(termHaystack)) jdTermCounts[term.key] += 1
    }
    incrementCount(cityCounts, record?.city)
    incrementCount(positionCategoryCounts, record?.positionCategory)

    const targetMatches = matchedCategories.filter(item => targetCategoryKeys.has(item))
    const noiseMatches = matchedCategories.filter(item => noiseCategoryKeys.has(item))
    const example = buildPreferenceExample(record, matchedCategories, noiseMatches)
    if (targetMatches.length && !noiseMatches.length && coreTargetExamples.length < 10) {
      coreTargetExamples.push(example)
    } else if (targetMatches.length && noiseMatches.length && mixedNoisyExamples.length < 10) {
      mixedNoisyExamples.push(example)
    } else if (!targetMatches.length && noiseMatches.length && likelyNoiseExamples.length < 10) {
      likelyNoiseExamples.push(example)
    }

    const lastMessageText = String(record?.lastMessage?.text ?? '').trim()
    if (lastMessageText && recruiterLastMessageExamples.length < 20) {
      recruiterLastMessageExamples.push({
        rank: record?.rank,
        title: record?.title ?? '',
        company: record?.company ?? '',
        recruiter: record?.recruiter?.name ?? '',
        direction: String(record?.lastMessage?.direction ?? ''),
        lastMessage: lastMessageText,
      })
    }
  }

  return {
    titleCategoryCounts,
    jdTermCounts,
    topCities: topCounts(cityCounts),
    topPositionCategories: topCounts(positionCategoryCounts),
    coreTargetExamples,
    mixedNoisyExamples,
    likelyNoiseExamples,
    recruiterLastMessageExamples,
  }
}

async function openRecentApplicationsBrowser ({ headless = false, browserUrl = '', cdpPort = '' } = {}) {
  const endpoint = browserUrl || (cdpPort ? `http://127.0.0.1:${cdpPort}` : '')
  if (endpoint) {
    const connectOptions = /^wss?:\/\//i.test(endpoint)
      ? { browserWSEndpoint: endpoint }
      : { browserURL: endpoint }
    const browser = await puppeteer.connect(connectOptions)
    const pages = await browser.pages()
    const page = pages.find(item => item.url?.().includes('zhipin.com')) ?? pages[0] ?? await browser.newPage()
    return { browser, page, shouldClose: false }
  }
  return { ...(await openBrowser({ headless })), shouldClose: true }
}

async function openChatPage (page) {
  await page.goto(chatPageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {})
  await page.waitForFunction?.(() => document.readyState === 'complete', { timeout: 60000 }).catch(() => {})
  await sleep(2500)
}

function createBaseArtifact ({ captureTime, limit, includeJd }) {
  return {
    schemaVersion: artifactSchemaVersion,
    ok: false,
    command: 'recent-applications',
    captureMetadata: {
      capturedAt: captureTime,
      limit,
      includeJd,
      readOnly: true,
      authorization: {
        issuesApplicationAuthorization: false,
        consumesApplicationAuthorizationToken: false,
      },
    },
    sourceStrategy: {
      list: 'chatStore.friendInfos',
      jd: includeJd ? 'boss_job_detail_dom' : 'not_requested',
      browserActions: 'read_only_navigation',
    },
    statusSummary: summarizeRecords([]),
    records: [],
  }
}

function normalizeFriendInfo (item) {
  const job = firstObject(item?.jobInfo, item?.job, item?.position, item?.targetJobData, item?.expectJob)
  const boss = firstObject(item?.bossInfo, item?.boss, item?.recruiter, item?.userInfo, item?.friendInfo)
  const timestamp = normalizeTimestamp(firstNumber(
    item?.lastTS,
    item?.lastTs,
    item?.lastTime,
    item?.updateTime,
    item?.lastUpdateTime,
    item?.sortTime,
    item?.activeTime,
    job?.lastTS,
    job?.updateTime
  ))
  const encryptJobId = firstString(item?.encryptJobId, item?.encryptId, item?.jobId, job?.encryptJobId, job?.encryptId, job?.jobId)
  const numericJobId = firstString(item?.numericJobId, item?.jobIdNumber, item?.jobIdNum, job?.numericJobId, job?.jobIdNumber, job?.jobIdNum)
  const securityId = firstString(item?.securityId, job?.securityId)
  const lastMessage = normalizeLastMessage(item)
  const record = {
    rank: 0,
    status: 'pending',
    conversationId: firstString(item?.friendId, item?.conversationId, item?.encryptBossId, item?.uid, item?.id),
    timestamp,
    timestampIso: timestamp ? new Date(timestamp).toISOString() : '',
    title: firstString(item?.jobName, item?.title, item?.positionName, job?.jobName, job?.title, job?.positionName),
    company: firstString(item?.brandName, item?.companyName, item?.company, job?.brandName, job?.companyName, job?.company),
    city: firstString(item?.cityName, item?.city, job?.cityName, job?.city),
    positionCategory: firstString(item?.positionCategory, item?.positionCategoryName, job?.positionCategory, job?.positionCategoryName),
    recruiter: {
      name: firstString(item?.bossName, item?.recruiterName, item?.name, boss?.bossName, boss?.name),
      title: firstString(item?.bossTitle, item?.recruiterTitle, boss?.title, boss?.position),
      id: firstString(item?.encryptBossId, item?.bossId, boss?.encryptBossId, boss?.bossId),
    },
    lastMessage,
    jobIdentityAnchor: {
      jobId: numericJobId || encryptJobId || '',
      encryptJobId,
      hasSecurityId: Boolean(securityId),
      securityIdRedacted: securityId ? redactSecurityId(securityId) : '',
    },
    jd: { status: 'pending' },
  }
  return {
    ...record,
    _detailUrl: encryptJobId ? buildBossDetailUrl({ encryptJobId, securityId }) : '',
  }
}

function normalizeLastMessage (item) {
  const raw = firstObject(item?.lastMessage, item?.lastMsgObj, item?.latestMessage)
  return {
    text: firstString(item?.lastMsg, item?.lastMessageText, item?.lastMsgContent, raw?.text, raw?.content, raw?.message),
    direction: firstString(item?.lastMsgDirection, item?.lastMessageDirection, raw?.direction, raw?.from),
    status: firstString(item?.lastMsgStatus, item?.lastMessageStatus, raw?.status),
    timestamp: firstNumber(item?.lastMsgTime, raw?.timestamp, raw?.time),
  }
}

function buildBossDetailUrl ({ encryptJobId, securityId }) {
  const url = new URL(`https://www.zhipin.com/job_detail/${encodeURIComponent(encryptJobId)}.html`)
  if (securityId) url.searchParams.set('securityId', securityId)
  return url.toString()
}

function omitRuntimeFields (record) {
  const { _detailUrl, ...publicRecord } = record
  return publicRecord
}

function summarizeRecords (records) {
  const summary = {
    total: records.length,
    ok: 0,
    failed: 0,
    blocked: 0,
    skipped: 0,
    pending: 0,
    jd: {
      ok: 0,
      failed: 0,
      blocked: 0,
      skipped: 0,
      pending: 0,
    },
    reasonCodes: {},
  }
  for (const record of records) {
    const status = record.status || 'pending'
    summary[status] = (summary[status] ?? 0) + 1
    const jdStatus = record.jd?.status || 'pending'
    summary.jd[jdStatus] = (summary.jd[jdStatus] ?? 0) + 1
    if (record.reasonCode) summary.reasonCodes[record.reasonCode] = (summary.reasonCodes[record.reasonCode] ?? 0) + 1
    if (record.jd?.reasonCode && record.jd.reasonCode !== record.reasonCode) {
      summary.reasonCodes[record.jd.reasonCode] = (summary.reasonCodes[record.jd.reasonCode] ?? 0) + 1
    }
  }
  return summary
}

function buildCommandSummary ({ artifact, rawArtifactPath, analysisArtifactPath }) {
  return {
    ok: Boolean(artifact.ok),
    command: 'recent-applications',
    reasonCode: artifact.reasonCode,
    recordCount: artifact.records.length,
    statusSummary: artifact.statusSummary,
    jdStatusSummary: artifact.statusSummary.jd,
    rawArtifactPath,
    analysisArtifactPath,
  }
}

async function writeArtifact (outputPath, artifact) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8')
}

function resolveRecentApplicationsOutputPath (outputPath, captureTime) {
  if (outputPath) return path.resolve(outputPath)
  return path.join(storageFilePath, 'recent-applications', `recent-applications-${fileTimestamp(captureTime)}.json`)
}

function resolveAnalysisOutputPath (analysisOutputPath, rawArtifactPath) {
  if (analysisOutputPath) return path.resolve(analysisOutputPath)
  return rawArtifactPath.replace(/\.json$/i, '.analysis.json')
}

function detectBlockingReason (text, url = '') {
  const haystack = `${url}\n${text ?? ''}`
  if (/登录\/注册|请登录|扫码登录|验证码登录|登录后继续/.test(haystack)) return 'BOSS_LOGIN_REQUIRED'
  if (/安全验证|环境异常|验证后继续|拖动滑块|verify|security-check/i.test(haystack)) return 'BOSS_SAFETY_VERIFICATION_REQUIRED'
  return ''
}

function firstBlockedReason (records) {
  return records.find(record => record.status === 'blocked')?.reasonCode ?? ''
}

function buildPreferenceExample (record, matchedCategories, noiseCategories) {
  return {
    rank: record?.rank,
    title: record?.title ?? '',
    company: record?.company ?? '',
    city: record?.city ?? '',
    positionCategory: record?.positionCategory ?? '',
    matchedCategories,
    noiseReasons: noiseCategories,
  }
}

function incrementCount (counts, value) {
  const key = String(value ?? '').trim()
  if (!key) return
  counts.set(key, (counts.get(key) ?? 0) + 1)
}

function topCounts (counts) {
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value, 'zh-CN'))
}

function redactSecurityId (value) {
  const raw = String(value)
  if (!raw) return ''
  if (raw.length <= 8) return '[REDACTED]'
  return `${raw.slice(0, 3)}...[REDACTED]...${raw.slice(-3)}`
}

function redactUrl (value) {
  const raw = String(value ?? '')
  if (!raw) return ''
  try {
    const url = new URL(raw)
    if (url.searchParams.has('securityId')) url.searchParams.set('securityId', '[REDACTED]')
    return url.toString()
  } catch {
    return raw.replace(/([?&]securityId=)[^&#]+/i, '$1[REDACTED]')
  }
}

function toPositiveInt (value, fallback) {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function normalizeTimestamp (timestamp) {
  return timestamp > 9999999999 ? timestamp : timestamp * 1000
}

function toIso (value) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function fileTimestamp (iso) {
  return String(iso).replace(/[:.]/g, '-')
}

function firstObject (...values) {
  return values.find(value => value && typeof value === 'object') ?? {}
}

function firstString (...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number') return String(value)
  }
  return ''
}

function firstNumber (...values) {
  for (const value of values) {
    const parsed = Number(value)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return 0
}

const categoryDefinitions = [
  { key: 'ai_llm_agent_aigc', pattern: /\b(ai|llm|agent|aigc|gpt)\b|大模型|智能体|生成式|人工智能/i },
  { key: 'full_stack', pattern: /全栈|full[-\s]?stack/i },
  { key: 'python_backend_data_engineering', pattern: /python|fastapi|django|flask|后端|数据工程|数据管道|pipeline/i },
  { key: 'frontend_react_vue', pattern: /前端|react|vue|typescript|javascript|next\.?js/i },
  { key: 'java_traditional_backend', pattern: /java|spring|mybatis|传统后端/i },
  { key: 'data_annotation_ai_training', pattern: /数据标注|ai训练|训练师|语料|标注|数据采集/i },
  { key: 'translation_localization_japanese', pattern: /翻译|本地化|日语|日本语|英语|localization/i },
  { key: 'testing_it_generic', pattern: /测试|qa|运维|实施|it支持|技术支持/i },
  { key: 'product_operations_audit_data_entry', pattern: /产品运营|运营|审核|审核运营|录入|客服|销售|金融|电销/i },
  { key: 'remote_part_time', pattern: /远程|兼职|part[-\s]?time|外包|项目制/i },
  { key: 'internship_new_grad', pattern: /实习|实习生|校招|应届|新卒|new grad/i },
]

const targetCategoryKeys = new Set([
  'ai_llm_agent_aigc',
  'full_stack',
  'python_backend_data_engineering',
  'frontend_react_vue',
])

const noiseCategoryKeys = new Set([
  'data_annotation_ai_training',
  'translation_localization_japanese',
  'testing_it_generic',
  'product_operations_audit_data_entry',
  'remote_part_time',
  'internship_new_grad',
])

const jdTerms = [
  { key: 'llm', pattern: /\bllm\b|大模型|gpt|智能体|agent/i },
  { key: 'python', pattern: /python/i },
  { key: 'fastapi', pattern: /fastapi/i },
  { key: 'react', pattern: /react/i },
  { key: 'vue', pattern: /\bvue\b/i },
  { key: 'data_pipeline', pattern: /数据管道|pipeline|etl/i },
  { key: 'annotation', pattern: /数据标注|标注/i },
  { key: 'translation', pattern: /翻译|本地化|日语|localization/i },
  { key: 'testing', pattern: /测试|qa/i },
  { key: 'remote_part_time', pattern: /远程|兼职|part[-\s]?time/i },
]
