import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

export function assertMatchingDistributionVersions ({
  metadataPath,
  cliPackagePath,
  sidecarPyprojectPath,
}) {
  const metadata = readJson(metadataPath)
  const cliPackage = readJson(cliPackagePath)
  const sidecarVersion = readPyprojectVersion(sidecarPyprojectPath)
  const distributionVersion = String(metadata.distributionVersion ?? '').trim()
  const cliVersion = String(cliPackage.version ?? '').trim()

  if (!distributionVersion || !cliVersion || !sidecarVersion) {
    throw new Error('DISTRIBUTION_VERSION_INVALID: distribution component versions are required')
  }
  if (cliVersion !== distributionVersion) {
    throw new Error(
      `DISTRIBUTION_VERSION_MISMATCH: CLI ${cliVersion} does not match distribution ${distributionVersion}`
    )
  }
  if (sidecarVersion !== distributionVersion) {
    throw new Error(
      `DISTRIBUTION_VERSION_MISMATCH: sidecar ${sidecarVersion} does not match distribution ${distributionVersion}`
    )
  }
  return distributionVersion
}

export function assertBrowserCompatibility ({ browserMetadataPath, revisionsPath }) {
  const browserVersion = String(readJson(browserMetadataPath)?.version ?? '').trim()
  const revisions = fs.readFileSync(revisionsPath, 'utf8')
  const puppeteerVersion = revisions.match(/chrome:\s*['"]([^'"]+)['"]/)?.[1]?.trim() ?? ''
  if (!browserVersion || !puppeteerVersion) {
    throw new Error('BROWSER_VERSION_INVALID: browser metadata and Puppeteer revision are required')
  }
  if (browserVersion !== puppeteerVersion) {
    throw new Error(
      `BROWSER_VERSION_MISMATCH: managed browser ${browserVersion} does not match Puppeteer ${puppeteerVersion}`
    )
  }
  return browserVersion
}

export function finalizePortableBundle ({
  bundleRoot,
  metadataPath,
  cliPackagePath,
  sidecarPyprojectPath,
  nodeVersion,
}) {
  const distributionVersion = assertMatchingDistributionVersions({
    metadataPath,
    cliPackagePath,
    sidecarPyprojectPath,
  })
  const metadata = readJson(metadataPath)
  const resolvedBundleRoot = path.resolve(bundleRoot)
  const manifestPath = path.join(resolvedBundleRoot, 'job-agent-installation-manifest.json')
  const componentPaths = {
    nodeRuntime: 'runtime/node.exe',
    nodeCli: 'app/bin/ggr-main.mjs',
    sidecar: 'sidecar/ggr-sidecar.exe',
    ggrLauncher: 'ggr.cmd',
    sidecarLauncher: 'ggr-sidecar.cmd',
    credentialCleanup: 'installer-support/cleanup-job-agent-credentials.ps1',
  }

  requireFile(resolvedBundleRoot, componentPaths.nodeRuntime)
  requireFile(resolvedBundleRoot, componentPaths.nodeCli)
  requireFile(resolvedBundleRoot, componentPaths.sidecar)
  requireFile(resolvedBundleRoot, componentPaths.credentialCleanup)
  fs.writeFileSync(
    path.join(resolvedBundleRoot, componentPaths.ggrLauncher),
    launcherText('runtime\\node.exe', 'app\\bin\\ggr.mjs'),
    'utf8'
  )
  fs.writeFileSync(
    path.join(resolvedBundleRoot, componentPaths.sidecarLauncher),
    launcherText('sidecar\\ggr-sidecar.exe'),
    'utf8'
  )
  fs.rmSync(manifestPath, { force: true })

  const components = {
    nodeRuntime: componentRecord({
      bundleRoot: resolvedBundleRoot,
      relativePath: componentPaths.nodeRuntime,
      distributionVersion,
      runtimeVersion: String(nodeVersion),
    }),
    nodeCli: componentRecord({
      bundleRoot: resolvedBundleRoot,
      relativePath: componentPaths.nodeCli,
      distributionVersion,
    }),
    sidecar: componentRecord({
      bundleRoot: resolvedBundleRoot,
      relativePath: componentPaths.sidecar,
      distributionVersion,
      runtimeVersion: '3.11',
    }),
    ggrLauncher: componentRecord({
      bundleRoot: resolvedBundleRoot,
      relativePath: componentPaths.ggrLauncher,
      distributionVersion,
    }),
    sidecarLauncher: componentRecord({
      bundleRoot: resolvedBundleRoot,
      relativePath: componentPaths.sidecarLauncher,
      distributionVersion,
    }),
    credentialCleanup: componentRecord({
      bundleRoot: resolvedBundleRoot,
      relativePath: componentPaths.credentialCleanup,
      distributionVersion,
    }),
  }
  const integrityFiles = listFiles(resolvedBundleRoot)
    .filter(filePath => filePath !== manifestPath)
    .map(filePath => ({
      path: portablePath(path.relative(resolvedBundleRoot, filePath)),
      sha256: sha256File(filePath),
    }))

  const manifest = {
    schemaVersion: metadata.contracts?.installationManifest,
    distributionName: metadata.name,
    distributionVersion,
    channel: metadata.channel,
    target: {
      os: 'windows',
      arch: 'x64',
    },
    contracts: metadata.contracts,
    features: metadata.features,
    components,
    integrity: {
      algorithm: 'sha256',
      files: integrityFiles,
    },
  }
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return manifest
}

