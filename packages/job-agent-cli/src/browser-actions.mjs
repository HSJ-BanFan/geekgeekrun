import fs from 'node:fs'
import puppeteerExtra from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import LaodengPlugin from '@geekgeekrun/puppeteer-extra-plugin-laodeng'
import AnonymizeUaPlugin from 'puppeteer-extra-plugin-anonymize-ua'
import { getBrowserPath, getJobAgentBrowserProfileDir, readBrowserState } from './config.mjs'
import { normalizeJobProfile } from './job-profile.mjs'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
let pluginsRegistered = false
const jobsPageUrl = 'https://www.zhipin.com/web/geek/jobs'
const chatPageUrl = 'https://www.zhipin.com/web/geek/chat'
const startChatButtonSelector = '.job-detail-box .op-btn.op-btn-chat'
const jobItemSelector = 'ul.rec-job-list li.job-card-box'
const chatConversationSelector = '.chat-conversation'
const chatRecordSelector = '.chat-conversation .chat-record'
const chatEditorSelector = '.chat-conversation .chat-im.chat-editor'
const chatPageInputSelector = '.chat-conversation .message-controls .chat-input'
const chatPageSendButtonSelector = '.chat-conversation .message-controls .chat-op .btn-send:not(.disabled)'
const chatJobDetailSelector = '#main .chat-conversation [ka="geek_chat_job_detail"] .right-content'
const selectedConversationSelector = [
  '.user-list-content li.active',
  '.user-list-content li.selected',
  '.user-list-content li.cur',
  '.user-list-content li[aria-selected="true"]',
  '.user-list .user-list-content li.active',
  '.user-list .user-list-content li.selected',
  '.user-container .geek-item.active',
  '.user-container .geek-item.selected',
  '.user-container .geek-item.cur',
].join(', ')
const greetDialogSelector = '.greet-boss-dialog'
const greetDialogInputSelector = 'textarea, input[type="text"], [contenteditable="true"], .chat-input'
const greetDialogSendButtonSelector = '.greet-boss-footer .sure-btn, .greet-boss-footer .confirm-btn, .greet-boss-footer .btn-sure, .greet-boss-footer .btn-primary, .greet-boss-footer button:not(.cancel-btn)'
const jobIdentityAnchorMissingReason = 'JOB_IDENTITY_ANCHOR_MISSING'
const jobRelocationNotFoundReason = 'JOB_RELOCATION_NOT_FOUND'
const jobRelocationDetailMismatchReason = 'JOB_RELOCATION_DETAIL_MISMATCH'
const jobRelocationDetailUnconfirmedReason = 'JOB_RELOCATION_DETAIL_UNCONFIRMED'
const jobRelocationFailureSendGreetingReason = 'start chat skipped due to job relocation failure'
const jobRelocationFailureNextJobReason = 'next job skipped due to job relocation failure'
const maxJobRelocationScrolls = 5
const usePersistentProfile = process.env.GGR_JOB_AGENT_EPHEMERAL_BROWSER !== '1'

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
  messageSkipReason = '',
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
    return await runCurrentJobBrowserActionsOnOpenPage(page, {
      shouldApply,
      message,
      messageSkipReason,
      imagePath,
      confirm,
      expectedJob,
      moveNext,
      beforeMoveNext,
      query,
      city,
    })
  } finally {
    await browser.close().catch(() => {})
  }
}

