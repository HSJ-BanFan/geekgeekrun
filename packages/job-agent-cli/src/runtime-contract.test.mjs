import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { test } from 'node:test'

const execFileAsync = promisify(execFile)
const ggrPath = path.resolve('bin', 'ggr.mjs')

test('ggr --version reports distribution and contract versions as JSON', async () => {
  const { stdout, stderr } = await runGgr(['--version'])
  const output = JSON.parse(stdout)

  assert.equal(stderr, '')
  assert.deepEqual(output, {
    ok: true,
    command: 'version',
    schemaVersion: 'job-agent-version.v1',
    distribution: {
      name: 'geekgeekrun-job-agent',
      version: '0.1.0',
      channel: 'prerelease',
    },
    contracts: {
      cli: 'job-agent-cli.v1',
      installationManifest: 'job-agent-installation-manifest.v1',
      marketJobs: 'market-jobs.v1',
      marketJobsAnalysis: 'market-jobs-analysis.v1',
    },
    runtimeMode: 'source',
    reasonCode: null,
  })
})

test('ggr doctor treats a valid fresh installation as ready without requiring browser setup or mutating runtime home', async () => {
  await withInstalledFixture(async ({ cwd, env, runtimeHome }) => {
    assert.equal(fs.existsSync(runtimeHome), false)

    const { stdout, stderr } = await runGgr(['doctor'], { cwd, env })
    const output = JSON.parse(stdout)

    assert.equal(stderr, '')
    assert.equal(output.ok, true)
    assert.equal(output.command, 'doctor')
    assert.equal(output.schemaVersion, 'job-agent-doctor.v1')
    assert.equal(output.reasonCode, null)
    assert.equal(output.runtime.mode, 'installed')
    assert.equal(output.runtime.runtimeHome, runtimeHome)
    assert.equal(output.checks.installation.ready, true)
    assert.equal(output.checks.installation.reasonCode, null)
    assert.equal(output.checks.sidecar.ready, true)
    assert.equal(output.checks.browser.ready, false)
    assert.equal(output.checks.browser.reasonCode, 'BROWSER_NOT_CONFIGURED')
    assert.equal(output.checks.bossSession.known, false)
    assert.equal(output.checks.bossSession.reasonCode, 'BOSS_SESSION_UNKNOWN')
    assert.deepEqual(output.features, {
      nodeCli: true,
      sidecar: true,
      openaiAgentsSdk: false,
    })
    assert.equal(fs.existsSync(runtimeHome), false)
  })
})

test('installed ggr --version reports the manifest distribution through the public launcher', async () => {
  await withInstalledFixture(async ({ cwd, env }) => {
    const { stdout } = await runGgr(['--version'], { cwd, env })
    const output = JSON.parse(stdout)

    assert.equal(output.ok, true)
    assert.equal(output.runtimeMode, 'installed')
    assert.equal(output.distribution.version, '0.1.0')
    assert.equal(output.contracts.cli, 'job-agent-cli.v1')
    assert.equal(output.reasonCode, null)
  })
})

test('installed ggr agent dispatches the manifest sidecar and preserves JSON stdout', async () => {
  await withInstalledFixture(async ({ cwd, env, installRoot, manifestPath, sidecarPath }) => {
    fs.rmSync(sidecarPath)
    copyExecutable(process.execPath, sidecarPath)
    updateManifestComponent({ installRoot, manifestPath, name: 'sidecar', filePath: sidecarPath })

    const expression = `JSON.stringify({ ok: true, command: 'sidecar-fixture', argv: process.argv.slice(1) })`
    const { stdout, stderr } = await runGgr(['agent', '--print', expression], { cwd, env })
    const output = JSON.parse(stdout)

    assert.equal(stderr, '')
    assert.deepEqual(output, {
      ok: true,
      command: 'sidecar-fixture',
      argv: [],
    })
  })
})

test('ggr doctor --require-browser fails with a stable reason when installation is healthy but browser setup is absent', async () => {
  await withInstalledFixture(async ({ cwd, env }) => {
    await assert.rejects(
      runGgr(['doctor', '--require-browser'], { cwd, env }),
      error => {
        const output = JSON.parse(error.stdout)
        assert.equal(output.ok, false)
        assert.equal(output.reasonCode, 'BROWSER_NOT_READY')
        assert.equal(output.checks.installation.ready, true)
        assert.equal(output.checks.browser.reasonCode, 'BROWSER_NOT_CONFIGURED')
        return true
      }
    )
  })
})

