import type { CapabilityDecision } from './capability'

export type ClusterOperationJson =
  | null
  | boolean
  | number
  | string
  | ClusterOperationJson[]
  | { [key: string]: ClusterOperationJson }

export type ClusterOperationJsonObject = { [key: string]: ClusterOperationJson }

export type ClusterOperationStatus = 'running' | 'completed' | 'failed' | 'canceled'

export type AsyncSearchPathPrefix =
  | '/_async_search'
  | '/_plugins/_asynchronous_search'

export type ReindexSubmitInput = {
  requestId: string
  connectionId: string
  sourceIndex: string
  destinationIndex: string
  query?: ClusterOperationJsonObject
  conflicts?: 'abort' | 'proceed'
  destinationOperation?: 'index' | 'create'
}

export type AsyncSearchSubmitInput = {
  requestId: string
  connectionId: string
  pathPrefix: AsyncSearchPathPrefix
  index: string
  query: ClusterOperationJsonObject
  keepAlive?: string
  waitForCompletionTimeout?: string
  keepOnCompletion?: boolean
}

export type AsyncSearchGetInput = {
  requestId: string
  connectionId: string
  pathPrefix: AsyncSearchPathPrefix
  taskId: string
  keepAlive?: string
  waitForCompletionTimeout?: string
}

export type AsyncSearchDeleteInput = {
  requestId: string
  connectionId: string
  pathPrefix: AsyncSearchPathPrefix
  taskId: string
}

export type ClusterOperationResult = {
  requestId: string
  taskId: string | null
  status: ClusterOperationStatus
  payload: ClusterOperationJsonObject
}

export type ClusterOperationErrorCode =
  | 'VALIDATION'
  | 'READ_ONLY'
  | 'UNSUPPORTED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'TIMEOUT'
  | 'INVALID_RESPONSE'
  | 'REQUEST_FAILED'

export type ClusterOperationCapabilities = {
  connectionId: string
  readOnly: boolean
  reindex: CapabilityDecision
  asyncSearch: CapabilityDecision
  asyncSearchPathPrefix: AsyncSearchPathPrefix | null
}

export type ClusterOperationApi = {
  getCapabilities: (connectionId: string) => Promise<ClusterOperationCapabilities>
  submitReindex: (input: ReindexSubmitInput) => Promise<ClusterOperationResult>
  submitAsyncSearch: (input: AsyncSearchSubmitInput) => Promise<ClusterOperationResult>
  getAsyncSearch: (input: AsyncSearchGetInput) => Promise<ClusterOperationResult>
  deleteAsyncSearch: (input: AsyncSearchDeleteInput) => Promise<ClusterOperationResult>
}
