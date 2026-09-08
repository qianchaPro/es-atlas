import type {
  RestCancelInput,
  RestCancelResult,
  RestErrorKind,
  RestExecuteInput,
  RestExecuteResult,
  RestExecutionError,
  RestRequest,
  RestRequestMethod
} from '../../../src/shared/types/rest'

type RestRequestOptions = {
  method?: RestRequestMethod
  body?: string
  contentType?: 'application/json' | 'application/x-ndjson'
}

export type RestConnectionService = {
  assertConnected: (connectionId: string) => string
  requestJson: <T>(
    connectionId: string,
    requestPath: string,
    options?: RestRequestOptions
  ) => Promise<T>
}

type NormalizedRestExecuteInput = Omit<RestExecuteInput, 'request'> & {
  request: RestRequest
}

type RequestOutcome =
  | { type: 'success'; body: unknown }
  | { type: 'failure'; error: unknown }
  | { type: 'canceled' }

type ActiveRequest = {
  cancel: () => void
}

const MAX_IDENTIFIER_LENGTH = 160
const MAX_REQUEST_PATH_LENGTH = 8_192
const MAX_REQUEST_BODY_BYTES = 5 * 1024 * 1024
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u
const IDENTIFIER_PATTERN = /^[A-Za-z0-9._:-]+$/u
const TIMEOUT_MESSAGE_PATTERN = /(?:timeout|timed out|超时|请求超过)/iu
const TLS_MESSAGE_PATTERN = /(?:tls|ssl|certificate|证书)/iu
const SSH_MESSAGE_PATTERN = /(?:ssh|隧道)/iu

export class RestExecutorError extends Error {
  readonly code: string
  readonly kind: RestErrorKind
  readonly statusCode: number | null

  constructor(
    code: string,
    kind: RestErrorKind,
    reason: string,
    statusCode: number | null = null
  ) {
    super(`REST 模块失败：原因=${reason}`)
    this.name = 'RestExecutorError'
    this.code = code
    this.kind = kind
    this.statusCode = statusCode
  }
}

export class RestExecutor {
  private readonly activeRequests = new Map<string, ActiveRequest>()
  private readonly connectionService: RestConnectionService

  constructor(connectionService: RestConnectionService) {
    this.connectionService = connectionService
  }

  async execute(input: RestExecuteInput): Promise<RestExecuteResult> {
    const startedAtMs = Date.now()
    let normalizedInput: NormalizedRestExecuteInput
    try {
      normalizedInput = normalizeExecuteInput(input)
      normalizedInput.connectionId = this.connectionService.assertConnected(
        normalizedInput.connectionId
      )
      if (this.activeRequests.has(normalizedInput.requestId)) {
        throw new RestExecutorError(
          'REST_DUPLICATE_REQUEST_ID',
          'validation',
          `requestId=${normalizedInput.requestId} 正在执行`
        )
      }
    } catch (error: unknown) {
      return createFailureResult(input, startedAtMs, error)
    }

    let cancelRequest: (() => void) | null = null
    const cancellation = new Promise<RequestOutcome>((resolve) => {
      let canceled = false
      cancelRequest = () => {
        if (canceled) return
        canceled = true
        resolve({ type: 'canceled' })
      }
    })
    this.activeRequests.set(normalizedInput.requestId, {
      cancel: () => cancelRequest?.()
    })

    const requestOptions = createRequestOptions(normalizedInput.request)
    const execution: Promise<RequestOutcome> = this.connectionService.requestJson<unknown>(
      normalizedInput.connectionId,
      normalizedInput.request.path,
      requestOptions
    ).then(
      (body): RequestOutcome => ({ type: 'success', body }),
      (error: unknown): RequestOutcome => ({ type: 'failure', error })
    )

    try {
      const outcome = await Promise.race([execution, cancellation])
      if (outcome.type === 'canceled') {
        return createCanceledResult(normalizedInput, startedAtMs)
      }
      if (outcome.type === 'failure') {
        return createFailureResult(normalizedInput, startedAtMs, outcome.error)
      }
      return createSuccessResult(normalizedInput, startedAtMs, outcome.body)
    } finally {
      this.activeRequests.delete(normalizedInput.requestId)
    }
  }

