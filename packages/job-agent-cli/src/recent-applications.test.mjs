import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import {
  analyzeApplicationPreferences,
  readChatStoreStateInPage,
  readJobDetailStateInPage,
  runRecentApplications,
  runRecentApplicationsOnOpenPage,
} from './recent-applications.mjs'

test('recent applications requires --from-browser before touching any browser', async () => {
  const result = await runRecentApplications({})

  assert.equal(result.ok, false)
  assert.equal(result.reasonCode, 'FROM_BROWSER_REQUIRED')
  assert.equal(result.command, 'recent-applications')
})

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

test('recent applications extraction fails closed when the chat page requires login', async () => {
  await withTempOutput(async ({ outputPath }) => {
    const page = createRecentApplicationsPageFake({
      loginRequired: true,
    })

    const result = await runRecentApplicationsOnOpenPage(page, {
      limit: 10,
      includeJd: true,
      outputPath,
      now: new Date('2026-07-07T10:00:00.000Z'),
    })

    assert.equal(result.ok, false)
    assert.equal(result.reasonCode, 'BOSS_LOGIN_REQUIRED')
    assert.equal(result.recordCount, 0)

    const artifact = JSON.parse(fs.readFileSync(outputPath, 'utf8'))
    assert.equal(artifact.ok, false)
    assert.equal(artifact.reasonCode, 'BOSS_LOGIN_REQUIRED')
    assert.deepEqual(artifact.records, [])
  })
})

test('recent applications extraction stops with a blocked record when a job detail page demands login', async () => {
  await withTempOutput(async ({ outputPath }) => {
    const page = createRecentApplicationsPageFake({
      friendInfos: [
        friendInfo({ id: 'expired-job', lastTS: 30, title: 'Python 后端', encryptJobId: 'expired-job' }),
      ],
      detailTextByJobId: {
        'expired-job': { visibleText: '当前状态已失效，请登录后继续操作' },
      },
    })

    const result = await runRecentApplicationsOnOpenPage(page, {
      limit: 10,
      includeJd: true,
      outputPath,
      now: new Date('2026-07-07T10:00:00.000Z'),
    })

    assert.equal(result.ok, false)
    assert.equal(result.reasonCode, 'BOSS_LOGIN_REQUIRED')
    assert.equal(result.statusSummary.blocked, 1)

    const artifact = JSON.parse(fs.readFileSync(outputPath, 'utf8'))
    assert.equal(artifact.records[0].status, 'blocked')
    assert.equal(artifact.records[0].jd.reasonCode, 'BOSS_LOGIN_REQUIRED')
    assert.equal(artifact.statusSummary.reasonCodes.BOSS_LOGIN_REQUIRED, 1)
  })
})

test('recent applications extraction orders records correctly across second and millisecond timestamps', async () => {
  await withTempOutput(async ({ outputPath }) => {
    const page = createRecentApplicationsPageFake({
      friendInfos: [
        friendInfo({
          id: 'older-in-milliseconds',
          lastTS: 1600000000000,
          title: '2020 年的旧会话',
        }),
        friendInfo({
          id: 'newer-in-seconds',
          lastTS: 1751900000,
          title: '2026 年的新会话',
        }),
      ],
    })

    const result = await runRecentApplicationsOnOpenPage(page, {
      limit: 10,
      includeJd: false,
      outputPath,
      now: new Date('2026-07-07T10:00:00.000Z'),
    })

    assert.equal(result.ok, true)
    const artifact = JSON.parse(fs.readFileSync(outputPath, 'utf8'))
    assert.equal(artifact.records[0].conversationId, 'newer-in-seconds')
    assert.equal(artifact.records[0].timestamp, 1751900000000)
    assert.equal(artifact.records[1].conversationId, 'older-in-milliseconds')
  })
})

