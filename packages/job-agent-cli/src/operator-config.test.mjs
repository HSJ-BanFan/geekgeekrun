import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { runConfigCommand } from './operator-config.mjs'

test('config secret set stores hidden input in the credential adapter and persists only a reference', async () => {
  const runtimeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ggr-operator-config-'))
  const canary = 'CANARY_INTERACTIVE_SECRET_VALUE'
  const calls = []
  const credentialStore = {
    set ({ target, secret }) {
      calls.push({ target, secret })
      return { ok: true, reasonCode: null }
    },
  }

  try {
    const result = await runConfigCommand(runtimeContext(runtimeHome), [
      'secret',
      'set',
      '--name',
      'openai',
    ], {
      credentialStore,
      readSecret: async () => canary,
      now: new Date('2026-07-10T00:00:00.000Z'),
    })

    assert.equal(result.ok, true)
    assert.equal(result.action, 'secret-set')
    assert.equal(result.credentialRef, 'windows-credential:GeekGeekRun/JobAgent/openai')
    assert.deepEqual(calls, [{ target: 'GeekGeekRun/JobAgent/openai', secret: canary }])
    const configText = fs.readFileSync(path.join(runtimeHome, 'config', 'operator.json'), 'utf8')
    assert.match(configText, /windows-credential:GeekGeekRun\/JobAgent\/openai/)
    assert.doesNotMatch(configText, /CANARY_INTERACTIVE_SECRET_VALUE/)
    assert.doesNotMatch(JSON.stringify(result), /CANARY_INTERACTIVE_SECRET_VALUE/)
  } finally {
    fs.rmSync(runtimeHome, { recursive: true, force: true })
  }
})

test('config secret set rejects secret values supplied as command-line options', async () => {
  const runtimeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ggr-operator-config-'))

  try {
    const result = await runConfigCommand(runtimeContext(runtimeHome), [
      'secret',
      'set',
      '--name',
      'openai',
      '--value',
      'CANARY_COMMAND_LINE_SECRET',
    ])

    assert.equal(result.ok, false)
    assert.equal(result.reasonCode, 'SECRET_COMMAND_LINE_INPUT_FORBIDDEN')
    assert.doesNotMatch(JSON.stringify(result), /CANARY_COMMAND_LINE_SECRET/)
    assert.equal(fs.existsSync(path.join(runtimeHome, 'config')), false)
  } finally {
    fs.rmSync(runtimeHome, { recursive: true, force: true })
  }
})

function runtimeContext (runtimeHome) {
  return {
    mode: 'installed',
    runtimeHome,
    configRoot: path.join(runtimeHome, 'config'),
  }
}
