import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  DEFAULT_CONNECTION_PREFERENCES,
  DEFAULT_GLOBAL_PREFERENCES,
  MAX_DEFAULT_QUERY_SIZE,
  MAX_FONT_SIZE,
  MAX_REFRESH_INTERVAL_SECONDS,
  MIN_DEFAULT_QUERY_SIZE,
  MIN_FONT_SIZE,
  MIN_REFRESH_INTERVAL_SECONDS,
  PREFERENCES_VERSION,
  type AppLanguage,
  type AppTheme,
  type ConnectionPreferences,
  type EasterEggTheme,
  type GlobalPreferences,
  type InterfaceDensity,
  type PreferencesSnapshot,
  type SavePreferencesInput,
  type SettingsDiagnostic
// Node 内置 TypeScript 测试器需要显式扩展名，Electron Vite 同样可以解析该源文件。
// @ts-expect-error TypeScript 测试运行时直接加载 .ts 源文件
} from '../../../src/shared/types/settings.ts'

const MAX_FONT_FAMILY_LENGTH = 256
const MAX_REMOTE_URL_LENGTH = 2_048
const MAX_CONNECTION_ID_LENGTH = 128
const RESERVED_CONNECTION_IDS = new Set(['__proto__', 'constructor', 'prototype'])
const THEMES = new Set<AppTheme>(['light', 'dark', 'starlight', 'pixel'])
const EASTER_EGG_THEMES = new Set<EasterEggTheme>(['starlight', 'pixel'])
const LANGUAGES = new Set<AppLanguage>(['zh-CN', 'en-US'])
const DENSITIES = new Set<InterfaceDensity>(['compact', 'standard', 'comfortable'])

export class SettingsServiceError extends Error {
  readonly code: string

  constructor(
    code: string,
    operation: string,
    reason: string,
    options?: ErrorOptions
  ) {
    super(`设置模块失败：操作=${operation}，原因=${reason}`, options)
    this.name = 'SettingsServiceError'
    this.code = code
  }
}

type ParsedPreferences = {
  snapshot: PreferencesSnapshot
  diagnostic: SettingsDiagnostic | null
}

export class SettingsService {
  private readonly storagePath: string
  private snapshot: PreferencesSnapshot = createDefaultSnapshot()
  private diagnostic: SettingsDiagnostic | null = null

  constructor(storagePath: string) {
    this.storagePath = storagePath
  }

  async initialize(): Promise<SettingsDiagnostic | null> {
    try {
      const content = await readFile(this.storagePath, 'utf8')
      const parsed = parsePersistedPreferences(content)
      this.snapshot = parsed.snapshot
      this.diagnostic = parsed.diagnostic
    } catch (error: unknown) {
      this.snapshot = createDefaultSnapshot()
      this.diagnostic = isFileNotFoundError(error)
        ? null
        : createDiagnostic(
            'SETTINGS_STORAGE_READ_FAILED',
            '读取偏好设置',
            getErrorMessage(error)
          )
    }

    return copyDiagnostic(this.diagnostic)
  }

  get(): PreferencesSnapshot {
    return copySnapshot(this.snapshot)
  }

  getDiagnostic(): SettingsDiagnostic | null {
    return copyDiagnostic(this.diagnostic)
  }

  async save(input: SavePreferencesInput): Promise<PreferencesSnapshot> {
    const nextSnapshot = validateSaveInput(input)
    await this.persist(nextSnapshot, '保存偏好设置')
    this.snapshot = nextSnapshot
    this.diagnostic = null
    return this.get()
  }

  async reset(): Promise<PreferencesSnapshot> {
    const nextSnapshot = createDefaultSnapshot()
    await this.persist(nextSnapshot, '重置偏好设置')
    this.snapshot = nextSnapshot
    this.diagnostic = null
    return this.get()
  }

