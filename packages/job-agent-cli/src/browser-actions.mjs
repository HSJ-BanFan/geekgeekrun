import fs from 'node:fs'
import puppeteerExtra from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import LaodengPlugin from '@geekgeekrun/puppeteer-extra-plugin-laodeng'
import AnonymizeUaPlugin from 'puppeteer-extra-plugin-anonymize-ua'
import { getBrowserPath, readBrowserState } from './config.mjs'
import { normalizeJobProfile } from './job-profile.mjs'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
let pluginsRegistered = false
const jobsPageUrl = 'https://www.zhipin.com/web/geek/jobs'
const chatPageUrl = 'https://www.zhipin.com/web/geek/chat'
const startChatButtonSelector = '.job-detail-box .op-btn.op-btn-chat'
const jobItemSelector = 'ul.rec-job-list li.job-card-box'
const chatPageInputSelector = '.chat-conversation .message-controls .chat-input'
const chatPageSendButtonSelector = '.chat-conversation .message-controls .chat-op .btn-send:not(.disabled)'
const greetDialogSelector = '.greet-boss-dialog'
const greetDialogInputSelector = 'textarea, input[type="text"], [contenteditable="true"], .chat-input'
const greetDialogSendButtonSelector = '.greet-boss-footer .sure-btn, .greet-boss-footer .confirm-btn, .greet-boss-footer .btn-sure, .greet-boss-footer .btn-primary, .greet-boss-footer button:not(.cancel-btn)'

export async function extractCurrentJobFromBrowser ({ headless = false, query = '', city = '' } = {}) {
  const { browser, page } = await openBrowser({ headless })
  try {
    await openJobsPage(page, { query, city })
    return await extractCurrentJobOnPage(page)
  } finally {
    await browser.close().catch(() => {})
  }
}

export async function startChatOnCurrentJob ({ confirm = false, headless = false, expectedJob = null, query = '', city = '' } = {}) {
  const { browser, page } = await openBrowser({ headless })
  try {
    await openJobsPage(page, { query, city })
    const extraction = await extractCurrentJobOnPage(page)
    return await startChatOnCurrentPage(page, { confirm, expectedJob, currentProfile: extraction.profile })
  } finally {
    await browser.close().catch(() => {})
  }
}

export async function moveToNextJob ({ confirm = false, headless = false, query = '', city = '' } = {}) {
  const { browser, page } = await openBrowser({ headless })
  try {
    await openJobsPage(page, { query, city })
    return await moveToNextJobOnCurrentPage(page, { confirm })
  } finally {
    await browser.close().catch(() => {})
  }
}