test('recent applications --analyze writes a deterministic preference analysis artifact and reports its path', async () => {
  await withTempOutput(async ({ outputPath }) => {
    const page = createRecentApplicationsPageFake({
      friendInfos: [
        friendInfo({
          id: 'target-job',
          lastTS: 30,
          title: 'AI Agent 后端开发',
          company: 'Target Co',
          city: '上海',
          positionCategory: '后端开发',
          encryptJobId: 'target-job',
        }),
        friendInfo({
          id: 'noise-job',
          lastTS: 20,
          title: '数据标注专员',
          company: 'Noise Co',
          city: '远程',
          positionCategory: '数据标注',
          encryptJobId: 'noise-job',
        }),
      ],
      detailTextByJobId: {
        'target-job': { jdText: '负责 Python FastAPI 服务与 LLM 工作流。' },
        'noise-job': { jdText: '负责数据标注与语料整理，兼职远程。' },
      },
    })

    const result = await runRecentApplicationsOnOpenPage(page, {
      limit: 10,
      includeJd: true,
      analyze: true,
      outputPath,
      now: new Date('2026-07-07T10:00:00.000Z'),
    })

    assert.equal(result.ok, true)
    assert.equal(result.analysisArtifactPath, outputPath.replace(/\.json$/, '.analysis.json'))
    assert.equal(fs.existsSync(result.analysisArtifactPath), true)

    const analysis = JSON.parse(fs.readFileSync(result.analysisArtifactPath, 'utf8'))
    assert.equal(analysis.schemaVersion, 'recent-application-preferences.v1')
    assert.equal(analysis.generatedAt, '2026-07-07T10:00:00.000Z')
    assert.equal(analysis.sourceArtifactPath, outputPath)
    assert.equal(analysis.titleCategoryCounts.ai_llm_agent_aigc, 1)
    assert.equal(analysis.titleCategoryCounts.data_annotation_ai_training, 1)
    assert.equal(analysis.jdTermCounts.python, 1)
    assert.equal(analysis.jdTermCounts.annotation, 1)
    assert.equal(analysis.coreTargetExamples[0].title, 'AI Agent 后端开发')
    assert.equal(analysis.likelyNoiseExamples[0].title, '数据标注专员')
    assert.equal(analysis.recruiterLastMessageExamples.length, 2)
  })
})

test('recent applications crawl performs only read-only page operations and records no authorization', async () => {
  await withTempOutput(async ({ outputPath }) => {
    const basePage = createRecentApplicationsPageFake({
      friendInfos: [
        friendInfo({ id: 'job-1', lastTS: 30, title: 'AI Agent 工程师', encryptJobId: 'job-1' }),
      ],
      detailTextByJobId: {
        'job-1': { jdText: '负责 LLM 应用开发。' },
      },
    })
    const accessedPageProps = new Set()
    const page = new Proxy(basePage, {
      get (target, prop, receiver) {
        if (typeof prop === 'string') accessedPageProps.add(prop)
        return Reflect.get(target, prop, receiver)
      },
    })

    const result = await runRecentApplicationsOnOpenPage(page, {
      limit: 10,
      includeJd: true,
      analyze: true,
      outputPath,
      now: new Date('2026-07-07T10:00:00.000Z'),
    })

    assert.equal(result.ok, true)
    const readOnlyPageProps = new Set(['url', 'goto', 'waitForFunction', 'evaluate'])
    for (const prop of accessedPageProps) {
      assert.equal(readOnlyPageProps.has(prop), true, `unexpected page operation: ${prop}`)
    }
    for (const forbidden of ['click', 'type', 'tap', 'uploadFile', 'keyboard', 'mouse', '$', '$$']) {
      assert.equal(accessedPageProps.has(forbidden), false, `real action attempted: ${forbidden}`)
    }

    const artifact = JSON.parse(fs.readFileSync(outputPath, 'utf8'))
    assert.equal(artifact.captureMetadata.readOnly, true)
    assert.equal(artifact.captureMetadata.authorization.issuesApplicationAuthorization, false)
    assert.equal(artifact.captureMetadata.authorization.consumesApplicationAuthorizationToken, false)
    assert.equal(artifact.sourceStrategy.browserActions, 'read_only_navigation')
  })
})

