import childProcess from 'node:child_process'
import path from 'node:path'
import url from 'node:url'

export default function buildSqlitePlugin() {
  const rawCwd = process.cwd()
  const __dirname = url.fileURLToPath(new URL('.', import.meta.url))

  const sqlitePluginDirPath = path.join(__dirname, '../../../sqlite-plugin')
  process.chdir(sqlitePluginDirPath)
  try {
    const pnpmCommand = process.env.npm_execpath
      ? `"${process.execPath}" "${process.env.npm_execpath}" run build`
      : 'pnpm run build'
    const sqlitePluginBuildProcess = childProcess.spawnSync(pnpmCommand, {
      stdio: ['inherit', 'inherit', 'inherit'],
      shell: true
    })
    process.chdir(rawCwd)
    if (sqlitePluginBuildProcess.error) {
      throw sqlitePluginBuildProcess.error
    }
    if (sqlitePluginBuildProcess.status !== 0) {
      process.exit(sqlitePluginBuildProcess.status ?? 1)
    }
  } catch (error) {
    process.chdir(rawCwd)
    console.error('error encounter when build sqlite plugin:')
    console.error(error)
    process.exit(1)
  }
}
