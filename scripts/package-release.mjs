#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import { extractFile, listPackage } from '@electron/asar'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packageJson = JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'))

const targets = [
  {
    id: 'windows-x64',
    label: 'Windows x64 (.exe)',
    builderArguments: ['--win', 'nsis', '--x64'],
    artifactName: `ES Atlas-${packageJson.version}-win-x64.exe`,
    outputDirectory: 'release/windows-x64',
    requiresMacOS: false
  },
  {
    id: 'windows-arm64',
    label: 'Windows ARM64 (.exe)',
    builderArguments: ['--win', 'nsis', '--arm64'],
    artifactName: `ES Atlas-${packageJson.version}-win-arm64.exe`,
    outputDirectory: 'release/windows-arm64',
    requiresMacOS: false
  },
  {
    id: 'macos-x64',
    label: 'macOS Intel x64 (.dmg)',
    builderArguments: ['--mac', 'dmg', '--x64'],
    artifactName: `ES Atlas-${packageJson.version}-mac-x64.dmg`,
    outputDirectory: 'release/macos-x64',
    requiresMacOS: true
  },
  {
    id: 'macos-arm64',
    label: 'macOS Apple Silicon arm64 (.dmg)',
    builderArguments: ['--mac', 'dmg', '--arm64'],
    artifactName: `ES Atlas-${packageJson.version}-mac-arm64.dmg`,
    outputDirectory: 'release/macos-arm64',
    requiresMacOS: true
  }
]

const forbiddenRuntimeFiles = new Set([
  'connections.json',
  'request-history.json',
  'request-history.sqlite',
  'app-logs.sqlite',
  'trash.sqlite',
  'preferences.json'
])

const requiredRuntimePackages = [
  '@aws-sdk/credential-provider-node',
  '@smithy/hash-node',
  '@smithy/signature-v4',
  'ssh2'
]

async function main() {
  const argumentsList = process.argv.slice(2)

  if (argumentsList.includes('--list-targets')) {
    for (const target of targets) console.log(`${target.id}\t${target.label}`)
    return
  }

  const auditIndex = argumentsList.indexOf('--audit-asar')
  if (auditIndex !== -1) {
    const asarPath = argumentsList[auditIndex + 1]
    if (!asarPath) throw new Error('缺少 --audit-asar 的文件路径')
    await auditAsar(path.resolve(repositoryRoot, asarPath))
    console.log(`安全审计通过：${path.resolve(repositoryRoot, asarPath)}`)
    return
  }

  await assertLocalToolsAvailable()
  const selectedTargets = await selectTargets(argumentsList)
  assertTargetsSupportedOnHost(selectedTargets)

  const shouldContinue = argumentsList.includes('--yes') || await confirmPossibleDownload()
  if (!shouldContinue) {
    console.log('已取消打包。')
    return
  }

  // 所有目标共享同一份测试与前端构建结果，避免多架构构建重复执行。
  await runCommand(resolveNpmCommand(), ['test'])
  await runCommand(resolveNpmCommand(), ['run', 'build'])

  for (const target of selectedTargets) await buildTarget(target)
}

async function selectTargets(argumentsList) {
  const targetIndex = argumentsList.indexOf('--target')
  if (targetIndex !== -1) {
    const targetId = argumentsList[targetIndex + 1]
    if (targetId === 'all') return [...targets]
    const target = targets.find((candidate) => candidate.id === targetId)
    if (!target) throw new Error(`不支持的打包目标：${targetId ?? '未提供'}`)
    return [target]
  }

  const terminal = createInterface({ input: process.stdin, output: process.stdout })
  try {
    console.log('\n请选择打包目标：')
    targets.forEach((target, index) => console.log(`  ${index + 1}. ${target.label}`))
    console.log(`  ${targets.length + 1}. 全部架构`)
    const answer = (await terminal.question('输入序号：')).trim()
    const selectedIndex = Number.parseInt(answer, 10) - 1
    if (selectedIndex === targets.length) return [...targets]
    if (!Number.isInteger(selectedIndex) || !targets[selectedIndex]) {
      throw new Error(`无效的打包选项：${answer || '空'}`)
    }
    return [targets[selectedIndex]]
  } finally {
    terminal.close()
  }
}

async function confirmPossibleDownload() {
  const terminal = createInterface({ input: process.stdin, output: process.stdout })
  try {
    console.log('\n首次构建某个架构时，electron-builder 可能下载对应的官方 Electron 运行时。')
    const answer = (await terminal.question('确认继续？[y/N] ')).trim().toLowerCase()
    return answer === 'y' || answer === 'yes'
  } finally {
    terminal.close()
  }
}

function assertTargetsSupportedOnHost(selectedTargets) {
  const macTarget = selectedTargets.find((target) => target.requiresMacOS)
  if (macTarget && process.platform !== 'darwin') {
    throw new Error(`目标 ${macTarget.label} 只能在 macOS 上构建`)
  }
}

