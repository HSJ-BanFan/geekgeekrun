import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { test } from 'node:test'

import {
  consumeAuthorizationToken,
  inspectAuthorizationToken,
  issueAuthorizationToken,
  readAuthorizationTokenStore,
} from './authorization-token.mjs'

const execFileAsync = promisify(execFile)

test('issues and persists an audit-safe Application Authorization Token after LLM apply authorization', () => {
  withTempTokenFile(({ tokenFile }) => {
    const result = issueAuthorizationToken({
      runId: 'run-token-1',
      job: sensitiveJob(),
      finalDecision: llmApplyDecision(),
      ruleEvaluation: sensitiveRuleEvaluation(),
      llmEvaluation: sensitiveLlmEvaluation(),
      allowedActions: ['start_chat', 'send_greeting'],
      ttlMs: 60000,
      now: new Date('2026-07-07T10:00:00.000Z'),
      tokenFile,
    })

    assert.equal(result.issued, true)
    assert.equal(result.token.runId, 'run-token-1')
    assert.equal(result.token.jobId, 'boss-job-123')
    assert.deepEqual(result.token.allowedActions, ['start_chat', 'send_greeting'])
    assert.equal(result.token.consumption.state, 'unconsumed')
    assert.equal(result.token.expiresAt, '2026-07-07T10:01:00.000Z')

    const store = readAuthorizationTokenStore({ tokenFile })
    assert.equal(store.tokens.length, 1)
    assert.equal(store.tokens[0].tokenId, result.token.tokenId)
    assert.equal(store.tokens[0].decisionEvidence.job.jobId, 'boss-job-123')
    assert.equal(store.tokens[0].decisionEvidence.job.jdSummary.includes('RAW_JD_TAIL_SHOULD_NOT_PERSIST'), false)
    assert.equal(store.tokens[0].decisionEvidence.finalDecision.decision, 'apply')
    assert.equal(store.tokens[0].decisionEvidence.llmEvaluation.decision, 'apply')

    const persisted = fs.readFileSync(tokenFile, 'utf8')
    for (const forbidden of forbiddenCanaries()) {
      assert.equal(persisted.includes(forbidden), false, `persisted token record leaked ${forbidden}`)
    }
  })
})

test('does not issue tokens for denied, malformed, incomplete, or rule-granted decisions', () => {
  withTempTokenFile(({ tokenFile }) => {
    const cases = [
      {
        name: 'skip',
        finalDecision: { decision: 'skip', source: 'llm' },
        expectedReasonCode: 'FINAL_DECISION_NOT_APPLY',
      },
      {
        name: 'uncertain',
        finalDecision: { decision: 'uncertain', source: 'llm' },
        expectedReasonCode: 'FINAL_DECISION_NOT_APPLY',
      },
      {
        name: 'malformed',
        finalDecision: null,
        expectedReasonCode: 'FINAL_DECISION_MALFORMED',
      },
      {
        name: 'incomplete llm judgment',
        finalDecision: { decision: 'apply', source: 'llm' },
        llmEvaluation: { decision: 'apply', resume_fit: '', intent_fit: '', recall_context: '' },
        expectedReasonCode: 'LLM_DECISION_INCOMPLETE',
      },
      {
        name: 'rule granted',
        finalDecision: { decision: 'apply', source: 'rules' },
        expectedReasonCode: 'AUTHORIZATION_NOT_GRANTED_BY_LLM',
      },
      {
        name: 'rule denied',
        finalDecision: { decision: 'apply', source: 'llm' },
        ruleEvaluation: { ...sensitiveRuleEvaluation(), hardReject: true },
        expectedReasonCode: 'RULE_BOUNDARY_DENIED',
      },
      {
        name: 'rule skip',
        finalDecision: { decision: 'apply', source: 'llm' },
        ruleEvaluation: { ...sensitiveRuleEvaluation(), decision: 'skip' },
        expectedReasonCode: 'RULE_BOUNDARY_DENIED',
      },
      {
        name: 'missing job anchor',
        job: { ...sensitiveJob(), jobId: '' },
        finalDecision: llmApplyDecision(),
        expectedReasonCode: 'JOB_IDENTITY_ANCHOR_MISSING',
      },
    ]

    for (const item of cases) {
      const result = issueAuthorizationToken({
        runId: `run-${item.name}`,
        job: item.job ?? sensitiveJob(),
        finalDecision: item.finalDecision,
        ruleEvaluation: item.ruleEvaluation ?? sensitiveRuleEvaluation(),
        llmEvaluation: item.llmEvaluation ?? sensitiveLlmEvaluation(),
        allowedActions: ['start_chat'],
        ttlMs: 60000,
        now: new Date('2026-07-07T10:00:00.000Z'),
        tokenFile,
      })

      assert.equal(result.issued, false, item.name)
      assert.equal(result.reasonCode, item.expectedReasonCode, item.name)
    }

    assert.deepEqual(readAuthorizationTokenStore({ tokenFile }).tokens, [])
  })
})

