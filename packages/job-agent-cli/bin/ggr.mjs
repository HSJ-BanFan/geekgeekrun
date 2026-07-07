#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import util from 'node:util'
import minimist from 'minimist'
import cityGroupData from '@geekgeekrun/geek-auto-start-chat-with-boss/cityGroup.mjs'
import { loadRuntimeConfig, getEnabledRecallKeywords, getGreetingRules, getResumeImagePath } from '../src/config.mjs'
import { normalizeJobProfile } from '../src/job-profile.mjs'
import { evaluateJobWithRules, selectGreetingWithPlan } from '../src/policy.mjs'
import { evaluateJobWithLlm } from '../src/llm-evaluator.mjs'
import { resolveFinalDecision } from '../src/final-decision.mjs'
import { buildCandidateProfile, summarizeCandidateProfile } from '../src/candidate-profile.mjs'
import { buildOrRefreshCapabilityProfile, inspectCapabilityProfileCache } from '../src/capability-profile.mjs'
import {
  buildGuardedPersonalizedGreetingPlan,
  buildGuardedPersonalizedGreetingSelection,
  getGreetingPlanTextSkipReason,
} from '../src/greeting-plan.mjs'
import {
  consumeAuthorizationToken,
  inspectAuthorizationToken,
  issueAuthorizationToken,
} from '../src/authorization-token.mjs'
import {
  extractCurrentJobFromBrowser,
  extractCurrentJobOnPage,
  moveToNextJob,
  openBrowser,
  openJobsPage,
  runCurrentJobBrowserActions,
  runCurrentJobBrowserActionsOnOpenPage,
  sendGreetingToMostRecentChat,
  startChatOnCurrentJob,
} from '../src/browser-actions.mjs'
import { appendAuditLog, buildAuditRecord, createRunId } from '../src/audit-log.mjs'

let flatCityListCache = null

const argv = minimist(process.argv.slice(2), {
  boolean: ['from-browser', 'headless', 'llm', 'confirm', 'refresh'],
  string: [
    'job',
    'title',
    'jd',
    'target-count',
    'max-candidates',
    'candidate-timeout-ms',
    'progress-file',
    'recall-keyword',
    'city',
    'salary',
    'event',
    'evaluation',
    'llm-evaluation',
    'actions',
    'error',
    'audit-file',
    'allowed-action',
    'token-file',
    'token-id',
    'ttl-ms',
    'expires-at',
    'now',
    'action',
    'run-id',
    'final-decision',
  ],
})
const [command] = argv._
captureInternalConsoleOutput({ debug: argv.debug })

try {
  const result = await dispatch(command, argv)
  writeJson(result)
} catch (err) {
  writeJson({ ok: false, error: err?.message ?? String(err), stack: argv.debug ? err?.stack : undefined })
  process.exit(1)
}

async function dispatch (command, argv) {
  switch (command) {
    case 'snapshot':
      return snapshot()
    case 'capability-profile':
      return capabilityProfile(argv)
    case 'extract-job':
      return extractJob(argv)
    case 'evaluate-job':
      return evaluateJob(argv)
    case 'greeting-preview':
      return greetingPreview(argv)
    case 'start-chat':
      return startChat(argv)
    case 'send-greeting':
      return sendGreeting(argv)
    case 'next-job':
      return nextJob(argv)
    case 'audit-log':
      return auditLog(argv)
    case 'authorization-token':
      return authorizationToken(argv)
    case 'run-once':
      return runOnce(argv)
    case 'run-batch':
      return runBatch(argv)
    default:
      return usage()
  }
}

function snapshot () {
  const { boss, llm, storageFilePath } = loadRuntimeConfig()
  const candidateProfile = buildCandidateProfile(boss)
  const capabilityProfile = inspectCapabilityProfileCache({ bossConfig: boss, candidateProfile })
  return {
    ok: true,
    command: 'snapshot',
    storageFilePath,
    candidateProfile: summarizeCandidateProfile(candidateProfile),
    capabilityProfile,
    recallKeywordCount: getEnabledRecallKeywords(boss).length,
    recallKeywords: getEnabledRecallKeywords(boss),
    staticConditionCount: boss.staticCombineRecommendJobFilterConditions?.length ?? 0,
    combineRecommendJobFilterType: boss.combineRecommendJobFilterType,
    rotateJobSourceAfterChatStartup: boss.rotateJobSourceAfterChatStartup,
    greetingRules: getGreetingRules(boss).map(rule => ({ name: rule.name, pattern: rule.pattern })),
    resumeImageConfigured: Boolean(getResumeImagePath(boss)),
    llmConfigured: hasLlmConfig(llm),
  }
}

