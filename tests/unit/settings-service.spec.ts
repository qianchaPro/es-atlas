import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { SettingsService, SettingsServiceError } from '../../electron/main/settings/settings-service.ts'
import {
  DEFAULT_GLOBAL_PREFERENCES,
  PREFERENCES_VERSION
} from '../../src/shared/types/settings.ts'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ))
})

async function createStoragePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'es-atlas-settings-'))
  temporaryDirectories.push(directory)
  return join(directory, 'preferences.json')
}

describe('设置服务远程地址持久化', () => {
  it('默认锁定彩蛋主题，并拒绝未解锁时直接保存隐藏主题', async () => {
    const service = new SettingsService(await createStoragePath())
    await service.initialize()

    assert.deepEqual(service.get().global.unlockedEasterEggThemes, [])
    await assert.rejects(
      service.save({
        global: {
          ...DEFAULT_GLOBAL_PREFERENCES,
          theme: 'starlight',
          unlockedEasterEggThemes: []
        },
        connections: {}
      }),
      (error: unknown) =>
        error instanceof SettingsServiceError && error.code === 'SETTINGS_VALIDATION_FAILED'
    )
  })

  it('秘籍解锁后允许持久化对应彩蛋主题', async () => {
    const storagePath = await createStoragePath()
    const service = new SettingsService(storagePath)
    await service.initialize()

    await service.save({
      global: {
        ...DEFAULT_GLOBAL_PREFERENCES,
        theme: 'pixel',
        unlockedEasterEggThemes: ['pixel']
      },
      connections: {}
    })
    const reloadedService = new SettingsService(storagePath)
    await reloadedService.initialize()

    assert.equal(reloadedService.get().global.theme, 'pixel')
    assert.deepEqual(reloadedService.get().global.unlockedEasterEggThemes, ['pixel'])
  })

  it('旧偏好没有解锁记录时关闭已选择的彩蛋主题', async () => {
    const storagePath = await createStoragePath()
    const { unlockedEasterEggThemes: _unlockedEasterEggThemes, ...legacyGlobalPreferences } =
      DEFAULT_GLOBAL_PREFERENCES
    await writeFile(storagePath, JSON.stringify({
      version: PREFERENCES_VERSION,
      global: { ...legacyGlobalPreferences, theme: 'starlight' },
      connections: {}
    }), 'utf8')
    const service = new SettingsService(storagePath)

    const diagnostic = await service.initialize()

    assert.equal(diagnostic, null)
    assert.equal(service.get().global.theme, 'light')
    assert.deepEqual(service.get().global.unlockedEasterEggThemes, [])
  })

  it('持久化 Atlas Admin 与 manifest URL', async () => {
    const storagePath = await createStoragePath()
    const service = new SettingsService(storagePath)
    await service.initialize()

    await service.save({
      global: {
        ...DEFAULT_GLOBAL_PREFERENCES,
        atlasAdminBaseUrl: 'https://admin.example.com/atlas',
        updateManifestUrl: 'https://updates.example.com/manifest.json'
      },
      connections: {}
    })
    const reloadedService = new SettingsService(storagePath)
    await reloadedService.initialize()

    assert.equal(reloadedService.get().global.atlasAdminBaseUrl, 'https://admin.example.com/atlas')
    assert.equal(reloadedService.get().global.homepageUrl, 'https://ideaatlas.online/esAtlas')
    assert.equal(reloadedService.get().global.blogUrl, 'https://ideaatlas.online/')
    assert.equal(
      reloadedService.get().global.updateManifestUrl,
      'https://updates.example.com/manifest.json'
    )
  })

  it('旧版 v1 缺少远程地址时迁移到线上默认地址', async () => {
    const storagePath = await createStoragePath()
    const { blogUrl, atlasAdminBaseUrl, updateManifestUrl, ...legacyGlobalPreferences } =
      DEFAULT_GLOBAL_PREFERENCES
    legacyGlobalPreferences.homepageUrl = 'http://www.ideaatlas.online/'
    await writeFile(storagePath, JSON.stringify({
      version: PREFERENCES_VERSION,
      global: legacyGlobalPreferences,
      connections: {}
    }), 'utf8')
    const service = new SettingsService(storagePath)

    const diagnostic = await service.initialize()

    assert.equal(diagnostic, null)
    assert.equal(service.get().global.atlasAdminBaseUrl, 'https://ideaatlas.online/prod-api')
    assert.equal(service.get().global.homepageUrl, 'https://ideaatlas.online/esAtlas')
    assert.equal(service.get().global.blogUrl, 'https://ideaatlas.online/')
    assert.equal(service.get().global.updateManifestUrl, '')
  })

  it('旧版默认地址迁移到线上 IP 地址', async () => {
    const storagePath = await createStoragePath()
    await writeFile(storagePath, JSON.stringify({
      version: PREFERENCES_VERSION,
      global: {
        ...DEFAULT_GLOBAL_PREFERENCES,
        homepageUrl: 'http://www.ideaatlas.online/esAtlas',
        blogUrl: 'http://www.ideaatlas.online/',
        atlasAdminBaseUrl: 'http://127.0.0.1:20808'
      },
      connections: {}
    }), 'utf8')
    const service = new SettingsService(storagePath)

    const diagnostic = await service.initialize()

    assert.equal(diagnostic, null)
    assert.equal(service.get().global.homepageUrl, 'https://ideaatlas.online/esAtlas')
    assert.equal(service.get().global.blogUrl, 'https://ideaatlas.online/')
    assert.equal(service.get().global.atlasAdminBaseUrl, 'https://ideaatlas.online/prod-api')
  })

  it('旧公网 IP 偏好迁移至 HTTPS，保留其他设置且可重新保存', async () => {
    const storagePath = await createStoragePath()
    await writeFile(storagePath, JSON.stringify({
      version: PREFERENCES_VERSION,
      global: {
        ...DEFAULT_GLOBAL_PREFERENCES,
        homepageUrl: 'http://111.231.115.181/esAtlas',
        blogUrl: 'http://111.231.115.181/',
        atlasAdminBaseUrl: 'http://111.231.115.181/prod-api',
        fontSize: 16
      },
      connections: {}
    }), 'utf8')
    const service = new SettingsService(storagePath)
    assert.equal(await service.initialize(), null)
    assert.equal(service.get().global.homepageUrl, 'https://ideaatlas.online/esAtlas')
    assert.equal(service.get().global.blogUrl, 'https://ideaatlas.online/')
    assert.equal(service.get().global.atlasAdminBaseUrl, 'https://ideaatlas.online/prod-api')
    assert.equal(service.get().global.fontSize, 16)
    await service.save(service.get())
    const reloadedService = new SettingsService(storagePath)
    assert.equal(await reloadedService.initialize(), null)
    assert.deepEqual(reloadedService.get(), service.get())
  })

  it('保存时拒绝旧公网 HTTP 地址', async () => {
    const service = new SettingsService(await createStoragePath())
    await service.initialize()
    await assert.rejects(service.save({
      global: { ...DEFAULT_GLOBAL_PREFERENCES, atlasAdminBaseUrl: 'http://111.231.115.181/prod-api' },
      connections: {}
    }), (error: unknown) => error instanceof SettingsServiceError && error.code === 'SETTINGS_VALIDATION_FAILED')
  })

  it('拒绝公网 HTTP 和带凭据的远程地址', async () => {
    const service = new SettingsService(await createStoragePath())
    await service.initialize()

    await assert.rejects(
      service.save({
        global: {
          ...DEFAULT_GLOBAL_PREFERENCES,
          atlasAdminBaseUrl: 'http://admin.example.com',
          updateManifestUrl: 'https://user:secret@updates.example.com/manifest.json'
        },
        connections: {}
      }),
      (error: unknown) =>
        error instanceof SettingsServiceError && error.code === 'SETTINGS_VALIDATION_FAILED'
    )
  })
})
