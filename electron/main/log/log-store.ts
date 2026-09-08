import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { DatabaseSync, type SQLInputValue, type SQLOutputValue, type StatementSync } from 'node:sqlite'
import type {
  AppLog,
  AppLogInput,
  LogClearResult,
  LogConnectionOption,
  LogExportData,
  LogExportFormat,
  LogFilter,
  LogLevel,
  LogPage,
  LogQueryInput,
  LogRetentionPolicy,
  LogRetentionResult,
  LogSortOrder
} from '../../../src/shared/types/log'
// Node 内置 TypeScript 测试器需要显式扩展名，Electron Vite 同样可以解析该源文件。
// @ts-expect-error TypeScript 测试运行时直接加载 .ts 源文件
import { redactError, redactText, redactUrl } from './log-redactor.ts'

type LogRow = Record<string, SQLOutputValue>

export type LogStoreOptions = {
  now?: () => number
  onFallbackError?: (error: LogStoreError) => void
}

type NormalizedLogFilter = {
  connectionId: string | null
  level: LogLevel | null
  startedAt: string | null
  endedAt: string | null
  keyword: string | null
  statusCode: number | null
  minimumDurationMs: number | null
  operation: string | null
}

type SqlFilter = {
  whereClause: string
  parameters: SQLInputValue[]
}

const DEFAULT_RETENTION_POLICY: LogRetentionPolicy = {
  maxAgeDays: 30,
  maxRecords: 100_000
}
const CLEANUP_INTERVAL_MS = 60 * 60 * 1_000
const MAX_PAGE_SIZE = 100
const MAX_RETENTION_DAYS = 3_650
const MAX_RETENTION_RECORDS = 1_000_000
const MAX_OPERATION_LENGTH = 128
const MAX_METHOD_LENGTH = 16
const MAX_PATH_LENGTH = 4_096
const MAX_TRACE_ID_LENGTH = 128
const MAX_MESSAGE_LENGTH = 4_096
const MAX_ERROR_LENGTH = 8_192

export class LogStoreError extends Error {
  constructor(operation: string, reason: string, options?: ErrorOptions) {
    super(`日志模块失败：操作=${operation}，原因=${reason}`, options)
    this.name = 'LogStoreError'
  }
}

export class LogStore {
  private readonly storagePath: string
  private database: DatabaseSync | null = null
  private insertStatement: StatementSync | null = null
  private lastCleanupAtMs = 0
  private readonly now: () => number
  private readonly onFallbackError: (error: LogStoreError) => void

  constructor(
    storagePath: string,
    options: LogStoreOptions = {}
  ) {
    this.storagePath = storagePath
    this.now = options.now ?? Date.now
    this.onFallbackError = options.onFallbackError ?? defaultFallbackErrorHandler
  }

  async initialize(): Promise<void> {
    try {
      if (this.storagePath !== ':memory:') {
        await mkdir(dirname(this.storagePath), { recursive: true })
      }
      const database = new DatabaseSync(this.storagePath)
      this.database = database
      database.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        CREATE TABLE IF NOT EXISTS app_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          created_at TEXT NOT NULL,
          connection_id TEXT,
          connection_name TEXT,
          level TEXT NOT NULL CHECK(level IN ('debug', 'info', 'warn', 'error')),
          operation TEXT NOT NULL,
          method TEXT,
          path TEXT,
          status_code INTEGER,
          duration_ms INTEGER,
          trace_id TEXT NOT NULL,
          message TEXT NOT NULL,
          error_summary TEXT,
          redacted INTEGER NOT NULL CHECK(redacted IN (0, 1))
        );
        CREATE INDEX IF NOT EXISTS idx_app_logs_created_at
          ON app_logs(created_at DESC, id DESC);
        CREATE INDEX IF NOT EXISTS idx_app_logs_connection_created_at
          ON app_logs(connection_id, created_at DESC, id DESC);
        CREATE INDEX IF NOT EXISTS idx_app_logs_level_created_at
          ON app_logs(level, created_at DESC, id DESC);
        CREATE INDEX IF NOT EXISTS idx_app_logs_status_code
          ON app_logs(status_code);
        CREATE INDEX IF NOT EXISTS idx_app_logs_operation
          ON app_logs(operation);
        CREATE TABLE IF NOT EXISTS app_log_settings (
          id INTEGER PRIMARY KEY CHECK(id = 1),
          max_age_days INTEGER NOT NULL,
          max_records INTEGER NOT NULL
        );
        INSERT INTO app_log_settings(id, max_age_days, max_records)
        VALUES (1, ${DEFAULT_RETENTION_POLICY.maxAgeDays}, ${DEFAULT_RETENTION_POLICY.maxRecords})
        ON CONFLICT(id) DO NOTHING;
      `)
      this.insertStatement = database.prepare(`
        INSERT INTO app_logs(
          created_at, connection_id, connection_name, level, operation, method, path,
          status_code, duration_ms, trace_id, message, error_summary, redacted
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      this.enforceRetention(this.now())
    } catch (error: unknown) {
      this.close()
      throw toLogStoreError('初始化日志库', error)
    }
  }