async function capabilityProfile (argv) {
  const { boss, llm } = loadRuntimeConfig()
  const candidateProfile = buildCandidateProfile(boss)
  const result = await buildOrRefreshCapabilityProfile({
    bossConfig: boss,
    candidateProfile,
    llmConfig: llm,
    forceRefresh: argv.refresh,
  })
  if (!result.ok) process.exitCode = 1
  return {
    ...result,
    command: 'capability-profile',
  }
}

async function extractJob (argv) {
  if (argv['from-browser']) {
    const extracted = await extractCurrentJobFromBrowser({ headless: argv.headless, ...browserJobSourceOptions(argv) })
    return { ok: true, command: 'extract-job', source: 'browser', ...extracted }
  }
  const profile = await readJobFromArgs(argv)
  return { ok: true, command: 'extract-job', source: argv.job ? 'file' : 'args', profile }
}

async function evaluateJob (argv) {
  const profile = await readJobFromArgs(argv)
  const { boss, llm } = loadRuntimeConfig()
  const candidateProfile = buildCandidateProfile(boss)
  const candidateProfileSummary = summarizeCandidateProfile(candidateProfile)
  const ruleEvaluation = evaluateJobWithRules(profile, boss, candidateProfile)
  const llmEvaluation = argv.llm
    ? await evaluateJobWithLlm({ job: profile, ruleEvaluation, llmConfig: llm, candidateProfile })
    : null
  const finalDecision = resolveFinalDecision(ruleEvaluation, llmEvaluation)
  return { ok: true, command: 'evaluate-job', profile, candidateProfile: candidateProfileSummary, ruleEvaluation, llmEvaluation, finalDecision }
}

async function greetingPreview (argv) {
  const profile = await readJobFromArgs(argv)
  const { boss, llm } = loadRuntimeConfig()
  const candidateProfile = buildCandidateProfile(boss)
  const candidateProfileSummary = summarizeCandidateProfile(candidateProfile)
  const { greetingPlan: fallbackPlan } = selectGreetingWithPlan(profile, boss)
  const greetingPlan = await buildGuardedPersonalizedGreetingPlan({
    job: profile,
    bossConfig: boss,
    candidateProfile,
    llmConfig: llm,
    fallbackPlan,
  })

  return {
    ok: true,
    command: 'greeting-preview',
    profile,
    candidateProfile: candidateProfileSummary,
    greetingPlan,
  }
}

async function sendGreeting (argv) {
  const profile = await readJobFromArgs(argv)
  const { boss } = loadRuntimeConfig()
  const { greeting, greetingPlan } = selectGreetingWithPlan(profile, boss)
  const result = await sendGreetingToMostRecentChat({
    message: greeting.message,
    imagePath: getResumeImagePath(boss),
    confirm: argv.confirm,
    headless: argv.headless,
  })
  return { ok: true, command: 'send-greeting', greeting, greetingPlan, result }
}

async function startChat (argv) {
  if (!argv['from-browser']) {
    throw new Error('START_CHAT_REQUIRES_FROM_BROWSER')
  }
  const result = await startChatOnCurrentJob({
    confirm: argv.confirm,
    headless: argv.headless,
    ...browserJobSourceOptions(argv),
  })
  return { ok: true, command: 'start-chat', result }
}

async function nextJob (argv) {
  const result = await moveToNextJob({
    confirm: argv.confirm,
    headless: argv.headless,
    ...browserJobSourceOptions(argv),
  })
  return { ok: true, command: 'next-job', result }
}

async function auditLog (argv) {
  const entry = argv.event
    ? readJsonFile(argv.event)
    : buildAuditRecord({
        runId: argv['run-id'] || createRunId(),
        command: 'audit-log',
        dryRun: !argv.confirm,
        profile: hasJobArgs(argv) ? await readJobFromArgs(argv) : null,
        ruleEvaluation: readOptionalJsonFile(argv.evaluation),
        llmEvaluation: readOptionalJsonFile(argv['llm-evaluation']),
        finalDecision: argv['final-decision'] ? { decision: argv['final-decision'], source: 'cli' } : null,
        actions: readOptionalJsonFile(argv.actions) ?? [],
        errors: normalizeErrors(argv.error),
      })
  const result = appendAuditLog(entry, { auditFile: argv['audit-file'] })
  return { ok: true, command: 'audit-log', result }
}

async function authorizationToken (argv) {
  const subcommand = argv._[1]
  switch (subcommand) {
    case 'issue':
      return issueAuthorizationTokenCommand(argv)
    case 'inspect':
      return inspectAuthorizationTokenCommand(argv)
    case 'consume':
      return consumeAuthorizationTokenCommand(argv)
    default:
      return {
        ok: true,
        command: 'authorization-token',
        subcommands: ['issue', 'inspect', 'consume'],
      }
  }
}

