#!/usr/bin/env node
import process from 'node:process'
import minimist from 'minimist'

import { runDoctor, versionReport } from '../src/distribution.mjs'
import { getRuntimeContext } from '../src/runtime-context.mjs'
import { dispatchAgent } from '../src/sidecar-dispatch.mjs'

const rawArgs = process.argv.slice(2)
const argv = minimist(rawArgs, {
  alias: { v: 'version' },
  boolean: ['version', 'require-browser', 'plan-only', 'from-browser', 'include-jd', 'analyze', 'headless'],
  string: ['keyword', 'city', 'recall-keyword', 'limit', 'output', 'analysis-output', 'browser-url', 'cdp-port'],
})
const [command] = argv._
const runtimeContext = getRuntimeContext()

try {
  await main()
} catch (err) {
  finish({
    ok: false,
    command: command ?? null,
    reasonCode: 'INTERNAL_ERROR',
    error: err?.message ?? String(err),
  })
}

async function main () {
  if (argv.version || command === 'version') {
    finish(versionReport(runtimeContext))
    return
  }
  if (command === 'doctor') {
    finish(runDoctor(runtimeContext, { requireBrowser: argv['require-browser'] }))
    return
  }
  if (command === 'market-jobs' && argv['plan-only']) {
    const { runMarketJobs } = await import('../src/market-jobs.mjs')
    finish(await runMarketJobs({
      fromBrowser: argv['from-browser'],
      planOnly: true,
      keywords: argv.keyword,
      cities: argv.city,
      recallKeywords: argv['recall-keyword'],
      limit: argv.limit,
      includeJd: argv['include-jd'],
      analyze: argv.analyze,
      outputPath: argv.output,
      analysisOutputPath: argv['analysis-output'],
      headless: argv.headless,
      browserUrl: argv['browser-url'],
      cdpPort: argv['cdp-port'],
    }))
    return
  }
  if (command === 'agent') {
    try {
      process.exitCode = await dispatchAgent(rawArgs.slice(1), runtimeContext)
    } catch (err) {
      finish({
        ok: false,
        command: 'agent',
        runtimeMode: runtimeContext.mode,
        reasonCode: err?.reasonCode ?? 'SIDECAR_DISPATCH_FAILED',
        error: err?.message ?? String(err),
      })
    }
    return
  }
  if (runtimeContext.mode === 'installed') {
    finish({
      ok: false,
      command: command ?? null,
      runtimeMode: runtimeContext.mode,
      reasonCode: 'INSTALLED_COMMAND_NOT_AVAILABLE',
      error: 'This command has not yet been migrated to the isolated Job Agent runtime context',
      availableCommands: ['--version', 'doctor', 'market-jobs --plan-only', 'agent'],
    })
    return
  }
  await import('./ggr-main.mjs')
}

function finish (result) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  if (!result.ok) process.exitCode = 1
}
