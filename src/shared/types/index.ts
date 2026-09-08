export type IndexHealth = 'green' | 'yellow' | 'red' | 'unknown'
export type IndexStatus = 'open' | 'close' | 'unknown'
export type IndexSortOrder = 'asc' | 'desc'
export type IndexTotalRelation = 'eq' | 'gte'
export type IndexDiscoveryStrategy = 'cat-baseline' | 'cat-plus-resolve-index'
export type IndexResolveStatus = 'not-supported' | 'applied' | 'failed'

export type IndexSummary = {
  name: string
  health: IndexHealth
  status: IndexStatus
  uuid: string | null
  primaryShards: number | null
  replicaShards: number | null
  documentCount: number | null
  deletedDocumentCount: number | null
  storeSizeBytes: number | null
  primaryStoreSizeBytes: number | null
  hidden: boolean | null
  dataStream: string | null
}

export type IndexListCompatibility = {
  engine: string | null
  version: string | null
  strategy: IndexDiscoveryStrategy
  resolveIndexStatus: IndexResolveStatus
  reason: string | null
}

export type IndexListWarning = {
  code: 'INDEX_RESOLVE_INDEX_FAILED'
  operation: 'GET /_resolve/index/*?expand_wildcards=all'
  reason: string
}

export type IndexListResult = {
  connectionId: string
  collectedAt: string
  indices: IndexSummary[]
  compatibility: IndexListCompatibility
  warnings: IndexListWarning[]
}

export type IndexAlias = {
  name: string
  routing: string | null
  indexRouting: string | null
  searchRouting: string | null
  isHidden: boolean | null
  isWriteIndex: boolean | null
  filter: Record<string, unknown> | null
}

export type IndexStats = {
  documentCount: number | null
  deletedDocumentCount: number | null
  storeSizeBytes: number | null
  primaryStoreSizeBytes: number | null
}

export type IndexMetadataInput = {
  connectionId: string
  index: string
}

export type IndexMetadata = {
  connectionId: string
  index: string
  collectedAt: string
  mapping: Record<string, unknown>
  settings: Record<string, unknown>
  aliases: IndexAlias[]
  stats: IndexStats
}

export type IndexDeleteInput = {
  connectionId: string
  index: string
}

export type IndexCreateInput = {
  connectionId: string
  index: string
  settings?: Record<string, unknown>
  mappings?: Record<string, unknown>
  aliases?: Record<string, unknown>
}

export type IndexCreateResult = {
  connectionId: string
  index: string
  acknowledged: boolean
  shardsAcknowledged: boolean | null
}

export type IndexDeleteResult = {
  connectionId: string
  index: string
  result: string
  trashRecordId: string
  documentCount: number
}

export type IndexDocumentSort = {
  field: string
  order: IndexSortOrder
}

export type IndexDocumentsInput = {
  connectionId: string
  index: string
  from?: number
  size?: number
  q?: string
  sort?: IndexDocumentSort
}

export type IndexDocument = {
  id: string
  index: string
  sequenceNumber: number | null
  primaryTerm: number | null
  score: number | null
  source: Record<string, unknown> | null
  fields: Record<string, unknown> | null
  sortValues: unknown[]
}

export type IndexDocumentsPage = {
  connectionId: string
  index: string
  from: number
  size: number
  total: number
  totalRelation: IndexTotalRelation
  tookMs: number | null
  timedOut: boolean
  documents: IndexDocument[]
}

export type IndexDocumentSource = Record<string, unknown>

export type IndexCreateDocumentInput = {
  connectionId: string
  index: string
  id?: string
  document: IndexDocumentSource
}

export type IndexUpdateDocumentInput = {
  connectionId: string
  index: string
  id: string
  document: IndexDocumentSource
}

export type IndexDeleteDocumentInput = {
  connectionId: string
  index: string
  id: string
}

export type IndexDocumentMutationResult = {
  connectionId: string
  index: string
  id: string
  result: string
  version: number | null
}

export type IndexBulkOperation = 'index' | 'create' | 'update'

export type IndexImportDocument = {
  id?: string
  source: IndexDocumentSource
}

export type IndexBulkImportInput = {
  connectionId: string
  index: string
  operation?: IndexBulkOperation
  documents: IndexImportDocument[]
}

export type IndexBulkImportItem = {
  position: number
  id: string | null
  result: string | null
  error: string | null
}

export type IndexBulkImportResult = {
  connectionId: string
  index: string
  total: number
  succeeded: number
  failed: number
  items: IndexBulkImportItem[]
}

export type IndexDocumentChange =
  | { action: 'create'; id?: string; source: IndexDocumentSource }
  | {
      action: 'index'
      id: string
      source: IndexDocumentSource
      sequenceNumber?: number
      primaryTerm?: number
    }
  | { action: 'delete'; id: string; sequenceNumber?: number; primaryTerm?: number }

export type IndexCommitDocumentChangesInput = {
  connectionId: string
  index: string
  actions: IndexDocumentChange[]
}

export type IndexDocumentChangeResult = {
  position: number
  action: IndexDocumentChange['action']
  id: string | null
  status: number
  succeeded: boolean
  result: string | null
  error: string | null
}

export type IndexCommitDocumentChangesResult = {
  connectionId: string
  index: string
  total: number
  succeeded: number
  failed: number
  items: IndexDocumentChangeResult[]
}

export type IndexExportDocumentsInput = {
  connectionId: string
  index: string
  q?: string
  sort?: IndexDocumentSort
  limit?: number
}

export type IndexDocumentExport = {
  connectionId: string
  index: string
  exportedAt: string
  total: number
  documents: Array<{ id: string; source: IndexDocumentSource }>
}

export type IndexSaveExportFileInput = {
  suggestedName: string
  content: string
  gzip?: boolean
}

export type IndexSaveExportFileResult = {
  canceled: boolean
  filePath: string | null
}

export type IndexApi = {
  listIndices: (connectionId: string) => Promise<IndexListResult>
  createIndex: (input: IndexCreateInput) => Promise<IndexCreateResult>
  deleteIndex: (input: IndexDeleteInput) => Promise<IndexDeleteResult>
  getMetadata: (input: IndexMetadataInput) => Promise<IndexMetadata>
  getDocuments: (input: IndexDocumentsInput) => Promise<IndexDocumentsPage>
  createDocument: (input: IndexCreateDocumentInput) => Promise<IndexDocumentMutationResult>
  updateDocument: (input: IndexUpdateDocumentInput) => Promise<IndexDocumentMutationResult>
  deleteDocument: (input: IndexDeleteDocumentInput) => Promise<IndexDocumentMutationResult>
  bulkImport: (input: IndexBulkImportInput) => Promise<IndexBulkImportResult>
  commitDocumentChanges: (
    input: IndexCommitDocumentChangesInput
  ) => Promise<IndexCommitDocumentChangesResult>
  exportDocuments: (input: IndexExportDocumentsInput) => Promise<IndexDocumentExport>
  saveExportFile: (input: IndexSaveExportFileInput) => Promise<IndexSaveExportFileResult>
}
