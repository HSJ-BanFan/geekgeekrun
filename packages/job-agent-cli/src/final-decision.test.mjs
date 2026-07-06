import assert from 'node:assert/strict'
import { test } from 'node:test'

import { resolveFinalDecision, validateRequiredLlmJudgment } from './final-decision.mjs'

const requiredRuleEvaluation = {
  requiresLlmFinalDecision: true,
  attentionTechnologyAssessment: {
    requiresLlm: false,
    terms: [],
  },
}

function completeLlmEvaluation (overrides = {}) {
  return {
    decision: 'apply',
    resume_fit: 'Resume shows Python backend project evidence.',
    intent_fit: 'JD aligns with expected Python backend internship.',
    recall_context: 'Job was recalled from the Python backend internship Recall Keyword.',
    attention_technology_assessment: {
      explanation: 'Core Attention Technologies are Python/FastAPI and overlap with candidate profile.',
      is_core_required: null,
    },
    ...overrides,
  }
}

test('validateRequiredLlmJudgment requires recall_context', () => {
  const missingRecallContext = completeLlmEvaluation({
    recall_context: undefined,
  })

  assert.equal(
    validateRequiredLlmJudgment(missingRecallContext, requiredRuleEvaluation, 'apply'),
    'llm missing required judgment/context: recall_context'
  )
})

test('resolveFinalDecision accepts recall_context as recall traceability context', () => {
  const result = resolveFinalDecision(requiredRuleEvaluation, completeLlmEvaluation())

  assert.deepEqual(result, {
    decision: 'apply',
    source: 'llm',
    reason: 'llm decision applied after candidate profile and rule boundary check',
  })
})

test('resolveFinalDecision fails safe when recall_context is missing', () => {
  const result = resolveFinalDecision(
    requiredRuleEvaluation,
    completeLlmEvaluation({ recall_context: '   ' })
  )

  assert.deepEqual(result, {
    decision: 'uncertain',
    source: 'llm',
    reason: 'llm missing required judgment/context: recall_context',
  })
})
