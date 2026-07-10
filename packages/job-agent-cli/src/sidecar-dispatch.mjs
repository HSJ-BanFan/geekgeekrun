import { spawn } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { resolveInstalledComponent } from './distribution.mjs'

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

export async function dispatchAgent (args, runtimeContext, { env = process.env } = {}) {
  const command = runtimeContext.mode === 'installed'
    ? installedSidecarCommand(runtimeContext, env)
    : sourceSidecarCommand(env)
  return await spawnAndWait(command.executable, [...command.args, ...args], {
    cwd: runtimeContext.callerWorkingDirectory,
    env: command.env,
  })
}

function installedSidecarCommand (runtimeContext, env) {
  const sidecar = resolveInstalledComponent(runtimeContext, 'sidecar')
  if (!sidecar.ok) {
    throw dispatchError(
      sidecar.reasonCode ?? 'SIDECAR_NOT_READY',
      'The installed sidecar could not be resolved from the installation manifest'
    )
  }
  return {
    executable: sidecar.path,
    args: [],
    env,
  }
}

function sourceSidecarCommand (env) {
  const sidecarSource = path.join(sourceRoot, 'packages', 'job-agent-sidecar', 'src')
  const pythonPath = [sidecarSource, env.PYTHONPATH].filter(Boolean).join(path.delimiter)
  return {
    executable: env.GGR_JOB_AGENT_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
    args: ['-m', 'ggr_sidecar'],
    env: {
      ...env,
      GGR_JOB_AGENT_MODE: 'source',
      PYTHONPATH: pythonPath,
    },
  }
}

async function spawnAndWait (executable, args, options) {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      ...options,
      stdio: 'inherit',
      windowsHide: true,
    })
    child.once('error', err => {
      reject(dispatchError('SIDECAR_LAUNCH_FAILED', err.message))
    })
    child.once('exit', (code, signal) => {
      resolve(Number.isInteger(code) ? code : signal ? 1 : 0)
    })
  })
}

function dispatchError (reasonCode, message) {
  const error = new Error(message)
  error.reasonCode = reasonCode
  return error
}
