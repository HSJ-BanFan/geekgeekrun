import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

import {
  classifyBossSessionState,
  runSetupCommand,
} from './operator-setup.mjs'

test('offline managed-browser setup verifies metadata, preserves the profile on repair, and leaves a healthy install intact on mismatch', async () => {
  const runtimeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ggr-browser-setup-'))
  const fixtureRoot = path.join(runtimeHome, 'fixture')
  const archiveContentRoot = path.join(fixtureRoot, 'content')
  const archivePath = path.join(fixtureRoot, 'chrome.zip')
  const metadataPath = path.join(fixtureRoot, 'browser-metadata.json')
  const chromeRoot = path.join(archiveContentRoot, 'chrome-win64')
  fs.mkdirSync(chromeRoot, { recursive: true })
  fs.copyFileSync(process.execPath, path.join(chromeRoot, 'chrome.exe'))
  const archived = spawnSync('tar.exe', ['-c', '-a', '-f', archivePath, '-C', archiveContentRoot, 'chrome-win64'])
  assert.equal(archived.status, 0)
  writeMetadata(metadataPath, archivePath)
  const runtimeContext = context(runtimeHome)

  try {
    const first = await runSetupCommand(runtimeContext, [
      '--offline-archive', archivePath,
      '--skip-login',
    ], { writeProgress: () => {}, browserMetadataPath: metadataPath })

    assert.equal(first.ok, true)
    assert.equal(first.browser.selectionMode, 'managed')
    assert.equal(fs.existsSync(first.browser.executablePath), true)

    const profileMarker = path.join(runtimeContext.browserRoot, 'profile', 'Default', 'marker.txt')
    fs.mkdirSync(path.dirname(profileMarker), { recursive: true })
    fs.writeFileSync(profileMarker, 'preserve-session-profile')
    fs.writeFileSync(path.join(runtimeContext.browserRoot, 'session.json'), JSON.stringify({ status: 'ready' }))

    const repaired = await runSetupCommand(runtimeContext, [
      'repair',
      '--offline-archive', archivePath,
      '--skip-login',
    ], { writeProgress: () => {}, browserMetadataPath: metadataPath })

    assert.equal(repaired.ok, true)
    assert.equal(fs.readFileSync(profileMarker, 'utf8'), 'preserve-session-profile')
    assert.equal(JSON.parse(fs.readFileSync(path.join(runtimeContext.browserRoot, 'session.json'))).status, 'ready')

    const previousConfiguration = fs.readFileSync(path.join(runtimeContext.browserRoot, 'browser.json'), 'utf8')
    fs.appendFileSync(archivePath, 'tampered')
    await assert.rejects(
      runSetupCommand(runtimeContext, [
        'repair',
        '--offline-archive', archivePath,
        '--skip-login',
      ], { writeProgress: () => {}, browserMetadataPath: metadataPath }),
      error => error.reasonCode === 'BROWSER_ARCHIVE_HASH_MISMATCH'
    )
    assert.equal(fs.readFileSync(path.join(runtimeContext.browserRoot, 'browser.json'), 'utf8'), previousConfiguration)
    assert.equal(fs.readFileSync(profileMarker, 'utf8'), 'preserve-session-profile')
  } finally {
    fs.rmSync(runtimeHome, { recursive: true, force: true })
  }
})

test('browser profile reset requires explicit confirmation and preserves browser configuration', async () => {
  const runtimeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ggr-browser-reset-'))
  const runtimeContext = context(runtimeHome)
  const browserConfigPath = path.join(runtimeContext.browserRoot, 'browser.json')
  const markerPath = path.join(runtimeContext.browserRoot, 'profile', 'marker.txt')
  fs.mkdirSync(path.dirname(markerPath), { recursive: true })
  fs.writeFileSync(markerPath, 'session state')
  fs.writeFileSync(browserConfigPath, JSON.stringify({ executablePath: 'C:\\browser\\chrome.exe' }))

  try {
    await assert.rejects(
      runSetupCommand(runtimeContext, ['reset-profile']),
      error => error.reasonCode === 'PROFILE_RESET_CONFIRMATION_REQUIRED'
    )
    assert.equal(fs.existsSync(markerPath), true)

    const reset = await runSetupCommand(runtimeContext, ['reset-profile', '--confirm'])
    assert.equal(reset.ok, true)
    assert.equal(fs.existsSync(markerPath), false)
    assert.equal(fs.existsSync(browserConfigPath), true)
  } finally {
    fs.rmSync(runtimeHome, { recursive: true, force: true })
  }
})

