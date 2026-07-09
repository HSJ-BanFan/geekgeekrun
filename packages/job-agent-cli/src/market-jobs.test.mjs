import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import {
  runMarketJobs,
  runMarketJobsOnOpenPage,
} from './market-jobs.mjs'

test('market-jobs --plan-only expands one keyword and city without browser access', async () => {
  const result = await runMarketJobs({
    planOnly: true,
    keywords: ['AI Agent'],
    cities: ['上海'],
    outputPath: 'artifacts/market.json',
    now: new Date('2026-07-09T08:00:00.000Z'),
  })

  assert.equal(result.ok, true)
  assert.equal(result.command, 'market-jobs')
  assert.equal(result.mode, 'plan-only')
  assert.equal(result.reasonCode, null)
  assert.equal(result.sampleCount, 1)
  assert.equal(result.jobCount, 0)
  assert.equal(result.requestedLimitPerSample, 200)
  assert.equal(result.plannedRecordBudget, 200)
  assert.equal(result.rawArtifactPath, path.resolve('artifacts/market.json'))
  assert.equal(result.analysisArtifactPath, null)
  assert.deepEqual(result.statusSummary, {})
  assert.deepEqual(result.plannedSamples, [
    {
      sampleKey: 'ai-agent__101020100',
      keyword: 'AI Agent',
      cityInput: '上海',
      cityCode: '101020100',
      requestedLimit: 200,
      plannedRankStart: 1,
      plannedRankEnd: 200,
    },
  ])
})

test('market-jobs --plan-only expands repeatable keywords and cities as a Cartesian grid', async () => {
  const result = await runMarketJobs({
    planOnly: true,
    keywords: ['AI Agent', '全栈'],
    cities: ['上海', '101010100'],
    limit: 3,
    analyze: true,
    outputPath: 'artifacts/market.json',
  })

  assert.equal(result.ok, true)
  assert.equal(result.sampleCount, 4)
  assert.equal(result.plannedRecordBudget, 12)
  assert.equal(result.analysisArtifactPath, path.resolve('artifacts/market.analysis.json'))
  assert.deepEqual(result.plannedSamples.map(sample => ({
    keyword: sample.keyword,
    cityInput: sample.cityInput,
    cityCode: sample.cityCode,
    requestedLimit: sample.requestedLimit,
  })), [
    { keyword: 'AI Agent', cityInput: '上海', cityCode: '101020100', requestedLimit: 3 },
    { keyword: 'AI Agent', cityInput: '101010100', cityCode: '101010100', requestedLimit: 3 },
    { keyword: '全栈', cityInput: '上海', cityCode: '101020100', requestedLimit: 3 },
    { keyword: '全栈', cityInput: '101010100', cityCode: '101010100', requestedLimit: 3 },
  ])
})

test('market-jobs --plan-only keeps sample keys unique when keyword slugs collide', async () => {
  const result = await runMarketJobs({
    planOnly: true,
    keywords: ['全栈', '后端'],
    cities: ['上海'],
    limit: 1,
  })

  assert.equal(result.ok, true)
  assert.deepEqual(result.plannedSamples.map(sample => sample.sampleKey), [
    'keyword__101020100',
    'keyword__101020100__2',
  ])
})

test('market-jobs requires --from-browser unless --plan-only is set', async () => {
  const result = await runMarketJobs({
    fromBrowser: false,
    planOnly: false,
    keywords: ['AI Agent'],
    cities: ['上海'],
  })

  assert.equal(result.ok, false)
  assert.equal(result.command, 'market-jobs')
  assert.equal(result.reasonCode, 'FROM_BROWSER_REQUIRED')
})