export async function runCurrentJobBrowserActionsOnOpenPage (page, {
  shouldApply,
  message,
  messageSkipReason = '',
  imagePath,
  confirm = false,
  expectedJob = null,
  moveNext = true,
  beforeMoveNext = null,
  query = '',
  city = '',
} = {}) {
  const extraction = await extractCurrentJobOnPage(page)
  const jobMatch = compareExpectedJob(extraction.profile, expectedJob)
  const actions = []
  const jobIdentityAnchor = getJobId(expectedJob)

  if (shouldApply && !confirm) {
    const startChatResult = {
      dryRun: true,
      wouldRelocateByJobId: Boolean(jobIdentityAnchor),
      jobIdentityAnchor: jobIdentityAnchor || null,
      confirmationRequired: true,
      reason: jobIdentityAnchor ? undefined : jobIdentityAnchorMissingReason,
      currentJob: extraction.profile,
      jobMatch,
    }
    const sendResult = buildDryRunGreetingSendResult({ message, messageSkipReason, imagePath })
    actions.push({ type: 'start_chat', result: startChatResult })
    actions.push({ type: 'send_greeting', result: sendResult })

    if (beforeMoveNext) {
      const result = await beforeMoveNext({ actions, profile: extraction.profile, jobMatch })
      actions.push({ type: 'audit_log', result })
    }

    if (moveNext) {
      await returnToJobsPage(page, { query, city })
      const result = await moveToNextJobOnCurrentPage(page, { confirm })
      actions.push({ type: 'next_job', result })
    }

    return { dryRun: true, profile: extraction.profile, jobMatch, actions }
  }

  if (shouldApply && confirm) {
    const jobRelocation = await relocateAuthorizedJobOnPage(page, {
      authorizedJob: expectedJob,
      currentProfile: extraction.profile,
    })
    if (!jobRelocation.match) {
      const failureProfile = jobRelocation.profile ?? extraction.profile
      pushRelocationFailureActions(actions, {
        ...jobRelocation,
        currentJob: extraction.profile,
        jobMatch,
        moveNext,
      })
      if (beforeMoveNext) {
        const result = await beforeMoveNext({ actions, profile: failureProfile, jobMatch })
        actions.splice(actions.length - (moveNext ? 1 : 0), 0, { type: 'audit_log', result })
      }
      return { dryRun: false, profile: failureProfile, jobMatch, actions }
    }

    const verifiedJobMatch = compareExpectedJob(jobRelocation.profile, expectedJob)
    const startChatResult = await startChatOnCurrentPage(page, {
      confirm,
      expectedJob,
      currentProfile: jobRelocation.profile,
    })
    startChatResult.jobRelocation = summarizeJobRelocation(jobRelocation)
    const sendResult = startChatResult.success
      ? await sendGreetingToCurrentSurfaceOrRecentChat(page, { message, messageSkipReason, imagePath, authorizedJob: jobRelocation.profile })
      : { skipped: true, reason: 'start chat did not succeed' }
    actions.push({ type: 'start_chat', result: startChatResult })
    actions.push({ type: 'send_greeting', result: sendResult })

    if (beforeMoveNext) {
      const result = await beforeMoveNext({ actions, profile: jobRelocation.profile, jobMatch: verifiedJobMatch })
      actions.push({ type: 'audit_log', result })
    }

    if (moveNext) {
      await returnToJobsPage(page, { query, city })
      const result = await moveToNextJobOnCurrentPage(page, { confirm })
      actions.push({ type: 'next_job', result })
    }

    return { dryRun: false, profile: jobRelocation.profile, jobMatch: verifiedJobMatch, actions }
  }

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
      ? buildDryRunGreetingSendResult({ message, messageSkipReason, imagePath })
      : startChatResult.success
        ? await sendGreetingToCurrentSurfaceOrRecentChat(page, { message, messageSkipReason, imagePath, authorizedJob: extraction.profile })
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
}

async function relocateAuthorizedJobOnPage (page, {
  authorizedJob,
  currentProfile,
} = {}) {
  const jobIdentityAnchor = getJobId(authorizedJob)
  if (!jobIdentityAnchor) {
    return {
      match: false,
      reason: jobIdentityAnchorMissingReason,
      jobIdentityAnchor: null,
      profile: currentProfile,
    }
  }

  if (getJobId(currentProfile) === jobIdentityAnchor) {
    return {
      match: true,
      method: 'current_detail',
      jobIdentityAnchor,
      profile: currentProfile,
    }
  }

  for (let scrollCount = 0; scrollCount <= maxJobRelocationScrolls; scrollCount += 1) {
    const listInfo = await inspectJobListOnPage(page)
    const item = listInfo.items.find(item => getJobId(item.profile) === jobIdentityAnchor)
    if (item) {
      const clickResult = await clickJobListItem(page, item.index)
      if (!clickResult.moved) {
        return {
          match: false,
          reason: jobRelocationNotFoundReason,
          jobIdentityAnchor,
          profile: currentProfile,
          clickResult,
        }
      }
      const detailJobId = getJobId(clickResult.profile)
      if (!detailJobId) {
        return {
          match: false,
          reason: jobRelocationDetailUnconfirmedReason,
          jobIdentityAnchor,
          profile: clickResult.profile,
          clickedIndex: item.index,
        }
      }
      if (detailJobId !== jobIdentityAnchor) {
        return {
          match: false,
          reason: jobRelocationDetailMismatchReason,
          jobIdentityAnchor,
          profile: clickResult.profile,
          clickedIndex: item.index,
        }
      }
      return {
        match: true,
        method: 'job_card',
        jobIdentityAnchor,
        profile: clickResult.profile,
        clickedIndex: item.index,
        scrollCount,
      }
    }
    if (scrollCount < maxJobRelocationScrolls) {
      await scrollJobListForRelocation(page)
    }
  }

  return {
    match: false,
    reason: jobRelocationNotFoundReason,
    jobIdentityAnchor,
    profile: currentProfile,
  }
}

