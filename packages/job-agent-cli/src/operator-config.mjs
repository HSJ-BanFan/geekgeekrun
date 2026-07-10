import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import {
  createWindowsCredentialStore,
  parseWindowsCredentialReference,
} from './credential-store.mjs'

const configSchemaVersion = 'job-agent-config.v1'

export async function runConfigCommand (runtimeContext, args, {
  now = new Date(),
  credentialStore = createWindowsCredentialStore(),
  readSecret = readHiddenSecret,
} = {}) {
  const action = args[0] ?? 'path'
  const options = parseOptions(args.slice(1))
  const paths = configPaths(runtimeContext)

  if (action === 'path') {
    return {
      ok: true,
      command: 'config',
      action,
      schemaVersion: configSchemaVersion,
      configRoot: paths.configRoot,
      files: publicPaths(paths),
      reasonCode: null,
    }
  }

  if (action === 'init') return initializeConfig(paths, now)
  if (action === 'validate') return validateConfig(paths)
  if (action === 'import-desktop') return importDesktopConfig(paths, options, now)
  if (action === 'secret') {
    return await runSecretCommand(paths, args.slice(1), { credentialStore, readSecret, now })
  }

  return {
    ok: false,
    command: 'config',
    action,
    reasonCode: 'CONFIG_ACTION_UNSUPPORTED',
    error: `Unsupported config action: ${action}`,
    availableActions: ['path', 'init', 'validate', 'import-desktop', 'secret'],
  }
}

export function configPaths (runtimeContext) {
  return {
    configRoot: runtimeContext.configRoot,
    operator: path.join(runtimeContext.configRoot, 'operator.json'),
    boss: path.join(runtimeContext.configRoot, 'boss.json'),
    llm: path.join(runtimeContext.configRoot, 'llm.json'),
    resumes: path.join(runtimeContext.configRoot, 'resumes.json'),
  }
}

function initializeConfig (paths, now) {
  fs.mkdirSync(paths.configRoot, { recursive: true })
  const createdFiles = []
  writeIfMissing(paths.operator, {
    schemaVersion: configSchemaVersion,
    createdAt: now.toISOString(),
    credentials: {},
  }, createdFiles)
  writeIfMissing(paths.boss, {}, createdFiles)
  writeIfMissing(paths.llm, [], createdFiles)
  return {
    ok: true,
    command: 'config',
    action: 'init',
    schemaVersion: configSchemaVersion,
    status: 'ready',
    created: createdFiles.length > 0,
    createdFiles,
    configRoot: paths.configRoot,
    files: publicPaths(paths),
    reasonCode: null,
  }
}

function validateConfig (paths) {
  if (!fs.existsSync(paths.operator)) {
    return {
      ok: false,
      command: 'config',
      action: 'validate',
      status: 'not_initialized',
      reasonCode: 'CONFIG_NOT_INITIALIZED',
      nextActions: ['ggr config init'],
    }
  }
  const operator = readJson(paths.operator)
  const boss = readJson(paths.boss)
  const llm = readJson(paths.llm)
  const errors = []
  if (!operator.ok || !isRecord(operator.value) || operator.value.schemaVersion !== configSchemaVersion) {
    errors.push({ file: paths.operator, reasonCode: 'OPERATOR_CONFIG_INVALID' })
  } else {
    for (const [name, reference] of Object.entries(operator.value.credentials ?? {})) {
      if (!/^[A-Za-z0-9._-]+$/.test(name) || !parseWindowsCredentialReference(reference)) {
        errors.push({ file: paths.operator, reasonCode: 'CREDENTIAL_REFERENCE_INVALID', credentialName: name })
      }
    }
  }
  if (!boss.ok || !isRecord(boss.value)) {
    errors.push({ file: paths.boss, reasonCode: 'BOSS_CONFIG_INVALID' })
  }
  if (!llm.ok || (!Array.isArray(llm.value) && !isRecord(llm.value))) {
    errors.push({ file: paths.llm, reasonCode: 'LLM_CONFIG_INVALID' })
  } else {
    for (const [index, item] of llmEntries(llm.value).entries()) {
      if (!isRecord(item)) continue
      if (String(item.providerApiSecret ?? item.apiKey ?? '').trim()) {
        errors.push({ file: paths.llm, reasonCode: 'LLM_PLAINTEXT_SECRET_FORBIDDEN', index })
      }
      if (item.credentialRef !== undefined && !parseWindowsCredentialReference(item.credentialRef)) {
        errors.push({ file: paths.llm, reasonCode: 'CREDENTIAL_REFERENCE_INVALID', index })
      }
    }
  }
  return {
    ok: errors.length === 0,
    command: 'config',
    action: 'validate',
    schemaVersion: configSchemaVersion,
    status: errors.length ? 'invalid' : 'ready',
    configRoot: paths.configRoot,
    files: publicPaths(paths),
    errors,
    reasonCode: errors.length ? 'CONFIG_INVALID' : null,
    nextActions: errors.length ? ['Repair the listed JSON files or run ggr config init after backing them up'] : [],
  }
}

