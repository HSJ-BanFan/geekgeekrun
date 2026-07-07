import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { appendAuditLog, buildAuditRecord, sanitizeForAudit } from './audit-log.mjs'

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
      recallKeyword: 'Python intern',
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
      attentionTechnologyAssessment: {
        evidence: [
          { segment: `${'Long evidence segment. '.repeat(20)}RAW_JD_TAIL_SHOULD_NOT_APPEAR` },
        ],
      },
    },
  })

  assert.equal(typeof sanitized.profile.jd, 'object')
  assert.equal(typeof sanitized.profile.jobDescription, 'object')
  assert.equal(JSON.stringify(sanitized).includes('RAW_JD_TAIL_SHOULD_NOT_APPEAR'), false)
  assert.ok(sanitized.ruleEvaluation.attentionTechnologyAssessment.evidence[0].segment.length <= 160)
})

test('appendAuditLog writes Greeting Plan metadata without full preset greeting text', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ggr-greeting-plan-audit-'))
  const auditFile = path.join(tempDir, 'audit.jsonl')
  const greetingMessage = '您好，我想了解这个岗位。FULL_GREETING_CANARY_0002 C:\\Users\\Private\\resume.png API_KEY_SECRET_0002'

  try {
    const entry = buildAuditRecord({
      runId: 'run-greeting-plan-1',
      command: 'run-once',
      dryRun: true,
      profile: {
        title: 'Python Backend Intern',
        company: 'Example Co',
        jd: '负责 Python API 开发。',
      },
      ruleEvaluation: {
        decision: 'apply',
        greetingTemplate: 'AI Agent Template',
        greetingMessage,
        greetingPlan: {
          source: 'preset',
          selectedTemplate: {
            type: 'rule',
            rule: 'AI Agent Template',
            name: 'AI Agent Template',
            pattern: 'Python|FastAPI',
          },
          fallbackReason: null,
          summary: 'Preset greeting selected from AI Agent Template; 70 characters.',
          characterCount: Array.from(greetingMessage).length,
          safetyStatus: {
            auditSafe: true,
            deliveryTextAvailable: true,
            originalMessageSensitive: true,
            reasons: ['sensitive_original_omitted_from_plan'],
          },
        },
      },
      finalDecision: { decision: 'apply' },
    })

    const result = appendAuditLog(entry, { auditFile })
    const persisted = fs.readFileSync(auditFile, 'utf8')

    assert.equal(result.record.ruleEvaluation.greetingPlan.source, 'preset')
    assert.equal(result.record.ruleEvaluation.greetingPlan.selectedTemplate.rule, 'AI Agent Template')
    assert.equal(result.record.ruleEvaluation.greetingMessage, '[REDACTED]')
    assert.equal(persisted.includes(greetingMessage), false)
    assert.equal(persisted.includes('FULL_GREETING_CANARY_0002'), false)
    assert.equal(persisted.includes('C:\\Users\\Private\\resume.png'), false)
    assert.equal(persisted.includes('API_KEY_SECRET_0002'), false)
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

test('sanitizeForAudit redacts greeting text fields while keeping safe plan metadata', () => {
  const generatedGreeting = '您好，我关注到岗位需要 FastAPI 和 LLM 工具集成，这是一段完整生成开场白，不应进入审计记录。'
  const presetGreeting = '您好，我想了解这个岗位，这是一段完整预设开场白，也不应进入审计记录。'
  const sanitized = sanitizeForAudit({
    command: 'run-once',
    ruleEvaluation: {
      generatedGreetingText: generatedGreeting,
      selectedGreetingMessage: presetGreeting,
      greetingPlan: {
        source: 'preset',
        fallbackReason: 'guard_rejected',
        safeSummary: 'Preset greeting selected from default; 0 characters.',
        characterCount: 0,
        personalization: {
          guardResult: {
            passed: false,
            safeSummary: 'Personalized greeting failed Greeting Guard; 40 characters; unsupported_claim.',
          },
        },
      },
    },
    actions: [
      {
        type: 'send_greeting',
        result: {
          textResult: {
            sent: false,
            skipped: true,
            reason: 'NO_SAFE_GREETING_TEXT',
          },
        },
      },
    ],
  })

  const text = JSON.stringify(sanitized)
  assert.equal(text.includes(generatedGreeting), false)
  assert.equal(text.includes(presetGreeting), false)
  assert.equal(sanitized.ruleEvaluation.generatedGreetingText, '[REDACTED]')
  assert.equal(sanitized.ruleEvaluation.selectedGreetingMessage, '[REDACTED]')
  assert.equal(sanitized.ruleEvaluation.greetingPlan.source, 'preset')
  assert.equal(sanitized.ruleEvaluation.greetingPlan.fallbackReason, 'guard_rejected')
  assert.equal(sanitized.actions[0].result.textResult.reason, 'NO_SAFE_GREETING_TEXT')
})
