import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { createRequire } from 'node:module'

const options = parseOptions(process.argv.slice(2))
const installRoot = path.resolve(requiredOption(options, 'install-root'))
const browserExecutable = path.resolve(requiredOption(options, 'browser-executable'))
const readyFile = path.resolve(requiredOption(options, 'ready-file'))
const stopFile = path.resolve(requiredOption(options, 'stop-file'))
const stoppedFile = options['stopped-file'] ? path.resolve(options['stopped-file']) : ''
const port = Number.parseInt(requiredOption(options, 'port'), 10)
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  throw new Error('BROWSER_FIXTURE_PORT_INVALID')
}

const requireFromInstalledApp = createRequire(path.join(installRoot, 'app', 'package.json'))
const puppeteerModule = requireFromInstalledApp('puppeteer')
const puppeteer = puppeteerModule.default ?? puppeteerModule
const fixtureProfile = path.join(path.dirname(readyFile), 'browser-profile')
const browser = await puppeteer.launch({
  executablePath: browserExecutable,
  headless: true,
  userDataDir: fixtureProfile,
  args: [
    `--remote-debugging-port=${port}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
  ],
})

const configuredPages = new WeakSet()
async function configurePage (page) {
  if (!page || configuredPages.has(page)) return
  configuredPages.add(page)
  await page.setRequestInterception(true)
  page.on('request', request => {
    if (request.isInterceptResolutionHandled?.()) return
    const url = request.url()
    if (request.isNavigationRequest() && url.startsWith('https://www.zhipin.com/')) {
      request.respond({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: fixtureHtml(new URL(url).pathname),
      }).catch(() => {})
      return
    }
    if (url.includes('zhipin.com')) {
      request.abort('blockedbyclient').catch(() => {})
      return
    }
    request.continue().catch(() => {})
  })
}

for (const page of await browser.pages()) await configurePage(page)
browser.on('targetcreated', target => {
  target.page().then(configurePage).catch(() => {})
})

fs.mkdirSync(path.dirname(readyFile), { recursive: true })
fs.writeFileSync(readyFile, `${JSON.stringify({ ok: true, port, pid: process.pid })}\n`, 'utf8')

let stopping = false
async function stop () {
  if (stopping) return
  stopping = true
  const browserProcess = browser.process?.()
  await Promise.race([
    browser.close().catch(() => {}),
    new Promise(resolve => setTimeout(resolve, 5000)),
  ])
  try {
    browserProcess?.kill()
  } catch {
  }
}

while (!stopping && !fs.existsSync(stopFile)) {
  await new Promise(resolve => setTimeout(resolve, 200))
}
await stop()
if (stoppedFile) {
  fs.writeFileSync(stoppedFile, `${JSON.stringify({ ok: true, stopped: true, pid: process.pid })}\n`, 'utf8')
}
process.exit(0)

function fixtureHtml (pathname) {
  if (pathname === '/web/geek/chat') return recentApplicationsHtml()
  if (pathname === '/web/geek/jobs') return marketJobsHtml()
  return '<!doctype html><html><body><main class="geek-center">Fixture BOSS geek page</main></body></html>'
}

function marketJobsHtml () {
  return `<!doctype html>
<html lang="zh-CN">
  <head><meta charset="utf-8"><title>BOSS Market Fixture</title></head>
  <body>
    <nav ka="header-personal">个人中心</nav>
    <ul class="rec-job-list">
      <li class="job-card-box" data-jobid="fixture-market-job-1">
        <a href="/job_detail/fixture-market-job-1.html"><span class="job-name">AI Agent 工程师</span></a>
        <span class="company-name">Fixture Technology</span>
        <span class="salary">20-30K</span>
        <span class="job-area">上海</span>
        <span class="boss-name">Fixture Recruiter</span>
        <span>立即沟通</span>
      </li>
    </ul>
  </body>
</html>`
}

function recentApplicationsHtml () {
  return `<!doctype html>
<html lang="zh-CN">
  <head><meta charset="utf-8"><title>BOSS Recent Applications Fixture</title></head>
  <body>
    <nav ka="header-personal">个人中心</nav>
    <div class="chat-conversation">Fixture conversation</div>
    <script>
      window.chatStore = {
        friendInfos: [{
          friendId: 'fixture-conversation-1',
          lastTS: 1760000000000,
          encryptJobId: 'fixture-recent-job-1',
          jobName: 'Python AI 后端开发',
          brandName: 'Fixture Technology',
          cityName: '上海',
          positionCategoryName: '后端开发',
          bossName: 'Fixture Recruiter',
          bossTitle: '招聘经理',
          lastMsg: '感谢投递，我们会尽快查看。',
          lastMsgDirection: 'boss_to_geek'
        }]
      }
    </script>
  </body>
</html>`
}

function parseOptions (args) {
  const parsed = {}
  for (let index = 0; index < args.length; index += 2) {
    const token = args[index]
    const value = args[index + 1]
    if (!token?.startsWith('--') || value === undefined) throw new Error('BROWSER_FIXTURE_ARGUMENT_INVALID')
    parsed[token.slice(2)] = value
  }
  return parsed
}

function requiredOption (value, name) {
  const resolved = String(value[name] ?? '').trim()
  if (!resolved) throw new Error(`BROWSER_FIXTURE_ARGUMENT_REQUIRED: --${name}`)
  return resolved
}