test('market-jobs browser mode writes a one-sample raw artifact from visible search cards', async () => {
  await withTempOutput(async ({ outputPath }) => {
    const page = createMarketJobsPageFake({
      batches: [
        [
          marketJob({
            jobId: 'enc-job-1',
            title: 'AI Agent 后端开发',
            company: 'Target Co',
            city: '上海',
            salaryText: '25-35K',
            experience: '3-5年',
            degree: '本科',
            contactState: 'uncontacted',
            contactEvidenceText: '立即沟通',
          }),
          marketJob({
            jobId: 'enc-job-2',
            title: 'Python 平台工程师',
            company: 'Platform Co',
            city: '上海',
            salaryText: '20-30K',
            contactState: 'contacted',
            contactEvidenceText: '继续沟通',
          }),
        ],
      ],
    })

    const result = await runMarketJobsOnOpenPage(page, {
      keywords: ['AI Agent'],
      cities: [{ cityInput: '上海', cityCode: '101020100' }],
      limit: 2,
      outputPath,
      navigationSettleMs: 0,
      scrollSettleMs: 0,
      now: new Date('2026-07-09T08:00:00.000Z'),
    })

    assert.equal(result.ok, true)
    assert.equal(result.command, 'market-jobs')
    assert.equal(result.sampleCount, 1)
    assert.equal(result.jobCount, 2)
    assert.equal(result.reasonCode, null)
    assert.equal(result.rawArtifactPath, outputPath)
    assert.equal(Object.hasOwn(result, 'jobs'), false)

    const artifact = JSON.parse(fs.readFileSync(outputPath, 'utf8'))
    assert.equal(artifact.schemaVersion, 'market-jobs.v1')
    assert.equal(artifact.captureMetadata.readOnly, true)
    assert.equal(artifact.captureMetadata.authorization.issuesApplicationAuthorization, false)
    assert.equal(artifact.captureMetadata.authorization.consumesApplicationAuthorizationToken, false)
    assert.equal(artifact.sourceStrategy.list, 'boss_geek_search_results')
    assert.equal(artifact.sourceStrategy.jd, 'not_requested')
    assert.equal(artifact.samples[0].sampleKey, 'ai-agent__101020100')
    assert.equal(artifact.samples[0].status, 'ok')
    assert.equal(artifact.samples[0].reasonCode, 'LIMIT_REACHED')
    assert.equal(artifact.samples[0].capturedCount, 2)
    assert.equal(artifact.samples[0].dedupedJobCount, 2)
    assert.equal(artifact.jobs.length, 2)
    assert.equal(artifact.jobs[0].jobIdentity.status, 'stable')
    assert.equal(artifact.jobs[0].observations[0].sampleKey, 'ai-agent__101020100')
    assert.equal(artifact.jobs[0].observations[0].rank, 1)
    assert.equal(artifact.jobs[1].contactState, 'contacted')
  })
})

test('market-jobs classifies contact state from visible list text without chat history', async () => {
  await withTempOutput(async ({ outputPath }) => {
    const page = createMarketJobsPageFake({
      batches: [
        [
          marketJob({
            jobId: 'uncontacted-job',
            title: '未沟通岗位',
            contactState: '',
            contactEvidenceText: '',
            listText: '未沟通岗位\nTarget Co\n25-35K\n立即沟通',
          }),
          marketJob({
            jobId: 'contacted-job',
            title: '沟通过的岗位',
            contactState: '',
            contactEvidenceText: '',
            listText: '沟通过的岗位\nPlatform Co\n20-30K\n继续沟通',
          }),
          marketJob({
            jobId: 'applied-job',
            title: '已投递岗位',
            contactState: '',
            contactEvidenceText: '',
            listText: '已投递岗位\nApply Co\n18-28K\n已投递',
          }),
          marketJob({
            jobId: 'unknown-job',
            title: '状态冲突岗位',
            contactState: '',
            contactEvidenceText: '',
            listText: '状态冲突岗位\nConflict Co\n30-40K\n立即沟通\n已投递',
          }),
          marketJob({
            jobId: 'missing-state-job',
            title: '无状态岗位',
            contactState: '',
            contactEvidenceText: '',
            listText: '无状态岗位\nUnknown Co\n15-20K',
          }),
        ],
      ],
      failOnChatHistoryAccess: true,
    })

    const result = await runMarketJobsOnOpenPage(page, {
      keywords: ['AI'],
      cities: [{ cityInput: '上海', cityCode: '101020100' }],
      limit: 5,
      outputPath,
      navigationSettleMs: 0,
      scrollSettleMs: 0,
      now: new Date('2026-07-09T08:00:00.000Z'),
    })

    assert.equal(result.ok, true)

    const artifact = JSON.parse(fs.readFileSync(outputPath, 'utf8'))
    assert.deepEqual(artifact.jobs.map(job => job.contactState), [
      'uncontacted',
      'contacted',
      'applied_or_chatting',
      'unknown',
      'unknown',
    ])
    assert.deepEqual(artifact.jobs.map(job => job.contactStateEvidence.text), [
      '立即沟通',
      '继续沟通',
      '已投递',
      'conflicting: 已投递 / 立即沟通',
      '',
    ])
    assert.deepEqual(artifact.jobs.map(job => job.observations[0].contactStateEvidence.text), [
      '立即沟通',
      '继续沟通',
      '已投递',
      'conflicting: 已投递 / 立即沟通',
      '',
    ])
    assert.equal(artifact.statusSummary.contactStates.uncontacted, 1)
    assert.equal(artifact.statusSummary.contactStates.contacted, 1)
    assert.equal(artifact.statusSummary.contactStates.applied_or_chatting, 1)
    assert.equal(artifact.statusSummary.contactStates.unknown, 2)
  })
})

