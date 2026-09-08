import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { RequestHistoryService } from '../../electron/main/request-history/request-history-service.ts'

describe('请求历史脱敏', () => {
  it('在统一写入点脱敏连接名和 URL 查询凭据', async () => {
    const service = new RequestHistoryService(':memory:')
    await service.initialize()

    await service.record({
      connectionId: 'connection-1',
      connectionName: 'password=connection-secret',
      startedAtMs: Date.UTC(2026, 7, 16, 12, 0, 0),
      method: 'GET',
      path: '/orders/_search?token=query-secret&size=20',
      successful: true,
      statusCode: 200,
      errorCode: null,
      durationMs: 25
    })

    const page = service.list({})
    const serialized = JSON.stringify(page.records)
    assert.equal(page.total, 1)
    assert.doesNotMatch(serialized, /connection-secret|query-secret/u)
    assert.match(serialized, /REDACTED/u)
    assert.match(page.records[0]?.path ?? '', /size=20/u)
    service.close()
  })
})
