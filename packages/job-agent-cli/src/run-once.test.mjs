import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { test } from 'node:test'

import { buildCandidateProfile } from './candidate-profile.mjs'
import { buildOrRefreshCapabilityProfile } from './capability-profile.mjs'

const execFileAsync = promisify(execFile)

test('run-once generates a personalized Greeting Plan only after final apply', async () => {
  await withTempRuntime(async ({ tempHome, storageDir, bossConfig, resume, canaries }) => {
    const candidateProfile = buildCandidateProfile(bossConfig, { resume })
    const cacheResult = await buildOrRefreshCapabilityProfile({
      bossConfig,
      candidateProfile,
      llmConfig: enabledFakeLlmConfig(),
      storageDir,
      generateProfile: async () => safeGeneratedProfile(),
    })
    assert.equal(cacheResult.ok, true)

    const requests = []
    const server = await startFakeChatCompletionsServer({
      requests,
      evaluationContent: JSON.stringify(completeLlmEvaluation({ decision: 'apply' })),
      greetingMessage: safePersonalizedGreeting(),
    })

    try {
      writeRuntimeConfig(tempHome, bossConfig, llmConfigForServer(server), resume)
      const auditFile = path.join(storageDir, 'run-once-apply-audit.jsonl')
      const { stdout } = await runGgr(tempHome, [
        'run-once',
        '--llm',
        '--audit-file',
        auditFile,
        '--title',
        targetJob().title,
        '--jd',
        targetJob().jd,
        '--recall-keyword',
        'Python 后端',
      ])
      const output = JSON.parse(stdout)
      const auditText = fs.readFileSync(auditFile, 'utf8')

      assert.equal(output.ok, true)
      assert.equal(output.finalDecision.decision, 'apply')
      assert.equal(output.ruleEvaluation.greetingPlan.source, 'personalized')
      assert.equal(output.ruleEvaluation.greetingPlan.fallbackReason, null)
      assert.equal(output.ruleEvaluation.greetingPlan.guardResult.passed, true)
      assert.equal(output.ruleEvaluation.greetingPlan.safeSummary, output.ruleEvaluation.greetingPlan.summary)
      assert.equal(output.ruleEvaluation.greetingPlan.characterCount, Array.from(safePersonalizedGreeting()).length)
      assert.equal(output.actions[0].type, 'send_greeting')
      assert.equal(output.actions[0].result.dryRun, true)
      assert.equal(output.actions[0].result.wouldSendMessage, true)
      assert.deepEqual(requests.map(request => request.kind), ['evaluation', 'greeting'])

      const greetingRequestText = JSON.stringify(requests.find(request => request.kind === 'greeting'))
      assert.equal(greetingRequestText.includes(canaries.resume), false)
      assert.equal(greetingRequestText.includes(canaries.email), false)
      assert.equal(greetingRequestText.includes('resumeMarkdown'), false)
      assert.equal(stdout.includes(safePersonalizedGreeting()), false)
      assert.equal(auditText.includes(safePersonalizedGreeting()), false)
    } finally {
      await server.close()
    }
  })
})

