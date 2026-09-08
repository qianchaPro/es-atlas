import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  MAX_REST_BODY_BYTES,
  MAX_REST_HISTORY_COUNT,
  RestConsoleStorageError,
  addRestRequestHistory,
  clearRestRequestHistory,
  isRestRequestFavorite,
  readRestConsoleDraft,
  readRestRequestFavorites,
  readRestRequestHistory,
  toggleRestRequestFavorite,
  writeRestConsoleDraft,
  type RestConsoleStorage,
  type RestSavedRequest
} from '../../src/renderer/src/components/rest-console-storage.ts'

describe('REST Console 本地数据', () => {
  it('按连接和标签隔离草稿并保留未完成 JSON 文本', () => {
    const storage = createStorage()
    writeRestConsoleDraft(storage, 'connection-a', 'tab-1', {
      method: 'POST',
      path: '/orders/_search',
      body: '{"query":'
    })

    assert.deepEqual(readRestConsoleDraft(storage, 'connection-a', 'tab-1'), {
      method: 'POST',
      path: '/orders/_search',
      body: '{"query":'
    })
    assert.equal(readRestConsoleDraft(storage, 'connection-a', 'tab-2'), null)
    assert.equal(readRestConsoleDraft(storage, 'connection-b', 'tab-1'), null)
  })

  it('历史去重、限制条数并支持清空', () => {
    const storage = createStorage()
    for (let index = 0; index < MAX_REST_HISTORY_COUNT + 5; index += 1) {
      addRestRequestHistory(storage, 'connection-a', savedRequest(index))
    }
    addRestRequestHistory(storage, 'connection-b', savedRequest(100))

    const history = readRestRequestHistory(storage, 'connection-a')
    assert.equal(history.length, MAX_REST_HISTORY_COUNT)
    assert.equal(history[0].path, `/index-${MAX_REST_HISTORY_COUNT + 4}/_search`)
    assert.equal(readRestRequestHistory(storage, 'connection-b').length, 1)

    clearRestRequestHistory(storage, 'connection-a')
    assert.deepEqual(readRestRequestHistory(storage, 'connection-a'), [])
  })

  it('收藏可切换并按完整请求匹配', () => {
    const storage = createStorage()
    const request = savedRequest(1)
    const added = toggleRestRequestFavorite(storage, 'connection-a', request)

    assert.equal(added.favorite, true)
    assert.equal(isRestRequestFavorite(added.favorites, request), true)
    assert.equal(readRestRequestFavorites(storage, 'connection-a').length, 1)

    const removed = toggleRestRequestFavorite(storage, 'connection-a', savedRequest(1))
    assert.equal(removed.favorite, false)
    assert.deepEqual(removed.favorites, [])
  })

  it('拒绝损坏 JSON、畸形结构、超限请求体和超量集合', () => {
    const malformed = createStorage({
      'es-atlas:rest:history:connection-a': '{invalid'
    })
    assert.throws(() => readRestRequestHistory(malformed, 'connection-a'), RestConsoleStorageError)

    const invalidShape = createStorage({
      'es-atlas:rest:favorites:connection-a': JSON.stringify({ version: 1, requests: [{}] })
    })
    assert.throws(() => readRestRequestFavorites(invalidShape, 'connection-a'), RestConsoleStorageError)

    assert.throws(
      () => writeRestConsoleDraft(createStorage(), 'connection-a', 'tab-1', {
        method: 'POST',
        path: '/_search',
        body: 'x'.repeat(MAX_REST_BODY_BYTES + 1)
      }),
      RestConsoleStorageError
    )

    const tooMany = Array.from({ length: MAX_REST_HISTORY_COUNT + 1 }, (_, index) => savedRequest(index))
    const oversizedCollection = createStorage({
      'es-atlas:rest:history:connection-a': JSON.stringify({ version: 1, requests: tooMany })
    })
    assert.throws(() => readRestRequestHistory(oversizedCollection, 'connection-a'), RestConsoleStorageError)
  })
})

function savedRequest(index: number): RestSavedRequest {
  return {
    id: `request-${index}`,
    method: 'GET',
    path: `/index-${index}/_search`,
    body: '',
    savedAt: new Date(Date.UTC(2026, 7, 16, 12, index % 60)).toISOString()
  }
}

function createStorage(initial: Record<string, string> = {}): RestConsoleStorage {
  const values = new Map(Object.entries(initial))
  return {
    getItem(key: string): string | null {
      return values.get(key) ?? null
    },
    setItem(key: string, value: string): void {
      values.set(key, value)
    }
  }
}