export function materializeNodeApp ({ sourceRoot, destinationRoot }) {
  const resolvedSourceRoot = fs.realpathSync(path.resolve(sourceRoot))
  const resolvedDestinationRoot = path.resolve(destinationRoot)
  fs.rmSync(resolvedDestinationRoot, { recursive: true, force: true })
  copyMaterializedEntry({
    sourcePath: resolvedSourceRoot,
    destinationPath: resolvedDestinationRoot,
    sourceRoot: resolvedSourceRoot,
    activeRealPaths: new Set(),
    followedLink: false,
  })
  const virtualHoistRoot = path.join(resolvedSourceRoot, 'node_modules', '.pnpm', 'node_modules')
  if (fs.existsSync(virtualHoistRoot)) {
    copyMaterializedEntry({
      sourcePath: virtualHoistRoot,
      destinationPath: path.join(resolvedDestinationRoot, 'node_modules'),
      sourceRoot: resolvedSourceRoot,
      activeRealPaths: new Set([resolvedSourceRoot]),
      followedLink: true,
    })
  }
}

export function writeFrozenSidecarVersionModule ({ outputPath, distributionVersion }) {
  const version = String(distributionVersion ?? '').trim()
  if (!version) throw new Error('DISTRIBUTION_VERSION_INVALID: frozen sidecar version is required')
  const resolvedOutputPath = path.resolve(outputPath)
  fs.mkdirSync(path.dirname(resolvedOutputPath), { recursive: true })
  fs.writeFileSync(resolvedOutputPath, `DISTRIBUTION_VERSION = ${JSON.stringify(version)}\n`, 'utf8')
  return resolvedOutputPath
}

