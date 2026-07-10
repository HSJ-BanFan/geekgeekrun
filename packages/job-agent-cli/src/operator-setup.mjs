import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

import { acquireBrowserProfileLock, browserRuntimeError } from './browser-runtime.mjs'

const defaultMetadataPath = fileURLToPath(new URL('../browser-distribution.json', import.meta.url))

export async function runSetupCommand (runtimeContext, args, {
  writeProgress = message => process.stderr.write(`${message}\n`),
  waitForEnter = defaultWaitForEnter,
  fetchImpl = fetch,
  spawnSyncImpl = spawnSync,
  browserMetadataPath = defaultMetadataPath,
} = {}) {
  const action = args[0] && !args[0].startsWith('--') ? args[0] : 'provision'
  const optionArgs = action === 'provision' ? args : args.slice(1)
  const options = parseOptions(optionArgs)

  if (action === 'reset-profile') return resetProfile(runtimeContext, options)
  if (action === 'login') {
    return await completeManualLogin(runtimeContext, { writeProgress, waitForEnter })
  }
  if (!['provision', 'repair'].includes(action)) {
    throw setupError('SETUP_ACTION_UNSUPPORTED', `Unsupported setup action: ${action}`)
  }

  if (runtimeContext.mode === 'installed' && options['browser-metadata']) {
    throw setupError(
      'BROWSER_METADATA_OVERRIDE_FORBIDDEN',
      'Installed setup always uses the browser metadata shipped in the verified installation'
    )
  }
  const metadata = readMetadata(options['browser-metadata'] || browserMetadataPath)
  const setupLock = acquireBrowserProfileLock(runtimeContext)
  let browser
  try {
    browser = options['system-browser']
      ? selectSystemBrowser({
          runtimeContext,
          executablePath: options['system-browser'],
          metadata,
          allowUnsupported: options['allow-unsupported-system-browser'] === true,
          spawnSyncImpl,
          writeProgress,
        })
      : await provisionManagedBrowser({
          runtimeContext,
          archivePath: options['offline-archive'],
          metadata,
          repair: action === 'repair',
          fetchImpl,
          spawnSyncImpl,
          writeProgress,
        })
  } finally {
    setupLock.release()
  }

  if (options['skip-login']) {
    return {
      ok: true,
      command: 'setup',
      action,
      browser,
      session: { status: 'not-checked', reasonCode: 'BOSS_SESSION_UNKNOWN' },
      reasonCode: null,
      nextActions: ['Run ggr setup login in an interactive terminal'],
    }
  }
  const login = await completeManualLogin(runtimeContext, { writeProgress, waitForEnter })
  return { ...login, action, browser }
}

export function readBrowserDistributionMetadata (filePath = defaultMetadataPath) {
  return readMetadata(filePath)
}

