import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  createWindowsCredentialStore,
  parseWindowsCredentialReference,
} from './credential-store.mjs'
import { resolveInstalledLlmSecrets } from './config.mjs'

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
  assert.match(calls[0].executable, /powershell\.exe$/i)
  assert.equal(calls[0].options.input, canary)
  assert.doesNotMatch(JSON.stringify(calls[0].args), /CANARY_CREDENTIAL_STDIN_ONLY/)
  assert.deepEqual(calls[0].args.slice(-4), ['-Action', 'set', '-Target', 'GeekGeekRun/JobAgent/openai'])
})

test('Windows credential adapter rejects targets outside the Job Agent namespace before spawning', () => {
  const calls = []
  const store = createWindowsCredentialStore({
    platform: 'win32',
    spawnSyncImpl: (...args) => calls.push(args),
  })

  const result = store.get({ target: 'OtherProduct/secret" & whoami &' })

  assert.equal(result.ok, false)
  assert.equal(result.reasonCode, 'CREDENTIAL_TARGET_INVALID')
  assert.equal(calls.length, 0)
  assert.equal(parseWindowsCredentialReference('windows-credential:GeekGeekRun/JobAgent/openai'), 'GeekGeekRun/JobAgent/openai')
  assert.equal(parseWindowsCredentialReference('windows-credential:OtherProduct/openai'), null)
})

test('installed LLM resolution discards plaintext secrets and resolves only trusted credential references', () => {
  const calls = []
  const resolved = resolveInstalledLlmSecrets([{
    enabled: true,
    model: 'fixture-model',
    providerCompleteApiUrl: 'https://example.invalid/v1/chat/completions',
    providerApiSecret: 'PLAINTEXT_SECRET_MUST_NOT_SURVIVE',
    credentialRef: 'windows-credential:GeekGeekRun/JobAgent/openai',
  }, {
    enabled: true,
    model: 'invalid-target',
    apiKey: 'SECOND_PLAINTEXT_SECRET_MUST_NOT_SURVIVE',
    credentialRef: 'windows-credential:OtherProduct/secret',
  }], {}, {
    credentialStore: {
      get ({ target }) {
        calls.push(target)
        return { ok: true, secret: 'CREDENTIAL_MANAGER_SECRET' }
      },
    },
  })

  assert.deepEqual(calls, ['GeekGeekRun/JobAgent/openai'])
  assert.equal(resolved[0].providerApiSecret, 'CREDENTIAL_MANAGER_SECRET')
  assert.equal(resolved[1].providerApiSecret, undefined)
  assert.equal(resolved[1].apiKey, undefined)
  assert.doesNotMatch(JSON.stringify(resolved), /PLAINTEXT_SECRET_MUST_NOT_SURVIVE/)
})
