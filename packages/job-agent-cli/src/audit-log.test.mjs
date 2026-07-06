import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildAuditRecord, sanitizeForAudit } from './audit-log.mjs'

const longJd = [
  'Responsibilities: build Python APIs and AI agent workflows.',
  'Requirements: FastAPI, data pipeline, and LLM integration experience.',
  'Nice to have: remote collaboration experience.',
  'Filler text that represents a long original job description.'.repeat(20),
  'RAW_JD_TAIL_SHOULD_NOT_APPEAR',
].join('\n')

test('buildAuditRecord summarizes JD text without storing the raw JD field', () => {
  const record = buildAuditRecord({
    runId: 'run-1',
    command: 'run-once',
    dryRun: true,
    profile: {
      title: 'Python Backend Intern',
      company: 'Example Co',
      jd: longJd,
      sourceKeyword: 'Python intern',
    },
    finalDecision: { decision: 'uncertain' },
  })

  assert.equal('jd' in record.profile, false)
  assert.equal(record.profile.jdSummary.includes('RAW_JD_TAIL_SHOULD_NOT_APPEAR'), false)
  assert.equal(JSON.stringify(record).includes('RAW_JD_TAIL_SHOULD_NOT_APPEAR'), false)
  assert.equal(record.profile.jdOriginalCharacterCount, longJd.length)
  assert.ok(record.profile.jdSummary.length <= 240)
  assert.ok(record.profile.jdEvidenceSnippets.length > 0)
  assert.ok(record.profile.jdEvidenceSnippets.every(snippet => snippet.length <= 160))
})

test('sanitizeForAudit compresses nested JD text in direct audit events', () => {
  const sanitized = sanitizeForAudit({
    event: 'manual-audit',
    profile: {
      jd: longJd,
      jobDescription: longJd,
    },
    ruleEvaluation: {
      techStackAssessment: {
        evidence: [
          { segment: `${'Long evidence segment. '.repeat(20)}RAW_JD_TAIL_SHOULD_NOT_APPEAR` },
        ],
      },
    },
  })

  assert.equal(typeof sanitized.profile.jd, 'object')
  assert.equal(typeof sanitized.profile.jobDescription, 'object')
  assert.equal(JSON.stringify(sanitized).includes('RAW_JD_TAIL_SHOULD_NOT_APPEAR'), false)
  assert.ok(sanitized.ruleEvaluation.techStackAssessment.evidence[0].segment.length <= 160)
})
