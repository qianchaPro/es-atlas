import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type {
  DesktopConfigurationRequest,
  DesktopConfigurationResult,
  DiagnosticsErrorCode,
  LocalDiagnosticInput,
  LocalDiagnosticSummary,
  UpdateCheckInput,
  UpdateCheckResult
} from '../../../src/shared/types/diagnostics'

export type DiagnosticsHttpRequest = {
  url: string
  timeoutMs: number
  maxResponseBytes: number
}

export type DiagnosticsHttpResponse = {
  statusCode: number
  body: string
}

export type DiagnosticsHttpClient = {
  get: (input: DiagnosticsHttpRequest) => Promise<DiagnosticsHttpResponse>
}

type SemanticVersion = {
  major: number
  minor: number
  patch: number
  prerelease: string[]
}

const UPDATE_TIMEOUT_MS = 5_000
const MAX_MANIFEST_BYTES = 1024 * 1024
const DESKTOP_CONFIGURATION_PATH = 'public/atlas/desktop-config'
const RELEASE_MANIFEST_PATH = 'public/atlas/releases/check'
const ATLAS_APP_CODE = 'es-atlas'
const MAX_PLATFORM_LENGTH = 64
const MAX_ERROR_CODE_LENGTH = 128
const MAX_TRACE_ID_LENGTH = 160
const SAFE_PLATFORM_PATTERN = /^[A-Za-z0-9._-]+$/u
const SAFE_CODE_PATTERN = /^[A-Za-z0-9._:-]+$/u
const SEMANTIC_VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u
const TIMEOUT_MESSAGE_PATTERN = /(?:timeout|timed out|超时|请求超过)/iu

export class DiagnosticsServiceError extends Error {
  readonly code: DiagnosticsErrorCode
  readonly statusCode: number | null

  constructor(
    code: DiagnosticsErrorCode,
    operation: string,
    reason: string,
    options?: { cause?: unknown; statusCode?: number | null }
  ) {
    super(`诊断与更新模块失败：操作=${operation}，原因=${reason}`, {
      cause: options?.cause
    })
    this.name = 'DiagnosticsServiceError'
    this.code = code
    this.statusCode = options?.statusCode ?? null
  }
}

export class DiagnosticsService {
  private readonly httpClient: DiagnosticsHttpClient

  constructor(httpClient: DiagnosticsHttpClient = createHttpsClient()) {
    this.httpClient = httpClient
  }

  createLocalSummary(input: LocalDiagnosticInput): LocalDiagnosticSummary {
    if (!isRecord(input)) {
      throw new DiagnosticsServiceError(
        'INVALID_DIAGNOSTIC_INPUT',
        '生成本地诊断摘要',
        '诊断参数必须是对象'
      )
    }
    const applicationVersion = normalizeDiagnosticVersion(input.applicationVersion)
    const platform = normalizePlatform(input.platform)
    const errorCode = readSafeErrorCode(input.error)
    const traceId = readSafeTraceId(input.traceId)

    // 摘要仅构造固定白名单字段，不序列化原始错误或连接上下文。
    return {
      applicationVersion,
      platform,
      errorCode,
      traceId
    }
  }

