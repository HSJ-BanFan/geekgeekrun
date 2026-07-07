import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { test } from 'node:test'

const execFileAsync = promisify(execFile)

test('buildOrRefreshCapabilityProfile writes a fresh non-sensitive cache', async () => {
  await withTempRuntime(async ({ tempHome, storageDir, resume, canaries, bossConfig }) => {
    const { buildCandidateProfile } = await import(`./candidate-profile.mjs?test=${Date.now()}-safe-cache`)
    const {
      buildOrRefreshCapabilityProfile,
      getCapabilityProfileCachePath,
      inspectCapabilityProfileCache,
    } = await import(`./capability-profile.mjs?test=${Date.now()}-safe-cache`)

    const candidateProfile = buildCandidateProfile(bossConfig, { resume })
    const result = await buildOrRefreshCapabilityProfile({
      bossConfig,
      candidateProfile,
      llmConfig: enabledFakeLlmConfig(),
      storageDir,
      generateProfile: async () => ({
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
        framingBoundaries: ['Do not claim senior tenure, certifications, or guaranteed availability'],
      }),
    })

    assert.equal(result.ok, true)
    assert.equal(result.refreshed, true)
    assert.equal(result.status.exists, true)
    assert.equal(result.status.fresh, true)

    const cachePath = getCapabilityProfileCachePath({ storageDir })
    assert.equal(cachePath, path.join(tempHome, '.geekgeekrun', 'storage', 'candidate-capability-profile.json'))
    assert.equal(fs.existsSync(cachePath), true)

    const cacheText = fs.readFileSync(cachePath, 'utf8')
    assertCanariesAbsent(cacheText, canaries)
    assert.equal(cacheText.includes('resumeMarkdown'), false)
    assert.equal(cacheText.includes('full resume'), false)
    assert.equal(cacheText.includes('autoStartChatGreetingImagePath'), false)

    const status = inspectCapabilityProfileCache({ bossConfig, candidateProfile, storageDir })
    assert.equal(status.exists, true)
    assert.equal(status.fresh, true)
    assert.equal(status.summary.demonstratedAbilities[0].ability, 'Python backend automation')
    assertCanariesAbsent(JSON.stringify(status), canaries)
  })
})

test('inspectCapabilityProfileCache marks cache stale when inputs or versions change', async () => {
  await withTempRuntime(async ({ storageDir, resume, bossConfig }) => {
    const { buildCandidateProfile } = await import(`./candidate-profile.mjs?test=${Date.now()}-stale`)
    const {
      buildOrRefreshCapabilityProfile,
      inspectCapabilityProfileCache,
    } = await import(`./capability-profile.mjs?test=${Date.now()}-stale`)

    const candidateProfile = buildCandidateProfile(bossConfig, { resume })
    const generation = await buildOrRefreshCapabilityProfile({
      bossConfig,
      candidateProfile,
      llmConfig: enabledFakeLlmConfig(),
      storageDir,
      generateProfile: async () => safeGeneratedProfile(),
    })
    assert.equal(generation.ok, true)

    assertStaleReason(
      inspectCapabilityProfileCache({
        bossConfig,
        storageDir,
        candidateProfile: {
          ...candidateProfile,
          resumeMarkdown: `${candidateProfile.resumeMarkdown}\nAdditional React Native evidence.`,
        },
      }),
      'source_fingerprint_mismatch:resumeDerivedInput'
    )
    assertStaleReason(
      inspectCapabilityProfileCache({
        bossConfig,
        storageDir,
        candidateProfile: {
          ...candidateProfile,
          expectedJob: 'AI 产品经理',
        },
      }),
      'source_fingerprint_mismatch:targetRoleIntent'
    )
    assertStaleReason(
      inspectCapabilityProfileCache({
        bossConfig: {
          ...bossConfig,
          staticCombineRecommendJobFilterConditions: [{ field: 'salary', value: '30k+' }],
        },
        candidateProfile,
        storageDir,
      }),
      'source_fingerprint_mismatch:userRequirements'
    )
    assertStaleReason(
      inspectCapabilityProfileCache({
        bossConfig: {
          ...bossConfig,
          autoStartChatGreetingMessageRules: [
            ...bossConfig.autoStartChatGreetingMessageRules,
            { name: 'Data', pattern: 'ETL|数据', message: '新的规则消息' },
          ],
        },
        candidateProfile,
        storageDir,
      }),
      'source_fingerprint_mismatch:greetingRules'
    )
    assertStaleReason(
      inspectCapabilityProfileCache({
        bossConfig,
        candidateProfile,
        storageDir,
        schemaVersion: 'candidate-capability-profile.v-next',
      }),
      'schema_version_changed'
    )
    assertStaleReason(
      inspectCapabilityProfileCache({
        bossConfig,
        candidateProfile,
        storageDir,
        promptVersion: 'candidate-capability-profile.prompt.v-next',
      }),
      'prompt_version_changed'
    )
  })
})

