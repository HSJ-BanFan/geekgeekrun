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
import { buildGuardedPersonalizedGreetingPlan, guardPersonalizedGreeting } from './greeting-plan.mjs'

const execFileAsync = promisify(execFile)

test('evaluate-job CLI exposes safe preset Greeting Plan metadata', async () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ggr-greeting-plan-cli-'))
  const originalHome = process.env.HOME
  const originalUserProfile = process.env.USERPROFILE
  const greetingMessage = '您好，我想了解这个 Python 岗位。FULL_GREETING_CANARY_0003 C:\\Users\\Private\\resume.png'

  try {
    process.env.HOME = tempHome
    process.env.USERPROFILE = tempHome
    const configDir = path.join(tempHome, '.geekgeekrun', 'config')
    fs.mkdirSync(configDir, { recursive: true })
    fs.writeFileSync(path.join(configDir, 'boss.json'), JSON.stringify({
      autoStartChatGreetingMessage: '默认开场白',
      autoStartChatGreetingMessageRules: [
        { name: 'AI Agent Template', pattern: 'Python|FastAPI|LLM', message: greetingMessage },
      ],
    }))
    fs.writeFileSync(path.join(configDir, 'llm.json'), JSON.stringify([]))

    const ggrPath = path.resolve('bin', 'ggr.mjs')
    const { stdout } = await execFileAsync(process.execPath, [
      ggrPath,
      'evaluate-job',
      '--title',
      'Python 后端开发',
      '--jd',
      '负责 FastAPI 服务开发和 LLM 工具接入。',
    ], {
      env: {
        ...process.env,
        HOME: process.env.HOME,
        USERPROFILE: process.env.USERPROFILE,
      },
    })
    const output = JSON.parse(stdout)
    const planJson = JSON.stringify(output.ruleEvaluation.greetingPlan)

    assert.equal(output.ok, true)
    assert.equal(output.ruleEvaluation.greetingMessage, greetingMessage)
    assert.equal(output.ruleEvaluation.greetingPlan.source, 'preset')
    assert.equal(output.ruleEvaluation.greetingPlan.selectedTemplate.rule, 'AI Agent Template')
    assert.equal(output.ruleEvaluation.greetingPlan.characterCount, Array.from(greetingMessage).length)
    assert.equal(planJson.includes(greetingMessage), false)
    assert.equal(planJson.includes('FULL_GREETING_CANARY_0003'), false)
    assert.equal(planJson.includes('C:\\Users\\Private\\resume.png'), false)
  } finally {
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    if (originalUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = originalUserProfile
    fs.rmSync(tempHome, { recursive: true, force: true })
  }
})

test('buildGuardedPersonalizedGreetingPlan returns a safe personalized Greeting Plan from a fresh cache', async () => {
  await withTempRuntime(async ({ storageDir, bossConfig, resume, canaries }) => {
    const candidateProfile = buildCandidateProfile(bossConfig, { resume })
    const cacheResult = await buildOrRefreshCapabilityProfile({
      bossConfig,
      candidateProfile,
      llmConfig: enabledFakeLlmConfig(),
      storageDir,
      generateProfile: async () => safeGeneratedProfile(),
    })
    assert.equal(cacheResult.ok, true)

    let generationRequest = null
    const plan = await buildGuardedPersonalizedGreetingPlan({
      job: targetJob(),
      bossConfig,
      candidateProfile,
      llmConfig: enabledFakeLlmConfig(),
      storageDir,
      fallbackPlan: fallbackPresetPlan(),
      generateGreeting: async (request) => {
        generationRequest = request
        return { message: safePersonalizedGreeting() }
      },
    })

    assert.equal(plan.source, 'personalized')
    assert.equal(plan.fallbackReason, null)
    assert.equal(plan.guardResult.passed, true)
    assert.equal(plan.characterCount, Array.from(safePersonalizedGreeting()).length)
    assert.equal(JSON.stringify(plan).includes(safePersonalizedGreeting()), false)

    const requestText = JSON.stringify(generationRequest)
    assert.equal(requestText.includes('resumeMarkdown'), false)
    assert.equal(requestText.includes(canaries.resume), false)
    assert.equal(requestText.includes(canaries.email), false)
    assert.equal(generationRequest.capabilityProfileSummary.targetRoleDirection, 'Python backend and AI agent roles')
    assert.equal(generationRequest.job.title, targetJob().title)
  })
})

