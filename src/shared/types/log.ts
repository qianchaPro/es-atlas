export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export type LogSortOrder = 'asc' | 'desc'
export type LogExportFormat = 'csv' | 'json'

export type AppLog = {
  id: string
  createdAt: string
  connectionId: string | null
  connectionName: string | null
  level: LogLevel
  operation: string
  method: string | null
  path: string | null
  statusCode: number | null
  durationMs: number | null
  traceId: string
  message: string
  errorSummary: string | null
  redacted: boolean
}

export type AppLogInput = {
  createdAt?: string | number
  connectionId?: string | null
  connectionName?: string | null
  level: LogLevel
  operation: string
  method?: string | null
  path?: string | null
  statusCode?: number | null
  durationMs?: number | null
  traceId: string
  message: string
  error?: unknown
}

export type LogConnectionOption = {
  id: string
  name: string
}

export type LogFilter = {
  connectionId?: string | null
  level?: LogLevel | null
  startedAt?: string | null
  endedAt?: string | null
  keyword?: string | null
  statusCode?: number | null
  minimumDurationMs?: number | null
  operation?: string | null
}

export type LogQueryInput = LogFilter & {
  page?: number
  pageSize?: number
  sortOrder?: LogSortOrder
}

export type LogPage = {
  records: AppLog[]
  total: number
  page: number
  pageSize: number
  connections: LogConnectionOption[]
}

export type LogClearResult = {
  deleted: number
}

export type LogRetentionPolicy = {
  maxAgeDays: number
  maxRecords: number
}

export type LogRetentionResult = {
  policy: LogRetentionPolicy
  deletedByAge: number
  deletedByCount: number
  totalDeleted: number
  remaining: number
}

export type LogExportData = {
  format: LogExportFormat
  fileName: string
  mimeType: string
  content: string
  recordCount: number
}

export type LogExportResult = {
  canceled: boolean
  filePath: string | null
  recordCount: number
}

export type LogApi = {
  query: (input: LogQueryInput) => Promise<LogPage>
  clear: (filter: LogFilter) => Promise<LogClearResult>
  export: (filter: LogFilter, format: LogExportFormat) => Promise<LogExportResult>
  updateRetention: (policy: LogRetentionPolicy) => Promise<LogRetentionResult>
}
