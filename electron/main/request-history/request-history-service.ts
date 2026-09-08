import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { DatabaseSync, type SQLInputValue, type SQLOutputValue, type StatementSync } from 'node:sqlite'
import type {
  RequestCategory,
  RequestHistoryConnectionOption,
  RequestHistoryPage,
  RequestHistoryQuery,
  RequestHistoryRecord,
  RequestMetricsSnapshot,
  RequestSource,
  RequestTrendBucket
} from '../../../src/shared/types/request-history'
// Node 内置 TypeScript 测试器需要显式扩展名，Electron Vite 同样可以解析该源文件。
// @ts-expect-error TypeScript 测试运行时直接加载 .ts 源文件
import { redactText, redactUrl } from '../log/log-redactor.ts'

export type RecordRequestInput = {
  connectionId: string
  connectionName: string
  startedAtMs: number
  method: RequestHistoryRecord['method']
  path: string
  successful: boolean
  statusCode: number | null
  errorCode: string | null
  durationMs: number
  source?: RequestSource
}

type RequestHistoryRow = Record<string, SQLOutputValue>

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000
const METRIC_WINDOW_SECONDS = 60
const METRIC_WINDOW_MS = METRIC_WINDOW_SECONDS * 1000
const TREND_BUCKET_COUNT = 10
const TREND_BUCKET_MS = METRIC_WINDOW_MS / TREND_BUCKET_COUNT
const MAX_PAGE_SIZE = 100
const SEARCH_PATH_PATTERN = /\/(?:_search|_msearch|_count|_async_search|_sql)(?:\/|\?|$)|\/_eql\/search(?:\/|\?|$)/

export class RequestHistoryServiceError extends Error {
  constructor(operation: string, reason: string, options?: ErrorOptions) {
    super(`请求历史模块失败：操作=${operation}，原因=${reason}`, options)
    this.name = 'RequestHistoryServiceError'
  }
}

export class RequestHistoryService {
  private readonly storagePath: string
  private database: DatabaseSync | null = null
  private insertPathStatement: StatementSync | null = null
  private insertRecordStatement: StatementSync | null = null
  private lastCleanupAtMs = 0

  constructor(storagePath: string) {
    this.storagePath = storagePath
  }