function readJson (filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function readPyprojectVersion (filePath) {
  const pyproject = fs.readFileSync(filePath, 'utf8')
  const projectSection = pyproject.match(/^\[project\]\s*$([\s\S]*?)(?=^\[|$(?![\s\S]))/m)?.[1] ?? ''
  return projectSection.match(/^version\s*=\s*["']([^"']+)["']\s*$/m)?.[1]?.trim() ?? ''
}

function launcherText (executablePath, entryPath = '') {
  const invocation = entryPath
    ? `"%~dp0${executablePath}" "%~dp0${entryPath}" %*`
    : `"%~dp0${executablePath}" %*`
  return [
    '@echo off',
    'setlocal',
    'set "GGR_JOB_AGENT_MODE=installed"',
    'set "GGR_JOB_AGENT_INSTALL_MANIFEST=%~dp0job-agent-installation-manifest.json"',
    invocation,
    'exit /b %ERRORLEVEL%',
    '',
  ].join('\r\n')
}

function componentRecord ({
  bundleRoot,
  relativePath,
  distributionVersion,
  runtimeVersion,
}) {
  const filePath = requireFile(bundleRoot, relativePath)
  return {
    path: portablePath(relativePath),
    distributionVersion,
    ...(runtimeVersion ? { runtimeVersion } : {}),
    sha256: sha256File(filePath),
  }
}

function requireFile (bundleRoot, relativePath) {
  const filePath = path.resolve(bundleRoot, relativePath)
  const relativeToRoot = path.relative(bundleRoot, filePath)
  if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
    throw new Error(`PORTABLE_COMPONENT_PATH_INVALID: ${relativePath}`)
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`PORTABLE_COMPONENT_MISSING: ${portablePath(relativePath)}`)
  }
  return filePath
}

function listFiles (directoryPath) {
  const files = []
  for (const entry of fs.readdirSync(directoryPath, { withFileTypes: true })) {
    const entryPath = path.join(directoryPath, entry.name)
    if (entry.isSymbolicLink()) {
      throw new Error(`PORTABLE_SYMLINK_NOT_ALLOWED: ${entryPath}`)
    }
    if (entry.isDirectory()) files.push(...listFiles(entryPath))
    if (entry.isFile()) files.push(entryPath)
  }
  return files.sort((left, right) => left.localeCompare(right, 'en'))
}

function copyMaterializedEntry ({
  sourcePath,
  destinationPath,
  sourceRoot,
  activeRealPaths,
  followedLink,
}) {
  const sourceStat = fs.lstatSync(sourcePath)
  if (sourceStat.isSymbolicLink()) {
    copyMaterializedEntry({
      sourcePath: fs.realpathSync(sourcePath),
      destinationPath,
      sourceRoot,
      activeRealPaths,
      followedLink: true,
    })
    return
  }
  if (sourceStat.isDirectory()) {
    if (!followedLink && excludedDeployDirectory(sourcePath, sourceRoot)) return
    const realPath = fs.realpathSync(sourcePath)
    if (activeRealPaths.has(realPath)) return
    activeRealPaths.add(realPath)
    fs.mkdirSync(destinationPath, { recursive: true })
    for (const entry of fs.readdirSync(sourcePath)) {
      copyMaterializedEntry({
        sourcePath: path.join(sourcePath, entry),
        destinationPath: path.join(destinationPath, entry),
        sourceRoot,
        activeRealPaths,
        followedLink: false,
      })
    }
    activeRealPaths.delete(realPath)
    return
  }
  if (sourceStat.isFile()) {
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true })
    fs.copyFileSync(sourcePath, destinationPath)
  }
}

function excludedDeployDirectory (sourcePath, sourceRoot) {
  const relativePath = portablePath(path.relative(sourceRoot, sourcePath))
  return relativePath === 'artifacts' ||
    relativePath === 'node_modules/.pnpm' ||
    relativePath === 'node_modules/.bin'
}

