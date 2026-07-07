import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import {
  evaluateChatTargetJobMatchGuard,
  runCurrentJobBrowserActionsOnOpenPage,
  sendGreetingToCurrentSurfaceOrRecentChat,
} from './browser-actions.mjs'

test('evaluateChatTargetJobMatchGuard accepts a matching chat target job and boss', () => {
  const guard = evaluateChatTargetJobMatchGuard({
    authorizedJob: {
      jobId: 'job-1',
      title: '后端开发',
      company: '示例科技',
      bossName: '王经理',
    },
    chatTarget: {
      jobId: 'job-1',
      title: '后端开发',
      bossName: '王经理',
    },
  })

  assert.equal(guard.match, true)
  assert.equal(guard.reason, 'CHAT_TARGET_MATCHED_AUTHORIZED_JOB')
  assert.equal(guard.comparedBy, 'jobId+bossName')
})

test('evaluateChatTargetJobMatchGuard rejects an unconfirmed chat target job', () => {
  const guard = evaluateChatTargetJobMatchGuard({
    authorizedJob: {
      jobId: 'job-1',
      title: '后端开发',
      bossName: '王经理',
    },
    chatTarget: {
      bossName: '王经理',
    },
  })

  assert.equal(guard.match, false)
  assert.equal(guard.reason, 'CHAT_TARGET_JOB_UNCONFIRMED')
})

test('evaluateChatTargetJobMatchGuard rejects a matching job with the wrong boss', () => {
  const guard = evaluateChatTargetJobMatchGuard({
    authorizedJob: {
      jobId: 'job-1',
      title: '后端开发',
      bossName: '王经理',
    },
    chatTarget: {
      jobId: 'job-1',
      title: '后端开发',
      bossName: '李经理',
    },
  })

  assert.equal(guard.match, false)
  assert.equal(guard.reason, 'CHAT_TARGET_BOSS_MISMATCH')
})

test('sendGreetingToCurrentSurfaceOrRecentChat skips fallback send when guard cannot confirm chat target', async () => {
  const selectors = []
  let clickedRecentConversation = false

  const page = {
    async $ (selector) {
      selectors.push(selector)
      if (selector.includes('user-list-content li')) {
        return {
          async click () {
            clickedRecentConversation = true
          },
        }
      }
      return null
    },
    async evaluate () {
      return {
        conversation: null,
        selectedFriend: null,
        boss: { name: '王经理' },
        jobDetailText: '',
        selectedConversationText: '',
      }
    },
    async goto () {},
    async waitForFunction () {},
  }

  const result = await sendGreetingToCurrentSurfaceOrRecentChat(page, {
    message: '你好，想了解这个岗位',
    authorizedJob: {
      jobId: 'job-1',
      title: '后端开发',
      bossName: '王经理',
    },
  })

  assert.equal(clickedRecentConversation, true)
  assert.equal(result.skipped, true)
  assert.equal(result.reason, 'CHAT_TARGET_JOB_UNCONFIRMED')
  assert.equal(result.jobMatchGuard.match, false)
  assert.equal(
    selectors.filter(selector => selector === '.chat-conversation .message-controls .chat-input').length,
    1
  )
})

test('runCurrentJobBrowserActions dry-run apply reports the job identity anchor without clicking', async () => {
  let jobCardClicked = false
  const page = createJobsPageFake({
    currentProfile: {
      jobId: 'other-job',
      title: '其他岗位',
      company: '示例科技',
    },
    jobList: [
      { jobId: 'authorized-job', title: '后端开发', company: '示例科技' },
    ],
    onJobCardClick: () => {
      jobCardClicked = true
    },
  })

  const result = await runCurrentJobBrowserActionsOnOpenPage(page, {
    shouldApply: true,
    confirm: false,
    expectedJob: {
      jobId: 'authorized-job',
      title: '后端开发',
      company: '示例科技',
    },
    moveNext: false,
  })

  const startChatAction = result.actions.find(action => action.type === 'start_chat')
  assert.equal(startChatAction.result.dryRun, true)
  assert.equal(startChatAction.result.wouldRelocateByJobId, true)
  assert.equal(startChatAction.result.jobIdentityAnchor, 'authorized-job')
  assert.equal(startChatAction.result.confirmationRequired, true)
  assert.equal(jobCardClicked, false)
})

