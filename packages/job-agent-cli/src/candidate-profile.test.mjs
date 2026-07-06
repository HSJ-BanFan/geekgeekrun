import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

test('buildCandidateProfile keeps search keywords out of intent signals', async () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ggr-candidate-profile-'))
  const originalHome = process.env.HOME
  const originalUserProfile = process.env.USERPROFILE

  try {
    process.env.HOME = tempHome
    process.env.USERPROFILE = tempHome

    const configDir = path.join(tempHome, '.geekgeekrun', 'config')
    fs.mkdirSync(configDir, { recursive: true })
    fs.writeFileSync(path.join(configDir, 'resumes.json'), JSON.stringify([
      {
        content: {
          expectJob: 'Python 后端',
          userDescription: 'FastAPI 项目经验',
        },
      },
    ]))

    const { buildCandidateProfile } = await import(`./candidate-profile.mjs?test=${Date.now()}`)
    const candidateProfile = buildCandidateProfile({
      jobSourceList: [
        {
          type: 'search',
          enabled: true,
          children: [
            { enabled: true, keyword: 'Rust embedded kernel' },
            { enabled: true, keyword: '日语翻译' },
          ],
        },
      ],
    })

    assert.deepEqual(candidateProfile.searchKeywords, ['Rust embedded kernel', '日语翻译'])
    assert.equal(candidateProfile.intentSignals.includes('Python'), true)
    assert.equal(candidateProfile.intentSignals.includes('FastAPI'), true)
    assert.equal(candidateProfile.intentSignals.includes('Rust'), false)
    assert.equal(candidateProfile.intentSignals.includes('embedded'), false)
    assert.equal(candidateProfile.intentSignals.includes('kernel'), false)
    assert.equal(candidateProfile.intentSignals.includes('日语翻译'), false)
  } finally {
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    if (originalUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = originalUserProfile
    fs.rmSync(tempHome, { recursive: true, force: true })
  }
})