test('run-once does not generate personalized greetings for non-apply final decisions', async () => {
  await withTempRuntime(async ({ tempHome, storageDir, bossConfig, resume }) => {
    const candidateProfile = buildCandidateProfile(bossConfig, { resume })
    const cacheResult = await buildOrRefreshCapabilityProfile({
      bossConfig,
      candidateProfile,
      llmConfig: enabledFakeLlmConfig(),
      storageDir,
      generateProfile: async () => safeGeneratedProfile(),
    })
    assert.equal(cacheResult.ok, true)

    writeRuntimeConfig(tempHome, bossConfig, enabledFakeLlmConfig(), resume)
    const missingLlmOutput = JSON.parse((await runGgr(tempHome, [
      'run-once',
      '--audit-file',
      path.join(storageDir, 'run-once-missing-llm-audit.jsonl'),
      '--title',
      targetJob().title,
      '--jd',
      targetJob().jd,
    ])).stdout)

    assert.equal(missingLlmOutput.finalDecision.decision, 'uncertain')
    assert.equal(missingLlmOutput.ruleEvaluation.greetingPlan.source, 'preset')
    assert.equal(missingLlmOutput.actions[0].type, 'skip_apply')

    const cases = [
      {
        name: 'llm skip',
        title: targetJob().title,
        jd: targetJob().jd,
        evaluationContent: JSON.stringify(completeLlmEvaluation({ decision: 'skip' })),
        expectedDecision: 'skip',
      },
      {
        name: 'hard reject',
        title: '信息录入专员',
        jd: '负责信息录入和资料整理。',
        evaluationContent: JSON.stringify(completeLlmEvaluation({ decision: 'apply' })),
        expectedDecision: 'skip',
      },
      {
        name: 'malformed llm judgment',
        title: targetJob().title,
        jd: targetJob().jd,
        evaluationContent: 'not json',
        expectedDecision: 'uncertain',
      },
    ]

    for (const item of cases) {
      const requests = []
      const server = await startFakeChatCompletionsServer({
        requests,
        evaluationContent: item.evaluationContent,
        greetingMessage: safePersonalizedGreeting(),
      })

      try {
        writeRuntimeConfig(tempHome, bossConfig, llmConfigForServer(server), resume)
        const { stdout } = await runGgr(tempHome, [
          'run-once',
          '--llm',
          '--audit-file',
          path.join(storageDir, `run-once-${item.name.replace(/\W+/g, '-')}-audit.jsonl`),
          '--title',
          item.title,
          '--jd',
          item.jd,
        ])
        const output = JSON.parse(stdout)

        assert.equal(output.finalDecision.decision, item.expectedDecision)
        assert.equal(output.ruleEvaluation.greetingPlan.source, 'preset')
        assert.equal(output.actions[0].type, 'skip_apply')
        assert.deepEqual(requests.map(request => request.kind), ['evaluation'])
      } finally {
        await server.close()
      }
    }
  })
})

test('run-once falls back to the preset greeting when personalization is unavailable or unsafe', async () => {
  await withTempRuntime(async ({ tempHome, storageDir, bossConfig, resume }) => {
    {
      const requests = []
      const server = await startFakeChatCompletionsServer({
        requests,
        evaluationContent: JSON.stringify(completeLlmEvaluation({ decision: 'apply' })),
        greetingMessage: safePersonalizedGreeting(),
      })

      try {
        writeRuntimeConfig(tempHome, bossConfig, llmConfigForServer(server), resume)
        const { stdout } = await runGgr(tempHome, [
          'run-once',
          '--llm',
          '--audit-file',
          path.join(storageDir, 'run-once-cache-missing-audit.jsonl'),
          '--title',
          targetJob().title,
          '--jd',
          targetJob().jd,
        ])
        const output = JSON.parse(stdout)

        assert.equal(output.finalDecision.decision, 'apply')
        assert.equal(output.ruleEvaluation.greetingPlan.source, 'preset')
        assert.equal(output.ruleEvaluation.greetingPlan.fallbackReason, 'cache_missing')
        assert.equal(output.actions[0].type, 'send_greeting')
        assert.equal(output.actions[0].result.wouldSendMessage, true)
        assert.deepEqual(requests.map(request => request.kind), ['evaluation'])
      } finally {
        await server.close()
      }
    }

    const candidateProfile = buildCandidateProfile(bossConfig, { resume })
    const cacheResult = await buildOrRefreshCapabilityProfile({
      bossConfig,
      candidateProfile,
      llmConfig: enabledFakeLlmConfig(),
      storageDir,
      generateProfile: async () => safeGeneratedProfile(),
    })
    assert.equal(cacheResult.ok, true)

    const requests = []
    const server = await startFakeChatCompletionsServer({
      requests,
      evaluationContent: JSON.stringify(completeLlmEvaluation({ decision: 'apply' })),
      greetingMessage: '您好，我有3年后端经验，可随时到岗，期望薪资 30K。',
    })

    try {
      writeRuntimeConfig(tempHome, bossConfig, llmConfigForServer(server), resume)
      const { stdout } = await runGgr(tempHome, [
        'run-once',
        '--llm',
        '--audit-file',
        path.join(storageDir, 'run-once-guard-rejected-audit.jsonl'),
        '--title',
        targetJob().title,
        '--jd',
        targetJob().jd,
      ])
      const output = JSON.parse(stdout)

      assert.equal(output.finalDecision.decision, 'apply')
      assert.equal(output.ruleEvaluation.greetingPlan.source, 'preset')
      assert.equal(output.ruleEvaluation.greetingPlan.fallbackReason, 'guard_rejected')
      assert.equal(output.ruleEvaluation.greetingPlan.personalization.guardResult.passed, false)
      assert.equal(output.actions[0].type, 'send_greeting')
      assert.equal(output.actions[0].result.wouldSendMessage, true)
      assert.deepEqual(requests.map(request => request.kind), ['evaluation', 'greeting'])
    } finally {
      await server.close()
    }
  })
})