export async function runCurrentJobBrowserActions ({
  shouldApply,
  message,
  imagePath,
  confirm = false,
  headless = false,
  expectedJob = null,
  moveNext = true,
  beforeMoveNext = null,
  query = '',
  city = '',
} = {}) {
  const { browser, page } = await openBrowser({ headless })
  try {
    await openJobsPage(page, { query, city })
    const extraction = await extractCurrentJobOnPage(page)
    const jobMatch = compareExpectedJob(extraction.profile, expectedJob)
    const actions = []

    if (!jobMatch.match) {
      const mismatchResult = {
        dryRun: !confirm,
        skipped: true,
        reason: 'JOB_MISMATCH',
        jobMatch,
        currentJob: extraction.profile,
      }
      if (shouldApply) {
        actions.push({ type: 'start_chat', result: mismatchResult })
        actions.push({ type: 'send_greeting', result: { skipped: true, reason: 'start chat skipped due to job mismatch' } })
      } else {
        actions.push({ type: 'skip_apply', result: mismatchResult })
      }
      if (moveNext) {
        actions.push({ type: 'next_job', result: { skipped: true, reason: 'next job skipped due to job mismatch', jobMatch } })
      }
      if (beforeMoveNext) {
        const result = await beforeMoveNext({ actions, profile: extraction.profile, jobMatch })
        actions.splice(actions.length - (moveNext ? 1 : 0), 0, { type: 'audit_log', result })
      }
      return { dryRun: !confirm, profile: extraction.profile, jobMatch, actions }
    }

    if (shouldApply) {
      const startChatResult = await startChatOnCurrentPage(page, {
        confirm,
        expectedJob,
        currentProfile: extraction.profile,
      })
      const sendResult = !confirm
        ? { dryRun: true, wouldSendMessage: Boolean(message), wouldUploadImage: Boolean(imagePath) }
        : startChatResult.success
          ? await sendGreetingToCurrentSurfaceOrRecentChat(page, { message, imagePath })
          : { skipped: true, reason: 'start chat did not succeed' }
      actions.push({ type: 'start_chat', result: startChatResult })
      actions.push({ type: 'send_greeting', result: sendResult })
    } else {
      actions.push({ type: 'skip_apply', dryRun: !confirm, reason: 'final decision is not apply' })
    }

    if (beforeMoveNext) {
      const result = await beforeMoveNext({ actions, profile: extraction.profile, jobMatch })
      actions.push({ type: 'audit_log', result })
    }

    if (moveNext) {
      await returnToJobsPage(page, { query, city })
      const result = await moveToNextJobOnCurrentPage(page, { confirm })
      actions.push({ type: 'next_job', result })
    }

    return { dryRun: !confirm, profile: extraction.profile, jobMatch, actions }
  } finally {
    await browser.close().catch(() => {})
  }
}

export async function sendGreetingToMostRecentChat ({ message, imagePath, confirm = false, headless = false } = {}) {
  if (!confirm) {
    return { dryRun: true, wouldSendMessage: Boolean(message), wouldUploadImage: Boolean(imagePath) }
  }
  const { browser, page } = await openBrowser({ headless })
  try {
    await openChatPage(page)
    const clicked = await clickMostRecentConversation(page)
    if (!clicked) return { clicked: false, textSent: false, imageUploaded: false }
    const result = await sendGreetingOnCurrentSurface(page, { message, imagePath })
    return { clicked, ...result }
  } finally {
    await browser.close().catch(() => {})
  }
}

