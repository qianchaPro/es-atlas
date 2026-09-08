import type {
  AsyncSearchDeleteInput,
  AsyncSearchGetInput,
  AsyncSearchPathPrefix,
  AsyncSearchSubmitInput,
  ClusterOperationCapabilities,
  ClusterOperationErrorCode,
  ClusterOperationJson,
  ClusterOperationJsonObject,
  ClusterOperationResult,
  ClusterOperationStatus,
  ReindexSubmitInput
} from '../../../src/shared/types/cluster-operation'
import type { CapabilityDecision, CapabilityKey, CapabilityMatrix } from '../../../src/shared/types/capability'
import type { ConnectionSummary } from '../../../src/shared/types/connection'
// Node 内置 TypeScript 测试器需要显式扩展名，Electron Vite 同样可以解析该源文件。
// @ts-expect-error TypeScript 测试运行时直接加载 .ts 源文件
import { createCapabilityMatrix } from './capability-matrix.ts'

type OperationRequestOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  body?: string
  contentType?: 'application/json' | 'application/x-ndjson'
}

export type OperationConnectionService = {
  assertConnected: (connectionId: string) => string
  list: () => ConnectionSummary[]
  requestJson: <T>(
    connectionId: string,
    requestPath: string,
    options?: OperationRequestOptions
  ) => Promise<T>
}

type NormalizedContext = {
  requestId: string
  connectionId: string
}

type OperationCapabilityContext = {
  connection: ConnectionSummary
  matrix: CapabilityMatrix
}

type ErrorWithContext = {
  code?: unknown
  statusCode?: unknown
  message?: unknown
}

const REINDEX_PATH = '/_reindex?wait_for_completion=false'
const ELASTICSEARCH_ASYNC_PREFIX: AsyncSearchPathPrefix = '/_async_search'
const OPENSEARCH_ASYNC_PREFIX: AsyncSearchPathPrefix = '/_plugins/_asynchronous_search'
const MAX_IDENTIFIER_LENGTH = 160
const MAX_RESOURCE_LENGTH = 8_192
const MAX_INDEX_LENGTH = 1_024
const MAX_QUERY_BYTES = 5 * 1024 * 1024
const MAX_JSON_DEPTH = 64
const IDENTIFIER_PATTERN = /^[A-Za-z0-9._:-]+$/u
const TIME_VALUE_PATTERN = /^\d+(?:\.\d+)?(?:ms|s|m|h|d)$/u
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u
const TIMEOUT_MESSAGE_PATTERN = /(?:timeout|timed out|超时|请求超过)/iu

export class OperationServiceError extends Error {
  readonly code: ClusterOperationErrorCode
  readonly connectionId: string | null
  readonly operation: string
  readonly statusCode: number | null

  constructor(
    code: ClusterOperationErrorCode,
    connectionId: string | null,
    operation: string,
    reason: string,
    statusCode: number | null = null,
    options?: ErrorOptions
  ) {
    super(
      `集群长任务模块失败：connectionId=${connectionId ?? '未提供'}，操作=${operation}，原因=${reason}`,
      options
    )
    this.name = 'OperationServiceError'
    this.code = code
    this.connectionId = connectionId
    this.operation = operation
    this.statusCode = statusCode
  }
}

export class OperationService {
  private readonly connectionService: OperationConnectionService

  constructor(connectionService: OperationConnectionService) {
    this.connectionService = connectionService
  }

  getCapabilities(connectionIdInput: string): ClusterOperationCapabilities {
    const connectionId = this.connectionService.assertConnected(connectionIdInput)
    const context = this.createCapabilityContext(connectionId)
    const endpoint = context.matrix.capabilities.asyncSearch.endpointVariants[0]
    return {
      connectionId,
      readOnly: context.connection.readOnly,
      reindex: context.matrix.capabilities.reindex,
      asyncSearch: context.matrix.capabilities.asyncSearch,
      asyncSearchPathPrefix: isAsyncSearchPathPrefix(endpoint) ? endpoint : null
    }
  }