async function provisionManagedBrowser ({
  runtimeContext,
  archivePath,
  metadata,
  repair,
  fetchImpl,
  spawnSyncImpl,
  writeProgress,
}) {
  const current = readJson(path.join(runtimeContext.browserRoot, 'browser.json'))
  if (!repair && !archivePath && current?.selectionMode === 'managed' &&
      current.version === metadata.version && fs.existsSync(current.executablePath)) {
    writeProgress(`Managed browser ${metadata.version} is already installed; preserving the profile.`)
    return current
  }

  fs.mkdirSync(runtimeContext.tempRoot, { recursive: true })
  const stagingRoot = path.join(runtimeContext.tempRoot, `browser-setup-${crypto.randomUUID()}`)
  const extractRoot = path.join(stagingRoot, 'extract')
  fs.mkdirSync(extractRoot, { recursive: true })
  let resolvedArchivePath = archivePath ? path.resolve(String(archivePath)) : path.join(stagingRoot, 'browser.zip')
  try {
    if (archivePath) {
      writeProgress(`Verifying offline browser archive for ${metadata.version}...`)
      if (!fs.existsSync(resolvedArchivePath) || !fs.statSync(resolvedArchivePath).isFile()) {
        throw setupError('BROWSER_ARCHIVE_NOT_FOUND', 'The selected offline browser archive was not found')
      }
    } else {
      writeProgress(`Downloading managed browser ${metadata.version}...`)
      await downloadFile(metadata.url, resolvedArchivePath, { fetchImpl })
    }
    const actualHash = sha256File(resolvedArchivePath)
    if (actualHash !== metadata.sha256) {
      throw setupError('BROWSER_ARCHIVE_HASH_MISMATCH', 'The browser archive checksum did not match supported metadata')
    }
    writeProgress('Browser archive integrity verified; extracting to a staging directory...')
    const extracted = spawnSyncImpl('tar.exe', ['-x', '-f', resolvedArchivePath, '-C', extractRoot], {
      encoding: 'utf8',
      windowsHide: true,
    })
    if (extracted.status !== 0) {
      throw setupError('BROWSER_ARCHIVE_EXTRACTION_FAILED', 'The verified browser archive could not be extracted')
    }
    const stagedExecutable = path.join(extractRoot, ...metadata.executableRelativePath.split('/'))
    if (!fs.existsSync(stagedExecutable) || !fs.statSync(stagedExecutable).isFile()) {
      throw setupError('BROWSER_ARCHIVE_LAYOUT_INVALID', 'The verified browser archive has an unsupported layout')
    }

    const managedRoot = path.join(runtimeContext.browserRoot, 'managed')
    const destinationRoot = path.join(managedRoot, metadata.version)
    const stagedBrowserRoot = path.join(extractRoot, metadata.archiveRoot)
    fs.mkdirSync(managedRoot, { recursive: true })
    removeWithin(destinationRoot, managedRoot)
    fs.renameSync(stagedBrowserRoot, destinationRoot)
    const executablePath = path.join(destinationRoot, path.basename(metadata.executableRelativePath))
    const configuration = {
      schemaVersion: 'job-agent-browser-config.v1',
      selectionMode: 'managed',
      product: metadata.product,
      version: metadata.version,
      executablePath,
      archiveSha256: metadata.sha256,
      supported: true,
    }
    writeJsonAtomic(path.join(runtimeContext.browserRoot, 'browser.json'), configuration)
    writeProgress(`Managed browser ${metadata.version} is ready.`)
    return configuration
  } finally {
    removeWithin(stagingRoot, runtimeContext.tempRoot)
  }
}

function selectSystemBrowser ({
  runtimeContext,
  executablePath,
  metadata,
  allowUnsupported,
  spawnSyncImpl,
  writeProgress,
}) {
  const resolvedPath = path.resolve(String(executablePath))
  writeProgress('Validating the explicitly selected system browser...')
  if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
    throw setupError('BROWSER_EXECUTABLE_MISSING', 'The explicitly selected system browser does not exist')
  }
  const inspected = spawnSyncImpl(resolvedPath, ['--version'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15000,
  })
  const reportedVersion = `${inspected.stdout ?? ''} ${inspected.stderr ?? ''}`.match(/\d+(?:\.\d+){1,3}/)?.[0] ?? ''
  const supported = reportedVersion.split('.')[0] === metadata.version.split('.')[0]
  if (!supported && !allowUnsupported) {
    throw setupError(
      'BROWSER_VERSION_UNSUPPORTED',
      'The selected system browser does not match the supported browser baseline'
    )
  }
  const configuration = {
    schemaVersion: 'job-agent-browser-config.v1',
    selectionMode: 'system-explicit',
    product: 'system-browser',
    version: reportedVersion || 'unknown',
    executablePath: resolvedPath,
    supported,
    supportedBaseline: metadata.version,
  }
  writeJsonAtomic(path.join(runtimeContext.browserRoot, 'browser.json'), configuration)
  writeProgress(`Explicit system browser selected${supported ? '' : ' with an unsupported-version override'}.`)
  return configuration
}

