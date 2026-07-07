import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { test } from 'node:test'

const execFileAsync = promisify(execFile)

test('evaluate-job CLI exposes safe preset Greeting Plan metadata', async () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ggr-greeting-plan-cli-'))
  const originalHome = process.env.HOME
  const originalUserProfile = process.env.USERPROFILE
  const greetingMessage = '您好，我想了解这个 Python 岗位。FULL_GREETING_CANARY_0003 C:\\Users\\Private\\resume.png'

  try {
    process.env.HOME = tempHome
    process.env.USERPROFILE = tempHome
    const configDir = path.join(tempHome, '.geekgeekrun', 'config')
    fs.mkdirSync(configDir, { recursive: true })
    fs.writeFileSync(path.join(configDir, 'boss.json'), JSON.stringify({
      autoStartChatGreetingMessage: '默认开场白',
      autoStartChatGreetingMessageRules: [
        { name: 'AI Agent Template', pattern: 'Python|FastAPI|LLM', message: greetingMessage },
      ],
    }))
    fs.writeFileSync(path.join(configDir, 'llm.json'), JSON.stringify([]))

    const ggrPath = path.resolve('bin', 'ggr.mjs')
    const { stdout } = await execFileAsync(process.execPath, [
      ggrPath,
      'evaluate-job',
      '--title',
      'Python 后端开发',
      '--jd',
      '负责 FastAPI 服务开发和 LLM 工具接入。',
    ], {
      env: {
        ...process.env,
        HOME: process.env.HOME,
        USERPROFILE: process.env.USERPROFILE,
      },
    })
    const output = JSON.parse(stdout)
    const planJson = JSON.stringify(output.ruleEvaluation.greetingPlan)

    assert.equal(output.ok, true)
    assert.equal(output.ruleEvaluation.greetingMessage, greetingMessage)
    assert.equal(output.ruleEvaluation.greetingPlan.source, 'preset')
    assert.equal(output.ruleEvaluation.greetingPlan.selectedTemplate.rule, 'AI Agent Template')
    assert.equal(output.ruleEvaluation.greetingPlan.characterCount, Array.from(greetingMessage).length)
    assert.equal(planJson.includes(greetingMessage), false)
    assert.equal(planJson.includes('FULL_GREETING_CANARY_0003'), false)
    assert.equal(planJson.includes('C:\\Users\\Private\\resume.png'), false)
  } finally {
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    if (originalUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = originalUserProfile
    fs.rmSync(tempHome, { recursive: true, force: true })
  }
})