  async initialize(): Promise<void> {
    try {
      await mkdir(dirname(this.storagePath), { recursive: true })
      const database = new DatabaseSync(this.storagePath)
      this.database = database
      database.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS request_paths (
          id INTEGER PRIMARY KEY,
          path TEXT NOT NULL UNIQUE
        );
        CREATE TABLE IF NOT EXISTS request_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          connection_id TEXT NOT NULL,
          connection_name TEXT NOT NULL,
          started_at TEXT NOT NULL,
          method TEXT NOT NULL,
          path_id INTEGER NOT NULL,
          category TEXT NOT NULL,
          source TEXT NOT NULL,
          successful INTEGER NOT NULL,
          status_code INTEGER,
          error_code TEXT,
          duration_ms INTEGER NOT NULL,
          FOREIGN KEY (path_id) REFERENCES request_paths(id)
        );
        CREATE INDEX IF NOT EXISTS idx_request_history_started_at
          ON request_history(started_at DESC);
        CREATE INDEX IF NOT EXISTS idx_request_history_connection_started_at
          ON request_history(connection_id, started_at DESC);
        PRAGMA user_version = 1;
      `)
      this.insertPathStatement = database.prepare(
        'INSERT INTO request_paths(path) VALUES (?) ON CONFLICT(path) DO NOTHING'
      )
      this.insertRecordStatement = database.prepare(`
        INSERT INTO request_history(
          connection_id, connection_name, started_at, method, path_id, category, source,
          successful, status_code, error_code, duration_ms
        ) VALUES (?, ?, ?, ?, (SELECT id FROM request_paths WHERE path = ?), ?, ?, ?, ?, ?, ?)
      `)
      this.cleanupExpiredRecords(Date.now())
    } catch (error: unknown) {
      this.close()
      throw new RequestHistoryServiceError('初始化历史数据库', getErrorMessage(error), { cause: error })
    }
  }

  async record(input: RecordRequestInput): Promise<void> {
    try {
      const database = this.getDatabase()
      const insertPathStatement = this.insertPathStatement
      const insertRecordStatement = this.insertRecordStatement
      if (!insertPathStatement || !insertRecordStatement) {
        throw new Error('请求历史写入语句未初始化')
      }
      const category = classifyRequest(input.method, input.path)
      const source = input.source ?? classifySource(input.path)
      // 历史库与日志库共享同一脱敏边界，不让 URL 查询凭据或敏感连接名落盘。
      const safePath = redactUrl(input.path).value
      const safeConnectionName = redactText(input.connectionName).value
      insertPathStatement.run(safePath)
      insertRecordStatement.run(
        input.connectionId,
        safeConnectionName,
        new Date(input.startedAtMs).toISOString(),
        input.method,
        safePath,
        category,
        source,
        input.successful ? 1 : 0,
        input.statusCode,
        input.errorCode,
        Math.max(0, Math.round(input.durationMs))
      )
      if (Date.now() - this.lastCleanupAtMs >= CLEANUP_INTERVAL_MS) {
        this.cleanupExpiredRecords(Date.now(), database)
      }
    } catch (error: unknown) {
      if (error instanceof RequestHistoryServiceError) throw error
      throw new RequestHistoryServiceError('记录请求', getErrorMessage(error), { cause: error })
    }
  }

  getRecent(connectionId: string, limit = 10): RequestHistoryRecord[] {
    try {
      const rows = this.getDatabase().prepare(`
        SELECT history.*, paths.path
        FROM request_history history
        JOIN request_paths paths ON paths.id = history.path_id
        WHERE history.connection_id = ?
        ORDER BY history.started_at DESC, history.id DESC
        LIMIT ?
      `).all(connectionId, Math.max(0, limit))
      return rows.map(parseHistoryRow)
    } catch (error: unknown) {
      throw new RequestHistoryServiceError('查询最近请求', getErrorMessage(error), { cause: error })
    }
  }

  getMetrics(connectionId: string, nowMs = Date.now()): RequestMetricsSnapshot {
    try {
      const windowStartMs = nowMs - METRIC_WINDOW_MS
      const rows = this.getDatabase().prepare(`
        SELECT history.*, paths.path
        FROM request_history history
        JOIN request_paths paths ON paths.id = history.path_id
        WHERE history.connection_id = ? AND history.started_at >= ?
        ORDER BY history.started_at DESC, history.id DESC
      `).all(connectionId, new Date(windowStartMs).toISOString())
      const records = rows.map(parseHistoryRow)
      const searchRecords = records.filter((record) => record.category === 'search')
      const writeRecords = records.filter((record) => record.category === 'write')
      const failedCount = records.filter((record) => !record.successful).length

      return {
        windowSeconds: METRIC_WINDOW_SECONDS,
        searchQps: calculateQps(searchRecords.length),
        writeQps: calculateQps(writeRecords.length),
        searchP95Ms: calculateP95(searchRecords.map((record) => record.durationMs)),
        errorRate: records.length > 0
          ? roundToTwoDecimals((failedCount / records.length) * 100)
          : null,
        trend: buildTrend(records, windowStartMs)
      }
    } catch (error: unknown) {
      throw new RequestHistoryServiceError('聚合请求指标', getErrorMessage(error), { cause: error })
    }
  }

  list(query: RequestHistoryQuery): RequestHistoryPage {
    try {
      const database = this.getDatabase()
      const connectionId = normalizeOptionalConnectionId(query?.connectionId)
      const startedAtMs = normalizeOptionalDate(query?.startedAt, '开始时间')
      const endedAtMs = normalizeOptionalDate(query?.endedAt, '结束时间')
      if (startedAtMs !== null && endedAtMs !== null && startedAtMs > endedAtMs) {
        throw new RequestHistoryServiceError('查询历史', '开始时间不能晚于结束时间')
      }
      const page = normalizePositiveInteger(query?.page, 1)
      const pageSize = Math.min(normalizePositiveInteger(query?.pageSize, 20), MAX_PAGE_SIZE)
      const conditions: string[] = []
      const parameters: SQLInputValue[] = []
      if (connectionId) {
        conditions.push('history.connection_id = ?')
        parameters.push(connectionId)
      }
      if (startedAtMs !== null) {
        conditions.push('history.started_at >= ?')
        parameters.push(new Date(startedAtMs).toISOString())
      }
      if (endedAtMs !== null) {
        conditions.push('history.started_at <= ?')
        parameters.push(new Date(endedAtMs).toISOString())
      }
      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
      const countRow = database.prepare(`
        SELECT COUNT(*) AS total
        FROM request_history history
        ${whereClause}
      `).get(...parameters)
      const offset = (page - 1) * pageSize
      const rows = database.prepare(`
        SELECT history.*, paths.path
        FROM request_history history
        JOIN request_paths paths ON paths.id = history.path_id
        ${whereClause}
        ORDER BY history.started_at DESC, history.id DESC
        LIMIT ? OFFSET ?
      `).all(...parameters, pageSize, offset)

      return {
        records: rows.map(parseHistoryRow),
        total: readNumber(countRow?.total, '历史总数'),
        page,
        pageSize,
        connections: this.listConnectionOptions(database)
      }
    } catch (error: unknown) {
      if (error instanceof RequestHistoryServiceError) throw error
      throw new RequestHistoryServiceError('分页查询历史', getErrorMessage(error), { cause: error })
    }
  }

  close(): void {
    this.insertPathStatement = null
    this.insertRecordStatement = null
    this.database?.close()
    this.database = null
  }

  private cleanupExpiredRecords(nowMs: number, database = this.getDatabase()): void {
    const cutoff = new Date(nowMs - RETENTION_MS).toISOString()
    database.prepare('DELETE FROM request_history WHERE started_at < ?').run(cutoff)
    database.exec(`
      DELETE FROM request_paths
      WHERE NOT EXISTS (
        SELECT 1 FROM request_history WHERE request_history.path_id = request_paths.id
      );
    `)
    this.lastCleanupAtMs = nowMs
  }

  private listConnectionOptions(database: DatabaseSync): RequestHistoryConnectionOption[] {
    const rows = database.prepare(`
      SELECT connection_id, connection_name
      FROM (
        SELECT
          connection_id,
          connection_name,
          ROW_NUMBER() OVER (
            PARTITION BY connection_id
            ORDER BY started_at DESC, id DESC
          ) AS row_number
        FROM request_history
      )
      WHERE row_number = 1
      ORDER BY connection_name COLLATE NOCASE
    `).all()
    return rows.map((row) => ({
      id: readString(row.connection_id, '连接 ID'),
      name: readString(row.connection_name, '连接名称')
    }))
  }

  private getDatabase(): DatabaseSync {
    if (!this.database) {
      throw new RequestHistoryServiceError('访问历史数据库', '数据库未初始化')
    }
    return this.database
  }
}

function classifyRequest(
  method: RequestHistoryRecord['method'],
  path: string
): RequestCategory {
  if (SEARCH_PATH_PATTERN.test(path)) return 'search'
  return method === 'GET' ? 'other' : 'write'
}

function classifySource(path: string): RequestSource {
  if (path === '/' || path.startsWith('/_cluster/') || path.startsWith('/_nodes/')) {
    return 'overview'
  }
  if (path !== '/') return 'index'
  return 'other'
}

function calculateQps(requestCount: number): number | null {
  return requestCount > 0 ? roundToTwoDecimals(requestCount / METRIC_WINDOW_SECONDS) : null
}

function calculateP95(durations: number[]): number | null {
  if (durations.length === 0) return null
  const sortedDurations = [...durations].sort((left, right) => left - right)
  const index = Math.max(0, Math.ceil(sortedDurations.length * 0.95) - 1)
  return sortedDurations[index]
}

function buildTrend(records: RequestHistoryRecord[], windowStartMs: number): RequestTrendBucket[] {
  const buckets: RequestTrendBucket[] = Array.from({ length: TREND_BUCKET_COUNT }, (_, index) => ({
    startedAt: new Date(windowStartMs + index * TREND_BUCKET_MS).toISOString(),
    searchCount: 0,
    writeCount: 0
  }))
  for (const record of records) {
    const bucketIndex = Math.min(
      TREND_BUCKET_COUNT - 1,
      Math.max(0, Math.floor((Date.parse(record.startedAt) - windowStartMs) / TREND_BUCKET_MS))
    )
    if (record.category === 'search') buckets[bucketIndex].searchCount += 1
    if (record.category === 'write') buckets[bucketIndex].writeCount += 1
  }
  return buckets
}

function parseHistoryRow(row: RequestHistoryRow): RequestHistoryRecord {
  const method = readString(row.method, '请求方法')
  const category = readString(row.category, '请求分类')
  const source = readString(row.source, '请求来源')
  if (method !== 'GET' && method !== 'POST' && method !== 'PUT' && method !== 'DELETE') {
    throw new RequestHistoryServiceError('解析历史记录', `请求方法无效：${method}`)
  }
  if (category !== 'search' && category !== 'write' && category !== 'other') {
    throw new RequestHistoryServiceError('解析历史记录', `请求分类无效：${category}`)
  }
  if (source !== 'overview' && source !== 'index' && source !== 'connection' && source !== 'other') {
    throw new RequestHistoryServiceError('解析历史记录', `请求来源无效：${source}`)
  }
  return {
    id: String(readNumber(row.id, '记录 ID')),
    connectionId: readString(row.connection_id, '连接 ID'),
    connectionName: readString(row.connection_name, '连接名称'),
    startedAt: readString(row.started_at, '请求时间'),
    method,
    path: readString(row.path, '请求路径'),
    category,
    source,
    successful: readNumber(row.successful, '请求结果') === 1,
    statusCode: readNullableNumber(row.status_code, 'HTTP 状态码'),
    errorCode: readNullableString(row.error_code, '错误码'),
    durationMs: readNumber(row.duration_ms, '请求耗时')
  }
}

function normalizeOptionalConnectionId(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback
}

function normalizeOptionalDate(value: unknown, fieldName: string): number | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new RequestHistoryServiceError('校验查询条件', `${fieldName}格式无效`)
  }
  return Date.parse(value)
}

function readString(value: SQLOutputValue | undefined, fieldName: string): string {
  if (typeof value !== 'string') {
    throw new RequestHistoryServiceError('解析历史记录', `${fieldName}不是字符串`)
  }
  return value
}

function readNullableString(value: SQLOutputValue | undefined, fieldName: string): string | null {
  if (value === null) return null
  return readString(value, fieldName)
}

function readNumber(value: SQLOutputValue | undefined, fieldName: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new RequestHistoryServiceError('解析历史记录', `${fieldName}不是有限数值`)
  }
  return value
}

function readNullableNumber(value: SQLOutputValue | undefined, fieldName: string): number | null {
  if (value === null) return null
  return readNumber(value, fieldName)
}

function roundToTwoDecimals(value: number): number {
  return Math.round(value * 100) / 100
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : '未知错误'
}