test('market-jobs list stage scrolls until no new visible cards are found', async () => {
  await withTempOutput(async ({ outputPath }) => {
    const page = createMarketJobsPageFake({
      batches: [
        [marketJob({ jobId: 'job-1', title: 'AI 工程师' })],
        [
          marketJob({ jobId: 'job-1', title: 'AI 工程师' }),
          marketJob({ jobId: 'job-2', title: 'LLM 工程师' }),
        ],
        [
          marketJob({ jobId: 'job-1', title: 'AI 工程师' }),
          marketJob({ jobId: 'job-2', title: 'LLM 工程师' }),
        ],
        [
          marketJob({ jobId: 'job-1', title: 'AI 工程师' }),
          marketJob({ jobId: 'job-2', title: 'LLM 工程师' }),
        ],
      ],
    })

    const result = await runMarketJobsOnOpenPage(page, {
      keywords: ['AI'],
      cities: [{ cityInput: '北京', cityCode: '101010100' }],
      limit: 5,
      outputPath,
      navigationSettleMs: 0,
      scrollSettleMs: 0,
      now: new Date('2026-07-09T08:00:00.000Z'),
    })

    assert.equal(result.ok, true)
    assert.equal(result.jobCount, 2)
    const artifact = JSON.parse(fs.readFileSync(outputPath, 'utf8'))
    assert.equal(artifact.samples[0].reasonCode, 'NO_NEW_ITEMS')
    assert.equal(artifact.samples[0].scrollCount, 3)
    assert.equal(artifact.samples[0].noNewItemCount, 2)
    assert.equal(artifact.statusSummary.reasonCodes.NO_NEW_ITEMS, 1)
  })
})

test('market-jobs keeps low-confidence records when a visible card has no stable job id', async () => {
  await withTempOutput(async ({ outputPath }) => {
    const page = createMarketJobsPageFake({
      batches: [
        [
          marketJob({
            jobId: '',
            title: '数据标注兼职',
            company: 'Noise Co',
            city: '远程',
            salaryText: '200元/天',
          }),
        ],
      ],
    })

    const result = await runMarketJobsOnOpenPage(page, {
      keywords: ['数据'],
      cities: [{ cityInput: '全国', cityCode: '100010000' }],
      limit: 1,
      outputPath,
      navigationSettleMs: 0,
      scrollSettleMs: 0,
      now: new Date('2026-07-09T08:00:00.000Z'),
    })

    assert.equal(result.ok, true)
    const artifact = JSON.parse(fs.readFileSync(outputPath, 'utf8'))
    assert.equal(artifact.jobs.length, 1)
    assert.equal(artifact.jobs[0].jobIdentity.status, 'missing')
    assert.equal(artifact.jobs[0].jobIdentity.confidence, 'low')
    assert.equal(artifact.jobs[0].jobIdentity.validJobIdentityAnchor, false)
    assert.equal(artifact.jobs[0].jobIdentity.temporaryFingerprint.includes('数据标注兼职'), true)
    assert.equal(artifact.jobs[0].jobIdentity.fingerprint.includes('数据标注兼职'), true)
    assert.equal(artifact.statusSummary.observationCount, 1)
    assert.equal(artifact.statusSummary.lowConfidenceJobCount, 1)
    assert.equal(artifact.statusSummary.missingIdentityJobCount, 1)
  })
})