  record(input: AppLogInput): AppLog | null {
    try {
      const database = this.getDatabase()
      const statement = this.insertStatement
      if (!statement) throw new Error('日志写入语句未初始化')
      const log = normalizeLogInput(input, this.now())
      const result = statement.run(
        log.createdAt,
        log.connectionId,
        log.connectionName,
        log.level,
        log.operation,
        log.method,
        log.path,
        log.statusCode,
        log.durationMs,
        log.traceId,
        log.message,
        log.errorSummary,
        log.redacted ? 1 : 0
      )
      const storedLog = { ...log, id: String(result.lastInsertRowid) }
      const nowMs = this.now()
      if (nowMs - this.lastCleanupAtMs >= CLEANUP_INTERVAL_MS) {
        this.enforceRetention(nowMs, database)
      }
      return storedLog
    } catch (error: unknown) {
      this.reportFallbackError(toLogStoreError('写入日志', error))
      return null
    }
  }

  query(input: LogQueryInput): LogPage {
    try {
      const database = this.getDatabase()
      const filter = normalizeFilter(input)
      const page = normalizePositiveInteger(input?.page, 1, '页码')
      const pageSize = Math.min(
        normalizePositiveInteger(input?.pageSize, 20, '每页条数'),
        MAX_PAGE_SIZE
      )
      const sortOrder = normalizeSortOrder(input?.sortOrder)
      const sqlFilter = buildSqlFilter(filter)
      const countRow = database.prepare(`
        SELECT COUNT(*) AS total
        FROM app_logs logs
        ${sqlFilter.whereClause}
      `).get(...sqlFilter.parameters)
      const rows = database.prepare(`
        SELECT logs.*
        FROM app_logs logs
        ${sqlFilter.whereClause}
        ORDER BY logs.created_at ${sortOrder.toUpperCase()}, logs.id ${sortOrder.toUpperCase()}
        LIMIT ? OFFSET ?
      `).all(...sqlFilter.parameters, pageSize, (page - 1) * pageSize)

      return {
        records: rows.map(parseLogRow),
        total: readNumber(countRow?.total, '日志总数'),
        page,
        pageSize,
        connections: this.listConnectionOptions(database)
      }
    } catch (error: unknown) {
      if (error instanceof LogStoreError) throw error
      throw toLogStoreError('分页查询日志', error)
    }
  }

  clear(input: LogFilter): LogClearResult {
    try {
      const filter = normalizeFilter(input)
      const sqlFilter = buildSqlFilter(filter)
      const result = this.getDatabase().prepare(`
        DELETE FROM app_logs AS logs
        ${sqlFilter.whereClause}
      `).run(...sqlFilter.parameters)
      return { deleted: toSafeNumber(result.changes, '清空日志条数') }
    } catch (error: unknown) {
      if (error instanceof LogStoreError) throw error
      throw toLogStoreError('按筛选条件清空日志', error)
    }
  }

  exportData(input: LogFilter, format: LogExportFormat, nowMs = this.now()): LogExportData {
    try {
      const normalizedFormat = normalizeExportFormat(format)
      const filter = normalizeFilter(input)
      const sqlFilter = buildSqlFilter(filter)
      const records = this.getDatabase().prepare(`
        SELECT logs.*
        FROM app_logs logs
        ${sqlFilter.whereClause}
        ORDER BY logs.created_at DESC, logs.id DESC
      `).all(...sqlFilter.parameters).map(parseLogRow)
      const dateStamp = new Date(nowMs).toISOString().replaceAll(':', '-').replace(/\.\d{3}Z$/u, 'Z')

      return {
        format: normalizedFormat,
        fileName: `es-atlas-logs-${dateStamp}.${normalizedFormat}`,
        mimeType: normalizedFormat === 'json' ? 'application/json' : 'text/csv; charset=utf-8',
        content: normalizedFormat === 'json' ? `${JSON.stringify(records, null, 2)}\n` : toCsv(records),
        recordCount: records.length
      }
    } catch (error: unknown) {
      if (error instanceof LogStoreError) throw error
      throw toLogStoreError('导出脱敏日志数据', error)
    }
  }