function llmEntries (value) {
  if (Array.isArray(value)) return value
  return Array.isArray(value?.configList) ? value.configList : []
}

function importDesktopConfig (paths, options, now) {
  const configuredRoot = String(options['desktop-config-root'] ?? '').trim()
  if (!configuredRoot) {
    return {
      ok: false,
      command: 'config',
      action: 'import-desktop',
      reasonCode: 'DESKTOP_CONFIG_ROOT_REQUIRED',
      error: '--desktop-config-root is required so data crossing is explicit',
    }
  }
  const desktopConfigRoot = path.resolve(configuredRoot)
  if (!fs.existsSync(desktopConfigRoot) || !fs.statSync(desktopConfigRoot).isDirectory()) {
    return {
      ok: false,
      command: 'config',
      action: 'import-desktop',
      reasonCode: 'DESKTOP_CONFIG_NOT_FOUND',
      desktopConfigRoot,
    }
  }

  initializeConfig(paths, now)
  const imported = []
  const skipped = []
  for (const fileName of ['boss.json', 'resumes.json', 'llm.json']) {
    const sourcePath = path.join(desktopConfigRoot, fileName)
    if (!fs.existsSync(sourcePath)) {
      skipped.push(fileName)
      continue
    }
    const parsed = readJson(sourcePath)
    if (!parsed.ok) {
      return {
        ok: false,
        command: 'config',
        action: 'import-desktop',
        reasonCode: 'DESKTOP_CONFIG_INVALID',
        fileName,
      }
    }
    const value = fileName === 'llm.json' ? stripSecretValues(parsed.value) : parsed.value
    fs.writeFileSync(path.join(paths.configRoot, fileName), `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    imported.push(fileName)
  }
  return {
    ok: true,
    command: 'config',
    action: 'import-desktop',
    desktopConfigRoot,
    configRoot: paths.configRoot,
    imported,
    skipped,
    excluded: ['browser sessions', 'authorization tokens', 'mutable storage', 'LLM secret values'],
    reasonCode: null,
    nextActions: imported.includes('llm.json')
      ? ['Store each required LLM secret with ggr config secret set']
      : [],
  }
}

async function runSecretCommand (paths, args, { credentialStore, readSecret, now }) {
  const action = args[0] ?? 'status'
  const options = parseOptions(args.slice(1))
  if (options.value !== undefined || options.secret !== undefined || options['api-key'] !== undefined) {
    return {
      ok: false,
      command: 'config',
      action: `secret-${action}`,
      reasonCode: 'SECRET_COMMAND_LINE_INPUT_FORBIDDEN',
      error: 'Secret values must be entered through the hidden interactive prompt',
    }
  }
  const name = String(options.name ?? '').trim()
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    return {
      ok: false,
      command: 'config',
      action: `secret-${action}`,
      reasonCode: 'CREDENTIAL_NAME_INVALID',
      error: '--name must contain only letters, numbers, dot, underscore, or hyphen',
    }
  }
  const target = `GeekGeekRun/JobAgent/${name}`
  const credentialRef = `windows-credential:${target}`

  if (action === 'set') {
    const secret = await readSecret({ prompt: `Enter secret for ${name}: ` })
    if (!secret) {
      return {
        ok: false,
        command: 'config',
        action: 'secret-set',
        credentialName: name,
        reasonCode: 'INTERACTIVE_SECRET_REQUIRED',
      }
    }
    const stored = credentialStore.set({ target, secret })
    if (!stored.ok) {
      return {
        ok: false,
        command: 'config',
        action: 'secret-set',
        credentialName: name,
        reasonCode: stored.reasonCode,
      }
    }
    initializeConfig(paths, now)
    const operator = readJson(paths.operator).value
    operator.credentials = isRecord(operator.credentials) ? operator.credentials : {}
    operator.credentials[name] = credentialRef
    fs.writeFileSync(paths.operator, `${JSON.stringify(operator, null, 2)}\n`, 'utf8')
    return {
      ok: true,
      command: 'config',
      action: 'secret-set',
      credentialName: name,
      credentialRef,
      storedIn: 'windows-credential-manager',
      reasonCode: null,
    }
  }

  if (action === 'status') {
    const status = credentialStore.exists({ target })
    return {
      ok: status.ok,
      command: 'config',
      action: 'secret-status',
      credentialName: name,
      credentialRef,
      configured: status.exists === true,
      reasonCode: status.ok ? null : status.reasonCode,
    }
  }

  if (action === 'delete') {
    const deleted = credentialStore.delete({ target })
    if (fs.existsSync(paths.operator)) {
      const parsed = readJson(paths.operator)
      if (parsed.ok && isRecord(parsed.value.credentials)) {
        delete parsed.value.credentials[name]
        fs.writeFileSync(paths.operator, `${JSON.stringify(parsed.value, null, 2)}\n`, 'utf8')
      }
    }
    return {
      ok: deleted.ok,
      command: 'config',
      action: 'secret-delete',
      credentialName: name,
      configured: false,
      reasonCode: deleted.ok ? null : deleted.reasonCode,
    }
  }

  return {
    ok: false,
    command: 'config',
    action: `secret-${action}`,
    reasonCode: 'SECRET_ACTION_UNSUPPORTED',
    availableActions: ['set', 'status', 'delete'],
  }
}

function writeIfMissing (filePath, value, createdFiles) {
  if (fs.existsSync(filePath)) return
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  createdFiles.push(filePath)
}

function publicPaths (paths) {
  return {
    operator: paths.operator,
    boss: paths.boss,
    llm: paths.llm,
    resumes: paths.resumes,
  }
}

function readJson (filePath) {
  if (!fs.existsSync(filePath)) return { ok: false, value: null }
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '')) }
  } catch {
    return { ok: false, value: null }
  }
}

function isRecord (value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
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

function stripSecretValues (value) {
  if (Array.isArray(value)) return value.map(stripSecretValues)
  if (!isRecord(value)) return value
  const output = {}
  for (const [key, child] of Object.entries(value)) {
    if (/^(?:apiKey|providerApiSecret|secret|password|accessToken|token|credentialRef)$/i.test(key)) continue
    output[key] = stripSecretValues(child)
  }
  return output
}

async function readHiddenSecret ({ prompt }) {
  if (!process.stdin.isTTY || !process.stderr.isTTY) return ''
  process.stderr.write(prompt)
  process.stdin.setRawMode?.(true)
  process.stdin.resume()
  process.stdin.setEncoding('utf8')
  let value = ''
  try {
    for await (const chunk of process.stdin) {
      for (const character of chunk) {
        if (character === '\r' || character === '\n') {
          process.stderr.write('\n')
          return value
        }
        if (character === '\u0003') throw new Error('SECRET_INPUT_CANCELLED')
        if (character === '\u007f' || character === '\b') {
          value = value.slice(0, -1)
          continue
        }
        value += character
      }
    }
    return value
  } finally {
    process.stdin.setRawMode?.(false)
    process.stdin.pause()
  }
}