test('reports stable token validity, expiry, consumption, and unusable reason codes', () => {
  withTempTokenFile(({ tokenFile }) => {
    const issued = issueAuthorizationToken({
      runId: 'run-token-state-1',
      job: sensitiveJob(),
      finalDecision: llmApplyDecision(),
      ruleEvaluation: sensitiveRuleEvaluation(),
      llmEvaluation: sensitiveLlmEvaluation(),
      allowedActions: ['start_chat'],
      ttlMs: 1000,
      now: new Date('2026-07-07T10:00:00.000Z'),
      tokenFile,
    })
    const tokenId = issued.token.tokenId

    assert.deepEqual(
      pickStatus(inspectAuthorizationToken({ tokenId, tokenFile, now: new Date('2026-07-07T10:00:00.500Z'), action: 'start_chat' })),
      { status: 'valid', reasonCode: 'TOKEN_VALID' }
    )
    assert.deepEqual(
      pickStatus(inspectAuthorizationToken({ tokenId, tokenFile, now: new Date('2026-07-07T10:00:00.500Z'), action: 'send_greeting' })),
      { status: 'unusable', reasonCode: 'ACTION_NOT_ALLOWED' }
    )
    assert.deepEqual(
      pickStatus(inspectAuthorizationToken({ tokenId, tokenFile, now: new Date('2026-07-07T10:00:01.001Z'), action: 'start_chat' })),
      { status: 'expired', reasonCode: 'TOKEN_EXPIRED' }
    )
    assert.deepEqual(
      pickStatus(inspectAuthorizationToken({ tokenId: 'missing-token', tokenFile, now: new Date('2026-07-07T10:00:00.500Z') })),
      { status: 'unusable', reasonCode: 'TOKEN_NOT_FOUND' }
    )

    const consumed = consumeAuthorizationToken({
      tokenId,
      tokenFile,
      now: new Date('2026-07-07T10:00:00.800Z'),
      action: 'start_chat',
    })
    assert.equal(consumed.consumed, true)

    assert.deepEqual(
      pickStatus(inspectAuthorizationToken({ tokenId, tokenFile, now: new Date('2026-07-07T10:00:00.900Z'), action: 'start_chat' })),
      { status: 'consumed', reasonCode: 'TOKEN_CONSUMED' }
    )
  })
})

test('CLI can issue and inspect authorization tokens as JSON', async () => {
  await withTempTokenFile(async ({ tempDir, tokenFile }) => {
    const jobFile = path.join(tempDir, 'job.json')
    const finalDecisionFile = path.join(tempDir, 'final-decision.json')
    const ruleEvaluationFile = path.join(tempDir, 'rule-evaluation.json')
    const llmEvaluationFile = path.join(tempDir, 'llm-evaluation.json')
    fs.writeFileSync(jobFile, JSON.stringify(sensitiveJob()))
    fs.writeFileSync(finalDecisionFile, JSON.stringify(llmApplyDecision()))
    fs.writeFileSync(ruleEvaluationFile, JSON.stringify(sensitiveRuleEvaluation()))
    fs.writeFileSync(llmEvaluationFile, JSON.stringify(sensitiveLlmEvaluation()))

    const issueOutput = JSON.parse((await runGgr([
      'authorization-token',
      'issue',
      '--token-file',
      tokenFile,
      '--run-id',
      'run-cli-token-1',
      '--job',
      jobFile,
      '--final-decision',
      finalDecisionFile,
      '--evaluation',
      ruleEvaluationFile,
      '--llm-evaluation',
      llmEvaluationFile,
      '--allowed-action',
      'start_chat',
      '--ttl-ms',
      '60000',
      '--now',
      '2026-07-07T10:00:00.000Z',
    ])).stdout)

    assert.equal(issueOutput.ok, true)
    assert.equal(issueOutput.issued, true)
    assert.equal(issueOutput.token.runId, 'run-cli-token-1')
    assert.equal(issueOutput.token.jobId, 'boss-job-123')

    const inspectOutput = JSON.parse((await runGgr([
      'authorization-token',
      'inspect',
      '--token-file',
      tokenFile,
      '--token-id',
      issueOutput.token.tokenId,
      '--action',
      'start_chat',
      '--now',
      '2026-07-07T10:00:30.000Z',
    ])).stdout)

    assert.equal(inspectOutput.ok, true)
    assert.equal(inspectOutput.status, 'valid')
    assert.equal(inspectOutput.reasonCode, 'TOKEN_VALID')
    assert.equal(JSON.stringify(inspectOutput).includes(sensitiveJob().jd), false)
  })
})

