import assert from 'node:assert/strict'
import { test } from 'node:test'

import { evaluateJobWithRules } from './policy.mjs'

test('evaluateJobWithRules keeps recall keyword out of target fit and score', () => {
  const evaluation = evaluateJobWithRules(
    {
      title: '项目助理',
      company: 'Example Co',
      jd: '整理项目资料，协助团队沟通。',
      sourceKeyword: 'Rust embedded kernel',
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
    keyword: 'Rust embedded kernel',
    tokenMatches: 3,
  })
  assert.equal('keywordMatch' in evaluation, false)
  assert.equal(evaluation.score, 0)
  assert.equal(evaluation.decision, 'skip')
  assert.equal(evaluation.reasons.includes('no lexical candidate profile fit matched'), true)
  assert.equal(
    evaluation.reasons.includes('matched configured keyword context: Rust embedded kernel'),
    false
  )
})
