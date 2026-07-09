import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import {
  analyzeMarketJobs,
  readMarketJobsListStateInPage,
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
    const visitedUrls = []
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
      onGoto: url => visitedUrls.push(url),
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
    assert.equal(visitedUrls.length, 1)
    assert.equal(new URL(visitedUrls[0]).pathname, '/web/geek/jobs')

    const artifact = JSON.parse(fs.readFileSync(outputPath, 'utf8'))
    assert.equal(artifact.schemaVersion, 'market-jobs.v1')
    assert.equal(artifact.captureMetadata.readOnly, true)
    assert.equal(artifact.captureMetadata.authorization.applicationAuthorizationScope, 'none')
    assert.equal(artifact.captureMetadata.authorization.marketEvidenceAuthorizesApplicationActions, false)
    assert.equal(artifact.captureMetadata.authorization.issuesApplicationAuthorizationToken, false)
    assert.equal(artifact.captureMetadata.authorization.issuesApplicationAuthorization, false)
    assert.equal(artifact.captureMetadata.authorization.consumesApplicationAuthorizationToken, false)
    assert.equal(artifact.captureMetadata.authorization.authorizationTokenIssued, false)
    assert.equal(artifact.captureMetadata.authorization.authorizationTokenConsumed, false)
    assert.equal(artifact.sourceStrategy.list, 'boss_geek_search_results')
    assert.equal(artifact.sourceStrategy.jd, 'not_requested')
    assert.equal(artifact.sourceStrategy.browserActions, 'read_only_list_scroll')
    assert.equal(artifact.samples[0].sampleKey, 'ai-agent__101020100')
    assert.equal(artifact.samples[0].status, 'ok')
    assert.equal(artifact.samples[0].reasonCode, 'LIMIT_REACHED')
    assert.equal(artifact.samples[0].capturedCount, 2)
    assert.equal(artifact.samples[0].dedupedJobCount, 2)
    assert.equal(artifact.jobs.length, 2)
    assert.equal(artifact.jobs[0].jobIdentity.status, 'stable')
    assert.deepEqual(artifact.jobs[0].jd, { status: 'skipped', reasonCode: 'JD_NOT_REQUESTED' })
    assert.equal(artifact.jobs[0].observations[0].sampleKey, 'ai-agent__101020100')
    assert.equal(artifact.jobs[0].observations[0].rank, 1)
    assert.equal(artifact.jobs[1].contactState, 'contacted')
  })
})

