import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import {
  acquireBrowserProfileLock,
  connectToBrowserEndpoint,
  releaseBrowserConnection,
  validateCdpEndpoint,
} from './browser-runtime.mjs'

test('CDP validation accepts loopback endpoints and requires an explicit high-risk option for remote hosts', () => {
  assert.equal(validateCdpEndpoint('http://127.0.0.1:9222').connectionMode, 'loopback')
  assert.equal(validateCdpEndpoint('ws://localhost:9222/devtools/browser/id').connectionMode, 'loopback')
  assert.equal(validateCdpEndpoint('http://[::1]:9222').connectionMode, 'loopback')

  assert.throws(
    () => validateCdpEndpoint('https://browser.example.com'),
    error => error.reasonCode === 'REMOTE_CDP_REJECTED'
  )
  assert.equal(
    validateCdpEndpoint('https://browser.example.com', { allowRemote: true }).connectionMode,
    'remote-high-risk'
  )
  assert.throws(
    () => validateCdpEndpoint('https://user:secret@browser.example.com', { allowRemote: true }),
    error => error.reasonCode === 'CDP_ENDPOINT_CREDENTIALS_FORBIDDEN' && !error.message.includes('secret')
  )
})

test('browser connection cleanup closes owned browsers and only disconnects attached CDP browsers', async () => {
  const calls = []
  await releaseBrowserConnection({
    shouldClose: true,
    browser: {
      async close () { calls.push('close') },
      disconnect () { calls.push('unexpected-disconnect') },
    },
  })
  await releaseBrowserConnection({
    shouldClose: false,
    browser: {
      async close () { calls.push('unexpected-close') },
      disconnect () { calls.push('disconnect') },
    },
  })

  assert.deepEqual(calls, ['close', 'disconnect'])
})

test('shared CDP connection selects an existing BOSS page and reports the validated connection mode', async () => {
  const bossPage = { url: () => 'https://www.zhipin.com/web/geek/jobs' }
  const otherPage = { url: () => 'about:blank' }
  const calls = []
  const browser = {
    async pages () { return [otherPage, bossPage] },
  }
  const connected = await connectToBrowserEndpoint({
    cdpPort: '9222',
    puppeteerImpl: {
      async connect (options) {
        calls.push(options)
        return browser
      },
    },
  })

  assert.deepEqual(calls, [{ browserURL: 'http://127.0.0.1:9222/' }])
  assert.equal(connected.page, bossPage)
  assert.deepEqual(connected.connection, { mode: 'loopback', highRisk: false })
  assert.equal(connected.shouldClose, false)
})

test('managed browser profile lock fails fast for a live owner and reclaims a stale lock', () => {
  const browserRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ggr-browser-lock-'))
  const runtimeContext = { browserRoot }
  const owner = acquireBrowserProfileLock(runtimeContext, {
    pid: 111,
    isProcessAlive: pid => pid === 111,
    now: new Date('2026-07-10T00:00:00.000Z'),
  })

  try {
    assert.throws(
      () => acquireBrowserProfileLock(runtimeContext, {
        pid: 222,
        isProcessAlive: pid => pid === 111,
      }),
      error => error.reasonCode === 'BROWSER_PROFILE_IN_USE'
    )
    owner.release()

    fs.writeFileSync(path.join(browserRoot, 'profile.lock'), JSON.stringify({ pid: 333, lockId: 'stale' }))
    const reclaimed = acquireBrowserProfileLock(runtimeContext, {
      pid: 444,
      isProcessAlive: () => false,
    })
    assert.equal(JSON.parse(fs.readFileSync(reclaimed.path, 'utf8')).pid, 444)
    reclaimed.release()
  } finally {
    owner.release()
    fs.rmSync(browserRoot, { recursive: true, force: true })
  }
})