  async checkForUpdates(input: UpdateCheckInput): Promise<UpdateCheckResult> {
    if (!isRecord(input)) {
      throw new DiagnosticsServiceError(
        'INVALID_CURRENT_VERSION',
        '检查更新',
        '更新检查参数必须是对象'
      )
    }
    const currentVersion = normalizeCurrentVersion(input.currentVersion)
    if (input.enabled !== true) {
      return {
        status: 'disabled',
        currentVersion,
        latestVersion: null,
        releaseNotesUrl: null
      }
    }

    const platform = normalizeRemoteIdentifier(input.platform, 'platform')
    const architecture = normalizeRemoteIdentifier(input.architecture, 'architecture')
    const manifestUrl = input.manifestUrl
      ? normalizeHttpsUrl(input.manifestUrl, 'INVALID_MANIFEST_URL', 'manifest URL')
      : createAtlasAdminUrl(
          input.atlasAdminBaseUrl,
          RELEASE_MANIFEST_PATH,
          { appCode: ATLAS_APP_CODE, platform, architecture }
        )
    const response = await this.getManifest(manifestUrl)
    if (response.statusCode === 404 || response.statusCode === 204) {
      return this.createUpToDateResult(currentVersion)
    }
    if (response.statusCode !== 200) {
      throw new DiagnosticsServiceError(
        'HTTP_ERROR',
        '检查更新',
        `manifest 请求返回 HTTP ${response.statusCode}`,
        { statusCode: response.statusCode }
      )
    }
    if (Buffer.byteLength(response.body, 'utf8') > MAX_MANIFEST_BYTES) {
      throw new DiagnosticsServiceError(
        'RESPONSE_TOO_LARGE',
        '检查更新',
        `manifest 响应超过 ${MAX_MANIFEST_BYTES} 字节`
      )
    }

    if (!response.body.trim()) return this.createUpToDateResult(currentVersion)

    let manifest: ReturnType<typeof parseManifest>
    try {
      manifest = parseManifest(response.body, platform, architecture)
    } catch (error: unknown) {
      if (error instanceof DiagnosticsServiceError && (
          (error.code === 'INVALID_MANIFEST' && error.message.includes('manifest.version 必须是')) ||
          (error.code === 'HTTP_ERROR' && error.message.includes('AjaxResult code=404'))
      )) {
        return this.createUpToDateResult(currentVersion)
      }
      throw error
    }
    return {
      status: compareSemanticVersions(currentVersion, manifest.version) < 0
        ? 'available'
        : 'up-to-date',
      currentVersion,
      latestVersion: manifest.version,
      releaseNotesUrl: manifest.releaseNotesUrl,
      ...(manifest.downloadUrl !== undefined ? { downloadUrl: manifest.downloadUrl } : {}),
      ...(manifest.fileName !== undefined ? { fileName: manifest.fileName } : {}),
      ...(manifest.releaseNotes !== undefined ? { releaseNotes: manifest.releaseNotes } : {}),
      ...(manifest.checksumSha256 !== undefined ? { checksumSha256: manifest.checksumSha256 } : {})
    }
  }

  private createUpToDateResult(currentVersion: string): UpdateCheckResult {
    return {
      status: 'up-to-date',
      currentVersion,
      latestVersion: null,
      releaseNotesUrl: null
    }
  }

  async loadDesktopConfiguration(
    input: DesktopConfigurationRequest
  ): Promise<DesktopConfigurationResult> {
    if (!isRecord(input)) {
      throw new DiagnosticsServiceError(
        'INVALID_ATLAS_ADMIN_URL',
        '读取桌面配置',
        '桌面配置参数必须是对象'
      )
    }
    const sourceUrl = createAtlasAdminUrl(
      input.atlasAdminBaseUrl,
      DESKTOP_CONFIGURATION_PATH
    )
    const response = await this.getRemoteJson(sourceUrl, '读取桌面配置', 'desktop-config')
    if (response.statusCode !== 200) {
      throw new DiagnosticsServiceError(
        'HTTP_ERROR',
        '读取桌面配置',
        `desktop-config 请求返回 HTTP ${response.statusCode}`,
        { statusCode: response.statusCode }
      )
    }
    return {
      sourceUrl,
      configuration: parseDesktopConfiguration(response.body)
    }
  }

  private async getManifest(url: string): Promise<DiagnosticsHttpResponse> {
    return this.getRemoteJson(url, '检查更新', 'manifest')
  }

  private async getRemoteJson(
    url: string,
    operation: string,
    resourceName: string
  ): Promise<DiagnosticsHttpResponse> {
    try {
      return await withTimeout(
        this.httpClient.get({
          url,
          timeoutMs: UPDATE_TIMEOUT_MS,
          maxResponseBytes: MAX_MANIFEST_BYTES
        }),
        UPDATE_TIMEOUT_MS
      )
    } catch (error: unknown) {
      if (error instanceof DiagnosticsServiceError) throw error
      const code = readStringProperty(error, 'code')
      const message = readStringProperty(error, 'message') ?? String(error)
      if (code === 'ERR_RESPONSE_TOO_LARGE') {
        throw new DiagnosticsServiceError(
          'RESPONSE_TOO_LARGE',
          operation,
          `${resourceName} 响应超过 ${MAX_MANIFEST_BYTES} 字节`,
          { cause: error }
        )
      }
      if (code === 'ETIMEDOUT' || TIMEOUT_MESSAGE_PATTERN.test(message)) {
        throw new DiagnosticsServiceError(
          'TIMEOUT',
          operation,
          `${resourceName} 请求超过 ${UPDATE_TIMEOUT_MS}ms`,
          { cause: error }
        )
      }
      throw new DiagnosticsServiceError(
        'NETWORK_ERROR',
        operation,
        `无法读取 ${resourceName}，url=${url}`,
        { cause: error }
      )
    }
  }
}

