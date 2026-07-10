import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createWindowsCredentialStore } from './credential-store.mjs'

test('Windows credential adapter sends secret input over stdin and never places it in process arguments', () => {
  const canary = 'CANARY_CREDENTIAL_STDIN_ONLY'
  const calls = []
  const store = createWindowsCredentialStore({
    platform: 'win32',
    spawnSyncImpl: (executable, args, options) => {
      calls.push({ executable, args, options })
      return { status: 0, stdout: '{"ok":true,"exists":true}', stderr: '' }
    },
  })

  const result = store.set({ target: 'GeekGeekRun/JobAgent/openai', secret: canary })

  assert.equal(result.ok, true)
  assert.equal(calls[0].executable, 'cmd.exe')
  assert.equal(calls[0].options.input, canary)
  assert.equal(calls[0].options.windowsVerbatimArguments, true)
  assert.doesNotMatch(JSON.stringify(calls[0].args), /CANARY_CREDENTIAL_STDIN_ONLY/)
})
