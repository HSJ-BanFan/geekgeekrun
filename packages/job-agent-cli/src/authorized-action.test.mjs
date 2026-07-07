import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { test } from 'node:test'

import {
  consumeAuthorizationToken,
  issueAuthorizationToken,
  readAuthorizationTokenStore,
} from './authorization-token.mjs'
import {
  runAuthorizedActionIntent,
  runAuthorizedActionIntentOnOpenPage,
} from './authorized-action.mjs'

const execFileAsync = promisify(execFile)

test('confirmed start_chat with a valid token verifies the job, clicks once, consumes the token, and audits redacted evidence', async () => {
  await withTempTokenFiles(async ({ tokenFile, auditFile }) => {
    const issued = issueTestToken({ tokenFile, allowedActions: ['start_chat'] })
    let clickCount = 0
    const page = createStartChatPageFake({
      currentProfile: {
        jobId: 'boss-job-123',
        title: 'Python AI 后端开发',
        company: 'Example Co',
        jd: `${longJd()} RAW_JD_TAIL_SHOULD_NOT_PERSIST`,
      },
      canStart: true,
      onStartChatClick: () => {
        clickCount += 1
      },
    })

    const output = await runAuthorizedActionIntentOnOpenPage(page, {
      action: 'start_chat',
      tokenId: issued.token.tokenId,
      tokenFile,
      auditFile,
      confirm: true,
      now: new Date('2026-07-07T10:00:30.000Z'),
    })

    assert.equal(output.ok, true)
    assert.equal(output.reasonCode, 'ACTION_EXECUTED')
    assert.equal(output.actionResult.success, true)
    assert.equal(output.actionResult.jobMatch.match, true)
    assert.equal(clickCount, 1)

    const store = readAuthorizationTokenStore({ tokenFile })
    assert.equal(store.tokens[0].consumption.state, 'consumed')
    assert.equal(store.tokens[0].consumption.consumedByAction, 'start_chat')

    const auditText = fs.readFileSync(auditFile, 'utf8')
    assert.equal(auditText.includes(issued.token.tokenId), false)
    for (const forbidden of forbiddenCanaries()) {
      assert.equal(auditText.includes(forbidden), false, `audit leaked ${forbidden}`)
    }
  })
})

test('confirmed start_chat rejects missing, expired, consumed, and unauthorized-action tokens before touching the browser', async () => {
  await withTempTokenFiles(async ({ tokenFile, auditFile }) => {
    const expired = issueTestToken({
      tokenFile,
      runId: 'run-expired-token',
      allowedActions: ['start_chat'],
      expiresAt: '2026-07-07T10:00:00.000Z',
    })
    const consumed = issueTestToken({
      tokenFile,
      runId: 'run-consumed-token',
      allowedActions: ['start_chat'],
    })
    consumeAuthorizationToken({
      tokenId: consumed.token.tokenId,
      tokenFile,
      now: new Date('2026-07-07T10:00:10.000Z'),
      action: 'start_chat',
    })
    const actionMismatch = issueTestToken({
      tokenFile,
      runId: 'run-action-mismatch-token',
      allowedActions: ['send_greeting'],
    })

    const cases = [
      {
        name: 'missing',
        tokenId: '',
        expectedReasonCode: 'AUTHORIZATION_TOKEN_REQUIRED',
      },
      {
        name: 'expired',
        tokenId: expired.token.tokenId,
        expectedReasonCode: 'TOKEN_EXPIRED',
      },
      {
        name: 'consumed',
        tokenId: consumed.token.tokenId,
        expectedReasonCode: 'TOKEN_CONSUMED',
      },
      {
        name: 'action mismatch',
        tokenId: actionMismatch.token.tokenId,
        expectedReasonCode: 'ACTION_NOT_ALLOWED',
      },
    ]

    for (const item of cases) {
      let touchedBrowser = false
      const output = await runAuthorizedActionIntent({
        action: 'start_chat',
        tokenId: item.tokenId,
        tokenFile,
        auditFile,
        confirm: true,
        now: new Date('2026-07-07T10:00:30.000Z'),
        executeAction: async () => {
          touchedBrowser = true
          return { result: { success: true } }
        },
      })

      assert.equal(output.ok, false, item.name)
      assert.equal(output.reasonCode, item.expectedReasonCode, item.name)
      assert.equal(touchedBrowser, false, item.name)
    }
  })
})

