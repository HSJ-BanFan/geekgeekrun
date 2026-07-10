import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

import {
  assertMatchingDistributionVersions,
  assertBrowserCompatibility,
  finalizePortableBundle,
  materializeNodeApp,
  sha256File,
  writeFrozenSidecarVersionModule,
} from './job-agent-portable.mjs'

const execFileAsync = promisify(execFile)

test('portable archive hashing does not depend on PowerShell command auto-loading', () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ggr-portable-hash-'))
  const filePath = path.join(fixtureRoot, 'archive.zip')
  fs.writeFileSync(filePath, 'portable archive fixture\n')

  assert.equal(
    sha256File(filePath),
    '740cd25913fcb1f277fdf3fcbd9c2c37d484e4e234d0b39ab65c14e9bc5bf2d5'
  )
})

test('portable build rejects mismatched CLI and sidecar distribution versions', () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ggr-portable-versions-'))
  const metadataPath = path.join(fixtureRoot, 'distribution-metadata.json')
  const cliPackagePath = path.join(fixtureRoot, 'package.json')
  const sidecarPyprojectPath = path.join(fixtureRoot, 'pyproject.toml')

  fs.writeFileSync(metadataPath, JSON.stringify({ distributionVersion: '0.1.0' }))
  fs.writeFileSync(cliPackagePath, JSON.stringify({ version: '0.1.1' }))
  fs.writeFileSync(sidecarPyprojectPath, '[project]\nversion = "0.1.0"\n')

  assert.throws(
    () => assertMatchingDistributionVersions({
      metadataPath,
      cliPackagePath,
      sidecarPyprojectPath,
    }),
    /DISTRIBUTION_VERSION_MISMATCH.*CLI 0\.1\.1.*distribution 0\.1\.0/
  )
})

test('portable build rejects a managed browser version that differs from the deployed Puppeteer runtime', () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ggr-browser-compatibility-'))
  const browserMetadataPath = path.join(fixtureRoot, 'browser-distribution.json')
  const revisionsPath = path.join(fixtureRoot, 'revisions.js')
  fs.writeFileSync(browserMetadataPath, JSON.stringify({ version: '140.0.7339.80' }))
  fs.writeFileSync(revisionsPath, "export const PUPPETEER_REVISIONS = { chrome: '141.0.0.0' }\n")

  assert.throws(
    () => assertBrowserCompatibility({ browserMetadataPath, revisionsPath }),
    /BROWSER_VERSION_MISMATCH.*140\.0\.7339\.80.*141\.0\.0\.0/
  )
  fs.writeFileSync(revisionsPath, "export const PUPPETEER_REVISIONS = { chrome: '140.0.7339.80' }\n")
  assert.equal(
    assertBrowserCompatibility({ browserMetadataPath, revisionsPath }),
    '140.0.7339.80'
  )
})

test('portable build writes the frozen sidecar version module from the validated distribution version', () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ggr-portable-sidecar-version-'))
  const outputPath = path.join(fixtureRoot, 'generated', 'ggr_sidecar_build_version.py')

  assert.equal(
    writeFrozenSidecarVersionModule({ outputPath, distributionVersion: '0.1.0' }),
    outputPath
  )
  assert.equal(fs.readFileSync(outputPath, 'utf8'), 'DISTRIBUTION_VERSION = "0.1.0"\n')
})

test('portable finalization writes launchers and integrity-verifiable component metadata', () => {
  const fixture = portableFixture()

  const manifest = finalizePortableBundle({
    bundleRoot: fixture.bundleRoot,
    metadataPath: fixture.metadataPath,
    cliPackagePath: fixture.cliPackagePath,
    sidecarPyprojectPath: fixture.sidecarPyprojectPath,
    nodeVersion: '20.16.0',
  })

  assert.equal(manifest.distributionVersion, '0.1.0')
  assert.deepEqual(manifest.features, {
    nodeCli: true,
    sidecar: true,
    openaiAgentsSdk: false,
  })
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(manifest.components).map(([name, component]) => [
        name,
        {
          path: component.path,
          distributionVersion: component.distributionVersion,
          runtimeVersion: component.runtimeVersion,
          hasHash: /^[a-f0-9]{64}$/.test(component.sha256),
        },
      ])
    ),
    {
      nodeRuntime: {
        path: 'runtime/node.exe',
        distributionVersion: '0.1.0',
        runtimeVersion: '20.16.0',
        hasHash: true,
      },
      nodeCli: {
        path: 'app/bin/ggr-main.mjs',
        distributionVersion: '0.1.0',
        runtimeVersion: undefined,
        hasHash: true,
      },
      sidecar: {
        path: 'sidecar/ggr-sidecar.exe',
        distributionVersion: '0.1.0',
        runtimeVersion: '3.11',
        hasHash: true,
      },
      ggrLauncher: {
        path: 'ggr.cmd',
        distributionVersion: '0.1.0',
        runtimeVersion: undefined,
        hasHash: true,
      },
      sidecarLauncher: {
        path: 'ggr-sidecar.cmd',
        distributionVersion: '0.1.0',
        runtimeVersion: undefined,
        hasHash: true,
      },
      credentialCleanup: {
        path: 'installer-support/cleanup-job-agent-credentials.ps1',
        distributionVersion: '0.1.0',
        runtimeVersion: undefined,
        hasHash: true,
      },
    }
  )
  assert.ok(manifest.integrity.files.length >= 5)
  assert.equal(
    manifest.integrity.files.some(file => file.path === 'job-agent-installation-manifest.json'),
    false
  )
  assert.match(fs.readFileSync(path.join(fixture.bundleRoot, 'ggr.cmd'), 'utf8'), /runtime\\node\.exe/)
  assert.match(
    fs.readFileSync(path.join(fixture.bundleRoot, 'ggr-sidecar.cmd'), 'utf8'),
    /sidecar\\ggr-sidecar\.exe/
  )
  assert.deepEqual(
    JSON.parse(
      fs.readFileSync(
        path.join(fixture.bundleRoot, 'job-agent-installation-manifest.json'),
        'utf8'
      )
    ),
    manifest
  )
})