  async deleteConnectionPreferences(connectionIdInput: string): Promise<PreferencesSnapshot> {
    const connectionId = normalizeConnectionId(connectionIdInput)
    if (!Object.hasOwn(this.snapshot.connections, connectionId)) return this.get()

    const nextConnections = Object.fromEntries(
      Object.entries(this.snapshot.connections).filter(([storedConnectionId]) =>
        storedConnectionId !== connectionId
      )
    )
    const nextSnapshot: PreferencesSnapshot = {
      version: PREFERENCES_VERSION,
      global: copyGlobalPreferences(this.snapshot.global),
      connections: nextConnections
    }

    await this.persist(nextSnapshot, `删除连接偏好 connectionId=${connectionId}`)
    this.snapshot = nextSnapshot
    this.diagnostic = null
    return this.get()
  }

  private async persist(snapshot: PreferencesSnapshot, operation: string): Promise<void> {
    const temporaryPath = `${this.storagePath}.tmp`

    // 先完整写入同目录临时文件，再原子替换目标文件；替换失败时保留旧快照和旧文件。
    try {
      await mkdir(dirname(this.storagePath), { recursive: true })
      await writeFile(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600
      })
      await rename(temporaryPath, this.storagePath)
    } catch (error: unknown) {
      throw new SettingsServiceError(
        'SETTINGS_STORAGE_WRITE_FAILED',
        operation,
        getErrorMessage(error),
        { cause: error }
      )
    }
  }
}

function parsePersistedPreferences(content: string): ParsedPreferences {
  try {
    const parsed = JSON.parse(content) as unknown
    if (!isRecord(parsed)) throw new Error('偏好文件根节点必须是对象')
    if (parsed.version !== PREFERENCES_VERSION) {
      throw new Error(`不支持的偏好版本：${String(parsed.version)}`)
    }

    // v1 读取允许字段缺失时回退默认值；类型或范围损坏则保留其他有效字段并返回诊断。
    const issues: string[] = []
    const snapshot: PreferencesSnapshot = {
      version: PREFERENCES_VERSION,
      global: readGlobalPreferences(parsed.global, issues),
      connections: readConnectionPreferencesRecord(parsed.connections, issues)
    }
    return {
      snapshot,
      diagnostic: issues.length > 0
        ? createDiagnostic(
            'SETTINGS_STORAGE_INVALID',
            '解析偏好设置',
            '部分字段无效，已使用安全默认值',
            issues
          )
        : null
    }
  } catch (error: unknown) {
    const reason = getErrorMessage(error)
    return {
      snapshot: createDefaultSnapshot(),
      diagnostic: createDiagnostic(
        'SETTINGS_STORAGE_INVALID',
        '解析偏好设置',
        reason,
        [reason]
      )
    }
  }
}

function validateSaveInput(input: SavePreferencesInput): PreferencesSnapshot {
  if (!isRecord(input)) {
    throw createValidationError(['保存内容必须是对象'])
  }

  const issues: string[] = []
  const global = validateGlobalPreferences(input.global, issues)
  const connections = validateConnectionPreferencesRecord(input.connections, issues)
  if (issues.length > 0) throw createValidationError(issues)

  return { version: PREFERENCES_VERSION, global, connections }
}

function validateGlobalPreferences(value: unknown, issues: string[]): GlobalPreferences {
  if (!isRecord(value)) {
    issues.push('global 必须是对象')
    return createDefaultGlobalPreferences()
  }

  const theme = readRequiredEnum(value.theme, THEMES, 'global.theme', issues, 'light')
  const unlockedEasterEggThemes = readRequiredUnlockedEasterEggThemes(
    value.unlockedEasterEggThemes,
    issues
  )
  if (isEasterEggTheme(theme) && !unlockedEasterEggThemes.includes(theme)) {
    issues.push(`global.theme=${theme} 对应的彩蛋主题尚未解锁`)
  }

  return {
    theme,
    unlockedEasterEggThemes,
    language: readRequiredEnum(value.language, LANGUAGES, 'global.language', issues, 'zh-CN'),
    fontFamily: readRequiredFontFamily(value.fontFamily, issues),
    fontSize: readRequiredInteger(
      value.fontSize,
      MIN_FONT_SIZE,
      MAX_FONT_SIZE,
      'global.fontSize',
      issues,
      DEFAULT_GLOBAL_PREFERENCES.fontSize
    ),
    density: readRequiredEnum(value.density, DENSITIES, 'global.density', issues, 'standard'),
    workspaceRestoreEnabled: readRequiredBoolean(
      value.workspaceRestoreEnabled,
      'global.workspaceRestoreEnabled',
      issues,
      DEFAULT_GLOBAL_PREFERENCES.workspaceRestoreEnabled
    ),
    homepageUrl: readRequiredHomepageUrl(
      value.homepageUrl,
      'global.homepageUrl',
      issues
    ),
    blogUrl: readRequiredHomepageUrl(
      value.blogUrl,
      'global.blogUrl',
      issues,
      DEFAULT_GLOBAL_PREFERENCES.blogUrl
    ),
    atlasAdminBaseUrl: readRequiredRemoteUrl(
      value.atlasAdminBaseUrl,
      'global.atlasAdminBaseUrl',
      issues,
      true
    ),
    updateManifestUrl: readRequiredRemoteUrl(
      value.updateManifestUrl,
      'global.updateManifestUrl',
      issues,
      false
    )
  }
}

