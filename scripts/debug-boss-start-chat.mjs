#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import minimist from 'minimist'

import {
  extractCurrentJobOnPage,
  openBrowser,
  openJobsPage,
} from '../packages/job-agent-cli/src/browser-actions.mjs'

const argv = minimist(process.argv.slice(2), {
  boolean: ['click', 'keep-open'],
  string: ['recall-keyword', 'city', 'out'],
  default: {
    click: false,
    'keep-open': false,
  },
})

const outputPath = argv.out || path.join(os.tmpdir(), `ggr-boss-start-chat-debug-${Date.now()}.json`)

const browser = await openBrowser({ headless: false })
try {
  const { page } = browser
  const network = []

  page.on('response', async response => {
    const url = response.url()
    if (!url.startsWith('https://www.zhipin.com/wapi/zpgeek/friend/add.json')) return
    const request = response.request()
    let payload = null
    let text = ''
    try {
      payload = await response.json()
    } catch {
      try {
        text = await response.text()
      } catch {}
    }
    network.push({
      url,
      method: request.method(),
      postData: redactPostData(request.postData()),
      status: response.status(),
      payload,
      text: text.slice(0, 1000),
    })
  })

  await openJobsPage(page, {
    query: argv['recall-keyword'] ?? '',
    city: argv.city ?? '',
  })

  const before = await inspectPage(page)
  const extraction = await extractCurrentJobOnPage(page)
  let clickResult = null

  if (argv.click) {
    clickResult = await clickStartChatAndWait(page, extraction.profile?.jobId)
  }

  const after = await inspectPage(page)
  const screenshotPath = outputPath.replace(/\.json$/i, '.png')
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => null)

  const report = {
    ok: true,
    outputPath,
    screenshotPath,
    clicked: Boolean(argv.click),
    before,
    after,
    profile: summarizeProfile(extraction.profile),
    rawJob: summarizeRawJob(extraction.raw),
    clickResult,
    network,
  }

  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify(report, null, 2))

  if (argv['keep-open']) {
    await new Promise(resolve => setTimeout(resolve, 180000))
  }
} finally {
  await browser.browser.close().catch(() => {})
}

async function inspectPage (page) {
  return await page.evaluate(() => {
    const button = document.querySelector('.job-detail-box .op-btn.op-btn-chat')
    const text = document.body?.innerText ?? ''
    const targetJobData = document.querySelector('.job-detail-box')?.__vue__?.data ?? null
    const jobsMain = document.querySelector('.page-jobs-main')?.__vue__ ?? null
    return {
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      webdriver: navigator.webdriver,
      userAgent: navigator.userAgent,
      language: navigator.language,
      languages: navigator.languages,
      pluginCount: navigator.plugins?.length ?? 0,
      hasLoginPrompt: /登录\/注册|登录查看完整内容|请登录|扫码登录|验证码登录/.test(text),
      hasSecurityCheckParam: location.href.includes('_security_check='),
      bodyTextSample: text.slice(0, 500),
      button: {
        found: Boolean(button),
        text: button?.textContent?.trim?.() ?? '',
        className: button?.className ?? '',
        disabled: Boolean(button?.classList?.contains?.('disabled') || button?.hasAttribute?.('disabled')),
      },
      vue: {
        pageQuery: jobsMain?.formData?.query ?? '',
        jobId: targetJobData?.jobInfo?.encryptId ?? '',
        bossId: targetJobData?.jobInfo?.encryptUserId ?? '',
        securityIdPresent: Boolean(targetJobData?.securityId),
        securityIdLength: String(targetJobData?.securityId ?? '').length,
        lid: targetJobData?.lid ?? '',
        sessionIdPresent: Boolean(targetJobData?.sessionId),
        beFriend: targetJobData?.relationInfo?.beFriend ?? null,
        interestJob: targetJobData?.relationInfo?.interestJob ?? null,
      },
    }
  })
}

async function clickStartChatAndWait (page, jobId) {
  const button = await page.$('.job-detail-box .op-btn.op-btn-chat')
  if (!button) return { ok: false, reason: 'button not found' }

  const responsePromise = page.waitForResponse(response => {
    if (!response.url().startsWith('https://www.zhipin.com/wapi/zpgeek/friend/add.json')) return false
    if (!jobId) return true
    return response.url().includes(`jobId=${encodeURIComponent(jobId)}`) || response.url().includes(`jobId=${jobId}`)
  }, { timeout: 25000 }).catch(err => ({ error: err?.message ?? String(err) }))

  await button.evaluate(node => node.scrollIntoView?.({ block: 'center', inline: 'center' })).catch(() => null)
  await new Promise(resolve => setTimeout(resolve, 800))
  const box = await button.boundingBox().catch(() => null)
  if (box && page.mouse) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 18 })
    await new Promise(resolve => setTimeout(resolve, 250))
    await page.mouse.down()
    await new Promise(resolve => setTimeout(resolve, 120))
    await page.mouse.up()
  } else {
    await button.click()
  }

  const response = await responsePromise
  if (response?.error) return { ok: false, reason: 'response timeout', error: response.error, currentUrl: page.url() }
  let payload = null
  try {
    payload = await response.json()
  } catch (err) {
    return { ok: false, reason: 'response json parse failed', error: err?.message ?? String(err), currentUrl: page.url() }
  }
  return { ok: payload?.code === 0, status: response.status(), payload, currentUrl: page.url() }
}

function summarizeProfile (profile) {
  return {
    jobId: profile?.jobId ?? '',
    title: profile?.title ?? '',
    company: profile?.company ?? '',
    bossName: profile?.bossName ?? '',
    bossTitle: profile?.bossTitle ?? '',
    recallKeyword: profile?.recallKeyword ?? '',
  }
}

function summarizeRawJob (raw) {
  return {
    url: raw?.url ?? '',
    selectedJobId: raw?.selectedJobData?.encryptJobId ?? '',
    targetJobId: raw?.targetJobData?.jobInfo?.encryptId ?? '',
    targetBossId: raw?.targetJobData?.jobInfo?.encryptUserId ?? '',
    securityIdPresent: Boolean(raw?.targetJobData?.securityId),
    securityIdLength: String(raw?.targetJobData?.securityId ?? '').length,
    lid: raw?.targetJobData?.lid ?? '',
    sessionIdPresent: Boolean(raw?.targetJobData?.sessionId),
    relationInfo: raw?.targetJobData?.relationInfo ?? null,
  }
}

function redactPostData (postData) {
  if (!postData) return ''
  return String(postData).replace(/([?&]?(?:token|cookie|key|secret|csrf)[^=&]*=)[^&]+/gi, '$1[REDACTED]')
}
