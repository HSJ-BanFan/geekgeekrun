import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import {
  analyzeApplicationPreferences,
  runRecentApplicationsOnOpenPage,
} from './recent-applications.mjs'

test('recent applications extraction reads chatStore friendInfos in timestamp order and writes a redacted artifact', async () => {
  await withTempOutput(async ({ outputPath }) => {
    const page = createRecentApplicationsPageFake({
      friendInfos: [
        friendInfo({
          id: 'older',
          lastTS: 20,
          title: '数据标注专员',
          company: 'Noise Co',
          securityId: 'RAW_SECURITY_ID_SHOULD_NOT_PERSIST',
        }),
        friendInfo({
          id: 'newer',
          lastTS: 30,
          title: 'AI Agent 后端开发',
          company: 'Target Co',
          city: '上海',
          positionCategory: '后端开发',
          securityId: 'RAW_SECURITY_ID_SHOULD_NOT_PERSIST_2',
        }),
      ],
    })

    const result = await runRecentApplicationsOnOpenPage(page, {
      limit: 1,
      includeJd: false,
      outputPath,
      now: new Date('2026-07-07T10:00:00.000Z'),
    })

    assert.equal(result.ok, true)
    assert.equal(result.command, 'recent-applications')
    assert.equal(result.recordCount, 1)
    assert.equal(result.statusSummary.total, 1)
    assert.equal(result.statusSummary.jd.skipped, 1)
    assert.equal(result.rawArtifactPath, outputPath)

    const artifactText = fs.readFileSync(outputPath, 'utf8')
    const artifact = JSON.parse(artifactText)
    assert.equal(artifact.schemaVersion, 'recent-applications.v1')
    assert.equal(artifact.records[0].conversationId, 'newer')
    assert.equal(artifact.records[0].rank, 1)
    assert.equal(artifact.records[0].title, 'AI Agent 后端开发')
    assert.equal(artifact.records[0].jobIdentityAnchor.hasSecurityId, true)
    assert.equal(artifactText.includes('RAW_SECURITY_ID_SHOULD_NOT_PERSIST'), false)
    assert.equal(artifactText.includes('cookies'), false)
    assert.equal(artifactText.includes('localStorage'), false)
  })
})

test('recent applications extraction enriches records from the BOSS job detail DOM', async () => {
  await withTempOutput(async ({ outputPath }) => {
    const navigatedUrls = []
    const page = createRecentApplicationsPageFake({
      friendInfos: [
        friendInfo({
          id: 'job-1',
          lastTS: 30,
          title: 'Python AI 后端开发',
          encryptJobId: 'enc-job-1',
          securityId: 'RAW_SECURITY_ID_FOR_URL_ONLY',
        }),
      ],
      detailTextByJobId: {
        'enc-job-1': {
          jdText: '负责 FastAPI 服务开发、LLM 工具接入和 Agent 工作流建设。',
          pageTitle: 'Python AI 后端开发_BOSS直聘',
          salary: '20-30K',
        },
      },
      onGoto: url => navigatedUrls.push(url),
    })

    const result = await runRecentApplicationsOnOpenPage(page, {
      limit: 10,
      includeJd: true,
      outputPath,
      now: new Date('2026-07-07T10:00:00.000Z'),
    })

    assert.equal(result.ok, true)
    assert.equal(result.statusSummary.jd.ok, 1)
    assert.equal(navigatedUrls.length, 2)
    assert.equal(navigatedUrls[1].includes('/job_detail/enc-job-1.html'), true)

    const artifactText = fs.readFileSync(outputPath, 'utf8')
    const artifact = JSON.parse(artifactText)
    assert.equal(artifact.records[0].status, 'ok')
    assert.equal(artifact.records[0].jd.status, 'ok')
    assert.equal(artifact.records[0].jd.text, '负责 FastAPI 服务开发、LLM 工具接入和 Agent 工作流建设。')
    assert.equal(artifact.records[0].jd.pageTitle, 'Python AI 后端开发_BOSS直聘')
    assert.equal(artifact.records[0].jd.salary, '20-30K')
    assert.equal(artifactText.includes('RAW_SECURITY_ID_FOR_URL_ONLY'), false)
  })
})

test('recent applications extraction stops with a partial artifact on BOSS safety verification', async () => {
  await withTempOutput(async ({ outputPath }) => {
    const page = createRecentApplicationsPageFake({
      friendInfos: [
        friendInfo({ id: 'safe-job', lastTS: 30, title: 'AI Agent 工程师', encryptJobId: 'safe-job' }),
        friendInfo({ id: 'blocked-job', lastTS: 20, title: 'Python 后端', encryptJobId: 'blocked-job' }),
      ],
      detailTextByJobId: {
        'safe-job': { jdText: '负责 LLM 应用开发。' },
        'blocked-job': { safetyVerification: true },
      },
    })

    const result = await runRecentApplicationsOnOpenPage(page, {
      limit: 10,
      includeJd: true,
      outputPath,
      now: new Date('2026-07-07T10:00:00.000Z'),
    })

    assert.equal(result.ok, false)
    assert.equal(result.reasonCode, 'BOSS_SAFETY_VERIFICATION_REQUIRED')
    assert.equal(result.statusSummary.ok, 1)
    assert.equal(result.statusSummary.blocked, 1)
    assert.equal(result.statusSummary.jd.blocked, 1)

    const artifact = JSON.parse(fs.readFileSync(outputPath, 'utf8'))
    assert.equal(artifact.records.length, 2)
    assert.equal(artifact.records[1].status, 'blocked')
    assert.equal(artifact.records[1].reasonCode, 'BOSS_SAFETY_VERIFICATION_REQUIRED')
  })
})