test('buildGuardedPersonalizedGreetingPlan falls back for missing or stale capability cache', async () => {
  await withTempRuntime(async ({ storageDir, bossConfig, resume }) => {
    const candidateProfile = buildCandidateProfile(bossConfig, { resume })
    let generationAttempted = false
    const missingPlan = await buildGuardedPersonalizedGreetingPlan({
      job: targetJob(),
      bossConfig,
      candidateProfile,
      llmConfig: enabledFakeLlmConfig(),
      storageDir,
      fallbackPlan: fallbackPresetPlan(),
      generateGreeting: async () => {
        generationAttempted = true
        return { message: safePersonalizedGreeting() }
      },
    })

    assert.equal(missingPlan.source, 'preset')
    assert.equal(missingPlan.fallbackReason, 'cache_missing')
    assert.equal(generationAttempted, false)

    const cacheResult = await buildOrRefreshCapabilityProfile({
      bossConfig,
      candidateProfile,
      llmConfig: enabledFakeLlmConfig(),
      storageDir,
      generateProfile: async () => safeGeneratedProfile(),
    })
    assert.equal(cacheResult.ok, true)

    const stalePlan = await buildGuardedPersonalizedGreetingPlan({
      job: targetJob(),
      bossConfig,
      candidateProfile: { ...candidateProfile, expectedJob: 'Java 后端' },
      llmConfig: enabledFakeLlmConfig(),
      storageDir,
      fallbackPlan: fallbackPresetPlan(),
      generateGreeting: async () => {
        generationAttempted = true
        return { message: safePersonalizedGreeting() }
      },
    })

    assert.equal(stalePlan.source, 'preset')
    assert.equal(stalePlan.fallbackReason, 'cache_stale')
  })
})

test('buildGuardedPersonalizedGreetingPlan falls back when LLM config is unavailable or output cannot be parsed', async () => {
  await withTempRuntime(async ({ storageDir, bossConfig, resume }) => {
    const candidateProfile = buildCandidateProfile(bossConfig, { resume })
    const cacheResult = await buildOrRefreshCapabilityProfile({
      bossConfig,
      candidateProfile,
      llmConfig: enabledFakeLlmConfig(),
      storageDir,
      generateProfile: async () => safeGeneratedProfile(),
    })
    assert.equal(cacheResult.ok, true)

    const unavailablePlan = await buildGuardedPersonalizedGreetingPlan({
      job: targetJob(),
      bossConfig,
      candidateProfile,
      llmConfig: [],
      storageDir,
      fallbackPlan: fallbackPresetPlan(),
      generateGreeting: async () => ({ message: safePersonalizedGreeting() }),
    })
    assert.equal(unavailablePlan.source, 'preset')
    assert.equal(unavailablePlan.fallbackReason, 'llm_unavailable')

    const parseFailurePlan = await buildGuardedPersonalizedGreetingPlan({
      job: targetJob(),
      bossConfig,
      candidateProfile,
      llmConfig: enabledFakeLlmConfig(),
      storageDir,
      fallbackPlan: fallbackPresetPlan(),
      generateGreeting: async () => ({
        ok: false,
        error: { code: 'PERSONALIZED_GREETING_PARSE_FAILED', message: 'Unexpected token' },
      }),
    })
    assert.equal(parseFailurePlan.source, 'preset')
    assert.equal(parseFailurePlan.fallbackReason, 'malformed_json')
  })
})

test('Greeting Guard blocks unsafe personalized greeting claims', async () => {
  await withTempRuntime(async ({ storageDir, bossConfig, resume, canaries }) => {
    const candidateProfile = buildCandidateProfile(bossConfig, { resume })
    const cacheResult = await buildOrRefreshCapabilityProfile({
      bossConfig,
      candidateProfile,
      llmConfig: enabledFakeLlmConfig(),
      storageDir,
      generateProfile: async () => safeGeneratedProfile(),
    })
    assert.equal(cacheResult.ok, true)

    const guardResult = guardPersonalizedGreeting([
      '您好，我有3年字节跳动后端经验，持有 AWS Certified 认证。',
      '我可以随时到岗，期望薪资 30K，并可通过 private-person@example.com 联系。',
      '简历图片 C:\\Users\\Private\\Documents\\resume-image.png。',
      canaries.resume,
    ].join(''), {
      capabilityProfileSummary: cacheResult.summary,
      candidateProfile,
    })

    const reasonCodes = guardResult.reasons.map(reason => reason.code)
    assert.equal(guardResult.passed, false)
    assert.equal(reasonCodes.includes('unsupported_years_of_experience_claim'), true)
    assert.equal(reasonCodes.includes('unsupported_company_claim'), true)
    assert.equal(reasonCodes.includes('unsupported_certification_claim'), true)
    assert.equal(reasonCodes.includes('unsupported_availability_claim'), true)
    assert.equal(reasonCodes.includes('unsupported_salary_claim'), true)
    assert.equal(reasonCodes.includes('contact_information'), true)
    assert.equal(reasonCodes.includes('local_path'), true)
    assert.equal(reasonCodes.includes('image_path'), true)
    assert.equal(reasonCodes.includes('full_resume_leakage'), true)
  })
})

