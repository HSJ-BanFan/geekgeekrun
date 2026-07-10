import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const metadata = JSON.parse(fs.readFileSync(new URL('../distribution-metadata.json', import.meta.url), 'utf8'))

export function versionReport (runtimeContext) {
  const installedManifest = runtimeContext.mode === 'installed'
    ? readInstallationManifest(runtimeContext.installManifestPath)
    : null
  const manifest = installedManifest?.manifest ?? installedManifest?.value ?? null
  const distributionVersion = typeof manifest?.distributionVersion === 'string'
    ? manifest.distributionVersion
    : metadata.distributionVersion
  const contracts = isRecord(manifest?.contracts)
    ? manifest.contracts
    : metadata.contracts

  return {
    ok: runtimeContext.mode !== 'installed' || installedManifest.ok,
    command: 'version',
    schemaVersion: 'job-agent-version.v1',
    distribution: {
      name: metadata.name,
      version: distributionVersion,
      channel: metadata.channel,
    },
    contracts,
    runtimeMode: runtimeContext.mode,
    reasonCode: runtimeContext.mode === 'installed' && !installedManifest.ok
      ? installedManifest.reasonCode
      : null,
  }
}

export function runDoctor (runtimeContext, { requireBrowser = false } = {}) {
  const installation = diagnoseInstallation(runtimeContext)
  const sidecar = diagnoseSidecar(runtimeContext, installation)
  const browser = diagnoseBrowser(runtimeContext)
  const bossSession = diagnoseBossSession(runtimeContext)
  const installationReady = installation.ready && sidecar.ready
  const browserReady = browser.ready && bossSession.ready
  const ok = installationReady && (!requireBrowser || browserReady)
  const reasonCode = !installationReady
    ? 'INSTALLATION_NOT_READY'
    : requireBrowser && !browser.ready
      ? 'BROWSER_NOT_READY'
      : requireBrowser && !bossSession.ready
        ? 'BOSS_SESSION_NOT_READY'
      : null

  return {
    ok,
    command: 'doctor',
    schemaVersion: 'job-agent-doctor.v1',
    reasonCode,
    requireBrowser,
    distribution: versionReport(runtimeContext).distribution,
    contracts: metadata.contracts,
    features: runtimeContext.mode === 'installed'
      ? installation.manifest?.features ?? null
      : metadata.features,
    runtime: publicRuntimeContext(runtimeContext),
    checks: {
      installation: withoutManifest(installation),
      sidecar,
      browser,
      bossSession,
    },
  }
}

function diagnoseInstallation (runtimeContext) {
  if (runtimeContext.mode !== 'installed') {
    return {
      ready: true,
      reasonCode: null,
      manifestPath: null,
      integrity: 'not-applicable',
      componentChecks: {},
      integrityChecks: {},
      manifest: null,
    }
  }

  const manifestResult = readInstallationManifest(runtimeContext.installManifestPath)
  if (!manifestResult.ok) {
    return installationFailure(
      manifestResult.reasonCode,
      runtimeContext.installManifestPath,
      manifestResult.manifest
    )
  }

  const manifest = manifestResult.value
  const installRoot = path.dirname(runtimeContext.installManifestPath)
  const componentChecks = Object.fromEntries(
    Object.entries(manifest.components ?? {}).map(([name, component]) => [
      name,
      checkComponent(installRoot, component),
    ])
  )
  const integrityChecks = Object.fromEntries(
    (manifest.integrity?.files ?? []).map(file => [
      String(file?.path ?? ''),
      checkComponent(installRoot, file),
    ])
  )
  for (const componentName of ['nodeRuntime', 'nodeCli']) {
    if (!componentChecks[componentName]) {
      componentChecks[componentName] = componentFailure('COMPONENT_NOT_DECLARED')
    }
  }
  if (manifest.features?.sidecar && !componentChecks.sidecar) {
    componentChecks.sidecar = componentFailure('COMPONENT_NOT_DECLARED')
  }
  const failedComponent = [...Object.values(componentChecks), ...Object.values(integrityChecks)]
    .find(check => !check.ready)
  if (failedComponent) {
    return {
      ready: false,
      reasonCode: 'INSTALLATION_INTEGRITY_FAILED',
      manifestPath: runtimeContext.installManifestPath,
      integrity: 'failed',
      componentChecks,
      integrityChecks,
      manifest,
    }
  }

  return {
    ready: true,
    reasonCode: null,
    manifestPath: runtimeContext.installManifestPath,
    integrity: 'verified',
    componentChecks,
    integrityChecks,
    manifest,
  }
}