export function compareSemanticVersions(left: string, right: string): -1 | 0 | 1 {
  const leftVersion = parseSemanticVersion(left)
  const rightVersion = parseSemanticVersion(right)
  const coreComparison = compareNumbers(
    [leftVersion.major, leftVersion.minor, leftVersion.patch],
    [rightVersion.major, rightVersion.minor, rightVersion.patch]
  )
  if (coreComparison !== 0) return coreComparison
  return comparePrerelease(leftVersion.prerelease, rightVersion.prerelease)
}

function parseManifest(
  body: string,
  platform: string,
  architecture: string
): {
  version: string
  releaseNotesUrl: string | null
  downloadUrl?: string | null
  fileName?: string | null
  releaseNotes?: string | null
  checksumSha256?: string | null
} {
  let parsed: unknown
  try {
    parsed = JSON.parse(body) as unknown
  } catch (error: unknown) {
    throw new DiagnosticsServiceError(
      'INVALID_MANIFEST',
      '解析更新 manifest',
      'manifest 不是合法 JSON',
      { cause: error }
    )
  }
  const unwrapped = unwrapAjaxResult(parsed, '解析更新 manifest')
  const manifest = selectManifest(unwrapped, platform, architecture)
  if (!isRecord(manifest) || typeof manifest.version !== 'string') {
    throw new DiagnosticsServiceError(
      'INVALID_MANIFEST',
      '解析更新 manifest',
      'manifest.version 必须是 SemVer 字符串'
    )
  }
  try {
    parseSemanticVersion(manifest.version)
  } catch (error: unknown) {
    throw new DiagnosticsServiceError(
      'INVALID_MANIFEST',
      '解析更新 manifest',
      `manifest.version 不是严格 SemVer：${manifest.version}`,
      { cause: error }
    )
  }
  const releaseNotesUrl = manifest.releaseNotesUrl === undefined || manifest.releaseNotesUrl === null
    ? null
    : normalizeHttpsUrl(
        manifest.releaseNotesUrl,
        'INVALID_MANIFEST',
        'releaseNotesUrl'
      )
  const downloadUrl = Object.hasOwn(manifest, 'downloadUrl')
    ? manifest.downloadUrl === null
      ? null
      : normalizeHttpsUrl(manifest.downloadUrl, 'INVALID_MANIFEST', 'downloadUrl')
    : undefined
  const fileName = Object.hasOwn(manifest, 'fileName')
    ? manifest.fileName === null ? null : readOptionalManifestString(manifest.fileName, 'fileName')
    : undefined
  const releaseNotes = Object.hasOwn(manifest, 'releaseNotes')
    ? manifest.releaseNotes === null ? null : readOptionalManifestString(manifest.releaseNotes, 'releaseNotes')
    : undefined
  const checksumSha256 = Object.hasOwn(manifest, 'checksumSha256')
    ? manifest.checksumSha256 === null
      ? null
      : readOptionalManifestString(manifest.checksumSha256, 'checksumSha256')
    : undefined
  return { version: manifest.version, releaseNotesUrl, downloadUrl, fileName, releaseNotes, checksumSha256 }
}

function readOptionalManifestString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length > MAX_MANIFEST_BYTES) {
    throw new DiagnosticsServiceError(
      'INVALID_MANIFEST',
      '解析更新 manifest',
      `${field} 必须是字符串且长度不超过 ${MAX_MANIFEST_BYTES}`
    )
  }
  return value
}

function parseDesktopConfiguration(body: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(body) as unknown
  } catch (error: unknown) {
    throw new DiagnosticsServiceError(
      'INVALID_DESKTOP_CONFIGURATION',
      '解析桌面配置',
      'desktop-config 不是合法 JSON',
      { cause: error }
    )
  }
  const configuration = unwrapAjaxResult(parsed, '解析桌面配置')
  if (!isRecord(configuration)) {
    throw new DiagnosticsServiceError(
      'INVALID_DESKTOP_CONFIGURATION',
      '解析桌面配置',
      'desktop-config 必须是 JSON 对象或 AjaxResult.data 对象'
    )
  }
  return configuration
}