async function completeManualLogin (runtimeContext, { writeProgress, waitForEnter }) {
  const configuration = readJson(path.join(runtimeContext.browserRoot, 'browser.json'))
  if (!configuration?.executablePath || !fs.existsSync(configuration.executablePath)) {
    throw setupError('BROWSER_NOT_CONFIGURED', 'Provision a browser before starting manual login')
  }
  if (!process.stdin.isTTY) {
    return {
      ok: false,
      command: 'setup',
      session: { status: 'not-checked', reasonCode: 'INTERACTIVE_LOGIN_REQUIRED' },
      reasonCode: 'INTERACTIVE_LOGIN_REQUIRED',
      nextActions: ['Run ggr setup login in an interactive terminal'],
    }
  }
  writeProgress('Opening the visible managed browser. Complete BOSS login manually; no password or Cookie input is accepted by the CLI.')
  const { openBrowser } = await import('./browser-actions.mjs')
  const opened = await openBrowser({ headless: false })
  try {
    await opened.page.goto('https://www.zhipin.com/web/user/', {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    }).catch(() => {})
    await waitForEnter('After login is complete, press Enter to verify the session: ')
    const state = await opened.page.evaluate(() => ({
      url: location.href,
      title: document.title ?? '',
      visibleText: (document.body?.innerText ?? '').slice(0, 1200),
      hasLoginControl: Boolean(document.querySelector(
        '[ka="header-login"], .header-login-btn, .btn-login, a[href*="ka=header-login"]'
      )),
      hasAuthenticatedNavigation: Boolean(document.querySelector(
        '[ka="header-personal"], [ka="header-resume"], [ka="header-geek"], [class*="user-nav"], [class*="geek-avatar"]'
      )),
      hasGeekWorkspace: Boolean(document.querySelector(
        '.page-jobs-main, .recommend-job-list, .user-list-content, .chat-conversation, [class*="geek-center"]'
      )),
    })).catch(() => ({ url: opened.page.url?.() ?? '', title: '', visibleText: '' }))
    const classification = classifyBossSessionState(state)
    const session = {
      schemaVersion: 'job-agent-boss-session-status.v1',
      status: classification.status,
      checkedAt: new Date().toISOString(),
      origin: safeOrigin(state.url),
    }
    writeJsonAtomic(path.join(runtimeContext.browserRoot, 'session.json'), session)
    return {
      ok: classification.status === 'ready',
      command: 'setup',
      session,
      reasonCode: classification.reasonCode,
      nextActions: loginNextActions(classification.status),
    }
  } finally {
    await opened.browser.close().catch(() => {})
  }
}

export function classifyBossSessionState ({
  url = '',
  title = '',
  visibleText = '',
  hasLoginControl = false,
  hasAuthenticatedNavigation = false,
  hasGeekWorkspace = false,
} = {}) {
  const haystack = `${url}\n${title}\n${visibleText}`
  if (/安全验证|验证后继续|拖动滑块|人机验证|security-check|captcha|verify/i.test(haystack)) {
    return { status: 'safety-verification', reasonCode: 'BOSS_SAFETY_VERIFICATION_REQUIRED' }
  }
  if (/环境异常|访问异常|网络错误|页面加载失败|无法访问此网站|chrome-error|ERR_[A-Z_]+/i.test(haystack)) {
    return { status: 'abnormal-environment', reasonCode: 'BOSS_ABNORMAL_ENVIRONMENT' }
  }
  if (hasLoginControl || /登录\/注册|请登录|扫码登录|验证码登录|登录后继续/.test(haystack)) {
    return { status: 'login-required', reasonCode: 'BOSS_LOGIN_REQUIRED' }
  }

  let parsedUrl
  try {
    parsedUrl = new URL(url)
  } catch {
    return { status: 'abnormal-environment', reasonCode: 'BOSS_ABNORMAL_ENVIRONMENT' }
  }
  if (parsedUrl.origin !== 'https://www.zhipin.com') {
    return { status: 'abnormal-environment', reasonCode: 'BOSS_ABNORMAL_ENVIRONMENT' }
  }
  if (!/^\/web\/(?:geek|user)(?:\/|$)/.test(parsedUrl.pathname)) {
    return { status: 'unconfirmed', reasonCode: 'BOSS_SESSION_UNCONFIRMED' }
  }
  if (!hasAuthenticatedNavigation && !hasGeekWorkspace) {
    return { status: 'unconfirmed', reasonCode: 'BOSS_SESSION_UNCONFIRMED' }
  }
  return { status: 'ready', reasonCode: null }
}

