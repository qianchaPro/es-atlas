import type {
  ClusterHealth,
  ClusterOverviewSnapshot,
  ClusterRisk
} from '../../../src/shared/types/cluster'
import type { ConnectionService } from '../connection/connection-service.ts'
import type { RequestHistoryService } from '../request-history/request-history-service.ts'

type RootResponse = {
  cluster_name?: unknown
  cluster_uuid?: unknown
  version?: {
    number?: unknown
    distribution?: unknown
  }
  tagline?: unknown
}

type ClusterHealthResponse = {
  status?: unknown
  number_of_nodes?: unknown
  active_shards?: unknown
  unassigned_shards?: unknown
}

type NodeStats = {
  name?: unknown
  roles?: unknown
  os?: { cpu?: { percent?: unknown } }
  jvm?: {
    version?: unknown
    uptime_in_millis?: unknown
    mem?: { heap_used_percent?: unknown }
    gc?: { collectors?: Record<string, { collection_time_in_millis?: unknown }> }
  }
  fs?: { total?: { total_in_bytes?: unknown; available_in_bytes?: unknown } }
  thread_pool?: {
    write?: { rejected?: unknown }
    bulk?: { rejected?: unknown }
    index?: { rejected?: unknown }
  }
  indices?: {
    search?: {
      query_total?: unknown
    }
    indexing?: {
      index_total?: unknown
      delete_total?: unknown
    }
  }
}

type NodesStatsResponse = {
  nodes?: Record<string, NodeStats>
}

type NodesInfoResponse = {
  nodes?: Record<string, { jvm?: { version?: unknown } }>
}

type MasterNodeResponse = {
  master_node?: unknown
}

type PendingTasksResponse = {
  tasks?: unknown
}

type NodeMetrics = {
  id: string
  name: string
  roles: string[]
  cpuUsage: number | null
  heapUsage: number | null
  diskUsage: number | null
  uptimeMs: number | null
  jvmVersion: string | null
  gcDurationMs: number | null
  writeRejected: number | null
  searchTotal: number | null
  writeTotal: number | null
}

const ROOT_PATH = '/'
const HEALTH_PATH =
  '/_cluster/health?filter_path=status,number_of_nodes,active_shards,unassigned_shards'
const NODES_STATS_PATH =
  '/_nodes/stats/jvm,os,fs,thread_pool,indices?filter_path=nodes.*.name,nodes.*.roles,nodes.*.os.cpu.percent,nodes.*.jvm.version,nodes.*.jvm.uptime_in_millis,nodes.*.jvm.mem.heap_used_percent,nodes.*.jvm.gc.collectors.*.collection_time_in_millis,nodes.*.fs.total.total_in_bytes,nodes.*.fs.total.available_in_bytes,nodes.*.thread_pool.write.rejected,nodes.*.thread_pool.bulk.rejected,nodes.*.thread_pool.index.rejected,nodes.*.indices.search.query_total,nodes.*.indices.indexing.index_total,nodes.*.indices.indexing.delete_total'
const NODES_INFO_PATH = '/_nodes/jvm?filter_path=nodes.*.jvm.version'
const MASTER_NODE_PATH = '/_cluster/state/master_node?filter_path=master_node'
const PENDING_TASKS_PATH = '/_cluster/pending_tasks?filter_path=tasks'

export class ClusterService {
  private readonly connectionService: ConnectionService
  private readonly requestHistoryService: RequestHistoryService
  private readonly clusterRequestSamples = new Map<string, ClusterRequestSample[]>()

  constructor(
    connectionService: ConnectionService,
    requestHistoryService: RequestHistoryService
  ) {
    this.connectionService = connectionService
    this.requestHistoryService = requestHistoryService
  }

