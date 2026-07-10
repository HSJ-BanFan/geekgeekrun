import fs from 'node:fs'
import path from 'node:path'
import { getRuntimeContext } from './runtime-context.mjs'
import {
  createWindowsCredentialStore,
  parseWindowsCredentialReference,
} from './credential-store.mjs'

const initialRuntimeContext = getRuntimeContext()
const sourceRuntimeFiles = initialRuntimeContext.mode === 'source'
  ? await import('@geekgeekrun/geek-auto-start-chat-with-boss/runtime-file-utils.mjs')
  : null
const sourceStorageFilePath = sourceRuntimeFiles?.storageFilePath ?? initialRuntimeContext.dataRoot

export function loadRuntimeConfig () {
  const runtimeContext = getRuntimeContext()
  if (runtimeContext.mode === 'installed') {
    const boss = readJsonIfPresent(path.join(runtimeContext.configRoot, 'boss.json'), {})
    const operator = readJsonIfPresent(path.join(runtimeContext.configRoot, 'operator.json'), {})
    const llm = resolveInstalledLlmSecrets(
      readJsonIfPresent(path.join(runtimeContext.configRoot, 'llm.json'), []),
      operator
    )
    return { boss, llm, storageFilePath: runtimeContext.dataRoot }
  }
  const boss = sourceRuntimeFiles.readConfigFile('boss.json') ?? {}
  const llm = sourceRuntimeFiles.readConfigFile('llm.json') ?? []
  return { boss, llm, storageFilePath: sourceStorageFilePath }
}

export function readRuntimeConfigFile (fileName, fallback = null) {
  const runtimeContext = getRuntimeContext()
  if (runtimeContext.mode === 'installed') {
    return readJsonIfPresent(path.join(runtimeContext.configRoot, fileName), fallback)
  }
  return sourceRuntimeFiles.readConfigFile(fileName) ?? fallback
}

export function getEnabledRecallKeywords (bossConfig) {
  const source = (bossConfig.jobSourceList ?? []).find(item => item?.type === 'search' && item?.enabled)
  return (source?.children ?? [])
    .filter(item => item?.enabled && String(item?.keyword ?? '').trim())
    .map(item => String(item.keyword).trim())
}

export function getGreetingRules (bossConfig) {
  return Array.isArray(bossConfig.autoStartChatGreetingMessageRules)
    ? bossConfig.autoStartChatGreetingMessageRules
      .map(rule => ({
        name: String(rule?.name ?? '').trim(),
        pattern: String(rule?.pattern ?? '').trim(),
        message: String(rule?.message ?? '').trim(),
      }))
      .filter(rule => rule.pattern && rule.message)
    : []
}

export function getDefaultGreeting (bossConfig) {
  return String(bossConfig.autoStartChatGreetingMessage ?? '').trim()
}

export function getResumeImagePath (bossConfig) {
  const enabled = bossConfig.autoStartChatGreetingImageEnabled !== false
  const imagePath = String(bossConfig.autoStartChatGreetingImagePath ?? '').trim()
  return enabled && imagePath ? imagePath : ''
}

export function getBrowserPath () {
  const runtimeContext = getRuntimeContext()
  if (runtimeContext.mode === 'installed') {
    return String(readJsonIfPresent(path.join(runtimeContext.browserRoot, 'browser.json'), {})?.executablePath ?? '').trim()
  }
  const recordPath = path.join(sourceStorageFilePath, 'last-used-browser-record')
  if (!fs.existsSync(recordPath)) return ''
  return fs.readFileSync(recordPath, 'utf8').trim().split(/\r?\n/)[0] ?? ''
}

export function getJobAgentBrowserProfileDir () {
  const runtimeContext = getRuntimeContext()
  const profileDir = runtimeContext.mode === 'installed'
    ? path.join(runtimeContext.browserRoot, 'profile')
    : path.join(sourceStorageFilePath, 'job-agent-chrome-profile')
  fs.mkdirSync(profileDir, { recursive: true })
  return profileDir
}

export function getAuditLogPath () {
  const runtimeContext = getRuntimeContext()
  return runtimeContext.mode === 'installed'
    ? path.join(runtimeContext.auditRoot, 'job-agent-audit.jsonl')
    : path.join(sourceStorageFilePath, 'job-agent-audit.jsonl')
}

export function getAuthorizationTokenStorePath () {
  const runtimeContext = getRuntimeContext()
  return runtimeContext.mode === 'installed'
    ? path.join(runtimeContext.tokenRoot, 'application-authorization-tokens.json')
    : path.join(sourceStorageFilePath, 'job-agent-authorization-tokens.json')
}

export function readBrowserState () {
  if (getRuntimeContext().mode === 'installed') {
    return { cookies: [], localStorage: {} }
  }
  return {
    cookies: sourceRuntimeFiles.readStorageFile('boss-cookies.json'),
    localStorage: sourceRuntimeFiles.readStorageFile('boss-local-storage.json'),
  }
}

export function getEnabledLlmConfig (llmConfig) {
  const list = Array.isArray(llmConfig)
    ? llmConfig
    : Array.isArray(llmConfig?.configList)
      ? llmConfig.configList
      : []
  return list.find(item =>
    item?.enabled !== false &&
    String(item?.providerCompleteApiUrl ?? item?.baseURL ?? '').trim() &&
    String(item?.providerApiSecret ?? item?.apiKey ?? '').trim() &&
    String(item?.model ?? '').trim()
  ) ?? null
}

function readJsonIfPresent (filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return fallback
  }
}

export function resolveInstalledLlmSecrets (llmConfig, operatorConfig, {
  credentialStore = createWindowsCredentialStore(),
} = {}) {
  const credentialRefs = isRecord(operatorConfig?.credentials) ? operatorConfig.credentials : {}
  const availableTargets = Object.values(credentialRefs)
    .map(parseWindowsCredentialReference)
    .filter(Boolean)
  const list = Array.isArray(llmConfig)
    ? llmConfig
    : Array.isArray(llmConfig?.configList)
      ? llmConfig.configList
      : []
  const resolved = list.map(item => {
    if (!isRecord(item)) return item
    const { providerApiSecret, apiKey, ...safeItem } = item
    const credentialName = String(item.credentialName ?? '').trim()
    const target = parseWindowsCredentialReference(
      item.credentialRef ??
      (credentialName ? credentialRefs[credentialName] : '') ??
      (availableTargets.length === 1 ? `windows-credential:${availableTargets[0]}` : '')
    )
    if (!target) return safeItem
    const result = credentialStore.get({ target })
    return result.ok ? { ...safeItem, providerApiSecret: result.secret } : safeItem
  })
  return Array.isArray(llmConfig) ? resolved : { ...llmConfig, configList: resolved }
}

function isRecord (value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