function summarizeJobRelocation (jobRelocation) {
  return {
    match: jobRelocation.match,
    method: jobRelocation.method,
    jobIdentityAnchor: jobRelocation.jobIdentityAnchor,
    profile: jobReference(jobRelocation.profile),
  }
}

async function scrollJobListForRelocation (page) {
  await page.evaluate((selector) => {
    const items = [...document.querySelectorAll(selector)]
    items.at(-1)?.scrollIntoView?.({ behavior: 'smooth', block: 'end' })
  }, jobItemSelector).catch(() => {})
  await sleep(1500)
}

function pushRelocationFailureActions (actions, {
  reason,
  jobIdentityAnchor,
  currentJob,
  profile,
  jobMatch,
  moveNext,
} = {}) {
  const jobRelocation = {
    match: false,
    reason,
    jobIdentityAnchor: jobIdentityAnchor || null,
    profile: jobReference(profile ?? currentJob),
  }
  actions.push({
    type: 'start_chat',
    result: {
      dryRun: false,
      skipped: true,
      success: false,
      reason,
      jobIdentityAnchor: jobIdentityAnchor || null,
      currentJob,
      jobRelocation,
      jobMatch,
    },
  })
  actions.push({
    type: 'send_greeting',
    result: {
      skipped: true,
      reason: jobRelocationFailureSendGreetingReason,
      relocationFailureReason: reason,
      jobRelocation,
    },
  })
  if (moveNext) {
    actions.push({
      type: 'next_job',
      result: {
        skipped: true,
        reason: jobRelocationFailureNextJobReason,
        relocationFailureReason: reason,
        jobRelocation,
      },
    })
  }
}

export async function sendGreetingToMostRecentChat ({ message, messageSkipReason = '', imagePath, confirm = false, headless = false } = {}) {
  if (!confirm) {
    return buildDryRunGreetingSendResult({ message, messageSkipReason, imagePath })
  }
  const { browser, page } = await openBrowser({ headless })
  try {
    await openChatPage(page)
    const clicked = await clickMostRecentConversation(page)
    if (!clicked) return { clicked: false, textSent: false, imageUploaded: false }
    const result = await sendGreetingOnCurrentSurface(page, { message, messageSkipReason, imagePath })
    return { clicked, ...result }
  } finally {
    await browser.close().catch(() => {})
  }
}

