import type {
  IndexAlias,
  IndexBulkImportInput,
  IndexBulkImportItem,
  IndexBulkImportResult,
  IndexBulkOperation,
  IndexCommitDocumentChangesInput,
  IndexCommitDocumentChangesResult,
  IndexCreateInput,
  IndexCreateResult,
  IndexCreateDocumentInput,
  IndexDeleteDocumentInput,
  IndexDocument,
  IndexDocumentChange,
  IndexDocumentChangeResult,
  IndexDocumentExport,
  IndexDocumentMutationResult,
  IndexDeleteInput,
  IndexDeleteResult,
  IndexDocumentsInput,
  IndexDocumentsPage,
  IndexExportDocumentsInput,
  IndexHealth,
  IndexListCompatibility,
  IndexListResult,
  IndexListWarning,
  IndexMetadata,
  IndexMetadataInput,
  IndexSortOrder,
  IndexStats,
  IndexStatus,
  IndexSummary,
  IndexTotalRelation,
  IndexUpdateDocumentInput
} from '../../../src/shared/types/index'
import type { TrashIndexSnapshot, TrashRecord } from '../../../src/shared/types/trash'
import { ConnectionService } from '../connection/connection-service'
import { TrashService } from '../trash/trash-service'
import { sanitizeRestorableIndexSettings } from './index-restore-settings'

type CatIndexRow = {
  health?: unknown
  status?: unknown
  index?: unknown
  uuid?: unknown
  pri?: unknown
  rep?: unknown
  'docs.count'?: unknown
  'docs.deleted'?: unknown
  'store.size'?: unknown
  'pri.store.size'?: unknown
}

type MappingResponse = Record<string, { mappings?: unknown }>
type SettingsResponse = Record<string, { settings?: unknown }>
type AliasesResponse = Record<string, { aliases?: unknown }>

type StatsValues = {
  docs?: { count?: unknown; deleted?: unknown }
  store?: { size_in_bytes?: unknown }
}

type StatsResponse = {
  _all?: { primaries?: StatsValues; total?: StatsValues }
  indices?: Record<string, { primaries?: StatsValues; total?: StatsValues }>
}

type SearchHit = {
  _id?: unknown
  _index?: unknown
  _seq_no?: unknown
  _primary_term?: unknown
  _score?: unknown
  _source?: unknown
  fields?: unknown
  sort?: unknown
}

type SearchResponse = {
  took?: unknown
  timed_out?: unknown
  hits?: {
    total?: unknown
    hits?: unknown
  }
}

type DocumentMutationResponse = {
  _id?: unknown
  _index?: unknown
  _version?: unknown
  result?: unknown
}

type BulkResponse = {
  errors?: unknown
  items?: unknown
}

type ResolveIndexEntry = {
  name: string
  attributes: string[]
  dataStream: string | null
}

type ResolveIndexResult = {
  indices: ResolveIndexEntry[]
  dataStreamBackings: Map<string, string>
}

const LIST_INDICES_PATH =
  '/_cat/indices?format=json&bytes=b&h=health,status,index,uuid,pri,rep,docs.count,docs.deleted,store.size,pri.store.size&s=index:asc'
