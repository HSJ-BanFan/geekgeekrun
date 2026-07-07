import { extractSensitiveFragments, redactSensitiveFragments } from './sensitive-text.mjs'

export function buildPresetGreetingPlan (selection = {}) {
  const message = String(selection.message ?? '')
  const characterCount = Array.from(message).length
  const selectedTemplate = normalizeSelectedTemplate(selection)
  const sensitiveFragments = extractSensitiveFragments(message)
  const reasons = []

  if (!message) reasons.push('empty_delivery_text')
  if (sensitiveFragments.length) reasons.push('sensitive_original_omitted_from_plan')

  return {
    source: 'preset',
    selectedTemplate,
    fallbackReason: null,
    summary: buildSummary({ selectedTemplate, characterCount }),
    characterCount,
    safetyStatus: {
      auditSafe: true,
      deliveryTextAvailable: Boolean(message),
      originalMessageSensitive: sensitiveFragments.length > 0,
      reasons,
    },
  }
}

function normalizeSelectedTemplate (selection) {
  const type = selection.type === 'default' ? 'default' : 'rule'
  const rule = redactSensitiveFragments(selection.rule || (type === 'default' ? 'default' : selection.pattern))
  return {
    type,
    rule,
    name: redactSensitiveFragments(selection.name || rule),
    pattern: type === 'default' ? '' : redactSensitiveFragments(selection.pattern),
  }
}

function buildSummary ({ selectedTemplate, characterCount }) {
  const template = selectedTemplate.rule || selectedTemplate.type
  return `Preset greeting selected from ${template}; ${characterCount} characters.`
}
