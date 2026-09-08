import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  DiagnosticsService,
  DiagnosticsServiceError,
  compareSemanticVersions,
  type DiagnosticsHttpClient,
  type DiagnosticsHttpRequest
} from '../../electron/main/app/diagnostics-service.ts'

function createHttpClient(
  execute: (input: DiagnosticsHttpRequest) => Promise<{ statusCode: number; body: string }>
): DiagnosticsHttpClient {
  return { get: execute }
}

describe('本地诊断与更新检查服务', () => {
  it('默认禁用更新检查且不发起网络请求', async () => {
    let requestCount = 0
    const service = new DiagnosticsService(createHttpClient(async () => {
      requestCount += 1
      return { statusCode: 200, body: '{"version":"2.0.0"}' }
    }))

    const result = await service.checkForUpdates({
      currentVersion: '1.0.0',
      manifestUrl: 'https://updates.example.com/manifest.json'
    })

    assert.deepEqual(result, {
      status: 'disabled',
      currentVersion: '1.0.0',
      latestVersion: null,
      releaseNotesUrl: null
    })
    assert.equal(requestCount, 0)
  })

  it('更新清单使用 HTTPS 并拒绝旧公网 HTTP 地址', async () => {
    const service = new DiagnosticsService(createHttpClient(async () => {
      throw new Error('不应请求')
    }))
    const invalidUrls = [
      'http://updates.example.com/manifest.json',
      'http://111.231.115.181/prod-api/public/atlas/releases/manifest',
      'https://user:secret@updates.example.com/manifest.json',
      'https://updates.example.com/manifest.json#fragment',
      '/manifest.json'
    ]

    for (const manifestUrl of invalidUrls) {
      await assert.rejects(
        service.checkForUpdates({
          enabled: true,
          currentVersion: '1.0.0',
          manifestUrl
        }),
        (error: unknown) =>
          error instanceof DiagnosticsServiceError && error.code === 'INVALID_MANIFEST_URL'
      )
    }

    const allowedService = new DiagnosticsService(createHttpClient(async () => ({
      statusCode: 200,
      body: '{"version":"1.0.0"}'
    })))
    await allowedService.checkForUpdates({
      enabled: true,
      currentVersion: '1.0.0',
      manifestUrl: 'https://ideaatlas.online/prod-api/public/atlas/releases/manifest'
    })
  })

  it('传递固定 5s/1MiB 限制并区分超时', async () => {
    let capturedRequest: DiagnosticsHttpRequest | null = null
    const service = new DiagnosticsService(createHttpClient(async (input) => {
      capturedRequest = input
      throw Object.assign(new Error('request timed out'), { code: 'ETIMEDOUT' })
    }))

    await assert.rejects(
      service.checkForUpdates({
        enabled: true,
        currentVersion: '1.0.0',
        manifestUrl: 'https://updates.example.com/manifest.json'
      }),
      (error: unknown) => error instanceof DiagnosticsServiceError && error.code === 'TIMEOUT'
    )
    assert.deepEqual(capturedRequest, {
      url: 'https://updates.example.com/manifest.json',
      timeoutMs: 5_000,
      maxResponseBytes: 1024 * 1024
    })
  })

  it('拒绝超过 1MiB 的 manifest 响应', async () => {
    const service = new DiagnosticsService(createHttpClient(async () => ({
      statusCode: 200,
      body: 'x'.repeat(1024 * 1024 + 1)
    })))

    await assert.rejects(
      service.checkForUpdates({
        enabled: true,
        currentVersion: '1.0.0',
        manifestUrl: 'https://updates.example.com/manifest.json'
      }),
      (error: unknown) =>
        error instanceof DiagnosticsServiceError && error.code === 'RESPONSE_TOO_LARGE'
    )
  })

  it('没有可发布版本时按当前已是最新处理', async () => {
    const notFoundService = new DiagnosticsService(createHttpClient(async () => ({
      statusCode: 404,
      body: '{}'
    })))
    const emptyService = new DiagnosticsService(createHttpClient(async () => ({
      statusCode: 200,
      body: JSON.stringify({ code: 200, data: null })
    })))
    const ajaxNotFoundService = new DiagnosticsService(createHttpClient(async () => ({
      statusCode: 200,
      body: JSON.stringify({ code: 404, msg: '未找到已发布版本', data: null })
    })))

    for (const service of [notFoundService, emptyService, ajaxNotFoundService]) {
      assert.deepEqual(await service.checkForUpdates({
        enabled: true,
        currentVersion: '1.0.0',
        manifestUrl: 'https://updates.example.com/manifest.json'
      }), {
        status: 'up-to-date',
        currentVersion: '1.0.0',
        latestVersion: null,
        releaseNotesUrl: null
      })
    }
  })

  it('本地诊断摘要仅保留版本、平台、错误码和 traceId', () => {
    const service = new DiagnosticsService()
    const summary = service.createLocalSummary({
      applicationVersion: '1.2.3',
      platform: 'darwin-arm64',
      traceId: 'trace-42',
      error: {
        code: 'CONNECTION_FORBIDDEN',
        message: 'Authorization: Bearer secret-token',
        body: '{"password":"secret-password"}',
        connection: { username: 'admin', password: 'secret-password' }
      }
    })
    const serialized = JSON.stringify(summary)

    assert.deepEqual(summary, {
      applicationVersion: '1.2.3',
      platform: 'darwin-arm64',
      errorCode: 'CONNECTION_FORBIDDEN',
      traceId: 'trace-42'
    })
    assert.equal(serialized.includes('secret-token'), false)
    assert.equal(serialized.includes('secret-password'), false)
    assert.equal(serialized.includes('body'), false)
  })

  it('严格校验 SemVer 并正确比较预发布版本', async () => {
    assert.equal(compareSemanticVersions('1.0.0', '1.0.1'), -1)
    assert.equal(compareSemanticVersions('2.0.0', '1.9.9'), 1)
    assert.equal(compareSemanticVersions('1.0.0-rc.1', '1.0.0'), -1)
    assert.equal(compareSemanticVersions('1.0.0+build.1', '1.0.0+build.2'), 0)

    const availableService = new DiagnosticsService(createHttpClient(async () => ({
      statusCode: 200,
      body: JSON.stringify({
        version: '1.1.0',
        releaseNotesUrl: 'https://updates.example.com/releases/1.1.0',
        downloadUrl: 'https://updates.example.com/releases/ES-Atlas-1.1.0.dmg',
        fileName: 'ES-Atlas-1.1.0.dmg',
        releaseNotes: '修复更新链路',
        checksumSha256: 'a'.repeat(64)
      })
    })))
    const available = await availableService.checkForUpdates({
      enabled: true,
      currentVersion: '1.0.0',
      manifestUrl: 'https://updates.example.com/manifest.json'
    })
    assert.deepEqual(available, {
      status: 'available',
      currentVersion: '1.0.0',
      latestVersion: '1.1.0',
      releaseNotesUrl: 'https://updates.example.com/releases/1.1.0',
      downloadUrl: 'https://updates.example.com/releases/ES-Atlas-1.1.0.dmg',
      fileName: 'ES-Atlas-1.1.0.dmg',
      releaseNotes: '修复更新链路',
      checksumSha256: 'a'.repeat(64)
    })

    const invalidService = new DiagnosticsService(createHttpClient(async () => ({
      statusCode: 200,
      body: '{"version":"01.2.3"}'
    })))
    await assert.rejects(
      invalidService.checkForUpdates({
        enabled: true,
        currentVersion: '1.0.0',
        manifestUrl: 'https://updates.example.com/manifest.json'
      }),
      (error: unknown) =>
        error instanceof DiagnosticsServiceError && error.code === 'INVALID_MANIFEST'
    )
  })

  it('使用 Atlas Admin 地址生成带应用、平台和架构参数的 manifest 请求', async () => {
    let capturedRequest: DiagnosticsHttpRequest | null = null
    const service = new DiagnosticsService(createHttpClient(async (input) => {
      capturedRequest = input
      return {
        statusCode: 200,
        body: JSON.stringify({
          code: 200,
          msg: 'success',
          data: [{
            version: '1.2.0',
            platform: 'macos',
            architecture: 'arm64',
            releaseNotesUrl: null
          }]
        })
      }
    }))

    const result = await service.checkForUpdates({
      enabled: true,
      currentVersion: '1.0.0',
      atlasAdminBaseUrl: 'https://admin.example.com/atlas',
      platform: 'macos',
      architecture: 'arm64'
    })

    assert.equal(
      capturedRequest?.url,
      'https://admin.example.com/atlas/public/atlas/releases/check?appCode=es-atlas&platform=macos&architecture=arm64'
    )
    assert.deepEqual(result, {
      status: 'available',
      currentVersion: '1.0.0',
      latestVersion: '1.2.0',
      releaseNotesUrl: null
    })
  })

  it('自定义 manifest URL 不追加 appCode', async () => {
    let capturedRequest: DiagnosticsHttpRequest | null = null
    const service = new DiagnosticsService(createHttpClient(async (input) => {
      capturedRequest = input
      return {
        statusCode: 200,
        body: '{"version":"1.0.0"}'
      }
    }))
    const manifestUrl = 'https://updates.example.com/manifest.json?channel=stable'

    await service.checkForUpdates({
      enabled: true,
      currentVersion: '1.0.0',
      manifestUrl,
      platform: 'macos',
      architecture: 'arm64'
    })

    assert.equal(capturedRequest?.url, manifestUrl)
  })

  it('兼容 AjaxResult.data 与直接 JSON 的 desktop-config', async () => {
    const wrappedService = new DiagnosticsService(createHttpClient(async () => ({
      statusCode: 200,
      body: JSON.stringify({ code: 200, data: { websiteUrl: 'https://www.example.com' } })
    })))
    const directService = new DiagnosticsService(createHttpClient(async () => ({
      statusCode: 200,
      body: JSON.stringify({ websiteUrl: 'https://www.example.com', plugins: [] })
    })))

    const wrapped = await wrappedService.loadDesktopConfiguration({
      atlasAdminBaseUrl: 'https://admin.example.com'
    })
    const direct = await directService.loadDesktopConfiguration({
      atlasAdminBaseUrl: 'http://127.0.0.1:8080'
    })

    assert.deepEqual(wrapped, {
      sourceUrl: 'https://admin.example.com/public/atlas/desktop-config',
      configuration: { websiteUrl: 'https://www.example.com' }
    })
    assert.deepEqual(direct, {
      sourceUrl: 'http://127.0.0.1:8080/public/atlas/desktop-config',
      configuration: { websiteUrl: 'https://www.example.com', plugins: [] }
    })
  })

  it('Atlas Admin 远端使用 HTTPS 并拒绝旧公网 HTTP 地址', async () => {
    const service = new DiagnosticsService(createHttpClient(async () => {
      throw new Error('不应请求')
    }))
    const invalidUrls = [
      'http://admin.example.com',
      'http://111.231.115.181/prod-api',
      'https://user:secret@admin.example.com',
      'https://admin.example.com?token=secret'
    ]

    for (const atlasAdminBaseUrl of invalidUrls) {
      await assert.rejects(
        service.loadDesktopConfiguration({ atlasAdminBaseUrl }),
        (error: unknown) =>
          error instanceof DiagnosticsServiceError && error.code === 'INVALID_ATLAS_ADMIN_URL'
      )
    }


    const allowedService = new DiagnosticsService(createHttpClient(async () => ({
      statusCode: 200,
      body: JSON.stringify({ code: 200, data: {} })
    })))
    const result = await allowedService.loadDesktopConfiguration({
      atlasAdminBaseUrl: 'https://ideaatlas.online/prod-api'
    })
    assert.equal(
      result.sourceUrl,
      'https://ideaatlas.online/prod-api/public/atlas/desktop-config'
    )
  })

  it('拒绝失败的 AjaxResult 和非对象 desktop-config', async () => {
    const failedService = new DiagnosticsService(createHttpClient(async () => ({
      statusCode: 200,
      body: JSON.stringify({ code: 500, msg: '配置未发布', data: null })
    })))
    const invalidService = new DiagnosticsService(createHttpClient(async () => ({
      statusCode: 200,
      body: JSON.stringify({ code: 200, data: [] })
    })))

    await assert.rejects(
      failedService.loadDesktopConfiguration({ atlasAdminBaseUrl: 'https://admin.example.com' }),
      (error: unknown) =>
        error instanceof DiagnosticsServiceError && error.code === 'HTTP_ERROR' &&
        error.message.includes('配置未发布')
    )
    await assert.rejects(
      invalidService.loadDesktopConfiguration({ atlasAdminBaseUrl: 'https://admin.example.com' }),
      (error: unknown) =>
        error instanceof DiagnosticsServiceError && error.code === 'INVALID_DESKTOP_CONFIGURATION'
    )
  })
})
