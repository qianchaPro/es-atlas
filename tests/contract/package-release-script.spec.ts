import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const executeFile = promisify(execFile)
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const packageScriptPath = path.join(repositoryRoot, 'scripts/package-release.mjs')

describe('多架构打包脚本', () => {
  it('暴露四个明确的 64 位桌面目标', async () => {
    const { stdout } = await executeFile(process.execPath, [packageScriptPath, '--list-targets'], {
      cwd: repositoryRoot
    })

    assert.deepEqual(stdout.trim().split('\n'), [
      'windows-x64\tWindows x64 (.exe)',
      'windows-arm64\tWindows ARM64 (.exe)',
      'macos-x64\tmacOS Intel x64 (.dmg)',
      'macos-arm64\tmacOS Apple Silicon arm64 (.dmg)'
    ])
  })

  it('由 npm 命令进入交互选择，并在脚本中执行用户数据审计', async () => {
    const packageJson = JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>
    }
    const scriptSource = await readFile(packageScriptPath, 'utf8')

    assert.equal(packageJson.scripts?.['package:select'], 'node scripts/package-release.mjs')
    assert.match(scriptSource, /connections\.json/)
    assert.match(scriptSource, /request-history\.sqlite/)
    assert.match(scriptSource, /app-logs\.sqlite/)
    assert.match(scriptSource, /preferences\.json/)
    assert.match(scriptSource, /createDefaultConnection/)
  })
})
