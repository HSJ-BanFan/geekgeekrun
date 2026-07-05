import { completes } from '@geekgeekrun/utils/gpt-request.mjs'
import { getEnabledLlmConfig } from './config.mjs'

export async function evaluateJobWithLlm ({ job, ruleEvaluation, llmConfig }) {
  const config = getEnabledLlmConfig(llmConfig)
  if (!config) {
    return { skipped: true, reason: 'no enabled llm config' }
  }

  const completion = await completes({
    baseURL: config.providerCompleteApiUrl ?? config.baseURL,
    apiKey: config.providerApiSecret ?? config.apiKey,
    model: config.model,
    max_tokens: 1200,
    temperature: 0.1,
    response_format: { type: 'json_object' },
  }, [
    {
      role: 'system',
      content: [
        'You evaluate whether a job should be applied to under the configured job-search policy.',
        'The goal is not to prove the candidate is perfect for every JD requirement.',
        'For internships and junior roles, apply when the JD overlaps with the configured target directions and no hard reject appears.',
        'Treat ruleEvaluation.decision as a strong prior. Only downgrade apply when the JD clearly violates reject constraints or is outside the target directions.',
        'Reject Java/J2EE/Spring/MyBatis roles when that stack is the title, core responsibility, or required skill. Do not reject only because Java/Spring/MyBatis appears as optional, bonus, background, department context, or integration context.',
        'When ruleEvaluation.techStackAssessment.requiresLlm is true, you must explicitly decide whether each mentioned rejected stack term is core/required or only optional/background.',
        'Treat phrases like 岗位要求, 任职要求, 要求, 必须, 熟悉, 掌握, 具备, 使用, 开发, 技术栈, 经验 next to Java/J2EE/Spring/MyBatis as evidence that the stack is required unless the same segment explicitly says 加分, 优先, 了解, 不要求, 不需要, 不涉及, or optional/background.',
        'The Chinese phrase "岗位要求熟悉 Java/Spring/MyBatis" means the rejected stack is required; it is not optional.',
        'If Java/J2EE/Spring/MyBatis is core or required, decision must be skip. If those terms are only optional/background, do not reject for that reason.',
        'Reject data annotation, info entry, content audit, sales/customer service, live-stream operations, and no-tech AI training roles.',
        'Return strict JSON with keys: decision, score, category, reason, matched_requirements, missing_requirements, risk_flags, tech_stack_assessment.',
        'tech_stack_assessment must be an object with keys: terms, is_core_required, evidence, explanation. Use is_core_required true when rejected stack is core/required, false when only optional/background, and null when no rejected stack terms are present.',
        'decision must be one of apply, skip, uncertain.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: JSON.stringify({
        job,
        ruleEvaluation: sanitizeRuleEvaluation(ruleEvaluation),
        policy: {
          targetDirections: [
            'Python backend/development internship',
            'data engineering/development/ETL/crawler/automation internship',
            'AI/LLM/Agent application development internship',
            'full-stack development internship',
            'Japanese translation/localization/subtitle work',
            'remote/online/work-from-home roles are preferred',
          ],
          rejectDirections: [
            'Java/J2EE/Spring/MyBatis only when core responsibility or required skill',
            'data annotation, info entry, content audit',
            'sales/customer service/live-stream operations/promotion',
            'no-tech AI training or evaluation work',
          ],
        },
      }),
    },
  ])

  const content = normalizeJsonContent(completion.choices?.[0]?.message?.content ?? '{}')
  try {
    return JSON.parse(content)
  } catch (err) {
    return { parseError: err?.message ?? String(err), raw: content }
  }
}

function normalizeJsonContent (content) {
  const text = String(content ?? '').trim()
  const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(text)
  const candidate = fenced ? fenced[1].trim() : text
  return extractFirstJsonObject(candidate) ?? candidate
}

function extractFirstJsonObject (text) {
  const source = String(text ?? '')
  const start = source.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < source.length; index++) {
    const char = source[index]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') depth += 1
    if (char === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, index + 1)
    }
  }
  return null
}

function sanitizeRuleEvaluation (ruleEvaluation) {
  const {
    greetingMessage,
    resumeImagePath,
    ...safeEvaluation
  } = ruleEvaluation ?? {}
  return safeEvaluation
}
