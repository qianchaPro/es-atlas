import type {
  ClusterResourceCollectionState,
  ClusterResourceError,
  ClusterResourceErrorCode,
  ClusterResourceItem,
  ClusterResourceKind,
  ClusterResourceListResult,
  ClusterResourceOperationCapability,
  ClusterResourceOperationRequest,
  ClusterResourceValue
} from '../../../shared/types/cluster-resource'

export type CreateClusterResourceOperationInput = {
  requestId: string
  connectionId: string
  connectionName: string
  kind: ClusterResourceKind
  capability: ClusterResourceOperationCapability
  resource: ClusterResourceItem | null
  resourceName: string
  payload: ClusterResourceValue | null
  readOnly: boolean
}

const OPERATION_RESOURCE_KINDS: Record<
  ClusterResourceOperationCapability['action'],
  ClusterResourceKind
> = {
  'create-index-template': 'index-template',
  'update-index-template': 'index-template',
  'delete-index-template': 'index-template',
  'create-component-template': 'component-template',
  'update-component-template': 'component-template',
  'delete-component-template': 'component-template',
  'create-data-stream': 'data-stream',
  'delete-data-stream': 'data-stream',
  'create-snapshot': 'snapshot',
  'delete-snapshot': 'snapshot',
  'restore-snapshot': 'snapshot',
  'create-ingest-pipeline': 'ingest-pipeline',
  'update-ingest-pipeline': 'ingest-pipeline',
  'delete-ingest-pipeline': 'ingest-pipeline',
  'create-stored-script': 'stored-script',
  'update-stored-script': 'stored-script',
  'delete-stored-script': 'stored-script',
  'cancel-task': 'task'
}

const CREATE_OPERATIONS = new Set<ClusterResourceOperationCapability['action']>([
  'create-index-template',
  'create-component-template',
  'create-data-stream',
  'create-snapshot',
  'create-ingest-pipeline',
  'create-stored-script'
])

const ERROR_CODES = new Set<ClusterResourceErrorCode>([
  'FORBIDDEN',
  'UNSUPPORTED',
  'UNAUTHORIZED',
  'NOT_FOUND',
  'TIMEOUT',
  'NETWORK',
  'INVALID_RESPONSE',
  'CONTEXT_MISMATCH',
  'UNKNOWN'
])

export function createClusterResourceCollectionState(
  connectionId: string,
  kind: ClusterResourceKind
): ClusterResourceCollectionState {
  return {
    connectionId,
    kind,
    loadState: 'idle',
    access: null,
    items: [],
    operations: [],
    collectedAt: null,
    stale: false,
    error: null
  }
}

export function beginClusterResourceLoad(
  state: ClusterResourceCollectionState
): ClusterResourceCollectionState {
  return {
    ...state,
    loadState: 'loading',
    error: null
  }
}

export function applyClusterResourceListResult(
  state: ClusterResourceCollectionState,
  result: ClusterResourceListResult
): ClusterResourceCollectionState {
  if (result.connectionId !== state.connectionId || result.kind !== state.kind) {
    throw new TypeError(
      `集群资源响应上下文不匹配：期望 connectionId=${state.connectionId}, kind=${state.kind}，` +
      `实际 connectionId=${result.connectionId}, kind=${result.kind}`
    )
  }

  if (result.access.state !== 'available') {
    return {
      ...state,
      loadState: result.access.state,
      access: result.access,
      operations: result.operations,
      collectedAt: result.collectedAt,
      stale: state.items.length > 0,
      error: null
    }
  }

  return {
    ...state,
    loadState: result.items.length > 0 ? 'ready' : 'empty',
    access: result.access,
    items: [...result.items],
    operations: [...result.operations],
    collectedAt: result.collectedAt,
    stale: false,
    error: null
  }
}

