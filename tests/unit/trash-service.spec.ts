import assert from 'node:assert/strict'
import test from 'node:test'
import { TrashService } from '../../electron/main/trash/trash-service.ts'

test('TrashService stores index and document snapshots and removes restored records', async () => {
  const service = new TrashService(':memory:')
  await service.initialize()
  const indexId = service.recordIndex({
    connectionId: 'connection-1',
    connectionName: '本地集群',
    index: 'orders',
    snapshot: {
      mapping: { properties: { status: { type: 'keyword' } } },
      settings: { 'index.number_of_shards': '1' },
      aliases: [],
      documents: [{ id: '1', source: { status: 'open' } }]
    }
  })
  const documentId = service.recordDocument({
    connectionId: 'connection-1',
    connectionName: '本地集群',
    index: 'orders',
    documentId: '2',
    operation: 'update',
    beforeSource: { status: 'pending' }
  })

  const result = service.list({ connectionId: 'connection-1', pageSize: 10 })
  assert.equal(result.total, 2)
  assert.deepEqual(result.records.map((record) => record.id).sort(), [documentId, indexId].sort())
  assert.equal(service.get(indexId).indexSnapshot?.documents[0]?.source.status, 'open')
  assert.deepEqual(service.get(documentId).beforeSource, { status: 'pending' })

  service.remove(documentId)
  assert.equal(service.list({ pageSize: 10 }).total, 1)
  service.close()
})