  cancel(input: RestCancelInput): RestCancelResult {
    const requestId = normalizeIdentifier(input?.requestId, 'requestId')
    const activeRequest = this.activeRequests.get(requestId)
    activeRequest?.cancel()
    return { requestId, canceled: Boolean(activeRequest) }
  }
}

function normalizeExecuteInput(input: RestExecuteInput): NormalizedRestExecuteInput {
  if (!input || typeof input !== 'object') {
    throw new RestExecutorError('REST_INVALID_INPUT', 'validation', '执行参数必须是对象')
  }
  return {
    requestId: normalizeIdentifier(input.requestId, 'requestId'),
    connectionId: normalizeIdentifier(input.connectionId, 'connectionId'),
    tabId: normalizeIdentifier(input.tabId, 'tabId'),
    request: normalizeRequest(input.request)
  }
}

function normalizeIdentifier(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    !IDENTIFIER_PATTERN.test(value)
  ) {
    throw new RestExecutorError(
      'REST_INVALID_IDENTIFIER',
      'validation',
      `${field} 必须是 1-${MAX_IDENTIFIER_LENGTH} 位字母、数字、点、冒号、下划线或连字符`
    )
  }
  return value
}

function normalizeRequest(value: unknown): RestRequest {
  if (!isRecord(value)) {
    throw new RestExecutorError('REST_INVALID_REQUEST', 'validation', 'request 必须是对象')
  }
  const method = normalizeMethod(value.method)
  const path = normalizePath(value.path)
  const body = normalizeBody(value.body)
  return { method, path, body }
}

function normalizeMethod(value: unknown): RestRequestMethod {
  if (value === 'GET' || value === 'POST' || value === 'PUT' || value === 'DELETE') {
    return value
  }
  throw new RestExecutorError(
    'REST_INVALID_METHOD',
    'validation',
    `method 仅支持 GET、POST、PUT、DELETE，当前值=${String(value)}`
  )
}

function normalizePath(value: unknown): string {
  const path = typeof value === 'string' ? value.trim() : ''
  if (!path || !path.startsWith('/') || path.startsWith('//')) {
    throw new RestExecutorError(
      'REST_INVALID_PATH',
      'validation',
      'path 必须是以单个 / 开头的集群相对路径'
    )
  }
  if (
    path.length > MAX_REQUEST_PATH_LENGTH ||
    CONTROL_CHARACTERS.test(path) ||
    path.includes('#')
  ) {
    throw new RestExecutorError(
      'REST_INVALID_PATH',
      'validation',
      `path 不能包含控制字符或片段，且长度不能超过 ${MAX_REQUEST_PATH_LENGTH}`
    )
  }
  return path
}

function normalizeBody(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string') {
    throw new RestExecutorError('REST_INVALID_BODY', 'validation', 'body 必须是 JSON 字符串或 null')
  }
  if (Buffer.byteLength(value, 'utf8') > MAX_REQUEST_BODY_BYTES) {
    throw new RestExecutorError(
      'REST_REQUEST_BODY_TOO_LARGE',
      'validation',
      `body 不能超过 ${MAX_REQUEST_BODY_BYTES} 字节`
    )
  }
  try {
    JSON.parse(value)
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new RestExecutorError('REST_INVALID_JSON_BODY', 'validation', `body 不是有效 JSON：${reason}`)
  }
  return value
}

function createRequestOptions(request: RestRequest): RestRequestOptions {
  if (request.body === null) return { method: request.method }
  return {
    method: request.method,
    body: request.body,
    contentType: 'application/json'
  }
}

function createSuccessResult(
  input: NormalizedRestExecuteInput,
  startedAtMs: number,
  body: unknown
): RestExecuteResult {
  return createResultBase(input, startedAtMs, {
    state: 'success',
    statusCode: null,
    dataFormat: 'json',
    body,
    error: null
  })
}

