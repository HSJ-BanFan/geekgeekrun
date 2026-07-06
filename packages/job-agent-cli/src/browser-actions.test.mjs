import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  evaluateChatTargetJobMatchGuard,
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