function unwrapAjaxResult(value: unknown, operation: string): unknown {
  if (!isRecord(value) || !Object.hasOwn(value, 'data') ||
      (!Object.hasOwn(value, 'code') && !Object.hasOwn(value, 'msg'))) {
    return value
  }
  const code = value.code
  if (code !== undefined && code !== 0 && code !== 200 && code !== '0' && code !== '200') {
    const message = typeof value.msg === 'string' ? value.msg : '后台返回失败状态'
    throw new DiagnosticsServiceError(
      'HTTP_ERROR',
      operation,
      `AjaxResult code=${String(code)}，msg=${message}`
    )
  }
  return value.data
}

function selectManifest(value: unknown, platform: string, architecture: string): unknown {
  if (!Array.isArray(value)) return value
  return value.find((candidate) =>
    isRecord(candidate) &&
    (candidate.platform === undefined || candidate.platform === platform) &&
    (candidate.architecture === undefined || candidate.architecture === architecture)
  ) ?? value[0]
}

function normalizeCurrentVersion(value: unknown): string {
  if (typeof value !== 'string') {
    throw new DiagnosticsServiceError(
      'INVALID_CURRENT_VERSION',
      '检查更新',
      '当前版本必须是 SemVer 字符串'
    )
  }
  try {
    parseSemanticVersion(value)
    return value
  } catch (error: unknown) {
    throw new DiagnosticsServiceError(
      'INVALID_CURRENT_VERSION',
      '检查更新',
      `当前版本不是严格 SemVer：${value}`,
      { cause: error }
    )
  }
}

function normalizeRemoteIdentifier(value: unknown, field: string): string {
  if (value === undefined) return 'unknown'
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > MAX_PLATFORM_LENGTH ||
    !SAFE_PLATFORM_PATTERN.test(value)
  ) {
    throw new DiagnosticsServiceError(
      'INVALID_MANIFEST_URL',
      '生成更新地址',
      `${field} 必须是 1-${MAX_PLATFORM_LENGTH} 位安全标识`
    )
  }
  return value
}

function createAtlasAdminUrl(
  baseUrlInput: unknown,
  path: string,
  query: Record<string, string> = {}
): string {
  const baseUrl = normalizeAtlasAdminBaseUrl(baseUrlInput)
  const url = new URL(`${baseUrl.replace(/\/+$/u, '')}/${path}`)
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value)
  return url.toString()
}

function normalizeAtlasAdminBaseUrl(value: unknown): string {
  let url: URL
  try {
    if (typeof value !== 'string' || !value) throw new Error('Atlas Admin 地址为空')
    url = new URL(value)
  } catch (error: unknown) {
    throw new DiagnosticsServiceError(
      'INVALID_ATLAS_ADMIN_URL',
      '校验 Atlas Admin 地址',
      'Atlas Admin 地址必须是绝对 URL',
      { cause: error }
    )
  }
  const isAllowedHttp = url.protocol === 'http:' && isLoopbackHost(url.hostname)
  if (
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' && !isAllowedHttp)
  ) {
    throw new DiagnosticsServiceError(
      'INVALID_ATLAS_ADMIN_URL',
      '校验 Atlas Admin 地址',
      '仅允许无凭据、无 query/fragment 的 HTTPS URL，或本机回环 HTTP 地址'
    )
  }
  return url.toString()
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}

function normalizeDiagnosticVersion(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 64 || /\s/u.test(value)) {
    throw new DiagnosticsServiceError(
      'INVALID_DIAGNOSTIC_INPUT',
      '生成本地诊断摘要',
      '应用版本必须是 1-64 位且不含空白字符'
    )
  }
  return value
}

function normalizePlatform(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > MAX_PLATFORM_LENGTH ||
    !SAFE_PLATFORM_PATTERN.test(value)
  ) {
    throw new DiagnosticsServiceError(
      'INVALID_DIAGNOSTIC_INPUT',
      '生成本地诊断摘要',
      '平台标识不合法'
    )
  }
  return value
}

function readSafeErrorCode(error: unknown): string {
  const code = readStringProperty(error, 'code')
  if (
    code &&
    code.length <= MAX_ERROR_CODE_LENGTH &&
    SAFE_CODE_PATTERN.test(code)
  ) {
    return code
  }
  return 'UNKNOWN'
}

