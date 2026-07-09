import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'

import { runMarketJobs } from './market-jobs.mjs'

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

test('market-jobs rejects browser mode until the browser-backed slice exists', async () => {
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