test('buildGuardedPersonalizedGreetingPlan falls back when Greeting Guard rejects generated output', async () => {
  await withTempRuntime(async ({ storageDir, bossConfig, resume }) => {
    const candidateProfile = buildCandidateProfile(bossConfig, { resume })
    const cacheResult = await buildOrRefreshCapabilityProfile({
      bossConfig,
      candidateProfile,
      llmConfig: enabledFakeLlmConfig(),
      storageDir,
      generateProfile: async () => safeGeneratedProfile(),
    })
    assert.equal(cacheResult.ok, true)

    const plan = await buildGuardedPersonalizedGreetingPlan({
      job: targetJob(),
      bossConfig,
      candidateProfile,
      llmConfig: enabledFakeLlmConfig(),
      storageDir,
      fallbackPlan: fallbackPresetPlan(),
      generateGreeting: async () => ({ message: '您好，我有3年后端经验，可随时到岗，期望薪资 30K。' }),
    })

    assert.equal(plan.source, 'preset')
    assert.equal(plan.fallbackReason, 'guard_rejected')
    assert.equal(plan.personalization.guardResult.passed, false)
  })
})

test('greeting-preview CLI produces a personalized Greeting Plan without storing generated text', async () => {
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
      message: safePersonalizedGreeting(),
      requests,
    })

    try {
      writeRuntimeConfig(tempHome, bossConfig, [
        {
          enabled: true,
          providerCompleteApiUrl: server.baseURL,
          providerApiSecret: 'test-secret',
          model: 'test-model',
        },
      ], resume)

      const ggrPath = path.resolve('bin', 'ggr.mjs')
      const { stdout } = await execFileAsync(process.execPath, [
        ggrPath,
        'greeting-preview',
        '--title',
        targetJob().title,
        '--jd',
        targetJob().jd,
      ], {
        env: {
          ...process.env,
          HOME: tempHome,
          USERPROFILE: tempHome,
        },
      })
      const output = JSON.parse(stdout)

      assert.equal(output.ok, true)
      assert.equal(output.command, 'greeting-preview')
      assert.equal(output.greetingPlan.source, 'personalized')
      assert.equal(output.greetingPlan.guardResult.passed, true)
      assert.equal(stdout.includes(safePersonalizedGreeting()), false)
      assert.equal(stdout.includes(canaries.resume), false)
      assert.equal(stdout.includes(canaries.email), false)

      const requestText = JSON.stringify(requests)
      assert.equal(requests.length, 1)
      assert.equal(requestText.includes(canaries.resume), false)
      assert.equal(requestText.includes(canaries.email), false)
      assert.equal(requestText.includes('resumeMarkdown'), false)
    } finally {
      await server.close()
    }
  })
})

function safePersonalizedGreeting () {
  return '您好，我关注到岗位需要 FastAPI、LLM 工具和自动化交付。我有 Python 后端与工作流自动化项目经验，能基于既有项目证据参与接口开发和工具集成，想进一步沟通岗位匹配。'
}

function targetJob () {
  return {
    title: 'Python AI 后端开发',
    company: 'Example Co',
    jd: '负责 FastAPI 服务开发、LLM 工具接入和自动化工作流建设。',
  }
}

function fallbackPresetPlan () {
  return {
    source: 'preset',
    selectedTemplate: {
      type: 'default',
      rule: 'default',
      name: 'default',
      pattern: '',
    },
    fallbackReason: null,
    summary: 'Preset greeting selected from default; 10 characters.',
    characterCount: 10,
    safetyStatus: {
      auditSafe: true,
      deliveryTextAvailable: true,
      originalMessageSensitive: false,
      reasons: [],
    },
  }
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

async function withTempRuntime (callback) {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ggr-personalized-greeting-'))
  const originalHome = process.env.HOME
  const originalUserProfile = process.env.USERPROFILE
  const configDir = path.join(tempHome, '.geekgeekrun', 'config')
  const storageDir = path.join(tempHome, '.geekgeekrun', 'storage')
  const canaries = {
    resume: 'PRIVATE_RESUME_CANARY_0003',
    email: 'private-person@example.com',
    imagePath: 'C:\\Users\\Private\\Documents\\resume-image.png',
    greeting: 'FULL_GREETING_CANARY_0003',
  }
  const bossConfig = {
    expectJobNameRegExpStr: 'Python|AI|后端',
    expectJobTypeRegExpStr: '实习|开发',
    expectJobDescRegExpStr: 'FastAPI|LLM|自动化',
    autoStartChatGreetingMessage: `您好，想了解这个岗位。${canaries.greeting}`,
    autoStartChatGreetingImageEnabled: true,
    autoStartChatGreetingImagePath: canaries.imagePath,
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
        `简历图片路径 ${canaries.imagePath}`,
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
    process.env.HOME = tempHome
    process.env.USERPROFILE = tempHome
    writeRuntimeConfig(tempHome, bossConfig, [], resume)
    fs.mkdirSync(storageDir, { recursive: true })
    return await callback({ tempHome, configDir, storageDir, bossConfig, resume, canaries })
  } finally {
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    if (originalUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = originalUserProfile
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

async function startFakeChatCompletionsServer ({ message, requests }) {
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      requests.push(JSON.parse(body))
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
              content: JSON.stringify({ message }),
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
