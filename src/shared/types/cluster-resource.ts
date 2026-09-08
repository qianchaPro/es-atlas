export const CLUSTER_RESOURCE_KINDS = [
  'node',
  'task',
  'index-template',
  'component-template',
  'data-stream',
  'snapshot',
  'ingest-pipeline',
  'stored-script'
] as const

export type ClusterResourceKind = (typeof CLUSTER_RESOURCE_KINDS)[number]

export type ClusterResourceValue =
  | null
  | boolean
  | number
  | string
  | ClusterResourceValue[]
  | { [key: string]: ClusterResourceValue }

export type ClusterResourceAccessState = 'available' | 'forbidden' | 'unsupported'

export type ClusterResourceAccess = {
  state: ClusterResourceAccessState
  capability: string
  reason: string | null
}

export type ClusterTaskState =
  | 'waiting'
  | 'running'
  | 'completed'
  | 'canceling'
  | 'canceled'
  | 'failed'

export type ClusterResourceFact = {
  key: string
  value: string | number | boolean | null
}

export type ClusterResourceItem = {
  id: string
  name: string
  status: string | null
  summary: string | null
  updatedAt: string | null
  taskState?: ClusterTaskState
  facts: ClusterResourceFact[]
}

export type ClusterResourceOperationAction =
  | 'create-index-template'
  | 'update-index-template'
  | 'delete-index-template'
  | 'create-component-template'
  | 'update-component-template'
  | 'delete-component-template'
  | 'create-data-stream'
  | 'delete-data-stream'
  | 'create-snapshot'
  | 'delete-snapshot'
  | 'restore-snapshot'
  | 'create-ingest-pipeline'
  | 'update-ingest-pipeline'
  | 'delete-ingest-pipeline'
  | 'create-stored-script'
  | 'update-stored-script'
  | 'delete-stored-script'
  | 'cancel-task'

export type ClusterResourceOperationCapability = {
  action: ClusterResourceOperationAction
  state: ClusterResourceAccessState
  reason: string | null
  impactScope: string
  destructive: boolean
}

export type ClusterResourceListInput = {
  connectionId: string
  kind: ClusterResourceKind
}

export type ClusterResourceListResult = {
  connectionId: string
  kind: ClusterResourceKind
  collectedAt: string
  access: ClusterResourceAccess
  items: ClusterResourceItem[]
  operations: ClusterResourceOperationCapability[]
}

export type ClusterResourceDetailInput = ClusterResourceListInput & {
  resourceId: string
}

export type ClusterResourceDetail = {
  connectionId: string
  kind: ClusterResourceKind
  resourceId: string
  collectedAt: string
  access: ClusterResourceAccess
  document: ClusterResourceValue
}

export type ClusterResourceOperationRequest = {
  requestId: string
  connectionId: string
  connectionName: string
  kind: ClusterResourceKind
  action: ClusterResourceOperationAction
  resourceId: string | null
  resourceName: string
  impactScope: string
  destructive: boolean
  payload: ClusterResourceValue | null
}

export type ClusterResourceOperationResult = {
  requestId: string
  connectionId: string
  kind: ClusterResourceKind
  action: ClusterResourceOperationAction
  state: 'completed' | 'accepted' | 'failed'
  taskId: string | null
  traceId: string
  message: string
}

export type ClusterResourceErrorCode =
  | 'FORBIDDEN'
  | 'UNSUPPORTED'
  | 'UNAUTHORIZED'
  | 'NOT_FOUND'
  | 'TIMEOUT'
  | 'NETWORK'
  | 'INVALID_RESPONSE'
  | 'CONTEXT_MISMATCH'
  | 'UNKNOWN'

export type ClusterResourceError = {
  code: ClusterResourceErrorCode
  message: string
  statusCode: number | null
  capability: string | null
}

export type ClusterResourceApi = {
  list: (input: ClusterResourceListInput) => Promise<ClusterResourceListResult>
  getDetail: (input: ClusterResourceDetailInput) => Promise<ClusterResourceDetail>
  executeOperation: (
    input: ClusterResourceOperationRequest
  ) => Promise<ClusterResourceOperationResult>
}

export type ClusterResourceLoadState =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'empty'
  | 'forbidden'
  | 'unsupported'
  | 'error'

export type ClusterResourceCollectionState = {
  connectionId: string
  kind: ClusterResourceKind
  loadState: ClusterResourceLoadState
  access: ClusterResourceAccess | null
  items: ClusterResourceItem[]
  operations: ClusterResourceOperationCapability[]
  collectedAt: string | null
  stale: boolean
  error: ClusterResourceError | null
}