test('runCurrentJobBrowserActions confirmed apply fails closed when the job identity anchor is missing', async () => {
  const page = createJobsPageFake({
    currentProfile: {
      title: '后端开发',
      company: '示例科技',
    },
  })

  const result = await runCurrentJobBrowserActionsOnOpenPage(page, {
    shouldApply: true,
    confirm: true,
    expectedJob: {
      title: '后端开发',
      company: '示例科技',
    },
    moveNext: true,
  })

  const startChatAction = result.actions.find(action => action.type === 'start_chat')
  const sendGreetingAction = result.actions.find(action => action.type === 'send_greeting')
  const nextJobAction = result.actions.find(action => action.type === 'next_job')
  assert.equal(startChatAction.result.skipped, true)
  assert.equal(startChatAction.result.reason, 'JOB_IDENTITY_ANCHOR_MISSING')
  assert.equal(sendGreetingAction.result.skipped, true)
  assert.equal(sendGreetingAction.result.reason, 'start chat skipped due to job relocation failure')
  assert.equal(nextJobAction.result.skipped, true)
  assert.equal(nextJobAction.result.reason, 'next job skipped due to job relocation failure')
})

test('runCurrentJobBrowserActions confirmed apply accepts the current detail when it already matches the job identity anchor', async () => {
  let jobCardClicked = false
  const page = createJobsPageFake({
    currentProfile: {
      jobId: 'authorized-job',
      title: '后端开发',
      company: '示例科技',
    },
    jobList: [
      { jobId: 'authorized-job', title: '后端开发', company: '示例科技' },
    ],
    startChatButtonState: {
      found: true,
      text: '已沟通',
      disabled: true,
      canStart: false,
    },
    onJobCardClick: () => {
      jobCardClicked = true
    },
  })

  const result = await runCurrentJobBrowserActionsOnOpenPage(page, {
    shouldApply: true,
    confirm: true,
    expectedJob: {
      jobId: 'authorized-job',
      title: '后端开发',
      company: '示例科技',
    },
    moveNext: false,
  })

  const startChatAction = result.actions.find(action => action.type === 'start_chat')
  assert.equal(startChatAction.result.reason, 'START_CHAT_UNAVAILABLE')
  assert.equal(startChatAction.result.jobRelocation.method, 'current_detail')
  assert.equal(startChatAction.result.jobRelocation.jobIdentityAnchor, 'authorized-job')
  assert.equal(jobCardClicked, false)
})

test('runCurrentJobBrowserActions confirmed apply clicks a matching job card and verifies the detail pane', async () => {
  const clickedJobIds = []
  const page = createJobsPageFake({
    currentProfile: {
      jobId: 'other-job',
      title: '其他岗位',
      company: '示例科技',
    },
    jobList: [
      { jobId: 'other-job', title: '其他岗位', company: '示例科技' },
      { jobId: 'authorized-job', title: '后端开发', company: '示例科技' },
    ],
    startChatButtonState: {
      found: true,
      text: '已沟通',
      disabled: true,
      canStart: false,
    },
    onJobCardClick: (job) => {
      clickedJobIds.push(job.jobId)
    },
  })

  const result = await runCurrentJobBrowserActionsOnOpenPage(page, {
    shouldApply: true,
    confirm: true,
    expectedJob: {
      jobId: 'authorized-job',
      title: '后端开发',
      company: '示例科技',
    },
    moveNext: false,
  })

  const startChatAction = result.actions.find(action => action.type === 'start_chat')
  assert.deepEqual(clickedJobIds, ['authorized-job'])
  assert.equal(result.profile.jobId, 'authorized-job')
  assert.equal(startChatAction.result.jobRelocation.method, 'job_card')
  assert.equal(startChatAction.result.jobRelocation.jobIdentityAnchor, 'authorized-job')
})

test('runCurrentJobBrowserActions confirmed apply sends safe text after job identity verification', async () => {
  const sentMessages = []
  const page = createJobsPageFake({
    currentProfile: {
      jobId: 'authorized-job',
      title: '后端开发',
      company: '示例科技',
    },
    jobList: [
      { jobId: 'authorized-job', title: '后端开发', company: '示例科技' },
    ],
    startChatButtonState: {
      found: true,
      text: '立即沟通',
      disabled: false,
      canStart: true,
    },
    chatInputAvailable: true,
    onTypedMessage: message => {
      sentMessages.push(message)
    },
  })

  const result = await runCurrentJobBrowserActionsOnOpenPage(page, {
    shouldApply: true,
    confirm: true,
    expectedJob: {
      jobId: 'authorized-job',
      title: '后端开发',
      company: '示例科技',
    },
    message: '您好，我想沟通这个岗位。',
    moveNext: false,
  })

  const startChatAction = result.actions.find(action => action.type === 'start_chat')
  const sendGreetingAction = result.actions.find(action => action.type === 'send_greeting')
  assert.equal(startChatAction.result.success, true)
  assert.equal(sendGreetingAction.result.textSent, true)
  assert.deepEqual(sentMessages, ['您好，我想沟通这个岗位。'])
})