function loginNextActions (status) {
  if (status === 'ready') return ['ggr doctor --require-browser']
  if (status === 'login-required') return ['Complete login and run ggr setup login again']
  if (status === 'safety-verification') return ['Complete the visible BOSS safety verification manually, then run ggr setup login again']
  if (status === 'abnormal-environment') return ['Check browser/network health, then run ggr setup login again']
  return ['Open a supported BOSS geek page in the managed browser, confirm login, then run ggr setup login again']
}

function resetProfile (runtimeContext, options) {
  if (options.confirm !== true) {
    throw setupError(
      'PROFILE_RESET_CONFIRMATION_REQUIRED',
      'Browser profile reset is destructive and requires --confirm'
    )
  }
  const lock = acquireBrowserProfileLock(runtimeContext)
  try {
    removeWithin(path.join(runtimeContext.browserRoot, 'profile'), runtimeContext.browserRoot)
    fs.rmSync(path.join(runtimeContext.browserRoot, 'session.json'), { force: true })
  } finally {
    lock.release()
  }
  return {
    ok: true,
    command: 'setup',
    action: 'reset-profile',
    removed: ['browser profile', 'BOSS session status'],
    preserved: ['browser binary', 'configuration', 'artifacts', 'Audit Records'],
    reasonCode: null,
  }
}

async function downloadFile (url, outputPath, { fetchImpl }) {
  const response = await fetchImpl(url, { redirect: 'follow' })
  if (!response.ok || !response.body) {
    throw setupError('BROWSER_DOWNLOAD_FAILED', 'The pinned browser download could not be completed')
  }
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(outputPath))
}

function readMetadata (configuredPath = '') {
  const filePath = configuredPath ? path.resolve(String(configuredPath)) : defaultMetadataPath
  const metadata = readJson(filePath)
  if (!metadata || metadata.schemaVersion !== 'job-agent-browser-distribution.v1' ||
      !metadata.version || !metadata.url || !/^[a-f0-9]{64}$/.test(metadata.sha256 ?? '') ||
      !metadata.archiveRoot || !metadata.executableRelativePath) {
    throw setupError('BROWSER_METADATA_INVALID', 'Browser distribution metadata is invalid')
  }
  return metadata
}

function writeJsonAtomic (filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.${crypto.randomUUID()}.tmp`
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  fs.renameSync(temporaryPath, filePath)
}

function readJson (filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return null
  }
}

function sha256File (filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function removeWithin (targetPath, rootPath) {
  if (!fs.existsSync(targetPath)) return
  const root = path.resolve(rootPath)
  const target = path.resolve(targetPath)
  const relative = path.relative(root, target)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw setupError('UNSAFE_RUNTIME_PATH', 'Refusing to remove a path outside the Job Agent runtime home')
  }
  fs.rmSync(target, { recursive: true, force: true })
}

function parseOptions (args) {
  const options = {}
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]
    if (!token?.startsWith('--')) continue
    const name = token.slice(2)
    const next = args[index + 1]
    if (next !== undefined && !next.startsWith('--')) {
      options[name] = next
      index += 1
    } else {
      options[name] = true
    }
  }
  return options
}

async function defaultWaitForEnter (prompt) {
  process.stderr.write(prompt)
  process.stdin.resume()
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) {
    if (String(chunk).includes('\n') || String(chunk).includes('\r')) break
  }
}

function safeOrigin (value) {
  try {
    return new URL(value).origin
  } catch {
    return ''
  }
}

function setupError (reasonCode, message) {
  return browserRuntimeError(reasonCode, message)
}