async function openJobsPage (page, { query = '', city = '' } = {}) {
  await page.goto(buildJobsPageUrl({ query, city }), { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {})
  await page.waitForFunction(() => document.readyState === 'complete', { timeout: 60000 }).catch(() => {})
  await sleep(5000)
}

function buildJobsPageUrl ({ query = '', city = '' } = {}) {
  const url = new URL(jobsPageUrl)
  if (String(query).trim()) url.searchParams.set('query', String(query).trim())
  if (String(city).trim()) url.searchParams.set('city', String(city).trim())
  return url.toString()
}

async function extractCurrentJobOnPage (page) {
  const raw = await page.evaluate(() => {
    const jobsMain = document.querySelector('.page-jobs-main')
    const detailBox = document.querySelector('.job-detail-box')
    const selectedJobData = jobsMain?.__vue__?.currentJob ?? null
    const targetJobData = detailBox?.__vue__?.data ?? null
    return {
      url: location.href,
      pageQuery: jobsMain?.__vue__?.formData?.query ?? '',
      selectedJobData,
      targetJobData,
      visibleText: detailBox?.innerText ?? '',
    }
  })
  const profile = normalizeJobProfile({
    ...raw,
    ...(raw.targetJobData ?? {}),
    ...(raw.selectedJobData ?? {}),
    jd: raw.visibleText,
    sourceKeyword: raw.pageQuery,
  })
  return { profile, raw }
}

async function startChatOnCurrentPage (page, { confirm, expectedJob, currentProfile }) {
  const buttonState = await inspectStartChatButton(page)
  const jobMatch = compareExpectedJob(currentProfile, expectedJob)
  const canClick = buttonState.canStart && jobMatch.match
  if (!confirm) {
    return {
      dryRun: true,
      wouldClick: canClick,
      buttonState,
      jobMatch,
      currentJob: currentProfile,
      confirmationRequired: true,
    }
  }
  if (!jobMatch.match) {
    return {
      dryRun: false,
      clicked: false,
      success: false,
      reason: 'JOB_MISMATCH',
      buttonState,
      jobMatch,
      currentJob: currentProfile,
    }
  }
  if (!buttonState.canStart) {
    return {
      dryRun: false,
      clicked: false,
      success: false,
      reason: 'START_CHAT_UNAVAILABLE',
      buttonState,
      currentJob: currentProfile,
    }
  }
  return await clickStartChatButton(page, currentProfile)
}

async function inspectStartChatButton (page) {
  return await page.evaluate((selector) => {
    const button = document.querySelector(selector)
    const text = button?.textContent?.trim?.() ?? ''
    const rect = button?.getBoundingClientRect?.()
    const disabled = !button ||
      button.classList?.contains?.('disabled') ||
      button.hasAttribute?.('disabled') ||
      button.getAttribute?.('aria-disabled') === 'true'
    return {
      found: Boolean(button),
      text,
      disabled,
      canStart: Boolean(button) && text === '立即沟通' && !disabled,
      rect: rect
        ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
        : null,
    }
  }, startChatButtonSelector)
}

async function clickStartChatButton (page, currentProfile) {
  const button = await page.$(startChatButtonSelector)
  if (!button) {
    return { dryRun: false, clicked: false, success: false, reason: 'START_CHAT_BUTTON_NOT_FOUND' }
  }
  const responsePromise = waitForAddFriendJson(page, currentProfile?.jobId)
  await button.click()
  const responseResult = await responsePromise
  if (responseResult.error) {
    await sleep(2000)
    if (page.url().startsWith(chatPageUrl)) {
      await waitForGreetingSurface(page).catch(() => null)
      return {
        dryRun: false,
        clicked: true,
        success: true,
        reason: 'PAGE_JUMPED_TO_CHAT',
        currentUrl: page.url(),
      }
    }
    return {
      dryRun: false,
      clicked: true,
      success: false,
      reason: 'ADD_FRIEND_RESPONSE_TIMEOUT',
      error: responseResult.error,
      currentUrl: page.url(),
    }
  }
  return await handleAddFriendResponse(page, responseResult.payload, currentProfile?.jobId)
}

async function waitForAddFriendJson (page, jobId) {
  try {
    const response = await page.waitForResponse(
      item => {
        if (!item.url().startsWith('https://www.zhipin.com/wapi/zpgeek/friend/add.json')) return false
        if (!jobId) return true
        return item.url().includes(`jobId=${encodeURIComponent(jobId)}`) || item.url().includes(`jobId=${jobId}`)
      },
      { timeout: 25000 }
    )
    const payload = await response.json()
    return { payload }
  } catch (err) {
    return { error: err?.message ?? String(err) }
  }
}

async function handleAddFriendResponse (page, payload, jobId, depth = 0) {
  if (payload?.code === 0) {
    await waitForGreetingSurface(page).catch(() => null)
    return {
      dryRun: false,
      clicked: true,
      success: true,
      response: summarizeAddFriendResponse(payload),
      currentUrl: page.url(),
    }
  }

  const dialog = payload?.zpData?.bizData?.chatRemindDialog
  const content = String(dialog?.content ?? '')
  const canContinue = payload?.zpData?.bizCode === 1 &&
    dialog?.blockLevel === 0 &&
    (/剩\d+次沟通机会/.test(content) || /猎头/.test(content))

  if (canContinue && depth < 2) {
    const clicked = await clickChatBlockContinue(page)
    if (!clicked) {
      return {
        dryRun: false,
        clicked: true,
        success: false,
        reason: 'CONTINUE_DIALOG_BUTTON_NOT_FOUND',
        response: summarizeAddFriendResponse(payload),
      }
    }
    const nextResponse = await waitForAddFriendJson(page, jobId)
    if (nextResponse.error) {
      return {
        dryRun: false,
        clicked: true,
        success: false,
        reason: 'ADD_FRIEND_RESPONSE_TIMEOUT_AFTER_CONTINUE',
        error: nextResponse.error,
      }
    }
    return await handleAddFriendResponse(page, nextResponse.payload, jobId, depth + 1)
  }

  if (/今日沟通人数已达上限|明天再来/.test(content)) {
    return {
      dryRun: false,
      clicked: true,
      success: false,
      reason: 'DAILY_LIMIT_REACHED',
      response: summarizeAddFriendResponse(payload),
    }
  }

  return {
    dryRun: false,
    clicked: true,
    success: false,
    reason: 'START_CHAT_REJECTED',
    response: summarizeAddFriendResponse(payload),
  }
}

async function clickChatBlockContinue (page) {
  const selector = '.chat-block-dialog .chat-block-footer .sure-btn'
  const button = await page.waitForSelector(selector, { timeout: 10000 }).catch(() => null)
  if (button) {
    await button.click()
    await sleep(500)
    return true
  }
  return await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('.chat-block-dialog button, .chat-block-dialog .sure-btn')]
    const target = buttons.find(item => /继续|确定|知道了/.test(item.textContent?.trim?.() ?? ''))
    if (!target) return false
    target.click()
    return true
  }).catch(() => false)
}