export function resolveInstalledComponent (runtimeContext, componentName) {
  if (runtimeContext.mode !== 'installed') {
    return {
      ok: false,
      reasonCode: 'INSTALLED_RUNTIME_REQUIRED',
      path: null,
    }
  }
  const installation = diagnoseInstallation(runtimeContext)
  if (!installation.ready) {
    return {
      ok: false,
      reasonCode: installation.reasonCode,
      path: null,
    }
  }
  const component = installation.componentChecks?.[componentName]
  if (!component?.ready) {
    return {
      ok: false,
      reasonCode: component?.reasonCode ?? 'COMPONENT_NOT_DECLARED',
      path: component?.path ?? null,
    }
  }
  return {
    ok: true,
    reasonCode: null,
    path: component.path,
  }
}

function diagnoseSidecar (runtimeContext, installation) {
  if (runtimeContext.mode !== 'installed') {
    return {
      ready: true,
      available: true,
      reasonCode: null,
    }
  }
  if (!installation.ready) {
    return {
      ready: false,
      available: installation.manifest?.features?.sidecar === true,
      reasonCode: 'SIDECAR_NOT_READY',
    }
  }
  const ready = installation.componentChecks?.sidecar?.ready === true
  return {
    ready,
    available: true,
    reasonCode: ready ? null : 'SIDECAR_NOT_READY',
  }
}

function diagnoseBrowser (runtimeContext) {
  const configurationPath = runtimeContext.mode === 'installed'
    ? path.join(runtimeContext.browserRoot, 'browser.json')
    : path.join(runtimeContext.browserRoot, 'last-used-browser-record')
  if (!fs.existsSync(configurationPath)) {
    return {
      ready: false,
      configured: false,
      reasonCode: 'BROWSER_NOT_CONFIGURED',
      configurationPath,
    }
  }

  const executablePath = runtimeContext.mode === 'installed'
    ? readInstalledBrowserPath(configurationPath)
    : readSourceBrowserPath(configurationPath)
  if (!executablePath) {
    return {
      ready: false,
      configured: false,
      reasonCode: 'BROWSER_CONFIGURATION_INVALID',
      configurationPath,
    }
  }
  if (!fs.existsSync(executablePath)) {
    return {
      ready: false,
      configured: true,
      reasonCode: 'BROWSER_EXECUTABLE_MISSING',
      configurationPath,
      executablePath,
    }
  }
  return {
    ready: true,
    configured: true,
    reasonCode: null,
    configurationPath,
    executablePath,
  }
}

function diagnoseBossSession (runtimeContext) {
  const sessionPath = runtimeContext.mode === 'installed'
    ? path.join(runtimeContext.browserRoot, 'session.json')
    : path.join(runtimeContext.browserRoot, 'boss-cookies.json')
  if (!fs.existsSync(sessionPath)) {
    return {
      ready: false,
      known: false,
      status: 'unknown',
      reasonCode: 'BOSS_SESSION_UNKNOWN',
      sessionPath,
    }
  }
  if (runtimeContext.mode !== 'installed') {
    return { ready: true, known: true, status: 'legacy-state-present', reasonCode: null, sessionPath }
  }
  try {
    const value = JSON.parse(fs.readFileSync(sessionPath, 'utf8'))
    const ready = value?.status === 'ready'
    return {
      ready,
      known: true,
      status: String(value?.status ?? 'unknown'),
      checkedAt: value?.checkedAt ?? null,
      reasonCode: ready ? null : 'BOSS_SESSION_NOT_READY',
      sessionPath,
    }
  } catch {
    return {
      ready: false,
      known: true,
      status: 'invalid',
      reasonCode: 'BOSS_SESSION_STATUS_INVALID',
      sessionPath,
    }
  }
}

function checkComponent (installRoot, component) {
  const relativePath = String(component?.path ?? '').trim()
  const expectedHash = String(component?.sha256 ?? '').trim().toLowerCase()
  if (!relativePath || !expectedHash) return componentFailure('COMPONENT_METADATA_INVALID')
  const resolvedPath = path.resolve(installRoot, relativePath)
  const relativeToRoot = path.relative(installRoot, resolvedPath)
  if (path.isAbsolute(relativePath) || relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
    return componentFailure('COMPONENT_PATH_OUTSIDE_INSTALLATION')
  }
  if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
    return componentFailure('COMPONENT_FILE_MISSING', resolvedPath)
  }
  const actualHash = sha256(resolvedPath)
  if (actualHash !== expectedHash) {
    return componentFailure('COMPONENT_HASH_MISMATCH', resolvedPath)
  }
  return {
    ready: true,
    reasonCode: null,
    path: resolvedPath,
    sha256: actualHash,
  }
}