const RESOLVE_INDICES_PATH = '/_resolve/index/*?expand_wildcards=all'
const RESOLVE_INDICES_OPERATION = 'GET /_resolve/index/*?expand_wildcards=all' as const
const DEFAULT_PAGE_FROM = 0
const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 200
const MAX_RESULT_WINDOW = 10_000
const MAX_QUERY_LENGTH = 4_096
const MAX_SORT_FIELD_LENGTH = 512
const MAX_DOCUMENT_ID_LENGTH_BYTES = 512
const MAX_BULK_DOCUMENTS = 1_000
const MAX_BULK_PAYLOAD_BYTES = 5 * 1024 * 1024
const MAX_EXPORT_DOCUMENTS = 10_000
const MAX_TRASH_INDEX_DOCUMENTS = 10_000
const INVALID_INDEX_CHARACTERS = /[\\/*?"<>|\s,#:%]/u
const VALID_SORT_FIELD = /^(?:_(?:score|doc)|[A-Za-z0-9_@.-]+)$/u
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u

export class IndexServiceError extends Error {
  constructor(
    readonly code: string,
    readonly connectionId: string | null,
    readonly index: string | null,
    operation: string,
    reason: string
  ) {
    super(
      `索引模块失败：connectionId=${connectionId ?? '未提供'}，index=${index ?? '未提供'}，操作=${operation}，原因=${reason}`
    )
    this.name = 'IndexServiceError'
  }
}

export class IndexService {
  constructor(
    private readonly connectionService: ConnectionService,
    private readonly trashService?: TrashService
  ) {}

  async listIndices(connectionIdInput: string): Promise<IndexListResult> {
    const connectionId = this.connectionService.assertConnected(connectionIdInput)
    const connection = this.connectionService.list().find((item) => item.id === connectionId)
    if (!connection) {
      throw new IndexServiceError(
        'INDEX_CONNECTION_NOT_FOUND',
        connectionId,
        null,
        '读取索引列表',
        '已连接的连接摘要不存在'
      )
    }
    const indexPatterns = parseIndexPatterns(
      this.connectionService.get(connectionId).filters.indices
    )
    const response = await this.connectionService.requestJson<unknown>(
      connectionId,
      LIST_INDICES_PATH
    )
    if (!Array.isArray(response)) {
      throw new IndexServiceError(
        'INDEX_INVALID_LIST_RESPONSE',
        connectionId,
        null,
        '读取索引列表',
        '_cat/indices 未返回数组'
      )
    }

    const baselineIndices = response
      .map((row, index) => toIndexSummary(row, connectionId, index))
      .filter((index) => matchesIndexPatterns(index.name, indexPatterns))
    const baselineCompatibility = getResolveCompatibility(
      connection.engine,
      connection.version
    )
    if (baselineCompatibility.resolveIndexStatus === 'not-supported') {
      return {
        connectionId,
        collectedAt: new Date().toISOString(),
        indices: baselineIndices,
        compatibility: baselineCompatibility,
        warnings: []
      }
    }

    // 新版本先保留 CAT 基线，再用固定的 resolve API 补齐隐藏、关闭及数据流后备索引。
    // resolve 属于兼容增强；请求或响应解析失败时必须降级，不能影响已有版本的索引列表。
    try {
      const resolveResponse = await this.connectionService.requestJson<unknown>(
        connectionId,
        RESOLVE_INDICES_PATH
      )
      const resolvedIndices = readResolveIndexResponse(resolveResponse, connectionId)
      return {
        connectionId,
        collectedAt: new Date().toISOString(),
        indices: mergeResolvedIndices(baselineIndices, resolvedIndices, indexPatterns),
        compatibility: {
          engine: connection.engine,
          version: connection.version,
          strategy: 'cat-plus-resolve-index',
          resolveIndexStatus: 'applied',
          reason: null
        },
        warnings: []
      }
    } catch (error) {
      const reason = getErrorMessage(error)
      const warnings: IndexListWarning[] = [
        {
          code: 'INDEX_RESOLVE_INDEX_FAILED',
          operation: RESOLVE_INDICES_OPERATION,
          reason
        }
      ]
      return {
        connectionId,
        collectedAt: new Date().toISOString(),
        indices: baselineIndices,
        compatibility: {
          engine: connection.engine,
          version: connection.version,
          strategy: 'cat-baseline',
          resolveIndexStatus: 'failed',
          reason: `resolve index 增强失败，已降级为 CAT 基线：${reason}`
        },
        warnings
      }
    }
  }

  async getMetadata(input: IndexMetadataInput): Promise<IndexMetadata> {
    const index = normalizeIndexName(input?.index, input?.connectionId ?? null)
    const connectionId = this.connectionService.assertConnected(input?.connectionId)
    const encodedIndex = encodeURIComponent(index)

    // 四类元数据彼此独立且均为只读 GET；并发读取可以避免串行放大远端集群延迟。
    const [mappingResponse, settingsResponse, aliasesResponse, statsResponse] = await Promise.all([
      this.connectionService.requestJson<MappingResponse>(
        connectionId,
        `/${encodedIndex}/_mapping`
      ),
      this.connectionService.requestJson<SettingsResponse>(
        connectionId,
        `/${encodedIndex}/_settings?flat_settings=true&include_defaults=false`
      ),
      this.connectionService.requestJson<AliasesResponse>(
        connectionId,
        `/${encodedIndex}/_alias`
      ),
      this.connectionService.requestJson<StatsResponse>(
        connectionId,
        `/${encodedIndex}/_stats/docs,store?filter_path=_all.primaries.docs,_all.primaries.store,_all.total.store,indices.*.primaries.docs,indices.*.primaries.store,indices.*.total.store`
      )
    ])

    return {
      connectionId,
      index,
      collectedAt: new Date().toISOString(),
      mapping: readMetadataObject(mappingResponse, index, 'mappings', connectionId),
      settings: readMetadataObject(settingsResponse, index, 'settings', connectionId),
      aliases: readAliases(aliasesResponse, index, connectionId),
      stats: readStats(statsResponse, index)
    }
  }

  async createIndex(input: IndexCreateInput): Promise<IndexCreateResult> {
    const index = normalizeIndexName(input?.index, input?.connectionId ?? null)
    const connectionId = this.connectionService.assertConnected(input?.connectionId)
    const body: Record<string, unknown> = {}
    const settings = normalizeIndexDefinitionPart(input?.settings, connectionId, index, 'Settings')
    const mappings = normalizeIndexDefinitionPart(input?.mappings, connectionId, index, 'Mapping')
    const aliases = normalizeIndexDefinitionPart(input?.aliases, connectionId, index, 'Aliases')
    if (settings) body.settings = settings
    if (mappings) body.mappings = mappings
    if (aliases) body.aliases = aliases

    const response = await this.connectionService.requestJson<Record<string, unknown>>(
      connectionId,
      `/${encodeURIComponent(index)}`,
      { method: 'PUT', body: JSON.stringify(body) }
    )
    if (!isRecord(response)) {
      throw new IndexServiceError(
        'INDEX_INVALID_CREATE_RESPONSE',
        connectionId,
        index,
        '解析创建索引响应',
        '响应不是对象'
      )
    }
    return {
      connectionId,
      index,
      acknowledged: response.acknowledged !== false,
      shardsAcknowledged: readBoolean(response.shards_acknowledged)
    }
  }

  async deleteIndex(input: IndexDeleteInput): Promise<IndexDeleteResult> {
    const index = normalizeIndexName(input?.index, input?.connectionId ?? null)
    const connectionId = this.connectionService.assertConnected(input?.connectionId)
    const connection = this.connectionService.list().find((item) => item.id === connectionId)
    if (!connection) {
      throw new IndexServiceError('INDEX_CONNECTION_NOT_FOUND', connectionId, index, '删除索引', '连接摘要不存在')
    }
    const trashService = this.requireTrashService(connectionId, index, '删除索引')
    const metadata = await this.getMetadata({ connectionId, index })
    const documentCount = metadata.stats.documentCount ?? 0
    if (documentCount > MAX_TRASH_INDEX_DOCUMENTS) {
      throw new IndexServiceError(
        'INDEX_TRASH_SNAPSHOT_LIMIT',
        connectionId,
        index,
        '删除索引',
        `索引包含 ${documentCount} 条文档，超过废纸篓单索引快照上限 ${MAX_TRASH_INDEX_DOCUMENTS} 条`
      )
    }
    const exported = await this.exportDocuments({
      connectionId,
      index,
      limit: MAX_TRASH_INDEX_DOCUMENTS,
      sort: { field: '_doc', order: 'asc' }
    })
    if (exported.total < documentCount) {
      throw new IndexServiceError(
        'INDEX_TRASH_SNAPSHOT_INCOMPLETE',
        connectionId,
        index,
        '删除索引',
        `快照仅读取 ${exported.total}/${documentCount} 条文档，为避免不可恢复，已取消删除`
      )
    }
    const snapshot: TrashIndexSnapshot = {
      mapping: metadata.mapping,
      settings: metadata.settings,
      aliases: metadata.aliases,
      documents: exported.documents
    }
    const trashRecordId = trashService.recordIndex({
      connectionId,
      connectionName: connection.name,
      index,
      snapshot
    })
    try {
      const response = await this.connectionService.requestJson<Record<string, unknown>>(
        connectionId,
        `/${encodeURIComponent(index)}`,
        { method: 'DELETE' }
      )
      return {
        connectionId,
        index,
        result: response.acknowledged === false ? 'not acknowledged' : 'deleted',
        trashRecordId,
        documentCount: exported.total
      }
    } catch (error: unknown) {
      trashService.remove(trashRecordId)
      throw error
    }
  }

  async getDocuments(input: IndexDocumentsInput): Promise<IndexDocumentsPage> {
    const index = normalizeIndexName(input?.index, input?.connectionId ?? null)
    const connectionId = this.connectionService.assertConnected(input?.connectionId)
    const connection = this.connectionService.list().find((item) => item.id === connectionId)
    if (!connection) {
      throw new IndexServiceError(
        'INDEX_CONNECTION_NOT_FOUND',
        connectionId,
        index,
        '查询索引文档',
        '已连接的连接摘要不存在'
      )
    }
    const from = normalizeInteger(input?.from, DEFAULT_PAGE_FROM, 0, MAX_RESULT_WINDOW, {
      connectionId,
      index,
      field: 'from'
    })
    const size = normalizeInteger(input?.size, DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE, {
      connectionId,
      index,
      field: 'size'
    })
    if (from + size > MAX_RESULT_WINDOW) {
      throw new IndexServiceError(
        'INDEX_RESULT_WINDOW_EXCEEDED',
        connectionId,
        index,
        '校验文档分页',
        `from + size 不能超过 ${MAX_RESULT_WINDOW}，当前值=${from + size}`
      )
    }

    const query = normalizeQuery(input?.q, connectionId, index)
    const sort = normalizeSort(input?.sort, connectionId, index)
    const parameters = new URLSearchParams({
      from: String(from),
      size: String(size)
    })
    // ES 5 不识别 track_total_hits；ES 6+ 和 OpenSearch 才按能力开启精确总数。
    if (supportsTrackTotalHits(connection.engine, connection.version)) {
      parameters.set('track_total_hits', 'true')
    }
    if (supportsSequenceNumberConcurrency(connection.engine, connection.version)) {
      parameters.set('seq_no_primary_term', 'true')
    }
    if (query) parameters.set('q', query)
    if (sort) parameters.set('sort', `${sort.field}:${sort.order}`)

    // 查询条件全部经过校验后写入 URLSearchParams，避免路径和参数注入。
    const response = await this.connectionService.requestJson<SearchResponse>(
      connectionId,
      `/${encodeURIComponent(index)}/_search?${parameters.toString()}`
    )
    const hits = readSearchHits(response, connectionId, index)
    const total = readSearchTotal(response.hits?.total, connectionId, index)

    return {
      connectionId,
      index,
      from,
      size,
      total: total.value,
      totalRelation: total.relation,
      tookMs: readFiniteNumber(response.took),
      timedOut: response.timed_out === true,
      documents: hits.map((hit, hitIndex) =>
        toIndexDocument(hit, connectionId, index, hitIndex)
      )
    }
  }

  async createDocument(input: IndexCreateDocumentInput): Promise<IndexDocumentMutationResult> {
    const index = normalizeIndexName(input?.index, input?.connectionId ?? null)
    const connectionId = this.connectionService.assertConnected(input?.connectionId)
    assertTypelessDocumentWriteSupported(this.connectionService, connectionId, index)
    const document = normalizeDocumentSource(input?.document, connectionId, index, '新增文档')
    const id = input?.id === undefined ? null : normalizeDocumentId(input.id, connectionId, index)
    const requestPath = id
      ? `/${encodeURIComponent(index)}/_doc/${encodeURIComponent(id)}?refresh=true`
      : `/${encodeURIComponent(index)}/_doc?refresh=true`
    const response = await this.connectionService.requestJson<DocumentMutationResponse>(
      connectionId,
      requestPath,
      {
        method: id ? 'PUT' : 'POST',
        body: JSON.stringify(document)
      }
    )
    return readMutationResponse(response, connectionId, index, '新增文档')
  }

  async updateDocument(input: IndexUpdateDocumentInput): Promise<IndexDocumentMutationResult> {
    const index = normalizeIndexName(input?.index, input?.connectionId ?? null)
    const connectionId = this.connectionService.assertConnected(input?.connectionId)
    assertTypelessDocumentWriteSupported(this.connectionService, connectionId, index)
    const id = normalizeDocumentId(input?.id, connectionId, index)
    const document = normalizeDocumentSource(input?.document, connectionId, index, '修改文档')
    const previousSource = await this.readDocumentSource(connectionId, index, id, '修改文档')
    const trashRecordId = this.recordDocumentTrash(connectionId, index, id, 'update', previousSource)
    let response: DocumentMutationResponse
    try {
      response = await this.connectionService.requestJson<DocumentMutationResponse>(
        connectionId,
        `/${encodeURIComponent(index)}/_doc/${encodeURIComponent(id)}?refresh=true`,
        {
          method: 'PUT',
          body: JSON.stringify(document)
        }
      )
    } catch (error: unknown) {
      if (trashRecordId) this.trashService?.remove(trashRecordId)
      throw error
    }
    const result = readMutationResponse(response, connectionId, index, '修改文档')
    return result
  }

  async deleteDocument(input: IndexDeleteDocumentInput): Promise<IndexDocumentMutationResult> {
    const index = normalizeIndexName(input?.index, input?.connectionId ?? null)
    const connectionId = this.connectionService.assertConnected(input?.connectionId)
    assertTypelessDocumentWriteSupported(this.connectionService, connectionId, index)
    const id = normalizeDocumentId(input?.id, connectionId, index)
    const previousSource = await this.readDocumentSource(connectionId, index, id, '删除文档')
    const trashRecordId = this.recordDocumentTrash(connectionId, index, id, 'delete', previousSource)
    let response: DocumentMutationResponse
    try {
      response = await this.connectionService.requestJson<DocumentMutationResponse>(
        connectionId,
        `/${encodeURIComponent(index)}/_doc/${encodeURIComponent(id)}?refresh=true`,
        { method: 'DELETE' }
      )
    } catch (error: unknown) {
      if (trashRecordId) this.trashService?.remove(trashRecordId)
      throw error
    }
    const result = readMutationResponse(response, connectionId, index, '删除文档')
    return result
  }

  async bulkImport(input: IndexBulkImportInput): Promise<IndexBulkImportResult> {
    const index = normalizeIndexName(input?.index, input?.connectionId ?? null)
    const connectionId = this.connectionService.assertConnected(input?.connectionId)
    assertTypelessDocumentWriteSupported(this.connectionService, connectionId, index)
    const operation = normalizeBulkOperation(input?.operation, connectionId, index)
    if (!Array.isArray(input?.documents) || input.documents.length === 0) {
      throw new IndexServiceError(
        'INDEX_INVALID_BULK_DOCUMENTS',
        connectionId,
        index,
        '批量导入文档',
        'documents 必须是非空数组'
      )
    }
    if (input.documents.length > MAX_BULK_DOCUMENTS) {
      throw new IndexServiceError(
        'INDEX_BULK_DOCUMENTS_EXCEEDED',
        connectionId,
        index,
        '批量导入文档',
        `单批最多 ${MAX_BULK_DOCUMENTS} 条，当前值=${input.documents.length}`
      )
    }

    const payloadLines: string[] = []
    const documentIds: Array<string | null> = []
    input.documents.forEach((item, position) => {
      if (!isRecord(item)) {
        throw invalidBulkDocument(connectionId, index, position, '文档不是对象')
      }
      const id = item.id === undefined ? null : normalizeDocumentId(item.id, connectionId, index)
      documentIds.push(id)
      if (operation === 'update' && !id) {
        throw invalidBulkDocument(connectionId, index, position, 'update 操作必须提供 id')
      }
      const source = normalizeDocumentSource(
        item.source,
        connectionId,
        index,
        `批量导入第 ${position + 1} 条文档`
      )
      payloadLines.push(
        JSON.stringify({ [operation]: { _index: index, ...(id ? { _id: id } : {}) } }),
        JSON.stringify(operation === 'update' ? { doc: source } : source)
      )
    })
    const payload = `${payloadLines.join('\n')}\n`
    const payloadSize = Buffer.byteLength(payload, 'utf8')
    if (payloadSize > MAX_BULK_PAYLOAD_BYTES) {
      throw new IndexServiceError(
        'INDEX_BULK_PAYLOAD_EXCEEDED',
        connectionId,
        index,
        '批量导入文档',
        `请求体不能超过 5 MiB，当前字节数=${payloadSize}`
      )
    }

    const previousSources = new Map<string, Record<string, unknown>>()
    if (operation === 'update') {
      await Promise.all(documentIds.map(async (id) => {
        if (!id) return
        previousSources.set(id, await this.readDocumentSource(connectionId, index, id, '批量更新文档'))
      }))
    }
    const response = await this.connectionService.requestJson<BulkResponse>(
      connectionId,
      '/_bulk?refresh=true',
      {
        method: 'POST',
        body: payload,
        contentType: 'application/x-ndjson'
      }
    )
    const result = readBulkResponse(response, connectionId, index, operation, input.documents.length)
    const connection = this.connectionService.list().find((item) => item.id === connectionId)
    if (connection && operation === 'update') {
      result.items.filter((item) => item.error === null && item.id !== null).forEach((item) => {
        const source = previousSources.get(item.id as string)
        if (source) this.recordDocumentTrashWithName(connectionId, connection.name, index, item.id as string, 'update', source)
      })
    }
    return result
  }

  async commitDocumentChanges(
    input: IndexCommitDocumentChangesInput
  ): Promise<IndexCommitDocumentChangesResult> {
    const index = normalizeIndexName(input?.index, input?.connectionId ?? null)
    const connectionId = this.connectionService.assertConnected(input?.connectionId)
    assertTypelessDocumentWriteSupported(this.connectionService, connectionId, index)
    if (!Array.isArray(input?.actions) || input.actions.length === 0) {
      throw new IndexServiceError(
        'INDEX_INVALID_DOCUMENT_CHANGES',
        connectionId,
        index,
        '提交文档更改',
        'actions 必须是非空数组'
      )
    }
    if (input.actions.length > MAX_BULK_DOCUMENTS) {
      throw new IndexServiceError(
        'INDEX_DOCUMENT_CHANGES_EXCEEDED',
        connectionId,
        index,
        '提交文档更改',
        `单次最多 ${MAX_BULK_DOCUMENTS} 项，当前值=${input.actions.length}`
      )
    }

    const normalizedActions: IndexDocumentChange[] = []
    const previousSources = new Map<string, Record<string, unknown>>()
    const payloadLines: string[] = []
    input.actions.forEach((value, position) => {
      const action = normalizeDocumentChange(value, connectionId, index, position)
      normalizedActions.push(action)
      payloadLines.push(
        JSON.stringify({
          [action.action]: {
            _index: index,
            ...('id' in action && action.id ? { _id: action.id } : {}),
            ...readDocumentChangeConcurrencyMetadata(action)
          }
        })
      )
      if (action.action !== 'delete') payloadLines.push(JSON.stringify(action.source))
    })
    await Promise.all(normalizedActions
      .filter((action): action is Extract<IndexDocumentChange, { action: 'index' | 'delete' }> => action.action !== 'create')
      .map(async (action) => {
        const source = await this.readDocumentSource(connectionId, index, action.id, '提交文档更改')
        previousSources.set(action.id, source)
      }))
    const payload = `${payloadLines.join('\n')}\n`
    const payloadSize = Buffer.byteLength(payload, 'utf8')
    if (payloadSize > MAX_BULK_PAYLOAD_BYTES) {
      throw new IndexServiceError(
        'INDEX_BULK_PAYLOAD_EXCEEDED',
        connectionId,
        index,
        '提交文档更改',
        `请求体不能超过 5 MiB，当前字节数=${payloadSize}`
      )
    }

    const response = await this.connectionService.requestJson<BulkResponse>(
      connectionId,
      '/_bulk?refresh=true',
      {
        method: 'POST',
        body: payload,
        contentType: 'application/x-ndjson'
      }
    )
    const result = readDocumentChangesResponse(response, connectionId, index, normalizedActions)
    const connection = this.connectionService.list().find((item) => item.id === connectionId)
    if (connection) {
      result.items.filter((item) => item.succeeded && item.action !== 'create').forEach((item) => {
        const action = normalizedActions[item.position]
        if (action.action === 'create') return
        const source = previousSources.get(action.id)
        if (source) this.recordDocumentTrashWithName(connectionId, connection.name, index, action.id, action.action === 'delete' ? 'delete' : 'update', source)
      })
    }
    return result
  }

  async restoreTrashRecord(record: TrashRecord): Promise<void> {
    const connectionId = this.connectionService.assertConnected(record.connectionId)
    if (record.kind === 'document') {
      if (!record.documentId || !record.beforeSource) {
        throw new IndexServiceError('INDEX_TRASH_RECORD_INVALID', connectionId, record.index, '恢复文档', '文档快照不完整')
      }
      await this.connectionService.requestJson<unknown>(
        connectionId,
        `/${encodeURIComponent(record.index)}/_doc/${encodeURIComponent(record.documentId)}?refresh=true`,
        { method: 'PUT', body: JSON.stringify(record.beforeSource) }
      )
      return
    }
    const snapshot = record.indexSnapshot
    if (!snapshot) throw new IndexServiceError('INDEX_TRASH_RECORD_INVALID', connectionId, record.index, '恢复索引', '索引快照不完整')
    const aliases = Object.fromEntries(snapshot.aliases.map((alias) => [alias.name, {
      routing: alias.routing ?? undefined,
      index_routing: alias.indexRouting ?? undefined,
      search_routing: alias.searchRouting ?? undefined,
      is_hidden: alias.isHidden ?? undefined,
      is_write_index: alias.isWriteIndex ?? undefined,
      filter: alias.filter ?? undefined
    }]))
    await this.connectionService.requestJson<unknown>(
      connectionId,
      `/${encodeURIComponent(record.index)}`,
      {
        method: 'PUT',
        body: JSON.stringify({
          settings: sanitizeRestorableIndexSettings(snapshot.settings),
          mappings: snapshot.mapping,
          aliases
        })
      }
    )
    if (snapshot.documents.length > 0) {
      for (let offset = 0; offset < snapshot.documents.length; offset += MAX_BULK_DOCUMENTS) {
        await this.bulkImport({
          connectionId,
          index: record.index,
          operation: 'index',
          documents: snapshot.documents.slice(offset, offset + MAX_BULK_DOCUMENTS)
        })
      }
    }
  }

  private recordDocumentTrash(
    connectionId: string,
    index: string,
    documentId: string,
    operation: 'delete' | 'update',
    beforeSource: Record<string, unknown>
  ): string | null {
    const connection = this.connectionService.list().find((item) => item.id === connectionId)
    if (connection) return this.recordDocumentTrashWithName(connectionId, connection.name, index, documentId, operation, beforeSource)
    return null
  }

  private recordDocumentTrashWithName(
    connectionId: string,
    connectionName: string,
    index: string,
    documentId: string,
    operation: 'delete' | 'update',
    beforeSource: Record<string, unknown>
  ): string | null {
    return this.trashService?.recordDocument({ connectionId, connectionName, index, documentId, operation, beforeSource }) ?? null
  }

  private requireTrashService(connectionId: string, index: string, operation: string): TrashService {
    if (!this.trashService) throw new IndexServiceError('INDEX_TRASH_UNAVAILABLE', connectionId, index, operation, '废纸篓服务尚未初始化')
    return this.trashService
  }

  private async readDocumentSource(
    connectionId: string,
    index: string,
    id: string,
    operation: string
  ): Promise<Record<string, unknown>> {
    const response = await this.connectionService.requestJson<Record<string, unknown>>(
      connectionId,
      `/${encodeURIComponent(index)}/_doc/${encodeURIComponent(id)}?_source=true`
    )
    const source = response._source
    if (!isRecord(source)) {
      throw new IndexServiceError('INDEX_TRASH_SOURCE_MISSING', connectionId, index, operation, `文档 _id=${id} 缺少 _source`)
    }
    return source
  }

  async exportDocuments(input: IndexExportDocumentsInput): Promise<IndexDocumentExport> {
    const index = normalizeIndexName(input?.index, input?.connectionId ?? null)
    const connectionId = this.connectionService.assertConnected(input?.connectionId)
    const limit = normalizeInteger(input?.limit, MAX_EXPORT_DOCUMENTS, 1, MAX_EXPORT_DOCUMENTS, {
      connectionId,
      index,
      field: 'limit'
    })
    const documents: IndexDocumentExport['documents'] = []

    // 导出以 200 条为一批读取，保留查询和排序口径；每批仍受连接层 5 MiB 响应限制保护。
    while (documents.length < limit) {
      const size = Math.min(MAX_PAGE_SIZE, limit - documents.length)
      const page = await this.getDocuments({
        connectionId,
        index,
        from: documents.length,
        size,
        q: input?.q,
        sort: input?.sort ?? { field: '_doc', order: 'asc' }
      })
      for (const document of page.documents) {
        if (!document.source) {
          throw new IndexServiceError(
            'INDEX_EXPORT_SOURCE_MISSING',
            connectionId,
            index,
            '导出文档',
            `文档 _id=${document.id} 缺少 _source`
          )
        }
        documents.push({ id: document.id, source: document.source })
      }
      if (page.documents.length < size || documents.length >= page.total) break
    }

    return {
      connectionId,
      index,
      exportedAt: new Date().toISOString(),
      total: documents.length,
      documents
    }
  }
}

function assertTypelessDocumentWriteSupported(
  connectionService: ConnectionService,
  connectionId: string,
  index: string
): void {
  const connection = connectionService.list().find((item) => item.id === connectionId)
  const engine = connection?.engine?.trim().toLowerCase() ?? null
  const version = connection?.version ?? null
  const parsedVersion = parseEngineVersion(version)
  if (engine !== 'elasticsearch' || !parsedVersion || parsedVersion.major >= 7) return
  throw new IndexServiceError(
    'INDEX_TYPED_DOCUMENT_WRITE_UNSUPPORTED',
    connectionId,
    index,
    '校验文档写入兼容性',
    `Elasticsearch ${parsedVersion.major} 使用 typed document API，当前 /_doc 写入可能误建 type，已拒绝操作：engine=${connection?.engine ?? '未知'}，version=${version ?? '未知'}`
  )
}

function normalizeDocumentId(value: unknown, connectionId: string, index: string): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    CONTROL_CHARACTERS.test(value) ||
    Buffer.byteLength(value, 'utf8') > MAX_DOCUMENT_ID_LENGTH_BYTES
  ) {
    throw new IndexServiceError(
      'INDEX_INVALID_DOCUMENT_ID',
      connectionId,
      index,
      '校验文档 ID',
      `id 必须是非空、不含控制字符且不超过 ${MAX_DOCUMENT_ID_LENGTH_BYTES} 字节的字符串`
    )
  }
  return value
}

function normalizeDocumentSource(
  value: unknown,
  connectionId: string,
  index: string,
  operation: string
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new IndexServiceError(
      'INDEX_INVALID_DOCUMENT_SOURCE',
      connectionId,
      index,
      operation,
      '文档内容必须是 JSON 对象'
    )
  }
  return value
}

function normalizeBulkOperation(
  value: unknown,
  connectionId: string,
  index: string
): IndexBulkOperation {
  if (value === undefined || value === null) return 'index'
  if (value === 'index' || value === 'create' || value === 'update') return value
  throw new IndexServiceError(
    'INDEX_INVALID_BULK_OPERATION',
    connectionId,
    index,
    '校验批量导入操作',
    `operation 仅支持 index/create/update，当前值=${String(value)}`
  )
}

function normalizeDocumentChange(
  value: unknown,
  connectionId: string,
  index: string,
  position: number
): IndexDocumentChange {
  if (!isRecord(value)) {
    throw invalidDocumentChange(connectionId, index, position, '操作不是对象')
  }
  if (value.action === 'delete') {
    const concurrency = normalizeDocumentChangeConcurrency(value, connectionId, index, position)
    return {
      action: 'delete',
      id: normalizeDocumentId(value.id, connectionId, index),
      ...concurrency
    }
  }
  if (value.action === 'index') {
    const concurrency = normalizeDocumentChangeConcurrency(value, connectionId, index, position)
    return {
      action: 'index',
      id: normalizeDocumentId(value.id, connectionId, index),
      source: normalizeDocumentSource(
        value.source,
        connectionId,
        index,
        `校验第 ${position + 1} 项 index 操作`
      ),
      ...concurrency
    }
  }
  if (value.action === 'create') {
    const id = value.id === undefined
      ? undefined
      : normalizeDocumentId(value.id, connectionId, index)
    return {
      action: 'create',
      ...(id ? { id } : {}),
      source: normalizeDocumentSource(
        value.source,
        connectionId,
        index,
        `校验第 ${position + 1} 项 create 操作`
      )
    }
  }
  throw invalidDocumentChange(
    connectionId,
    index,
    position,
    `action 仅支持 create/index/delete，当前值=${String(value.action)}`
  )
}

function normalizeDocumentChangeConcurrency(
  value: Record<string, unknown>,
  connectionId: string,
  index: string,
  position: number
): { sequenceNumber?: number; primaryTerm?: number } {
  const hasSequenceNumber = value.sequenceNumber !== undefined
  const hasPrimaryTerm = value.primaryTerm !== undefined
  if (hasSequenceNumber !== hasPrimaryTerm) {
    throw invalidDocumentChange(
      connectionId,
      index,
      position,
      'sequenceNumber 和 primaryTerm 必须同时提供'
    )
  }
  if (!hasSequenceNumber) return {}
  const sequenceNumber = readNonNegativeNumber(value.sequenceNumber)
  const primaryTerm = readNonNegativeNumber(value.primaryTerm)
  if (
    sequenceNumber === null ||
    primaryTerm === null ||
    !Number.isSafeInteger(sequenceNumber) ||
    !Number.isSafeInteger(primaryTerm) ||
    primaryTerm < 1
  ) {
    throw invalidDocumentChange(
      connectionId,
      index,
      position,
      'sequenceNumber 和 primaryTerm 必须是有效的非负安全整数，且 primaryTerm 大于 0'
    )
  }
  return { sequenceNumber, primaryTerm }
}

function readDocumentChangeConcurrencyMetadata(
  action: IndexDocumentChange
): { if_seq_no?: number; if_primary_term?: number } {
  if (
    action.action === 'create' ||
    action.sequenceNumber === undefined ||
    action.primaryTerm === undefined
  ) {
    return {}
  }
  return {
    if_seq_no: action.sequenceNumber,
    if_primary_term: action.primaryTerm
  }
}

function invalidDocumentChange(
  connectionId: string,
  index: string,
  position: number,
  reason: string
): IndexServiceError {
  return new IndexServiceError(
    'INDEX_INVALID_DOCUMENT_CHANGE',
    connectionId,
    index,
    '校验文档更改',
    `第 ${position + 1} 项无效：${reason}`
  )
}

function invalidBulkDocument(
  connectionId: string,
  index: string,
  position: number,
  reason: string
): IndexServiceError {
  return new IndexServiceError(
    'INDEX_INVALID_BULK_DOCUMENT',
    connectionId,
    index,
    '校验批量导入文档',
    `第 ${position + 1} 条无效：${reason}`
  )
}

function readMutationResponse(
  response: DocumentMutationResponse,
  connectionId: string,
  requestedIndex: string,
  operation: string
): IndexDocumentMutationResult {
  if (!isRecord(response)) {
    throw new IndexServiceError(
      'INDEX_INVALID_MUTATION_RESPONSE',
      connectionId,
      requestedIndex,
      `解析${operation}响应`,
      '响应不是对象'
    )
  }
  const id = readNonEmptyString(response._id)
  const result = readNonEmptyString(response.result)
  if (!id || !result) {
    throw new IndexServiceError(
      'INDEX_INVALID_MUTATION_RESPONSE',
      connectionId,
      requestedIndex,
      `解析${operation}响应`,
      '响应缺少 _id 或 result'
    )
  }
  return {
    connectionId,
    index: readNonEmptyString(response._index) ?? requestedIndex,
    id,
    result,
    version: readNonNegativeNumber(response._version)
  }
}

function readBulkResponse(
  response: BulkResponse,
  connectionId: string,
  index: string,
  operation: IndexBulkOperation,
  expectedCount: number
): IndexBulkImportResult {
  if (!isRecord(response) || !Array.isArray(response.items) || response.items.length !== expectedCount) {
    throw new IndexServiceError(
      'INDEX_INVALID_BULK_RESPONSE',
      connectionId,
      index,
      '解析批量导入响应',
      `items 必须包含 ${expectedCount} 条结果`
    )
  }
  const items: IndexBulkImportItem[] = response.items.map((value, position) =>
    readBulkItem(value, connectionId, index, operation, position)
  )
  const failed = items.filter((item) => item.error !== null).length
  return {
    connectionId,
    index,
    total: items.length,
    succeeded: items.length - failed,
    failed,
    items
  }
}

function readDocumentChangesResponse(
  response: BulkResponse,
  connectionId: string,
  index: string,
  actions: IndexDocumentChange[]
): IndexCommitDocumentChangesResult {
  if (!isRecord(response) || !Array.isArray(response.items) || response.items.length !== actions.length) {
    throw new IndexServiceError(
      'INDEX_INVALID_DOCUMENT_CHANGES_RESPONSE',
      connectionId,
      index,
      '解析文档更改响应',
      `items 必须包含 ${actions.length} 条结果`
    )
  }
  const items: IndexDocumentChangeResult[] = response.items.map((value, position) =>
    readDocumentChangeItem(value, connectionId, index, actions[position], position)
  )
  const failed = items.filter((item) => !item.succeeded).length
  return {
    connectionId,
    index,
    total: items.length,
    succeeded: items.length - failed,
    failed,
    items
  }
}

function readDocumentChangeItem(
  value: unknown,
  connectionId: string,
  index: string,
  action: IndexDocumentChange,
  position: number
): IndexDocumentChangeResult {
  if (!isRecord(value) || !isRecord(value[action.action])) {
    throw new IndexServiceError(
      'INDEX_INVALID_DOCUMENT_CHANGES_RESPONSE',
      connectionId,
      index,
      '解析文档更改响应',
      `items[${position}].${action.action} 不是对象`
    )
  }
  const item = value[action.action]
  const status = readNonNegativeNumber(item.status)
  if (status === null || !Number.isInteger(status)) {
    throw new IndexServiceError(
      'INDEX_INVALID_DOCUMENT_CHANGES_RESPONSE',
      connectionId,
      index,
      '解析文档更改响应',
      `items[${position}].${action.action}.status 不是有效状态码`
    )
  }
  const succeeded = status >= 200 && status < 300
  const error = readBulkError(item.error)
  return {
    position,
    action: action.action,
    id: readNonEmptyString(item._id),
    status,
    succeeded,
    result: readNonEmptyString(item.result),
    error: error ?? (succeeded ? null : `HTTP ${status}`)
  }
}

function readBulkItem(
  value: unknown,
  connectionId: string,
  index: string,
  operation: IndexBulkOperation,
  position: number
): IndexBulkImportItem {
  if (!isRecord(value) || !isRecord(value[operation])) {
    throw new IndexServiceError(
      'INDEX_INVALID_BULK_RESPONSE',
      connectionId,
      index,
      '解析批量导入响应',
      `items[${position}].${operation} 不是对象`
    )
  }
  const item = value[operation]
  return {
    position,
    id: readNonEmptyString(item._id),
    result: readNonEmptyString(item.result),
    error: readBulkError(item.error)
  }
}

function readBulkError(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value === 'string') return value
  if (isRecord(value)) {
    const type = readNonEmptyString(value.type)
    const reason = readNonEmptyString(value.reason)
    if (type && reason) return `${type}: ${reason}`
    if (reason) return reason
  }
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function toIndexSummary(
  value: unknown,
  connectionId: string,
  rowIndex: number
): IndexSummary {
  if (!isRecord(value)) {
    throw new IndexServiceError(
      'INDEX_INVALID_LIST_ROW',
      connectionId,
      null,
      '解析索引列表',
      `第 ${rowIndex + 1} 行不是对象`
    )
  }
  const row = value as CatIndexRow
  const name = readNonEmptyString(row.index)
  if (!name) {
    throw new IndexServiceError(
      'INDEX_INVALID_LIST_ROW',
      connectionId,
      null,
      '解析索引列表',
      `第 ${rowIndex + 1} 行缺少 index 字段`
    )
  }

  return {
    name,
    health: readIndexHealth(row.health),
    status: readIndexStatus(row.status),
    uuid: readNonEmptyString(row.uuid),
    primaryShards: readNonNegativeNumber(row.pri),
    replicaShards: readNonNegativeNumber(row.rep),
    documentCount: readNonNegativeNumber(row['docs.count']),
    deletedDocumentCount: readNonNegativeNumber(row['docs.deleted']),
    storeSizeBytes: readNonNegativeNumber(row['store.size']),
    primaryStoreSizeBytes: readNonNegativeNumber(row['pri.store.size']),
    hidden: null,
    dataStream: null
  }
}

function getResolveCompatibility(
  engine: string | null,
  version: string | null
): IndexListCompatibility {
  const normalizedEngine = engine?.trim().toLowerCase() ?? null
  const parsedVersion = parseEngineVersion(version)
  if (!normalizedEngine || !parsedVersion) {
    return {
      engine,
      version,
      strategy: 'cat-baseline',
      resolveIndexStatus: 'not-supported',
      reason: `无法确认引擎或版本，未发送 resolve index 请求：engine=${engine ?? '未知'}，version=${version ?? '未知'}`
    }
  }

  const supportsResolveIndex =
    (normalizedEngine === 'elasticsearch' &&
      (parsedVersion.major > 7 ||
        (parsedVersion.major === 7 && parsedVersion.minor >= 9))) ||
    (normalizedEngine === 'opensearch' && parsedVersion.major >= 1)
  if (supportsResolveIndex) {
    return {
      engine,
      version,
      strategy: 'cat-plus-resolve-index',
      resolveIndexStatus: 'applied',
      reason: null
    }
  }

  return {
    engine,
    version,
    strategy: 'cat-baseline',
    resolveIndexStatus: 'not-supported',
    reason: `当前引擎版本不支持 resolve index 增强，未发送请求：engine=${engine}，version=${version}`
  }
}

function parseEngineVersion(version: string | null): { major: number; minor: number } | null {
  if (!version) return null
  const match = /^(\d+)\.(\d+)(?:\.|[-+]|$)/u.exec(version.trim())
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2])
  }
}

function supportsTrackTotalHits(engine: string | null, version: string | null): boolean {
  const normalizedEngine = engine?.trim().toLowerCase()
  const parsedVersion = parseEngineVersion(version)
  if (!normalizedEngine || !parsedVersion) return false
  if (normalizedEngine === 'opensearch') return parsedVersion.major >= 1
  return normalizedEngine === 'elasticsearch' && parsedVersion.major >= 6
}

function supportsSequenceNumberConcurrency(engine: string | null, version: string | null): boolean {
  const normalizedEngine = engine?.trim().toLowerCase()
  const parsedVersion = parseEngineVersion(version)
  if (!normalizedEngine || !parsedVersion) return false
  if (normalizedEngine === 'opensearch') return parsedVersion.major >= 1
  return normalizedEngine === 'elasticsearch' && parsedVersion.major >= 7
}

function readResolveIndexResponse(value: unknown, connectionId: string): ResolveIndexResult {
  if (!isRecord(value)) {
    throw new IndexServiceError(
      'INDEX_INVALID_RESOLVE_RESPONSE',
      connectionId,
      null,
      '解析 resolve index 响应',
      '响应不是对象'
    )
  }
  const indices = readRequiredArray(value.indices, 'indices', connectionId).map(
    (entry, entryIndex) => readResolveIndexEntry(entry, entryIndex, connectionId)
  )
  const dataStreams = readRequiredArray(value.data_streams, 'data_streams', connectionId)
  const dataStreamBackings = new Map<string, string>()
  dataStreams.forEach((entry, entryIndex) => {
    if (!isRecord(entry)) {
      throw invalidResolveResponse(connectionId, `data_streams[${entryIndex}] 不是对象`)
    }
    const dataStreamName = readNonEmptyString(entry.name)
    if (!dataStreamName) {
      throw invalidResolveResponse(connectionId, `data_streams[${entryIndex}] 缺少 name`)
    }
    const backingIndices = readRequiredArray(
      entry.backing_indices,
      `data_streams[${entryIndex}].backing_indices`,
      connectionId
    )
    backingIndices.forEach((backingIndex, backingIndexPosition) => {
      const backingIndexName = readBackingIndexName(backingIndex)
      if (!backingIndexName) {
        throw invalidResolveResponse(
          connectionId,
          `data_streams[${entryIndex}].backing_indices[${backingIndexPosition}] 无效`
        )
      }
      dataStreamBackings.set(backingIndexName, dataStreamName)
    })
  })
  return { indices, dataStreamBackings }
}

function readResolveIndexEntry(
  value: unknown,
  entryIndex: number,
  connectionId: string
): ResolveIndexEntry {
  if (!isRecord(value)) {
    throw invalidResolveResponse(connectionId, `indices[${entryIndex}] 不是对象`)
  }
  const name = readNonEmptyString(value.name)
  if (!name) {
    throw invalidResolveResponse(connectionId, `indices[${entryIndex}] 缺少 name`)
  }
  const attributes = readRequiredArray(
    value.attributes,
    `indices[${entryIndex}].attributes`,
    connectionId
  )
  if (!attributes.every((attribute) => typeof attribute === 'string')) {
    throw invalidResolveResponse(connectionId, `indices[${entryIndex}].attributes 包含非字符串`)
  }
  if (
    value.data_stream !== undefined &&
    value.data_stream !== null &&
    typeof value.data_stream !== 'string'
  ) {
    throw invalidResolveResponse(connectionId, `indices[${entryIndex}].data_stream 不是字符串`)
  }
  return {
    name,
    attributes: attributes as string[],
    dataStream: readNonEmptyString(value.data_stream)
  }
}

function readRequiredArray(
  value: unknown,
  field: string,
  connectionId: string
): unknown[] {
  if (Array.isArray(value)) return value
  throw invalidResolveResponse(connectionId, `${field} 不是数组`)
}

function readBackingIndexName(value: unknown): string | null {
  // 标准 Elasticsearch/OpenSearch 返回字符串；对象分支仅兼容显式提供 index_name 的实现。
  if (typeof value === 'string') return readNonEmptyString(value)
  return isRecord(value) ? readNonEmptyString(value.index_name) : null
}

function invalidResolveResponse(connectionId: string, reason: string): IndexServiceError {
  return new IndexServiceError(
    'INDEX_INVALID_RESOLVE_RESPONSE',
    connectionId,
    null,
    '解析 resolve index 响应',
    reason
  )
}

function mergeResolvedIndices(
  baselineIndices: IndexSummary[],
  resolved: ResolveIndexResult,
  indexPatterns: string[]
): IndexSummary[] {
  const merged = new Map(baselineIndices.map((index) => [index.name, index]))

  for (const resolvedIndex of resolved.indices) {
    if (!matchesIndexPatterns(resolvedIndex.name, indexPatterns)) continue
    const existing = merged.get(resolvedIndex.name)
    const inferredStatus = readResolvedIndexStatus(resolvedIndex.attributes)
    const dataStream =
      resolvedIndex.dataStream ?? resolved.dataStreamBackings.get(resolvedIndex.name) ?? null
    if (existing) {
      merged.set(resolvedIndex.name, {
        ...existing,
        status: existing.status === 'unknown' ? inferredStatus : existing.status,
        hidden: resolvedIndex.attributes.includes('hidden'),
        dataStream
      })
      continue
    }
    merged.set(
      resolvedIndex.name,
      createResolvedIndexSummary(
        resolvedIndex.name,
        inferredStatus,
        resolvedIndex.attributes.includes('hidden'),
        dataStream
      )
    )
  }

  // 某些兼容实现仅在 data_streams 中返回后备索引；这些索引仍需补入，但指标保持未知。
  for (const [backingIndexName, dataStreamName] of resolved.dataStreamBackings) {
    if (!matchesIndexPatterns(backingIndexName, indexPatterns)) continue
    const existing = merged.get(backingIndexName)
    if (existing) {
      merged.set(backingIndexName, {
        ...existing,
        hidden: existing.hidden ?? true,
        dataStream: dataStreamName
      })
      continue
    }
    merged.set(
      backingIndexName,
      createResolvedIndexSummary(backingIndexName, 'unknown', true, dataStreamName)
    )
  }

  return Array.from(merged.values()).sort((left, right) => left.name.localeCompare(right.name))
}

function createResolvedIndexSummary(
  name: string,
  status: IndexStatus,
  hidden: boolean,
  dataStream: string | null
): IndexSummary {
  return {
    name,
    health: 'unknown',
    status,
    uuid: null,
    primaryShards: null,
    replicaShards: null,
    documentCount: null,
    deletedDocumentCount: null,
    storeSizeBytes: null,
    primaryStoreSizeBytes: null,
    hidden,
    dataStream
  }
}

function readResolvedIndexStatus(attributes: string[]): IndexStatus {
  if (attributes.includes('closed') || attributes.includes('close')) return 'close'
  return attributes.includes('open') ? 'open' : 'unknown'
}

function parseIndexPatterns(value: string): string[] {
  return value
    .split(',')
    .map((pattern) => pattern.trim())
    .filter(Boolean)
}

function matchesIndexPatterns(indexName: string, patterns: string[]): boolean {
  if (patterns.length === 0) return true
  return patterns.some((pattern) => createIndexPatternRegex(pattern).test(indexName))
}

function createIndexPatternRegex(pattern: string): RegExp {
  let source = '^'
  for (const character of pattern) {
    if (character === '*') {
      source += '.*'
    } else if (character === '?') {
      source += '.'
    } else {
      source += character.replace(/[\\^$.*+?()[\]{}|]/gu, '\\$&')
    }
  }
  return new RegExp(`${source}$`, 'u')
}

function readMetadataObject(
  response: Record<string, { mappings?: unknown; settings?: unknown }>,
  index: string,
  field: 'mappings' | 'settings',
  connectionId: string
): Record<string, unknown> {
  const indexResponse = response[index] ?? Object.values(response)[0]
  const value = indexResponse?.[field]
  if (!isRecord(value)) {
    throw new IndexServiceError(
      'INDEX_INVALID_METADATA_RESPONSE',
      connectionId,
      index,
      `解析索引 ${field}`,
      `响应缺少对象字段 ${field}`
    )
  }
  return value
}

function readAliases(
  response: AliasesResponse,
  index: string,
  connectionId: string
): IndexAlias[] {
  const indexResponse = response[index] ?? Object.values(response)[0]
  if (!indexResponse || !isRecord(indexResponse.aliases)) {
    throw new IndexServiceError(
      'INDEX_INVALID_ALIASES_RESPONSE',
      connectionId,
      index,
      '解析索引别名',
      '响应缺少 aliases 对象'
    )
  }

  return Object.entries(indexResponse.aliases)
    .map(([name, value]) => toIndexAlias(name, value))
    .sort((left, right) => left.name.localeCompare(right.name))
}

function toIndexAlias(name: string, value: unknown): IndexAlias {
  const alias = isRecord(value) ? value : {}
  return {
    name,
    routing: readNonEmptyString(alias.routing),
    indexRouting: readNonEmptyString(alias.index_routing),
    searchRouting: readNonEmptyString(alias.search_routing),
    isHidden: readBoolean(alias.is_hidden),
    isWriteIndex: readBoolean(alias.is_write_index),
    filter: isRecord(alias.filter) ? alias.filter : null
  }
}

function readStats(response: StatsResponse, index: string): IndexStats {
  const indexStats = response.indices?.[index]
  const primaries = indexStats?.primaries ?? response._all?.primaries
  const total = indexStats?.total ?? response._all?.total
  return {
    documentCount: readNonNegativeNumber(primaries?.docs?.count),
    deletedDocumentCount: readNonNegativeNumber(primaries?.docs?.deleted),
    storeSizeBytes: readNonNegativeNumber(total?.store?.size_in_bytes),
    primaryStoreSizeBytes: readNonNegativeNumber(primaries?.store?.size_in_bytes)
  }
}

function readSearchHits(
  response: SearchResponse,
  connectionId: string,
  index: string
): SearchHit[] {
  if (!response.hits || !Array.isArray(response.hits.hits)) {
    throw new IndexServiceError(
      'INDEX_INVALID_SEARCH_RESPONSE',
      connectionId,
      index,
      '解析文档列表',
      '响应缺少 hits.hits 数组'
    )
  }
  return response.hits.hits as SearchHit[]
}

function readSearchTotal(
  value: unknown,
  connectionId: string,
  index: string
): { value: number; relation: IndexTotalRelation } {
  if (typeof value === 'number') {
    return { value: readRequiredCount(value, connectionId, index), relation: 'eq' }
  }
  if (isRecord(value)) {
    if (value.relation !== 'eq' && value.relation !== 'gte') {
      throw new IndexServiceError(
        'INDEX_INVALID_SEARCH_RESPONSE',
        connectionId,
        index,
        '解析文档总数',
        `hits.total.relation 无效：${String(value.relation)}`
      )
    }
    return {
      value: readRequiredCount(value.value, connectionId, index),
      relation: value.relation
    }
  }
  throw new IndexServiceError(
    'INDEX_INVALID_SEARCH_RESPONSE',
    connectionId,
    index,
    '解析文档总数',
    '响应缺少 hits.total'
  )
}

function toIndexDocument(
  hit: SearchHit,
  connectionId: string,
  requestedIndex: string,
  hitIndex: number
): IndexDocument {
  if (!isRecord(hit)) {
    throw new IndexServiceError(
      'INDEX_INVALID_SEARCH_HIT',
      connectionId,
      requestedIndex,
      '解析文档列表',
      `第 ${hitIndex + 1} 条命中不是对象`
    )
  }
  const id = readNonEmptyString(hit._id)
  if (!id) {
    throw new IndexServiceError(
      'INDEX_INVALID_SEARCH_HIT',
      connectionId,
      requestedIndex,
      '解析文档列表',
      `第 ${hitIndex + 1} 条命中缺少 _id`
    )
  }

  return {
    id,
    index: readNonEmptyString(hit._index) ?? requestedIndex,
    sequenceNumber: readSafeNonNegativeInteger(hit._seq_no),
    primaryTerm: readSafePositiveInteger(hit._primary_term),
    score: readFiniteNumber(hit._score),
    source: isRecord(hit._source) ? hit._source : null,
    fields: isRecord(hit.fields) ? hit.fields : null,
    sortValues: Array.isArray(hit.sort) ? hit.sort : []
  }
}

function normalizeIndexName(value: unknown, connectionId: string | null): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new IndexServiceError(
      'INDEX_INVALID_NAME',
      connectionId,
      null,
      '校验索引名称',
      '索引名称不能为空'
    )
  }
  const index = value.trim()
  if (
    index === '.' ||
    index === '..' ||
    index !== index.toLowerCase() ||
    ['-', '_', '+'].some((prefix) => index.startsWith(prefix)) ||
    INVALID_INDEX_CHARACTERS.test(index) ||
    Buffer.byteLength(index, 'utf8') > 255
  ) {
    throw new IndexServiceError(
      'INDEX_INVALID_NAME',
      connectionId,
      index,
      '校验索引名称',
      '索引名称必须是合法的小写精确名称，不能包含通配符、路径字符、空格或查询分隔符，且不能超过 255 字节'
    )
  }
  return index
}

function normalizeIndexDefinitionPart(
  value: unknown,
  connectionId: string,
  index: string,
  field: string
): Record<string, unknown> | null {
  if (value === undefined || value === null) return null
  if (!isRecord(value)) {
    throw new IndexServiceError(
      'INDEX_INVALID_DEFINITION',
      connectionId,
      index,
      `校验${field}`,
      `${field} 必须是 JSON 对象`
    )
  }
  return value
}

function normalizeInteger(
  value: unknown,
  defaultValue: number,
  minimum: number,
  maximum: number,
  context: { connectionId: string; index: string; field: string }
): number {
  if (value === undefined) return defaultValue
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new IndexServiceError(
      'INDEX_INVALID_PAGINATION',
      context.connectionId,
      context.index,
      '校验文档分页',
      `${context.field} 必须是 ${minimum}-${maximum} 的整数，当前值=${String(value)}`
    )
  }
  return value as number
}

function normalizeQuery(value: unknown, connectionId: string, index: string): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') {
    throw new IndexServiceError(
      'INDEX_INVALID_QUERY',
      connectionId,
      index,
      '校验查询字符串',
      'q 必须是字符串'
    )
  }
  const query = value.trim()
  if (!query) return null
  if (query.length > MAX_QUERY_LENGTH || CONTROL_CHARACTERS.test(query)) {
    throw new IndexServiceError(
      'INDEX_INVALID_QUERY',
      connectionId,
      index,
      '校验查询字符串',
      `q 不能包含控制字符且不能超过 ${MAX_QUERY_LENGTH} 个字符`
    )
  }
  return query
}

function normalizeSort(
  value: unknown,
  connectionId: string,
  index: string
): { field: string; order: IndexSortOrder } | null {
  if (value === undefined || value === null) return null
  if (!isRecord(value)) {
    throw new IndexServiceError(
      'INDEX_INVALID_SORT',
      connectionId,
      index,
      '校验排序',
      'sort 必须包含 field 和 order'
    )
  }
  const field = typeof value.field === 'string' ? value.field.trim() : ''
  const order = value.order
  if (
    !field ||
    field === '_id' ||
    field.length > MAX_SORT_FIELD_LENGTH ||
    !VALID_SORT_FIELD.test(field) ||
    (order !== 'asc' && order !== 'desc')
  ) {
    throw new IndexServiceError(
      'INDEX_INVALID_SORT',
      connectionId,
      index,
      '校验排序',
      '排序字段仅支持字母、数字、点、下划线、@、连字符及 _score/_doc；为兼容 ES 5 和 ES 8+，不支持 _id 排序；order 必须是 asc 或 desc'
    )
  }
  return { field, order }
}

function readIndexHealth(value: unknown): IndexHealth {
  return value === 'green' || value === 'yellow' || value === 'red' ? value : 'unknown'
}

function readIndexStatus(value: unknown): IndexStatus {
  return value === 'open' || value === 'close' ? value : 'unknown'
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readNonNegativeNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null
  if (typeof value !== 'string' || !value.trim()) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

function readSafeNonNegativeInteger(value: unknown): number | null {
  const numberValue = readNonNegativeNumber(value)
  return numberValue !== null && Number.isSafeInteger(numberValue) ? numberValue : null
}

function readSafePositiveInteger(value: unknown): number | null {
  const numberValue = readSafeNonNegativeInteger(value)
  return numberValue !== null && numberValue > 0 ? numberValue : null
}

function readRequiredCount(value: unknown, connectionId: string, index: string): number {
  const count = readNonNegativeNumber(value)
  if (count !== null) return count
  throw new IndexServiceError(
    'INDEX_INVALID_SEARCH_RESPONSE',
    connectionId,
    index,
    '解析文档总数',
    `hits.total.value 无效：${String(value)}`
  )
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