function summarizeAddFriendResponse (payload) {
  const dialog = payload?.zpData?.bizData?.chatRemindDialog
  return {
    code: payload?.code,
    bizCode: payload?.zpData?.bizCode,
    blockLevel: dialog?.blockLevel,
    content: dialog?.content,
  }
}

async function sendGreetingToCurrentSurfaceOrRecentChat (page, { message, imagePath }) {
  const currentSurfaceResult = await sendGreetingOnCurrentSurface(page, { message, imagePath })
  if (currentSurfaceResult.textSent || currentSurfaceResult.imageUploaded) {
    return { ...currentSurfaceResult, fallbackUsed: false }
  }
  await openChatPage(page)
  const clicked = await clickMostRecentConversation(page)
  if (!clicked) {
    return { ...currentSurfaceResult, fallbackUsed: true, clickedRecentConversation: false }
  }
  const fallbackResult = await sendGreetingOnCurrentSurface(page, { message, imagePath })
  return { clickedRecentConversation: true, ...fallbackResult, fallbackUsed: true }
}

async function openBrowser ({ headless = false } = {}) {
  const browserPath = getBrowserPath()
  if (!browserPath || !fs.existsSync(browserPath)) {
    throw new Error(`NO_BROWSER:${browserPath}`)
  }
  registerPlugins()
  const browser = await puppeteerExtra.launch({
    executablePath: browserPath,
    headless,
    ignoreHTTPSErrors: true,
    protocolTimeout: 120000,
    defaultViewport: { width: 1440, height: 760 },
    args: ['--no-first-run', '--no-default-browser-check'],
  })
  const page = (await browser.pages())[0] ?? await browser.newPage()
  const { cookies, localStorage } = readBrowserState()
  if (Array.isArray(cookies) && cookies.length) {
    await page.setCookie(...cookies.map(cookie => {
      const copy = { ...cookie }
      if (copy.sameSite === 'unspecified') delete copy.sameSite
      return copy
    }))
  }
  await page.goto('https://www.zhipin.com/desktop/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {})
  await page.evaluate(data => {
    for (const [key, value] of Object.entries(data || {})) {
      window.localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value))
    }
  }, localStorage).catch(() => {})
  return { browser, page }
}

function registerPlugins () {
  if (pluginsRegistered) return
  puppeteerExtra.use(StealthPlugin())
  puppeteerExtra.use(LaodengPlugin())
  puppeteerExtra.use(AnonymizeUaPlugin({ makeWindows: false }))
  pluginsRegistered = true
}