  async submitReindex(input: ReindexSubmitInput): Promise<ClusterOperationResult> {
    const context = normalizeContext(input)
    this.assertCapability(context.connectionId, 'reindex', true)
    const sourceIndex = normalizeIndex(input?.sourceIndex, '源索引', context)
    const destinationIndex = normalizeIndex(input?.destinationIndex, '目标索引', context)
    const query = input.query === undefined
      ? undefined
      : normalizeJsonObject(input.query, 'query', context)
    const conflicts = normalizeConflicts(input.conflicts, context)
    const destinationOperation = normalizeDestinationOperation(
      input.destinationOperation,
      context
    )
    const source: ClusterOperationJsonObject = { index: sourceIndex }
    if (query !== undefined) source.query = query
    const destination: ClusterOperationJsonObject = { index: destinationIndex }
    if (destinationOperation !== undefined) destination.op_type = destinationOperation
    const body: ClusterOperationJsonObject = { source, dest: destination }
    if (conflicts !== undefined) body.conflicts = conflicts

    const response = await this.requestJson<unknown>(
      context.connectionId,
      REINDEX_PATH,
      {
        method: 'POST',
        body: serializeBody(body, context, 'Reindex'),
        contentType: 'application/json'
      },
      'Reindex'
    )
    const payload = normalizeResponse(response, context, 'Reindex')
    const taskId = readNonEmptyString(payload.task)
    if (!taskId) {
      throw createInvalidResponseError(context, 'Reindex', '响应缺少 task')
    }

    return {
      requestId: context.requestId,
      taskId,
      status: 'running',
      payload
    }
  }

  async submitAsyncSearch(input: AsyncSearchSubmitInput): Promise<ClusterOperationResult> {
    const context = normalizeContext(input)
    const decision = this.assertCapability(context.connectionId, 'asyncSearch', true)
    const pathPrefix = normalizePathPrefix(input?.pathPrefix, context)
    assertCapabilityPath(pathPrefix, decision, context)
    const index = normalizeIndex(input?.index, '索引', context)
    const query = normalizeJsonObject(input?.query, 'query', context)
    const parameters = createAsyncParameters(input, context)
    const path = createAsyncSubmitPath(pathPrefix, index, parameters)
    const response = await this.requestJson<unknown>(
      context.connectionId,
      path,
      {
        method: 'POST',
        body: serializeBody(query, context, 'Async Search submit'),
        contentType: 'application/json'
      },
      'Async Search submit'
    )
    return createAsyncResult(context, response, 'Async Search submit')
  }

  async getAsyncSearch(input: AsyncSearchGetInput): Promise<ClusterOperationResult> {
    const context = normalizeContext(input)
    const decision = this.assertCapability(context.connectionId, 'asyncSearch', false)
    const pathPrefix = normalizePathPrefix(input?.pathPrefix, context)
    assertCapabilityPath(pathPrefix, decision, context)
    const taskId = normalizeResource(input?.taskId, 'taskId', context)
    const parameters = createAsyncParameters(input, context)
    const path = appendParameters(`${pathPrefix}/${encodeResource(taskId)}`, parameters)
    const response = await this.requestJson<unknown>(
      context.connectionId,
      path,
      { method: 'GET' },
      'Async Search get'
    )
    return createAsyncResult(context, response, 'Async Search get', taskId)
  }

  async deleteAsyncSearch(input: AsyncSearchDeleteInput): Promise<ClusterOperationResult> {
    const context = normalizeContext(input)
    const decision = this.assertCapability(context.connectionId, 'asyncSearch', true)
    const pathPrefix = normalizePathPrefix(input?.pathPrefix, context)
    assertCapabilityPath(pathPrefix, decision, context)
    const taskId = normalizeResource(input?.taskId, 'taskId', context)
    const response = await this.requestJson<unknown>(
      context.connectionId,
      `${pathPrefix}/${encodeResource(taskId)}`,
      { method: 'DELETE' },
      'Async Search delete'
    )
    const payload = normalizeResponse(response, context, 'Async Search delete')
    if (payload.acknowledged !== true && payload.acknowledged !== 'true') {
      throw createInvalidResponseError(
        context,
        'Async Search delete',
        '响应未确认删除或取消'
      )
    }
    return {
      requestId: context.requestId,
      taskId,
      status: 'canceled',
      payload
    }
  }

