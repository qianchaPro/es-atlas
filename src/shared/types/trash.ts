export type TrashRecordKind = 'index' | 'document'
export type TrashRecordOperation = 'delete' | 'update'

export type TrashIndexSnapshot = {
  mapping: Record<string, unknown>
  settings: Record<string, unknown>
  aliases: Array<{
    name: string
    routing: string | null
    indexRouting: string | null
    searchRouting: string | null
    isHidden: boolean | null
    isWriteIndex: boolean | null
    filter: Record<string, unknown> | null
  }>
  documents: Array<{ id: string; source: Record<string, unknown> }>
}

export type TrashRecord = {
  id: string
  connectionId: string
  connectionName: string
  kind: TrashRecordKind
  operation: TrashRecordOperation
  index: string
  documentId: string | null
  createdAt: string
  expiresAt: string
  indexSnapshot: TrashIndexSnapshot | null
  beforeSource: Record<string, unknown> | null
}

export type TrashRecordSummary = Omit<TrashRecord, 'indexSnapshot' | 'beforeSource'>

export type TrashListInput = {
  connectionId?: string | null
  page?: number
  pageSize?: number
}

export type TrashListResult = {
  records: TrashRecordSummary[]
  total: number
  page: number
  pageSize: number
}

export type TrashRestoreResult = {
  id: string
  kind: TrashRecordKind
  index: string
  documentId: string | null
  message: string
}

export type TrashApi = {
  list: (input?: TrashListInput) => Promise<TrashListResult>
  restore: (id: string) => Promise<TrashRestoreResult>
  remove: (id: string) => Promise<void>
}