export function sha256File (filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function portablePath (filePath) {
  return filePath.replaceAll('\\', '/')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const metadataPath = path.join(repoRoot, 'packages', 'job-agent-cli', 'distribution-metadata.json')
  const cliPackagePath = path.join(repoRoot, 'packages', 'job-agent-cli', 'package.json')
  const sidecarPyprojectPath = path.join(repoRoot, 'packages', 'job-agent-sidecar', 'pyproject.toml')
  if (process.argv[2] === 'check-versions') {
    const distributionVersion = assertMatchingDistributionVersions({
      metadataPath,
      cliPackagePath,
      sidecarPyprojectPath,
    })
    process.stdout.write(`${JSON.stringify({
      ok: true,
      command: 'check-job-agent-distribution-versions',
      distributionVersion,
    }, null, 2)}\n`)
    process.exit(0)
  }
  if (process.argv[2] === 'materialize-node-app') {
    const options = parseOptions(process.argv.slice(3))
    materializeNodeApp({
      sourceRoot: requiredOption(options, 'source-root'),
      destinationRoot: requiredOption(options, 'destination-root'),
    })
    process.stdout.write(`${JSON.stringify({
      ok: true,
      command: 'materialize-job-agent-node-app',
      sourceRoot: path.resolve(requiredOption(options, 'source-root')),
      destinationRoot: path.resolve(requiredOption(options, 'destination-root')),
    }, null, 2)}\n`)
    process.exit(0)
  }
  if (process.argv[2] === 'check-browser-compatibility') {
    const options = parseOptions(process.argv.slice(3))
    const appRoot = path.resolve(requiredOption(options, 'app-root'))
    const browserVersion = assertBrowserCompatibility({
      browserMetadataPath: path.join(appRoot, 'browser-distribution.json'),
      revisionsPath: path.join(appRoot, 'node_modules', 'puppeteer-core', 'lib', 'esm', 'puppeteer', 'revisions.js'),
    })
    process.stdout.write(`${JSON.stringify({
      ok: true,
      command: 'check-job-agent-browser-compatibility',
      browserVersion,
    }, null, 2)}\n`)
    process.exit(0)
  }
  if (process.argv[2] === 'write-sidecar-build-version') {
    const options = parseOptions(process.argv.slice(3))
    const distributionVersion = assertMatchingDistributionVersions({
      metadataPath,
      cliPackagePath,
      sidecarPyprojectPath,
    })
    const outputPath = writeFrozenSidecarVersionModule({
      outputPath: requiredOption(options, 'output'),
      distributionVersion,
    })
    process.stdout.write(`${JSON.stringify({
      ok: true,
      command: 'write-frozen-sidecar-version',
      distributionVersion,
      outputPath,
    }, null, 2)}\n`)
    process.exit(0)
  }
  if (process.argv[2] === 'hash-file') {
    const options = parseOptions(process.argv.slice(3))
    const filePath = path.resolve(requiredOption(options, 'file'))
    process.stdout.write(`${JSON.stringify({
      ok: true,
      command: 'hash-job-agent-portable-file',
      filePath,
      sha256: sha256File(filePath),
    }, null, 2)}\n`)
    process.exit(0)
  }
  const options = parseOptions(process.argv.slice(2))
  const manifest = finalizePortableBundle({
    bundleRoot: requiredOption(options, 'bundle-root'),
    nodeVersion: requiredOption(options, 'node-version'),
    metadataPath,
    cliPackagePath,
    sidecarPyprojectPath,
  })
  process.stdout.write(`${JSON.stringify({
    ok: true,
    command: 'finalize-job-agent-portable',
    bundleRoot: path.resolve(requiredOption(options, 'bundle-root')),
    distributionVersion: manifest.distributionVersion,
    componentCount: Object.keys(manifest.components).length,
    integrityFileCount: manifest.integrity.files.length,
  }, null, 2)}\n`)
}

function parseOptions (args) {
  const options = {}
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]
    const value = args[index + 1]
    if (!name?.startsWith('--') || value === undefined) {
      throw new Error(`PORTABLE_BUILD_ARGUMENT_INVALID: ${name ?? ''}`)
    }
    options[name.slice(2)] = value
  }
  return options
}

function requiredOption (options, name) {
  const value = String(options[name] ?? '').trim()
  if (!value) throw new Error(`PORTABLE_BUILD_ARGUMENT_REQUIRED: --${name}`)
  return value
}