  private async requestJson<T>(
    connectionId: string,
    path: string,
    options: OperationRequestOptions,
    operation: string
  ): Promise<T> {
    try {
      const connectedId = this.connectionService.assertConnected(connectionId)
      return await this.connectionService.requestJson<T>(connectedId, path, options)
    } catch (error: unknown) {
      if (error instanceof OperationServiceError) throw error
      throw normalizeRequestError(error, connectionId, operation)
    }
  }

  private createCapabilityContext(connectionId: string): OperationCapabilityContext {
    const connection = this.connectionService.list().find((item) => item.id === connectionId)
    if (!connection) {
      throw new OperationServiceError(
        'VALIDATION',
        connectionId,
        '读取连接能力',
        '找不到已连接配置'
      )
    }
    return {
      connection,
      matrix: createCapabilityMatrix({
        engine: connection.engine,
        version: connection.version,
        mode: connection.mode
      })
    }
  }

  private assertCapability(
    connectionId: string,
    capabilityKey: Extract<CapabilityKey, 'reindex' | 'asyncSearch'>,
    requiresWrite: boolean
  ): CapabilityDecision {
    const connectedId = this.connectionService.assertConnected(connectionId)
    const context = this.createCapabilityContext(connectedId)
    const decision = context.matrix.capabilities[capabilityKey]
    if (requiresWrite && context.connection.readOnly) {
      throw new OperationServiceError(
        'READ_ONLY',
        connectedId,
        `校验 ${capabilityKey} 能力`,
        '当前连接已开启只读模式'
      )
    }
    if (!decision.supported || (requiresWrite && !decision.writeSupported)) {
      throw new OperationServiceError(
        decision.reasonKind === 'permission-denied' ? 'FORBIDDEN' : 'UNSUPPORTED',
        connectedId,
        `校验 ${capabilityKey} 能力`,
        decision.reason
      )
    }
    return decision
  }
}

function assertCapabilityPath(
  pathPrefix: AsyncSearchPathPrefix,
  decision: CapabilityDecision,
  context: NormalizedContext
): void {
  if (decision.endpointVariants[0] === pathPrefix) return
  throw new OperationServiceError(
    'VALIDATION',
    context.connectionId,
    '校验 Async Search 能力',
    `路径前缀与当前连接能力矩阵不匹配，当前值=${pathPrefix}`
  )
}

function isAsyncSearchPathPrefix(value: string | undefined): value is AsyncSearchPathPrefix {
  return value === ELASTICSEARCH_ASYNC_PREFIX || value === OPENSEARCH_ASYNC_PREFIX
}

function normalizeContext(input: unknown): NormalizedContext {
  if (!isRecord(input)) {
    throw new OperationServiceError('VALIDATION', null, '校验输入', '执行参数必须是对象')
  }
  return {
    requestId: normalizeIdentifier(input.requestId, 'requestId', null),
    connectionId: normalizeIdentifier(input.connectionId, 'connectionId', null)
  }
}

function normalizeIdentifier(value: unknown, field: string, connectionId: string | null): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    !IDENTIFIER_PATTERN.test(value)
  ) {
    throw new OperationServiceError(
      'VALIDATION',
      connectionId,
      '校验输入',
      `${field} 必须是 1-${MAX_IDENTIFIER_LENGTH} 位安全标识符`
    )
  }
  return value
}

function normalizeIndex(value: unknown, field: string, context: NormalizedContext): string {
  const index = typeof value === 'string' ? value.trim() : ''
  if (!index || index.length > MAX_INDEX_LENGTH || CONTROL_CHARACTERS.test(index)) {
    throw new OperationServiceError(
      'VALIDATION',
      context.connectionId,
      '校验输入',
      `${field} 必须是 1-${MAX_INDEX_LENGTH} 位且不含控制字符`
    )
  }
  return index
}

function normalizeResource(value: unknown, field: string, context: NormalizedContext): string {
  const resource = typeof value === 'string' ? value.trim() : ''
  if (!resource || resource.length > MAX_RESOURCE_LENGTH || CONTROL_CHARACTERS.test(resource)) {
    throw new OperationServiceError(
      'VALIDATION',
      context.connectionId,
      '校验输入',
      `${field} 必须是 1-${MAX_RESOURCE_LENGTH} 位且不含控制字符`
    )
  }
  return resource
}