test('default artifacts drop unknown browser state fields and secrets from chat store records', async () => {
  await withTempOutput(async ({ outputPath }) => {
    const page = createRecentApplicationsPageFake({
      friendInfos: [
        {
          ...friendInfo({
            id: 'job-1',
            lastTS: 30,
            title: 'AI 平台工程师',
            encryptJobId: 'job-1',
            securityId: 'CANARY_SECURITY_ID_VALUE',
          }),
          cookies: 'CANARY_COOKIES_VALUE',
          localStorageDump: 'CANARY_LOCAL_STORAGE_VALUE',
          resumeImagePath: 'C:/Users/geek/CANARY_RESUME_PATH.png',
          apiKey: 'CANARY_API_KEY_VALUE',
          browserState: { wsEndpoint: 'CANARY_BROWSER_STATE_VALUE' },
        },
      ],
      detailTextByJobId: {
        'job-1': { jdText: '负责 AI 平台建设。' },
      },
    })

    const result = await runRecentApplicationsOnOpenPage(page, {
      limit: 10,
      includeJd: true,
      analyze: true,
      outputPath,
      now: new Date('2026-07-07T10:00:00.000Z'),
    })

    assert.equal(result.ok, true)
    const rawArtifactText = fs.readFileSync(outputPath, 'utf8')
    const analysisArtifactText = fs.readFileSync(result.analysisArtifactPath, 'utf8')
    assert.equal(rawArtifactText.includes('CANARY_'), false)
    assert.equal(analysisArtifactText.includes('CANARY_'), false)

    const artifact = JSON.parse(rawArtifactText)
    assert.equal(artifact.records[0].jobIdentityAnchor.hasSecurityId, true)
    assert.equal(artifact.records[0].jobIdentityAnchor.securityIdRedacted.includes('CANARY_'), false)
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
      lastMessage: { text: '方便的话可以发一份简历', direction: 'boss' },
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
  assert.equal(analysis.recruiterLastMessageExamples[0].direction, 'boss')
  assert.equal(analysis.recruiterLastMessageExamples[1].direction, '')
})

test('preference analysis counts Chinese-only AI titles without requiring ASCII word boundaries', () => {
  const analysis = analyzeApplicationPreferences([
    {
      rank: 1,
      title: '大模型应用工程师',
      company: 'Chinese Title Co',
      city: '北京',
      positionCategory: '人工智能',
      jd: { text: '负责智能体平台建设。' },
    },
  ])

  assert.equal(analysis.titleCategoryCounts.ai_llm_agent_aigc, 1)
  assert.equal(analysis.jdTermCounts.llm, 1)
  assert.equal(analysis.coreTargetExamples.length, 1)
})

test('in-page chat store reader detects login walls, safety checks, missing stores, and object maps', () => {
  const loginState = withPageGlobals({
    document: { body: { innerText: '微信扫码登录 手机验证码登录' } },
    location: { href: 'https://www.zhipin.com/web/user/?ka=header-login' },
    window: {},
  }, () => readChatStoreStateInPage())
  assert.equal(loginState.ok, false)
  assert.equal(loginState.reasonCode, 'BOSS_LOGIN_REQUIRED')

  const safetyState = withPageGlobals({
    document: { body: { innerText: '安全验证 请拖动滑块完成拼图' } },
    location: { href: 'https://www.zhipin.com/web/common/security-check.html' },
    window: {},
  }, () => readChatStoreStateInPage())
  assert.equal(safetyState.ok, false)
  assert.equal(safetyState.reasonCode, 'BOSS_SAFETY_VERIFICATION_REQUIRED')

  const missingStoreState = withPageGlobals({
    document: { body: { innerText: '最近联系人 全部消息' } },
    location: { href: 'https://www.zhipin.com/web/geek/chat' },
    window: {},
  }, () => readChatStoreStateInPage())
  assert.equal(missingStoreState.ok, false)
  assert.equal(missingStoreState.reasonCode, 'BOSS_CHAT_STORE_UNAVAILABLE')

  const objectMapState = withPageGlobals({
    document: { body: { innerText: '最近联系人 全部消息' } },
    location: { href: 'https://www.zhipin.com/web/geek/chat' },
    window: { chatStore: { friendInfos: { first: { friendId: 'first' }, second: { friendId: 'second' } } } },
  }, () => readChatStoreStateInPage())
  assert.equal(objectMapState.ok, true)
  assert.deepEqual(objectMapState.friendInfos, [{ friendId: 'first' }, { friendId: 'second' }])
})

test('in-page job detail reader extracts the JD from the primary job-sec-text selector', () => {
  const body = domNode('body', {
    children: [
      domNode('div', {
        className: 'job-detail-section',
        children: [
          domNode('h3', { className: 'job-sec-title', text: '职位描述' }),
          domNode('div', { className: 'job-sec-text', text: '负责 LLM Agent 平台的后端研发。' }),
        ],
      }),
      domNode('span', { className: 'salary', text: '25-35K' }),
    ],
  })

  const state = withPageGlobals({
    document: createFakeDocument(body, { title: 'AI 平台工程师_BOSS直聘' }),
    location: { href: 'https://www.zhipin.com/job_detail/enc-1.html' },
  }, () => readJobDetailStateInPage())

  assert.equal(state.jdText, '负责 LLM Agent 平台的后端研发。')
  assert.equal(state.pageTitle, 'AI 平台工程师_BOSS直聘')
  assert.equal(state.salary, '25-35K')
})

test('in-page job detail reader falls back to the 职位描述 heading section when job-sec-text is missing', () => {
  const body = domNode('body', {
    children: [
      domNode('section', {
        children: [
          domNode('h3', { text: '职位描述' }),
          domNode('p', { text: '负责数据管道与自动化工具建设。' }),
        ],
      }),
    ],
  })

  const state = withPageGlobals({
    document: createFakeDocument(body, { title: '数据工程师_BOSS直聘' }),
    location: { href: 'https://www.zhipin.com/job_detail/enc-2.html' },
  }, () => readJobDetailStateInPage())

  assert.equal(state.jdText, '负责数据管道与自动化工具建设。')
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
  loginRequired = false,
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
        if (loginRequired) {
          return {
            ok: false,
            reasonCode: 'BOSS_LOGIN_REQUIRED',
            url: currentUrl,
            visibleText: '登录/注册 扫码登录',
          }
        }
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
          visibleText: detail.visibleText ??
            (detail.safetyVerification ? '安全验证 拖动滑块后继续' : detail.jdText ?? ''),
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

function domNode (tagName, { className = '', text = '', children = [] } = {}) {
  const node = {
    tagName: tagName.toLowerCase(),
    className,
    children,
    parent: null,
    get innerText () {
      return [text, ...children.map(child => child.innerText)].filter(Boolean).join('\n')
    },
    get textContent () {
      return [text, ...children.map(child => child.textContent)].filter(Boolean).join(' ')
    },
    closest (selector) {
      let current = node
      while (current) {
        if (nodeMatchesSelector(current, selector)) return current
        current = current.parent
      }
      return null
    },
    querySelector (selector) {
      return descendantsOf(node).find(item => nodeMatchesSelector(item, selector)) ?? null
    },
  }
  for (const child of children) child.parent = node
  return node
}

function descendantsOf (node) {
  return node.children.flatMap(child => [child, ...descendantsOf(child)])
}

function nodeMatchesSelector (node, selectorList) {
  return String(selectorList).split(',').some(chain => nodeMatchesChain(node, chain.trim()))
}

function nodeMatchesChain (node, chain) {
  const parts = chain.split(/\s+/)
  if (!nodeMatchesSimple(node, parts[parts.length - 1])) return false
  let current = node.parent
  let index = parts.length - 2
  while (index >= 0) {
    while (current && !nodeMatchesSimple(current, parts[index])) current = current.parent
    if (!current) return false
    current = current.parent
    index -= 1
  }
  return true
}

function nodeMatchesSimple (node, simple) {
  if (simple.startsWith('.')) return node.className.split(/\s+/).includes(simple.slice(1))
  const classContains = simple.match(/^\[class\*="([^"]+)"\]$/)
  if (classContains) return node.className.includes(classContains[1])
  return node.tagName === simple.toLowerCase()
}

function createFakeDocument (rootNode, { title = '' } = {}) {
  return {
    title,
    body: rootNode,
    querySelector: selector => rootNode.querySelector(selector),
    querySelectorAll: selector => descendantsOf(rootNode).filter(item => nodeMatchesSelector(item, selector)),
  }
}

function withPageGlobals ({ document, location, window }, callback) {
  const globalKeys = ['document', 'location', 'window']
  const savedGlobals = globalKeys.map(key => [
    key,
    Object.prototype.hasOwnProperty.call(globalThis, key),
    globalThis[key],
  ])
  if (document !== undefined) globalThis.document = document
  if (location !== undefined) globalThis.location = location
  if (window !== undefined) globalThis.window = window
  try {
    return callback()
  } finally {
    for (const [key, hadOwn, value] of savedGlobals) {
      if (hadOwn) globalThis[key] = value
      else delete globalThis[key]
    }
  }
}