  getRetentionPolicy(): LogRetentionPolicy {
    try {
      const row = this.getDatabase().prepare(`
        SELECT max_age_days, max_records
        FROM app_log_settings
        WHERE id = 1
      `).get()
      return {
        maxAgeDays: readNumber(row?.max_age_days, '日志保留天数'),
        maxRecords: readNumber(row?.max_records, '日志保留条数')
      }
    } catch (error: unknown) {
      if (error instanceof LogStoreError) throw error
      throw toLogStoreError('读取日志保留策略', error)
    }
  }

  updateRetention(policy: LogRetentionPolicy, nowMs = this.now()): LogRetentionResult {
    try {
      const normalizedPolicy = normalizeRetentionPolicy(policy)
      this.getDatabase().prepare(`
        INSERT INTO app_log_settings(id, max_age_days, max_records)
        VALUES (1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          max_age_days = excluded.max_age_days,
          max_records = excluded.max_records
      `).run(normalizedPolicy.maxAgeDays, normalizedPolicy.maxRecords)
      return this.enforceRetention(nowMs)
    } catch (error: unknown) {
      if (error instanceof LogStoreError) throw error
      throw toLogStoreError('更新日志保留策略', error)
    }
  }

  enforceRetention(nowMs = this.now(), database = this.getDatabase()): LogRetentionResult {
    const policy = this.getRetentionPolicy()
    const cutoff = new Date(nowMs - policy.maxAgeDays * 24 * 60 * 60 * 1_000).toISOString()
    database.exec('BEGIN IMMEDIATE')
    try {
      const ageResult = database.prepare('DELETE FROM app_logs WHERE created_at < ?').run(cutoff)
      const countResult = database.prepare(`
        DELETE FROM app_logs
        WHERE id IN (
          SELECT id
          FROM app_logs
          ORDER BY created_at DESC, id DESC
          LIMIT -1 OFFSET ?
        )
      `).run(policy.maxRecords)
      const remainingRow = database.prepare('SELECT COUNT(*) AS total FROM app_logs').get()
      database.exec('COMMIT')
      const deletedByAge = toSafeNumber(ageResult.changes, '过期删除条数')
      const deletedByCount = toSafeNumber(countResult.changes, '超量删除条数')
      this.lastCleanupAtMs = nowMs
      return {
        policy,
        deletedByAge,
        deletedByCount,
        totalDeleted: deletedByAge + deletedByCount,
        remaining: readNumber(remainingRow?.total, '保留后日志条数')
      }
    } catch (error: unknown) {
      let rollbackFailure: string | null = null
      try {
        database.exec('ROLLBACK')
      } catch (rollbackError: unknown) {
        rollbackFailure = getErrorMessage(rollbackError)
      }
      if (error instanceof LogStoreError) throw error
      const reason = rollbackFailure === null
        ? getErrorMessage(error)
        : `${getErrorMessage(error)}；回滚失败=${rollbackFailure}`
      throw new LogStoreError('执行日志保留策略', reason, { cause: error })
    }
  }

  close(): void {
    this.insertStatement = null
    this.database?.close()
    this.database = null
  }

  private listConnectionOptions(database: DatabaseSync): LogConnectionOption[] {
    const rows = database.prepare(`
      SELECT connection_id, connection_name
      FROM (
        SELECT
          connection_id,
          COALESCE(connection_name, connection_id) AS connection_name,
          ROW_NUMBER() OVER (
            PARTITION BY connection_id
            ORDER BY created_at DESC, id DESC
          ) AS row_number
        FROM app_logs
        WHERE connection_id IS NOT NULL
      )
      WHERE row_number = 1
      ORDER BY connection_name COLLATE NOCASE, connection_id
    `).all()
    return rows.map((row) => ({
      id: readString(row.connection_id, '连接 ID'),
      name: readString(row.connection_name, '连接名称')
    }))
  }

  private getDatabase(): DatabaseSync {
    if (!this.database) throw new LogStoreError('访问日志库', '数据库未初始化')
    return this.database
  }