test('run-once skips text when no safe greeting exists while preserving image upload planning', async () => {
  await withTempRuntime(async ({ tempHome, storageDir, bossConfig, resume }) => {
    const imagePath = path.join(storageDir, 'private-resume.png')
    const noTextBossConfig = {
      ...bossConfig,
      autoStartChatGreetingMessage: '',
      autoStartChatGreetingMessageRules: [],
      autoStartChatGreetingImageEnabled: true,
      autoStartChatGreetingImagePath: imagePath,
    }
    const requests = []
    const server = await startFakeChatCompletionsServer({
      requests,
      evaluationContent: JSON.stringify(completeLlmEvaluation({ decision: 'apply' })),
      greetingMessage: safePersonalizedGreeting(),
    })

    try {
      writeRuntimeConfig(tempHome, noTextBossConfig, llmConfigForServer(server), resume)
      const auditFile = path.join(storageDir, 'run-once-no-safe-text-audit.jsonl')
      const { stdout } = await runGgr(tempHome, [
        'run-once',
        '--llm',
        '--audit-file',
        auditFile,
        '--title',
        targetJob().title,
        '--jd',
        targetJob().jd,
      ])
      const output = JSON.parse(stdout)
      const auditText = fs.readFileSync(auditFile, 'utf8')

      assert.equal(output.finalDecision.decision, 'apply')
      assert.equal(output.ruleEvaluation.greetingPlan.source, 'preset')
      assert.equal(output.ruleEvaluation.greetingPlan.fallbackReason, 'cache_missing')
      assert.equal(output.ruleEvaluation.greetingPlan.safetyStatus.deliveryTextAvailable, false)
      assert.equal(output.actions[0].type, 'send_greeting')
      assert.equal(output.actions[0].result.wouldSendMessage, false)
      assert.equal(output.actions[0].result.textResult.skipped, true)
      assert.equal(output.actions[0].result.textResult.reason, 'NO_SAFE_GREETING_TEXT')
      assert.equal(output.actions[0].result.wouldUploadImage, true)
      assert.equal(auditText.includes(imagePath), false)
      assert.deepEqual(requests.map(request => request.kind), ['evaluation'])
    } finally {
      await server.close()
    }
  })
})

async function runGgr (tempHome, args) {
  return await execFileAsync(process.execPath, [
    path.resolve('bin', 'ggr.mjs'),
    ...args,
  ], {
    env: {
      ...process.env,
      HOME: tempHome,
      USERPROFILE: tempHome,
    },
  })
}

async function withTempRuntime (callback) {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ggr-run-once-'))
  const storageDir = path.join(tempHome, '.geekgeekrun', 'storage')
  const canaries = {
    resume: 'PRIVATE_RESUME_CANARY_RUN_ONCE',
    email: 'run-once-person@example.com',
    greeting: 'FULL_PRESET_GREETING_CANARY_RUN_ONCE',
  }
  const bossConfig = {
    expectJobNameRegExpStr: 'Python|AI|后端',
    expectJobTypeRegExpStr: '开发|实习',
    expectJobDescRegExpStr: 'FastAPI|LLM|自动化',
    autoStartChatGreetingMessage: `您好，想了解这个岗位。${canaries.greeting}`,
    autoStartChatGreetingImageEnabled: false,
    autoStartChatGreetingMessageRules: [
      { name: 'AI Agent', pattern: 'AI|LLM|Agent|FastAPI', message: `您好，想沟通岗位。${canaries.greeting}` },
    ],
  }
  const resume = {
    content: {
      expectJob: 'Python 后端 / AI Agent 实习',
      workYearDesc: '应届生',
      userDescription: [
        `我做过 FastAPI 自动化项目。${canaries.resume}`,
        `联系邮箱 ${canaries.email}`,
      ].join('\n'),
      geekProjExpList: [
        {
          name: 'Agent Demo',
          roleName: 'Developer',
          projectDescription: 'Implemented a FastAPI service and LLM tool orchestration demo.',
          performance: 'Delivered a working prototype for review.',
        },
      ],
    },
  }

  try {
    fs.mkdirSync(storageDir, { recursive: true })
    return await callback({ tempHome, storageDir, bossConfig, resume, canaries })
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true })
  }
}