function normalizePathPrefix(value: unknown, context: NormalizedContext): AsyncSearchPathPrefix {
  if (value === ELASTICSEARCH_ASYNC_PREFIX) return ELASTICSEARCH_ASYNC_PREFIX
  if (value === OPENSEARCH_ASYNC_PREFIX) return OPENSEARCH_ASYNC_PREFIX
  throw new OperationServiceError(
    'VALIDATION',
    context.connectionId,
    '校验 Async Search 能力',
    `路径前缀必须来自能力矩阵，当前值=${String(value)}`
  )
}

function normalizeConflicts(
  value: unknown,
  context: NormalizedContext
): 'abort' | 'proceed' | undefined {
  if (value === undefined || value === 'abort' || value === 'proceed') return value
  throw new OperationServiceError(
    'VALIDATION',
    context.connectionId,
    '校验 Reindex',
    `conflicts 仅支持 abort 或 proceed，当前值=${String(value)}`
  )
}

function normalizeDestinationOperation(
  value: unknown,
  context: NormalizedContext
): 'index' | 'create' | undefined {
  if (value === undefined || value === 'index' || value === 'create') return value
  throw new OperationServiceError(
    'VALIDATION',
    context.connectionId,
    '校验 Reindex',
    `destinationOperation 仅支持 index 或 create，当前值=${String(value)}`
  )
}

function normalizeJsonObject(
  value: unknown,
  field: string,
  context: NormalizedContext
): ClusterOperationJsonObject {
  const normalized = normalizeJson(value, field, context, 0)
  if (normalized === null || Array.isArray(normalized) || typeof normalized !== 'object') {
    throw new OperationServiceError(
      'VALIDATION',
      context.connectionId,
      '校验 JSON',
      `${field} 必须是 JSON 对象`
    )
  }
  return normalized
}

function normalizeJson(
  value: unknown,
  field: string,
  context: NormalizedContext,
  depth: number
): ClusterOperationJson {
  if (depth > MAX_JSON_DEPTH) {
    throw new OperationServiceError(
      'VALIDATION',
      context.connectionId,
      '校验 JSON',
      `${field} 超过最大嵌套深度 ${MAX_JSON_DEPTH}`
    )
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) {
    return value.map((item, index) => normalizeJson(item, `${field}[${index}]`, context, depth + 1))
  }
  if (isPlainRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        normalizeJson(item, `${field}.${key}`, context, depth + 1)
      ])
    )
  }
  throw new OperationServiceError(
    'VALIDATION',
    context.connectionId,
    '校验 JSON',
    `${field} 包含非 JSON 值`
  )
}

function createAsyncParameters(
  input: AsyncSearchSubmitInput | AsyncSearchGetInput,
  context: NormalizedContext
): Array<[string, string]> {
  const parameters: Array<[string, string]> = []
  const keepAlive = normalizeTimeValue(input.keepAlive, 'keepAlive', context)
  const waitForCompletionTimeout = normalizeTimeValue(
    input.waitForCompletionTimeout,
    'waitForCompletionTimeout',
    context
  )
  if (keepAlive !== undefined) parameters.push(['keep_alive', keepAlive])
  if (waitForCompletionTimeout !== undefined) {
    parameters.push(['wait_for_completion_timeout', waitForCompletionTimeout])
  }
  if ('keepOnCompletion' in input && input.keepOnCompletion !== undefined) {
    if (typeof input.keepOnCompletion !== 'boolean') {
      throw new OperationServiceError(
        'VALIDATION',
        context.connectionId,
        '校验 Async Search',
        'keepOnCompletion 必须是布尔值'
      )
    }
    parameters.push(['keep_on_completion', String(input.keepOnCompletion)])
  }
  return parameters
}

function normalizeTimeValue(
  value: unknown,
  field: string,
  context: NormalizedContext
): string | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'string' && TIME_VALUE_PATTERN.test(value)) return value
  throw new OperationServiceError(
    'VALIDATION',
    context.connectionId,
    '校验 Async Search',
    `${field} 必须使用 ms、s、m、h 或 d 时间单位`
  )
}

