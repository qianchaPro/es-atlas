export type RestRequestMethod = 'GET' | 'POST' | 'PUT' | 'DELETE'

export type RestRequestState =
  | 'draft'
  | 'running'
  | 'success'
  | 'failed'
  | 'canceled'
  | 'timed-out'

export type RestErrorKind =
  | 'validation'
  | 'read-only'
  | 'unauthorized'
  | 'forbidden'
  | 'not-found'
  | 'rate-limited'
  | 'server'
  | 'tls'
  | 'ssh'
  | 'network'
  | 'timeout'
  | 'canceled'
  | 'connection'
  | 'unknown'

export type RestRequest = {
  method: RestRequestMethod
  path: string
  body: string | null
}

export type RestExecuteInput = {
  requestId: string
  connectionId: string
  tabId: string
  request: RestRequest
}

export type RestResponseHeader = {
  name: string
  value: string
}

export type RestExecutionError = {
  kind: RestErrorKind
  code: string
  message: string
  statusCode: number | null
}

export type RestExecuteResult = {
  requestId: string
  connectionId: string
  tabId: string
  state: Exclude<RestRequestState, 'draft' | 'running'>
  startedAt: string
  completedAt: string
  durationMs: number
  statusCode: number | null
  headers: RestResponseHeader[]
  dataFormat: 'json' | null
  body: unknown
  truncated: boolean
  error: RestExecutionError | null
}

export type RestCancelInput = {
  requestId: string
}

export type RestCancelResult = {
  requestId: string
  canceled: boolean
}

export type RestApi = {
  execute: (input: RestExecuteInput) => Promise<RestExecuteResult>
  cancel: (input: RestCancelInput) => Promise<RestCancelResult>
}
