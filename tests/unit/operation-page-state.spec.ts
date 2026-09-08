import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ClusterOperationCapabilities } from '../../src/shared/types/cluster-operation.ts'
import {
  createClusterOperationAvailability,
  normalizeClusterOperationError,
  parseClusterOperationJsonObject
} from '../../src/renderer/src/components/operation-page-state.ts'

function createCapabilities(
  overrides: Partial<ClusterOperationCapabilities> = {}
): ClusterOperationCapabilities {
  return {
    connectionId: 'connection-1',
    readOnly: false,
    reindex: {
      key: 'reindex',
      access: 'write',
      supported: true,
      writeSupported: true,
      permission: 'unknown',
      reasonKind: 'permission-unknown',
      reason: '支持 Reindex',
      endpointVariants: ['/_reindex?wait_for_completion=false']
    },
    asyncSearch: {
      key: 'asyncSearch',
      access: 'read-write',
      supported: true,
      writeSupported: true,
      permission: 'unknown',
      reasonKind: 'permission-unknown',
      reason: '支持 Async Search',
      endpointVariants: ['/_async_search']
    },
    asyncSearchPathPrefix: '/_async_search',
    ...overrides
  }
}

describe('集群长任务页面状态', () => {
  it('只使用能力结果启用 Reindex 和 Async Search', () => {
    const available = createClusterOperationAvailability(true, createCapabilities())
    assert.equal(available.reindex, true)
    assert.equal(available.asyncSubmit, true)
    assert.equal(available.asyncRead, true)

    const noPath = createClusterOperationAvailability(
      true,
      createCapabilities({ asyncSearchPathPrefix: null })
    )
    assert.equal(noPath.asyncSubmit, false)
    assert.equal(noPath.asyncRead, false)
  })

  it('只读连接禁用写操作但保留已有异步任务读取', () => {
    const available = createClusterOperationAvailability(
      true,
      createCapabilities({ readOnly: true })
    )
    assert.equal(available.reindex, false)
    assert.equal(available.asyncSubmit, false)
    assert.equal(available.asyncDelete, false)
    assert.equal(available.asyncRead, true)
  })

  it('JSON 输入只接受对象并返回可诊断错误', () => {
    assert.deepEqual(parseClusterOperationJsonObject('{"query":{"match_all":{}}}', '请求体'), {
      query: { match_all: {} }
    })
    assert.throws(() => parseClusterOperationJsonObject('[]', '请求体'), /必须是 JSON 对象/u)
    assert.throws(() => parseClusterOperationJsonObject('{', '请求体'), /不是有效 JSON/u)
    assert.match(normalizeClusterOperationError(new Error('权限不足'), '提交'), /提交失败：权限不足/u)
  })
})
