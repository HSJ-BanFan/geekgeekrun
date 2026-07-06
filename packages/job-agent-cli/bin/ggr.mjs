#!/usr/bin/env node
import fs from 'node:fs'
import process from 'node:process'
import util from 'node:util'
import minimist from 'minimist'
import { loadRuntimeConfig, getEnabledRecallKeywords, getGreetingRules, getResumeImagePath } from '../src/config.mjs'
import { normalizeJobProfile } from '../src/job-profile.mjs'
import { evaluateJobWithRules, selectGreeting } from '../src/policy.mjs'
import { evaluateJobWithLlm } from '../src/llm-evaluator.mjs'
import { resolveFinalDecision } from '../src/final-decision.mjs'
import { buildCandidateProfile, summarizeCandidateProfile } from '../src/candidate-profile.mjs'
import {
  extractCurrentJobFromBrowser,
  moveToNextJob,
  runCurrentJobBrowserActions,
  sendGreetingToMostRecentChat,
  startChatOnCurrentJob,
} from '../src/browser-actions.mjs'
import { appendAuditLog, buildAuditRecord, createRunId } from '../src/audit-log.mjs'

const argv = minimist(process.argv.slice(2), {
  boolean: ['from-browser', 'headless', 'llm', 'confirm'],
  string: [
    'job',
    'title',
    'jd',
    'recall-keyword',
    'city',
    'salary',
    'event',
    'evaluation',
    'llm-evaluation',
    'actions',
    'error',
    'audit-file',
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
    case 'extract-job':
      return extractJob(argv)
    case 'evaluate-job':
      return evaluateJob(argv)
    case 'start-chat':
      return startChat(argv)
    case 'send-greeting':
      return sendGreeting(argv)
    case 'next-job':
      return nextJob(argv)
    case 'audit-log':
      return auditLog(argv)
    case 'run-once':
      return runOnce(argv)
    default:
      return usage()
  }
}

function snapshot () {
  const { boss, llm, storageFilePath } = loadRuntimeConfig()
  const candidateProfile = buildCandidateProfile(boss)
  return {
    ok: true,
    command: 'snapshot',
    storageFilePath,
    candidateProfile: summarizeCandidateProfile(candidateProfile),
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

async function sendGreeting (argv) {
  const profile = await readJobFromArgs(argv)
  const { boss } = loadRuntimeConfig()
  const greeting = selectGreeting(profile, boss)
  const result = await sendGreetingToMostRecentChat({
    message: greeting.message,
    imagePath: getResumeImagePath(boss),
    confirm: argv.confirm,
    headless: argv.headless,
  })
  return { ok: true, command: 'send-greeting', greeting, result }
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

  try {
    extraction = argv['from-browser']
      ? { source: 'browser', ...(await extractCurrentJobFromBrowser({ headless: argv.headless, ...browserJobSourceOptions(argv) })) }
      : { source: argv.job ? 'file' : 'args', profile: await readJobFromArgs(argv) }
    profile = extraction.profile
    const { boss, llm } = loadRuntimeConfig()
    candidateProfile = buildCandidateProfile(boss)
    candidateProfileSummary = summarizeCandidateProfile(candidateProfile)
    ruleEvaluation = evaluateJobWithRules(profile, boss, candidateProfile)
    llmEvaluation = argv.llm
      ? await evaluateJobWithLlm({ job: profile, ruleEvaluation, llmConfig: llm, candidateProfile })
      : null
    finalDecision = resolveFinalDecision(ruleEvaluation, llmEvaluation)

    if (argv['from-browser']) {
      const browserActionResult = await runCurrentJobBrowserActions({
        shouldApply: finalDecision.decision === 'apply',
        message: ruleEvaluation.greetingMessage,
        imagePath: ruleEvaluation.resumeImagePath,
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
        message: ruleEvaluation.greetingMessage,
        imagePath: ruleEvaluation.resumeImagePath,
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

function hasJobArgs (argv) {
  return Boolean(argv.job || argv.title || argv.jd || argv['recall-keyword'] || argv.city || argv.salary)
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

function usage () {
  return {
    ok: true,
    commands: [
      'ggr snapshot',
      'ggr extract-job --job job.json',
      'ggr extract-job --from-browser [--recall-keyword value] [--city code]',
      'ggr evaluate-job --job job.json [--llm]',
      'ggr start-chat --from-browser [--recall-keyword value] [--city code] [--confirm]',
      'ggr send-greeting --job job.json [--confirm]',
      'ggr next-job [--recall-keyword value] [--city code] [--confirm]',
      'ggr audit-log [--event event.json]',
      'ggr run-once --job job.json [--llm] [--confirm]',
      'ggr run-once --from-browser [--recall-keyword value] [--city code] [--llm] [--confirm]',
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