function createAsyncSubmitPath(
  pathPrefix: AsyncSearchPathPrefix,
  index: string,
  parameters: Array<[string, string]>
): string {
  if (pathPrefix === ELASTICSEARCH_ASYNC_PREFIX) {
    return appendParameters(`/${encodeResource(index)}${pathPrefix}`, parameters)
  }
  return appendParameters(pathPrefix, [['index', index], ...parameters])
}

function appendParameters(path: string, parameters: Array<[string, string]>): string {
  if (parameters.length === 0) return path
  const query = parameters
    .map(([key, value]) => `${encodeResource(key)}=${encodeResource(value)}`)
    .join('&')
  return `${path}?${query}`
}

function encodeResource(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/gu, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  )
}

function serializeBody(
  body: ClusterOperationJsonObject,
  context: NormalizedContext,
  operation: string
): string {
  const serialized = JSON.stringify(body)
  if (Buffer.byteLength(serialized, 'utf8') > MAX_QUERY_BYTES) {
    throw new OperationServiceError(
      'VALIDATION',
      context.connectionId,
      operation,
      `JSON 请求体不能超过 ${MAX_QUERY_BYTES} 字节`
    )
  }
  return serialized
}

function createAsyncResult(
  context: NormalizedContext,
  response: unknown,
  operation: string,
  fallbackTaskId: string | null = null
): ClusterOperationResult {
  const payload = normalizeResponse(response, context, operation)
  const taskId = readNonEmptyString(payload.id) ?? fallbackTaskId
  const status = normalizeAsyncStatus(payload, taskId)
  if (status === 'running' && !taskId) {
    throw createInvalidResponseError(context, operation, '运行中响应缺少 id')
  }
  return {
    requestId: context.requestId,
    taskId,
    status,
    payload
  }
}

function normalizeAsyncStatus(
  payload: ClusterOperationJsonObject,
  taskId: string | null
): ClusterOperationStatus {
  if (typeof payload.is_running === 'boolean') {
    return payload.is_running ? 'running' : 'completed'
  }
  const state = readNonEmptyString(payload.state)?.toUpperCase()
  if (state === 'RUNNING' || state === 'PERSISTING') return 'running'
  if (state === 'FAILED' || state === 'PERSIST_FAILED') return 'failed'
  if (state === 'CLOSED') return 'canceled'
  if (
    state === 'SUCCEEDED' ||
    state === 'PERSIST_SUCCEEDED' ||
    state === 'STORE_RESIDENT'
  ) {
    return 'completed'
  }
  return taskId ? 'running' : 'completed'
}

function normalizeResponse(
  value: unknown,
  context: NormalizedContext,
  operation: string
): ClusterOperationJsonObject {
  try {
    return normalizeJsonObject(value, '响应', context)
  } catch (error: unknown) {
    if (error instanceof OperationServiceError) {
      throw createInvalidResponseError(context, operation, error.message, error)
    }
    throw error
  }
}

function createInvalidResponseError(
  context: NormalizedContext,
  operation: string,
  reason: string,
  cause?: unknown
): OperationServiceError {
  return new OperationServiceError(
    'INVALID_RESPONSE',
    context.connectionId,
    operation,
    reason,
    null,
    cause === undefined ? undefined : { cause }
  )
}

function normalizeRequestError(
  error: unknown,
  connectionId: string,
  operation: string
): OperationServiceError {
  const context = isRecord(error) ? error as ErrorWithContext : {}
  const statusCode = typeof context.statusCode === 'number' ? context.statusCode : null
  const code = typeof context.code === 'string' ? context.code : ''
  const message = typeof context.message === 'string' ? context.message : String(error)
  let normalizedCode: ClusterOperationErrorCode = 'REQUEST_FAILED'
  if (code === 'CONNECTION_READ_ONLY') normalizedCode = 'READ_ONLY'
  else if (statusCode === 403) normalizedCode = 'FORBIDDEN'
  else if (statusCode === 404) normalizedCode = 'NOT_FOUND'
  else if (code.includes('TIMEOUT') || TIMEOUT_MESSAGE_PATTERN.test(message)) {
    normalizedCode = 'TIMEOUT'
  }
  return new OperationServiceError(
    normalizedCode,
    connectionId,
    operation,
    message,
    statusCode,
    { cause: error }
  )
}

function readNonEmptyString(value: ClusterOperationJson | undefined): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