async function issueAuthorizationTokenCommand (argv) {
  const profile = await readJobFromArgs(argv)
  const result = issueAuthorizationToken({
    runId: argv['run-id'],
    job: profile,
    finalDecision: readFinalDecisionArg(argv['final-decision']),
    ruleEvaluation: readOptionalJsonFile(argv.evaluation),
    llmEvaluation: readOptionalJsonFile(argv['llm-evaluation']),
    allowedActions: getAllowedActions(argv),
    ttlMs: argv['ttl-ms'] ? Number(argv['ttl-ms']) : undefined,
    expiresAt: argv['expires-at'],
    now: argv.now ? new Date(argv.now) : new Date(),
    tokenFile: argv['token-file'],
  })
  return {
    command: 'authorization-token',
    action: 'issue',
    ...result,
  }
}

function inspectAuthorizationTokenCommand (argv) {
  const result = inspectAuthorizationToken({
    tokenId: argv['token-id'],
    tokenFile: argv['token-file'],
    now: argv.now ? new Date(argv.now) : new Date(),
    action: argv.action,
  })
  return {
    command: 'authorization-token',
    action: 'inspect',
    ...result,
  }
}

function consumeAuthorizationTokenCommand (argv) {
  const result = consumeAuthorizationToken({
    tokenId: argv['token-id'],
    tokenFile: argv['token-file'],
    now: argv.now ? new Date(argv.now) : new Date(),
    action: argv.action,
  })
  return {
    command: 'authorization-token',
    action: 'consume',
    ...result,
  }
}

async function runOnce (argv) {
  const runId = argv['run-id'] || createRunId()
  const actions = []
  const errors = []
  let ok = true
  let error = null
  let extraction = null
  let profile = null
  let candidateProfile = null
  let candidateProfileSummary = null
  let ruleEvaluation = null
  let llmEvaluation = null
  let finalDecision = null
  let auditResult = null
  let deliveryGreetingMessage = ''
  let deliveryGreetingMessageSkipReason = ''
  let deliveryResumeImagePath = ''

  try {
    extraction = argv['from-browser']
      ? { source: 'browser', ...(await extractCurrentJobFromBrowser({ headless: argv.headless, ...browserJobSourceOptions(argv) })) }
      : { source: argv.job ? 'file' : 'args', profile: await readJobFromArgs(argv) }
    profile = extraction.profile
    const { boss, llm } = loadRuntimeConfig()
    candidateProfile = buildCandidateProfile(boss)
    candidateProfileSummary = summarizeCandidateProfile(candidateProfile)
    ruleEvaluation = evaluateJobWithRules(profile, boss, candidateProfile)
    deliveryGreetingMessage = ruleEvaluation.greetingMessage
    deliveryResumeImagePath = ruleEvaluation.resumeImagePath
    llmEvaluation = argv.llm
      ? await evaluateJobWithLlm({ job: profile, ruleEvaluation, llmConfig: llm, candidateProfile })
      : null
    finalDecision = resolveFinalDecision(ruleEvaluation, llmEvaluation)

    if (finalDecision.decision === 'apply') {
      const greetingSelection = await buildGuardedPersonalizedGreetingSelection({
        job: profile,
        bossConfig: boss,
        candidateProfile,
        llmConfig: llm,
        fallbackGreeting: {
          rule: ruleEvaluation.greetingTemplate,
          message: ruleEvaluation.greetingMessage,
        },
        fallbackPlan: ruleEvaluation.greetingPlan,
      })
      deliveryGreetingMessage = greetingSelection.greeting.message
      ruleEvaluation = applyGreetingSelectionToRuleEvaluation(ruleEvaluation, greetingSelection)
    }
    deliveryGreetingMessageSkipReason = getGreetingPlanTextSkipReason(ruleEvaluation?.greetingPlan, deliveryGreetingMessage)
    if (deliveryGreetingMessageSkipReason) deliveryGreetingMessage = ''

    if (argv['from-browser']) {
      const browserActionResult = await runCurrentJobBrowserActions({
        shouldApply: finalDecision.decision === 'apply',
        message: deliveryGreetingMessage,
        messageSkipReason: deliveryGreetingMessageSkipReason,
        imagePath: deliveryResumeImagePath,
        confirm: argv.confirm,
        headless: argv.headless,
        expectedJob: profile,
        moveNext: true,
        ...browserJobSourceOptions(argv),
        beforeMoveNext: ({ actions: browserActions }) => {
          auditResult = appendAuditLog(
            buildAuditRecord({
              runId,
              command: 'run-once',
              dryRun: !argv.confirm,
              extraction,
              profile,
              candidateProfile: candidateProfileSummary,
              ruleEvaluation,
              llmEvaluation,
              finalDecision,
              actions: browserActions,
              errors,
            }),
            { auditFile: argv['audit-file'] }
          )
          return auditResult
        },
      })
      actions.push(...browserActionResult.actions)
    } else if (finalDecision.decision === 'apply') {
      const result = await sendGreetingToMostRecentChat({
        message: deliveryGreetingMessage,
        messageSkipReason: deliveryGreetingMessageSkipReason,
        imagePath: deliveryResumeImagePath,
        confirm: argv.confirm,
        headless: argv.headless,
      })
      actions.push({ type: 'send_greeting', result })
    } else {
      actions.push({
        type: 'skip_apply',
        dryRun: !argv.confirm,
        reason: `final decision: ${finalDecision.decision}`,
      })
    }
  } catch (err) {
    ok = false
    error = err?.message ?? String(err)
    errors.push({ message: error, stack: argv.debug ? err?.stack : undefined })
    process.exitCode = 1
  }

  try {
    if (!auditResult) auditResult = appendAuditLog(
      buildAuditRecord({
        runId,
        command: 'run-once',
        dryRun: !argv.confirm,
        extraction,
        profile,
        candidateProfile: candidateProfileSummary,
        ruleEvaluation,
        llmEvaluation,
        finalDecision,
        actions,
        errors,
      }),
      { auditFile: argv['audit-file'] }
    )
  } catch (err) {
    const auditError = `AUDIT_LOG_FAILED: ${err?.message ?? String(err)}`
    errors.push({ message: auditError, stack: argv.debug ? err?.stack : undefined })
    if (ok) {
      ok = false
      error = auditError
      process.exitCode = 1
    }
  }

  const sendAction = actions.find(action => action.type === 'send_greeting')
  return {
    ok,
    command: 'run-once',
    runId,
    error,
    profile,
    candidateProfile: candidateProfileSummary,
    ruleEvaluation,
    llmEvaluation,
    finalDecision,
    actions,
    sendResult: sendAction?.result ?? null,
    auditResult,
    errors,
  }
}

