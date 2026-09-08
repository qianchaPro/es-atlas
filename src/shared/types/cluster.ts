import type {
  RequestHistoryRecord,
  RequestTrendBucket
} from './request-history'

export type ClusterHealth = 'green' | 'yellow' | 'red' | 'unknown'

export type ClusterRisk = {
  id: string
  level: 'danger' | 'warning' | 'info'
  label: string
  title: string
  detail: string
}

export type ClusterOverviewSnapshot = {
  connectionId: string
  collectedAt: string
  clusterName: string | null
  clusterUuid: string | null
  engine: string | null
  version: string | null
  uptime: string | null
  jvmVersion: string | null
  nodeRoles: string | null
  health: ClusterHealth
  nodesOnline: number | null
  nodesTotal: number | null
  masterNode: string | null
  activeShards: number | null
  unassignedShards: number | null
  searchP95Ms: number | null
  writeRejected: number | null
  searchQps: number | null
  writeQps: number | null
  errorRate: number | null
  requestMetricWindowSeconds: number
  requestTrend: RequestTrendBucket[]
  recentRequests: RequestHistoryRecord[]
  cpuUsage: number | null
  heapUsage: number | null
  diskUsage: number | null
  gcDuration: string | null
  pressureNode: string | null
  pendingTasks: number | null
  risks: ClusterRisk[]
}

export type ClusterApi = {
  getOverview: (connectionId: string) => Promise<ClusterOverviewSnapshot>
}
