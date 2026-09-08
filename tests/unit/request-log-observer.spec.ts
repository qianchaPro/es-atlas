import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { LogStore } from '../../electron/main/log/log-store.ts'
import { createRequestLogObserver } from '../../electron/main/log/request-log-observer.ts'

describe('连接请求日志观察器', () => {
  it('统一记录请求元数据并由 LogStore 脱敏', async () => {
    const store = new LogStore(':memory:')
    await store.initialize()
    const observe = createRequestLogObserver(store)

    observe({
      connectionId: 'connection-1',
      connectionName: 'password=connection-secret',
      startedAtMs: Date.UTC(2026, 7, 16, 12, 0, 0),
      method: 'POST',
      path: '/orders/_search?token=query-secret',
      successful: false,
      statusCode: 403,
      errorCode: 'CONNECTION_FORBIDDEN',
      durationMs: 1_250,
      source: 'index'
    })

    const page = store.query({})
    const record = page.records[0]
    const serialized = JSON.stringify(record)
    assert.equal(page.total, 1)
    assert.equal(record?.operation, 'index.request')
    assert.equal(record?.level, 'error')
    assert.equal(record?.method, 'POST')
    assert.equal(record?.statusCode, 403)
    assert.equal(record?.durationMs, 1_250)
    assert.match(record?.traceId ?? '', /^[0-9a-f-]{36}$/u)
    assert.doesNotMatch(serialized, /connection-secret|query-secret/u)
    assert.doesNotMatch(serialized, /body|header|authorization/iu)
    assert.match(serialized, /REDACTED/u)
  })

  it('允许未保存连接测试使用空 connectionId', async () => {
    const store = new LogStore(':memory:')
    await store.initialize()
    const observe = createRequestLogObserver(store)

    observe({
      connectionId: null,
      connectionName: '临时连接',
      startedAtMs: Date.UTC(2026, 7, 16, 12, 0, 0),
      method: 'GET',
      path: '/',
      successful: true,
      statusCode: 200,
      errorCode: null,
      durationMs: 20,
      source: 'connection'
    })

    const record = store.query({}).records[0]
    assert.equal(record?.connectionId, null)
    assert.equal(record?.operation, 'connection.test')
  })
})