test('ggr doctor --require-browser passes when installed browser configuration points to an existing executable', async () => {
  await withInstalledFixture(async ({ cwd, env, runtimeHome }) => {
    const browserExecutable = path.join(runtimeHome, 'browser', 'chrome.exe')
    fs.mkdirSync(path.dirname(browserExecutable), { recursive: true })
    fs.writeFileSync(browserExecutable, 'browser fixture\n')
    fs.writeFileSync(
      path.join(runtimeHome, 'browser', 'browser.json'),
      JSON.stringify({ executablePath: browserExecutable })
    )

    const { stdout } = await runGgr(['doctor', '--require-browser'], { cwd, env })
    const output = JSON.parse(stdout)

    assert.equal(output.ok, true)
    assert.equal(output.reasonCode, null)
    assert.equal(output.checks.installation.ready, true)
    assert.equal(output.checks.browser.ready, true)
    assert.equal(output.checks.browser.executablePath, browserExecutable)
  })
})

test('ggr doctor reports a stable installation failure when a declared component is tampered with', async () => {
  await withInstalledFixture(async ({ cwd, env, cliPath, runtimeHome }) => {
    fs.appendFileSync(cliPath, 'tampered\n')

    await assert.rejects(
      runGgr(['doctor'], { cwd, env }),
      error => {
        const output = JSON.parse(error.stdout)
        assert.equal(output.ok, false)
        assert.equal(output.reasonCode, 'INSTALLATION_NOT_READY')
        assert.equal(output.checks.installation.ready, false)
        assert.equal(output.checks.installation.reasonCode, 'INSTALLATION_INTEGRITY_FAILED')
        assert.equal(output.checks.installation.componentChecks.nodeCli.reasonCode, 'COMPONENT_HASH_MISMATCH')
        assert.equal(output.checks.browser.reasonCode, 'BROWSER_NOT_CONFIGURED')
        assert.equal(fs.existsSync(runtimeHome), false)
        return true
      }
    )
  })
})

test('installed version and doctor return JSON failures for a structurally invalid manifest', async () => {
  await withInstalledFixture(async ({ cwd, env, manifestPath }) => {
    fs.writeFileSync(manifestPath, 'null\n')

    for (const args of [['--version'], ['doctor']]) {
      await assert.rejects(
        runGgr(args, { cwd, env }),
        error => {
          const output = JSON.parse(error.stdout)
          assert.equal(output.ok, false)
          assert.equal(output.reasonCode, args[0] === 'doctor' ? 'INSTALLATION_NOT_READY' : 'INSTALL_MANIFEST_INVALID')
          if (args[0] === 'doctor') {
            assert.equal(output.checks.installation.reasonCode, 'INSTALL_MANIFEST_INVALID')
          }
          assert.equal(error.stderr, '')
          return true
        }
      )
    }
  })
})

test('ggr doctor rejects a manifest that omits the required sidecar feature', async () => {
  await withInstalledFixture(async ({ cwd, env, manifestPath }) => {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    manifest.features.sidecar = false
    delete manifest.components.sidecar
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))

    await assert.rejects(
      runGgr(['doctor'], { cwd, env }),
      error => {
        const output = JSON.parse(error.stdout)
        assert.equal(output.ok, false)
        assert.equal(output.reasonCode, 'INSTALLATION_NOT_READY')
        assert.equal(output.checks.installation.reasonCode, 'DISTRIBUTION_FEATURE_MISMATCH')
        assert.equal(output.checks.sidecar.ready, false)
        assert.equal(output.checks.sidecar.reasonCode, 'SIDECAR_NOT_READY')
        return true
      }
    )
  })
})

test('installed mode fails unsupported legacy commands without touching desktop or runtime state', async () => {
  await withInstalledFixture(async ({ cwd, env, runtimeHome, desktopHome }) => {
    await assert.rejects(
      runGgr(['snapshot'], { cwd, env }),
      error => {
        const output = JSON.parse(error.stdout)
        assert.equal(output.ok, false)
        assert.equal(output.command, 'snapshot')
        assert.equal(output.reasonCode, 'INSTALLED_COMMAND_NOT_AVAILABLE')
        assert.equal(fs.existsSync(runtimeHome), false)
        assert.equal(fs.existsSync(desktopHome), false)
        return true
      }
    )
  })
})

test('installed market-jobs --plan-only resolves default and explicit artifact paths independently of repository layout', async () => {
  await withInstalledFixture(async ({ cwd, env, runtimeHome }) => {
    const defaultRun = await runGgr([
      'market-jobs',
      '--plan-only',
      '--keyword',
      'AI Agent',
      '--city',
      '上海',
    ], { cwd, env })
    const defaultOutput = JSON.parse(defaultRun.stdout)

    assert.equal(defaultRun.stderr, '')
    assert.equal(defaultOutput.ok, true)
    assert.equal(defaultOutput.mode, 'plan-only')
    assert.equal(path.isAbsolute(defaultOutput.rawArtifactPath), true)
    assert.equal(
      path.dirname(defaultOutput.rawArtifactPath),
      path.join(runtimeHome, 'artifacts', 'market-jobs')
    )
    assert.equal(fs.existsSync(runtimeHome), false)

    const explicitRun = await runGgr([
      'market-jobs',
      '--plan-only',
      '--keyword',
      'AI Agent',
      '--city',
      '上海',
      '--analyze',
      '--output',
      path.join('reports', 'market.json'),
    ], { cwd, env })
    const explicitOutput = JSON.parse(explicitRun.stdout)

    assert.equal(explicitOutput.rawArtifactPath, path.join(cwd, 'reports', 'market.json'))
    assert.equal(explicitOutput.analysisArtifactPath, path.join(cwd, 'reports', 'market.analysis.json'))
  })
})