test('recent applications extraction fails closed when chatStore friendInfos is unavailable', async () => {
  await withTempOutput(async ({ outputPath }) => {
    const page = createRecentApplicationsPageFake({
      chatStoreUnavailable: true,
    })

    const result = await runRecentApplicationsOnOpenPage(page, {
      limit: 10,
      includeJd: true,
      outputPath,
      now: new Date('2026-07-07T10:00:00.000Z'),
    })

    assert.equal(result.ok, false)
    assert.equal(result.reasonCode, 'BOSS_CHAT_STORE_UNAVAILABLE')
    assert.equal(result.recordCount, 0)

    const artifact = JSON.parse(fs.readFileSync(outputPath, 'utf8'))
    assert.equal(artifact.reasonCode, 'BOSS_CHAT_STORE_UNAVAILABLE')
    assert.deepEqual(artifact.records, [])
  })
})

test('preference analysis reports deterministic category counts, terms, locations, and examples', () => {
  const analysis = analyzeApplicationPreferences([
    {
      rank: 1,
      title: 'AI Agent 后端开发',
      company: 'Target Co',
      city: '上海',
      positionCategory: '后端开发',
      jd: { text: '负责 Python FastAPI、LLM、Agent 工作流和数据管道建设。' },
      lastMessage: { text: '方便的话可以发一份简历' },
    },
    {
      rank: 2,
      title: '日语数据标注兼职',
      company: 'Noise Co',
      city: '远程',
      positionCategory: '数据标注',
      jd: { text: '日语翻译、AI 训练、数据标注，兼职远程。' },
      lastMessage: { text: '这个是兼职项目' },
    },
    {
      rank: 3,
      title: 'AIGC 测试实习生',
      company: 'Mixed Co',
      city: '上海',
      positionCategory: '测试',
      jd: { text: '测试 AIGC 产品，也需要做数据审核。' },
    },
  ])

  assert.equal(analysis.titleCategoryCounts.ai_llm_agent_aigc, 2)
  assert.equal(analysis.titleCategoryCounts.python_backend_data_engineering, 1)
  assert.equal(analysis.titleCategoryCounts.data_annotation_ai_training, 1)
  assert.equal(analysis.titleCategoryCounts.translation_localization_japanese, 1)
  assert.equal(analysis.jdTermCounts.llm, 1)
  assert.equal(analysis.jdTermCounts.python, 1)
  assert.deepEqual(analysis.topCities[0], { value: '上海', count: 2 })
  assert.equal(analysis.coreTargetExamples[0].title, 'AI Agent 后端开发')
  assert.equal(analysis.likelyNoiseExamples[0].title, '日语数据标注兼职')
  assert.equal(analysis.mixedNoisyExamples[0].title, 'AIGC 测试实习生')
  assert.equal(analysis.recruiterLastMessageExamples.length, 2)
})

function friendInfo ({
  id,
  lastTS,
  title,
  company = 'Example Co',
  city = '北京',
  positionCategory = '开发',
  encryptJobId = id,
  jobId = id,
  securityId,
} = {}) {
  return {
    friendId: id,
    lastTS,
    lastMsg: '您好，可以沟通一下',
    jobInfo: {
      encryptJobId,
      jobId,
      jobName: title,
      brandName: company,
      cityName: city,
      positionCategory,
      securityId,
    },
    bossInfo: {
      name: '王经理',
      title: '招聘经理',
    },
  }
}

function createRecentApplicationsPageFake ({
  friendInfos = [],
  chatStoreUnavailable = false,
  detailTextByJobId = {},
  onGoto = () => {},
} = {}) {
  let currentUrl = 'about:blank'
  let currentJobId = ''
  return {
    url () {
      return currentUrl
    },
    async goto (url) {
      currentUrl = url
      onGoto(url)
      const match = String(url).match(/job_detail\/([^/.]+)\.html/)
      currentJobId = match?.[1] ?? ''
    },
    async waitForFunction () {},
    async evaluate (fn) {
      const source = String(fn)
      if (source.includes('chatStore') && source.includes('friendInfos')) {
        if (chatStoreUnavailable) {
          return {
            ok: false,
            reasonCode: 'BOSS_CHAT_STORE_UNAVAILABLE',
            url: currentUrl,
            visibleText: '聊天列表',
          }
        }
        return {
          ok: true,
          url: currentUrl,
          friendInfos,
        }
      }
      if (source.includes('document.body') && source.includes('innerText')) {
        const detail = detailTextByJobId[currentJobId] ?? {}
        return {
          url: currentUrl,
          pageTitle: detail.pageTitle ?? '',
          visibleText: detail.safetyVerification ? '安全验证 拖动滑块后继续' : detail.jdText ?? '',
          jdText: detail.safetyVerification ? '' : detail.jdText ?? '',
          salary: detail.salary ?? '',
          companyDescription: detail.companyDescription ?? '',
        }
      }
      return null
    },
  }
}

function withTempOutput (callback) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ggr-recent-applications-'))
  const outputPath = path.join(tempDir, 'recent-applications.json')
  const cleanup = () => fs.rmSync(tempDir, { recursive: true, force: true })
  try {
    const result = callback({ tempDir, outputPath })
    if (result && typeof result.then === 'function') return result.finally(cleanup)
    cleanup()
    return result
  } catch (err) {
    cleanup()
    throw err
  }
}