test('online managed-browser setup downloads only the pinned metadata URL and verifies the same archive hash', async () => {
  const runtimeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ggr-browser-download-'))
  const archiveContentRoot = path.join(runtimeHome, 'source', 'chrome-win64')
  const archivePath = path.join(runtimeHome, 'source', 'chrome.zip')
  const metadataPath = path.join(runtimeHome, 'source', 'browser-metadata.json')
  fs.mkdirSync(archiveContentRoot, { recursive: true })
  fs.copyFileSync(process.execPath, path.join(archiveContentRoot, 'chrome.exe'))
  const archived = spawnSync('tar.exe', [
    '-c', '-a', '-f', archivePath, '-C', path.dirname(archiveContentRoot), 'chrome-win64',
  ])
  assert.equal(archived.status, 0)
  writeMetadata(metadataPath, archivePath)
  const requested = []

  try {
    const result = await runSetupCommand(context(runtimeHome), [
      '--skip-login',
    ], {
      writeProgress: () => {},
      browserMetadataPath: metadataPath,
      fetchImpl: async url => {
        requested.push(url)
        return new Response(fs.readFileSync(archivePath), { status: 200 })
      },
    })

    assert.equal(result.ok, true)
    assert.deepEqual(requested, ['https://example.invalid/chrome.zip'])
    assert.equal(result.browser.selectionMode, 'managed')
    assert.equal(fs.existsSync(result.browser.executablePath), true)
  } finally {
    fs.rmSync(runtimeHome, { recursive: true, force: true })
  }
})

test('installed setup rejects public browser metadata replacement', async () => {
  const runtimeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ggr-browser-metadata-'))
  try {
    await assert.rejects(
      runSetupCommand(context(runtimeHome), ['--browser-metadata', 'attacker-controlled.json', '--skip-login']),
      error => error.reasonCode === 'BROWSER_METADATA_OVERRIDE_FORBIDDEN'
    )
  } finally {
    fs.rmSync(runtimeHome, { recursive: true, force: true })
  }
})

test('manual login classification requires a supported BOSS geek page and positive authenticated DOM evidence', () => {
  assert.deepEqual(classifyBossSessionState({
    url: 'https://www.zhipin.com/web/geek/jobs',
    visibleText: 'AI Agent 工程师',
    hasAuthenticatedNavigation: true,
  }), { status: 'ready', reasonCode: null })

  assert.equal(classifyBossSessionState({
    url: 'https://www.zhipin.com/web/geek/jobs',
    visibleText: '扫码登录后继续',
    hasLoginControl: true,
  }).status, 'login-required')
  assert.equal(classifyBossSessionState({
    url: 'https://www.zhipin.com/web/common/security-check',
    visibleText: '请拖动滑块完成安全验证',
  }).status, 'safety-verification')
  assert.equal(classifyBossSessionState({
    url: 'chrome-error://chromewebdata/',
    title: '无法访问此网站',
  }).status, 'abnormal-environment')
  assert.equal(classifyBossSessionState({
    url: 'https://www.zhipin.com/web/geek/jobs',
    visibleText: '普通空白内容',
  }).status, 'unconfirmed')
  assert.equal(classifyBossSessionState({
    url: 'https://example.com/web/geek/jobs',
    hasGeekWorkspace: true,
  }).status, 'abnormal-environment')
})

function context (runtimeHome) {
  return {
    mode: 'installed',
    runtimeHome,
    browserRoot: path.join(runtimeHome, 'browser'),
    tempRoot: path.join(runtimeHome, 'temp'),
  }
}

function writeMetadata (metadataPath, archivePath) {
  fs.writeFileSync(metadataPath, `\uFEFF${JSON.stringify({
    schemaVersion: 'job-agent-browser-distribution.v1',
    product: 'chrome-for-testing',
    platform: 'win64',
    version: '140.0.7339.80',
    url: 'https://example.invalid/chrome.zip',
    sha256: crypto.createHash('sha256').update(fs.readFileSync(archivePath)).digest('hex'),
    archiveRoot: 'chrome-win64',
    executableRelativePath: 'chrome-win64/chrome.exe',
  }, null, 2)}`)
}
