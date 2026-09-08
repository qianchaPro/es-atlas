import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ClusterService } from '../../electron/main/es/cluster-service.ts'
import type { ConnectionService } from '../../electron/main/connection/connection-service.ts'
import type { RequestHistoryService } from '../../electron/main/request-history/request-history-service.ts'

describe('ClusterService 集群请求指标', () => {
  it('按所有节点累计计数计算跨客户端 QPS 和趋势', async () => {
    let nowMs = Date.UTC(2026, 7, 16, 12, 0, 0)
    let sampleIndex = 0
    const counters = [
      { search: [100, 40], write: [80, 20] },
      { search: [130, 50], write: [90, 25] }
    ]
    const connectionService = {
      assertConnected: (connectionId: string) => connectionId,
      requestJson: async <T>(connectionId: string, path: string): Promise<T> => {
        if (path === '/') {
          return { cluster_name: 'test', cluster_uuid: 'uuid', version: { number: '8.0.0' } } as T
        }
        if (path.startsWith('/_cluster/health')) {
          return { status: 'green', number_of_nodes: 2, active_shards: 4, unassigned_shards: 0 } as T
        }
        if (path.startsWith('/_nodes/stats')) {
          const current = counters[sampleIndex]
          return {
            nodes: {
              'node-1': {
                name: 'node-1',
                roles: ['data'],
                indices: {
                  search: { query_total: current.search[0] },
                  indexing: { index_total: current.write[0], delete_total: 0 }
                }
              },
              'node-2': {
                name: 'node-2',
                roles: ['data'],
                indices: {
                  search: { query_total: current.search[1] },
                  indexing: { index_total: current.write[1], delete_total: 0 }
                }
              }
            }
          } as T
        }
        if (path.startsWith('/_nodes/jvm')) return { nodes: {} } as T
        if (path.startsWith('/_cluster/state/master_node')) return { master_node: 'node-1' } as T
        if (path.startsWith('/_cluster/pending_tasks')) return { tasks: [] } as T
        throw new Error(`unexpected path: ${path}`)
      }
    } as unknown as ConnectionService
    const requestHistoryService = {
      getMetrics: () => ({
        windowSeconds: 60,
        searchQps: null,
        writeQps: null,
        searchP95Ms: 12,
        errorRate: 0,
        trend: []
      }),
      getRecent: () => []
    } as unknown as RequestHistoryService
    const service = new ClusterService(connectionService, requestHistoryService)

    const originalDateNow = Date.now
    Date.now = () => nowMs
    try {
      const first = await service.getOverview('connection-1')
      assert.equal(first.searchQps, null)
      assert.equal(first.writeQps, null)

      nowMs += 10_000
      sampleIndex = 1
      const second = await service.getOverview('connection-1')
      assert.equal(second.searchQps, 4)
      assert.equal(second.writeQps, 1.5)
      assert.deepEqual(second.requestTrend.at(-1), {
        startedAt: new Date(nowMs).toISOString(),
        searchCount: 40,
        writeCount: 15
      })
    } finally {
      Date.now = originalDateNow
    }
  })

  it('累计计数回退时等待新基线，不返回负 QPS', async () => {
    let nowMs = Date.UTC(2026, 7, 16, 12, 0, 0)
    let searchTotal = 100
    const connectionService = {
      assertConnected: (connectionId: string) => connectionId,
      requestJson: async <T>(connectionId: string, path: string): Promise<T> => {
        if (path === '/') return { version: { number: '8.0.0' } } as T
        if (path.startsWith('/_cluster/health')) return { status: 'green' } as T
        if (path.startsWith('/_nodes/stats')) {
          return { nodes: { node: { indices: { search: { query_total: searchTotal } } } } } as T
        }
        if (path.startsWith('/_nodes/jvm')) return { nodes: {} } as T
        if (path.startsWith('/_cluster/state/master_node')) return {} as T
        if (path.startsWith('/_cluster/pending_tasks')) return { tasks: [] } as T
        throw new Error(`unexpected path: ${path}`)
      }
    } as unknown as ConnectionService
    const requestHistoryService = {
      getMetrics: () => ({ windowSeconds: 60, searchQps: null, writeQps: null, searchP95Ms: null, errorRate: null, trend: [] }),
      getRecent: () => []
    } as unknown as RequestHistoryService
    const service = new ClusterService(connectionService, requestHistoryService)

    const originalDateNow = Date.now
    Date.now = () => nowMs
    try {
      await service.getOverview('connection-1')
      nowMs += 5_000
      searchTotal = 20
      const reset = await service.getOverview('connection-1')
      assert.equal(reset.searchQps, null)

      nowMs += 5_000
      searchTotal = 30
      const afterReset = await service.getOverview('connection-1')
      assert.equal(afterReset.searchQps, 2)
    } finally {
      Date.now = originalDateNow
    }
  })
})