  async getOverview(connectionIdInput: string): Promise<ClusterOverviewSnapshot> {
    const connectionId = this.connectionService.assertConnected(connectionIdInput)

    // 根信息与健康状态是概览成立的前提，失败时立即终止，不能用空值伪装集群可用。
    const [root, health] = await Promise.all([
      this.connectionService.requestJson<RootResponse>(connectionId, ROOT_PATH),
      this.connectionService.requestJson<ClusterHealthResponse>(connectionId, HEALTH_PATH)
    ])
    // 节点、主节点和任务权限可能独立缺失；保留核心数据并把降级原因放入风险区。
    const [nodeStatsResult, nodesInfoResult, masterResult, pendingTasksResult] =
      await Promise.allSettled([
        this.connectionService.requestJson<NodesStatsResponse>(connectionId, NODES_STATS_PATH),
        this.connectionService.requestJson<NodesInfoResponse>(connectionId, NODES_INFO_PATH),
        this.connectionService.requestJson<MasterNodeResponse>(connectionId, MASTER_NODE_PATH),
        this.connectionService.requestJson<PendingTasksResponse>(connectionId, PENDING_TASKS_PATH)
      ])

    const nodeStats = readSettledValue(nodeStatsResult)
    const nodesInfo = readSettledValue(nodesInfoResult)
    const master = readSettledValue(masterResult)
    const pendingTasks = readSettledValue(pendingTasksResult)
    const partialFailures = [
      readSettledFailure('节点资源指标', nodeStatsResult),
      readSettledFailure('JVM 版本', nodesInfoResult),
      readSettledFailure('主节点', masterResult),
      readSettledFailure('待处理任务', pendingTasksResult)
    ].filter((failure): failure is string => failure !== null)
    const nodes = toNodeMetrics(nodeStats?.nodes, nodesInfo?.nodes)
    const masterNodeId = readString(master?.master_node)
    const masterMetrics = nodes.find((node) => node.id === masterNodeId) ?? null
    const pressureNode = findPressureNode(nodes)
    const healthStatus = readHealth(health.status)
    const unassignedShards = readNumber(health.unassigned_shards)
    const writeRejected = sumNumbers(nodes.map((node) => node.writeRejected))
    const heapUsage = maxNumber(nodes.map((node) => node.heapUsage))
    const diskUsage = maxNumber(nodes.map((node) => node.diskUsage))
    const pendingTaskCount = pendingTasks
      ? Array.isArray(pendingTasks.tasks)
        ? pendingTasks.tasks.length
        : 0
      : null
    const detectedEngine = detectEngine(root)
    const collectedAtMs = Date.now()
    const appRequestMetrics = this.requestHistoryService.getMetrics(connectionId, collectedAtMs)
    const clusterRequestMetrics = this.getClusterRequestMetrics(connectionId, nodes, collectedAtMs)

    return {
      connectionId,
      collectedAt: new Date().toISOString(),
      clusterName: readString(root.cluster_name),
      clusterUuid: readString(root.cluster_uuid),
      engine: detectedEngine,
      version: readString(root.version?.number),
      uptime: formatDuration(masterMetrics?.uptimeMs ?? maxNumber(nodes.map((node) => node.uptimeMs))),
      jvmVersion: masterMetrics?.jvmVersion ?? firstValue(nodes.map((node) => node.jvmVersion)),
      nodeRoles: collectNodeRoles(nodes),
      health: healthStatus,
      nodesOnline: nodes.length > 0 ? nodes.length : readNumber(health.number_of_nodes),
      nodesTotal: readNumber(health.number_of_nodes),
      masterNode: masterMetrics?.name ?? masterNodeId,
      activeShards: readNumber(health.active_shards),
      unassignedShards,
      searchP95Ms: appRequestMetrics.searchP95Ms,
      writeRejected,
      searchQps: clusterRequestMetrics.searchQps,
      writeQps: clusterRequestMetrics.writeQps,
      errorRate: appRequestMetrics.errorRate,
      requestMetricWindowSeconds: clusterRequestMetrics.windowSeconds,
      requestTrend: clusterRequestMetrics.trend,
      recentRequests: this.requestHistoryService.getRecent(connectionId),
      cpuUsage: maxNumber(nodes.map((node) => node.cpuUsage)),
      heapUsage,
      diskUsage,
      gcDuration: formatDuration(sumNumbers(nodes.map((node) => node.gcDurationMs))),
      pressureNode: pressureNode?.name ?? null,
      pendingTasks: pendingTaskCount,
      risks: buildRisks({
        connectionId,
        health: healthStatus,
        unassignedShards,
        writeRejected,
        heapUsage,
        diskUsage,
        pendingTasks: pendingTaskCount,
        partialFailures
      })
    }
  }

