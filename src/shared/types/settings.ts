export const PREFERENCES_VERSION = 1 as const
export const MIN_FONT_SIZE = 12
export const MAX_FONT_SIZE = 18
export const MIN_REFRESH_INTERVAL_SECONDS = 5
export const MAX_REFRESH_INTERVAL_SECONDS = 3_600
export const MIN_DEFAULT_QUERY_SIZE = 1
export const MAX_DEFAULT_QUERY_SIZE = 1_000

export type AppTheme = 'light' | 'dark' | 'starlight' | 'pixel'
export type EasterEggTheme = Extract<AppTheme, 'starlight' | 'pixel'>
export type AppLanguage = 'zh-CN' | 'en-US'
export type InterfaceDensity = 'compact' | 'standard' | 'comfortable'

export type GlobalPreferences = {
  theme: AppTheme
  unlockedEasterEggThemes: EasterEggTheme[]
  language: AppLanguage
  fontFamily: string
  fontSize: number
  density: InterfaceDensity
  workspaceRestoreEnabled: boolean
  homepageUrl: string
  blogUrl: string
  atlasAdminBaseUrl: string
  updateManifestUrl: string
}

export type ConnectionPreferences = {
  autoRefreshEnabled: boolean
  refreshIntervalSeconds: number
  defaultQuerySize: number
}

export const DEFAULT_GLOBAL_PREFERENCES: Readonly<GlobalPreferences> = Object.freeze({
  theme: 'light',
  unlockedEasterEggThemes: [],
  language: 'zh-CN',
  fontFamily: '"Avenir Next", "PingFang SC", "Microsoft YaHei", sans-serif',
  fontSize: 13,
  density: 'standard',
  workspaceRestoreEnabled: true,
  homepageUrl: 'https://ideaatlas.online/esAtlas',
  blogUrl: 'https://ideaatlas.online/',
  atlasAdminBaseUrl: 'https://ideaatlas.online/prod-api',
  updateManifestUrl: ''
})

export const DEFAULT_CONNECTION_PREFERENCES: Readonly<ConnectionPreferences> = Object.freeze({
  autoRefreshEnabled: true,
  refreshIntervalSeconds: MIN_REFRESH_INTERVAL_SECONDS,
  defaultQuerySize: 10
})

export type PreferencesSnapshot = {
  version: typeof PREFERENCES_VERSION
  global: GlobalPreferences
  connections: Record<string, ConnectionPreferences>
}

export type SavePreferencesInput = {
  global: GlobalPreferences
  connections: Record<string, ConnectionPreferences>
}

export type SettingsDiagnostic = {
  code: 'SETTINGS_STORAGE_READ_FAILED' | 'SETTINGS_STORAGE_INVALID'
  operation: '读取偏好设置' | '解析偏好设置'
  reason: string
  issues: string[]
}

export type SettingsApi = {
  get: () => Promise<PreferencesSnapshot>
  getDiagnostic: () => Promise<SettingsDiagnostic | null>
  save: (input: SavePreferencesInput) => Promise<PreferencesSnapshot>
  reset: () => Promise<PreferencesSnapshot>
}
