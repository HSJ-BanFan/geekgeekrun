import { completes } from '@geekgeekrun/utils/gpt-request.mjs'
import { getEnabledLlmConfig } from './config.mjs'
import { limitResumeMarkdown, summarizeCandidateProfile } from './candidate-profile.mjs'

export async function evaluateJobWithLlm ({ job, ruleEvaluation, llmConfig, candidateProfile = null }) {
  const config = getEnabledLlmConfig(llmConfig)
  if (!config) {
    return { skipped: true, reason: 'no enabled llm config' }
  }

  const completion = await completes({
    baseURL: config.providerCompleteApiUrl ?? config.baseURL,
    apiKey: config.providerApiSecret ?? config.apiKey,
    model: config.model,
    max_tokens: 1800,
    temperature: 0.1,
    response_format: { type: 'json_object' },
  }, [
    {
      role: 'system',
      content: [
        'You evaluate whether the candidate should apply to a job.',
        'Use the candidate resume, stated expected job, configured Recall Keywords, configured regex signals, rule evidence, and the JD together.',
        'Recall Keywords are sourcing traceability only. Never decide apply solely because a Recall Keyword matched.',
        'The final apply decision requires meaningful overlap between the JD core responsibilities/required skills and the candidate resume or stated intent.',
        'For internships and junior roles, the candidate does not need to satisfy every listed requirement, but the role direction and core Attention Technologies must be plausible from the resume/intent.',
        'Attention Technology is not a static blacklist. Identify the JD core/required technologies from the title, responsibilities, and requirements, then compare them to the candidate profile.',
        'If ruleEvaluation.attentionTechnologyAssessment.terms contains Attention Technology terms such as Java/J2EE/Spring/MyBatis, explain whether those terms are core/required or only optional/background/department mentions. Do not reject merely because a term appears.',
        'Treat phrases like 岗位要求, 任职要求, 要求, 必须, 熟悉, 掌握, 具备, 使用, 开发, 技术栈, 经验 next to a technology as evidence that the technology is required unless the same segment explicitly says 加分, 优先, 了解, 不要求, 不需要, 不涉及, or optional/background.',
        'If a technology is only a department/background/integration mention, do not treat it as a required skill.',
        'If core/required Attention Technologies do not match the candidate resume or target intent, usually skip or mark uncertain depending on severity and internship tolerance.',
        'Reject data annotation, info entry, content audit, sales/customer service, live-stream operations, and no-tech AI training roles.',
        'Return strict JSON with keys: decision, score, category, reason, jd_match_summary, resume_fit, intent_fit, recall_context, matched_requirements, missing_requirements, risk_flags, attention_technology_assessment.',
        'resume_fit must explain evidence from the resume and gaps. intent_fit must explain whether the JD matches the expected job and configured intent.',
        'recall_context must explain the Recall Keyword or other recall source that brought this job into review. It is traceability context only; do not use it as a match score, and do not justify apply solely from recall_context.',
        'attention_technology_assessment must be an object with keys: core_required_attention_technologies, candidate_profile_overlap, mismatched_core_required_attention_technologies, mentioned_but_not_required_attention_technologies, terms, is_core_required, evidence, explanation.',
        'For attention_technology_assessment.is_core_required, use true only when ruleEvaluation.attentionTechnologyAssessment.terms are core/required, false when those Attention Technology terms are only optional/background, and null when no Attention Technology terms are present.',
        'decision must be one of apply, skip, uncertain.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: JSON.stringify({
        job,
        ruleEvaluation: sanitizeRuleEvaluation(ruleEvaluation),
        candidateProfile: summarizeCandidateProfile(candidateProfile),
        resumeMarkdown: limitResumeMarkdown(candidateProfile),
        policy: {
          finalDecisionSource: 'LLM must combine resume + expected job + configured Recall Keywords + JD. Rules are boundary checks and evidence only.',
          recallKeywordRole: 'Recall Keywords indicate how the job was sourced. They are traceability context and cannot by themselves justify apply.',
          hardRejectDirections: [
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