test('public portable launchers run from an unrelated directory without Node or Python on PATH', async () => {
  const fixture = portableFixture()
  const unrelatedCwd = path.join(path.dirname(fixture.bundleRoot), 'unrelated-working-directory')
  fs.mkdirSync(unrelatedCwd)
  finalizePortableBundle({
    bundleRoot: fixture.bundleRoot,
    metadataPath: fixture.metadataPath,
    cliPackagePath: fixture.cliPackagePath,
    sidecarPyprojectPath: fixture.sidecarPyprojectPath,
    nodeVersion: '20.16.0',
  })
  const env = {
    SystemRoot: process.env.SystemRoot,
    ComSpec: process.env.ComSpec,
    PATH: path.join(process.env.SystemRoot, 'System32'),
  }

  const version = await runCmd(path.join(fixture.bundleRoot, 'ggr.cmd'), ['--version'], {
    cwd: unrelatedCwd,
    env,
  })
  const versionOutput = JSON.parse(version.stdout)
  assert.equal(version.stderr, '')
  assert.equal(versionOutput.runtimeMode, 'installed')
  assert.equal(versionOutput.cwd, unrelatedCwd)
  assert.deepEqual(versionOutput.args, ['--version'])
  assert.equal(
    versionOutput.manifestPath,
    path.join(fixture.bundleRoot, 'job-agent-installation-manifest.json')
  )

  const sidecarHelp = await runCmd(
    path.join(fixture.bundleRoot, 'ggr-sidecar.cmd'),
    ['--help'],
    { cwd: unrelatedCwd, env }
  )
  assert.match(sidecarHelp.stdout, /Usage: node/)
})

test('Node app materialization replaces package links with ordinary files and cuts cycles', () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ggr-portable-materialize-'))
  const sourceRoot = path.join(fixtureRoot, 'source')
  const destinationRoot = path.join(fixtureRoot, 'destination')
  const packageStoreRoot = path.join(sourceRoot, 'node_modules', '.pnpm', 'fixture', 'node_modules', 'fixture')
  const transitiveStoreRoot = path.join(sourceRoot, 'node_modules', '.pnpm', 'transitive', 'node_modules', 'transitive')
  const virtualHoistRoot = path.join(sourceRoot, 'node_modules', '.pnpm', 'node_modules')
  const packageLink = path.join(sourceRoot, 'node_modules', 'fixture')

  fs.mkdirSync(packageStoreRoot, { recursive: true })
  fs.mkdirSync(transitiveStoreRoot, { recursive: true })
  fs.mkdirSync(virtualHoistRoot, { recursive: true })
  fs.writeFileSync(path.join(sourceRoot, 'entry.mjs'), 'export const entry = true\n')
  fs.mkdirSync(path.join(sourceRoot, 'artifacts', 'job-agent-portable'), { recursive: true })
  fs.writeFileSync(path.join(sourceRoot, 'artifacts', 'job-agent-portable', 'build-only.txt'), 'exclude me\n')
  fs.writeFileSync(path.join(packageStoreRoot, 'index.js'), 'module.exports = true\n')
  fs.writeFileSync(path.join(transitiveStoreRoot, 'index.js'), 'module.exports = "transitive"\n')
  fs.symlinkSync(packageStoreRoot, packageLink, 'junction')
  fs.symlinkSync(transitiveStoreRoot, path.join(virtualHoistRoot, 'transitive'), 'junction')
  fs.symlinkSync(sourceRoot, path.join(virtualHoistRoot, 'root-app'), 'junction')
  fs.symlinkSync(sourceRoot, path.join(packageStoreRoot, 'cycle'), 'junction')

  materializeNodeApp({ sourceRoot, destinationRoot })

  assert.equal(fs.readFileSync(path.join(destinationRoot, 'entry.mjs'), 'utf8'), 'export const entry = true\n')
  assert.equal(
    fs.readFileSync(path.join(destinationRoot, 'node_modules', 'fixture', 'index.js'), 'utf8'),
    'module.exports = true\n'
  )
  assert.equal(fs.existsSync(path.join(destinationRoot, 'node_modules', '.pnpm')), false)
  assert.equal(
    fs.readFileSync(path.join(destinationRoot, 'node_modules', 'transitive', 'index.js'), 'utf8'),
    'module.exports = "transitive"\n'
  )
  assert.equal(fs.existsSync(path.join(destinationRoot, 'node_modules', 'root-app')), false)
  assert.equal(fs.existsSync(path.join(destinationRoot, 'node_modules', 'fixture', 'cycle')), false)
  assert.equal(fs.existsSync(path.join(destinationRoot, 'artifacts')), false)
  assert.equal(findReparsePoints(destinationRoot).length, 0)
})