  private reportFallbackError(error: LogStoreError): void {
    try {
      this.onFallbackError(error)
    } catch (fallbackError: unknown) {
      defaultFallbackErrorHandler(
        new LogStoreError('备用错误通道', getErrorMessage(fallbackError), { cause: error })
      )
    }
  }
}

function normalizeLogInput(input: AppLogInput, nowMs: number): Omit<AppLog, 'id'> {
  if (!input || typeof input !== 'object') {
    throw new LogStoreError('校验日志', '日志输入必须是对象')
  }
  const level = normalizeLevel(input.level)
  const createdAt = normalizeCreatedAt(input.createdAt, nowMs)
  const connectionId = normalizeOptionalText(input.connectionId, 256, '连接 ID')
  const connectionNameResult = redactOptionalText(input.connectionName, 256, '连接名称')
  const operationResult = redactRequiredText(input.operation, MAX_OPERATION_LENGTH, '操作类型')
  const method = normalizeMethod(input.method)
  const pathResult = redactOptionalUrl(input.path)
  const statusCode = normalizeStatusCode(input.statusCode)
  const durationMs = normalizeDuration(input.durationMs)
  const traceIdResult = redactRequiredText(input.traceId, MAX_TRACE_ID_LENGTH, '追踪 ID')
  const messageResult = redactRequiredText(input.message, MAX_MESSAGE_LENGTH, '日志摘要')
  const errorResult = redactOptionalError(input.error)

  return {
    createdAt,
    connectionId,
    connectionName: connectionNameResult.value,
    level,
    operation: operationResult.value,
    method,
    path: pathResult.value,
    statusCode,
    durationMs,
    traceId: traceIdResult.value,
    message: messageResult.value,
    errorSummary: errorResult.value,
    redacted:
      connectionNameResult.redacted ||
      operationResult.redacted ||
      pathResult.redacted ||
      traceIdResult.redacted ||
      messageResult.redacted ||
      errorResult.redacted
  }
}

function normalizeFilter(input: LogFilter | null | undefined): NormalizedLogFilter {
  const filter = input ?? {}
  const startedAt = normalizeOptionalFilterDate(filter.startedAt, '开始时间')
  const endedAt = normalizeOptionalFilterDate(filter.endedAt, '结束时间')
  if (startedAt !== null && endedAt !== null && startedAt > endedAt) {
    throw new LogStoreError('校验日志筛选', '开始时间不能晚于结束时间')
  }
  return {
    connectionId: normalizeOptionalText(filter.connectionId, 256, '连接 ID'),
    level: filter.level === null || filter.level === undefined ? null : normalizeLevel(filter.level),
    startedAt: startedAt === null ? null : new Date(startedAt).toISOString(),
    endedAt: endedAt === null ? null : new Date(endedAt).toISOString(),
    keyword: normalizeOptionalText(filter.keyword, 256, '关键字'),
    statusCode: normalizeStatusCode(filter.statusCode),
    minimumDurationMs: normalizeDuration(filter.minimumDurationMs),
    operation: normalizeOptionalText(filter.operation, MAX_OPERATION_LENGTH, '操作类型')
  }
}

function buildSqlFilter(filter: NormalizedLogFilter): SqlFilter {
  const conditions: string[] = []
  const parameters: SQLInputValue[] = []
  if (filter.connectionId !== null) {
    conditions.push('logs.connection_id = ?')
    parameters.push(filter.connectionId)
  }
  if (filter.level !== null) {
    conditions.push('logs.level = ?')
    parameters.push(filter.level)
  }
  if (filter.startedAt !== null) {
    conditions.push('logs.created_at >= ?')
    parameters.push(filter.startedAt)
  }
  if (filter.endedAt !== null) {
    conditions.push('logs.created_at <= ?')
    parameters.push(filter.endedAt)
  }
  if (filter.keyword !== null) {
    const keyword = `%${filter.keyword}%`
    conditions.push(`(
      logs.operation LIKE ? OR
      logs.trace_id LIKE ? OR
      logs.message LIKE ? OR
      COALESCE(logs.path, '') LIKE ? OR
      COALESCE(logs.error_summary, '') LIKE ?
    )`)
    parameters.push(keyword, keyword, keyword, keyword, keyword)
  }
  if (filter.statusCode !== null) {
    conditions.push('logs.status_code = ?')
    parameters.push(filter.statusCode)
  }
  if (filter.minimumDurationMs !== null) {
    conditions.push('logs.duration_ms >= ?')
    parameters.push(filter.minimumDurationMs)
  }
  if (filter.operation !== null) {
    conditions.push('logs.operation = ?')
    parameters.push(filter.operation)
  }
  return {
    whereClause: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
    parameters
  }
}