async function openChatPage (page) {
  await page.goto(chatPageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForFunction(() => document.readyState === 'complete', { timeout: 60000 }).catch(() => {})
  await sleep(5000)
}

async function returnToJobsPage (page, { query = '', city = '' } = {}) {
  if (page.url().startsWith(jobsPageUrl)) return
  if (page.url().startsWith(chatPageUrl)) {
    await page.goBack({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null)
    await page.waitForFunction(
      url => location.href.startsWith(url) && document.readyState === 'complete',
      { timeout: 20000 },
      jobsPageUrl
    ).catch(() => null)
    if (page.url().startsWith(jobsPageUrl)) {
      await sleep(2500)
      return
    }
  }
  await openJobsPage(page, { query, city })
}

async function clickMostRecentConversation (page) {
  const item = await page.$('.user-list-content li, .user-list .user-list-content li')
  if (!item) return false
  await item.click()
  await sleep(3000)
  return true
}

async function sendGreetingOnCurrentSurface (page, { message, imagePath }) {
  const textResult = message
    ? await sendTextOnCurrentSurface(page, message)
    : { sent: false, reason: 'NO_MESSAGE' }
  const imageResult = imagePath
    ? await sendImageOnCurrentSurface(page, imagePath)
    : { uploaded: false, reason: 'NO_IMAGE' }
  return {
    textSent: textResult.sent,
    imageUploaded: imageResult.uploaded,
    textResult,
    imageResult,
  }
}

async function sendTextOnCurrentSurface (page, message) {
  const chatInput = await page.$(chatPageInputSelector)
  if (chatInput) {
    const sent = await sendTextInChatPage(page, chatInput, message)
    return { sent, surface: 'chat_page', reason: sent ? undefined : 'CHAT_SEND_BUTTON_NOT_FOUND' }
  }

  const dialog = await page.$(greetDialogSelector)
  if (dialog) {
    const input = await dialog.$(greetDialogInputSelector)
    if (!input) return { sent: false, surface: 'greet_dialog', reason: 'DIALOG_INPUT_NOT_FOUND' }
    await typeText(input, message)
    await sleep(500)
    const sendButton = await dialog.$(greetDialogSendButtonSelector)
    if (!sendButton) return { sent: false, surface: 'greet_dialog', reason: 'DIALOG_SEND_BUTTON_NOT_FOUND' }
    await sendButton.click()
    await sleep(1600)
    return { sent: true, surface: 'greet_dialog' }
  }

  return { sent: false, reason: 'NO_GREETING_INPUT' }
}

async function typeText (input, message) {
  await input.click()
  await sleep(200)
  await input.evaluate(el => {
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      el.value = ''
      el.dispatchEvent(new Event('input', { bubbles: true }))
      return
    }
    if (el instanceof HTMLElement) {
      el.innerText = ''
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }))
    }
  })
  await input.type(message, { delay: 8 })
}

async function sendTextInChatPage (page, input, message) {
  await typeText(input, message)
  await sleep(500)
  const button = await page.$(chatPageSendButtonSelector)
  if (!button) return false
  await button.click()
  await sleep(1600)
  return true
}

async function sendImageOnCurrentSurface (page, imagePath) {
  if (!fs.existsSync(imagePath)) return { uploaded: false, reason: 'IMAGE_NOT_FOUND' }
  const chatInput = await findImageUploadInput(page, '.chat-conversation')
  if (chatInput) {
    const uploaded = await uploadImageAndMaybeSend(page, chatInput, chatPageSendButtonSelector, imagePath)
    return { uploaded, surface: 'chat_page' }
  }

  const dialog = await page.$(greetDialogSelector)
  if (dialog) {
    const input = await findImageUploadInput(page, greetDialogSelector)
    if (!input) return { uploaded: false, surface: 'greet_dialog', reason: 'DIALOG_IMAGE_INPUT_NOT_FOUND' }
    await input.uploadFile(imagePath)
    await sleep(2400)
    const button = await dialog.$(greetDialogSendButtonSelector)
    if (button) await button.click().catch(() => {})
    await sleep(1600)
    return { uploaded: true, surface: 'greet_dialog' }
  }

  return { uploaded: false, reason: 'NO_IMAGE_INPUT' }
}

