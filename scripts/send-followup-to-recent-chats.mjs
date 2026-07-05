import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import process from 'node:process'
import minimist from 'minimist'
import puppeteerExtra from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import LaodengPlugin from '@geekgeekrun/puppeteer-extra-plugin-laodeng'
import AnonymizeUaPlugin from 'puppeteer-extra-plugin-anonymize-ua'

const argv = minimist(process.argv.slice(2))
const limit = Math.max(1, Number.parseInt(argv.limit ?? '10', 10) || 10)
const runtimeDir = path.join(os.homedir(), '.geekgeekrun')
const storageDir = path.join(runtimeDir, 'storage')
const configDir = path.join(runtimeDir, 'config')
const cookiePath = path.join(storageDir, 'boss-cookies.json')
const localStoragePath = path.join(storageDir, 'boss-local-storage.json')
const bossConfigPath = path.join(configDir, 'boss.json')
const browserRecordPath = path.join(storageDir, 'last-used-browser-record')

const browserPath = fs.existsSync(browserRecordPath)
  ? fs.readFileSync(browserRecordPath, 'utf8').trim().split(/\r?\n/)[0]
  : ''
const bossConfig = JSON.parse(fs.readFileSync(bossConfigPath, 'utf8'))
const message = String(bossConfig.autoStartChatGreetingMessage ?? '').trim()
const imagePath = String(bossConfig.autoStartChatGreetingImagePath ?? '').trim()
const sentMarker = String(
  bossConfig.autoStartChatGreetingSentMarker ??
  message.split(/\s+/).find(part => part.length >= 8) ??
  message.slice(0, 20)
).trim()

if (!browserPath || !fs.existsSync(browserPath)) {
  console.error(JSON.stringify({ type: 'fatal', reason: 'NO_BROWSER', browserPath }))
  process.exit(85)
}
if (!message) {
  console.error(JSON.stringify({ type: 'fatal', reason: 'NO_MESSAGE' }))
  process.exit(1)
}
if (!imagePath || !fs.existsSync(imagePath)) {
  console.error(JSON.stringify({ type: 'fatal', reason: 'NO_IMAGE', imagePath }))
  process.exit(1)
}

puppeteerExtra.use(StealthPlugin())
puppeteerExtra.use(LaodengPlugin())
puppeteerExtra.use(AnonymizeUaPlugin({ makeWindows: false }))

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

const normalize = (text) => String(text ?? '').trim().replace(/\s+/g, ' ')

async function getConversationItems(page) {
  return page.evaluate(() => {
    const selectors = [
      '.user-list-content > *',
      '.user-list .user-list-content li',
      '.chat-user [class*="item"]',
    ]
    const seen = new Set()
    const result = []
    for (const selector of selectors) {
      for (const el of document.querySelectorAll(selector)) {
        if (seen.has(el)) continue
        seen.add(el)
        const rect = el.getBoundingClientRect()
        const text = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ')
        if (!text || rect.width < 40 || rect.height < 40 || rect.height > 140) continue
        result.push({
          text,
          x: rect.left + rect.width / 2,
          y: rect.top + Math.min(rect.height / 2, 40),
          height: rect.height,
        })
      }
    }
    return result
  })
}

async function findConversation(page, targetText) {
  const target = normalize(targetText)
  const prefix = target.slice(0, 42)
  const items = await getConversationItems(page)
  return items.find(item => normalize(item.text).startsWith(prefix))
    ?? items.find(item => target.includes(normalize(item.text).slice(0, 30)))
    ?? null
}

async function clearAndType(page, selector, text) {
  const input = await page.$(selector)
  if (!input) return false
  await input.click()
  await sleep(200)
  await input.evaluate((el) => {
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      el.value = ''
      el.dispatchEvent(new Event('input', { bubbles: true }))
      return
    }
    if (el instanceof HTMLElement && el.isContentEditable) {
      el.innerText = ''
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }))
    }
  })
  await input.type(text, { delay: 8 })
  return true
}

async function clickSend(page) {
  const sendSelector = '.chat-conversation .message-controls .chat-op .btn-send:not(.disabled)'
  const sendButton = await page.$(sendSelector)
  if (!sendButton) return false
  await sendButton.click()
  return true
}

async function sendMessage(page) {
  const inputSelector = '.chat-conversation .message-controls .chat-input'
  const typed = await clearAndType(page, inputSelector, message)
  if (!typed) return false
  await sleep(500)
  const clicked = await clickSend(page)
  await sleep(1800)
  return clicked
}