function parseLogRow(row: LogRow): AppLog {
  return {
    id: String(readNumber(row.id, '日志 ID')),
    createdAt: readString(row.created_at, '创建时间'),
    connectionId: readNullableString(row.connection_id, '连接 ID'),
    connectionName: readNullableString(row.connection_name, '连接名称'),
    level: normalizeLevel(readString(row.level, '日志级别')),
    operation: readString(row.operation, '操作类型'),
    method: readNullableString(row.method, '请求方法'),
    path: readNullableString(row.path, '请求路径'),
    statusCode: readNullableNumber(row.status_code, '状态码'),
    durationMs: readNullableNumber(row.duration_ms, '耗时'),
    traceId: readString(row.trace_id, '追踪 ID'),
    message: readString(row.message, '日志摘要'),
    errorSummary: readNullableString(row.error_summary, '错误摘要'),
    redacted: readBoolean(row.redacted, '脱敏标记')
  }
}

function normalizeRetentionPolicy(policy: LogRetentionPolicy): LogRetentionPolicy {
  if (!policy || typeof policy !== 'object') {
    throw new LogStoreError('校验保留策略', '保留策略必须是对象')
  }
  return {
    maxAgeDays: normalizeBoundedInteger(policy.maxAgeDays, 1, MAX_RETENTION_DAYS, '保留天数'),
    maxRecords: normalizeBoundedInteger(policy.maxRecords, 1, MAX_RETENTION_RECORDS, '保留条数')
  }
}

function normalizeLevel(value: unknown): LogLevel {
  if (value === 'debug' || value === 'info' || value === 'warn' || value === 'error') return value
  throw new LogStoreError('校验日志级别', '日志级别必须是 debug/info/warn/error')
}

function normalizeCreatedAt(value: unknown, fallbackMs: number): string {
  const timestamp = value === null || value === undefined ? fallbackMs : value
  if (
    (typeof timestamp !== 'string' && typeof timestamp !== 'number') ||
    !Number.isFinite(typeof timestamp === 'number' ? timestamp : Date.parse(timestamp))
  ) {
    throw new LogStoreError('校验日志时间', '日志时间必须是有效日期字符串或毫秒时间戳')
  }
  return new Date(timestamp).toISOString()
}

function normalizeMethod(value: unknown): string | null {
  const method = normalizeOptionalText(value, MAX_METHOD_LENGTH, '请求方法')?.toUpperCase() ?? null
  if (method !== null && !/^[A-Z]+$/u.test(method)) {
    throw new LogStoreError('校验请求方法', '请求方法只能包含英文字母')
  }
  return method
}

function normalizeStatusCode(value: unknown): number | null {
  if (value === null || value === undefined) return null
  return normalizeBoundedInteger(value, 100, 599, 'HTTP 状态码')
}

function normalizeDuration(value: unknown): number | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new LogStoreError('校验请求耗时', `耗时必须是非负有限数：${String(value)}`)
  }
  return Math.round(value)
}

function normalizeSortOrder(value: unknown): LogSortOrder {
  if (value === null || value === undefined) return 'desc'
  if (value === 'asc' || value === 'desc') return value
  throw new LogStoreError('校验排序', '排序方向必须是 asc 或 desc')
}

function normalizeExportFormat(value: unknown): LogExportFormat {
  if (value === 'csv' || value === 'json') return value
  throw new LogStoreError('校验导出格式', '导出格式必须是 csv 或 json')
}

function normalizeOptionalFilterDate(value: unknown, fieldName: string): number | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new LogStoreError('校验日志筛选', `${fieldName}格式无效`)
  }
  return Date.parse(value)
}

function normalizeRequiredText(value: unknown, maxLength: number, fieldName: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new LogStoreError('校验日志', `${fieldName}必须是非空字符串`)
  }
  return value.trim().slice(0, maxLength)
}

function normalizeOptionalText(value: unknown, maxLength: number, fieldName: string): string | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string') {
    throw new LogStoreError('校验日志', `${fieldName}必须是字符串`)
  }
  const normalized = value.trim()
  return normalized ? normalized.slice(0, maxLength) : null
}

