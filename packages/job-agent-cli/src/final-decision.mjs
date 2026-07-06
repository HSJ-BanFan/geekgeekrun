export function resolveFinalDecision (ruleEvaluation, llmEvaluation) {
  if (ruleEvaluation?.hardReject) {
    return {
      decision: 'skip',
      source: 'rules',
      reason: 'hard reject boundary cannot be upgraded by llm',
    }
  }
  const llmDecision = typeof llmEvaluation?.decision === 'string'
    ? llmEvaluation.decision.trim().toLowerCase()
    : ''
  const requiresLlmFinalDecision = Boolean(
    ruleEvaluation?.requiresLlmFinalDecision ||
    ruleEvaluation?.attentionTechnologyAssessment?.requiresLlm
  )
  if (requiresLlmFinalDecision) {
    if (!llmEvaluation || llmEvaluation.skipped) {
      return {
        decision: 'uncertain',
        source: 'rules',
        reason: 'llm final decision required before auto-apply',
      }
    }
    const invalidReason = validateRequiredLlmJudgment(llmEvaluation, ruleEvaluation, llmDecision)
    if (invalidReason) {
      return {
        decision: 'uncertain',
        source: 'llm',
        reason: invalidReason,
      }
    }
  }
  if (['apply', 'skip', 'uncertain'].includes(llmDecision)) {
    return {
      decision: llmDecision,
      source: 'llm',
      reason: 'llm decision applied after candidate profile and rule boundary check',
    }
  }
  if (requiresLlmFinalDecision) {
    return {
      decision: 'uncertain',
      source: 'rules',
      reason: 'missing llm decision for candidate profile final judgment',
    }
  }
  return {
    decision: ruleEvaluation?.decision ?? 'uncertain',
    source: 'rules',
    reason: llmEvaluation?.skipped ? llmEvaluation.reason : 'no llm decision',
  }
}

export function validateRequiredLlmJudgment (llmEvaluation, ruleEvaluation, llmDecision) {
  if (llmEvaluation?.parseError) return `llm response parse error: ${llmEvaluation.parseError}`
  if (!['apply', 'skip', 'uncertain'].includes(llmDecision)) {
    return 'llm decision is missing or invalid'
  }
  if (ruleEvaluation?.requiresLlmFinalDecision) {
    const missing = [
      ['resume_fit', llmEvaluation.resume_fit ?? llmEvaluation.resumeFit],
      ['intent_fit', llmEvaluation.intent_fit ?? llmEvaluation.intentFit],
      ['recall_context', llmEvaluation.recall_context ?? llmEvaluation.recallContext],
    ]
      .filter(([, value]) => !hasLlmExplanation(value))
      .map(([name]) => name)
    if (missing.length) return `llm missing required judgment/context: ${missing.join(', ')}`
  }
  const attentionTechnologyAssessment = getLlmAttentionTechnologyAssessment(llmEvaluation)
  if (!hasLlmExplanation(attentionTechnologyAssessment?.explanation)) {
    return 'llm missing attention technology assessment explanation'
  }
  if ((ruleEvaluation?.attentionTechnologyAssessment?.terms ?? []).length &&
    typeof attentionTechnologyAssessment?.is_core_required !== 'boolean') {
    return 'llm did not explain whether Attention Technology terms are core/required'
  }
  return ''
}

function hasLlmExplanation (value) {
  if (typeof value === 'string') return Boolean(value.trim())
  if (!value || typeof value !== 'object') return false
  return Object.values(value).some(item => {
    if (Array.isArray(item)) return item.length > 0
    if (typeof item === 'string') return Boolean(item.trim())
    return item != null
  })
}

function getLlmAttentionTechnologyAssessment (llmEvaluation) {
  return llmEvaluation?.attention_technology_assessment ?? llmEvaluation?.attentionTechnologyAssessment ?? null
}
