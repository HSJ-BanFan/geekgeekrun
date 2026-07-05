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
const limit = Math.max(1, Number.parseInt(argv.limit ?? '20', 10) || 20)
const runtimeDir = path.join(os.homedir(), '.geekgeekrun')
const storageDir = path.join(runtimeDir, 'storage')
const configDir = path.join(runtimeDir, 'config')
const browserPath = fs.readFileSync(path.join(storageDir, 'last-used-browser-record'), 'utf8').trim().split(/\r?\n/)[0]
const cookies = JSON.parse(fs.readFileSync(path.join(storageDir, 'boss-cookies.json'), 'utf8')).map(cookie => {
  const copy = { ...cookie }
  if (copy.sameSite === 'unspecified') delete copy.sameSite
  return copy
})
const localStorageData = JSON.parse(fs.readFileSync(path.join(storageDir, 'boss-local-storage.json'), 'utf8'))
const bossConfig = JSON.parse(fs.readFileSync(path.join(configDir, 'boss.json'), 'utf8'))
const message = String(bossConfig.autoStartChatGreetingMessage ?? '').trim()
const imagePath = String(bossConfig.autoStartChatGreetingImagePath ?? '').trim()
const sentMarker = String(
  bossConfig.autoStartChatGreetingSentMarker ??
  message.split(/\s+/).find(part => part.length >= 8) ??
  message.slice(0, 20)
).trim()

if (!message || !imagePath || !fs.existsSync(imagePath)) {
  console.error(JSON.stringify({ type: 'fatal', reason: 'MISSING_MESSAGE_OR_IMAGE', imagePath }))
  process.exit(1)
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

puppeteerExtra.use(StealthPlugin())
puppeteerExtra.use(LaodengPlugin())
puppeteerExtra.use(AnonymizeUaPlugin({ makeWindows: false }))

async function openChat(page) {
  await page.goto('https://www.zhipin.com/web/geek/chat', { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForFunction(() => document.readyState === 'complete', { timeout: 60000 }).catch(() => {})
  await sleep(6000)
}

async function getTargets(page) {
  return page.evaluate((limit) => {
    return [...document.querySelectorAll('.user-list-content li')]
      .map(el => {
        const rect = el.getBoundingClientRect()
        const text = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ')
        return { text, height: rect.height }
      })
      .filter(item =>
        item.height >= 40 &&
        item.height <= 150 &&
        item.text.includes('[送达] Boss您好，我想进一步了解') &&
        !item.text.includes('[图片]')
      )
      .slice(0, limit)
      .map(item => item.text)
  }, limit)
}

async function clickTarget(page, targetText) {
  const rect = await page.evaluate((targetText) => {
    for (const el of document.querySelectorAll('.user-list-content li')) {
      const text = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ')
      const rect = el.getBoundingClientRect()
      if (rect.height >= 40 && rect.height <= 150 && text === targetText) {
        el.scrollIntoView({ block: 'center' })
        const nextRect = el.getBoundingClientRect()
        return {
          x: nextRect.left + nextRect.width / 2,
          y: nextRect.top + Math.min(nextRect.height / 2, 40),
        }
      }
    }
    return null
  }, targetText)
  if (!rect) return false
  await sleep(400)
  await page.mouse.click(rect.x, rect.y)
  await sleep(3000)
  return true
}

async function sendText(page) {
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

async function sendImage(page) {
  const inputs = await page.$$('.chat-conversation input[type="file"]')
  let chosen = null
  for (const input of inputs) {
    const ok = await input.evaluate(el => {
      const accept = (el.getAttribute('accept') || '').toLowerCase()
      return !accept || accept.includes('image') || accept.includes('png') || accept.includes('jpg') || accept.includes('jpeg')
    }).catch(() => false)
    if (ok) {
      chosen = input
      break
    }
  }
  if (!chosen) return false
  await chosen.uploadFile(imagePath)
  await sleep(2400)
  const button = await page.$('.chat-conversation .message-controls .chat-op .btn-send:not(.disabled)').catch(() => null)
  if (button) await button.click().catch(() => {})
  await sleep(1600)
  return true
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
  if (cookies.length) await page.setCookie(...cookies)
  await page.goto('https://www.zhipin.com/desktop/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {})
  await page.evaluate(data => {
    for (const [key, value] of Object.entries(data || {})) {
      window.localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value))
    }
  }, localStorageData).catch(() => {})

  await openChat(page)
  const targets = await getTargets(page)
  console.log(JSON.stringify({ type: 'targets', limit, count: targets.length, targets: targets.map(t => t.slice(0, 180)) }))

  const results = []
  for (let i = 0; i < targets.length; i++) {
    const target = targets[i]
    const clicked = await clickTarget(page, target)
    let alreadyCustom = false
    let textSent = false
    let imageUploaded = false
    if (clicked) {
      alreadyCustom = await page.evaluate((marker) => {
        return Boolean(marker) && (document.querySelector('.chat-conversation')?.innerText?.includes(marker) ?? false)
      }, sentMarker).catch(() => false)
      if (!alreadyCustom) {
        textSent = await sendText(page)
        imageUploaded = await sendImage(page)
      }
    }
    const result = { index: i + 1, target: target.slice(0, 180), clicked, alreadyCustom, textSent, imageUploaded }
    results.push(result)
    console.log(JSON.stringify({ type: 'followup-result', ...result }))
    await sleep(1000)
  }

  console.log(JSON.stringify({ type: 'done', results }))
} finally {
  await browser.close().catch(() => {})
}
