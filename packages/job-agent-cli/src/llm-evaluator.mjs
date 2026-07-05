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
        'Reject Java/J2EE/Spring/MyBatis roles, data annotation, info entry, content audit, sales/customer service, live-stream operations, and no-tech AI training roles.',
        'Return strict JSON with keys: decision, score, category, reason, matched_requirements, missing_requirements, risk_flags.',
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
            'Java/J2EE/Spring/MyBatis',
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
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text)
  return fenced ? fenced[1].trim() : text
}

function sanitizeRuleEvaluation (ruleEvaluation) {
  const {
    greetingMessage,
    resumeImagePath,
    ...safeEvaluation
  } = ruleEvaluation ?? {}
  return safeEvaluation
}