test('buildOrRefreshCapabilityProfile fails closed without LLM config and writes no fresh cache', async () => {
  await withTempRuntime(async ({ storageDir, resume, bossConfig }) => {
    const { buildCandidateProfile } = await import(`./candidate-profile.mjs?test=${Date.now()}-no-llm`)
    const {
      buildOrRefreshCapabilityProfile,
      getCapabilityProfileCachePath,
      inspectCapabilityProfileCache,
    } = await import(`./capability-profile.mjs?test=${Date.now()}-no-llm`)

    const candidateProfile = buildCandidateProfile(bossConfig, { resume })
    const result = await buildOrRefreshCapabilityProfile({
      bossConfig,
      candidateProfile,
      llmConfig: [],
      storageDir,
    })

    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'CAPABILITY_PROFILE_LLM_UNAVAILABLE')
    assert.equal(fs.existsSync(getCapabilityProfileCachePath({ storageDir })), false)

    const status = inspectCapabilityProfileCache({ bossConfig, candidateProfile, storageDir })
    assert.equal(status.exists, false)
    assert.equal(status.fresh, false)
  })
})

test('capability-profile command fails safely without LLM config and writes no cache', async () => {
  await withTempRuntime(async ({ storageDir, canaries }) => {
    const ggrPath = path.resolve('bin', 'ggr.mjs')
    let failure = null
    try {
      await execFileAsync(process.execPath, [ggrPath, 'capability-profile'], {
        env: {
          ...process.env,
          HOME: process.env.HOME,
          USERPROFILE: process.env.USERPROFILE,
        },
      })
    } catch (err) {
      failure = err
    }

    assert.ok(failure)
    const output = JSON.parse(failure.stdout)
    assert.equal(output.ok, false)
    assert.equal(output.command, 'capability-profile')
    assert.equal(output.error.code, 'CAPABILITY_PROFILE_LLM_UNAVAILABLE')
    assert.equal(fs.existsSync(path.join(storageDir, 'candidate-capability-profile.json')), false)
    assertCanariesAbsent(failure.stdout, canaries)
  })
})

test('snapshot reports capability cache status without resume canaries', async () => {
  await withTempRuntime(async ({ storageDir, resume, canaries, bossConfig }) => {
    const { buildCandidateProfile } = await import(`./candidate-profile.mjs?test=${Date.now()}-snapshot`)
    const { buildOrRefreshCapabilityProfile } = await import(`./capability-profile.mjs?test=${Date.now()}-snapshot`)

    const candidateProfile = buildCandidateProfile(bossConfig, { resume })
    const generation = await buildOrRefreshCapabilityProfile({
      bossConfig,
      candidateProfile,
      llmConfig: enabledFakeLlmConfig(),
      storageDir,
      generateProfile: async () => safeGeneratedProfile(),
    })
    assert.equal(generation.ok, true)

    const ggrPath = path.resolve('bin', 'ggr.mjs')
    const { stdout } = await execFileAsync(process.execPath, [ggrPath, 'snapshot'], {
      env: {
        ...process.env,
        HOME: process.env.HOME,
        USERPROFILE: process.env.USERPROFILE,
      },
    })
    const output = JSON.parse(stdout)

    assert.equal(output.ok, true)
    assert.equal(output.capabilityProfile.exists, true)
    assert.equal(output.capabilityProfile.fresh, true)
    assert.equal(output.capabilityProfile.summary.targetRoleDirection, 'Python backend and AI agent roles')
    assertCanariesAbsent(stdout, canaries)
  })
})

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
    framingBoundaries: ['Do not claim senior tenure, certifications, or guaranteed availability'],
  }
}