test('market-jobs does not duplicate a missing-id card seen again in the same sample', async () => {
  await withTempOutput(async ({ outputPath }) => {
    const missingJob = marketJob({
      jobId: '',
      title: '数据标注兼职',
      company: 'Noise Co',
      city: '远程',
      salaryText: '200元/天',
    })
    const page = createMarketJobsPageFake({
      batches: [
        [missingJob],
        [missingJob],
        [missingJob],
      ],
    })

    const result = await runMarketJobsOnOpenPage(page, {
      keywords: ['数据'],
      cities: [{ cityInput: '全国', cityCode: '100010000' }],
      limit: 3,
      outputPath,
      navigationSettleMs: 0,
      scrollSettleMs: 0,
      now: new Date('2026-07-09T08:00:00.000Z'),
    })

    assert.equal(result.ok, true)
    assert.equal(result.jobCount, 1)
    const artifact = JSON.parse(fs.readFileSync(outputPath, 'utf8'))
    assert.equal(artifact.samples[0].capturedCount, 1)
    assert.equal(artifact.samples[0].reasonCode, 'NO_NEW_ITEMS')
    assert.equal(artifact.statusSummary.observationCount, 1)
    assert.equal(artifact.jobs[0].observations[0].rank, 1)
  })
})

test('market-jobs stops with a partial artifact when the search list is blocked', async () => {
  await withTempOutput(async ({ outputPath }) => {
    const page = createMarketJobsPageFake({
      blockedReasonCode: 'BOSS_SAFETY_VERIFICATION_REQUIRED',
    })

    const result = await runMarketJobsOnOpenPage(page, {
      keywords: ['AI'],
      cities: [{ cityInput: '上海', cityCode: '101020100' }],
      limit: 10,
      outputPath,
      navigationSettleMs: 0,
      scrollSettleMs: 0,
      now: new Date('2026-07-09T08:00:00.000Z'),
    })

    assert.equal(result.ok, false)
    assert.equal(result.reasonCode, 'BOSS_SAFETY_VERIFICATION_REQUIRED')
    assert.equal(result.jobCount, 0)

    const artifact = JSON.parse(fs.readFileSync(outputPath, 'utf8'))
    assert.equal(artifact.ok, false)
    assert.equal(artifact.reasonCode, 'BOSS_SAFETY_VERIFICATION_REQUIRED')
    assert.equal(artifact.samples[0].status, 'blocked')
    assert.equal(artifact.samples[0].endedAt, '2026-07-09T08:00:00.000Z')
    assert.deepEqual(artifact.jobs, [])
  })
})

test('market-jobs browser crawl performs only read-only navigation and scroll operations', async () => {
  await withTempOutput(async ({ outputPath }) => {
    const basePage = createMarketJobsPageFake({
      batches: [
        [marketJob({ jobId: 'job-1', title: 'AI 工程师' })],
      ],
    })
    const accessedPageProps = new Set()
    const page = new Proxy(basePage, {
      get (target, prop, receiver) {
        if (typeof prop === 'string') accessedPageProps.add(prop)
        return Reflect.get(target, prop, receiver)
      },
    })

    const result = await runMarketJobsOnOpenPage(page, {
      keywords: ['AI'],
      cities: [{ cityInput: '北京', cityCode: '101010100' }],
      limit: 1,
      outputPath,
      navigationSettleMs: 0,
      scrollSettleMs: 0,
      now: new Date('2026-07-09T08:00:00.000Z'),
    })

    assert.equal(result.ok, true)
    const readOnlyPageProps = new Set(['url', 'goto', 'waitForFunction', 'evaluate'])
    for (const prop of accessedPageProps) {
      assert.equal(readOnlyPageProps.has(prop), true, `unexpected page operation: ${prop}`)
    }
    for (const forbidden of ['click', 'type', 'tap', 'uploadFile', 'keyboard', 'mouse', '$', '$$']) {
      assert.equal(accessedPageProps.has(forbidden), false, `real action attempted: ${forbidden}`)
    }
  })
})

