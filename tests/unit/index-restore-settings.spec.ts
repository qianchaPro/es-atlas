import assert from 'node:assert/strict'
import test from 'node:test'
import { sanitizeRestorableIndexSettings } from '../../electron/main/es/index-restore-settings.ts'

test('索引恢复会移除 Elasticsearch 生成的只读 settings', () => {
  assert.deepEqual(
    sanitizeRestorableIndexSettings({
      'index.creation_date': '1786817439856',
      'index.number_of_replicas': '0',
      'index.number_of_shards': '1',
      'index.provided_name': '.tasks',
      'index.uuid': 'generated',
      'index.version.created': '7030199',
      'index.priority': '2147483647'
    }),
    {
      'index.number_of_replicas': '0',
      'index.number_of_shards': '1',
      'index.priority': '2147483647'
    }
  )
})
