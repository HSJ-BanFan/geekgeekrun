import path from 'node:path'
import { storageFilePath } from '@geekgeekrun/geek-auto-start-chat-with-boss/runtime-file-utils.mjs'
import { resolveCityCode } from './city-codes.mjs'

const commandName = 'market-jobs'
const artifactSchemaVersion = 'market-jobs.v1'
const defaultLimit = 200
const maxLimit = 500

export async function runMarketJobs ({
  fromBrowser = false,
  planOnly = false,
  keywords = [],
  cities = [],
  recallKeywords = [],
  limit = defaultLimit,
  analyze = false,
  outputPath = '',
  analysisOutputPath = '',
  now = new Date(),
} = {}) {
  if (!planOnly && !fromBrowser) {
    return failure('FROM_BROWSER_REQUIRED', 'market-jobs requires --from-browser unless --plan-only is set')
  }

  if (!planOnly) {
    return failure('MARKET_JOBS_BROWSER_MODE_NOT_IMPLEMENTED', 'browser-backed market-jobs crawl is not implemented in this slice')
  }

  const marketKeywords = normalizeList(keywords)
  const legacyRecallKeywords = normalizeList(recallKeywords)
  if (!marketKeywords.length) {
    return failure(
      'MARKET_KEYWORD_REQUIRED',
      legacyRecallKeywords.length
        ? 'market-jobs uses --keyword; do not use --recall-keyword for Market Keywords'
        : 'market-jobs requires at least one --keyword'
    )
  }

  const cityInputs = normalizeList(cities)
  if (!cityInputs.length) {
    return failure('MARKET_CITY_REQUIRED', 'market-jobs requires at least one --city')
  }

  const limitResult = normalizeLimit(limit)
  if (!limitResult.ok) {
    return {
      ...failure(limitResult.reasonCode, limitResult.error),
      maxLimit,
    }
  }

  const resolvedCities = []
  for (const cityInput of cityInputs) {
    const cityCode = resolveCityCode(cityInput)
    if (!cityCode) {
      return failure('MARKET_CITY_NOT_RESOLVED', `could not resolve BOSS city code for --city ${cityInput}`)
    }
    resolvedCities.push({ cityInput, cityCode })
  }

  const captureTime = toIso(now)
  const rawArtifactPath = resolveMarketJobsOutputPath(outputPath, captureTime)
  const plannedSamples = buildPlannedSamples({
    keywords: marketKeywords,
    cities: resolvedCities,
    requestedLimit: limitResult.limit,
  })

  return {
    ok: true,
    command: commandName,
    mode: 'plan-only',
    schemaVersion: artifactSchemaVersion,
    sampleCount: plannedSamples.length,
    jobCount: 0,
    requestedLimitPerSample: limitResult.limit,
    plannedRecordBudget: plannedSamples.length * limitResult.limit,
    statusSummary: {},
    rawArtifactPath,
    analysisArtifactPath: analyze ? resolveAnalysisOutputPath(analysisOutputPath, rawArtifactPath) : null,
    reasonCode: null,
    plannedSamples,
  }
}

function buildPlannedSamples ({ keywords, cities, requestedLimit }) {
  const samples = []
  for (const keyword of keywords) {
    for (const city of cities) {
      samples.push({
        sampleKey: `${slugKeyword(keyword)}__${city.cityCode}`,
        keyword,
        cityInput: city.cityInput,
        cityCode: city.cityCode,
        requestedLimit,
        plannedRankStart: 1,
        plannedRankEnd: requestedLimit,
      })
    }
  }
  return samples
}

function normalizeLimit (value) {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return { ok: false, reasonCode: 'LIMIT_INVALID', error: '--limit must be a positive integer' }
  }
  if (parsed > maxLimit) {
    return { ok: false, reasonCode: 'LIMIT_EXCEEDS_MAX', error: `--limit must be less than or equal to ${maxLimit}` }
  }
  return { ok: true, limit: parsed }
}

function resolveMarketJobsOutputPath (outputPath, captureTime) {
  if (outputPath) return path.resolve(outputPath)
  return path.join(storageFilePath, 'market-jobs', `market-jobs-${fileTimestamp(captureTime)}.json`)
}

function resolveAnalysisOutputPath (analysisOutputPath, rawArtifactPath) {
  if (analysisOutputPath) return path.resolve(analysisOutputPath)
  return rawArtifactPath.replace(/\.json$/i, '.analysis.json')
}

function normalizeList (value) {
  const items = Array.isArray(value) ? value : value == null ? [] : [value]
  return items
    .map(item => String(item ?? '').trim())
    .filter(Boolean)
}

function slugKeyword (value) {
  const slug = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'keyword'
}

function failure (reasonCode, error) {
  return {
    ok: false,
    command: commandName,
    reasonCode,
    error,
  }
}

function toIso (value) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function fileTimestamp (iso) {
  return String(iso).replace(/[:.]/g, '-')
}