  private getClusterRequestMetrics(
    connectionId: string,
    nodes: NodeMetrics[],
    collectedAtMs: number
  ): ClusterRequestMetrics {
    const current = collectClusterRequestCounters(nodes)
    const samples = this.clusterRequestSamples.get(connectionId) ?? []
    const previous = samples.at(-1)
    const sample: ClusterRequestSample = {
      collectedAtMs,
      searchTotal: current.searchTotal,
      writeTotal: current.writeTotal,
      searchDelta: calculateCounterDelta(current.searchTotal, previous?.searchTotal),
      writeDelta: calculateCounterDelta(current.writeTotal, previous?.writeTotal)
    }
    // 节点累计计数可能因重启回退；丢弃旧窗口后重新建立基线，避免产生负 QPS。
    const counterReset = hasCounterReset(current, previous)
    const retainedSamples = (counterReset ? [sample] : [...samples, sample]).filter(
      (item) => item.collectedAtMs >= collectedAtMs - METRIC_WINDOW_MS
    )
    this.clusterRequestSamples.set(connectionId, retainedSamples)

    // 用窗口内最早有效累计值计算总量差分，避免刷新间隔改变 QPS 分母。
    const previousSamples = retainedSamples.slice(0, -1)
    const searchBaseline = findCounterBaseline(previousSamples, 'searchTotal')
    const writeBaseline = findCounterBaseline(previousSamples, 'writeTotal')
    return {
      windowSeconds: METRIC_WINDOW_SECONDS,
      searchQps: calculateCounterRate(
        current.searchTotal,
        searchBaseline?.searchTotal,
        searchBaseline ? (collectedAtMs - searchBaseline.collectedAtMs) / 1000 : 0
      ),
      writeQps: calculateCounterRate(
        current.writeTotal,
        writeBaseline?.writeTotal,
        writeBaseline ? (collectedAtMs - writeBaseline.collectedAtMs) / 1000 : 0
      ),
      trend: retainedSamples
        .filter((item) => item.searchDelta !== null || item.writeDelta !== null)
        .map((item) => ({
          startedAt: new Date(item.collectedAtMs).toISOString(),
          searchCount: item.searchDelta ?? 0,
          writeCount: item.writeDelta ?? 0
        }))
    }
  }
}

type ClusterRequestCounters = {
  searchTotal: number | null
  writeTotal: number | null
}

type ClusterRequestSample = ClusterRequestCounters & {
  collectedAtMs: number
  searchDelta: number | null
  writeDelta: number | null
}

type ClusterRequestMetrics = {
  windowSeconds: number
  searchQps: number | null
  writeQps: number | null
  trend: ClusterOverviewSnapshot['requestTrend']
}

const METRIC_WINDOW_SECONDS = 60
const METRIC_WINDOW_MS = METRIC_WINDOW_SECONDS * 1000

function collectClusterRequestCounters(nodes: NodeMetrics[]): ClusterRequestCounters {
  return {
    searchTotal: sumNumbers(nodes.map((node) => node.searchTotal)),
    writeTotal: sumNumbers(nodes.map((node) => node.writeTotal))
  }
}

function findCounterBaseline(
  samples: ClusterRequestSample[],
  counter: keyof Pick<ClusterRequestCounters, 'searchTotal' | 'writeTotal'>
): ClusterRequestSample | undefined {
  return samples.find((sample) => sample[counter] !== null)
}