async function runBatch (argv) {
  const targetCount = toPositiveInt(argv['target-count'], 20)
  const maxCandidates = toPositiveInt(argv['max-candidates'], Math.max(targetCount * 8, targetCount))
  const candidateTimeoutMs = toPositiveInt(argv['candidate-timeout-ms'], 240000)
  const progressFile = argv['progress-file'] ? String(argv['progress-file']) : ''
  const batchRunId = argv['run-id'] || createRunId()
  const { boss, llm } = loadRuntimeConfig()
  const candidateProfile = buildCandidateProfile(boss)
  const candidateProfileSummary = summarizeCandidateProfile(candidateProfile)
  const queries = getBatchRecallKeywords(argv, boss)
  const cityCodes = getBatchCityCodes(argv, boss)
  const results = []
  const errors = []
  const visited = new Set()
  let sentCount = 0
  let examinedCount = 0
  let browser = null
  let page = null
  let browserOpenCount = 0

  const openBatchBrowser = async (reason) => {
    browserOpenCount += 1
    const opened = await openBrowser({ headless: argv.headless })
    browser = opened.browser
    page = opened.page
    appendBatchStage(progressFile, {
      batchRunId,
      targetCount,
      sentCount,
      stage: 'browser:opened',
      reason,
      browserOpenCount,
    })
  }

  const closeBatchBrowser = async () => {
    const currentBrowser = browser
    browser = null
    page = null
    await currentBrowser?.close?.().catch(() => {})
  }

  await openBatchBrowser('initial')
  try {
    for (const query of queries) {
      if (sentCount >= targetCount || examinedCount >= maxCandidates) break
      for (const city of cityCodes) {
        if (sentCount >= targetCount || examinedCount >= maxCandidates) break
        appendBatchStage(progressFile, {
          batchRunId,
          query,
          city,
          targetCount,
          sentCount,
          stage: 'search:open:start',
        })
        await openJobsPage(page, { query, city })
        appendBatchStage(progressFile, {
          batchRunId,
          query,
          city,
          targetCount,
          sentCount,
          stage: 'search:open:done',
        })

        while (sentCount < targetCount && examinedCount < maxCandidates) {
          const candidateIndex = examinedCount + 1
          const runId = `${batchRunId}-${String(candidateIndex).padStart(3, '0')}`
          let auditResult = null
          let profile = null
          let ruleEvaluation = null
          let llmEvaluation = null
          let finalDecision = null
          let actions = []
          let result = null
          let error = null
          let needsBrowserRestart = false
          let candidatePromise = null

          const appendCandidateStage = (stage, extra = {}) => {
            appendBatchStage(progressFile, {
              batchRunId,
              runId,
              candidateIndex,
              query,
              city,
              profile,
              finalDecision,
              targetCount,
              sentCount,
              stage,
              ...extra,
            })
          }

          try {
            candidatePromise = (async () => {
              appendCandidateStage('extract:start')
              const extraction = await extractCurrentJobOnPage(page)
              profile = extraction.profile
              appendCandidateStage('extract:done', { profile })

              const jobKey = getBatchJobKey(profile)
              if (jobKey && visited.has(jobKey)) {
                finalDecision = { decision: 'skip', source: 'batch', reason: 'duplicate job in this batch' }
                appendCandidateStage('duplicate:skip:start', { profile, finalDecision })
                const duplicateActionResult = await runCurrentJobBrowserActionsOnOpenPage(page, {
                  shouldApply: false,
                  confirm: argv.confirm,
                  expectedJob: profile,
                  moveNext: true,
                  query,
                  city,
                })
                actions = duplicateActionResult.actions
                appendCandidateStage('duplicate:skip:done', {
                  profile,
                  finalDecision,
                  delivery: summarizeDeliveryActions(actions),
                  nextJobMoved: nextJobMoved(actions),
                })
                return
              }
              if (jobKey) visited.add(jobKey)

              ruleEvaluation = evaluateJobWithRules(profile, boss, candidateProfile)
              appendCandidateStage('rules:done', {
                profile,
                ruleDecision: ruleEvaluation?.decision,
                reasonCount: Array.isArray(ruleEvaluation?.reasons) ? ruleEvaluation.reasons.length : undefined,
                greetingPlan: summarizeGreetingPlanForProgress(ruleEvaluation?.greetingPlan),
              })

              let deliveryGreetingMessage = ruleEvaluation.greetingMessage
              let deliveryResumeImagePath = ruleEvaluation.resumeImagePath
              if (argv.llm) appendCandidateStage('llm:start', { profile })
              llmEvaluation = argv.llm
                ? await evaluateJobWithLlm({ job: profile, ruleEvaluation, llmConfig: llm, candidateProfile })
                : null
              finalDecision = resolveFinalDecision(ruleEvaluation, llmEvaluation)
              appendCandidateStage('decision:done', {
                profile,
                finalDecision,
                llmDecision: llmEvaluation?.decision,
              })

              if (finalDecision.decision === 'apply') {
                appendCandidateStage('greeting:start', { profile, finalDecision })
                const greetingSelection = await buildGuardedPersonalizedGreetingSelection({
                  job: profile,
                  bossConfig: boss,
                  candidateProfile,
                  llmConfig: llm,
                  fallbackGreeting: {
                    rule: ruleEvaluation.greetingTemplate,
                    message: ruleEvaluation.greetingMessage,
                  },
                  fallbackPlan: ruleEvaluation.greetingPlan,
                })
                deliveryGreetingMessage = greetingSelection.greeting.message
                ruleEvaluation = applyGreetingSelectionToRuleEvaluation(ruleEvaluation, greetingSelection)
                appendCandidateStage('greeting:done', {
                  profile,
                  finalDecision,
                  greetingPlan: summarizeGreetingPlanForProgress(ruleEvaluation?.greetingPlan),
                })
              }
              const deliveryGreetingMessageSkipReason = getGreetingPlanTextSkipReason(ruleEvaluation?.greetingPlan, deliveryGreetingMessage)
              if (deliveryGreetingMessageSkipReason) deliveryGreetingMessage = ''

              appendCandidateStage('browser-action:start', {
                profile,
                finalDecision,
                willApply: finalDecision.decision === 'apply',
                greetingPlan: summarizeGreetingPlanForProgress(ruleEvaluation?.greetingPlan),
                messageSkipReason: deliveryGreetingMessageSkipReason || undefined,
              })
              const browserActionResult = await runCurrentJobBrowserActionsOnOpenPage(page, {
                shouldApply: finalDecision.decision === 'apply',
                message: deliveryGreetingMessage,
                messageSkipReason: deliveryGreetingMessageSkipReason,
                imagePath: deliveryResumeImagePath,
                confirm: argv.confirm,
                expectedJob: profile,
                moveNext: true,
                query,
                city,
                beforeMoveNext: ({ actions: browserActions }) => {
                  auditResult = appendAuditLog(
                    buildAuditRecord({
                      runId,
                      command: 'run-batch',
                      dryRun: !argv.confirm,
                      extraction: { source: 'browser', profile, raw: { pageQuery: query } },
                      profile,
                      candidateProfile: candidateProfileSummary,
                      ruleEvaluation,
                      llmEvaluation,
                      finalDecision,
                      actions: browserActions,
                      errors,
                    }),
                    { auditFile: argv['audit-file'] }
                  )
                  return auditResult
                },
              })
              actions = browserActionResult.actions
              if (isSuccessfulDelivery(actions)) sentCount += 1
              appendCandidateStage('browser-action:done', {
                profile,
                finalDecision,
                delivery: summarizeDeliveryActions(actions),
                sentCount,
                nextJobMoved: nextJobMoved(actions),
              })
            })()

            await withTimeout(
              candidatePromise,
              candidateTimeoutMs,
              `CANDIDATE_TIMEOUT:${candidateTimeoutMs}ms`
            )
          } catch (err) {
            error = err?.message ?? String(err)
            needsBrowserRestart = isRecoverableBatchError(err)
            errors.push({ message: error, stack: argv.debug ? err?.stack : undefined })
            appendCandidateStage('candidate:error', {
              profile,
              finalDecision,
              error,
              recoverable: needsBrowserRestart,
            })
            if (needsBrowserRestart) {
              await closeBatchBrowser()
              await drainPromise(candidatePromise, 5000)
            }
          } finally {
            examinedCount += 1
            result = buildBatchResult({
              batchRunId,
              runId,
              candidateIndex,
              query,
              city,
              profile,
              finalDecision,
              actions,
              sentCount,
              targetCount,
              auditResult,
              error,
            })
            results.push(result)
            appendProgress(progressFile, result)
          }

          if (needsBrowserRestart) {
            appendBatchStage(progressFile, {
              batchRunId,
              runId,
              candidateIndex,
              query,
              city,
              targetCount,
              sentCount,
              stage: 'browser:recover:start',
              error,
            })
            await openBatchBrowser('candidate_error')
            await openJobsPage(page, { query, city })
            appendBatchStage(progressFile, {
              batchRunId,
              runId,
              candidateIndex,
              query,
              city,
              targetCount,
              sentCount,
              stage: 'browser:recover:done',
            })
            continue
          }
          if (error || !nextJobMoved(actions)) break
        }
      }
    }
  } finally {
    await closeBatchBrowser()
  }

  return {
    ok: sentCount >= targetCount,
    command: 'run-batch',
    runId: batchRunId,
    dryRun: !argv.confirm,
    targetCount,
    sentCount,
    examinedCount,
    maxCandidates,
    candidateTimeoutMs,
    browserOpenCount,
    queryCount: queries.length,
    cityCodes,
    queries,
    progressFile: progressFile || null,
    results,
    errors,
  }
}