async function withTempRuntime (callback) {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ggr-capability-profile-'))
  const originalHome = process.env.HOME
  const originalUserProfile = process.env.USERPROFILE
  const canaries = [
    'PRIVATE_RESUME_CANARY_90210',
    'private-person@example.com',
    'C:\\Users\\Private\\Documents\\resume-image.png',
    'FULL_GREETING_CANARY_8848',
  ]

  try {
    process.env.HOME = tempHome
    process.env.USERPROFILE = tempHome
    const configDir = path.join(tempHome, '.geekgeekrun', 'config')
    const storageDir = path.join(tempHome, '.geekgeekrun', 'storage')
    fs.mkdirSync(configDir, { recursive: true })
    fs.mkdirSync(storageDir, { recursive: true })

    const bossConfig = {
      expectJobNameRegExpStr: 'Python|AI|后端',
      expectJobTypeRegExpStr: '实习|开发',
      expectJobDescRegExpStr: 'FastAPI|LLM|自动化',
      expectCityList: ['101020100'],
      staticCombineRecommendJobFilterConditions: [{ field: 'degree', value: '本科' }],
      anyCombineRecommendJobFilter: { salaryList: ['10-20K'] },
      autoStartChatGreetingMessage: `你好，我想了解这个岗位。${canaries[3]}`,
      autoStartChatGreetingImageEnabled: true,
      autoStartChatGreetingImagePath: canaries[2],
      autoStartChatGreetingMessageRules: [
        { name: 'AI Agent', pattern: 'AI|LLM|Agent', message: `您好，想沟通岗位。${canaries[3]}` },
      ],
      jobSourceList: [
        {
          type: 'search',
          enabled: true,
          children: [{ enabled: true, keyword: 'Python AI 实习' }],
        },
      ],
    }

    fs.writeFileSync(path.join(configDir, 'boss.json'), JSON.stringify(bossConfig))
    fs.writeFileSync(path.join(configDir, 'llm.json'), JSON.stringify([]))
    const resume = {
      content: {
        expectJob: 'Python 后端 / AI Agent 实习',
        workYearDesc: '应届生',
        userDescription: [
          `我做过 FastAPI 自动化项目。${canaries[0]}`,
          `联系邮箱 ${canaries[1]}`,
          `简历图片路径 ${canaries[2]}`,
        ].join('\n'),
        geekWorkExpList: [
          {
            company: 'Example Lab',
            positionName: 'Backend Intern',
            workDescription: 'Built Python automation workflows for internal data processing.',
            performance: 'Reduced manual checking in a demo workflow.',
          },
        ],
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
    fs.writeFileSync(path.join(configDir, 'resumes.json'), JSON.stringify([resume]))

    return await callback({ tempHome, storageDir, resume, canaries, bossConfig })
  } finally {
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    if (originalUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = originalUserProfile
    fs.rmSync(tempHome, { recursive: true, force: true })
  }
}

function assertCanariesAbsent (text, canaries) {
  for (const canary of canaries) {
    const escapedCanary = JSON.stringify(canary).slice(1, -1)
    assert.equal(
      text.includes(canary),
      false,
      `expected output to omit sensitive canary: ${canary}`
    )
    assert.equal(
      text.includes(escapedCanary),
      false,
      `expected output to omit escaped sensitive canary: ${escapedCanary}`
    )
  }
}

function assertStaleReason (status, reason) {
  assert.equal(status.exists, true)
  assert.equal(status.fresh, false)
  assert.equal(status.reasons.includes(reason), true)
}