function toNodeMetrics(
  nodes: Record<string, NodeStats> | undefined,
  nodesInfo: NodesInfoResponse['nodes']
): NodeMetrics[] {
  if (!nodes) return []

  return Object.entries(nodes).map(([id, node]) => {
    const totalDisk = readNumber(node.fs?.total?.total_in_bytes)
    const availableDisk = readNumber(node.fs?.total?.available_in_bytes)
    return {
      id,
      name: readString(node.name) ?? id,
      roles: readStringArray(node.roles),
      cpuUsage: readNumber(node.os?.cpu?.percent),
      heapUsage: readNumber(node.jvm?.mem?.heap_used_percent),
      diskUsage: calculateDiskUsage(totalDisk, availableDisk),
      uptimeMs: readNumber(node.jvm?.uptime_in_millis),
      jvmVersion: readString(nodesInfo?.[id]?.jvm?.version) ?? readString(node.jvm?.version),
      gcDurationMs: sumNumbers(
        Object.values(node.jvm?.gc?.collectors ?? {}).map((collector) =>
          readNumber(collector.collection_time_in_millis)
        )
      ),
      writeRejected:
        readNumber(node.thread_pool?.write?.rejected) ??
        readNumber(node.thread_pool?.bulk?.rejected) ??
        readNumber(node.thread_pool?.index?.rejected),
      searchTotal: readNumber(node.indices?.search?.query_total),
      writeTotal: sumNumbers([
        readNumber(node.indices?.indexing?.index_total),
        readNumber(node.indices?.indexing?.delete_total)
      ])
    }
  })
}

function buildRisks(input: {
  connectionId: string
  health: ClusterHealth
  unassignedShards: number | null
  writeRejected: number | null
  heapUsage: number | null
  diskUsage: number | null
  pendingTasks: number | null
  partialFailures: string[]
}): ClusterRisk[] {
  const risks: ClusterRisk[] = []

  if (input.health === 'red') {
    risks.push({
      id: `${input.connectionId}-health`,
      level: 'danger',
      label: '异常',
      title: '集群健康状态为红色',
      detail: '存在主分片未分配，请优先检查分片和节点状态'
    })
  } else if (input.health === 'yellow') {
    risks.push({
      id: `${input.connectionId}-health`,
      level: 'warning',
      label: '关注',
      title: '集群健康状态为黄色',
      detail: '存在副本分片未分配，集群可用但容错能力受限'
    })
  }

  if ((input.unassignedShards ?? 0) > 0) {
    risks.push({
      id: `${input.connectionId}-unassigned-shards`,
      level: 'warning',
      label: '关注',
      title: '存在未分配分片',
      detail: `当前有 ${input.unassignedShards} 个分片等待分配`
    })
  }

  if ((input.writeRejected ?? 0) > 0) {
    risks.push({
      id: `${input.connectionId}-write-rejected`,
      level: 'warning',
      label: '关注',
      title: '写入线程池存在拒绝',
      detail: `节点启动以来累计拒绝 ${input.writeRejected} 次`
    })
  }

  if ((input.heapUsage ?? 0) >= 85) {
    risks.push({
      id: `${input.connectionId}-heap`,
      level: 'danger',
      label: '异常',
      title: 'JVM 堆使用率过高',
      detail: `节点峰值已达 ${input.heapUsage}%`
    })
  } else if ((input.heapUsage ?? 0) >= 75) {
    risks.push({
      id: `${input.connectionId}-heap`,
      level: 'warning',
      label: '关注',
      title: 'JVM 堆进入关注区间',
      detail: `节点峰值已达 ${input.heapUsage}%`
    })
  }

  if ((input.diskUsage ?? 0) >= 90) {
    risks.push({
      id: `${input.connectionId}-disk`,
      level: 'danger',
      label: '异常',
      title: '磁盘使用率过高',
      detail: `节点峰值已达 ${input.diskUsage}%`
    })
  } else if ((input.diskUsage ?? 0) >= 80) {
    risks.push({
      id: `${input.connectionId}-disk`,
      level: 'warning',
      label: '关注',
      title: '磁盘使用率较高',
      detail: `节点峰值已达 ${input.diskUsage}%`
    })
  }

  if ((input.pendingTasks ?? 0) > 0) {
    risks.push({
      id: `${input.connectionId}-pending-tasks`,
      level: 'info',
      label: '提示',
      title: '集群存在待处理任务',
      detail: `当前有 ${input.pendingTasks} 个 pending task`
    })
  }

  if (input.partialFailures.length > 0) {
    risks.push({
      id: `${input.connectionId}-partial-overview`,
      level: 'info',
      label: '提示',
      title: '部分概览指标不可用',
      detail: input.partialFailures.join('；')
    })
  }

  return risks
}