async function readJobFromArgs (argv) {
  if (argv.job) {
    return normalizeJobProfile(JSON.parse(fs.readFileSync(argv.job, 'utf8')))
  }
  return normalizeJobProfile({
    title: argv.title ?? '',
    jd: argv.jd ?? '',
    recallKeyword: argv['recall-keyword'] ?? '',
    city: argv.city ?? '',
    salary: argv.salary ?? '',
  })
}

function readJsonFile (filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function browserJobSourceOptions (argv) {
  return {
    query: argv['recall-keyword'] ?? '',
    city: argv.city ?? '',
  }
}

function readOptionalJsonFile (filePath) {
  return filePath ? readJsonFile(filePath) : null
}

function readFinalDecisionArg (value) {
  if (!value) return null
  const raw = String(value)
  if (fs.existsSync(raw)) return readJsonFile(raw)
  try {
    return JSON.parse(raw)
  } catch {
    return { decision: raw, source: 'cli' }
  }
}

function getAllowedActions (argv) {
  const explicit = toArray(argv['allowed-action'])
  if (explicit.length) return explicit
  return toArray(argv.actions)
}

function hasJobArgs (argv) {
  return Boolean(argv.job || argv.title || argv.jd || argv['recall-keyword'] || argv.city || argv.salary)
}

function toPositiveInt (value, fallback) {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function getBatchRecallKeywords (argv, boss) {
  const explicit = toArray(argv['recall-keyword'])
    .map(item => String(item ?? '').trim())
    .filter(Boolean)
  const configured = getEnabledRecallKeywords(boss)
  const source = explicit.length ? explicit : configured
  const unique = []
  const seen = new Set()
  for (const item of source) {
    const key = String(item).trim()
    if (!key || seen.has(key)) continue
    seen.add(key)
    unique.push(key)
  }
  return unique.length ? unique : ['']
}

function getBatchCityCodes (argv, boss) {
  const explicit = toArray(argv.city)
    .map(item => resolveCityCode(item))
    .filter(Boolean)
  if (explicit.length) return uniqueStrings(explicit)

  const cityNames = []
  for (const condition of boss.staticCombineRecommendJobFilterConditions ?? []) {
    if (condition?.city) cityNames.push(condition.city)
  }
  for (const city of boss.anyCombineRecommendJobFilter?.cityList ?? []) {
    if (city) cityNames.push(city)
  }
  for (const city of boss.expectCityList ?? []) {
    if (city) cityNames.push(city)
  }

  const resolved = cityNames.map(item => resolveCityCode(item)).filter(Boolean)
  return resolved.length ? uniqueStrings(resolved) : ['']
}

function resolveCityCode (value) {
  const normalized = String(value ?? '').trim()
  if (!normalized) return ''
  if (/^\d+$/.test(normalized)) return normalized
  const city = getFlatCityList().find(item => item.name === normalized)
  return city?.code ? String(city.code) : ''
}

function getFlatCityList () {
  if (flatCityListCache) return flatCityListCache
  flatCityListCache = []
  for (const group of cityGroupData?.zpData?.cityGroup ?? []) {
    for (const city of group.cityList ?? []) {
      flatCityListCache.push({ ...city, firstChar: group.firstChar })
    }
  }
  for (const city of cityGroupData?.zpData?.hotCityList ?? []) {
    flatCityListCache.push({ ...city, firstChar: city.firstChar })
  }
  return flatCityListCache
}

function uniqueStrings (items) {
  const seen = new Set()
  const unique = []
  for (const item of items) {
    const key = String(item ?? '').trim()
    if (!key || seen.has(key)) continue
    seen.add(key)
    unique.push(key)
  }
  return unique
}

function toArray (value) {
  if (Array.isArray(value)) return value
  return value == null ? [] : [value]
}

function getBatchJobKey (profile) {
  return [
    profile?.jobId,
    profile?.title,
    profile?.company,
    profile?.bossName,
  ].map(item => String(item ?? '').trim()).filter(Boolean).join('|')
}

function buildBatchResult ({
  batchRunId,
  runId,
  candidateIndex,
  query,
  city,
  profile,
  finalDecision,
  actions,
  sentCount,
  targetCount,
  auditResult = null,
  error = null,
}) {
  const startChatAction = actions.find(action => action.type === 'start_chat')
  const sendGreetingAction = actions.find(action => action.type === 'send_greeting')
  const nextJobAction = actions.find(action => action.type === 'next_job')
  const delivery = summarizeDeliveryActions(actions)
  return {
    batchRunId,
    runId,
    candidateIndex,
    query,
    city,
    job: summarizeBatchJob(profile),
    finalDecision,
    startChat: summarizeActionResult(startChatAction?.result),
    sendGreeting: summarizeActionResult(sendGreetingAction?.result),
    nextJob: summarizeActionResult(nextJobAction?.result),
    delivery,
    sentCount,
    targetCount,
    auditFile: auditResult?.auditFile ?? null,
    error,
  }
}

function summarizeBatchJob (profile) {
  if (!profile) return null
  return {
    jobId: profile.jobId,
    title: profile.title,
    company: profile.company,
    city: profile.city,
    salary: profile.salary,
    experience: profile.experience,
    degree: profile.degree,
    recallKeyword: profile.recallKeyword,
    bossName: profile.bossName,
    bossTitle: profile.bossTitle,
  }
}

function summarizeDeliveryActions (actions) {
  const sendGreetingAction = actions.find(action => action.type === 'send_greeting')
  const result = sendGreetingAction?.result ?? {}
  const textSent = Boolean(result.textSent || result.textResult?.sent)
  const imageUploaded = Boolean(result.imageUploaded || result.imageResult?.uploaded)
  return {
    successful: isSuccessfulDelivery(actions),
    textSent,
    imageUploaded,
    textSkippedReason: result.textSkippedReason ?? result.textResult?.reason,
    reason: result.reason,
  }
}

function isSuccessfulDelivery (actions) {
  const startChatAction = actions.find(action => action.type === 'start_chat')
  const sendGreetingAction = actions.find(action => action.type === 'send_greeting')
  const startSucceeded = Boolean(startChatAction?.result?.success)
  const sendResult = sendGreetingAction?.result ?? {}
  const sentSomething = Boolean(
    sendResult.textSent ||
    sendResult.textResult?.sent ||
    sendResult.imageUploaded ||
    sendResult.imageResult?.uploaded
  )
  return startSucceeded && sentSomething
}

function summarizeActionResult (result) {
  if (!result) return null
  return {
    dryRun: result.dryRun,
    skipped: result.skipped,
    success: result.success,
    clicked: result.clicked,
    moved: result.moved,
    textSent: result.textSent,
    imageUploaded: result.imageUploaded,
    reason: result.reason,
    textSkippedReason: result.textSkippedReason,
  }
}

function nextJobMoved (actions) {
  const nextJobAction = actions.find(action => action.type === 'next_job')
  if (!nextJobAction) return false
  return nextJobAction.result?.moved !== false && !nextJobAction.result?.skipped
}

function appendProgress (progressFile, record) {
  if (!progressFile) return
  fs.mkdirSync(path.dirname(progressFile), { recursive: true })
  fs.appendFileSync(progressFile, `${JSON.stringify(record)}\n`, 'utf8')
}

function appendBatchStage (progressFile, record) {
  if (!progressFile) return
  const { profile, ...rest } = record
  appendProgress(progressFile, {
    event: 'stage',
    timestamp: new Date().toISOString(),
    ...rest,
    job: summarizeBatchJob(profile),
  })
}

function summarizeGreetingPlanForProgress (greetingPlan) {
  if (!greetingPlan || typeof greetingPlan !== 'object') return null
  return {
    source: greetingPlan.source,
    fallbackReason: greetingPlan.fallbackReason ?? null,
    characterCount: greetingPlan.characterCount,
    guardPassed: greetingPlan.guardResult?.passed,
    deliveryTextAvailable: greetingPlan.safetyStatus?.deliveryTextAvailable,
    safeSummary: greetingPlan.safeSummary,
  }
}

async function withTimeout (promise, timeoutMs, message) {
  let timeoutId = null
  try {
    return await Promise.race([
      promise,
      new Promise((resolve, reject) => {
        timeoutId = setTimeout(() => {
          const err = new Error(message)
          err.code = 'CANDIDATE_TIMEOUT'
          reject(err)
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
  }
}

async function drainPromise (promise, timeoutMs) {
  if (!promise) return
  await Promise.race([
    promise.catch(() => {}),
    new Promise(resolve => setTimeout(resolve, timeoutMs)),
  ])
}

function isRecoverableBatchError (err) {
  if (err?.code === 'CANDIDATE_TIMEOUT') return true
  const message = String(err?.message ?? err ?? '')
  return /Runtime\.callFunctionOn timed out|Protocol error|Target closed|Session closed|Navigation timeout|Execution context was destroyed|Cannot find context|Connection closed|detached Frame|net::ERR/i.test(message)
}

function normalizeErrors (value) {
  if (!value) return []
  const list = Array.isArray(value) ? value : [value]
  return list.map(item => typeof item === 'string' ? { message: item } : item)
}

function hasLlmConfig (llm) {
  const list = Array.isArray(llm) ? llm : Array.isArray(llm?.configList) ? llm.configList : []
  return list.some(item =>
    item?.enabled !== false &&
    String(item?.providerCompleteApiUrl ?? item?.baseURL ?? '').trim() &&
    String(item?.providerApiSecret ?? item?.apiKey ?? '').trim() &&
    String(item?.model ?? '').trim()
  )
}

function applyGreetingSelectionToRuleEvaluation (ruleEvaluation, { greeting, greetingPlan }) {
  const outputGreetingMessage = greetingPlan.source === 'personalized'
    ? '[PERSONALIZED_GREETING_OMITTED]'
    : greeting.message

  return {
    ...ruleEvaluation,
    greetingTemplate: greeting.rule,
    greetingMessage: outputGreetingMessage,
    greetingPlan,
    presetTasks: updateGreetingTasks(ruleEvaluation.presetTasks, { greeting, greetingPlan }),
  }
}

function updateGreetingTasks (tasks, { greeting, greetingPlan }) {
  if (!Array.isArray(tasks)) return tasks
  return tasks.map(task => {
    if (task?.type !== 'send_greeting') return task
    return {
      ...task,
      template: greeting.rule,
      greetingPlan,
    }
  })
}

function usage () {
  return {
    ok: true,
    commands: [
      'ggr snapshot',
      'ggr capability-profile [--refresh]',
      'ggr extract-job --job job.json',
      'ggr extract-job --from-browser [--recall-keyword value] [--city code]',
      'ggr evaluate-job --job job.json [--llm]',
      'ggr greeting-preview --job job.json',
      'ggr start-chat --from-browser [--recall-keyword value] [--city code] [--confirm]',
      'ggr send-greeting --job job.json [--confirm]',
      'ggr next-job [--recall-keyword value] [--city code] [--confirm]',
      'ggr audit-log [--event event.json]',
      'ggr authorization-token issue --run-id run-id --job job.json --final-decision final.json --llm-evaluation llm.json --allowed-action start_chat [--token-file file] [--ttl-ms 600000]',
      'ggr authorization-token inspect --token-id token-id [--token-file file] [--action start_chat]',
      'ggr authorization-token consume --token-id token-id [--token-file file] [--action start_chat]',
      'ggr run-once --job job.json [--llm] [--confirm]',
      'ggr run-once --from-browser [--recall-keyword value] [--city code] [--llm] [--confirm]',
      'ggr run-batch --from-browser --llm --confirm [--target-count 20] [--max-candidates 160] [--candidate-timeout-ms 240000] [--progress-file file]',
    ],
  }
}

function writeJson (value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function captureInternalConsoleOutput ({ debug = false } = {}) {
  for (const method of ['log', 'info', 'warn', 'error']) {
    console[method] = (...args) => {
      if (!debug) return
      process.stderr.write(`${args.map(arg => typeof arg === 'string' ? arg : util.inspect(arg)).join(' ')}\n`)
    }
  }
}