function redactRequiredText(
  value: unknown,
  maxLength: number,
  fieldName: string
): { value: string; redacted: boolean } {
  const normalized = normalizeRequiredText(value, Number.MAX_SAFE_INTEGER, fieldName)
  const result = redactText(normalized)
  return {
    value: result.value.slice(0, maxLength),
    redacted: result.redacted || result.value.length > maxLength
  }
}

function redactOptionalText(
  value: unknown,
  maxLength: number,
  fieldName: string
): { value: string | null; redacted: boolean } {
  const normalized = normalizeOptionalText(value, Number.MAX_SAFE_INTEGER, fieldName)
  if (normalized === null) return { value: null, redacted: false }
  const result = redactText(normalized)
  return {
    value: result.value.slice(0, maxLength),
    redacted: result.redacted || result.value.length > maxLength
  }
}

function redactOptionalUrl(value: unknown): { value: string | null; redacted: boolean } {
  const normalized = normalizeOptionalText(value, Number.MAX_SAFE_INTEGER, '请求路径')
  if (normalized === null) return { value: null, redacted: false }
  const result = redactUrl(normalized)
  return {
    value: result.value.slice(0, MAX_PATH_LENGTH),
    redacted: result.redacted || result.value.length > MAX_PATH_LENGTH
  }
}

function redactOptionalError(value: unknown): { value: string | null; redacted: boolean } {
  if (value === null || value === undefined) return { value: null, redacted: false }
  const result = redactError(value)
  return {
    value: result.value.slice(0, MAX_ERROR_LENGTH),
    redacted: result.redacted || result.value.length > MAX_ERROR_LENGTH
  }
}

function normalizePositiveInteger(value: unknown, fallback: number, fieldName: string): number {
  if (value === null || value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new LogStoreError('校验日志查询', `${fieldName}必须是正整数`)
  }
  return value
}

function normalizeBoundedInteger(value: unknown, minimum: number, maximum: number, fieldName: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new LogStoreError(
      '校验数值',
      `${fieldName}必须是 ${minimum}-${maximum} 之间的安全整数`
    )
  }
  return value
}

function readString(value: SQLOutputValue | undefined, fieldName: string): string {
  if (typeof value !== 'string') {
    throw new LogStoreError('解析日志', `${fieldName}不是字符串`)
  }
  return value
}

function readNullableString(value: SQLOutputValue | undefined, fieldName: string): string | null {
  return value === null ? null : readString(value, fieldName)
}

function readNumber(value: SQLOutputValue | undefined, fieldName: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new LogStoreError('解析日志', `${fieldName}不是有限数值`)
  }
  return value
}

function readNullableNumber(value: SQLOutputValue | undefined, fieldName: string): number | null {
  return value === null ? null : readNumber(value, fieldName)
}

function readBoolean(value: SQLOutputValue | undefined, fieldName: string): boolean {
  const numberValue = readNumber(value, fieldName)
  if (numberValue !== 0 && numberValue !== 1) {
    throw new LogStoreError('解析日志', `${fieldName}不是布尔值`)
  }
  return numberValue === 1
}

function toSafeNumber(value: number | bigint, fieldName: string): number {
  const numberValue = Number(value)
  if (!Number.isSafeInteger(numberValue) || numberValue < 0) {
    throw new LogStoreError('解析数据库结果', `${fieldName}超出安全整数范围`)
  }
  return numberValue
}

function toCsv(records: AppLog[]): string {
  const columns: Array<keyof AppLog> = [
    'id',
    'createdAt',
    'connectionId',
    'connectionName',
    'level',
    'operation',
    'method',
    'path',
    'statusCode',
    'durationMs',
    'traceId',
    'message',
    'errorSummary',
    'redacted'
  ]
  const lines = [columns.join(',')]
  for (const record of records) {
    lines.push(columns.map((column) => csvCell(record[column])).join(','))
  }
  return `${lines.join('\n')}\n`
}

function csvCell(value: AppLog[keyof AppLog]): string {
  if (value === null) return ''
  let text = String(value)
  if (/^[=+\-@\t\r]/u.test(text)) text = `'${text}`
  return `"${text.replaceAll('"', '""')}"`
}

function toLogStoreError(operation: string, error: unknown): LogStoreError {
  return error instanceof LogStoreError
    ? error
    : new LogStoreError(operation, getErrorMessage(error), { cause: error })
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : '未知错误'
}

function defaultFallbackErrorHandler(error: LogStoreError): void {
  process.stderr.write(`${error.name}: ${error.message}\n`)
}