async function findImageUploadInput (page, scopeSelector) {
  const inputs = await page.$$(`${scopeSelector} input[type="file"]`)
  for (const input of inputs) {
    const ok = await input.evaluate(el => {
      const accept = (el.getAttribute('accept') || '').toLowerCase()
      return !accept || accept.includes('image') || accept.includes('png') || accept.includes('jpg') || accept.includes('jpeg') || accept.includes('*')
    }).catch(() => false)
    if (!ok) continue
    return input
  }
  return null
}

async function uploadImageAndMaybeSend (page, input, sendButtonSelector, imagePath) {
  await input.uploadFile(imagePath)
  await sleep(2400)
  const button = await page.$(sendButtonSelector).catch(() => null)
  if (button) await button.click().catch(() => {})
  await sleep(1600)
  return true
}

async function waitForGreetingSurface (page, timeout = 12000) {
  const selector = [
    chatPageInputSelector,
    `${greetDialogSelector} textarea`,
    `${greetDialogSelector} input[type="text"]`,
    `${greetDialogSelector} [contenteditable="true"]`,
    `${greetDialogSelector} .chat-input`,
    `${greetDialogSelector} input[type="file"]`,
    '.chat-conversation input[type="file"]',
  ].join(', ')
  return await page.waitForSelector(selector, { timeout })
}

async function moveToNextJobOnCurrentPage (page, { confirm }) {
  const before = await ensureNextJobAvailableOnPage(page)
  if (!confirm) {
    return {
      dryRun: true,
      wouldMove: before.nextIndex != null,
      fromIndex: before.currentIndex,
      toIndex: before.nextIndex,
      currentJob: before.currentJob,
      nextJob: before.nextJob,
      reason: before.nextIndex == null ? before.reason : undefined,
    }
  }
  if (before.nextIndex == null) {
    return {
      dryRun: false,
      moved: false,
      fromIndex: before.currentIndex,
      reason: before.reason ?? 'NO_NEXT_JOB',
    }
  }
  const clickResult = await clickJobListItem(page, before.nextIndex)
  return {
    dryRun: false,
    moved: clickResult.moved,
    fromIndex: before.currentIndex,
    toIndex: before.nextIndex,
    previousJob: before.currentJob,
    nextJob: before.nextJob,
    currentJob: clickResult.profile,
    reason: clickResult.reason,
  }
}

async function ensureNextJobAvailableOnPage (page) {
  let info = await inspectJobListOnPage(page)
  if (info.nextIndex != null || info.currentIndex == null) return info
  await page.evaluate((selector) => {
    const items = [...document.querySelectorAll(selector)]
    items.at(-1)?.scrollIntoView?.({ behavior: 'smooth', block: 'end' })
  }, jobItemSelector).catch(() => {})
  await sleep(2500)
  info = await inspectJobListOnPage(page)
  return info
}