async function assertLocalToolsAvailable() {
  const requiredPaths = [
    path.join(repositoryRoot, 'node_modules'),
    resolveElectronBuilderCommand(),
    path.join(repositoryRoot, 'electron-builder.yml')
  ]
  for (const requiredPath of requiredPaths) {
    try {
      await access(requiredPath)
    } catch (error) {
      throw new Error(`打包依赖不存在：${requiredPath}。请先手动安装项目依赖。`, { cause: error })
    }
  }
}

async function buildTarget(target) {
  const outputDirectory = path.resolve(repositoryRoot, target.outputDirectory)
  console.log(`\n开始构建：${target.label}`)
  await runCommand(resolveElectronBuilderCommand(), [
    '--config',
    'electron-builder.yml',
    // 先完成产物审计，发布由独立步骤处理，避免 CI 环境触发隐式上传。
    '--publish',
    'never',
    ...target.builderArguments,
    `--config.directories.output=${target.outputDirectory}`
  ], {
    ...process.env,
    CSC_IDENTITY_AUTO_DISCOVERY: process.env.CSC_IDENTITY_AUTO_DISCOVERY ?? 'false'
  })

  // 只有最终 ASAR 通过运行依赖和用户数据双重审计，才报告产物成功。
  const asarPaths = await findFiles(outputDirectory, (filePath) => path.basename(filePath) === 'app.asar')
  if (asarPaths.length !== 1) {
    throw new Error(`产物审计失败：目标=${target.id}，app.asar 数量=${asarPaths.length}`)
  }
  await auditAsar(asarPaths[0])

  const artifactPath = path.join(outputDirectory, target.artifactName)
  await access(artifactPath)
  const artifactStat = await stat(artifactPath)
  const checksum = await sha256(artifactPath)
  console.log(`构建成功：${artifactPath}`)
  console.log(`文件大小：${(artifactStat.size / 1024 / 1024).toFixed(1)} MB`)
  console.log(`SHA-256：${checksum}`)
}

async function auditAsar(asarPath) {
  await access(asarPath)
  const entries = listPackage(asarPath).map(normalizeAsarEntry)
  const entrySet = new Set(entries)

  if (!entrySet.has('out/main/index.js')) {
    throw new Error(`产物审计失败：缺少主进程入口，asar=${asarPath}`)
  }

  for (const packageName of requiredRuntimePackages) {
    const packagePath = `node_modules/${packageName}/package.json`
    if (!entrySet.has(packagePath)) {
      throw new Error(`产物审计失败：缺少运行依赖 ${packageName}，asar=${asarPath}`)
    }
  }

  for (const entry of entries) {
    if (entry.startsWith('node_modules/')) continue
    const fileName = path.posix.basename(entry).toLowerCase()
    if (forbiddenRuntimeFiles.has(fileName) || /\.(?:db|sqlite|sqlite3|db-journal|sqlite-journal)$/u.test(fileName)) {
      throw new Error(`产物审计失败：发现运行数据 ${entry}，asar=${asarPath}`)
    }
  }

  const mainProcessSource = extractFile(asarPath, 'out/main/index.js').toString('utf8')
  if (/createDefaultConnection\s*\(\s*['"]/u.test(mainProcessSource)) {
    throw new Error(`产物审计失败：主进程仍包含硬编码默认连接，asar=${asarPath}`)
  }
}

function normalizeAsarEntry(entry) {
  return entry.replaceAll('\\', '/').replace(/^\/+/, '')
}

async function findFiles(directory, predicate) {
  const matches = []
  const directoryEntries = await readdir(directory, { withFileTypes: true })
  for (const entry of directoryEntries) {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      matches.push(...await findFiles(entryPath, predicate))
    } else if (entry.isFile() && predicate(entryPath)) {
      matches.push(entryPath)
    }
  }
  return matches
}

function runCommand(command, commandArguments, environment = process.env) {
  return new Promise((resolve, reject) => {
    // Windows 不支持直接 spawn .cmd；用 Node 加载已有 CLI，避免引入 shell 转义。
    const nodeScript = process.platform === 'win32'
      ? command === resolveNpmCommand()
        ? process.env.npm_execpath ?? path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
        : path.join(repositoryRoot, 'node_modules/electron-builder/out/cli/cli.js')
      : null
    const child = spawn(nodeScript ? process.execPath : command, nodeScript ? [nodeScript, ...commandArguments] : commandArguments, {
      cwd: repositoryRoot,
      env: environment,
      stdio: 'inherit',
      shell: false
    })
    child.once('error', (error) => {
      reject(new Error(`命令启动失败：${command} ${commandArguments.join(' ')}`, { cause: error }))
    })
    child.once('exit', (exitCode, signal) => {
      if (exitCode === 0) {
        resolve()
        return
      }
      reject(new Error(
        `命令执行失败：${command} ${commandArguments.join(' ')}，exitCode=${exitCode ?? 'null'}，signal=${signal ?? 'null'}`
      ))
    })
  })
}

function sha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const input = createReadStream(filePath)
    input.once('error', reject)
    input.on('data', (chunk) => hash.update(chunk))
    input.once('end', () => resolve(hash.digest('hex')))
  })
}

function resolveNpmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

function resolveElectronBuilderCommand() {
  const executableName = process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder'
  return path.join(repositoryRoot, 'node_modules', '.bin', executableName)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