function installationFailure (reasonCode, manifestPath, manifest = null) {
  return {
    ready: false,
    reasonCode,
    manifestPath: manifestPath || null,
    integrity: 'failed',
    componentChecks: {},
    integrityChecks: {},
    manifest,
  }
}

function componentFailure (reasonCode, componentPath = null) {
  return {
    ready: false,
    reasonCode,
    path: componentPath,
  }
}

function readJson (filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return { ok: false, reasonCode: 'INSTALL_MANIFEST_NOT_FOUND' }
  }
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(filePath, 'utf8')) }
  } catch {
    return { ok: false, reasonCode: 'INSTALL_MANIFEST_INVALID' }
  }
}

function readInstallationManifest (filePath) {
  const parsed = readJson(filePath)
  if (!parsed.ok) return parsed

  const manifest = parsed.value
  if (!isRecord(manifest)) {
    return { ok: false, reasonCode: 'INSTALL_MANIFEST_INVALID', manifest: null }
  }
  if (typeof manifest.schemaVersion !== 'string') {
    return { ok: false, reasonCode: 'INSTALL_MANIFEST_INVALID', manifest }
  }
  if (manifest.schemaVersion !== metadata.contracts.installationManifest) {
    return { ok: false, reasonCode: 'INSTALL_MANIFEST_SCHEMA_UNSUPPORTED', manifest }
  }
  if (typeof manifest.distributionVersion !== 'string' || !manifest.distributionVersion) {
    return { ok: false, reasonCode: 'INSTALL_MANIFEST_INVALID', manifest }
  }
  if (manifest.distributionVersion !== metadata.distributionVersion) {
    return { ok: false, reasonCode: 'DISTRIBUTION_VERSION_MISMATCH', manifest }
  }
  if (!isRecord(manifest.contracts)) {
    return { ok: false, reasonCode: 'INSTALL_MANIFEST_INVALID', manifest }
  }
  if (!sameContracts(manifest.contracts, metadata.contracts)) {
    return { ok: false, reasonCode: 'CONTRACT_VERSION_MISMATCH', manifest }
  }
  if (!isRecord(manifest.features)) {
    return { ok: false, reasonCode: 'INSTALL_MANIFEST_INVALID', manifest }
  }
  if (!sameFeatures(manifest.features, metadata.features)) {
    return { ok: false, reasonCode: 'DISTRIBUTION_FEATURE_MISMATCH', manifest }
  }
  if (!isRecord(manifest.components)) {
    return { ok: false, reasonCode: 'INSTALL_MANIFEST_INVALID', manifest }
  }
  if (manifest.integrity !== undefined && !validIntegrityMetadata(manifest.integrity)) {
    return { ok: false, reasonCode: 'INSTALL_MANIFEST_INVALID', manifest }
  }
  return { ok: true, value: manifest, manifest }
}

function readInstalledBrowserPath (configurationPath) {
  try {
    return String(JSON.parse(fs.readFileSync(configurationPath, 'utf8'))?.executablePath ?? '').trim()
  } catch {
    return ''
  }
}

function readSourceBrowserPath (configurationPath) {
  try {
    return fs.readFileSync(configurationPath, 'utf8').trim().split(/\r?\n/)[0] ?? ''
  } catch {
    return ''
  }
}

function sameContracts (actual, expected) {
  return Object.entries(expected).every(([name, version]) => actual?.[name] === version)
}

function sameFeatures (actual, expected) {
  return Object.entries(expected).every(([name, enabled]) => actual?.[name] === enabled)
}

function validIntegrityMetadata (integrity) {
  return isRecord(integrity) &&
    integrity.algorithm === 'sha256' &&
    Array.isArray(integrity.files) &&
    integrity.files.every(file => isRecord(file))
}

function isRecord (value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function sha256 (filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function publicRuntimeContext (runtimeContext) {
  return {
    mode: runtimeContext.mode,
    runtimeHome: runtimeContext.runtimeHome,
    configRoot: runtimeContext.configRoot,
    browserRoot: runtimeContext.browserRoot,
    dataRoot: runtimeContext.dataRoot,
    artifactRoot: runtimeContext.artifactRoot,
    auditRoot: runtimeContext.auditRoot,
    tokenRoot: runtimeContext.tokenRoot,
    tempRoot: runtimeContext.tempRoot,
    installManifestPath: runtimeContext.installManifestPath || null,
  }
}

function withoutManifest (installation) {
  const { manifest, ...publicInstallation } = installation
  return publicInstallation
}