function readGlobalPreferences(value: unknown, issues: string[]): GlobalPreferences {
  if (value === undefined) return createDefaultGlobalPreferences()
  if (!isRecord(value)) {
    issues.push('global 必须是对象')
    return createDefaultGlobalPreferences()
  }

  const unlockedEasterEggThemes = readOptionalUnlockedEasterEggThemes(
    value.unlockedEasterEggThemes,
    issues
  )
  const requestedTheme = readOptionalEnum(value.theme, THEMES, 'global.theme', issues, 'light')
  const theme = isEasterEggTheme(requestedTheme) && !unlockedEasterEggThemes.includes(requestedTheme)
    ? 'light'
    : requestedTheme

  return {
    theme,
    unlockedEasterEggThemes,
    language: readOptionalEnum(value.language, LANGUAGES, 'global.language', issues, 'zh-CN'),
    fontFamily: readOptionalFontFamily(value.fontFamily, issues),
    fontSize: readOptionalInteger(
      value.fontSize,
      MIN_FONT_SIZE,
      MAX_FONT_SIZE,
      'global.fontSize',
      issues,
      DEFAULT_GLOBAL_PREFERENCES.fontSize
    ),
    density: readOptionalEnum(value.density, DENSITIES, 'global.density', issues, 'standard'),
    workspaceRestoreEnabled: readOptionalBoolean(
      value.workspaceRestoreEnabled,
      'global.workspaceRestoreEnabled',
      issues,
      DEFAULT_GLOBAL_PREFERENCES.workspaceRestoreEnabled
    ),
    homepageUrl: readOptionalProductHomepageUrl(value.homepageUrl, 'global.homepageUrl', issues),
    blogUrl: readOptionalBlogUrl(
      value.blogUrl,
      'global.blogUrl',
      issues,
      DEFAULT_GLOBAL_PREFERENCES.blogUrl
    ),
    atlasAdminBaseUrl: readOptionalAtlasAdminBaseUrl(
      value.atlasAdminBaseUrl,
      'global.atlasAdminBaseUrl',
      issues,
      DEFAULT_GLOBAL_PREFERENCES.atlasAdminBaseUrl
    ),
    updateManifestUrl: readOptionalRemoteUrl(
      value.updateManifestUrl,
      'global.updateManifestUrl',
      issues,
      false
    )
  }
}

function validateConnectionPreferencesRecord(
  value: unknown,
  issues: string[]
): Record<string, ConnectionPreferences> {
  if (!isRecord(value)) {
    issues.push('connections 必须是对象')
    return {}
  }

  const entries: Array<[string, ConnectionPreferences]> = []
  for (const [connectionIdInput, preferences] of Object.entries(value)) {
    const connectionId = validateConnectionId(connectionIdInput, issues)
    if (!connectionId) continue
    entries.push([
      connectionId,
      validateConnectionPreferences(preferences, connectionId, issues)
    ])
  }
  return Object.fromEntries(entries)
}

function readConnectionPreferencesRecord(
  value: unknown,
  issues: string[]
): Record<string, ConnectionPreferences> {
  if (value === undefined) return {}
  if (!isRecord(value)) {
    issues.push('connections 必须是对象')
    return {}
  }

  const entries: Array<[string, ConnectionPreferences]> = []
  for (const [connectionIdInput, preferences] of Object.entries(value)) {
    const connectionId = validateConnectionId(connectionIdInput, issues)
    if (!connectionId) continue
    entries.push([connectionId, readConnectionPreferences(preferences, connectionId, issues)])
  }
  return Object.fromEntries(entries)
}

