import os from 'node:os'
import path from 'node:path'

const installedMode = 'installed'

export function getRuntimeContext ({ env = process.env, cwd = process.cwd(), homeDir = os.homedir() } = {}) {
  const mode = env.GGR_JOB_AGENT_MODE === installedMode ? installedMode : 'source'
  const callerWorkingDirectory = path.resolve(cwd)

  if (mode === installedMode) {
    const runtimeHome = path.resolve(env.GGR_JOB_AGENT_HOME || path.join(homeDir, '.geekgeekrun-job-agent'))
    const installManifestPath = env.GGR_JOB_AGENT_INSTALL_MANIFEST
      ? path.resolve(env.GGR_JOB_AGENT_INSTALL_MANIFEST)
      : ''
    return {
      mode,
      callerWorkingDirectory,
      runtimeHome,
      installManifestPath,
      configRoot: path.join(runtimeHome, 'config'),
      browserRoot: path.join(runtimeHome, 'browser'),
      dataRoot: path.join(runtimeHome, 'data'),
      artifactRoot: path.join(runtimeHome, 'artifacts'),
      auditRoot: path.join(runtimeHome, 'audit'),
      tokenRoot: path.join(runtimeHome, 'tokens'),
      tempRoot: path.join(runtimeHome, 'temp'),
    }
  }

  const runtimeHome = path.join(homeDir, '.geekgeekrun')
  const storageRoot = path.join(runtimeHome, 'storage')
  return {
    mode,
    callerWorkingDirectory,
    runtimeHome,
    installManifestPath: '',
    configRoot: path.join(runtimeHome, 'config'),
    browserRoot: storageRoot,
    dataRoot: storageRoot,
    artifactRoot: storageRoot,
    auditRoot: storageRoot,
    tokenRoot: storageRoot,
    tempRoot: path.join(runtimeHome, 'temp'),
  }
}