function createCanceledResult(
  input: NormalizedRestExecuteInput,
  startedAtMs: number
): RestExecuteResult {
  const error: RestExecutionError = {
    kind: 'canceled',
    code: 'REST_REQUEST_CANCELED',
    message: `REST 请求已取消：requestId=${input.requestId}`,
    statusCode: null
  }
  return createResultBase(input, startedAtMs, {
    state: 'canceled',
    statusCode: null,
    dataFormat: null,
    body: null,
    error
  })
}

function createFailureResult(
  input: RestExecuteInput | NormalizedRestExecuteInput,
  startedAtMs: number,
  error: unknown
): RestExecuteResult {
  const executionError = toExecutionError(error)
  return createResultBase(
    {
      requestId: readDiagnosticIdentifier(input?.requestId),
      connectionId: readDiagnosticIdentifier(input?.connectionId),
      tabId: readDiagnosticIdentifier(input?.tabId),
      request: { method: 'GET', path: '/', body: null }
    },
    startedAtMs,
    {
      state: executionError.kind === 'timeout' ? 'timed-out' : 'failed',
      statusCode: executionError.statusCode,
      dataFormat: null,
      body: null,
      error: executionError
    }
  )
}

function createResultBase(
  input: NormalizedRestExecuteInput,
  startedAtMs: number,
  outcome: Pick<
    RestExecuteResult,
    'state' | 'statusCode' | 'dataFormat' | 'body' | 'error'
  >
): RestExecuteResult {
  const completedAtMs = Date.now()
  return {
    requestId: input.requestId,
    connectionId: input.connectionId,
    tabId: input.tabId,
    ...outcome,
    startedAt: new Date(startedAtMs).toISOString(),
    completedAt: new Date(completedAtMs).toISOString(),
    durationMs: Math.max(0, completedAtMs - startedAtMs),
    headers: [],
    truncated: false
  }
}

function toExecutionError(error: unknown): RestExecutionError {
  if (error instanceof RestExecutorError) {
    return {
      kind: error.kind,
      code: error.code,
      message: error.message,
      statusCode: error.statusCode
    }
  }
  const statusCode = readStatusCode(error)
  const code = readErrorCode(error)
  const message = error instanceof Error ? error.message : String(error)
  return {
    kind: classifyError(code, statusCode, message),
    code,
    message: `REST 请求执行失败：${message}`,
    statusCode
  }
}

function classifyError(code: string, statusCode: number | null, message: string): RestErrorKind {
  if (statusCode === 401) return 'unauthorized'
  if (statusCode === 403) return 'forbidden'
  if (statusCode === 404) return 'not-found'
  if (statusCode === 429) return 'rate-limited'
  if (statusCode !== null && statusCode >= 500) return 'server'
  if (code === 'CONNECTION_READ_ONLY') return 'read-only'
  if (code.includes('TIMEOUT') || TIMEOUT_MESSAGE_PATTERN.test(message)) return 'timeout'
  if (code.includes('TLS') || TLS_MESSAGE_PATTERN.test(message)) return 'tls'
  if (code.includes('SSH') || SSH_MESSAGE_PATTERN.test(message)) return 'ssh'
  if (code.includes('NETWORK')) return 'network'
  if (code.startsWith('CONNECTION_')) return 'connection'
  return 'unknown'
}

function readStatusCode(error: unknown): number | null {
  if (!isRecord(error)) return null
  return typeof error.statusCode === 'number' && Number.isInteger(error.statusCode)
    ? error.statusCode
    : null
}

function readErrorCode(error: unknown): string {
  if (!isRecord(error) || typeof error.code !== 'string' || !error.code) {
    return 'REST_EXECUTION_FAILED'
  }
  return error.code
}

function readDiagnosticIdentifier(value: unknown): string {
  return typeof value === 'string' ? value.slice(0, MAX_IDENTIFIER_LENGTH) : ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
