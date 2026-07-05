import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import puppeteerExtra from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import LaodengPlugin from '@geekgeekrun/puppeteer-extra-plugin-laodeng'
import AnonymizeUaPlugin from 'puppeteer-extra-plugin-anonymize-ua'

const runtimeDir = path.join(os.homedir(), '.geekgeekrun')
const storageDir = path.join(runtimeDir, 'storage')
const cookiePath = path.join(storageDir, 'boss-cookies.json')
const localStoragePath = path.join(storageDir, 'boss-local-storage.json')
const browserRecordPath = path.join(storageDir, 'last-used-browser-record')
const browserPath = fs.readFileSync(browserRecordPath, 'utf8').trim().split(/\r?\n/)[0]
const outputPath = path.join(storageDir, `boss-chat-list-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

puppeteerExtra.use(StealthPlugin())
puppeteerExtra.use(LaodengPlugin())
puppeteerExtra.use(AnonymizeUaPlugin({ makeWindows: false }))

function parseItemText(text) {
  const normalized = String(text ?? '').trim().replace(/\s+/g, ' ')
  const timeMatch = normalized.match(/^(今天|昨天|\d{1,2}:\d{2}|\d{1,2}月\d{1,2}日|\d{4}[-/]\d{1,2}[-/]\d{1,2})\s*/)
  const timeText = timeMatch?.[1] ?? ''
  const rest = timeMatch ? normalized.slice(timeMatch[0].length) : normalized
  const recentMessage = rest.includes('[送达]')
    ? rest.slice(rest.indexOf('[送达]') + '[送达]'.length).trim()
    : rest
  const sent = rest.includes('[送达]')
  const image = rest.includes('[图片]')
  const jobMatch = recentMessage.match(/(?:了解|关于)(.+?)这个岗位/) ?? recentMessage.match(/(.+?)(?:这个岗位|岗位)/)
  const jobName = jobMatch?.[1]?.trim() ?? ''
  return { timeText, sent, image, jobName, text: normalized }
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
  const cookies = JSON.parse(fs.readFileSync(cookiePath, 'utf8')).map(cookie => {
    const copy = { ...cookie }
    if (copy.sameSite === 'unspecified') delete copy.sameSite
    return copy
  })
  if (cookies.length) await page.setCookie(...cookies)

  const localStorageData = JSON.parse(fs.readFileSync(localStoragePath, 'utf8'))
  await page.goto('https://www.zhipin.com/desktop/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {})
  await page.evaluate(data => {
    for (const [key, value] of Object.entries(data || {})) {
      window.localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value))
    }
  }, localStorageData).catch(() => {})

  await page.goto('https://www.zhipin.com/web/geek/chat', { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForFunction(() => document.readyState === 'complete', { timeout: 60000 }).catch(() => {})
  await sleep(6000)

  const seen = new Map()
  let stableRounds = 0
  let lastCount = 0

  for (let round = 0; round < 80 && stableRounds < 6; round++) {
    const items = await page.evaluate(() => {
      return [...document.querySelectorAll('.user-list-content li')]
        .map(el => {
          const rect = el.getBoundingClientRect()
          const text = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ')
          return { text, height: rect.height, top: rect.top }
        })
        .filter(item => item.text && item.height >= 40 && item.height <= 150)
    })

    for (const item of items) {
      const parsed = parseItemText(item.text)
      const key = parsed.text
      if (!seen.has(key)) seen.set(key, parsed)
    }

    if (seen.size === lastCount) stableRounds += 1
    else stableRounds = 0
    lastCount = seen.size

    await page.evaluate(() => {
      const scroller = document.querySelector('.user-list-content') || document.querySelector('.user-list')
      if (scroller) scroller.scrollTop += 520
      else window.scrollBy(0, 520)
    })
    await sleep(900)
  }

  const records = [...seen.values()]
  fs.writeFileSync(outputPath, JSON.stringify(records, null, 2), 'utf8')
  console.log(JSON.stringify({ outputPath, count: records.length, sample: records.slice(0, 20) }, null, 2))
} finally {
  await browser.close().catch(() => {})
}