function findPressureNode(nodes: NodeMetrics[]): NodeMetrics | null {
  let pressureNode: NodeMetrics | null = null
  let highestPressure = -1
  for (const node of nodes) {
    const pressure = Math.max(node.cpuUsage ?? 0, node.heapUsage ?? 0, node.diskUsage ?? 0)
    if (pressure > highestPressure) {
      pressureNode = node
      highestPressure = pressure
    }
  }
  return pressureNode
}

function collectNodeRoles(nodes: NodeMetrics[]): string | null {
  const roles = [...new Set(nodes.flatMap((node) => node.roles))]
  return roles.length > 0 ? roles.join(', ') : null
}

function calculateDiskUsage(total: number | null, available: number | null): number | null {
  if (total === null || available === null || total <= 0) return null
  return Math.round(((total - available) / total) * 100)
}

function readHealth(value: unknown): ClusterHealth {
  return value === 'green' || value === 'yellow' || value === 'red' ? value : 'unknown'
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function maxNumber(values: Array<number | null>): number | null {
  const availableValues = values.filter((value): value is number => value !== null)
  return availableValues.length > 0 ? Math.max(...availableValues) : null
}

function sumNumbers(values: Array<number | null>): number | null {
  const availableValues = values.filter((value): value is number => value !== null)
  return availableValues.length > 0
    ? availableValues.reduce((total, value) => total + value, 0)
    : null
}

function calculateCounterDelta(current: number | null, previous: number | null | undefined): number | null {
  if (current === null || previous === undefined || current < previous) return null
  return current - previous
}

function hasCounterReset(
  current: ClusterRequestCounters,
  previous: ClusterRequestSample | undefined
): boolean {
  return (
    (current.searchTotal !== null && typeof previous?.searchTotal === 'number' && current.searchTotal < previous.searchTotal) ||
    (current.writeTotal !== null && typeof previous?.writeTotal === 'number' && current.writeTotal < previous.writeTotal)
  )
}

function calculateCounterRate(
  current: number | null,
  baseline: number | undefined,
  elapsedSeconds: number
): number | null {
  if (current === null || baseline === undefined || current < baseline || elapsedSeconds <= 0) {
    return null
  }
  return roundToTwoDecimals((current - baseline) / elapsedSeconds)
}

function roundToTwoDecimals(value: number): number {
  return Math.round(value * 100) / 100
}

function firstValue<T>(values: Array<T | null>): T | null {
  return values.find((value): value is T => value !== null) ?? null
}

function readSettledValue<T>(result: PromiseSettledResult<T>): T | null {
  return result.status === 'fulfilled' ? result.value : null
}

function readSettledFailure<T>(label: string, result: PromiseSettledResult<T>): string | null {
  if (result.status === 'fulfilled') return null
  return `${label}采集失败：${getErrorMessage(result.reason)}`
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function detectEngine(response: RootResponse): string | null {
  const distribution = readString(response.version?.distribution)?.toLowerCase()
  const tagline = readString(response.tagline)?.toLowerCase()
  if (distribution === 'opensearch' || tagline?.includes('opensearch')) return 'OpenSearch'
  if (tagline?.includes('you know, for search') || response.version) return 'Elasticsearch'
  return null
}

function formatDuration(durationMs: number | null): string | null {
  if (durationMs === null) return null
  if (durationMs < 1_000) return `${Math.round(durationMs)} ms`

  const totalSeconds = Math.floor(durationMs / 1_000)
  const days = Math.floor(totalSeconds / 86_400)
  const hours = Math.floor((totalSeconds % 86_400) / 3_600)
  const minutes = Math.floor((totalSeconds % 3_600) / 60)
  const seconds = totalSeconds % 60
  const parts: string[] = []
  if (days > 0) parts.push(`${days} 天`)
  if (hours > 0) parts.push(`${hours} 小时`)
  if (minutes > 0) parts.push(`${minutes} 分钟`)
  if (parts.length === 0) parts.push(`${seconds} 秒`)
  return parts.join(' ')
}
