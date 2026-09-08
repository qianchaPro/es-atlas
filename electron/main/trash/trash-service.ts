import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from 'node:sqlite'
import type {
  TrashIndexSnapshot,
  TrashListInput,
  TrashListResult,
  TrashRecord,
  TrashRecordKind,
  TrashRecordOperation,
  TrashRecordSummary
} from '../../../src/shared/types/trash'

type TrashRow = Record<string, SQLOutputValue>

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000
const MAX_PAGE_SIZE = 100

export class TrashServiceError extends Error {
  constructor(operation: string, reason: string, options?: ErrorOptions) {
    super(`废纸篓模块失败：操作=${operation}，原因=${reason}`, options)
    this.name = 'TrashServiceError'
  }
}

export type RecordIndexTrashInput = {
  connectionId: string
  connectionName: string
  index: string
  snapshot: TrashIndexSnapshot
}

export type RecordDocumentTrashInput = {
  connectionId: string
  connectionName: string
  index: string
  documentId: string
  operation: TrashRecordOperation
  beforeSource: Record<string, unknown>
}

export class TrashService {
  private database: DatabaseSync | null = null
  private lastCleanupAtMs = 0
  private readonly storagePath: string

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
        CREATE TABLE IF NOT EXISTS trash_records (
          id TEXT PRIMARY KEY,
          connection_id TEXT NOT NULL,
          connection_name TEXT NOT NULL,
          kind TEXT NOT NULL CHECK(kind IN ('index', 'document')),
          operation TEXT NOT NULL CHECK(operation IN ('delete', 'update')),
          index_name TEXT NOT NULL,
          document_id TEXT,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          index_snapshot TEXT,
          before_source TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_trash_records_created_at
          ON trash_records(created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_trash_records_connection_created_at
          ON trash_records(connection_id, created_at DESC);
      `)
      this.cleanupExpiredRecords(Date.now())
    } catch (error: unknown) {
      this.close()
      throw new TrashServiceError('初始化废纸篓数据库', getErrorMessage(error), { cause: error })
    }
  }

  recordIndex(input: RecordIndexTrashInput): string {
    return this.insertRecord({
      connectionId: input.connectionId,
      connectionName: input.connectionName,
      kind: 'index',
      operation: 'delete',
      index: input.index,
      documentId: null,
      indexSnapshot: input.snapshot,
      beforeSource: null
    })
  }

  recordDocument(input: RecordDocumentTrashInput): string {
    return this.insertRecord({
      connectionId: input.connectionId,
      connectionName: input.connectionName,
      kind: 'document',
      operation: input.operation,
      index: input.index,
      documentId: input.documentId,
      indexSnapshot: null,
      beforeSource: input.beforeSource
    })
  }

  list(input: TrashListInput = {}): TrashListResult {
    try {
      const database = this.getDatabase()
      this.cleanupExpiredRecords(Date.now(), database)
      const connectionId = normalizeOptionalString(input.connectionId)
      const page = normalizePositiveInteger(input.page, 1)
      const pageSize = Math.min(normalizePositiveInteger(input.pageSize, 20), MAX_PAGE_SIZE)
      const conditions: string[] = []
      const parameters: SQLInputValue[] = []
      if (connectionId) {
        conditions.push('connection_id = ?')
        parameters.push(connectionId)
      }
      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
      const count = database.prepare(`SELECT COUNT(*) AS total FROM trash_records ${whereClause}`).get(...parameters)
      const rows = database.prepare(`
        SELECT id, connection_id, connection_name, kind, operation, index_name, document_id,
               created_at, expires_at
        FROM trash_records
        ${whereClause}
        ORDER BY created_at DESC, id DESC
        LIMIT ? OFFSET ?
      `).all(...parameters, pageSize, (page - 1) * pageSize)
      return {
        records: rows.map(parseSummaryRow),
        total: readNumber(count?.total, '废纸篓总数'),
        page,
        pageSize
      }
    } catch (error: unknown) {
      if (error instanceof TrashServiceError) throw error
      throw new TrashServiceError('查询废纸篓', getErrorMessage(error), { cause: error })
    }
  }

  get(idInput: string): TrashRecord {
    const id = normalizeId(idInput)
    try {
      const row = this.getDatabase().prepare(`
        SELECT id, connection_id, connection_name, kind, operation, index_name, document_id,
               created_at, expires_at, index_snapshot, before_source
        FROM trash_records
        WHERE id = ?
      `).get(id)
      if (!row) throw new TrashServiceError('读取废纸篓记录', `找不到记录：id=${id}`)
      return parseRecordRow(row)
    } catch (error: unknown) {
      if (error instanceof TrashServiceError) throw error
      throw new TrashServiceError('读取废纸篓记录', getErrorMessage(error), { cause: error })
    }
  }

  remove(idInput: string): void {
    const id = normalizeId(idInput)
    try {
      const result = this.getDatabase().prepare('DELETE FROM trash_records WHERE id = ?').run(id)
      if (Number(result.changes) === 0) {
        throw new TrashServiceError('删除废纸篓记录', `找不到记录：id=${id}`)
      }
    } catch (error: unknown) {
      if (error instanceof TrashServiceError) throw error
      throw new TrashServiceError('删除废纸篓记录', getErrorMessage(error), { cause: error })
    }
  }

  close(): void {
    this.database?.close()
    this.database = null
  }

  private insertRecord(input: Omit<RecordIndexTrashInput, 'snapshot'> & {
    kind: TrashRecordKind
    operation: TrashRecordOperation
    documentId: string | null
    indexSnapshot: TrashIndexSnapshot | null
    beforeSource: Record<string, unknown> | null
  }): string {
    try {
      const id = randomUUID()
      const createdAt = new Date().toISOString()
      const expiresAt = new Date(Date.now() + RETENTION_MS).toISOString()
      this.getDatabase().prepare(`
        INSERT INTO trash_records(
          id, connection_id, connection_name, kind, operation, index_name, document_id,
          created_at, expires_at, index_snapshot, before_source
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        input.connectionId,
        input.connectionName,
        input.kind,
        input.operation,
        input.index,
        input.documentId,
        createdAt,
        expiresAt,
        input.indexSnapshot ? JSON.stringify(input.indexSnapshot) : null,
        input.beforeSource ? JSON.stringify(input.beforeSource) : null
      )
      return id
    } catch (error: unknown) {
      throw new TrashServiceError('写入废纸篓记录', getErrorMessage(error), { cause: error })
    }
  }

