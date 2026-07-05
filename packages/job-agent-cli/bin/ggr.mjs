#!/usr/bin/env node
import fs from 'node:fs'
import process from 'node:process'
import minimist from 'minimist'
import { loadRuntimeConfig, getEnabledSearchKeywords, getGreetingRules, getResumeImagePath } from '../src/config.mjs'
import { normalizeJobProfile } from '../src/job-profile.mjs'
import { evaluateJobWithRules, selectGreeting } from '../src/policy.mjs'
import { evaluateJobWithLlm } from '../src/llm-evaluator.mjs'
import { extractCurrentJobFromBrowser, sendGreetingToMostRecentChat } from '../src/browser-actions.mjs'

const argv = minimist(process.argv.slice(2), {
  boolean: ['from-browser', 'headless', 'llm', 'confirm'],
  string: ['job', 'title', 'jd', 'keyword', 'city', 'salary'],
})
const [command] = argv._

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
    case 'send-greeting':
      return sendGreeting(argv)
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

async function runOnce (argv) {
  const profile = argv['from-browser']
    ? (await extractCurrentJobFromBrowser({ headless: argv.headless })).profile
    : await readJobFromArgs(argv)
  const { boss, llm } = loadRuntimeConfig()
  const ruleEvaluation = evaluateJobWithRules(profile, boss)
  const llmEvaluation = argv.llm
    ? await evaluateJobWithLlm({ job: profile, ruleEvaluation, llmConfig: llm })
    : null
  let sendResult = null
  if (ruleEvaluation.decision === 'apply') {
    sendResult = await sendGreetingToMostRecentChat({
      message: ruleEvaluation.greetingMessage,
      imagePath: ruleEvaluation.resumeImagePath,
      confirm: argv.confirm,
      headless: argv.headless,
    })
  }
  return { ok: true, command: 'run-once', profile, ruleEvaluation, llmEvaluation, sendResult }
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
      'ggr send-greeting --job job.json [--confirm]',
      'ggr run-once --job job.json [--llm] [--confirm]',
    ],
  }
}

function writeJson (value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}
