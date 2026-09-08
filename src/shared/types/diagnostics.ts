export type LocalDiagnosticInput = {
  applicationVersion: string
  platform: string
  error: unknown
  traceId?: string | null
}

export type LocalDiagnosticSummary = {
  applicationVersion: string
  platform: string
  errorCode: string
  traceId: string | null
}

export type LocalDiagnosticRequest = {
  errorCode?: string | null
  traceId?: string | null
}

export type UpdateCheckInput = {
  enabled?: boolean
  currentVersion: string
  manifestUrl?: string
  atlasAdminBaseUrl?: string
  platform?: string
  architecture?: string
}

export type UpdateCheckStatus = 'disabled' | 'up-to-date' | 'available'

export type UpdateCheckResult = {
  status: UpdateCheckStatus
  currentVersion: string
  latestVersion: string | null
  releaseNotesUrl: string | null
  downloadUrl?: string | null
  fileName?: string | null
  releaseNotes?: string | null
  checksumSha256?: string | null
}

export type UpdateCheckRequest = {
  manifestUrl?: string
  atlasAdminBaseUrl?: string
}

export type DesktopConfigurationRequest = {
  atlasAdminBaseUrl: string
}

export type DesktopConfigurationResult = {
  sourceUrl: string
  configuration: Record<string, unknown>
}

export type DiagnosticsApi = {
  createLocalSummary: (input: LocalDiagnosticRequest) => Promise<LocalDiagnosticSummary>
  checkForUpdates: (input: UpdateCheckRequest) => Promise<UpdateCheckResult>
  loadDesktopConfiguration: (
    input: DesktopConfigurationRequest
  ) => Promise<DesktopConfigurationResult>
}

export type DiagnosticsErrorCode =
  | 'INVALID_DIAGNOSTIC_INPUT'
  | 'INVALID_CURRENT_VERSION'
  | 'INVALID_MANIFEST_URL'
  | 'INVALID_ATLAS_ADMIN_URL'
  | 'INVALID_DESKTOP_CONFIGURATION'
  | 'INVALID_MANIFEST'
  | 'RESPONSE_TOO_LARGE'
  | 'TIMEOUT'
  | 'HTTP_ERROR'
  | 'NETWORK_ERROR'
