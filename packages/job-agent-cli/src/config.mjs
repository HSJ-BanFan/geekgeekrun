import fs from 'node:fs'
import path from 'node:path'
import { readConfigFile, readStorageFile, storageFilePath } from '@geekgeekrun/geek-auto-start-chat-with-boss/runtime-file-utils.mjs'

export function loadRuntimeConfig () {
  const boss = readConfigFile('boss.json') ?? {}
  const llm = readConfigFile('llm.json') ?? []
  return { boss, llm, storageFilePath }
}

export function getEnabledSearchKeywords (bossConfig) {
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
  const recordPath = path.join(storageFilePath, 'last-used-browser-record')
  if (!fs.existsSync(recordPath)) return ''
  return fs.readFileSync(recordPath, 'utf8').trim().split(/\r?\n/)[0] ?? ''
}

export function readBrowserState () {
  return {
    cookies: readStorageFile('boss-cookies.json'),
    localStorage: readStorageFile('boss-local-storage.json'),
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
