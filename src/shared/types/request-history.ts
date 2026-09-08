export type RequestCategory = 'search' | 'write' | 'other'
export type RequestSource = 'overview' | 'index' | 'connection' | 'other'

export type RequestHistoryRecord = {
  id: string
  connectionId: string
  connectionName: string
  startedAt: string
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  path: string
  category: RequestCategory
  source: RequestSource
  successful: boolean
  statusCode: number | null
  errorCode: string | null
  durationMs: number
}

export type RequestTrendBucket = {
  startedAt: string
  searchCount: number
  writeCount: number
}

export type RequestMetricsSnapshot = {
  windowSeconds: number
  searchQps: number | null
  writeQps: number | null
  searchP95Ms: number | null
  errorRate: number | null
  trend: RequestTrendBucket[]
}

export type RequestHistoryConnectionOption = {
  id: string
  name: string
}

export type RequestHistoryQuery = {
  connectionId: string | null
  startedAt: string | null
  endedAt: string | null
  page: number
  pageSize: number
}

export type RequestHistoryPage = {
  records: RequestHistoryRecord[]
  total: number
  page: number
  pageSize: number
  connections: RequestHistoryConnectionOption[]
}

export type RequestHistoryApi = {
  list: (query: RequestHistoryQuery) => Promise<RequestHistoryPage>
}
