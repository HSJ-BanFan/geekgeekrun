import fs from 'node:fs'
import path from 'node:path'
import puppeteer from 'puppeteer'
import { storageFilePath } from '@geekgeekrun/geek-auto-start-chat-with-boss/runtime-file-utils.mjs'
import { openBrowser } from './browser-actions.mjs'
import { resolveCityCode } from './city-codes.mjs'

const commandName = 'market-jobs'
const artifactSchemaVersion = 'market-jobs.v1'
const searchPageUrl = 'https://www.zhipin.com/web/geek/jobs'
const defaultLimit = 200
const maxLimit = 500
const noNewItemStopThreshold = 2
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const commandStoppingReasonCodes = new Set([
  'BOSS_LOGIN_REQUIRED',
  'BOSS_SAFETY_VERIFICATION_REQUIRED',
  'BOSS_ABNORMAL_ENVIRONMENT',
  'BOSS_SEARCH_LIST_UNAVAILABLE',
  'BOSS_JOB_DETAIL_UNCONFIRMED',
])

export async function runMarketJobs ({
  fromBrowser = false,
  planOnly = false,
  keywords = [],
  cities = [],
  recallKeywords = [],
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
  if (!planOnly && !fromBrowser) {
    return failure('FROM_BROWSER_REQUIRED', 'market-jobs requires --from-browser unless --plan-only is set')
  }

  const marketKeywords = normalizeList(keywords)
  const legacyRecallKeywords = normalizeList(recallKeywords)
  if (!marketKeywords.length) {
    return failure(
      'MARKET_KEYWORD_REQUIRED',
      legacyRecallKeywords.length
        ? 'market-jobs uses --keyword; do not use --recall-keyword for Market Keywords'
        : 'market-jobs requires at least one --keyword'
    )
  }

  const cityInputs = normalizeList(cities)
  if (!cityInputs.length) {
    return failure('MARKET_CITY_REQUIRED', 'market-jobs requires at least one --city')
  }

  const limitResult = normalizeLimit(limit)
  if (!limitResult.ok) {
    return {
      ...failure(limitResult.reasonCode, limitResult.error),
      maxLimit,
    }
  }

  const resolvedCities = []
  for (const cityInput of cityInputs) {
    const cityCode = resolveCityCode(cityInput)
    if (!cityCode) {
      return failure('MARKET_CITY_NOT_RESOLVED', `could not resolve BOSS city code for --city ${cityInput}`)
    }
    resolvedCities.push({ cityInput, cityCode })
  }

  if (!planOnly && analyze) {
    return failure('MARKET_JOBS_ANALYSIS_NOT_IMPLEMENTED', '--analyze for browser-backed market-jobs is implemented in a later slice')
  }

  const captureTime = toIso(now)
  const rawArtifactPath = resolveMarketJobsOutputPath(outputPath, captureTime)
  const plannedSamples = buildPlannedSamples({
    keywords: marketKeywords,
    cities: resolvedCities,
    requestedLimit: limitResult.limit,
  })

  if (!planOnly) {
    const opened = await openMarketJobsBrowser({ headless, browserUrl, cdpPort })
    try {
      return await runMarketJobsOnOpenPage(opened.page, {
        keywords: marketKeywords,
        cities: resolvedCities,
        limit: limitResult.limit,
        includeJd,
        analyze,
        outputPath: rawArtifactPath,
        analysisOutputPath,
        now,
      })
    } finally {
      if (opened.shouldClose) await opened.browser?.close?.().catch(() => {})
    }
  }

  return {
    ok: true,
    command: commandName,
    mode: 'plan-only',
    schemaVersion: artifactSchemaVersion,
    sampleCount: plannedSamples.length,
    jobCount: 0,
    requestedLimitPerSample: limitResult.limit,
    plannedRecordBudget: plannedSamples.length * limitResult.limit,
    statusSummary: {},
    rawArtifactPath,
    analysisArtifactPath: analyze ? resolveAnalysisOutputPath(analysisOutputPath, rawArtifactPath) : null,
    reasonCode: null,
    plannedSamples,
  }
}

export async function runMarketJobsOnOpenPage (page, {
  keywords = [],
  cities = [],
  limit = defaultLimit,
  includeJd = false,
  analyze = false,
  outputPath = '',
  analysisOutputPath = '',
  navigationSettleMs = 5000,
  scrollSettleMs = 1500,
  detailNavigationSettleMs = 1200,
  now = new Date(),
} = {}) {
  const marketKeywords = normalizeList(keywords)
  const resolvedCities = normalizeResolvedCities(cities)
  const limitResult = normalizeLimit(limit)
  if (!limitResult.ok) {
    return {
      ...failure(limitResult.reasonCode, limitResult.error),
      maxLimit,
    }
  }
  if (analyze) {
    return failure('MARKET_JOBS_ANALYSIS_NOT_IMPLEMENTED', '--analyze for browser-backed market-jobs is implemented in a later slice')
  }

  const plannedSamples = buildPlannedSamples({
    keywords: marketKeywords,
    cities: resolvedCities,
    requestedLimit: limitResult.limit,
  })

  const captureTime = toIso(now)
  const rawArtifactPath = resolveMarketJobsOutputPath(outputPath, captureTime)
  const artifact = createBaseArtifact({
    captureTime,
    keywords: marketKeywords,
    cities: resolvedCities,
    requestedLimit: limitResult.limit,
    includeJd,
  })
  await writeArtifact(rawArtifactPath, artifact)

  const jobByIdentityKey = new Map()
  const detailUrlByIdentityKey = new Map()

  for (const plannedSample of plannedSamples) {
    const sample = {
      ...plannedSample,
      status: 'pending',
      reasonCode: null,
      capturedCount: 0,
      dedupedJobCount: 0,
      scrollCount: 0,
      noNewItemCount: 0,
      startedAt: captureTime,
      endedAt: null,
    }
    artifact.samples.push(sample)
    artifact.statusSummary = summarizeMarketArtifact(artifact)
    await writeArtifact(rawArtifactPath, artifact)

    await openMarketJobsSearchPage(page, {
      keyword: sample.keyword,
      cityCode: sample.cityCode,
      settleMs: navigationSettleMs,
    })

    const sampleObservationKeys = new Set()
    let shouldContinue = true

    while (shouldContinue) {
      const listResult = await extractMarketJobsListFromPage(page)
      if (!listResult.ok) {
        sample.status = isCommandStoppingReason(listResult.reasonCode) ? 'blocked' : 'failed'
        sample.reasonCode = listResult.reasonCode
        sample.endedAt = captureTime
        artifact.ok = false
        artifact.reasonCode = listResult.reasonCode
        artifact.statusSummary = summarizeMarketArtifact(artifact)
        await writeArtifact(rawArtifactPath, artifact)
        return buildCommandSummary({
          artifact,
          rawArtifactPath,
          analysisArtifactPath: null,
        })
      }

      const beforeCount = sample.capturedCount
      for (const rawJob of listResult.jobs) {
        if (sample.capturedCount >= limitResult.limit) break
        const rank = getMarketJobObservationRank(rawJob, sample.capturedCount + 1)
        const normalizedJob = normalizeMarketJob(rawJob, {
          sampleKey: sample.sampleKey,
          rank,
          sourceUrl: listResult.url,
          includeJd,
        })
        const detailUrl = resolveMarketJobRuntimeDetailUrl(rawJob, normalizedJob)
        if (detailUrl && !detailUrlByIdentityKey.has(normalizedJob.jobIdentity.key)) {
          detailUrlByIdentityKey.set(normalizedJob.jobIdentity.key, detailUrl)
        }
        const observationKey = `${sample.sampleKey}|${normalizedJob.jobIdentity.key}`
        if (sampleObservationKeys.has(observationKey)) continue
        sampleObservationKeys.add(observationKey)
        sample.capturedCount += 1
        upsertMarketJob(artifact, jobByIdentityKey, normalizedJob)
      }

      sample.dedupedJobCount = countJobsObservedInSample(artifact.jobs, sample.sampleKey)
      artifact.statusSummary = summarizeMarketArtifact(artifact)
      await writeArtifact(rawArtifactPath, artifact)

      if (sample.capturedCount >= limitResult.limit) {
        sample.status = 'ok'
        sample.reasonCode = 'LIMIT_REACHED'
        sample.endedAt = captureTime
        shouldContinue = false
        break
      }

      if (sample.capturedCount === beforeCount) sample.noNewItemCount += 1
      else sample.noNewItemCount = 0

      if (sample.noNewItemCount >= noNewItemStopThreshold) {
        sample.status = 'ok'
        sample.reasonCode = 'NO_NEW_ITEMS'
        sample.endedAt = captureTime
        shouldContinue = false
        break
      }

      await scrollMarketJobsList(page, { settleMs: scrollSettleMs })
      sample.scrollCount += 1
    }
  }

  if (includeJd) {
    const jdResult = await enrichMarketJobsWithJd(page, artifact, {
      detailUrlByIdentityKey,
      outputPath: rawArtifactPath,
      settleMs: detailNavigationSettleMs,
    })
    if (!jdResult.ok) {
      return buildCommandSummary({
        artifact,
        rawArtifactPath,
        analysisArtifactPath: null,
      })
    }
  }

  artifact.ok = true
  artifact.reasonCode = null
  artifact.statusSummary = summarizeMarketArtifact(artifact)
  await writeArtifact(rawArtifactPath, artifact)

  return buildCommandSummary({
    artifact,
    rawArtifactPath,
    analysisArtifactPath: null,
  })
}

export async function extractMarketJobsListFromPage (page) {
  return await page.evaluate(readMarketJobsListStateInPage)
}

// Runs inside the BOSS page via page.evaluate. Keep it self-contained.
export function readMarketJobsListStateInPage () {
  const bodyText = document.body?.innerText ?? ''
  const url = location.href
  if (/登录\/注册|请登录|扫码登录|验证码登录|登录后继续/.test(bodyText)) {
    return { ok: false, reasonCode: 'BOSS_LOGIN_REQUIRED', url, visibleText: bodyText.slice(0, 500), jobs: [] }
  }
  if (/安全验证|验证后继续|拖动滑块|verify|security-check/i.test(`${url}\n${bodyText}`)) {
    return { ok: false, reasonCode: 'BOSS_SAFETY_VERIFICATION_REQUIRED', url, visibleText: bodyText.slice(0, 500), jobs: [] }
  }
  if (/环境异常|abnormal/i.test(`${url}\n${bodyText}`)) {
    return { ok: false, reasonCode: 'BOSS_ABNORMAL_ENVIRONMENT', url, visibleText: bodyText.slice(0, 500), jobs: [] }
  }

  const selectors = [
    'ul.rec-job-list li.job-card-box',
    'li.job-card-box',
    '.job-card-wrapper',
    '.job-list-box li',
  ]
  const cards = selectors.flatMap(selector => [...document.querySelectorAll(selector)])
  const uniqueCards = [...new Set(cards)].filter(el => String(el?.innerText ?? '').trim())
  if (!uniqueCards.length) {
    return { ok: false, reasonCode: 'BOSS_SEARCH_LIST_UNAVAILABLE', url, visibleText: bodyText.slice(0, 500), jobs: [] }
  }

  return {
    ok: true,
    url,
    jobs: uniqueCards.map((el, index) => extractCard(el, index + 1)),
  }

  function extractCard (el, rank) {
    const data = pickJobData(el.__vue__)
    const text = el.innerText?.trim?.() ?? ''
    const jobId = firstString(
      data?.encryptId,
      data?.encryptJobId,
      data?.jobId,
      data?.jobInfo?.encryptId,
      data?.jobInfo?.encryptJobId,
      data?.jobInfo?.jobId,
      el.getAttribute?.('data-jobid'),
      el.querySelector?.('a[href*="/job_detail/"]')?.getAttribute?.('href')?.match?.(/job_detail\/([^/.?]+)\.html/)?.[1]
    )
    const detailUrl = firstString(
      data?.detailUrl,
      data?.jobUrl,
      data?.url,
      data?.jobInfo?.detailUrl,
      data?.jobInfo?.jobUrl,
      el.querySelector?.('a[href*="/job_detail/"]')?.getAttribute?.('href')
    )
    const title = firstString(
      data?.jobName,
      data?.title,
      data?.positionName,
      data?.jobInfo?.jobName,
      data?.jobInfo?.title,
      queryText(el, '.job-name,.job-title,[class*="job-name"],[class*="title"]')
    )
    const company = firstString(
      data?.brandName,
      data?.companyName,
      data?.company,
      data?.jobInfo?.brandName,
      data?.companyInfo?.brandName,
      queryText(el, '.company-name,.boss-name,[class*="company"]')
    )
    const salaryText = firstString(
      data?.salaryDesc,
      data?.salary,
      data?.salaryText,
      data?.jobInfo?.salaryDesc,
      queryText(el, '.salary,.job-salary,[class*="salary"]')
    )
    const city = firstString(
      data?.cityName,
      data?.city,
      data?.jobInfo?.cityName,
      data?.locationName,
      queryText(el, '.job-area,.job-location,[class*="area"],[class*="location"]')
    )
    const experience = firstString(data?.jobExperience, data?.experience, data?.experienceName)
    const degree = firstString(data?.degreeName, data?.degree, data?.jobDegree)
    const positionCategory = firstString(data?.positionCategory, data?.positionCategoryName, data?.jobType)
    const recruiter = firstObject(data?.bossInfo, data?.recruiter, data?.boss)
    const companySummary = firstObject(data?.companyInfo, data?.brandInfo)
    const tags = uniqueStrings([
      ...toStringArray(data?.skills),
      ...toStringArray(data?.tags),
      ...toStringArray(data?.jobLabels),
      ...[...el.querySelectorAll?.('.tag-list span,.job-card-footer span,[class*="tag"]') ?? []].map(item => item.textContent),
    ])
    const contact = classifyContactState(text)
    return {
      sourceRank: rank,
      jobId,
      title,
      company,
      city,
      salaryText,
      experience,
      degree,
      positionCategory,
      tags,
      contactState: contact.state,
      contactEvidenceText: contact.evidenceText,
      recruiter: {
        name: firstString(data?.bossName, recruiter?.name, recruiter?.bossName, queryText(el, '.boss-name,[class*="boss"]')),
        title: firstString(data?.bossTitle, recruiter?.title, recruiter?.position),
        activeText: firstString(data?.activeTimeDesc, recruiter?.activeTimeDesc, queryText(el, '.boss-active,[class*="active"]')),
      },
      companySummary: {
        industry: firstString(data?.industry, companySummary?.industry, companySummary?.industryName),
        financingStage: firstString(data?.stageName, data?.financingStage, companySummary?.stageName, companySummary?.financingStage),
        size: firstString(data?.scaleName, data?.companySize, companySummary?.scaleName, companySummary?.companySize),
        tags: uniqueStrings([
          ...toStringArray(companySummary?.tags),
          ...toStringArray(data?.brandLabels),
        ]),
      },
      detailUrl,
      listText: text,
    }
  }

  function pickJobData (vue) {
    const candidates = [
      vue?.data,
      vue?.job,
      vue?.jobInfo,
      vue?.item,
      vue?.position,
      vue?.$props?.data,
      vue?.$props?.job,
      vue?.$props?.item,
      vue?._props?.data,
      vue?._props?.job,
      vue?._props?.item,
    ]
    return candidates.find(item => item && typeof item === 'object') ?? {}
  }

  function queryText (root, selector) {
    return root.querySelector?.(selector)?.textContent?.trim?.() ?? ''
  }

  function classifyContactState (text) {
    const evidence = []
    const applied = text.match(/已投递|投递成功|已申请/)
    if (applied) evidence.push({ state: 'applied_or_chatting', text: applied[0] })
    const contacted = text.match(/继续沟通|已沟通|沟通中|chat-entry|聊天入口|进入沟通/i)
    if (contacted) evidence.push({ state: 'contacted', text: contacted[0] })
    const uncontacted = text.match(/立即沟通/)
    if (uncontacted) evidence.push({ state: 'uncontacted', text: uncontacted[0] })
    const states = [...new Set(evidence.map(item => item.state))]
    if (states.length > 1) return { state: 'unknown', evidenceText: `conflicting: ${uniqueStrings(evidence.map(item => item.text)).join(' / ')}` }
    if (states.length === 1) return { state: states[0], evidenceText: evidence[0].text }
    return { state: 'unknown', evidenceText: '' }
  }

  function firstString (...values) {
    for (const value of values) {
      if (typeof value === 'string' && value.trim()) return value.trim()
      if (typeof value === 'number') return String(value)
    }
    return ''
  }

  function firstObject (...values) {
    return values.find(value => value && typeof value === 'object') ?? {}
  }

  function toStringArray (value) {
    if (!Array.isArray(value)) return []
    return value.map(item => typeof item === 'string' ? item : firstString(item?.name, item?.label, item?.text)).filter(Boolean)
  }

  function uniqueStrings (items) {
    const seen = new Set()
    const unique = []
    for (const item of items) {
      const key = String(item ?? '').trim()
      if (!key || seen.has(key)) continue
      seen.add(key)
      unique.push(key)
    }
    return unique
  }
}

function buildPlannedSamples ({ keywords, cities, requestedLimit }) {
  const samples = []
  const sampleKeyCounts = new Map()
  for (const keyword of keywords) {
    for (const city of cities) {
      const baseSampleKey = `${slugKeyword(keyword)}__${city.cityCode}`
      const seenCount = (sampleKeyCounts.get(baseSampleKey) ?? 0) + 1
      sampleKeyCounts.set(baseSampleKey, seenCount)
      samples.push({
        sampleKey: seenCount === 1 ? baseSampleKey : `${baseSampleKey}__${seenCount}`,
        keyword,
        cityInput: city.cityInput,
        cityCode: city.cityCode,
        requestedLimit,
        plannedRankStart: 1,
        plannedRankEnd: requestedLimit,
      })
    }
  }
  return samples
}

function normalizeLimit (value) {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return { ok: false, reasonCode: 'LIMIT_INVALID', error: '--limit must be a positive integer' }
  }
  if (parsed > maxLimit) {
    return { ok: false, reasonCode: 'LIMIT_EXCEEDS_MAX', error: `--limit must be less than or equal to ${maxLimit}` }
  }
  return { ok: true, limit: parsed }
}

