#!/usr/bin/env node
import fs from 'node:fs'
import process from 'node:process'
import util from 'node:util'
import minimist from 'minimist'
import { loadRuntimeConfig, getEnabledSearchKeywords, getGreetingRules, getResumeImagePath } from '../src/config.mjs'
import { normalizeJobProfile } from '../src/job-profile.mjs'
import { evaluateJobWithRules, selectGreeting } from '../src/policy.mjs'
import { evaluateJobWithLlm } from '../src/llm-evaluator.mjs'
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
    'keyword',
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
  return {
    ok: true,
    command: 'snapshot',
    storageFilePath,
    keywordCount: getEnabledSearchKeywords(boss).length,
    keywords: getEnabledSearchKeywords(boss),
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
    const extracted = await extractCurrentJobFromBrowser({ headless: argv.headless })
    return { ok: true, command: 'extract-job', source: 'browser', ...extracted }
  }
  const profile = await readJobFromArgs(argv)
  return { ok: true, command: 'extract-job', source: argv.job ? 'file' : 'args', profile }
}

async function evaluateJob (argv) {
  const profile = await readJobFromArgs(argv)
  const { boss, llm } = loadRuntimeConfig()
  const ruleEvaluation = evaluateJobWithRules(profile, boss)
  const llmEvaluation = argv.llm
    ? await evaluateJobWithLlm({ job: profile, ruleEvaluation, llmConfig: llm })
    : null
  return { ok: true, command: 'evaluate-job', profile, ruleEvaluation, llmEvaluation }
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
  })
  return { ok: true, command: 'start-chat', result }
}

async function nextJob (argv) {
  const result = await moveToNextJob({
    confirm: argv.confirm,
    headless: argv.headless,
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
  let ruleEvaluation = null
  let llmEvaluation = null
  let finalDecision = null
  let auditResult = null

  try {
    extraction = argv['from-browser']
      ? { source: 'browser', ...(await extractCurrentJobFromBrowser({ headless: argv.headless })) }
      : { source: argv.job ? 'file' : 'args', profile: await readJobFromArgs(argv) }
    profile = extraction.profile
    const { boss, llm } = loadRuntimeConfig()
    ruleEvaluation = evaluateJobWithRules(profile, boss)
    llmEvaluation = argv.llm
      ? await evaluateJobWithLlm({ job: profile, ruleEvaluation, llmConfig: llm })
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
        beforeMoveNext: ({ actions: browserActions }) => {
          auditResult = appendAuditLog(
            buildAuditRecord({
              runId,
              command: 'run-once',
              dryRun: !argv.confirm,
              extraction,
              profile,
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
    sourceKeyword: argv.keyword ?? '',
    city: argv.city ?? '',
    salary: argv.salary ?? '',
  })
}

function resolveFinalDecision (ruleEvaluation, llmEvaluation) {
  if (ruleEvaluation?.decision === 'skip') {
    return {
      decision: 'skip',
      source: 'rules',
      reason: 'rule skip cannot be upgraded by llm',
    }
  }
  const llmDecision = typeof llmEvaluation?.decision === 'string'
    ? llmEvaluation.decision.trim().toLowerCase()
    : ''
  if (ruleEvaluation?.techStackAssessment?.requiresLlm) {
    const llmTechStackAssessment = getLlmTechStackAssessment(llmEvaluation)
    if (!llmEvaluation || llmEvaluation.skipped) {
      return {
        decision: 'uncertain',
        source: 'rules',
        reason: 'llm tech stack assessment required before auto-apply',
      }
    }
    if (typeof llmTechStackAssessment?.is_core_required !== 'boolean') {
      return {
        decision: 'uncertain',
        source: 'llm',
        reason: 'llm did not explain whether rejected tech stack is core/required',
      }
    }
    if (llmTechStackAssessment.is_core_required) {
      return {
        decision: 'skip',
        source: 'llm',
        reason: 'llm identified rejected tech stack as core/required',
      }
    }
    if (!['apply', 'skip', 'uncertain'].includes(llmDecision)) {
      return {
        decision: 'uncertain',
        source: 'llm',
        reason: 'llm tech stack assessment passed but decision is missing or invalid',
      }
    }
  }
  if (['apply', 'skip', 'uncertain'].includes(llmDecision)) {
    return {
      decision: llmDecision,
      source: 'llm',
      reason: 'llm decision applied after rule boundary check',
    }
  }
  return {
    decision: ruleEvaluation?.decision ?? 'uncertain',
    source: 'rules',
    reason: llmEvaluation?.skipped ? llmEvaluation.reason : 'no llm decision',
  }
}

function getLlmTechStackAssessment (llmEvaluation) {
  return llmEvaluation?.tech_stack_assessment ?? llmEvaluation?.techStackAssessment ?? null
}

function readJsonFile (filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function readOptionalJsonFile (filePath) {
  return filePath ? readJsonFile(filePath) : null
}

function hasJobArgs (argv) {
  return Boolean(argv.job || argv.title || argv.jd || argv.keyword || argv.city || argv.salary)
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
      'ggr extract-job --from-browser',
      'ggr evaluate-job --job job.json [--llm]',
      'ggr start-chat --from-browser [--confirm]',
      'ggr send-greeting --job job.json [--confirm]',
      'ggr next-job [--confirm]',
      'ggr audit-log [--event event.json]',
      'ggr run-once --job job.json [--llm] [--confirm]',
      'ggr run-once --from-browser [--llm] [--confirm]',
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
