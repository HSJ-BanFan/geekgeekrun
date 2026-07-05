import fs from 'node:fs'
import puppeteerExtra from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import LaodengPlugin from '@geekgeekrun/puppeteer-extra-plugin-laodeng'
import AnonymizeUaPlugin from 'puppeteer-extra-plugin-anonymize-ua'
import { getBrowserPath, readBrowserState } from './config.mjs'
import { normalizeJobProfile } from './job-profile.mjs'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
let pluginsRegistered = false

export async function extractCurrentJobFromBrowser ({ headless = false } = {}) {
  const { browser, page } = await openBrowser({ headless })
  try {
    await page.goto('https://www.zhipin.com/web/geek/jobs', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {})
    await page.waitForFunction(() => document.readyState === 'complete', { timeout: 60000 }).catch(() => {})
    await sleep(5000)
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
    const textSent = message ? await sendText(page, message) : false
    const imageUploaded = imagePath ? await sendImage(page, imagePath) : false
    return { clicked, textSent, imageUploaded }
  } finally {
    await browser.close().catch(() => {})
  }
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
  await page.goto('https://www.zhipin.com/web/geek/chat', { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForFunction(() => document.readyState === 'complete', { timeout: 60000 }).catch(() => {})
  await sleep(5000)
}

async function clickMostRecentConversation (page) {
  const item = await page.$('.user-list-content li, .user-list .user-list-content li')
  if (!item) return false
  await item.click()
  await sleep(3000)
  return true
}

async function sendText (page, message) {
  const input = await page.$('.chat-conversation .message-controls .chat-input')
  if (!input) return false
  await input.click()
  await sleep(200)
  await input.evaluate(el => {
    if (el instanceof HTMLElement) {
      el.innerText = ''
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }))
    }
  })
  await input.type(message, { delay: 8 })
  await sleep(500)
  const button = await page.$('.chat-conversation .message-controls .chat-op .btn-send:not(.disabled)')
  if (!button) return false
  await button.click()
  await sleep(1600)
  return true
}

async function sendImage (page, imagePath) {
  if (!fs.existsSync(imagePath)) return false
  const inputs = await page.$$('.chat-conversation input[type="file"]')
  for (const input of inputs) {
    const ok = await input.evaluate(el => {
      const accept = (el.getAttribute('accept') || '').toLowerCase()
      return !accept || accept.includes('image') || accept.includes('png') || accept.includes('jpg') || accept.includes('jpeg')
    }).catch(() => false)
    if (!ok) continue
    await input.uploadFile(imagePath)
    await sleep(2400)
    const button = await page.$('.chat-conversation .message-controls .chat-op .btn-send:not(.disabled)').catch(() => null)
    if (button) await button.click().catch(() => {})
    await sleep(1600)
    return true
  }
  return false
}