test('source market-jobs --plan-only retains the desktop storage default until installed mode is selected', async () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ggr-source-runtime-'))
  const cwd = path.join(tempHome, 'working-directory')
  fs.mkdirSync(cwd, { recursive: true })

  try {
    const { stdout } = await runGgr([
      'market-jobs',
      '--plan-only',
      '--keyword',
      'AI Agent',
      '--city',
      '上海',
    ], {
      cwd,
      env: {
        HOME: tempHome,
        USERPROFILE: tempHome,
        GGR_JOB_AGENT_MODE: '',
        GGR_JOB_AGENT_HOME: '',
        GGR_JOB_AGENT_INSTALL_MANIFEST: '',
      },
    })
    const output = JSON.parse(stdout)

    assert.equal(
      path.dirname(output.rawArtifactPath),
      path.join(tempHome, '.geekgeekrun', 'storage', 'market-jobs')
    )
    assert.equal(fs.existsSync(path.join(tempHome, '.geekgeekrun')), false)
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true })
  }
})

async function runGgr (args, { cwd = path.dirname(ggrPath), env = {} } = {}) {
  return await execFileAsync(process.execPath, [ggrPath, ...args], {
    cwd,
    env: {
      ...process.env,
      ...env,
    },
  })
}

async function withInstalledFixture (callback) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ggr-installed-runtime-'))
  const installRoot = path.join(tempDir, 'install')
  const cwd = path.join(tempDir, 'unrelated-working-directory')
  const runtimeHome = path.join(tempDir, 'runtime-home')
  const desktopHome = path.join(tempDir, 'desktop-home')
  const cliPath = path.join(installRoot, 'app', 'ggr.mjs')
  const nodeRuntimePath = path.join(installRoot, 'runtime', 'node.exe')
  const sidecarPath = path.join(installRoot, 'sidecar', 'ggr-sidecar.exe')
  const manifestPath = path.join(installRoot, 'job-agent-installation-manifest.json')

  fs.mkdirSync(path.dirname(cliPath), { recursive: true })
  fs.mkdirSync(path.dirname(nodeRuntimePath), { recursive: true })
  fs.mkdirSync(path.dirname(sidecarPath), { recursive: true })
  fs.mkdirSync(cwd, { recursive: true })
  fs.writeFileSync(cliPath, 'installed cli fixture\n')
  fs.writeFileSync(nodeRuntimePath, 'installed node runtime fixture\n')
  fs.writeFileSync(sidecarPath, 'installed sidecar fixture\n')
  fs.writeFileSync(manifestPath, JSON.stringify({
    schemaVersion: 'job-agent-installation-manifest.v1',
    distributionVersion: '0.1.0',
    contracts: {
      cli: 'job-agent-cli.v1',
      installationManifest: 'job-agent-installation-manifest.v1',
      marketJobs: 'market-jobs.v1',
      marketJobsAnalysis: 'market-jobs-analysis.v1',
    },
    features: {
      nodeCli: true,
      sidecar: true,
      openaiAgentsSdk: false,
    },
    components: {
      nodeRuntime: componentRecord(installRoot, nodeRuntimePath),
      nodeCli: componentRecord(installRoot, cliPath),
      sidecar: componentRecord(installRoot, sidecarPath),
    },
  }, null, 2))

  try {
    await callback({
      cwd,
      installRoot,
      runtimeHome,
      desktopHome,
      cliPath,
      nodeRuntimePath,
      sidecarPath,
      manifestPath,
      env: {
        GGR_JOB_AGENT_MODE: 'installed',
        GGR_JOB_AGENT_HOME: runtimeHome,
        GGR_JOB_AGENT_INSTALL_MANIFEST: manifestPath,
        HOME: desktopHome,
        USERPROFILE: desktopHome,
      },
    })
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

function componentRecord (installRoot, filePath) {
  return {
    path: path.relative(installRoot, filePath).replaceAll(path.sep, '/'),
    sha256: crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex'),
  }
}

function updateManifestComponent ({ installRoot, manifestPath, name, filePath }) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  manifest.components[name] = componentRecord(installRoot, filePath)
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
}

function copyExecutable (sourcePath, destinationPath) {
  fs.copyFileSync(sourcePath, destinationPath)
  fs.chmodSync(destinationPath, 0o755)
}