function pickStatus (result) {
  return {
    status: result.status,
    reasonCode: result.reasonCode,
  }
}

async function runGgr (args) {
  return await execFileAsync(process.execPath, [
    path.resolve('bin', 'ggr.mjs'),
    ...args,
  ])
}

function withTempTokenFile (callback) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ggr-authorization-token-'))
  const tokenFile = path.join(tempDir, 'tokens.json')
  const cleanup = () => fs.rmSync(tempDir, { recursive: true, force: true })
  try {
    const result = callback({ tempDir, tokenFile })
    if (result && typeof result.then === 'function') {
      return result.finally(cleanup)
    }
    cleanup()
    return result
  } catch (err) {
    cleanup()
    throw err
  }
}

function sensitiveJob () {
  return {
    jobId: 'boss-job-123',
    title: 'Python AI 后端开发',
    company: 'Example Co',
    city: '上海',
    salary: '20-30K',
    experience: '1-3年',
    degree: '本科',
    labels: ['FastAPI', 'LLM'],
    jd: [
      '负责 FastAPI 服务开发、LLM 工具接入和自动化工作流建设。',
      '候选人需要具备 API 设计、数据处理和部署经验。',
      'RAW_JD_TAIL_SHOULD_NOT_PERSIST',
    ].join('\n'),
    recallKeyword: 'Python 后端',
    bossName: 'Alice',
    bossTitle: '招聘经理',
    raw: {
      cookies: 'COOKIE_CANARY_SHOULD_NOT_PERSIST',
      localStorage: 'LOCAL_STORAGE_CANARY_SHOULD_NOT_PERSIST',
    },
  }
}

function llmApplyDecision () {
  return {
    decision: 'apply',
    source: 'llm',
    reason: 'llm decision applied after candidate profile and rule boundary check',
  }
}

function sensitiveRuleEvaluation () {
  return {
    decision: 'uncertain',
    score: 64,
    hardReject: false,
    requiresLlmFinalDecision: true,
    reasons: [
      'candidate profile fit requires LLM confirmation',
      'C:\\Users\\Private\\resume.png',
    ],
    greetingMessage: 'FULL_GREETING_CANARY_SHOULD_NOT_PERSIST',
    resumeImagePath: 'C:\\Users\\Private\\resume.png',
    greetingPlan: {
      source: 'preset',
      safeSummary: 'Preset greeting selected from AI Agent Template; 40 characters.',
      characterCount: 40,
      fallbackReason: null,
    },
  }
}

function sensitiveLlmEvaluation () {
  return {
    decision: 'apply',
    score: 86,
    category: 'python_backend',
    reason: 'JD matches Python backend and AI workflow project evidence.',
    jd_match_summary: 'FastAPI service development and LLM tool integration are central responsibilities.',
    resume_fit: 'Resume project evidence includes FastAPI automation and LLM tool orchestration.',
    intent_fit: 'Expected job direction matches Python backend and AI Agent internship roles.',
    recall_context: 'The job was reviewed from a Python backend recall context.',
    matched_requirements: ['FastAPI', 'LLM tools', 'automation workflow'],
    missing_requirements: [],
    risk_flags: ['API_KEY_CANARY_SHOULD_NOT_PERSIST'],
    attention_technology_assessment: {
      explanation: 'No Attention Technology mismatch.',
      is_core_required: null,
      evidence: [
        {
          segment: '负责 FastAPI 服务开发、LLM 工具接入和自动化工作流建设。'.repeat(10),
        },
      ],
    },
  }
}

function forbiddenCanaries () {
  return [
    'RAW_JD_TAIL_SHOULD_NOT_PERSIST',
    'FULL_GREETING_CANARY_SHOULD_NOT_PERSIST',
    'C:\\Users\\Private\\resume.png',
    'COOKIE_CANARY_SHOULD_NOT_PERSIST',
    'LOCAL_STORAGE_CANARY_SHOULD_NOT_PERSIST',
    'API_KEY_CANARY_SHOULD_NOT_PERSIST',
  ]
}