async function sendImage(page) {
  const inputHandles = await page.$$('.chat-conversation input[type="file"]')
  let imageInput = null
  for (const inputHandle of inputHandles) {
    const canUse = await inputHandle.evaluate((el) => {
      const accept = (el.getAttribute('accept') || '').toLowerCase()
      return !accept || accept.includes('image') || accept.includes('png') || accept.includes('jpg') || accept.includes('jpeg') || accept.includes('*')
    }).catch(() => false)
    if (canUse) {
      imageInput = inputHandle
      break
    }
  }
  if (!imageInput) return { uploaded: false, sendClicked: false }
  await imageInput.uploadFile(imagePath)
  await sleep(2500)
  const sendClicked = await clickSend(page).catch((err) => {
    console.log(JSON.stringify({
      type: 'image-send-click-error',
      message: err?.message ?? String(err),
    }))
    return false
  })
  await sleep(1800)
  return { uploaded: true, sendClicked }
}

async function openChatPage(page) {
  await page.goto('https://www.zhipin.com/web/geek/chat', { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForFunction(() => document.readyState === 'complete', { timeout: 60000 }).catch(() => {})
  await sleep(5000)
}

const browser = await puppeteerExtra.launch({
  executablePath: browserPath,
  headless: false,
  ignoreHTTPSErrors: true,
  protocolTimeout: 120000,
  defaultViewport: { width: 1440, height: 760 },
  args: ['--no-first-run', '--no-default-browser-check'],
})

try {
  const page = (await browser.pages())[0] ?? await browser.newPage()
  const cookies = JSON.parse(fs.readFileSync(cookiePath, 'utf8')).map((cookie) => {
    const copy = { ...cookie }
    if (copy.sameSite === 'unspecified') delete copy.sameSite
    return copy
  })
  if (cookies.length) await page.setCookie(...cookies)

  const localStorageData = JSON.parse(fs.readFileSync(localStoragePath, 'utf8'))
  await page.goto('https://www.zhipin.com/desktop/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {})
  await page.evaluate((data) => {
    for (const [key, value] of Object.entries(data || {})) {
      window.localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value))
    }
  }, localStorageData).catch(() => {})

  await openChatPage(page)

  const initialItems = (await getConversationItems(page))
    .filter(item => item.text.includes('[送达] Boss您好，我想进一步了解'))
    .slice(0, limit)

  console.log(JSON.stringify({
    type: 'targets',
    limit,
    count: initialItems.length,
    targets: initialItems.map(item => item.text.slice(0, 180)),
  }))

  const results = []
  for (let i = 0; i < initialItems.length; i++) {
    const target = initialItems[i]
    try {
      const found = await findConversation(page, target.text)
      if (!found) {
        const result = { index: i + 1, target: target.text.slice(0, 140), found: false }
        results.push(result)
        console.log(JSON.stringify({ type: 'followup-result', ...result }))
        continue
      }

      await page.mouse.click(found.x, found.y)
      await sleep(3500)
      await page.waitForSelector('.chat-conversation .message-controls .chat-input', { timeout: 10000 }).catch(() => null)

      const alreadySent = await page.evaluate((marker) => {
        return Boolean(marker) && (document.querySelector('.chat-conversation')?.innerText?.includes(marker) ?? false)
      }, sentMarker).catch(() => false)

      let textSent = false
      let imageResult = { uploaded: false, sendClicked: false }
      if (!alreadySent) {
        textSent = await sendMessage(page)
        imageResult = await sendImage(page)
      }

      const result = {
        index: i + 1,
        target: target.text.slice(0, 160),
        found: true,
        alreadySent,
        textSent,
        imageUploaded: imageResult.uploaded,
        imageSendClicked: imageResult.sendClicked,
      }
      results.push(result)
      console.log(JSON.stringify({ type: 'followup-result', ...result }))
      await sleep(1800)
    } catch (err) {
      const result = {
        index: i + 1,
        target: target.text.slice(0, 160),
        found: null,
        error: err?.message ?? String(err),
      }
      results.push(result)
      console.log(JSON.stringify({ type: 'followup-result', ...result }))
      await openChatPage(page).catch(() => {})
    }
  }

  console.log(JSON.stringify({ type: 'done', results }))
} finally {
  await browser.close().catch(() => {})
}