function validateConnectionPreferences(
  value: unknown,
  connectionId: string,
  issues: string[]
): ConnectionPreferences {
  if (!isRecord(value)) {
    issues.push(`connections.${connectionId} 必须是对象`)
    return createDefaultConnectionPreferences()
  }

  return {
    autoRefreshEnabled: readRequiredBoolean(
      value.autoRefreshEnabled,
      `connections.${connectionId}.autoRefreshEnabled`,
      issues,
      DEFAULT_CONNECTION_PREFERENCES.autoRefreshEnabled
    ),
    refreshIntervalSeconds: readRequiredInteger(
      value.refreshIntervalSeconds,
      MIN_REFRESH_INTERVAL_SECONDS,
      MAX_REFRESH_INTERVAL_SECONDS,
      `connections.${connectionId}.refreshIntervalSeconds`,
      issues,
      DEFAULT_CONNECTION_PREFERENCES.refreshIntervalSeconds
    ),
    defaultQuerySize: readRequiredInteger(
      value.defaultQuerySize,
      MIN_DEFAULT_QUERY_SIZE,
      MAX_DEFAULT_QUERY_SIZE,
      `connections.${connectionId}.defaultQuerySize`,
      issues,
      DEFAULT_CONNECTION_PREFERENCES.defaultQuerySize
    )
  }
}

function readConnectionPreferences(
  value: unknown,
  connectionId: string,
  issues: string[]
): ConnectionPreferences {
  if (!isRecord(value)) {
    issues.push(`connections.${connectionId} 必须是对象`)
    return createDefaultConnectionPreferences()
  }

  return {
    autoRefreshEnabled: readOptionalBoolean(
      value.autoRefreshEnabled,
      `connections.${connectionId}.autoRefreshEnabled`,
      issues,
      DEFAULT_CONNECTION_PREFERENCES.autoRefreshEnabled
    ),
    refreshIntervalSeconds: readOptionalInteger(
      value.refreshIntervalSeconds,
      MIN_REFRESH_INTERVAL_SECONDS,
      MAX_REFRESH_INTERVAL_SECONDS,
      `connections.${connectionId}.refreshIntervalSeconds`,
      issues,
      DEFAULT_CONNECTION_PREFERENCES.refreshIntervalSeconds
    ),
    defaultQuerySize: readOptionalInteger(
      value.defaultQuerySize,
      MIN_DEFAULT_QUERY_SIZE,
      MAX_DEFAULT_QUERY_SIZE,
      `connections.${connectionId}.defaultQuerySize`,
      issues,
      DEFAULT_CONNECTION_PREFERENCES.defaultQuerySize
    )
  }
}

function readRequiredFontFamily(value: unknown, issues: string[]): string {
  const fontFamily = readFontFamily(value)
  if (fontFamily) return fontFamily
  issues.push(`global.fontFamily 必须是 1-${MAX_FONT_FAMILY_LENGTH} 个字符且不能包含控制字符`)
  return DEFAULT_GLOBAL_PREFERENCES.fontFamily
}

function readOptionalFontFamily(value: unknown, issues: string[]): string {
  if (value === undefined) return DEFAULT_GLOBAL_PREFERENCES.fontFamily
  return readRequiredFontFamily(value, issues)
}

function readFontFamily(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const fontFamily = value.trim()
  if (!fontFamily || fontFamily.length > MAX_FONT_FAMILY_LENGTH || /[\u0000-\u001f\u007f]/.test(fontFamily)) {
    return null
  }
  return fontFamily
}