test('market-jobs browser mode crawls Cartesian samples and globally dedupes stable jobs', async () => {
  await withTempOutput(async ({ outputPath }) => {
    const visitedUrls = []
    const page = createMarketJobsPageFake({
      sampleBatches: [
        [
          [
            marketJob({
              jobId: 'shared-job',
              title: 'AI Agent 工程师',
              contactEvidenceText: '立即沟通',
              sourceUrl: 'https://www.zhipin.com/web/geek/jobs?query=AI&city=101010100&securityId=secret&ka=chat-entry',
            }),
            marketJob({ jobId: 'ai-bj', title: 'AI 平台工程师' }),
          ],
        ],
        [
          [
            marketJob({ jobId: 'shared-job', title: 'AI Agent 工程师', contactEvidenceText: '继续沟通', contactState: 'contacted' }),
            marketJob({ jobId: 'ai-sh', title: 'AI 应用工程师' }),
          ],
        ],
        [
          [
            marketJob({ jobId: '', title: '数据标注兼职', company: 'Noise Co', salaryText: '200元/天' }),
            marketJob({ jobId: 'py-bj', title: 'Python 后端工程师' }),
          ],
        ],
        [
          [
            marketJob({ jobId: 'shared-job', title: 'AI Agent 工程师' }),
            marketJob({ jobId: 'py-sh', title: 'Python 平台工程师' }),
          ],
        ],
      ],
      onGoto: url => visitedUrls.push(url),
    })

    const result = await runMarketJobsOnOpenPage(page, {
      keywords: ['AI', 'Python'],
      cities: [
        { cityInput: '北京', cityCode: '101010100' },
        { cityInput: '上海', cityCode: '101020100' },
      ],
      limit: 2,
      outputPath,
      navigationSettleMs: 0,
      scrollSettleMs: 0,
      now: new Date('2026-07-09T08:00:00.000Z'),
    })

    assert.equal(result.ok, true)
    assert.equal(result.sampleCount, 4)
    assert.equal(result.jobCount, 6)
    assert.equal(result.statusSummary.observationCount, 8)
    assert.equal(result.statusSummary.dedupedJobCount, 6)
    assert.equal(result.statusSummary.lowConfidenceJobCount, 1)
    assert.equal(result.statusSummary.identityConfidence.low, 1)
    assert.equal(result.statusSummary.identityConfidence.high, 5)
    assert.equal(visitedUrls.length, 4)
    assert.deepEqual(visitedUrls.map(url => new URL(url).searchParams.get('query')), ['AI', 'AI', 'Python', 'Python'])
    assert.deepEqual(visitedUrls.map(url => new URL(url).searchParams.get('city')), ['101010100', '101020100', '101010100', '101020100'])

    const artifact = JSON.parse(fs.readFileSync(outputPath, 'utf8'))
    assert.deepEqual(artifact.samples.map(sample => sample.sampleKey), [
      'ai__101010100',
      'ai__101020100',
      'python__101010100',
      'python__101020100',
    ])
    assert.deepEqual(artifact.samples.map(sample => sample.capturedCount), [2, 2, 2, 2])
    assert.deepEqual(artifact.samples.map(sample => sample.dedupedJobCount), [2, 2, 2, 2])
    const sharedJob = artifact.jobs.find(job => job.jobIdentity.jobId === 'shared-job')
    assert.equal(sharedJob.observations.length, 3)
    assert.deepEqual(sharedJob.observations.map(observation => observation.sampleKey), [
      'ai__101010100',
      'ai__101020100',
      'python__101020100',
    ])
    assert.deepEqual(sharedJob.observations.map(observation => observation.rank), [1, 1, 1])
    assert.equal(sharedJob.observations[0].source.type, 'boss_geek_search_results')
    assert.equal(sharedJob.observations[0].source.url.includes('query=AI'), true)
    assert.equal(sharedJob.observations[0].source.url.includes('city=101010100'), true)
    assert.equal(sharedJob.observations[0].source.url.includes('securityId'), false)
    assert.equal(sharedJob.observations[0].source.url.includes('chat-entry'), false)
    assert.equal(sharedJob.observations[1].contactState, 'contacted')
    assert.equal(sharedJob.observations[1].contactEvidenceText, '继续沟通')
    assert.equal(sharedJob.observations[1].listText.includes('AI Agent 工程师'), true)

    const missingJob = artifact.jobs.find(job => job.jobIdentity.status === 'missing')
    assert.equal(missingJob.jobIdentity.confidence, 'low')
    assert.equal(missingJob.jobIdentity.validJobIdentityAnchor, false)
    assert.equal(missingJob.jobIdentity.temporaryFingerprint.includes('python__101010100'), true)
    assert.equal(missingJob.jobIdentity.temporaryFingerprint.includes('1'), true)
  })
})

