#!/usr/bin/env node
import { openBrowser } from '../packages/job-agent-cli/src/browser-actions.mjs'

const { browser, page } = await openBrowser({ headless: false })
await page.goto('https://www.zhipin.com/web/user/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null)
await page.bringToFront().catch(() => null)

console.log('BOSS login page opened in the job-agent browser profile.')
console.log('Complete login in the opened browser window, then close the browser when done.')

process.on('SIGINT', async () => {
  await browser.close().catch(() => null)
  process.exit(0)
})

await new Promise(() => {})
