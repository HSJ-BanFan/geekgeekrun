import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { checkForUpdates } from './update-check.mjs'

test('explicit update check selects Job Agent tags and never mutates the runtime home', async () => {
  const runtimeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ggr-update-check-'))
  const markerPath = path.join(runtimeHome, 'marker.txt')
  fs.writeFileSync(markerPath, 'unchanged')
  const requested = []

  try {
    const result = await checkForUpdates({
      currentVersion: '0.1.0',
      fetchImpl: async url => {
        requested.push(url)
        return new Response(JSON.stringify([
          { tag_name: 'v9.9.9', draft: false, prerelease: false, html_url: 'https://example.invalid/ui' },
          { tag_name: 'job-agent-v0.2.0', draft: false, prerelease: true, html_url: 'https://example.invalid/0.2.0', published_at: '2026-07-10T00:00:00Z' },
          { tag_name: 'job-agent-v0.1.1', draft: false, prerelease: true, html_url: 'https://example.invalid/0.1.1', published_at: '2026-07-09T00:00:00Z' },
        ]), { status: 200 })
      },
    })

    assert.equal(result.ok, true)
    assert.equal(result.command, 'update')
    assert.equal(result.action, 'check')
    assert.equal(result.currentVersion, '0.1.0')
    assert.equal(result.latestVersion, '0.2.0')
    assert.equal(result.updateAvailable, true)
    assert.equal(result.mutating, false)
    assert.equal(requested.length, 1)
    assert.equal(fs.readFileSync(markerPath, 'utf8'), 'unchanged')
    assert.deepEqual(fs.readdirSync(runtimeHome), ['marker.txt'])
  } finally {
    fs.rmSync(runtimeHome, { recursive: true, force: true })
  }
})

test('update check reports network failure without affecting unrelated commands', async () => {
  const result = await checkForUpdates({
    currentVersion: '0.1.0',
    fetchImpl: async () => { throw new Error('offline') },
  })

  assert.equal(result.ok, false)
  assert.equal(result.reasonCode, 'UPDATE_CHECK_NETWORK_FAILED')
  assert.equal(result.mutating, false)
})