function readRequiredRemoteUrl(
  value: unknown,
  field: string,
  issues: string[],
  allowLoopbackHttp: boolean
): string {
  if (value === '') return ''
  if (typeof value !== 'string' || value !== value.trim() || value.length > MAX_REMOTE_URL_LENGTH) {
    issues.push(`${field} 必须为空或不超过 ${MAX_REMOTE_URL_LENGTH} 个字符的绝对 URL`)
    return ''
  }

  try {
    const url = new URL(value)
    const isAllowedHttp = url.protocol === 'http:' && isLoopbackHost(url.hostname)
    if (
      !url.hostname ||
      url.username ||
      url.password ||
      url.hash ||
      (url.protocol !== 'https:' && (!allowLoopbackHttp || !isAllowedHttp))
    ) {
      throw new Error('URL 安全约束不满足')
    }
    if (allowLoopbackHttp && (url.search || url.hash)) {
      throw new Error('Atlas Admin 地址不能包含 query 或 fragment')
    }
    return value
  } catch {
    const protocolHint = allowLoopbackHttp
      ? 'HTTPS URL，或本机回环 HTTP 地址'
      : '无凭据、无 fragment 的 HTTPS URL'
    issues.push(`${field} 必须是${protocolHint}`)
    return ''
  }
}

function readOptionalRemoteUrl(
  value: unknown,
  field: string,
  issues: string[],
  allowLoopbackHttp: boolean,
  fallback = ''
): string {
  return value === undefined
    ? fallback
    : readRequiredRemoteUrl(value, field, issues, allowLoopbackHttp)
}

function readOptionalAtlasAdminBaseUrl(
  value: unknown,
  field: string,
  issues: string[],
  fallback: string
): string {
  // 仅迁移旧官方默认地址，用户配置的其他 HTTPS 服务保持原值。
  if (value === 'http://127.0.0.1:20808' || value === 'http://111.231.115.181/prod-api') return fallback
  return readOptionalRemoteUrl(value, field, issues, true, fallback)
}

function readRequiredHomepageUrl(
  value: unknown,
  field: string,
  issues: string[],
  fallback = DEFAULT_GLOBAL_PREFERENCES.homepageUrl
): string {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || !value.trim()) {
    issues.push(`${field} 必须是 HTTP(S) URL`)
    return fallback
  }
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
      throw new Error('URL 安全约束不满足')
    }
    return value
  } catch {
    issues.push(`${field} 必须是无凭据、无 fragment 的 HTTP(S) URL`)
    return fallback
  }
}

function readOptionalHomepageUrl(
  value: unknown,
  field: string,
  issues: string[],
  fallback = DEFAULT_GLOBAL_PREFERENCES.homepageUrl
): string {
  return value === undefined
    ? fallback
    : readRequiredHomepageUrl(value, field, issues, fallback)
}

function readOptionalProductHomepageUrl(value: unknown, field: string, issues: string[]): string {
  if (
    value === 'http://www.ideaatlas.online/' ||
    value === 'http://www.ideaatlas.online/esAtlas' ||
    value === 'http://111.231.115.181/esAtlas'
  ) {
    return DEFAULT_GLOBAL_PREFERENCES.homepageUrl
  }
  return readOptionalHomepageUrl(value, field, issues)
}

function readOptionalBlogUrl(
  value: unknown,
  field: string,
  issues: string[],
  fallback: string
): string {
  if (value === 'http://www.ideaatlas.online/' || value === 'http://111.231.115.181/') return fallback
  return readOptionalHomepageUrl(value, field, issues, fallback)
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}

function readRequiredBoolean(
  value: unknown,
  field: string,
  issues: string[],
  fallback: boolean
): boolean {
  if (typeof value === 'boolean') return value
  issues.push(`${field} 必须是 boolean`)
  return fallback
}

function readOptionalBoolean(
  value: unknown,
  field: string,
  issues: string[],
  fallback: boolean
): boolean {
  return value === undefined ? fallback : readRequiredBoolean(value, field, issues, fallback)
}

function readRequiredInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  field: string,
  issues: string[],
  fallback: number
): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum) {
    return value
  }
  issues.push(`${field} 必须是 ${minimum}-${maximum} 范围内的整数`)
  return fallback
}

function readOptionalInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  field: string,
  issues: string[],
  fallback: number
): number {
  return value === undefined
    ? fallback
    : readRequiredInteger(value, minimum, maximum, field, issues, fallback)
}

function readRequiredEnum<T extends string>(
  value: unknown,
  allowedValues: ReadonlySet<T>,
  field: string,
  issues: string[],
  fallback: T
): T {
  if (typeof value === 'string' && allowedValues.has(value as T)) return value as T
  issues.push(`${field} 的值无效`)
  return fallback
}

