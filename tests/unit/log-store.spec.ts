import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { LogStore } from '../../electron/main/log/log-store.ts'

const NOW = Date.UTC(2026, 7, 16, 12, 0, 0)

describe('LogStore', () => {
  it('queries logs with combined filters, deterministic sorting and pagination', async () => {
    const store = await createStore()
    recordLog(store, {
      createdAt: NOW - 3_000,
      connectionId: 'connection-a',
      connectionName: 'Alpha',
      level: 'info',
      traceId: 'trace-1',
      statusCode: 200,
      durationMs: 80,
      message: 'search completed'
    })
    recordLog(store, {
      createdAt: NOW - 2_000,
      connectionId: 'connection-a',
      connectionName: 'Alpha',
      level: 'error',
      traceId: 'trace-2',
      statusCode: 503,
      durationMs: 1_500,
      message: 'search failed'
    })
    recordLog(store, {
      createdAt: NOW - 1_000,
      connectionId: 'connection-b',
      connectionName: 'Beta',
      level: 'error',
      traceId: 'trace-3',
      statusCode: 503,
      durationMs: 2_000,
      message: 'search failed'
    })

    const page = store.query({
      connectionId: 'connection-a',
      level: 'error',
      statusCode: 503,
      minimumDurationMs: 1_000,
      keyword: 'trace-2',
      page: 1,
      pageSize: 1,
      sortOrder: 'desc'
    })

    assert.equal(page.total, 1)
    assert.equal(page.records[0]?.traceId, 'trace-2')
    assert.deepEqual(page.connections, [
      { id: 'connection-a', name: 'Alpha' },
      { id: 'connection-b', name: 'Beta' }
    ])

    const secondPage = store.query({ page: 2, pageSize: 1, sortOrder: 'desc' })
    assert.equal(secondPage.total, 3)
    assert.equal(secondPage.records[0]?.traceId, 'trace-2')
  })

  it('使用可配置阈值在单次分页 SQL 中筛选慢日志', async () => {
    const store = await createStore()
    recordLog(store, { traceId: 'fast', durationMs: 999 })
    recordLog(store, { traceId: 'default-slow', durationMs: 1_000 })
    recordLog(store, { traceId: 'custom-slow', durationMs: 2_500 })
    recordLog(store, { traceId: 'unknown-duration', durationMs: null })

    const defaultThreshold = store.query({ minimumDurationMs: 1_000 })
    const customThreshold = store.query({ minimumDurationMs: 2_000 })

    assert.deepEqual(
      defaultThreshold.records.map((record) => record.traceId),
      ['custom-slow', 'default-slow']
    )
    assert.deepEqual(
      customThreshold.records.map((record) => record.traceId),
      ['custom-slow']
    )
  })

  it('clears all matching rows in one filtered operation', async () => {
    const store = await createStore()
    recordLog(store, { connectionId: 'connection-a', traceId: 'trace-1', message: 'first' })
    recordLog(store, { connectionId: 'connection-a', traceId: 'trace-2', message: 'second' })
    recordLog(store, { connectionId: 'connection-b', traceId: 'trace-3', message: 'third' })

    const result = store.clear({ connectionId: 'connection-a' })

    assert.equal(result.deleted, 2)
    assert.equal(store.query({}).total, 1)
    assert.equal(store.query({}).records[0]?.connectionId, 'connection-b')
  })

  it('applies age and count retention rules in bulk', async () => {
    const store = await createStore()
    store.updateRetention({ maxAgeDays: 30, maxRecords: 3 }, NOW)
    recordLog(store, { createdAt: NOW - 31 * 24 * 60 * 60 * 1_000, traceId: 'expired', message: 'expired' })
    recordLog(store, { createdAt: NOW - 4_000, traceId: 'trace-1', message: 'first' })
    recordLog(store, { createdAt: NOW - 3_000, traceId: 'trace-2', message: 'second' })
    recordLog(store, { createdAt: NOW - 2_000, traceId: 'trace-3', message: 'third' })
    recordLog(store, { createdAt: NOW - 1_000, traceId: 'trace-4', message: 'fourth' })

    const result = store.enforceRetention(NOW)

    assert.equal(result.deletedByAge, 1)
    assert.equal(result.deletedByCount, 1)
    assert.equal(result.totalDeleted, 2)
    assert.equal(result.remaining, 3)
    assert.deepEqual(
      store.query({ sortOrder: 'asc' }).records.map((record) => record.traceId),
      ['trace-2', 'trace-3', 'trace-4']
    )
  })

  it('exports only stored redacted values as JSON and CSV', async () => {
    const store = await createStore()
    recordLog(store, {
      connectionId: 'connection-export',
      traceId: 'trace-export',
      message: 'password=message-secret',
      path: '/_search?token=query-secret',
      error: new Error('Authorization: Bearer error-secret')
    })
    recordLog(store, {
      connectionId: 'connection-other',
      traceId: 'trace-other',
      message: 'other connection'
    })

    const filter = { connectionId: 'connection-export' }
    const json = store.exportData(filter, 'json', NOW)
    const csv = store.exportData(filter, 'csv', NOW)

    assert.equal(json.recordCount, 1)
    assert.equal(csv.recordCount, 1)
    assert.equal(json.mimeType, 'application/json')
    assert.equal(csv.mimeType, 'text/csv; charset=utf-8')
    assert.doesNotMatch(json.content, /message-secret|query-secret|error-secret/u)
    assert.doesNotMatch(csv.content, /message-secret|query-secret|error-secret/u)
    assert.match(json.content, /REDACTED/u)
    assert.match(csv.content, /trace-export/u)
    assert.doesNotMatch(json.content, /trace-other/u)
  })

  it('reports write failures through the fallback channel without throwing', async () => {
    const errors: Error[] = []
    const store = await createStore((error) => errors.push(error))
    store.close()

    const result = store.record({
      level: 'error',
      operation: 'test.closed-store',
      traceId: 'trace-closed',
      message: 'write after close'
    })

    assert.equal(result, null)
    assert.equal(errors.length, 1)
    assert.match(errors[0]?.message ?? '', /\u65e5\u5fd7\u6a21\u5757\u5931\u8d25/u)
  })
})

async function createStore(onFallbackError?: (error: Error) => void): Promise<LogStore> {
  const store = new LogStore(':memory:', {
    now: () => NOW,
    onFallbackError
  })
  await store.initialize()
  return store
}

function recordLog(
  store: LogStore,
  overrides: Partial<Parameters<LogStore['record']>[0]>
): void {
  const result = store.record({
    createdAt: NOW,
    connectionId: null,
    connectionName: null,
    level: 'info',
    operation: 'request.execute',
    method: 'POST',
    path: '/_search',
    statusCode: 200,
    durationMs: 10,
    traceId: 'trace-default',
    message: 'request completed',
    ...overrides
  })
  assert.notEqual(result, null)
}