function readSafeTraceId(value: unknown): string | null {
  if (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_TRACE_ID_LENGTH &&
    SAFE_CODE_PATTERN.test(value)
  ) {
    return value
  }
  return null
}

function normalizeHttpsUrl(
  value: unknown,
  errorCode: 'INVALID_MANIFEST_URL' | 'INVALID_MANIFEST',
  field: string
): string {
  let url: URL
  try {
    if (typeof value !== 'string' || !value) throw new Error(`${field} 为空`)
    url = new URL(value)
  } catch (error: unknown) {
    throw new DiagnosticsServiceError(
      errorCode,
      '校验更新地址',
      `${field} 必须是绝对 URL`,
      { cause: error }
    )
  }
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(url.hostname))) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new DiagnosticsServiceError(
      errorCode,
      '校验更新地址',
      `${field} 仅允许无凭据、无 fragment 的 HTTPS URL，或本机回环 HTTP 地址`
    )
  }
  return url.toString()
}

function parseSemanticVersion(value: string): SemanticVersion {
  const match = SEMANTIC_VERSION_PATTERN.exec(value)
  if (!match) throw new Error(`非法 SemVer：${value}`)
  const prerelease = match[4]?.split('.') ?? []
  if (prerelease.some((identifier) => /^\d+$/u.test(identifier) && /^0\d+/u.test(identifier))) {
    throw new Error(`SemVer 预发布数字标识不能包含前导零：${value}`)
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease
  }
}

function compareNumbers(left: number[], right: number[]): -1 | 0 | 1 {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] < right[index]) return -1
    if (left[index] > right[index]) return 1
  }
  return 0
}

function comparePrerelease(left: string[], right: string[]): -1 | 0 | 1 {
  if (left.length === 0 && right.length === 0) return 0
  if (left.length === 0) return 1
  if (right.length === 0) return -1
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = left[index]
    const rightIdentifier = right[index]
    if (leftIdentifier === undefined) return -1
    if (rightIdentifier === undefined) return 1
    if (leftIdentifier === rightIdentifier) continue
    const leftNumeric = /^\d+$/u.test(leftIdentifier)
    const rightNumeric = /^\d+$/u.test(rightIdentifier)
    if (leftNumeric && rightNumeric) {
      const comparison = compareNumericIdentifiers(leftIdentifier, rightIdentifier)
      if (comparison !== 0) return comparison
      continue
    }
    if (leftNumeric) return -1
    if (rightNumeric) return 1
    return leftIdentifier < rightIdentifier ? -1 : 1
  }
  return 0
}

function compareNumericIdentifiers(left: string, right: string): -1 | 0 | 1 {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1
  if (left === right) return 0
  return left < right ? -1 : 1
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(Object.assign(new Error(`request timed out after ${timeoutMs}ms`), {
        code: 'ETIMEDOUT'
      }))
    }, timeoutMs)
    timer.unref()
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

function createHttpsClient(): DiagnosticsHttpClient {
  return {
    get(input: DiagnosticsHttpRequest): Promise<DiagnosticsHttpResponse> {
      return new Promise((resolve, reject) => {
        const requestFunction = input.url.startsWith('http:') ? httpRequest : httpsRequest
        const request = requestFunction(input.url, {
          method: 'GET',
          headers: { accept: 'application/json' }
        }, (response) => {
          const chunks: Buffer[] = []
          let totalBytes = 0
          response.on('data', (chunk: Buffer | string) => {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
            totalBytes += buffer.byteLength
            if (totalBytes > input.maxResponseBytes) {
              response.destroy(Object.assign(new Error('response too large'), {
                code: 'ERR_RESPONSE_TOO_LARGE'
              }))
              return
            }
            chunks.push(buffer)
          })
          response.on('end', () => {
            resolve({
              statusCode: response.statusCode ?? 0,
              body: Buffer.concat(chunks).toString('utf8')
            })
          })
          response.on('error', reject)
        })
        request.setTimeout(input.timeoutMs, () => {
          request.destroy(Object.assign(new Error('request timed out'), { code: 'ETIMEDOUT' }))
        })
        request.on('error', reject)
        request.end()
      })
    }
  }
}

function readStringProperty(value: unknown, key: string): string | null {
  if (!isRecord(value)) return null
  return typeof value[key] === 'string' ? value[key] : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