test('market-jobs browser mode rejects analysis until the analysis slice exists', async () => {
  const result = await runMarketJobs({
    fromBrowser: true,
    keywords: ['AI'],
    cities: ['北京'],
    analyze: true,
  })

  assert.equal(result.ok, false)
  assert.equal(result.reasonCode, 'MARKET_JOBS_ANALYSIS_NOT_IMPLEMENTED')
})

test('market-jobs rejects limits above the per-sample maximum with a stable reason code', async () => {
  const result = await runMarketJobs({
    planOnly: true,
    keywords: ['AI Agent'],
    cities: ['上海'],
    limit: 501,
  })

  assert.equal(result.ok, false)
  assert.equal(result.command, 'market-jobs')
  assert.equal(result.reasonCode, 'LIMIT_EXCEEDS_MAX')
  assert.equal(result.maxLimit, 500)
})

test('market-jobs rejects --recall-keyword for market sampling', async () => {
  const result = await runMarketJobs({
    planOnly: true,
    recallKeywords: ['Python 后端'],
    keywords: [],
    cities: ['上海'],
  })

  assert.equal(result.ok, false)
  assert.equal(result.reasonCode, 'MARKET_KEYWORD_REQUIRED')
  assert.equal(result.error.includes('--keyword'), true)
  assert.equal(result.error.includes('--recall-keyword'), true)
})

function marketJob ({
  jobId = 'job-1',
  title = 'AI 工程师',
  company = 'Example Co',
  city = '北京',
  salaryText = '20-30K',
  experience = '1-3年',
  degree = '本科',
  positionCategory = '后端开发',
  tags = ['Python', 'LLM'],
  contactState = 'uncontacted',
  contactEvidenceText = '立即沟通',
  recruiter = { name: '王经理', title: '招聘经理', activeText: '刚刚活跃' },
  companySummary = { industry: '互联网', financingStage: 'B轮', size: '100-499人', tags: ['AI'] },
  sourceUrl = '',
  listText = `${title}\n${company}\n${salaryText}\n${contactEvidenceText}`,
} = {}) {
  const job = {
    jobId,
    title,
    company,
    city,
    salaryText,
    experience,
    degree,
    positionCategory,
    tags,
    contactState,
    contactEvidenceText,
    recruiter,
    companySummary,
    listText,
  }
  if (sourceUrl) job.sourceUrl = sourceUrl
  return job
}

function createMarketJobsPageFake ({
  batches = [[]],
  sampleBatches = null,
  blockedReasonCode = '',
  onGoto = () => {},
  failOnChatHistoryAccess = false,
} = {}) {
  let currentUrl = 'about:blank'
  let batchIndex = 0
  let sampleIndex = -1
  return {
    url () {
      return currentUrl
    },
    async goto (url) {
      currentUrl = url
      batchIndex = 0
      sampleIndex += 1
      onGoto(url)
    },
    async waitForFunction () {},
    async evaluate (fn) {
      const source = String(fn)
      if (failOnChatHistoryAccess && /chatStore|friendInfos|recent-applications|recentApplications/i.test(source)) {
        throw new Error('market-jobs attempted to access chat history sources')
      }
      if (source.includes('readMarketJobsListStateInPage')) {
        if (blockedReasonCode) {
          return {
            ok: false,
            reasonCode: blockedReasonCode,
            url: currentUrl,
            visibleText: blockedReasonCode,
            jobs: [],
          }
        }
        return {
          ok: true,
          url: currentUrl,
          jobs: getCurrentBatch(),
        }
      }
      if (source.includes('scrollMarketJobsListInPage')) {
        batchIndex += 1
        return { scrolled: true }
      }
      return null
    },
  }

  function getCurrentBatch () {
    const activeBatches = sampleBatches
      ? sampleBatches[Math.min(Math.max(sampleIndex, 0), sampleBatches.length - 1)] ?? []
      : batches
    const batch = activeBatches[Math.min(batchIndex, activeBatches.length - 1)] ?? []
    return batch.map((job, index) => ({ sourceRank: index + 1, ...job }))
  }
}

function withTempOutput (callback) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ggr-market-jobs-'))
  const outputPath = path.join(tempDir, 'market-jobs.json')
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
