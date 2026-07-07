import assert from 'node:assert/strict'
import { test } from 'node:test'

import { evaluateJobWithRules } from './policy.mjs'

test('evaluateJobWithRules keeps recall keyword out of target fit and score', () => {
  const evaluation = evaluateJobWithRules(
    {
      title: '项目助理',
      company: 'Example Co',
      jd: '整理项目资料，协助团队沟通。',
      recallKeyword: 'Rust embedded kernel',
    },
    {
      jobSourceList: [
        {
          type: 'search',
          enabled: true,
          children: [
            { enabled: true, keyword: 'Rust embedded kernel' },
          ],
        },
      ],
    }
  )

  assert.deepEqual(evaluation.recallKeyword, {
    value: 'Rust embedded kernel',
    tokenMatches: 3,
  })
  assert.equal(evaluation.score, 0)
  assert.equal(evaluation.decision, 'skip')
  assert.equal(evaluation.reasons.includes('no lexical candidate profile fit matched'), true)
  assert.equal(
    evaluation.reasons.includes('matched recall keyword trace: Rust embedded kernel'),
    false
  )
})

test('evaluateJobWithRules keeps candidate recall keywords out of target fit', () => {
  const evaluation = evaluateJobWithRules(
    {
      title: 'Rust embedded kernel',
      company: 'Example Co',
      jd: '整理项目资料，协助团队沟通。',
      recallKeyword: 'Rust embedded kernel',
    },
    {
      jobSourceList: [
        {
          type: 'search',
          enabled: true,
          children: [
            { enabled: true, keyword: 'Rust embedded kernel' },
          ],
        },
      ],
    },
    {
      resumeAvailable: false,
      expectedJob: '',
      recallKeywords: ['Rust embedded kernel'],
      intentSignals: [],
      resumeSignals: [],
      requiresLlmForFinalDecision: true,
    }
  )

  assert.deepEqual(evaluation.profileFit.recallKeywordMatches, ['Rust embedded kernel'])
  assert.equal(evaluation.score, 0)
  assert.equal(evaluation.decision, 'uncertain')
  assert.equal(evaluation.reasons.includes('no lexical candidate profile fit matched'), true)
})

test('evaluateJobWithRules keeps preset greeting delivery text and exposes an audit-safe Greeting Plan', () => {
  const greetingMessage = '您好，我想了解这个 Python 岗位。FULL_GREETING_CANARY_0001 C:\\Users\\Private\\resume.png'
  const evaluation = evaluateJobWithRules(
    {
      title: 'Python 后端开发',
      company: 'Example Co',
      jd: '负责 FastAPI 服务开发和 LLM 工具接入。',
    },
    {
      autoStartChatGreetingMessage: '默认开场白',
      autoStartChatGreetingMessageRules: [
        { name: 'AI Agent Template', pattern: 'Python|FastAPI|LLM', message: greetingMessage },
      ],
    }
  )

  assert.equal(evaluation.greetingTemplate, 'AI Agent Template')
  assert.equal(evaluation.greetingMessage, greetingMessage)
  assert.equal(evaluation.greetingPlan.source, 'preset')
  assert.deepEqual(evaluation.greetingPlan.selectedTemplate, {
    type: 'rule',
    rule: 'AI Agent Template',
    name: 'AI Agent Template',
    pattern: 'Python|FastAPI|LLM',
  })
  assert.equal(evaluation.greetingPlan.fallbackReason, null)
  assert.equal(evaluation.greetingPlan.characterCount, Array.from(greetingMessage).length)
  assert.equal(evaluation.greetingPlan.safetyStatus.auditSafe, true)
  assert.equal(evaluation.greetingPlan.safetyStatus.originalMessageSensitive, true)
  assert.equal(JSON.stringify(evaluation.greetingPlan).includes(greetingMessage), false)
  assert.equal(JSON.stringify(evaluation.greetingPlan).includes('FULL_GREETING_CANARY_0001'), false)
  assert.equal(JSON.stringify(evaluation.greetingPlan).includes('C:\\Users\\Private\\resume.png'), false)
})