test('confirmed start_chat rejects a token whose Job Identity Anchor does not match the current browser target', async () => {
  await withTempTokenFiles(async ({ tokenFile, auditFile }) => {
    const issued = issueTestToken({ tokenFile, allowedActions: ['start_chat'] })
    let clickCount = 0
    const page = createStartChatPageFake({
      currentProfile: {
        jobId: 'different-job',
        title: '其他岗位',
        company: 'Example Co',
      },
      canStart: true,
      onStartChatClick: () => {
        clickCount += 1
      },
    })

    const output = await runAuthorizedActionIntentOnOpenPage(page, {
      action: 'start_chat',
      tokenId: issued.token.tokenId,
      tokenFile,
      auditFile,
      confirm: true,
      now: new Date('2026-07-07T10:00:30.000Z'),
    })

    assert.equal(output.ok, false)
    assert.equal(output.reasonCode, 'JOB_MISMATCH')
    assert.equal(output.actionResult.clicked, false)
    assert.equal(clickCount, 0)

    const store = readAuthorizationTokenStore({ tokenFile })
    assert.equal(store.tokens[0].consumption.state, 'unconsumed')
  })
})

test('confirmed start_chat reports a failed token state update when consumption races after execution', async () => {
  await withTempTokenFiles(async ({ tokenFile, auditFile }) => {
    const issued = issueTestToken({ tokenFile, allowedActions: ['start_chat'] })

    const output = await runAuthorizedActionIntent({
      action: 'start_chat',
      tokenId: issued.token.tokenId,
      tokenFile,
      auditFile,
      confirm: true,
      now: new Date('2026-07-07T10:00:30.000Z'),
      executeAction: async () => {
        consumeAuthorizationToken({
          tokenId: issued.token.tokenId,
          tokenFile,
          now: new Date('2026-07-07T10:00:25.000Z'),
          action: 'start_chat',
        })
        return {
          result: {
            dryRun: false,
            clicked: true,
            success: true,
            jobMatch: { match: true, comparedBy: 'jobId' },
          },
        }
      },
    })

    assert.equal(output.ok, false)
    assert.equal(output.reasonCode, 'TOKEN_CONSUMPTION_FAILED')
    assert.equal(output.consumption.consumed, false)
  })
})

test('CLI dry-run validates the token and reports planned start_chat without consuming it or opening the browser', async () => {
  await withTempTokenFiles(async ({ tokenFile, auditFile }) => {
    const issued = issueTestToken({ tokenFile, allowedActions: ['start_chat'] })

    const output = JSON.parse((await runGgr([
      'authorized-action',
      '--action',
      'start_chat',
      '--token-id',
      issued.token.tokenId,
      '--token-file',
      tokenFile,
      '--audit-file',
      auditFile,
      '--now',
      '2026-07-07T10:00:30.000Z',
    ])).stdout)

    assert.equal(output.ok, true)
    assert.equal(output.dryRun, true)
    assert.equal(output.reasonCode, 'DRY_RUN')
    assert.equal(output.plannedAction.type, 'start_chat')
    assert.equal(output.validation.browserTarget.planned, true)

    const store = readAuthorizationTokenStore({ tokenFile })
    assert.equal(store.tokens[0].consumption.state, 'unconsumed')
  })
})

test('CLI confirmed start_chat rejects a missing authorization token with a stable reason code', async () => {
  await withTempTokenFiles(async ({ tokenFile, auditFile }) => {
    let error = null
    try {
      await runGgr([
        'authorized-action',
        '--action',
        'start_chat',
        '--confirm',
        '--token-file',
        tokenFile,
        '--audit-file',
        auditFile,
        '--now',
        '2026-07-07T10:00:30.000Z',
      ])
    } catch (err) {
      error = err
    }

    assert.ok(error)
    const output = JSON.parse(error.stdout)
    assert.equal(output.ok, false)
    assert.equal(output.reasonCode, 'AUTHORIZATION_TOKEN_REQUIRED')
  })
})

