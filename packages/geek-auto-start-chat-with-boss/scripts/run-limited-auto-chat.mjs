import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import process from 'node:process'
import minimist from 'minimist'
import { AsyncSeriesHook, SyncHook } from 'tapable'
import {
  initPuppeteer,
  mainLoop,
  closeBrowserWindow,
} from '../index.mjs'

const argv = minimist(process.argv.slice(2))
const limit = Math.max(1, Number.parseInt(argv.limit ?? '10', 10) || 10)
const stopMessage = `LIMIT_REACHED_${limit}`
const startedJobs = []
let successCount = 0
let stopping = false

const browserRecordPath = path.join(os.homedir(), '.geekgeekrun', 'storage', 'last-used-browser-record')
const browserPath = fs.existsSync(browserRecordPath)
  ? fs.readFileSync(browserRecordPath, 'utf8').trim().split(/\r?\n/)[0]
  : ''

if (!browserPath || !fs.existsSync(browserPath)) {
  console.error(JSON.stringify({ type: 'fatal', reason: 'NO_BROWSER', browserPath }))
  process.exit(85)
}

process.env.PUPPETEER_EXECUTABLE_PATH = browserPath

const summarizeJob = (positionInfoDetail, chatRunningContext) => {
  const jobInfo = positionInfoDetail?.jobInfo ?? {}
  const bossInfo = positionInfoDetail?.bossInfo ?? {}
  return {
    index: successCount,
    jobName: jobInfo.jobName ?? jobInfo.title ?? '',
    companyName: jobInfo.brandName ?? positionInfoDetail?.brandName ?? '',
    cityName: jobInfo.cityName ?? positionInfoDetail?.cityName ?? '',
    salaryDesc: jobInfo.salaryDesc ?? positionInfoDetail?.salaryDesc ?? '',
    bossName: bossInfo.name ?? bossInfo.bossName ?? '',
    bossTitle: bossInfo.title ?? bossInfo.position ?? '',
    jobSource: chatRunningContext?.jobSource ?? null,
    encryptJobId: jobInfo.encryptId ?? '',
  }
}

const stopSoon = () => {
  if (stopping) return
  stopping = true
  setTimeout(() => {
    console.log(JSON.stringify({ type: 'limit-stop', limit, successCount, jobs: startedJobs }))
    closeBrowserWindow?.()
    process.exit(0)
  }, 20000).unref()
}

const hooks = {
  puppeteerLaunched: new SyncHook(['browser']),
  pageGotten: new SyncHook(['page']),
  pageLoaded: new SyncHook(),
  cookieWillSet: new AsyncSeriesHook(['cookies']),
  userInfoResponse: new AsyncSeriesHook(['userInfo']),
  mainFlowWillLaunch: new AsyncSeriesHook(['args']),
  jobDetailIsGetFromRecommendList: new AsyncSeriesHook(['userInfo']),
  newChatWillStartup: new AsyncSeriesHook(['positionInfoDetail']),
  newChatStartup: new AsyncSeriesHook(['positionInfoDetail', 'chatRunningContext']),
  jobMarkedAsNotSuit: new AsyncSeriesHook(['positionInfoDetail', 'markDetail']),
  noPositionFoundForCurrentJob: new SyncHook(),
  noPositionFoundAfterTraverseAllJob: new SyncHook(),
  errorEncounter: new SyncHook(['errorInfo']),
  encounterEmptyRecommendJobList: new AsyncSeriesHook(['args']),
  sageTimeEnter: new AsyncSeriesHook(['args']),
  sageTimeExit: new AsyncSeriesHook(['args']),
}

hooks.mainFlowWillLaunch.tapPromise('limited-runner-log-start', async (args) => {
  console.log(JSON.stringify({ type: 'start', limit, browserPath, args }))
})

hooks.userInfoResponse.tapPromise('limited-runner-user-info', async (userInfo) => {
  console.log(JSON.stringify({
    type: 'user-info',
    code: userInfo?.code,
    message: userInfo?.message ?? userInfo?.msg ?? '',
  }))
})

hooks.newChatWillStartup.tapPromise('limited-runner-stop-before-next-click', async (positionInfoDetail) => {
  if (successCount >= limit) {
    console.log(JSON.stringify({
      type: 'stop-before-next-click',
      limit,
      successCount,
      nextJobName: positionInfoDetail?.jobInfo?.jobName ?? '',
      nextCompanyName: positionInfoDetail?.jobInfo?.brandName ?? '',
    }))
    throw new Error(stopMessage)
  }
})

hooks.newChatStartup.tapPromise('limited-runner-count-success', async (positionInfoDetail, chatRunningContext) => {
  successCount += 1
  const job = summarizeJob(positionInfoDetail, chatRunningContext)
  startedJobs.push(job)
  console.log(JSON.stringify({ type: 'chat-started', limit, successCount, job }))
  if (successCount >= limit) {
    stopSoon()
  }
})

hooks.jobMarkedAsNotSuit.tapPromise('limited-runner-log-not-suit', async (positionInfoDetail, markDetail) => {
  console.log(JSON.stringify({
    type: 'job-skipped',
    reason: markDetail?.markReason ?? null,
    op: markDetail?.markOp ?? null,
    jobName: positionInfoDetail?.jobInfo?.jobName ?? '',
    companyName: positionInfoDetail?.jobInfo?.brandName ?? '',
  }))
})

hooks.errorEncounter.tap('limited-runner-log-error', (errorInfo) => {
  const text = errorInfo instanceof Error ? errorInfo.message : String(errorInfo ?? '')
  console.log(JSON.stringify({ type: 'error-encounter', message: text.slice(0, 1000) }))
})

hooks.encounterEmptyRecommendJobList.tapPromise('limited-runner-empty-list', async (args) => {
  console.log(JSON.stringify({ type: 'empty-list', args }))
})

hooks.sageTimeEnter.tapPromise('limited-runner-sage-enter', async (args) => {
  console.log(JSON.stringify({ type: 'sage-enter', args }))
})

hooks.sageTimeExit.tapPromise('limited-runner-sage-exit', async (args) => {
  console.log(JSON.stringify({ type: 'sage-exit', args }))
})

process.on('SIGINT', () => {
  console.log(JSON.stringify({ type: 'sigint', successCount, jobs: startedJobs }))
  closeBrowserWindow?.()
  process.exit(130)
})

process.on('SIGTERM', () => {
  console.log(JSON.stringify({ type: 'sigterm', successCount, jobs: startedJobs }))
  closeBrowserWindow?.()
  process.exit(143)
})

try {
  console.log(JSON.stringify({ type: 'boot', limit }))
  await initPuppeteer()
  await mainLoop(hooks)
} catch (err) {
  const message = err?.message ?? String(err)
  if (message.includes(stopMessage) || successCount >= limit) {
    console.log(JSON.stringify({ type: 'done', limit, successCount, jobs: startedJobs }))
    closeBrowserWindow?.()
    process.exit(0)
  }
  console.error(JSON.stringify({ type: 'fatal', message, successCount, jobs: startedJobs }))
  closeBrowserWindow?.()
  process.exit(1)
}
