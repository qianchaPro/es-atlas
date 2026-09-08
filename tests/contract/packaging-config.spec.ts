import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { load } from 'js-yaml'

type BuilderTarget = {
  target?: string
  arch?: string[]
}

type BuilderConfiguration = {
  appId?: string
  productName?: string
  asar?: boolean
  directories?: {
    output?: string
    buildResources?: string
  }
  files?: string[]
  extraFiles?: unknown
  extraResources?: unknown
  beforeBuild?: string
  npmRebuild?: boolean
  mac?: {
    target?: BuilderTarget[]
    icon?: string
  }
  win?: {
    target?: BuilderTarget[]
    icon?: string
    files?: string[]
  }
  nsis?: {
    oneClick?: boolean
    perMachine?: boolean
    allowToChangeInstallationDirectory?: boolean
    deleteAppDataOnUninstall?: boolean
  }
}

type CompatibilityFixture = {
  fixtureVersion: number
  product: 'elasticsearch' | 'opensearch'
  version: string
  verification: 'live-local' | 'contract-only'
  responses: {
    root: Record<string, unknown>
    clusterHealth: Record<string, unknown>
    nodes: Record<string, unknown>
    tasks: Record<string, unknown>
  }
}

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const fixtureDirectory = path.join(repositoryRoot, 'tests/contract/fixtures')

const expectedFixtures = new Map([
  ['elasticsearch-7.3.1.json', ['elasticsearch', '7.3.1', 'live-local']],
  ['elasticsearch-8.17.3.json', ['elasticsearch', '8.17.3', 'contract-only']],
  ['elasticsearch-9.0.0.json', ['elasticsearch', '9.0.0', 'contract-only']],
  ['opensearch-1.3.19.json', ['opensearch', '1.3.19', 'contract-only']],
  ['opensearch-2.19.1.json', ['opensearch', '2.19.1', 'contract-only']],
  ['opensearch-3.0.0.json', ['opensearch', '3.0.0', 'contract-only']]
] as const)

async function readBuilderConfiguration(): Promise<BuilderConfiguration> {
  const content = await readFile(path.join(repositoryRoot, 'electron-builder.yml'), 'utf8')
  return load(content) as BuilderConfiguration
}

describe('桌面端打包配置', () => {
  it('首次启动不创建预置连接', async () => {
    const connectionServiceSource = await readFile(
      path.join(repositoryRoot, 'electron/main/connection/connection-service.ts'),
      'utf8'
    )

    assert.doesNotMatch(connectionServiceSource, /const DEFAULT_CONNECTIONS/)
    assert.doesNotMatch(connectionServiceSource, /createDefaultConnection\(['"](?:local|remote)['"]/)
    assert.match(connectionServiceSource, /await this\.persist\(\[\], \[\]\)/)
  })

  it('仅收录运行产物，并显式排除敏感与运行时数据', async () => {
    const configuration = await readBuilderConfiguration()
    const includedFiles = configuration.files?.filter((pattern) => !pattern.startsWith('!')) ?? []
    const excludedFiles = configuration.files?.filter((pattern) => pattern.startsWith('!')).join('\n') ?? ''

    assert.equal(configuration.appId, 'com.esatlas.desktop')
    assert.equal(configuration.productName, 'ES Atlas')
    assert.equal(configuration.asar, true)
    assert.deepEqual(configuration.directories, {
      output: 'release',
      buildResources: 'build'
    })
    assert.deepEqual(includedFiles, ['out/**/*', 'package.json'])
    assert.match(excludedFiles, /tests/)
    assert.match(excludedFiles, /\.log/)
    assert.match(excludedFiles, /connections?/)
    assert.match(excludedFiles, /(db|sqlite)/)
    assert.match(excludedFiles, /credentials?/)
    assert.match(excludedFiles, /secrets?/)
    assert.match(excludedFiles, /token/)
    assert.equal(configuration.extraFiles, undefined)
    assert.equal(configuration.extraResources, undefined)
  })

  it('配置 macOS DMG 与 Windows NSIS，且卸载时保留用户数据', async () => {
    const configuration = await readBuilderConfiguration()
    const macTarget = configuration.mac?.target?.find((target) => target.target === 'dmg')
    const windowsTarget = configuration.win?.target?.find((target) => target.target === 'nsis')

    assert.deepEqual(macTarget?.arch, ['x64', 'arm64'])
    assert.equal(configuration.mac?.icon, 'build/icon.icns')
    assert.deepEqual(windowsTarget?.arch, ['x64'])
    assert.equal(configuration.win?.icon, 'build/icon.ico')
    assert.equal(configuration.nsis?.oneClick, false)
    assert.equal(configuration.nsis?.perMachine, false)
    assert.equal(configuration.nsis?.allowToChangeInstallationDirectory, true)
    assert.equal(configuration.nsis?.deleteAppDataOnUninstall, false)
  })

  it('交叉打包跳过原生重建但保留生产依赖收集，并排除本机可选二进制', async () => {
    const configuration = await readBuilderConfiguration()
    const packagedFiles = configuration.files?.join('\n') ?? ''

    assert.equal(configuration.beforeBuild, undefined)
    assert.equal(configuration.npmRebuild, false)
    assert.equal(configuration.win?.files, undefined)
    assert.match(packagedFiles, /cpu-features/)
    assert.match(packagedFiles, /ssh2\/lib\/protocol\/crypto\/build/)
  })
})

describe('兼容性响应 fixture', () => {
  it('完整覆盖目标产品版本，并区分真实验证与契约验证', async () => {
    const fixtureFiles = (await readdir(fixtureDirectory)).filter((file) => file.endsWith('.json')).sort()

    assert.deepEqual(fixtureFiles, [...expectedFixtures.keys()].sort())

    for (const fixtureFile of fixtureFiles) {
      const fixtureContent = await readFile(path.join(fixtureDirectory, fixtureFile), 'utf8')
      const fixture = JSON.parse(fixtureContent) as CompatibilityFixture
      const expected = expectedFixtures.get(fixtureFile)

      assert.ok(expected)
      assert.equal(fixture.fixtureVersion, 1)
      assert.equal(fixture.product, expected[0])
      assert.equal(fixture.version, expected[1])
      assert.equal(fixture.verification, expected[2])
      assert.equal((fixture.responses.root.version as { number?: string }).number, fixture.version)
      assert.equal(typeof fixture.responses.clusterHealth.status, 'string')
      assert.equal(typeof (fixture.responses.nodes._nodes as { total?: number }).total, 'number')
      assert.equal(typeof fixture.responses.tasks.nodes, 'object')
    }
  })

  it('fixture 只包含脱敏最小响应，不携带连接与凭据信息', async () => {
    const fixtureFiles = await readdir(fixtureDirectory)

    for (const fixtureFile of fixtureFiles.filter((file) => file.endsWith('.json'))) {
      const fixtureContent = await readFile(path.join(fixtureDirectory, fixtureFile), 'utf8')

      assert.doesNotMatch(fixtureContent, /https?:\/\//i)
      assert.doesNotMatch(
        fixtureContent,
        /"(?:authorization|password|username|api[_-]?key|access[_-]?key|secret|token|url|host)"\s*:/i
      )
      assert.doesNotMatch(fixtureContent, /-----BEGIN [A-Z ]+PRIVATE KEY-----/)
      assert.doesNotMatch(fixtureContent, /\/(?:Users|home|var|opt|etc)\//)
    }
  })
})