function writeRuntimeConfig (tempHome, bossConfig, llmConfig, resume) {
  const configDir = path.join(tempHome, '.geekgeekrun', 'config')
  fs.mkdirSync(configDir, { recursive: true })
  fs.writeFileSync(path.join(configDir, 'boss.json'), JSON.stringify(bossConfig))
  fs.writeFileSync(path.join(configDir, 'llm.json'), JSON.stringify(llmConfig))
  fs.writeFileSync(path.join(configDir, 'resumes.json'), JSON.stringify([resume]))
}

async function startFakeChatCompletionsServer ({ requests, evaluationContent, greetingMessage }) {
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      const payload = JSON.parse(body)
      const kind = classifyLlmRequest(payload)
      requests.push({ kind, payload })

      const content = kind === 'greeting'
        ? JSON.stringify({ message: greetingMessage })
        : evaluationContent

      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        id: 'chatcmpl-test',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'test-model',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content,
            },
            finish_reason: 'stop',
          },
        ],
      }))
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return {
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    close: () => new Promise((resolve, reject) => {
      server.close(err => err ? reject(err) : resolve())
    }),
  }
}

function classifyLlmRequest (payload) {
  const systemPrompt = String(payload?.messages?.[0]?.content ?? '')
  if (systemPrompt.includes('You evaluate whether the candidate should apply to a job')) return 'evaluation'
  if (systemPrompt.includes('Generate one short Chinese Personalized Greeting')) return 'greeting'
  return 'unknown'
}

function llmConfigForServer (server) {
  return [
    {
      enabled: true,
      providerCompleteApiUrl: server.baseURL,
      providerApiSecret: 'test-secret',
      model: 'test-model',
    },
  ]
}

function enabledFakeLlmConfig () {
  return [
    {
      enabled: true,
      providerCompleteApiUrl: 'https://llm.example.test/v1',
      providerApiSecret: 'test-secret',
      model: 'test-model',
    },
  ]
}

function completeLlmEvaluation (overrides = {}) {
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
    risk_flags: [],
    attention_technology_assessment: {
      core_required_attention_technologies: [],
      candidate_profile_overlap: 'No Attention Technology mismatch.',
      mismatched_core_required_attention_technologies: [],
      mentioned_but_not_required_attention_technologies: [],
      terms: [],
      is_core_required: null,
      evidence: [],
      explanation: 'No Attention Technology seed terms require extra explanation.',
    },
    ...overrides,
  }
}

function safeGeneratedProfile () {
  return {
    demonstratedAbilities: [
      {
        ability: 'Python backend automation',
        evidenceSummary: 'Built FastAPI services and workflow automation projects.',
      },
    ],
    supportingEvidenceSummaries: [
      'Project evidence shows API development and data-processing automation.',
    ],
    targetRoleDirection: 'Python backend and AI agent roles',
    transferableStrengths: ['Workflow automation', 'API integration'],
    gaps: ['No durable evidence for Java enterprise ownership'],
    framingBoundaries: ['Do not claim senior tenure, certifications, guaranteed availability, or salary expectations'],
  }
}

function safePersonalizedGreeting () {
  return '您好，我关注到岗位需要 FastAPI、LLM 工具和自动化交付。我有 Python 后端与工作流自动化项目经验，能基于既有项目证据参与接口开发和工具集成，想进一步沟通岗位匹配。'
}

function targetJob () {
  return {
    title: 'Python AI 后端开发',
    jd: '负责 FastAPI 服务开发、LLM 工具接入和自动化工作流建设。',
  }
}