function portableFixture () {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ggr-portable-bundle-'))
  const bundleRoot = path.join(fixtureRoot, 'bundle')
  const metadataPath = path.join(fixtureRoot, 'distribution-metadata.json')
  const cliPackagePath = path.join(fixtureRoot, 'package.json')
  const sidecarPyprojectPath = path.join(fixtureRoot, 'pyproject.toml')
  const nodeRuntimePath = path.join(bundleRoot, 'runtime', 'node.exe')
  const cliPath = path.join(bundleRoot, 'app', 'bin', 'ggr.mjs')
  const toolCliPath = path.join(bundleRoot, 'app', 'bin', 'ggr-main.mjs')
  const sidecarPath = path.join(bundleRoot, 'sidecar', 'ggr-sidecar.exe')
  const credentialCleanupPath = path.join(bundleRoot, 'installer-support', 'cleanup-job-agent-credentials.ps1')

  fs.mkdirSync(path.dirname(nodeRuntimePath), { recursive: true })
  fs.mkdirSync(path.dirname(cliPath), { recursive: true })
  fs.mkdirSync(path.dirname(sidecarPath), { recursive: true })
  fs.mkdirSync(path.dirname(credentialCleanupPath), { recursive: true })
  fs.copyFileSync(process.execPath, nodeRuntimePath)
  fs.writeFileSync(
    cliPath,
    [
      'import process from \'node:process\'',
      'process.stdout.write(`${JSON.stringify({',
      '  runtimeMode: process.env.GGR_JOB_AGENT_MODE,',
      '  manifestPath: process.env.GGR_JOB_AGENT_INSTALL_MANIFEST,',
      '  cwd: process.cwd(),',
      '  args: process.argv.slice(2)',
      '})}\\n`)',
      '',
    ].join('\n')
  )
  fs.writeFileSync(toolCliPath, 'process.stdout.write("tool fixture\\n")\n')
  fs.copyFileSync(process.execPath, sidecarPath)
  fs.writeFileSync(credentialCleanupPath, 'param([string]$InstallRoot)\n')
  fs.writeFileSync(
    metadataPath,
    JSON.stringify({
      name: 'geekgeekrun-job-agent',
      distributionVersion: '0.1.0',
      channel: 'prerelease',
      contracts: {
        cli: 'job-agent-cli.v1',
        installationManifest: 'job-agent-installation-manifest.v1',
      },
      features: {
        nodeCli: true,
        sidecar: true,
        openaiAgentsSdk: false,
      },
    })
  )
  fs.writeFileSync(cliPackagePath, JSON.stringify({ version: '0.1.0' }))
  fs.writeFileSync(sidecarPyprojectPath, '[project]\nversion = "0.1.0"\n')

  return {
    bundleRoot,
    metadataPath,
    cliPackagePath,
    sidecarPyprojectPath,
  }
}

async function runCmd (commandPath, args, options) {
  return await execFileAsync(process.env.ComSpec, ['/d', '/s', '/c', commandPath, ...args], {
    ...options,
    encoding: 'utf8',
    windowsHide: true,
  })
}

function findReparsePoints (directoryPath) {
  const matches = []
  for (const entry of fs.readdirSync(directoryPath, { withFileTypes: true })) {
    const entryPath = path.join(directoryPath, entry.name)
    if (entry.isSymbolicLink()) matches.push(entryPath)
    if (entry.isDirectory()) matches.push(...findReparsePoints(entryPath))
  }
  return matches
}