async function runGgr (args) {
  return await execFileAsync(process.execPath, [
    path.resolve('bin', 'ggr.mjs'),
    ...args,
  ])
}

function withTempTokenFiles (callback) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ggr-authorized-action-'))
  const tokenFile = path.join(tempDir, 'tokens.json')
  const auditFile = path.join(tempDir, 'audit.jsonl')
  const cleanup = () => fs.rmSync(tempDir, { recursive: true, force: true })
  try {
    const result = callback({ tempDir, tokenFile, auditFile })
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

function issueTestToken ({
  tokenFile,
  runId = 'run-tokened-action-1',
  allowedActions,
  expiresAt,
} = {}) {
  return issueAuthorizationToken({
    runId,
    job: sensitiveJob(),
    finalDecision: {
      decision: 'apply',
      source: 'llm',
      reason: 'LLM authorized this job after complete evidence review.',
    },
    ruleEvaluation: sensitiveRuleEvaluation(),
    llmEvaluation: sensitiveLlmEvaluation(),
    allowedActions,
    expiresAt,
    ttlMs: 60000,
    now: new Date('2026-07-07T10:00:00.000Z'),
    tokenFile,
  })
}

function createStartChatPageFake ({
  currentProfile,
  canStart,
  onStartChatClick = () => {},
} = {}) {
  return {
    url () {
      return 'https://www.zhipin.com/web/geek/jobs'
    },
    async evaluate (fn, arg) {
      const source = String(fn)
      if (source.includes('startChatAction')) {
        return { called: false }
      }
      if (arg === '.job-detail-box .op-btn.op-btn-chat') {
        return {
          found: true,
          text: canStart ? '立即沟通' : '已沟通',
          disabled: !canStart,
          authRequired: false,
          securityCheckRequired: false,
          canStart,
          rect: { x: 0, y: 0, width: 100, height: 32 },
        }
      }
      if (source.includes('.page-jobs-main') && source.includes('.job-detail-box')) {
        return {
          url: this.url(),
          pageQuery: '',
          selectedJobData: currentProfile,
          targetJobData: {
            jobInfo: currentProfile,
          },
          visibleText: currentProfile?.jd ?? '',
        }
      }
      return null
    },
    async $ (selector) {
      if (selector !== '.job-detail-box .op-btn.op-btn-chat') return null
      return {
        async evaluate () {},
        async boundingBox () {
          return null
        },
        async click () {
          onStartChatClick()
        },
      }
    },
    async waitForResponse () {
      return {
        async json () {
          return { code: 0 }
        },
      }
    },
    async waitForSelector () {
      return {}
    },
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
    jd: `${longJd()} RAW_JD_TAIL_SHOULD_NOT_PERSIST`,
    recallKeyword: 'Python 后端',
    bossName: 'Alice',
    bossTitle: '招聘经理',
    raw: {
      cookies: 'COOKIE_CANARY_SHOULD_NOT_PERSIST',
      localStorage: 'LOCAL_STORAGE_CANARY_SHOULD_NOT_PERSIST',
    },
  }
}

function sensitiveRuleEvaluation () {
  return {
    decision: 'uncertain',
    score: 64,
    hardReject: false,
    requiresLlmFinalDecision: true,
    reasons: ['candidate profile fit requires LLM confirmation'],
    greetingMessage: 'FULL_GREETING_CANARY_SHOULD_NOT_PERSIST',
    resumeImagePath: 'C:\\Users\\Private\\resume.png',
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
      evidence: [{ segment: '负责 FastAPI 服务开发、LLM 工具接入和自动化工作流建设。' }],
    },
  }
}

function longJd () {
  return [
    '负责 FastAPI 服务开发、LLM 工具接入和自动化工作流建设。',
    '候选人需要具备 API 设计、数据处理和部署经验。',
    'Nice to have: agent orchestration experience.',
    'Filler text that represents the omitted raw job description tail.'.repeat(20),
  ].join('\n')
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