function getMarketJobObservationRank (rawJob, fallbackRank) {
  const sourceRank = Number(rawJob?.sourceRank)
  return Number.isFinite(sourceRank) && sourceRank > 0 ? sourceRank : fallbackRank
}

async function openMarketJobsBrowser ({ headless = false, browserUrl = '', cdpPort = '' } = {}) {
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

async function openMarketJobsSearchPage (page, { keyword, cityCode, settleMs = 5000 }) {
  await page.goto(buildSearchPageUrl({ keyword, cityCode }), { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {})
  await page.waitForFunction?.(() => document.readyState === 'complete', { timeout: 60000 }).catch(() => {})
  if (settleMs > 0) await sleep(settleMs)
}

function buildSearchPageUrl ({ keyword = '', cityCode = '' } = {}) {
  const url = new URL(searchPageUrl)
  if (String(keyword).trim()) url.searchParams.set('query', String(keyword).trim())
  if (String(cityCode).trim()) url.searchParams.set('city', String(cityCode).trim())
  return url.toString()
}

async function scrollMarketJobsList (page, { settleMs = 1500 } = {}) {
  await page.evaluate(scrollMarketJobsListInPage).catch(() => {})
  if (settleMs > 0) await sleep(settleMs)
}

export function scrollMarketJobsListInPage () {
  const selectors = [
    'ul.rec-job-list li.job-card-box',
    'li.job-card-box',
    '.job-card-wrapper',
    '.job-list-box li',
  ]
  const cards = selectors.flatMap(selector => [...document.querySelectorAll(selector)])
  const lastCard = cards.at(-1)
  if (lastCard?.scrollIntoView) {
    lastCard.scrollIntoView({ behavior: 'smooth', block: 'end' })
    return { scrolled: true, method: 'last-card' }
  }
  window.scrollBy?.(0, Math.floor(window.innerHeight * 0.8))
  return { scrolled: true, method: 'window' }
}

export async function extractMarketJobDescriptionFromDetailPage (page, detailUrl, { settleMs = 1200 } = {}) {
  await page.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {})
  await page.waitForFunction?.(() => document.readyState === 'complete', { timeout: 60000 }).catch(() => {})
  if (settleMs > 0) await sleep(settleMs)

  const detail = await page.evaluate(readMarketJobDetailStateInPage)
  const resolvedUrl = sanitizeMarketJobsDetailUrl(detail?.url ?? page.url?.() ?? detailUrl)
  const riskReason = detectMarketJobDetailRisk(detail)
  if (riskReason) {
    return {
      status: 'blocked',
      reasonCode: riskReason,
      source: 'boss_job_detail_dom',
      resolvedUrl,
      pageTitle: detail?.pageTitle ?? '',
      evidenceText: firstString(detail?.evidenceText, riskReason),
    }
  }

  const jdText = String(detail?.jdText ?? '').trim()
  if (!jdText) {
    return {
      status: 'failed',
      reasonCode: 'JD_DOM_EXTRACTION_FAILED',
      source: 'boss_job_detail_dom',
      resolvedUrl,
      pageTitle: detail?.pageTitle ?? '',
      evidenceText: firstString(detail?.evidenceText),
    }
  }

  return {
    status: 'ok',
    source: 'boss_job_detail_dom',
    text: jdText,
    characterCount: Array.from(jdText).length,
    resolvedUrl,
    pageTitle: detail?.pageTitle ?? '',
    evidenceText: firstString(detail?.evidenceText),
  }
}

// Runs inside the BOSS detail page via page.evaluate. Keep it self-contained.
export function readMarketJobDetailStateInPage () {
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
  let evidenceText = ''
  for (const selector of selectors) {
    const el = document.querySelector(selector)
    const text = el?.innerText?.trim?.()
    if (text) {
      jdText = text
      evidenceText = selector
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
    evidenceText = heading?.textContent?.trim?.() ?? ''
  }
  return {
    url,
    pageTitle,
    visibleText,
    jdText,
    evidenceText,
    detailPageConfirmed: /\/job_detail\/[^/]+\.html/i.test(url),
  }
}

function createBaseArtifact ({ captureTime, keywords, cities, requestedLimit, includeJd }) {
  return {
    schemaVersion: artifactSchemaVersion,
    ok: false,
    command: commandName,
    captureMetadata: {
      capturedAt: captureTime,
      arguments: {
        keywords,
        cities,
        requestedLimitPerSample: requestedLimit,
        includeJd,
      },
      requestedLimitPerSample: requestedLimit,
      includeJd,
      readOnly: true,
      authorization: {
        issuesApplicationAuthorization: false,
        consumesApplicationAuthorizationToken: false,
      },
    },
    sourceStrategy: {
      list: 'boss_geek_search_results',
      jd: includeJd ? 'boss_job_detail_dom' : 'not_requested',
      browserActions: includeJd ? 'read_only_list_scroll_then_sequential_detail_navigation' : 'read_only_list_scroll',
    },
    samples: [],
    jobs: [],
    statusSummary: {
      sampleCount: 0,
      jobCount: 0,
      observationCount: 0,
      capturedObservationCount: 0,
      dedupedJobCount: 0,
      lowConfidenceJobCount: 0,
      stableIdentityJobCount: 0,
      missingIdentityJobCount: 0,
      validJobIdentityAnchorCount: 0,
      invalidJobIdentityAnchorCount: 0,
      reasonCodes: {},
      stopped: 0,
      partial: 0,
      blockingReasonCode: null,
      contactStates: {},
      identityConfidence: {},
    },
  }
}

function normalizeMarketJob (rawJob, { sampleKey, rank, sourceUrl = '', includeJd = false }) {
  const jobId = firstString(rawJob?.jobId, rawJob?.encryptJobId, rawJob?.encryptId)
  const title = firstString(rawJob?.title, rawJob?.jobName, rawJob?.positionName)
  const company = firstString(rawJob?.company, rawJob?.companyName, rawJob?.brandName)
  const city = firstString(rawJob?.city, rawJob?.cityName)
  const salaryText = firstString(rawJob?.salaryText, rawJob?.salary, rawJob?.salaryDesc)
  const fingerprint = buildMissingJobFingerprint({
    title,
    company,
    salaryText,
    city,
    sampleKey,
    rank,
  })
  const jobIdentity = jobId
    ? { status: 'stable', jobId, key: `job:${jobId}`, confidence: 'high', validJobIdentityAnchor: true }
    : {
        status: 'missing',
        jobId: '',
        fingerprint,
        temporaryFingerprint: fingerprint,
        key: `missing:${fingerprint}`,
        confidence: 'low',
        validJobIdentityAnchor: false,
      }
  const contact = classifyMarketJobContactState({
    state: rawJob?.contactState,
    evidenceText: firstString(rawJob?.contactEvidenceText, rawJob?.contactStateEvidence?.text),
    listText: rawJob?.listText,
  })
  const contactStateEvidence = {
    text: contact.evidenceText,
    source: contact.evidenceText ? 'visible_page_text' : 'missing_visible_page_text',
  }
  return {
    jobIdentity,
    jobId,
    title,
    company,
    city,
    salaryText,
    experience: firstString(rawJob?.experience),
    degree: firstString(rawJob?.degree),
    positionCategory: firstString(rawJob?.positionCategory),
    tags: uniqueStrings(rawJob?.tags ?? []),
    contactState: contact.state,
    contactEvidenceText: contact.evidenceText,
    contactStateEvidence,
    recruiter: {
      name: firstString(rawJob?.recruiter?.name),
      title: firstString(rawJob?.recruiter?.title),
      activeText: firstString(rawJob?.recruiter?.activeText),
    },
    companySummary: {
      industry: firstString(rawJob?.companySummary?.industry),
      financingStage: firstString(rawJob?.companySummary?.financingStage),
      size: firstString(rawJob?.companySummary?.size),
      tags: uniqueStrings(rawJob?.companySummary?.tags ?? []),
    },
    detailUrlEvidence: buildMarketJobDetailUrlEvidence(rawJob, jobId),
    jd: includeJd
      ? { status: 'pending' }
      : { status: 'skipped', reasonCode: 'JD_NOT_REQUESTED' },
    observations: [
      {
        sampleKey,
        rank,
        sourceRank: Number.isFinite(Number(rawJob?.sourceRank)) ? Number(rawJob.sourceRank) : rank,
        contactState: contact.state,
        contactEvidenceText: contact.evidenceText,
        contactStateEvidence,
        listText: firstString(rawJob?.listText),
        source: {
          type: 'boss_geek_search_results',
          url: sanitizeMarketJobsSourceUrl(firstString(rawJob?.sourceUrl, sourceUrl)),
        },
      },
    ],
  }
}

function upsertMarketJob (artifact, jobByIdentityKey, normalizedJob) {
  const existingIndex = jobByIdentityKey.has(normalizedJob.jobIdentity.key)
    ? jobByIdentityKey.get(normalizedJob.jobIdentity.key)
    : artifact.jobs.findIndex(job => job.jobIdentity?.key === normalizedJob.jobIdentity.key)
  if (existingIndex >= 0) {
    if (!artifact.jobs[existingIndex].detailUrlEvidence?.url && normalizedJob.detailUrlEvidence?.url) {
      artifact.jobs[existingIndex].detailUrlEvidence = normalizedJob.detailUrlEvidence
    }
    artifact.jobs[existingIndex].observations.push(...normalizedJob.observations)
    return
  }
  jobByIdentityKey.set(normalizedJob.jobIdentity.key, artifact.jobs.length)
  artifact.jobs.push(normalizedJob)
}

function countJobsObservedInSample (jobs, sampleKey) {
  return jobs.filter(job => job.observations?.some(observation => observation.sampleKey === sampleKey)).length
}

function summarizeMarketArtifact (artifact) {
  const summary = {
    sampleCount: artifact.samples.length,
    jobCount: artifact.jobs.length,
    observationCount: 0,
    capturedObservationCount: 0,
    dedupedJobCount: artifact.jobs.length,
    lowConfidenceJobCount: 0,
    stableIdentityJobCount: 0,
    missingIdentityJobCount: 0,
    validJobIdentityAnchorCount: 0,
    invalidJobIdentityAnchorCount: 0,
    ok: 0,
    failed: 0,
    blocked: 0,
    pending: 0,
    stopped: 0,
    partial: 0,
    blockingReasonCode: null,
    reasonCodes: {},
    contactStates: {},
    identityConfidence: {},
    jd: {
      ok: 0,
      failed: 0,
      blocked: 0,
      skipped: 0,
      pending: 0,
    },
  }
  for (const sample of artifact.samples) {
    const status = sample.status || 'pending'
    summary[status] = (summary[status] ?? 0) + 1
    summary.capturedObservationCount += Number.isFinite(Number(sample.capturedCount)) ? Number(sample.capturedCount) : 0
    if (sample.reasonCode) summary.reasonCodes[sample.reasonCode] = (summary.reasonCodes[sample.reasonCode] ?? 0) + 1
    if (['blocked', 'failed'].includes(status)) {
      summary.stopped += 1
      summary.partial += 1
      if (!summary.blockingReasonCode && sample.reasonCode) summary.blockingReasonCode = sample.reasonCode
    }
  }
  for (const job of artifact.jobs) {
    summary.observationCount += Array.isArray(job.observations) ? job.observations.length : 0
    const contactState = job.contactState || 'unknown'
    summary.contactStates[contactState] = (summary.contactStates[contactState] ?? 0) + 1
    const confidence = job.jobIdentity?.confidence || 'unknown'
    summary.identityConfidence[confidence] = (summary.identityConfidence[confidence] ?? 0) + 1
    if (confidence === 'low') summary.lowConfidenceJobCount += 1
    if (job.jobIdentity?.status === 'stable') summary.stableIdentityJobCount += 1
    if (job.jobIdentity?.status === 'missing') summary.missingIdentityJobCount += 1
    if (job.jobIdentity?.validJobIdentityAnchor === true) summary.validJobIdentityAnchorCount += 1
    if (job.jobIdentity?.validJobIdentityAnchor === false) summary.invalidJobIdentityAnchorCount += 1
    const jdStatus = job.jd?.status || 'pending'
    summary.jd[jdStatus] = (summary.jd[jdStatus] ?? 0) + 1
    if (job.jd?.reasonCode) summary.reasonCodes[job.jd.reasonCode] = (summary.reasonCodes[job.jd.reasonCode] ?? 0) + 1
    if (jdStatus === 'blocked') {
      summary.stopped += 1
      summary.partial += 1
      if (!summary.blockingReasonCode && job.jd?.reasonCode) summary.blockingReasonCode = job.jd.reasonCode
    }
  }
  if (artifact.reasonCode && !summary.blockingReasonCode) summary.blockingReasonCode = artifact.reasonCode
  return summary
}

function buildCommandSummary ({ artifact, rawArtifactPath, analysisArtifactPath }) {
  return {
    ok: Boolean(artifact.ok),
    command: commandName,
    sampleCount: artifact.samples.length,
    jobCount: artifact.jobs.length,
    statusSummary: artifact.statusSummary,
    rawArtifactPath,
    analysisArtifactPath,
    reasonCode: artifact.reasonCode,
  }
}

async function writeArtifact (outputPath, artifact) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8')
}

function resolveMarketJobsOutputPath (outputPath, captureTime) {
  if (outputPath) return path.resolve(outputPath)
  return path.join(storageFilePath, 'market-jobs', `market-jobs-${fileTimestamp(captureTime)}.json`)
}

function resolveAnalysisOutputPath (analysisOutputPath, rawArtifactPath) {
  if (analysisOutputPath) return path.resolve(analysisOutputPath)
  return rawArtifactPath.replace(/\.json$/i, '.analysis.json')
}

function normalizeList (value) {
  const items = Array.isArray(value) ? value : value == null ? [] : [value]
  return items
    .map(item => String(item ?? '').trim())
    .filter(Boolean)
}

function normalizeResolvedCities (value) {
  return (Array.isArray(value) ? value : [])
    .map(item => {
      if (item && typeof item === 'object') {
        return {
          cityInput: firstString(item.cityInput, item.city),
          cityCode: firstString(item.cityCode, item.code),
        }
      }
      const cityInput = String(item ?? '').trim()
      return { cityInput, cityCode: resolveCityCode(cityInput) }
    })
    .filter(item => item.cityInput && item.cityCode)
}

function slugKeyword (value) {
  const slug = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'keyword'
}

function failure (reasonCode, error) {
  return {
    ok: false,
    command: commandName,
    reasonCode,
    error,
  }
}

function isCommandStoppingReason (reasonCode) {
  return commandStoppingReasonCodes.has(reasonCode)
}

async function enrichMarketJobsWithJd (page, artifact, { detailUrlByIdentityKey, outputPath, settleMs }) {
  for (const job of artifact.jobs) {
    const detailUrl = detailUrlByIdentityKey.get(job.jobIdentity?.key) || buildMarketJobDetailUrlFromJob(job)
    if (!detailUrl) {
      job.jd = {
        status: 'failed',
        reasonCode: 'MISSING_JOB_DETAIL_URL',
      }
      artifact.statusSummary = summarizeMarketArtifact(artifact)
      await writeArtifact(outputPath, artifact)
      continue
    }

    const jd = await extractMarketJobDescriptionFromDetailPage(page, detailUrl, { settleMs })
    job.jd = jd
    if (!job.detailUrlEvidence?.url && jd.resolvedUrl) {
      job.detailUrlEvidence = {
        url: jd.resolvedUrl,
        source: 'derived_from_job_identity',
      }
    }

    if (jd.status === 'blocked') {
      artifact.ok = false
      artifact.reasonCode = jd.reasonCode
      artifact.statusSummary = summarizeMarketArtifact(artifact)
      await writeArtifact(outputPath, artifact)
      return { ok: false, reasonCode: jd.reasonCode }
    }

    artifact.statusSummary = summarizeMarketArtifact(artifact)
    await writeArtifact(outputPath, artifact)
  }

  return { ok: true }
}

function resolveMarketJobRuntimeDetailUrl (rawJob, normalizedJob) {
  const rawDetailUrl = firstString(rawJob?.detailUrl, rawJob?.jobUrl, rawJob?.url)
  if (rawDetailUrl) return absolutizeBossUrl(rawDetailUrl)
  return buildMarketJobDetailUrlFromJob(normalizedJob)
}

function buildMarketJobDetailUrlFromJob (job) {
  const jobId = firstString(job?.jobId, job?.jobIdentity?.jobId)
  if (!jobId) return ''
  return `https://www.zhipin.com/job_detail/${encodeURIComponent(jobId)}.html`
}

function buildMarketJobDetailUrlEvidence (rawJob, jobId) {
  const rawDetailUrl = firstString(rawJob?.detailUrl, rawJob?.jobUrl, rawJob?.url)
  const url = rawDetailUrl
    ? sanitizeMarketJobsDetailUrl(absolutizeBossUrl(rawDetailUrl))
    : jobId
      ? sanitizeMarketJobsDetailUrl(buildMarketJobDetailUrlFromJob({ jobId }))
      : ''
  return {
    url,
    source: rawDetailUrl ? 'visible_job_card_link' : jobId ? 'derived_from_job_identity' : 'missing',
  }
}

function absolutizeBossUrl (value) {
  const raw = firstString(value)
  if (!raw) return ''
  try {
    return new URL(raw, 'https://www.zhipin.com').toString()
  } catch {
    return ''
  }
}

function detectMarketJobDetailRisk (detail) {
  const haystack = `${detail?.url ?? ''}\n${detail?.visibleText ?? ''}`
  if (/登录\/注册|请登录|扫码登录|验证码登录|登录后继续/.test(haystack)) return 'BOSS_LOGIN_REQUIRED'
  if (/安全验证|验证后继续|拖动滑块|verify|security-check/i.test(haystack)) return 'BOSS_SAFETY_VERIFICATION_REQUIRED'
  if (/环境异常|abnormal/i.test(haystack)) return 'BOSS_ABNORMAL_ENVIRONMENT'
  if (detail?.detailPageConfirmed === false) return 'BOSS_JOB_DETAIL_UNCONFIRMED'
  return ''
}

function buildMissingJobFingerprint ({ title, company, salaryText, city, sampleKey, rank }) {
  return [title, company, salaryText, city, sampleKey, rank]
    .map(item => String(item ?? '').trim())
    .join('|')
}

function classifyMarketJobContactState ({ state = '', evidenceText = '', listText = '' } = {}) {
  const visibleEvidence = extractVisibleContactStateEvidence(listText)
  if (visibleEvidence.hasEvidence) return visibleEvidence

  const explicitState = String(state ?? '').trim()
  if (['uncontacted', 'contacted', 'applied_or_chatting', 'unknown'].includes(explicitState)) {
    return {
      state: explicitState,
      evidenceText: firstString(evidenceText),
      hasEvidence: Boolean(firstString(evidenceText)),
    }
  }

  return { state: 'unknown', evidenceText: '', hasEvidence: false }
}

function extractVisibleContactStateEvidence (listText = '') {
  const text = String(listText ?? '')
  const evidence = []
  const applied = text.match(/已投递|投递成功|已申请/)
  if (applied) evidence.push({ state: 'applied_or_chatting', text: applied[0] })
  const contacted = text.match(/继续沟通|已沟通|沟通中|chat-entry|聊天入口|进入沟通/i)
  if (contacted) evidence.push({ state: 'contacted', text: contacted[0] })
  const uncontacted = text.match(/立即沟通/)
  if (uncontacted) evidence.push({ state: 'uncontacted', text: uncontacted[0] })

  const states = [...new Set(evidence.map(item => item.state))]
  if (states.length > 1) {
    return {
      state: 'unknown',
      evidenceText: `conflicting: ${uniqueStrings(evidence.map(item => item.text)).join(' / ')}`,
      hasEvidence: true,
    }
  }
  if (states.length === 1) {
    return {
      state: states[0],
      evidenceText: evidence[0].text,
      hasEvidence: true,
    }
  }

  return { state: 'unknown', evidenceText: '', hasEvidence: false }
}

function sanitizeMarketJobsSourceUrl (value) {
  const raw = firstString(value)
  if (!raw) return ''
  try {
    const url = new URL(raw)
    const sanitized = new URL(`${url.origin}${url.pathname}`)
    for (const key of ['query', 'city']) {
      const paramValue = url.searchParams.get(key)
      if (paramValue) sanitized.searchParams.set(key, paramValue)
    }
    return sanitized.toString()
  } catch {
    return ''
  }
}

function sanitizeMarketJobsDetailUrl (value) {
  const raw = firstString(value)
  if (!raw) return ''
  try {
    const url = new URL(raw, 'https://www.zhipin.com')
    const sanitized = new URL(`${url.origin}${url.pathname}`)
    if (url.searchParams.has('securityId')) sanitized.searchParams.set('securityId', '[REDACTED]')
    return sanitized.toString()
  } catch {
    return raw.replace(/([?&]securityId=)[^&#]+/i, '$1[REDACTED]')
  }
}

function uniqueStrings (items) {
  const seen = new Set()
  const unique = []
  for (const item of Array.isArray(items) ? items : []) {
    const key = String(item ?? '').trim()
    if (!key || seen.has(key)) continue
    seen.add(key)
    unique.push(key)
  }
  return unique
}

function firstString (...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number') return String(value)
  }
  return ''
}

function toIso (value) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function fileTimestamp (iso) {
  return String(iso).replace(/[:.]/g, '-')
}