test('runCurrentJobBrowserActions confirmed apply skips unsafe text while preserving image upload', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ggr-browser-action-image-'))
  const imagePath = path.join(tempDir, 'resume.png')
  const sentMessages = []
  const uploadedImages = []

  try {
    fs.writeFileSync(imagePath, 'fake image bytes')
    const page = createJobsPageFake({
      currentProfile: {
        jobId: 'authorized-job',
        title: '后端开发',
        company: '示例科技',
      },
      jobList: [
        { jobId: 'authorized-job', title: '后端开发', company: '示例科技' },
      ],
      startChatButtonState: {
        found: true,
        text: '立即沟通',
        disabled: false,
        canStart: true,
      },
      chatInputAvailable: true,
      imageUploadAvailable: true,
      onTypedMessage: message => {
        sentMessages.push(message)
      },
      onImageUpload: filePath => {
        uploadedImages.push(filePath)
      },
    })

    const result = await runCurrentJobBrowserActionsOnOpenPage(page, {
      shouldApply: true,
      confirm: true,
      expectedJob: {
        jobId: 'authorized-job',
        title: '后端开发',
        company: '示例科技',
      },
      message: '',
      messageSkipReason: 'NO_SAFE_GREETING_TEXT',
      imagePath,
      moveNext: false,
    })

    const sendGreetingAction = result.actions.find(action => action.type === 'send_greeting')
    assert.equal(sendGreetingAction.result.textSent, false)
    assert.equal(sendGreetingAction.result.textResult.skipped, true)
    assert.equal(sendGreetingAction.result.textResult.reason, 'NO_SAFE_GREETING_TEXT')
    assert.equal(sendGreetingAction.result.imageUploaded, true)
    assert.deepEqual(sentMessages, [])
    assert.deepEqual(uploadedImages, [imagePath])
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

test('runCurrentJobBrowserActions confirmed apply fails closed when relocation cannot find the job identity anchor', async () => {
  let scrollCount = 0
  const page = createJobsPageFake({
    currentProfile: {
      jobId: 'other-job',
      title: '其他岗位',
      company: '示例科技',
    },
    jobList: [
      { jobId: 'other-job', title: '其他岗位', company: '示例科技' },
    ],
    onRelocationScroll: () => {
      scrollCount += 1
    },
  })

  const result = await runCurrentJobBrowserActionsOnOpenPage(page, {
    shouldApply: true,
    confirm: true,
    expectedJob: {
      jobId: 'authorized-job',
      title: '后端开发',
      company: '示例科技',
    },
    moveNext: true,
  })

  const startChatAction = result.actions.find(action => action.type === 'start_chat')
  const nextJobAction = result.actions.find(action => action.type === 'next_job')
  assert.equal(scrollCount, 5)
  assert.equal(startChatAction.result.skipped, true)
  assert.equal(startChatAction.result.reason, 'JOB_RELOCATION_NOT_FOUND')
  assert.equal(nextJobAction.result.skipped, true)
  assert.equal(nextJobAction.result.relocationFailureReason, 'JOB_RELOCATION_NOT_FOUND')
})

test('runCurrentJobBrowserActions confirmed apply fails closed when post-click detail verification mismatches', async () => {
  const clickedJobIds = []
  const page = createJobsPageFake({
    currentProfile: {
      jobId: 'other-job',
      title: '其他岗位',
      company: '示例科技',
    },
    jobList: [
      { jobId: 'authorized-job', title: '后端开发', company: '示例科技' },
    ],
    resolveClickedProfile: () => ({
      jobId: 'wrong-detail-job',
      title: '错误详情岗位',
      company: '示例科技',
    }),
    onJobCardClick: (job) => {
      clickedJobIds.push(job.jobId)
    },
  })

  const result = await runCurrentJobBrowserActionsOnOpenPage(page, {
    shouldApply: true,
    confirm: true,
    expectedJob: {
      jobId: 'authorized-job',
      title: '后端开发',
      company: '示例科技',
    },
    moveNext: true,
  })

  const startChatAction = result.actions.find(action => action.type === 'start_chat')
  const nextJobAction = result.actions.find(action => action.type === 'next_job')
  assert.deepEqual(clickedJobIds, ['authorized-job'])
  assert.equal(startChatAction.result.skipped, true)
  assert.equal(startChatAction.result.reason, 'JOB_RELOCATION_DETAIL_MISMATCH')
  assert.equal(nextJobAction.result.skipped, true)
  assert.equal(nextJobAction.result.relocationFailureReason, 'JOB_RELOCATION_DETAIL_MISMATCH')
})

test('runCurrentJobBrowserActions confirmed apply fails closed when post-click detail cannot confirm a job id', async () => {
  const page = createJobsPageFake({
    currentProfile: {
      jobId: 'other-job',
      title: '其他岗位',
      company: '示例科技',
    },
    jobList: [
      { jobId: 'authorized-job', title: '后端开发', company: '示例科技' },
    ],
    resolveClickedProfile: () => ({
      title: '后端开发',
      company: '示例科技',
    }),
  })

  const result = await runCurrentJobBrowserActionsOnOpenPage(page, {
    shouldApply: true,
    confirm: true,
    expectedJob: {
      jobId: 'authorized-job',
      title: '后端开发',
      company: '示例科技',
    },
    moveNext: true,
  })

  const startChatAction = result.actions.find(action => action.type === 'start_chat')
  const nextJobAction = result.actions.find(action => action.type === 'next_job')
  assert.equal(startChatAction.result.skipped, true)
  assert.equal(startChatAction.result.reason, 'JOB_RELOCATION_DETAIL_UNCONFIRMED')
  assert.equal(nextJobAction.result.skipped, true)
  assert.equal(nextJobAction.result.relocationFailureReason, 'JOB_RELOCATION_DETAIL_UNCONFIRMED')
})

function createJobsPageFake ({
  currentProfile,
  jobList = [],
  startChatButtonState = {
    found: false,
    text: '',
    disabled: true,
    canStart: false,
  },
  onRelocationScroll = () => {},
  resolveClickedProfile = job => job,
  onJobCardClick = () => {},
  chatInputAvailable = false,
  chatSendButtonAvailable = true,
  imageUploadAvailable = false,
  onTypedMessage = () => {},
  onImageUpload = () => {},
  onStartChatClick = () => {},
  onSendClick = () => {},
} = {}) {
  let selectedProfile = currentProfile
  return {
    url () {
      return 'https://www.zhipin.com/web/geek/jobs'
    },
    async evaluate (fn, arg) {
      const source = String(fn)
      if (arg === '.job-detail-box .op-btn.op-btn-chat') {
        return {
          ...startChatButtonState,
          rect: startChatButtonState.found
            ? { x: 0, y: 0, width: 100, height: 32 }
            : null,
        }
      }
      if (source.includes('scrollIntoView') && source.includes('querySelectorAll(selector)')) {
        onRelocationScroll()
        return null
      }
      if (source.includes('.page-jobs-main') && source.includes('.job-detail-box')) {
        return {
          url: this.url(),
          pageQuery: '',
          selectedJobData: selectedProfile,
          targetJobData: {
            jobInfo: selectedProfile,
          },
          visibleText: selectedProfile?.jd ?? '',
        }
      }
      if (source.includes('querySelectorAll(selector)')) {
        return {
          currentJob: selectedProfile,
          currentIndex: 0,
          items: jobList.map((job, index) => ({
            index,
            className: index === 0 ? 'job-card-box active' : 'job-card-box',
            text: job.jd ?? '',
            data: job,
          })),
        }
      }
      return null
    },
    async $ (selector) {
      if (selector === '.job-detail-box .op-btn.op-btn-chat') {
        if (!startChatButtonState.found) return null
        return {
          async click () {
            onStartChatClick()
          },
        }
      }
      if (selector === '.chat-conversation .message-controls .chat-input' && chatInputAvailable) {
        return {
          async click () {},
          async evaluate () {},
          async type (message) {
            onTypedMessage(message)
          },
        }
      }
      if (selector === '.chat-conversation .message-controls .chat-op .btn-send:not(.disabled)' && chatSendButtonAvailable) {
        return {
          async click () {
            onSendClick()
          },
        }
      }
      return null
    },
    async $$ (selector) {
      if (selector === '.chat-conversation input[type="file"]' && imageUploadAvailable) {
        return [
          {
            async evaluate () {
              return true
            },
            async uploadFile (filePath) {
              onImageUpload(filePath)
            },
          },
        ]
      }
      if (selector !== 'ul.rec-job-list li.job-card-box') return []
      return jobList.map(job => ({
        async evaluate () {},
        async click () {
          selectedProfile = resolveClickedProfile(job)
          onJobCardClick(job)
        },
      }))
    },
    async waitForResponse () {
      return {
        async json () {
          return { code: 0 }
        },
      }
    },
    async waitForSelector () {
      return {}
    },
  }
}