function readOptionalEnum<T extends string>(
  value: unknown,
  allowedValues: ReadonlySet<T>,
  field: string,
  issues: string[],
  fallback: T
): T {
  return value === undefined
    ? fallback
    : readRequiredEnum(value, allowedValues, field, issues, fallback)
}

function readRequiredUnlockedEasterEggThemes(
  value: unknown,
  issues: string[]
): EasterEggTheme[] {
  if (!Array.isArray(value)) {
    issues.push('global.unlockedEasterEggThemes 必须是数组')
    return []
  }

  const themes: EasterEggTheme[] = []
  for (const item of value) {
    if (typeof item !== 'string' || !EASTER_EGG_THEMES.has(item as EasterEggTheme)) {
      issues.push('global.unlockedEasterEggThemes 包含无效主题')
      continue
    }
    const theme = item as EasterEggTheme
    if (!themes.includes(theme)) themes.push(theme)
  }
  return themes
}

function readOptionalUnlockedEasterEggThemes(
  value: unknown,
  issues: string[]
): EasterEggTheme[] {
  return value === undefined ? [] : readRequiredUnlockedEasterEggThemes(value, issues)
}

function isEasterEggTheme(theme: AppTheme): theme is EasterEggTheme {
  return EASTER_EGG_THEMES.has(theme as EasterEggTheme)
}

function validateConnectionId(value: string, issues: string[]): string | null {
  try {
    return normalizeConnectionId(value)
  } catch (error: unknown) {
    issues.push(getErrorMessage(error))
    return null
  }
}

function normalizeConnectionId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new SettingsServiceError(
      'SETTINGS_INVALID_CONNECTION_ID',
      '校验连接偏好',
      'connectionId 不能为空'
    )
  }
  const connectionId = value.trim()
  if (connectionId !== value || connectionId.length > MAX_CONNECTION_ID_LENGTH || RESERVED_CONNECTION_IDS.has(connectionId)) {
    throw new SettingsServiceError(
      'SETTINGS_INVALID_CONNECTION_ID',
      '校验连接偏好',
      `connectionId=${connectionId} 格式无效`
    )
  }
  return connectionId
}

function createValidationError(issues: string[]): SettingsServiceError {
  return new SettingsServiceError(
    'SETTINGS_VALIDATION_FAILED',
    '校验偏好设置',
    issues.join('；')
  )
}

function createDefaultSnapshot(): PreferencesSnapshot {
  return {
    version: PREFERENCES_VERSION,
    global: createDefaultGlobalPreferences(),
    connections: {}
  }
}

function createDefaultGlobalPreferences(): GlobalPreferences {
  return {
    ...DEFAULT_GLOBAL_PREFERENCES,
    unlockedEasterEggThemes: [...DEFAULT_GLOBAL_PREFERENCES.unlockedEasterEggThemes]
  }
}

function createDefaultConnectionPreferences(): ConnectionPreferences {
  return { ...DEFAULT_CONNECTION_PREFERENCES }
}

function copySnapshot(snapshot: PreferencesSnapshot): PreferencesSnapshot {
  return {
    version: PREFERENCES_VERSION,
    global: copyGlobalPreferences(snapshot.global),
    connections: Object.fromEntries(
      Object.entries(snapshot.connections).map(([connectionId, preferences]) => [
        connectionId,
        { ...preferences }
      ])
    )
  }
}

function copyGlobalPreferences(preferences: GlobalPreferences): GlobalPreferences {
  return {
    ...preferences,
    unlockedEasterEggThemes: [...preferences.unlockedEasterEggThemes]
  }
}

function createDiagnostic(
  code: SettingsDiagnostic['code'],
  operation: SettingsDiagnostic['operation'],
  reason: string,
  issues: string[] = []
): SettingsDiagnostic {
  return { code, operation, reason, issues: [...issues] }
}

function copyDiagnostic(diagnostic: SettingsDiagnostic | null): SettingsDiagnostic | null {
  return diagnostic ? { ...diagnostic, issues: [...diagnostic.issues] } : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFileNotFoundError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
