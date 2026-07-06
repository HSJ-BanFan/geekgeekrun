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