export function applyClusterResourceLoadError(
  state: ClusterResourceCollectionState,
  error: unknown
): ClusterResourceCollectionState {
  const normalizedError = normalizeClusterResourceError(error)
  const loadState = normalizedError.code === 'FORBIDDEN'
    ? 'forbidden'
    : normalizedError.code === 'UNSUPPORTED'
      ? 'unsupported'
      : 'error'

  return {
    ...state,
    loadState,
    stale: state.items.length > 0,
    error: normalizedError
  }
}

export function normalizeClusterResourceError(error: unknown): ClusterResourceError {
  if (isRecord(error)) {
    const statusCode = typeof error.statusCode === 'number' ? error.statusCode : null
    const rawCode = typeof error.code === 'string' ? error.code : ''
    const code = statusCode === 403
      ? 'FORBIDDEN'
      : ERROR_CODES.has(rawCode as ClusterResourceErrorCode)
        ? rawCode as ClusterResourceErrorCode
        : 'UNKNOWN'
    return {
      code,
      message: typeof error.message === 'string' && error.message
        ? error.message
        : '集群资源请求失败',
      statusCode,
      capability: typeof error.capability === 'string' ? error.capability : null
    }
  }
  return {
    code: 'UNKNOWN',
    message: error instanceof Error && error.message ? error.message : '集群资源请求失败',
    statusCode: null,
    capability: null
  }
}

export function canCancelClusterTask(resource: ClusterResourceItem): boolean {
  return resource.taskState === 'waiting' || resource.taskState === 'running'
}

export function canExecuteClusterResourceOperation(
  readOnly: boolean,
  capability: ClusterResourceOperationCapability | undefined
): boolean {
  return !readOnly && capability?.state === 'available'
}

export function createClusterResourceOperationRequest(
  input: CreateClusterResourceOperationInput
): ClusterResourceOperationRequest {
  requireNonEmptyString(input.requestId, 'requestId')
  requireNonEmptyString(input.connectionId, 'connectionId')
  requireNonEmptyString(input.connectionName, 'connectionName')
  requireNonEmptyString(input.resourceName, 'resourceName')
  requireNonEmptyString(input.capability.impactScope, 'impactScope')

  if (input.readOnly) {
    throw new Error(`集群资源写操作已禁用：connectionId=${input.connectionId} 为只读连接`)
  }
  if (input.capability.state !== 'available') {
    throw new Error(
      `集群资源写操作能力不可用：action=${input.capability.action}，` +
      `reason=${input.capability.reason ?? '未提供原因'}`
    )
  }
  const expectedKind = OPERATION_RESOURCE_KINDS[input.capability.action]
  if (expectedKind !== input.kind) {
    throw new Error(
      `集群资源写操作资源类型不匹配：action=${input.capability.action}，` +
      `expectedKind=${expectedKind}，actualKind=${input.kind}`
    )
  }
  if (!CREATE_OPERATIONS.has(input.capability.action) && !input.resource) {
    throw new Error(`集群资源写操作缺少目标资源：action=${input.capability.action}`)
  }
  if (
    input.capability.action === 'cancel-task' &&
    input.resource &&
    !canCancelClusterTask(input.resource)
  ) {
    throw new Error(
      `任务状态不允许取消：taskId=${input.resource.id}，state=${input.resource.taskState ?? 'unknown'}`
    )
  }

  return {
    requestId: input.requestId,
    connectionId: input.connectionId,
    connectionName: input.connectionName,
    kind: input.kind,
    action: input.capability.action,
    resourceId: input.resource?.id ?? null,
    resourceName: input.resourceName,
    impactScope: input.capability.impactScope,
    destructive: input.capability.destructive,
    payload: cloneOperationPayload(input.payload)
  }
}

function cloneOperationPayload(payload: ClusterResourceValue | null): ClusterResourceValue | null {
  if (payload === null) return null
  try {
    return JSON.parse(JSON.stringify(payload)) as ClusterResourceValue
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new TypeError(`集群资源操作参数无法序列化：原因=${reason}`)
  }
}

function requireNonEmptyString(value: string, field: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`集群资源操作参数无效：${field} 必须是非空字符串`)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