export async function openJobsPage (page, { query = '', city = '' } = {}) {
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

export async function extractCurrentJobOnPage (page) {
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
    recallKeyword: raw.pageQuery,
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
  if (buttonState.authRequired || buttonState.securityCheckRequired) {
    return {
      dryRun: false,
      clicked: false,
      success: false,
      reason: buttonState.authRequired ? 'BOSS_WEB_AUTH_REQUIRED' : 'BOSS_WEB_SECURITY_CHECK_REQUIRED',
      buttonState,
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
    const bodyText = document.body?.innerText ?? ''
    const authRequired = /登录\/注册|登录查看完整内容|请登录|扫码登录|验证码登录/.test(bodyText)
    const securityCheckRequired = /安全验证|环境异常|验证后继续|拖动滑块/.test(bodyText)
    const disabled = !button ||
      button.classList?.contains?.('disabled') ||
      button.hasAttribute?.('disabled') ||
      button.getAttribute?.('aria-disabled') === 'true'
    return {
      found: Boolean(button),
      text,
      disabled,
      authRequired,
      securityCheckRequired,
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
  const trigger = await triggerStartChat(page, button)
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
        triggerMethod: trigger.method,
        currentUrl: page.url(),
      }
    }
    return {
      dryRun: false,
      clicked: true,
      success: false,
      reason: 'ADD_FRIEND_RESPONSE_TIMEOUT',
      triggerMethod: trigger.method,
      error: responseResult.error,
      currentUrl: page.url(),
    }
  }
  return await handleAddFriendResponse(page, responseResult.payload, currentProfile?.jobId, 0, trigger.method)
}

async function triggerStartChat (page, element) {
  const vueResult = await page.evaluate(() => {
    const vm = document.querySelector('.job-detail-box')?.__vue__
    if (typeof vm?.startChatAction !== 'function') return { called: false }
    vm.startChatAction()
    return { called: true }
  }).catch(err => ({ called: false, error: err?.message ?? String(err) }))
  if (vueResult?.called) return { method: 'vue_startChatAction' }

  await clickElementLikeUser(page, element)
  return { method: 'mouse' }
}

async function clickElementLikeUser (page, element) {
  if (element.evaluate) {
    await element.evaluate(node => {
      node.scrollIntoView?.({ block: 'center', inline: 'center' })
    }).catch(() => null)
  }
  await sleep(300 + Math.random() * 700)

  const box = await element.boundingBox?.().catch(() => null)
  if (!box || !page.mouse) {
    await element.click()
    return
  }

  const x = box.x + box.width * (0.35 + Math.random() * 0.3)
  const y = box.y + box.height * (0.35 + Math.random() * 0.3)
  await page.mouse.move(x, y, { steps: 12 + Math.floor(Math.random() * 8) })
  await sleep(120 + Math.random() * 280)
  await page.mouse.down()
  await sleep(80 + Math.random() * 160)
  await page.mouse.up()
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

async function handleAddFriendResponse (page, payload, jobId, depth = 0, triggerMethod = '') {
  if (payload?.code === 0) {
    await waitForGreetingSurface(page).catch(() => null)
    return {
      dryRun: false,
      clicked: true,
      success: true,
      triggerMethod,
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
        triggerMethod,
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
        triggerMethod,
        error: nextResponse.error,
      }
    }
    return await handleAddFriendResponse(page, nextResponse.payload, jobId, depth + 1, triggerMethod)
  }

  if (/今日沟通人数已达上限|明天再来/.test(content)) {
    return {
      dryRun: false,
      clicked: true,
      success: false,
      reason: 'DAILY_LIMIT_REACHED',
      triggerMethod,
      response: summarizeAddFriendResponse(payload),
    }
  }

  return {
    dryRun: false,
    clicked: true,
    success: false,
    reason: 'START_CHAT_REJECTED',
    triggerMethod,
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

export async function sendGreetingToCurrentSurfaceOrRecentChat (page, { message, messageSkipReason = '', imagePath, authorizedJob = null } = {}) {
  const currentSurfaceResult = await sendGreetingOnCurrentSurface(page, { message, messageSkipReason, imagePath })
  if (currentSurfaceResult.textSent || currentSurfaceResult.imageUploaded || currentSurfaceResult.skipped) {
    return { ...currentSurfaceResult, fallbackUsed: false }
  }
  await openChatPage(page)
  const clicked = await clickMostRecentConversation(page)
  if (!clicked) {
    return { ...currentSurfaceResult, fallbackUsed: true, clickedRecentConversation: false }
  }
  const jobMatchGuard = await inspectCurrentChatTargetJobMatchGuard(page, authorizedJob)
  if (!jobMatchGuard.match) {
    return {
      ...currentSurfaceResult,
      fallbackUsed: true,
      clickedRecentConversation: true,
      skipped: true,
      reason: jobMatchGuard.reason,
      jobMatchGuard,
    }
  }
  const fallbackResult = await sendGreetingOnCurrentSurface(page, { message, messageSkipReason, imagePath })
  return { clickedRecentConversation: true, jobMatchGuard, ...fallbackResult, fallbackUsed: true }
}

async function inspectCurrentChatTargetJobMatchGuard (page, authorizedJob) {
  let chatTarget = null
  try {
    chatTarget = await extractCurrentChatTargetOnPage(page)
  } catch (err) {
    return {
      match: false,
      reason: 'CHAT_TARGET_INSPECTION_FAILED',
      comparedBy: 'none',
      expected: jobReference(authorizedJob),
      actual: null,
      error: err?.message ?? String(err),
    }
  }
  return evaluateChatTargetJobMatchGuard({ authorizedJob, chatTarget })
}

async function extractCurrentChatTargetOnPage (page) {
  const raw = await page.evaluate((selectors) => {
    const conversationNode = document.querySelector(selectors.chatEditorSelector) ??
      document.querySelector(selectors.chatConversationSelector)
    const conversation = conversationNode?.__vue__?.conversation$ ?? null
    const selectedFriend = document.querySelector(selectors.chatConversationSelector)?.__vue__?.selectedFriend$ ?? null
    const boss = document.querySelector(selectors.chatRecordSelector)?.__vue__?.boss ?? null
    const selectedConversation = document.querySelector(selectors.selectedConversationSelector)
    return {
      url: location.href,
      conversation: pickPrimitiveFields(conversation, [
        'encryptJobId',
        'jobId',
        'jobName',
        'positionName',
        'position',
        'title',
        'brandName',
        'companyName',
        'encryptBossId',
        'bossId',
        'bossName',
        'name',
        'bossTitle',
      ]),
      selectedFriend: pickPrimitiveFields(selectedFriend, [
        'encryptJobId',
        'jobId',
        'jobName',
        'positionName',
        'position',
        'title',
        'brandName',
        'companyName',
        'bossName',
        'name',
        'encryptBossId',
        'bossId',
      ]),
      boss: pickPrimitiveFields(boss, [
        'encryptBossId',
        'bossId',
        'name',
        'bossName',
        'title',
        'position',
      ]),
      jobDetailText: document.querySelector(selectors.chatJobDetailSelector)?.textContent?.trim?.() ?? '',
      selectedConversationText: selectedConversation?.textContent?.trim?.().replace(/\s+/g, ' ') ?? '',
    }

    function pickPrimitiveFields (source, keys) {
      if (!source || typeof source !== 'object') return null
      const output = {}
      for (const key of keys) {
        const value = source[key]
        if (['string', 'number', 'boolean'].includes(typeof value)) {
          output[key] = value
        }
      }
      return Object.keys(output).length ? output : null
    }
  }, {
    chatConversationSelector,
    chatRecordSelector,
    chatEditorSelector,
    chatJobDetailSelector,
    selectedConversationSelector,
  })
  return normalizeChatTarget(raw)
}

function normalizeChatTarget (raw = {}) {
  const conversation = raw.conversation ?? {}
  const selectedFriend = raw.selectedFriend ?? {}
  const boss = raw.boss ?? {}
  return {
    jobId: firstString(
      conversation.encryptJobId,
      conversation.jobId,
      selectedFriend.encryptJobId,
      selectedFriend.jobId
    ),
    title: firstString(
      conversation.jobName,
      conversation.positionName,
      conversation.position,
      conversation.title,
      selectedFriend.jobName,
      selectedFriend.positionName,
      selectedFriend.position,
      selectedFriend.title
    ),
    company: firstString(
      conversation.brandName,
      conversation.companyName,
      selectedFriend.brandName,
      selectedFriend.companyName
    ),
    bossId: firstString(
      boss.encryptBossId,
      boss.bossId,
      conversation.encryptBossId,
      conversation.bossId
    ),
    bossName: firstString(
      boss.name,
      boss.bossName,
      conversation.bossName
    ),
    bossTitle: firstString(
      boss.title,
      boss.position,
      conversation.bossTitle
    ),
    chatTargetText: [raw.jobDetailText, raw.selectedConversationText].filter(Boolean).join('\n'),
  }
}

export function evaluateChatTargetJobMatchGuard ({ authorizedJob, chatTarget } = {}) {
  if (!authorizedJob) {
    return {
      match: false,
      reason: 'AUTHORIZED_JOB_UNCONFIRMED',
      comparedBy: 'none',
      expected: null,
      actual: jobReference(chatTarget),
    }
  }
  if (!chatTarget) {
    return {
      match: false,
      reason: 'CHAT_TARGET_NOT_FOUND',
      comparedBy: 'none',
      expected: jobReference(authorizedJob),
      actual: null,
    }
  }

  const jobComparison = compareJobForChatGuard(authorizedJob, chatTarget)
  if (!jobComparison.canCompare) {
    return {
      match: false,
      reason: 'CHAT_TARGET_JOB_UNCONFIRMED',
      comparedBy: jobComparison.comparedBy,
      expected: jobReference(authorizedJob),
      actual: jobReference(chatTarget),
      jobComparison,
    }
  }
  if (!jobComparison.match) {
    return {
      match: false,
      reason: 'CHAT_TARGET_JOB_MISMATCH',
      comparedBy: jobComparison.comparedBy,
      expected: jobReference(authorizedJob),
      actual: jobReference(chatTarget),
      jobComparison,
    }
  }

  const bossComparison = compareBossForChatGuard(authorizedJob, chatTarget)
  if (!bossComparison.canCompare) {
    return {
      match: false,
      reason: 'CHAT_TARGET_BOSS_UNCONFIRMED',
      comparedBy: bossComparison.comparedBy,
      expected: jobReference(authorizedJob),
      actual: jobReference(chatTarget),
      jobComparison,
      bossComparison,
    }
  }
  if (!bossComparison.match) {
    return {
      match: false,
      reason: 'CHAT_TARGET_BOSS_MISMATCH',
      comparedBy: bossComparison.comparedBy,
      expected: jobReference(authorizedJob),
      actual: jobReference(chatTarget),
      jobComparison,
      bossComparison,
    }
  }

  return {
    match: true,
    reason: 'CHAT_TARGET_MATCHED_AUTHORIZED_JOB',
    comparedBy: `${jobComparison.comparedBy}+${bossComparison.comparedBy}`,
    expected: jobReference(authorizedJob),
    actual: jobReference(chatTarget),
    jobComparison,
    bossComparison,
  }
}

function compareJobForChatGuard (expected, actual) {
  const expectedJobId = getJobId(expected)
  const actualJobId = getJobId(actual)
  if (expectedJobId && actualJobId) {
    return {
      canCompare: true,
      match: expectedJobId === actualJobId,
      comparedBy: 'jobId',
      expected: expectedJobId,
      actual: actualJobId,
    }
  }

  const expectedTitle = normalizeComparable(getJobTitle(expected))
  const actualTitle = normalizeComparable(getJobTitle(actual))
  const expectedCompany = normalizeComparable(getCompany(expected))
  const actualCompany = normalizeComparable(getCompany(actual))
  if (expectedTitle && actualTitle) {
    const titleMatch = expectedTitle === actualTitle
    const companyMatch = !expectedCompany || !actualCompany || expectedCompany === actualCompany
    return {
      canCompare: true,
      match: titleMatch && companyMatch,
      comparedBy: expectedCompany && actualCompany ? 'title+company' : 'title',
      expected: { title: expectedTitle, company: expectedCompany || undefined },
      actual: { title: actualTitle, company: actualCompany || undefined },
    }
  }

  const actualText = normalizeComparable(actual?.chatTargetText)
  if (expectedTitle && actualText) {
    const titleMatch = actualText.includes(expectedTitle)
    const companyMatch = !expectedCompany || actualText.includes(expectedCompany)
    return {
      canCompare: true,
      match: titleMatch && companyMatch,
      comparedBy: expectedCompany ? 'title+company-in-chat-target-text' : 'title-in-chat-target-text',
      expected: { title: expectedTitle, company: expectedCompany || undefined },
      actual: {
        chatTargetTextLength: actualText.length,
        titleFound: titleMatch,
        companyFound: expectedCompany ? companyMatch : undefined,
      },
    }
  }

  return {
    canCompare: false,
    match: false,
    comparedBy: 'insufficient-job-fields',
    expected: jobReference(expected),
    actual: jobReference(actual),
  }
}

function compareBossForChatGuard (expected, actual) {
  const expectedBossId = getBossId(expected)
  const actualBossId = getBossId(actual)
  if (expectedBossId && actualBossId) {
    return {
      canCompare: true,
      match: expectedBossId === actualBossId,
      comparedBy: 'bossId',
      expected: expectedBossId,
      actual: actualBossId,
    }
  }

  const expectedBossName = normalizeComparable(getBossName(expected))
  const actualBossName = normalizeComparable(getBossName(actual))
  if (expectedBossName && actualBossName) {
    return {
      canCompare: true,
      match: expectedBossName === actualBossName,
      comparedBy: 'bossName',
      expected: expectedBossName,
      actual: actualBossName,
    }
  }

  return {
    canCompare: false,
    match: false,
    comparedBy: 'insufficient-boss-fields',
    expected: jobReference(expected),
    actual: jobReference(actual),
  }
}

export async function openBrowser ({ headless = false } = {}) {
  const browserPath = getBrowserPath()
  if (!browserPath || !fs.existsSync(browserPath)) {
    throw new Error(`NO_BROWSER:${browserPath}`)
  }
  registerPlugins()
  const browser = await puppeteerExtra.launch(buildBrowserLaunchOptions({ browserPath, headless }))
  const page = (await browser.pages())[0] ?? await browser.newPage()
  await configureBossPage(page)
  const { cookies, localStorage } = usePersistentProfile
    ? { cookies: [], localStorage: {} }
    : readBrowserState()
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

export function buildBrowserLaunchOptions ({ browserPath, headless = false } = {}) {
  const launchOptions = {
    executablePath: browserPath,
    headless,
    ignoreHTTPSErrors: true,
    protocolTimeout: 300000,
    defaultViewport: { width: 1440, height: 760 },
    args: ['--no-first-run', '--no-default-browser-check', '--lang=zh-CN,zh', '--disable-blink-features=AutomationControlled'],
  }
  if (usePersistentProfile) {
    launchOptions.userDataDir = getJobAgentBrowserProfileDir()
  }
  return launchOptions
}

async function configureBossPage (page) {
  await page.setExtraHTTPHeaders?.({ 'Accept-Language': 'zh-CN,zh;q=0.9' }).catch(() => null)
  await page.evaluateOnNewDocument?.(() => {
    Object.defineProperty(navigator, 'language', { get: () => 'zh-CN' })
    Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh'] })
  }).catch(() => null)
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

async function sendGreetingOnCurrentSurface (page, { message, messageSkipReason = '', imagePath }) {
  const textResult = message
    ? await sendTextOnCurrentSurface(page, message)
    : buildSkippedTextResult(messageSkipReason)
  const imageResult = imagePath
    ? await sendImageOnCurrentSurface(page, imagePath)
    : { uploaded: false, reason: 'NO_IMAGE' }
  const result = {
    textSent: textResult.sent,
    imageUploaded: imageResult.uploaded,
    textResult,
    imageResult,
  }
  if (textResult.skipped) result.textSkippedReason = textResult.reason
  if (textResult.skipped && !imagePath) {
    result.skipped = true
    result.reason = textResult.reason
  }
  return result
}

function buildDryRunGreetingSendResult ({ message, messageSkipReason = '', imagePath } = {}) {
  const wouldSendMessage = Boolean(message)
  const wouldUploadImage = Boolean(imagePath)
  const result = {
    dryRun: true,
    wouldSendMessage,
    wouldUploadImage,
  }
  if (!wouldSendMessage) {
    result.textResult = buildSkippedTextResult(messageSkipReason)
    result.textSkippedReason = result.textResult.reason
  }
  if (!wouldSendMessage && !wouldUploadImage) {
    result.skipped = true
    result.reason = result.textResult.reason
  }
  return result
}

function buildSkippedTextResult (messageSkipReason = '') {
  return {
    sent: false,
    skipped: true,
    reason: messageSkipReason || 'NO_MESSAGE',
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
  const actualJobId = getJobId(actual)
  const expectedJobId = getJobId(expected)
  if (actualJobId && expectedJobId) {
    return {
      match: actualJobId === expectedJobId,
      comparedBy: 'jobId',
      expected: jobReference(expected),
      actual: jobReference(actual),
    }
  }
  const actualTitle = normalizeComparable(getJobTitle(actual))
  const expectedTitle = normalizeComparable(getJobTitle(expected))
  const actualCompany = normalizeComparable(getCompany(actual))
  const expectedCompany = normalizeComparable(getCompany(expected))
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
    jobId: getJobId(job) || undefined,
    title: getJobTitle(job) || undefined,
    company: getCompany(job) || undefined,
    bossId: getBossId(job) || undefined,
    bossName: getBossName(job) || undefined,
    bossTitle: getBossTitle(job) || undefined,
  }
}

function getJobId (job) {
  return firstString(
    job?.jobId,
    job?.encryptJobId,
    job?.encryptId,
    job?.raw?.jobId,
    job?.raw?.encryptJobId,
    job?.raw?.encryptId,
    job?.raw?.jobInfo?.encryptId,
    job?.raw?.jobInfo?.jobId,
    job?.raw?.selectedJobData?.encryptId,
    job?.raw?.selectedJobData?.jobId,
    job?.raw?.selectedJobData?.encryptJobId,
    job?.raw?.targetJobData?.jobInfo?.encryptId,
    job?.raw?.targetJobData?.jobInfo?.jobId
  )
}

function getJobTitle (job) {
  return firstString(
    job?.title,
    job?.jobName,
    job?.positionName,
    job?.raw?.jobName,
    job?.raw?.title,
    job?.raw?.positionName,
    job?.raw?.jobInfo?.jobName,
    job?.raw?.jobInfo?.title,
    job?.raw?.jobInfo?.positionName,
    job?.raw?.selectedJobData?.jobName,
    job?.raw?.selectedJobData?.title,
    job?.raw?.selectedJobData?.positionName,
    job?.raw?.targetJobData?.jobInfo?.jobName,
    job?.raw?.targetJobData?.jobInfo?.title,
    job?.raw?.targetJobData?.jobInfo?.positionName
  )
}

function getCompany (job) {
  return firstString(
    job?.company,
    job?.companyName,
    job?.brandName,
    job?.raw?.company,
    job?.raw?.companyName,
    job?.raw?.brandName,
    job?.raw?.jobInfo?.brandName,
    job?.raw?.selectedJobData?.brandName,
    job?.raw?.targetJobData?.brandName,
    job?.raw?.targetJobData?.jobInfo?.brandName
  )
}

function getBossId (job) {
  return firstString(
    job?.bossId,
    job?.encryptBossId,
    job?.raw?.bossId,
    job?.raw?.encryptBossId,
    job?.raw?.bossInfo?.encryptBossId,
    job?.raw?.bossInfo?.bossId,
    job?.raw?.targetJobData?.bossInfo?.encryptBossId,
    job?.raw?.targetJobData?.bossInfo?.bossId,
    job?.raw?.selectedJobData?.bossInfo?.encryptBossId,
    job?.raw?.selectedJobData?.bossInfo?.bossId
  )
}

function getBossName (job) {
  return firstString(
    job?.bossName,
    job?.name,
    job?.raw?.bossName,
    job?.raw?.bossInfo?.name,
    job?.raw?.bossInfo?.bossName,
    job?.raw?.targetJobData?.bossInfo?.name,
    job?.raw?.targetJobData?.bossInfo?.bossName,
    job?.raw?.selectedJobData?.bossInfo?.name,
    job?.raw?.selectedJobData?.bossInfo?.bossName
  )
}

function getBossTitle (job) {
  return firstString(
    job?.bossTitle,
    job?.raw?.bossTitle,
    job?.raw?.bossInfo?.title,
    job?.raw?.bossInfo?.position,
    job?.raw?.targetJobData?.bossInfo?.title,
    job?.raw?.targetJobData?.bossInfo?.position,
    job?.raw?.selectedJobData?.bossInfo?.title,
    job?.raw?.selectedJobData?.bossInfo?.position
  )
}

function firstString (...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number') return String(value)
  }
  return ''
}