  private cleanupExpiredRecords(nowMs: number, database = this.getDatabase()): void {
    if (nowMs - this.lastCleanupAtMs < CLEANUP_INTERVAL_MS) return
    database.prepare('DELETE FROM trash_records WHERE expires_at <= ?').run(new Date(nowMs).toISOString())
    this.lastCleanupAtMs = nowMs
  }

  private getDatabase(): DatabaseSync {
    if (!this.database) throw new TrashServiceError('访问废纸篓数据库', '数据库尚未初始化')
    return this.database
  }
}

function parseSummaryRow(row: TrashRow): TrashRecordSummary {
  return {
    id: readString(row.id, '记录 ID'),
    connectionId: readString(row.connection_id, '连接 ID'),
    connectionName: readString(row.connection_name, '连接名称'),
    kind: readEnum(row.kind, ['index', 'document'], '记录类型'),
    operation: readEnum(row.operation, ['delete', 'update'], '操作类型'),
    index: readString(row.index_name, '索引名称'),
    documentId: readOptionalString(row.document_id),
    createdAt: readString(row.created_at, '创建时间'),
    expiresAt: readString(row.expires_at, '过期时间')
  }
}

function parseRecordRow(row: TrashRow): TrashRecord {
  const summary = parseSummaryRow(row)
  return {
    ...summary,
    indexSnapshot: parseJsonValue(row.index_snapshot, '索引快照') as TrashIndexSnapshot | null,
    beforeSource: parseJsonValue(row.before_source, '文档快照') as Record<string, unknown> | null
  }
}

function normalizeId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 128) {
    throw new TrashServiceError('校验废纸篓记录', 'id 必须是非空字符串且不超过 128 位')
  }
  return value.trim()
}

function normalizeOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback
}

function readString(value: SQLOutputValue | undefined, field: string): string {
  if (typeof value !== 'string' || !value) throw new TrashServiceError('解析废纸篓记录', `${field} 不是有效字符串`)
  return value
}

function readOptionalString(value: SQLOutputValue | undefined): string | null {
  return typeof value === 'string' && value ? value : null
}

function readNumber(value: SQLOutputValue | undefined, field: string): number {
  const result = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(result)) throw new TrashServiceError('解析废纸篓记录', `${field} 不是有效数字`)
  return result
}

function readEnum<T extends string>(value: SQLOutputValue | undefined, values: readonly T[], field: string): T {
  if (typeof value === 'string' && values.includes(value as T)) return value as T
  throw new TrashServiceError('解析废纸篓记录', `${field} 值无效`)
}

function parseJsonValue(value: SQLOutputValue | undefined, field: string): unknown {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') throw new TrashServiceError('解析废纸篓记录', `${field} 不是 JSON 字符串`)
  try {
    return JSON.parse(value)
  } catch (error: unknown) {
    throw new TrashServiceError('解析废纸篓记录', `${field} JSON 损坏`, { cause: error })
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error)
}