async function inspectJobListOnPage (page) {
  const raw = await page.evaluate((selector) => {
    const jobsMain = document.querySelector('.page-jobs-main')
    const currentJob = jobsMain?.__vue__?.currentJob ?? null
    const currentId = getJobId(currentJob)
    const currentTitle = getJobTitle(currentJob)
    const currentCompany = getCompany(currentJob)
    const items = [...document.querySelectorAll(selector)].map((el, index) => {
      const data = pickJobData(el.__vue__)
      return {
        index,
        className: el.className,
        text: el.innerText?.trim?.() ?? '',
        data,
      }
    })
    let currentIndex = currentId
      ? items.findIndex(item => getJobId(item.data) === currentId)
      : -1
    if (currentIndex < 0) {
      currentIndex = items.findIndex(item => /\b(active|selected|current|cur)\b/i.test(item.className))
    }
    if (currentIndex < 0 && currentTitle) {
      currentIndex = items.findIndex(item => {
        const text = item.text || ''
        return text.includes(currentTitle) && (!currentCompany || text.includes(currentCompany))
      })
    }
    return { currentJob, currentIndex, items }

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
      return candidates.find(item => item && typeof item === 'object' && (getJobId(item) || getJobTitle(item))) ?? null
    }

    function getJobId (item) {
      return String(item?.encryptId ?? item?.jobId ?? item?.encryptJobId ?? '').trim()
    }

    function getJobTitle (item) {
      return String(item?.jobName ?? item?.title ?? item?.positionName ?? '').trim()
    }

    function getCompany (item) {
      return String(item?.brandName ?? item?.companyName ?? item?.company ?? '').trim()
    }
  }, jobItemSelector)

  const items = raw.items.map(item => ({
    index: item.index,
    className: item.className,
    profile: normalizeJobProfile({
      ...(item.data ?? {}),
      jd: item.text,
    }),
  }))
  const currentIndex = raw.currentIndex >= 0 ? raw.currentIndex : null
  const nextIndex = currentIndex != null && items[currentIndex + 1] ? currentIndex + 1 : null
  return {
    currentIndex,
    nextIndex,
    currentJob: normalizeJobProfile(raw.currentJob ?? items[currentIndex]?.profile ?? {}),
    nextJob: nextIndex != null ? items[nextIndex].profile : null,
    items,
    reason: currentIndex == null
      ? 'CURRENT_JOB_INDEX_NOT_FOUND'
      : nextIndex == null
        ? 'NO_NEXT_JOB_IN_RENDERED_LIST'
        : undefined,
  }
}

async function clickJobListItem (page, index) {
  const items = await page.$$(jobItemSelector)
  const item = items[index]
  if (!item) return { moved: false, reason: 'NEXT_JOB_ELEMENT_NOT_FOUND' }
  await item.evaluate(el => el.scrollIntoView({ behavior: 'smooth', block: 'center' })).catch(() => {})
  await sleep(300)
  const detailResponsePromise = page.waitForResponse(
    response => response.url().startsWith('https://www.zhipin.com/wapi/zpgeek/job/detail.json'),
    { timeout: 20000 }
  ).catch(() => null)
  await item.click()
  await detailResponsePromise
  await sleep(2200)
  const extraction = await extractCurrentJobOnPage(page)
  return { moved: true, profile: extraction.profile }
}

function compareExpectedJob (actual, expected) {
  if (!expected) return { match: true, comparedBy: 'none' }
  if (actual?.jobId && expected?.jobId) {
    return {
      match: actual.jobId === expected.jobId,
      comparedBy: 'jobId',
      expected: jobReference(expected),
      actual: jobReference(actual),
    }
  }
  const actualTitle = normalizeComparable(actual?.title)
  const expectedTitle = normalizeComparable(expected?.title)
  const actualCompany = normalizeComparable(actual?.company)
  const expectedCompany = normalizeComparable(expected?.company)
  if (actualTitle && expectedTitle) {
    const titleMatch = actualTitle === expectedTitle
    const companyMatch = !expectedCompany || !actualCompany || actualCompany === expectedCompany
    return {
      match: titleMatch && companyMatch,
      comparedBy: expectedCompany && actualCompany ? 'title+company' : 'title',
      expected: jobReference(expected),
      actual: jobReference(actual),
    }
  }
  return {
    match: false,
    comparedBy: 'insufficient-fields',
    expected: jobReference(expected),
    actual: jobReference(actual),
  }
}

function normalizeComparable (value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase()
}

function jobReference (job) {
  return {
    jobId: job?.jobId,
    title: job?.title,
    company: job?.company,
  }
}