test('market-jobs raw artifact redacts browser state, secrets, action URLs, and resume paths', async () => {
  await withTempOutput(async ({ outputPath }) => {
    const page = createMarketJobsPageFake({
      batches: [
        [
          {
            ...marketJob({
              jobId: 'privacy-job',
              title: 'AI 工程师',
              detailUrl: 'https://www.zhipin.com/job_detail/privacy-job.html?securityId=RAW_SECURITY_ID_SHOULD_NOT_PERSIST&ka=chat-entry',
              sourceUrl: 'https://www.zhipin.com/web/geek/jobs?query=AI&city=101010100&securityId=RAW_SOURCE_SECURITY_ID&ka=chat-entry',
              listText: [
                'AI 工程师',
                'cookies=COOKIE_CANARY_SHOULD_NOT_PERSIST',
                'localStorage=LOCAL_STORAGE_CANARY_SHOULD_NOT_PERSIST',
                'api_key=API_KEY_CANARY_SHOULD_NOT_PERSIST',
                'token=TOKEN_CANARY_SHOULD_NOT_PERSIST',
                'C:\\Users\\Private\\resume-market.pdf',
                'https://img.bosszhipin.com/avatar/CANARY_AVATAR_URL.png',
                'https://example.com/users/CANARY_HOMEPAGE_URL',
                'https://www.zhipin.com/web/geek/chat?ka=chat-entry&securityId=CANARY_CHAT_SECURITY',
              ].join('\n'),
            }),
            securityId: 'RAW_SECURITY_ID_FIELD_SHOULD_NOT_PERSIST',
            cookies: 'COOKIE_FIELD_SHOULD_NOT_PERSIST',
            localStorage: 'LOCAL_STORAGE_FIELD_SHOULD_NOT_PERSIST',
            apiKey: 'API_KEY_FIELD_SHOULD_NOT_PERSIST',
            resumePath: 'C:\\Users\\Private\\resume-field.pdf',
            avatarUrl: 'https://img.bosszhipin.com/avatar/FIELD_AVATAR.png',
            homepageUrl: 'https://example.com/FIELD_HOMEPAGE',
            browserState: { localStorage: 'FULL_BROWSER_STATE_SHOULD_NOT_PERSIST' },
          },
        ],
      ],
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
    assert.equal(Object.hasOwn(result, 'jobs'), false)
    assert.equal(Object.hasOwn(result, 'observations'), false)

    const artifactText = fs.readFileSync(outputPath, 'utf8')
    for (const forbidden of [
      'COOKIE_CANARY_SHOULD_NOT_PERSIST',
      'LOCAL_STORAGE_CANARY_SHOULD_NOT_PERSIST',
      'API_KEY_CANARY_SHOULD_NOT_PERSIST',
      'TOKEN_CANARY_SHOULD_NOT_PERSIST',
      'RAW_SECURITY_ID_SHOULD_NOT_PERSIST',
      'RAW_SOURCE_SECURITY_ID',
      'RAW_SECURITY_ID_FIELD_SHOULD_NOT_PERSIST',
      'COOKIE_FIELD_SHOULD_NOT_PERSIST',
      'LOCAL_STORAGE_FIELD_SHOULD_NOT_PERSIST',
      'API_KEY_FIELD_SHOULD_NOT_PERSIST',
      'resume-market.pdf',
      'resume-field.pdf',
      'CANARY_AVATAR_URL',
      'CANARY_HOMEPAGE_URL',
      'CANARY_CHAT_SECURITY',
      'FIELD_AVATAR',
      'FIELD_HOMEPAGE',
      'FULL_BROWSER_STATE_SHOULD_NOT_PERSIST',
      'ka=chat-entry',
    ]) {
      assert.equal(artifactText.includes(forbidden), false, `artifact leaked ${forbidden}`)
    }
    assert.equal(artifactText.includes('[REDACTED_BROWSER_STATE]'), true)
    assert.equal(artifactText.includes('[REDACTED_SECRET]'), true)
    assert.equal(artifactText.includes('[REDACTED_RESUME_PATH]'), true)
    assert.equal(artifactText.includes('[REDACTED_URL]'), true)
  })
})

test('market-jobs enriches JD from detail DOM only when --include-jd is requested', async () => {
  await withTempOutput(async ({ outputPath }) => {
    const visitedUrls = []
    const page = createMarketJobsPageFake({
      batches: [
        [
          marketJob({
            jobId: 'enc-job-1',
            title: 'AI Agent 后端开发',
            detailUrl: 'https://www.zhipin.com/job_detail/enc-job-1.html?securityId=secret&ka=search_list',
          }),
          marketJob({
            jobId: 'enc-job-2',
            title: 'Python 平台工程师',
            detailUrl: 'https://www.zhipin.com/job_detail/enc-job-2.html',
          }),
        ],
      ],
      detailTextByJobId: {
        'enc-job-1': {
          jdText: '负责 AI Agent 平台后端研发，建设工具调用和评测体系。',
          pageTitle: 'AI Agent 后端开发招聘',
          evidenceText: '职位描述',
        },
        'enc-job-2': {
          jdText: '负责 Python 数据平台服务开发。',
          pageTitle: 'Python 平台工程师招聘',
          evidenceText: '岗位职责',
        },
      },
      onGoto: url => visitedUrls.push(url),
    })

    const result = await runMarketJobsOnOpenPage(page, {
      keywords: ['AI Agent'],
      cities: [{ cityInput: '上海', cityCode: '101020100' }],
      limit: 2,
      includeJd: true,
      outputPath,
      navigationSettleMs: 0,
      scrollSettleMs: 0,
      detailNavigationSettleMs: 0,
      now: new Date('2026-07-09T08:00:00.000Z'),
    })

    assert.equal(result.ok, true)
    assert.equal(result.jobCount, 2)
    assert.equal(result.statusSummary.jd.ok, 2)
    assert.deepEqual(visitedUrls.map(url => new URL(url).pathname), [
      '/web/geek/jobs',
      '/job_detail/enc-job-1.html',
      '/job_detail/enc-job-2.html',
    ])

    const artifact = JSON.parse(fs.readFileSync(outputPath, 'utf8'))
    assert.equal(artifact.sourceStrategy.jd, 'boss_job_detail_dom')
    assert.equal(artifact.sourceStrategy.browserActions, 'read_only_list_scroll_then_sequential_detail_navigation')
    assert.equal(artifact.jobs[0].jd.status, 'ok')
    assert.equal(artifact.jobs[0].jd.source, 'boss_job_detail_dom')
    assert.equal(artifact.jobs[0].jd.text, '负责 AI Agent 平台后端研发，建设工具调用和评测体系。')
    assert.equal(artifact.jobs[0].jd.characterCount, Array.from('负责 AI Agent 平台后端研发，建设工具调用和评测体系。').length)
    assert.equal(artifact.jobs[0].jd.resolvedUrl.includes('securityId=%5BREDACTED%5D'), true)
    assert.equal(artifact.jobs[0].jd.resolvedUrl.includes('secret'), false)
    assert.equal(artifact.jobs[0].detailUrlEvidence.url.includes('secret'), false)
    assert.deepEqual(artifact.jobs.map(job => job.jd.status), ['ok', 'ok'])
  })
})

test('market-jobs combined --include-jd --analyze keeps stdout summary-only and analysis JD-free', async () => {
  await withTempOutput(async ({ outputPath }) => {
    const jdText = 'FULL_JD_TEXT_CANARY_FOR_RAW_ARTIFACT_ONLY 负责 AI Agent 平台研发。'
    const accessedPageProps = new Set()
    const basePage = createMarketJobsPageFake({
      batches: [
        [
          marketJob({
            jobId: 'combined-job',
            title: 'AI Agent 后端开发',
            contactState: 'uncontacted',
            contactEvidenceText: '立即沟通',
          }),
        ],
      ],
      detailTextByJobId: {
        'combined-job': {
          jdText,
          pageTitle: 'AI Agent 后端开发招聘',
          evidenceText: '职位描述',
        },
      },
    })
    const page = new Proxy(basePage, {
      get (target, prop, receiver) {
        if (typeof prop === 'string') accessedPageProps.add(prop)
        return Reflect.get(target, prop, receiver)
      },
    })

    const result = await runMarketJobsOnOpenPage(page, {
      keywords: ['AI Agent'],
      cities: [{ cityInput: '上海', cityCode: '101020100' }],
      limit: 1,
      includeJd: true,
      analyze: true,
      outputPath,
      navigationSettleMs: 0,
      scrollSettleMs: 0,
      detailNavigationSettleMs: 0,
      now: new Date('2026-07-09T08:00:00.000Z'),
    })

    assert.equal(result.ok, true)
    assert.equal(result.command, 'market-jobs')
    assert.equal(Object.hasOwn(result, 'jobs'), false)
    assert.equal(Object.hasOwn(result, 'observations'), false)
    assert.equal(JSON.stringify(result).includes(jdText), false)

    const rawArtifact = JSON.parse(fs.readFileSync(outputPath, 'utf8'))
    assert.equal(rawArtifact.jobs[0].jd.text, jdText)
    const analysisText = fs.readFileSync(result.analysisArtifactPath, 'utf8')
    assert.equal(analysisText.includes(jdText), false)

    const readOnlyPageProps = new Set(['url', 'goto', 'waitForFunction', 'evaluate'])
    for (const prop of accessedPageProps) {
      assert.equal(readOnlyPageProps.has(prop), true, `unexpected page operation: ${prop}`)
    }
    for (const forbidden of ['click', 'type', 'tap', 'uploadFile', 'keyboard', 'mouse', '$', '$$']) {
      assert.equal(accessedPageProps.has(forbidden), false, `real action attempted: ${forbidden}`)
    }
  })
})

test('market-jobs stops with a partial artifact when JD enrichment is blocked', async () => {
  await withTempOutput(async ({ outputPath }) => {
    const page = createMarketJobsPageFake({
      batches: [
        [
          marketJob({ jobId: 'safe-job', title: 'AI 工程师' }),
          marketJob({ jobId: 'blocked-job', title: 'LLM 工程师' }),
        ],
      ],
      detailTextByJobId: {
        'safe-job': { jdText: '正常职位描述' },
        'blocked-job': {
          visibleText: '安全验证 拖动滑块后继续',
          jdText: '',
        },
      },
    })

    const result = await runMarketJobsOnOpenPage(page, {
      keywords: ['AI'],
      cities: [{ cityInput: '上海', cityCode: '101020100' }],
      limit: 2,
      includeJd: true,
      outputPath,
      navigationSettleMs: 0,
      scrollSettleMs: 0,
      detailNavigationSettleMs: 0,
      now: new Date('2026-07-09T08:00:00.000Z'),
    })

    assert.equal(result.ok, false)
    assert.equal(result.reasonCode, 'BOSS_SAFETY_VERIFICATION_REQUIRED')
    assert.equal(result.jobCount, 2)
    assert.equal(result.statusSummary.partial, 1)
    assert.equal(result.statusSummary.jd.ok, 1)
    assert.equal(result.statusSummary.jd.blocked, 1)

    const artifact = JSON.parse(fs.readFileSync(outputPath, 'utf8'))
    assert.equal(artifact.ok, false)
    assert.equal(artifact.reasonCode, 'BOSS_SAFETY_VERIFICATION_REQUIRED')
    assert.equal(artifact.jobs[0].jd.status, 'ok')
    assert.equal(artifact.jobs[1].jd.status, 'blocked')
    assert.equal(artifact.jobs[1].jd.reasonCode, 'BOSS_SAFETY_VERIFICATION_REQUIRED')
    assert.equal(artifact.statusSummary.blockingReasonCode, 'BOSS_SAFETY_VERIFICATION_REQUIRED')
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
    assert.equal(artifact.statusSummary.stopped, 1)
    assert.equal(artifact.statusSummary.blocked, 1)
    assert.equal(artifact.statusSummary.partial, 1)
    assert.equal(artifact.statusSummary.blockingReasonCode, 'BOSS_SAFETY_VERIFICATION_REQUIRED')
    assert.equal(artifact.statusSummary.reasonCodes.BOSS_SAFETY_VERIFICATION_REQUIRED, 1)
    assert.deepEqual(artifact.jobs, [])
  })
})

test('market-jobs stops on login expiration after preserving completed sample data', async () => {
  await withTempOutput(async ({ outputPath }) => {
    const page = createMarketJobsPageFake({
      sampleBatches: [
        [[marketJob({ jobId: 'safe-job', title: 'AI Agent 工程师' })]],
        [[]],
      ],
      sampleFailures: ['', 'BOSS_LOGIN_REQUIRED'],
    })

    const result = await runMarketJobsOnOpenPage(page, {
      keywords: ['AI', 'Python'],
      cities: [{ cityInput: '上海', cityCode: '101020100' }],
      limit: 1,
      outputPath,
      navigationSettleMs: 0,
      scrollSettleMs: 0,
      now: new Date('2026-07-09T08:00:00.000Z'),
    })

    assert.equal(result.ok, false)
    assert.equal(result.reasonCode, 'BOSS_LOGIN_REQUIRED')
    assert.equal(result.jobCount, 1)
    assert.equal(result.statusSummary.ok, 1)
    assert.equal(result.statusSummary.blocked, 1)
    assert.equal(result.statusSummary.stopped, 1)
    assert.equal(result.statusSummary.partial, 1)
    assert.equal(result.statusSummary.blockingReasonCode, 'BOSS_LOGIN_REQUIRED')

    const artifact = JSON.parse(fs.readFileSync(outputPath, 'utf8'))
    assert.equal(artifact.ok, false)
    assert.equal(artifact.reasonCode, 'BOSS_LOGIN_REQUIRED')
    assert.deepEqual(artifact.samples.map(sample => sample.status), ['ok', 'blocked'])
    assert.deepEqual(artifact.samples.map(sample => sample.reasonCode), ['LIMIT_REACHED', 'BOSS_LOGIN_REQUIRED'])
    assert.equal(artifact.jobs.length, 1)
    assert.equal(artifact.jobs[0].jobIdentity.jobId, 'safe-job')
    assert.equal(artifact.statusSummary.reasonCodes.BOSS_LOGIN_REQUIRED, 1)
  })
})

test('market-jobs stops on abnormal environment with a blocked partial artifact', async () => {
  await withTempOutput(async ({ outputPath }) => {
    const page = createMarketJobsPageFake({
      blockedReasonCode: 'BOSS_ABNORMAL_ENVIRONMENT',
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
    assert.equal(result.reasonCode, 'BOSS_ABNORMAL_ENVIRONMENT')

    const artifact = JSON.parse(fs.readFileSync(outputPath, 'utf8'))
    assert.equal(artifact.samples[0].status, 'blocked')
    assert.equal(artifact.statusSummary.stopped, 1)
    assert.equal(artifact.statusSummary.partial, 1)
    assert.equal(artifact.statusSummary.blockingReasonCode, 'BOSS_ABNORMAL_ENVIRONMENT')
    assert.equal(artifact.statusSummary.reasonCodes.BOSS_ABNORMAL_ENVIRONMENT, 1)
  })
})

test('market-jobs stops when the search list DOM is unavailable after navigation', async () => {
  await withTempOutput(async ({ outputPath }) => {
    const page = createMarketJobsPageFake({
      blockedReasonCode: 'BOSS_SEARCH_LIST_UNAVAILABLE',
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
    assert.equal(result.reasonCode, 'BOSS_SEARCH_LIST_UNAVAILABLE')

    const artifact = JSON.parse(fs.readFileSync(outputPath, 'utf8'))
    assert.equal(artifact.samples[0].status, 'blocked')
    assert.equal(artifact.statusSummary.stopped, 1)
    assert.equal(artifact.statusSummary.partial, 1)
    assert.equal(artifact.statusSummary.blockingReasonCode, 'BOSS_SEARCH_LIST_UNAVAILABLE')
    assert.equal(artifact.statusSummary.reasonCodes.BOSS_SEARCH_LIST_UNAVAILABLE, 1)
  })
})

test('market-jobs ordinary sample exhaustion continues with subsequent samples', async () => {
  await withTempOutput(async ({ outputPath }) => {
    const visitedUrls = []
    const page = createMarketJobsPageFake({
      sampleBatches: [
        [
          [marketJob({ jobId: 'ai-job', title: 'AI 工程师' })],
          [marketJob({ jobId: 'ai-job', title: 'AI 工程师' })],
          [marketJob({ jobId: 'ai-job', title: 'AI 工程师' })],
        ],
        [
          [marketJob({ jobId: 'python-job', title: 'Python 工程师' })],
          [marketJob({ jobId: 'python-job', title: 'Python 工程师' })],
          [marketJob({ jobId: 'python-job', title: 'Python 工程师' })],
        ],
      ],
      onGoto: url => visitedUrls.push(url),
    })

    const result = await runMarketJobsOnOpenPage(page, {
      keywords: ['AI', 'Python'],
      cities: [{ cityInput: '上海', cityCode: '101020100' }],
      limit: 5,
      outputPath,
      navigationSettleMs: 0,
      scrollSettleMs: 0,
      now: new Date('2026-07-09T08:00:00.000Z'),
    })

    assert.equal(result.ok, true)
    assert.equal(result.reasonCode, null)
    assert.equal(result.sampleCount, 2)
    assert.equal(result.jobCount, 2)
    assert.equal(visitedUrls.length, 2)

    const artifact = JSON.parse(fs.readFileSync(outputPath, 'utf8'))
    assert.deepEqual(artifact.samples.map(sample => sample.status), ['ok', 'ok'])
    assert.deepEqual(artifact.samples.map(sample => sample.reasonCode), ['NO_NEW_ITEMS', 'NO_NEW_ITEMS'])
    assert.deepEqual(artifact.samples.map(sample => sample.capturedCount), [1, 1])
    assert.equal(artifact.statusSummary.stopped, 0)
    assert.equal(artifact.statusSummary.blocked, 0)
    assert.equal(artifact.statusSummary.partial, 0)
    assert.equal(artifact.statusSummary.reasonCodes.NO_NEW_ITEMS, 2)
  })
})

test('in-page market list reader reports missing list DOM as a stable stop reason', () => {
  const state = withPageGlobals({
    document: {
      body: { innerText: '搜索结果正在加载' },
      querySelectorAll: () => [],
    },
    location: { href: 'https://www.zhipin.com/web/geek/jobs?query=AI&city=101020100' },
  }, () => readMarketJobsListStateInPage())

  assert.equal(state.ok, false)
  assert.equal(state.reasonCode, 'BOSS_SEARCH_LIST_UNAVAILABLE')
  assert.equal(state.jobs.length, 0)
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

test('market-jobs module does not depend on application action, token, upload, or history paths', () => {
  const moduleSource = fs.readFileSync(new URL('./market-jobs.mjs', import.meta.url), 'utf8')
  for (const forbidden of [
    './authorized-action.mjs',
    './authorization-token.mjs',
    './recent-applications.mjs',
    'runAuthorizedActionIntent',
    'issueAuthorizationToken',
    'consumeAuthorizationToken',
    'sendGreetingToMostRecentChat',
    'startChatOnCurrentJob',
    'runCurrentJobBrowserActions',
    'uploadFile',
    'chatStore',
    'friendInfos',
    'recentApplications',
  ]) {
    assert.equal(moduleSource.includes(forbidden), false, `market-jobs reached forbidden path: ${forbidden}`)
  }
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

test('market-jobs --analyze writes a deterministic analysis artifact and reports its path', async () => {
  await withTempOutput(async ({ outputPath }) => {
    const page = createMarketJobsPageFake({
      batches: [
        [
          marketJob({
            jobId: 'target-job',
            title: 'AI Agent 后端开发',
            company: 'Target Co',
            city: '上海',
            salaryText: '25-35K',
            experience: '3-5年',
            degree: '本科',
            tags: ['LLM', 'Python'],
            contactState: 'uncontacted',
            companySummary: { industry: '人工智能', financingStage: 'B轮', size: '100-499人', tags: [] },
          }),
          marketJob({
            jobId: '',
            title: '数据标注兼职',
            company: 'Noise Co',
            city: '远程',
            salaryText: '200元/天',
            experience: '经验不限',
            degree: '学历不限',
            positionCategory: '数据标注',
            tags: [],
            contactState: 'uncontacted',
            companySummary: { industry: '外包服务', financingStage: '未融资', size: '0-20人', tags: [] },
          }),
          marketJob({
            jobId: 'contacted-job',
            title: 'Java 后端开发',
            company: 'Contacted Co',
            city: '上海',
            salaryText: '18-25K',
            tags: [],
            contactState: 'contacted',
            contactEvidenceText: '继续沟通',
          }),
        ],
      ],
    })

    const result = await runMarketJobsOnOpenPage(page, {
      keywords: ['AI Agent'],
      cities: [{ cityInput: '上海', cityCode: '101020100' }],
      limit: 3,
      analyze: true,
      outputPath,
      navigationSettleMs: 0,
      scrollSettleMs: 0,
      now: new Date('2026-07-09T08:00:00.000Z'),
    })

    assert.equal(result.ok, true)
    assert.equal(result.analysisArtifactPath, outputPath.replace(/\.json$/, '.analysis.json'))
    assert.equal(fs.existsSync(result.analysisArtifactPath), true)

    const analysis = JSON.parse(fs.readFileSync(result.analysisArtifactPath, 'utf8'))
    assert.equal(analysis.schemaVersion, 'market-jobs-analysis.v1')
    assert.equal(analysis.source.schemaVersion, 'market-jobs.v1')
    assert.equal(analysis.jobSetSummary.totalJobCount, 3)
    assert.equal(analysis.jobSetSummary.marketSupplyJobCount, 2)
    assert.equal(analysis.jobSetSummary.actionableJobCount, 1)
    assert.equal(analysis.categoryCounts.ai_llm_agent_aigc, 1)
    assert.equal(analysis.categoryCounts.data_annotation_ai_training, 1)
    assert.equal(analysis.categoryCounts.java_traditional_backend, 0)
    assert.equal(analysis.salaryBuckets.monthly_high.count, 1)
    assert.equal(analysis.salaryBuckets.daily_rate.count, 1)
    assert.equal(analysis.salaryBuckets.monthly_high.examples[0].salaryText, '25-35K')
    assert.equal(analysis.experienceBuckets.three_to_five_years, 1)
    assert.equal(analysis.experienceBuckets.no_experience_required, 1)
    assert.equal(analysis.degreeBuckets.bachelor, 1)
    assert.equal(analysis.degreeBuckets.no_degree_requirement, 1)
    assert.deepEqual(analysis.contactStateBreakdown, { uncontacted: 2, contacted: 1 })
    assert.deepEqual(analysis.identityConfidenceBreakdown, { high: 1, low: 1 })
    assert.equal(analysis.sampleBreakdown[0].marketSupplyJobCount, 2)
    assert.equal(analysis.sampleBreakdown[0].actionableJobCount, 1)
    assert.equal(analysis.coreTargetExamples[0].jobId, 'target-job')
    assert.equal(analysis.likelyNoiseExamples[0].title, '数据标注兼职')
  })
})

test('market-jobs analysis covers deterministic market buckets, examples, and sample breakdown', () => {
  const analysis = analyzeMarketJobs({
    schemaVersion: 'market-jobs.v1',
    samples: [
      {
        sampleKey: 'ai__101020100',
        keyword: 'AI',
        cityInput: '上海',
        cityCode: '101020100',
        requestedLimit: 10,
        capturedCount: 3,
        dedupedJobCount: 3,
        status: 'ok',
        reasonCode: 'LIMIT_REACHED',
      },
      {
        sampleKey: 'front__101010100',
        keyword: '前端',
        cityInput: '北京',
        cityCode: '101010100',
        requestedLimit: 10,
        capturedCount: 1,
        dedupedJobCount: 1,
        status: 'ok',
        reasonCode: 'NO_NEW_ITEMS',
      },
    ],
    jobs: [
      marketAnalysisJob({
        jobId: 'ai-1',
        title: 'AI Agent 全栈工程师',
        city: '上海',
        salaryText: '20-30K',
        experience: '1-3年',
        degree: '本科',
        positionCategory: '全栈开发',
        tags: ['LLM'],
        contactState: 'uncontacted',
        industry: '人工智能',
        size: '100-499人',
        financingStage: 'B轮',
        sampleKeys: ['ai__101020100'],
      }),
      marketAnalysisJob({
        jobId: '',
        title: '日语数据标注兼职',
        city: '远程',
        salaryText: '300元/天',
        experience: '',
        degree: '',
        positionCategory: '数据标注',
        tags: ['兼职'],
        contactState: 'uncontacted',
        confidence: 'low',
        identityStatus: 'missing',
        industry: '外包服务',
        size: '0-20人',
        financingStage: '未融资',
        sampleKeys: ['ai__101020100'],
      }),
      marketAnalysisJob({
        jobId: 'mixed-1',
        title: 'AI 测试实习生',
        city: '上海',
        salaryText: '薪资面议',
        experience: '在校/应届',
        degree: '大专',
        positionCategory: '测试',
        tags: [],
        contactState: 'uncontacted',
        sampleKeys: ['ai__101020100'],
      }),
      marketAnalysisJob({
        jobId: 'contacted-front',
        title: 'React 前端工程师',
        city: '北京',
        salaryText: '15-20K',
        experience: '3-5年',
        degree: '硕士',
        positionCategory: '前端开发',
        tags: ['Vue'],
        contactState: 'contacted',
        sampleKeys: ['front__101010100'],
      }),
    ],
  })

  assert.equal(analysis.jobSetSummary.totalJobCount, 4)
  assert.equal(analysis.jobSetSummary.marketSupplyJobCount, 3)
  assert.equal(analysis.jobSetSummary.actionableJobCount, 2)
  assert.equal(analysis.categoryCounts.ai_llm_agent_aigc, 2)
  assert.equal(analysis.categoryCounts.full_stack, 1)
  assert.equal(analysis.categoryCounts.frontend_react_vue, 0)
  assert.equal(analysis.categoryCounts.data_annotation_ai_training, 1)
  assert.equal(analysis.categoryCounts.translation_localization_japanese, 1)
  assert.equal(analysis.categoryCounts.testing_it_generic, 1)
  assert.equal(analysis.categoryCounts.remote_part_time, 1)
  assert.equal(analysis.categoryCounts.internship_new_grad, 1)
  assert.equal(analysis.salaryBuckets.monthly_mid.count, 1)
  assert.equal(analysis.salaryBuckets.daily_rate.count, 1)
  assert.equal(analysis.salaryBuckets.negotiable.count, 1)
  assert.equal(analysis.salaryBuckets.monthly_mid.examples[0].salaryText, '20-30K')
  assert.equal(analysis.experienceBuckets.one_to_three_years, 1)
  assert.equal(analysis.experienceBuckets.unknown, 1)
  assert.equal(analysis.experienceBuckets.new_grad_or_internship, 1)
  assert.equal(analysis.degreeBuckets.bachelor, 1)
  assert.equal(analysis.degreeBuckets.unknown, 1)
  assert.equal(analysis.degreeBuckets.junior_college, 1)
  assert.deepEqual(analysis.contactStateBreakdown, { uncontacted: 3, contacted: 1 })
  assert.deepEqual(analysis.identityConfidenceBreakdown, { high: 2, low: 1 })
  assert.deepEqual(analysis.topCities, [
    { value: '上海', count: 2 },
    { value: '远程', count: 1 },
  ])
  assert.equal(analysis.sampleBreakdown[0].sampleKey, 'ai__101020100')
  assert.equal(analysis.sampleBreakdown[0].marketSupplyJobCount, 3)
  assert.equal(analysis.sampleBreakdown[0].actionableJobCount, 2)
  assert.equal(analysis.sampleBreakdown[1].marketSupplyJobCount, 0)
  assert.equal(analysis.coreTargetExamples[0].title, 'AI Agent 全栈工程师')
  assert.equal(analysis.likelyNoiseExamples[0].title, '日语数据标注兼职')
  assert.equal(analysis.mixedTargetNoiseExamples[0].title, 'AI 测试实习生')
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
  detailUrl = '',
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
  if (detailUrl) job.detailUrl = detailUrl
  return job
}

function marketAnalysisJob ({
  jobId = 'job-1',
  title = 'AI 工程师',
  company = 'Example Co',
  city = '北京',
  salaryText = '20-30K',
  experience = '1-3年',
  degree = '本科',
  positionCategory = '后端开发',
  tags = [],
  contactState = 'uncontacted',
  confidence = 'high',
  identityStatus = 'stable',
  industry = '',
  size = '',
  financingStage = '',
  sampleKeys = ['sample__101010100'],
} = {}) {
  return {
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
    jobIdentity: {
      status: identityStatus,
      jobId,
      confidence,
      validJobIdentityAnchor: identityStatus === 'stable',
    },
    companySummary: {
      industry,
      size,
      financingStage,
    },
    observations: sampleKeys.map((sampleKey, index) => ({
      sampleKey,
      rank: index + 1,
      contactState,
    })),
  }
}

function createMarketJobsPageFake ({
  batches = [[]],
  sampleBatches = null,
  blockedReasonCode = '',
  sampleFailures = [],
  detailTextByJobId = {},
  onGoto = () => {},
  failOnChatHistoryAccess = false,
} = {}) {
  let currentUrl = 'about:blank'
  let currentJobId = ''
  let batchIndex = 0
  let sampleIndex = -1
  return {
    url () {
      return currentUrl
    },
    async goto (url) {
      currentUrl = url
      const detailMatch = String(url).match(/job_detail\/([^/.?]+)\.html/)
      currentJobId = detailMatch?.[1] ? decodeURIComponent(detailMatch[1]) : ''
      if (!currentJobId) {
        batchIndex = 0
        sampleIndex += 1
      }
      onGoto(url)
    },
    async waitForFunction () {},
    async evaluate (fn) {
      const source = String(fn)
      if (failOnChatHistoryAccess && /chatStore|friendInfos|recent-applications|recentApplications/i.test(source)) {
        throw new Error('market-jobs attempted to access chat history sources')
      }
      if (source.includes('readMarketJobsListStateInPage')) {
        const currentBlockedReasonCode = getCurrentBlockedReasonCode()
        if (currentBlockedReasonCode) {
          return {
            ok: false,
            reasonCode: currentBlockedReasonCode,
            url: currentUrl,
            visibleText: currentBlockedReasonCode,
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
      if (source.includes('readMarketJobDetailStateInPage')) {
        const detail = detailTextByJobId[currentJobId] ?? {}
        return {
          url: currentUrl,
          pageTitle: detail.pageTitle ?? '',
          visibleText: detail.visibleText ?? detail.jdText ?? '',
          jdText: detail.jdText ?? '',
          evidenceText: detail.evidenceText ?? '',
        }
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

  function getCurrentBlockedReasonCode () {
    const sampleFailure = sampleFailures[Math.min(Math.max(sampleIndex, 0), sampleFailures.length - 1)]
    return sampleFailure || blockedReasonCode
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

function withPageGlobals ({ document, location }, callback) {
  const globalKeys = ['document', 'location']
  const savedGlobals = globalKeys.map(key => [
    key,
    Object.prototype.hasOwnProperty.call(globalThis, key),
    globalThis[key],
  ])
  if (document !== undefined) globalThis.document = document
  if (location !== undefined) globalThis.location = location
  try {
    return callback()
  } finally {
    for (const [key, hadOwn, value] of savedGlobals) {
      if (hadOwn) globalThis[key] = value
      else delete globalThis[key]
    }
  }
}
