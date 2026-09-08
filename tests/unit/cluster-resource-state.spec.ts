import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isProxy, reactive } from 'vue'
import {
  applyClusterResourceListResult,
  applyClusterResourceLoadError,
  beginClusterResourceLoad,
  canCancelClusterTask,
  canExecuteClusterResourceOperation,
  createClusterResourceCollectionState,
  createClusterResourceOperationRequest,
  normalizeClusterResourceError
} from '../../src/renderer/src/components/cluster-resource-state.ts'
import type {
  ClusterResourceItem,
  ClusterResourceListResult,
  ClusterResourceOperationCapability
} from '../../src/shared/types/cluster-resource.ts'

describe('集群资源读取状态', () => {
  it('刷新时保留上一次成功数据并进入加载状态', () => {
    const initial = createClusterResourceCollectionState('connection-a', 'node')
    const loaded = applyClusterResourceListResult(initial, listResult({ items: [resourceItem('node-1')] }))
    const refreshing = beginClusterResourceLoad(loaded)

    assert.equal(refreshing.loadState, 'loading')
    assert.deepEqual(refreshing.items, loaded.items)
    assert.equal(refreshing.error, null)
  })

  it('区分有数据、空列表、403 与能力不支持', () => {
    const initial = createClusterResourceCollectionState('connection-a', 'node')
    const ready = applyClusterResourceListResult(initial, listResult({ items: [resourceItem('node-1')] }))
    const empty = applyClusterResourceListResult(initial, listResult({ items: [] }))
    const forbidden = applyClusterResourceListResult(
      initial,
      listResult({ accessState: 'forbidden', reason: '缺少 monitor 权限' })
    )
    const unsupported = applyClusterResourceListResult(
      initial,
      listResult({ accessState: 'unsupported', reason: '当前产品不支持该接口' })
    )

    assert.equal(ready.loadState, 'ready')
    assert.equal(empty.loadState, 'empty')
    assert.equal(forbidden.loadState, 'forbidden')
    assert.equal(forbidden.access?.reason, '缺少 monitor 权限')
    assert.equal(unsupported.loadState, 'unsupported')
    assert.equal(unsupported.access?.reason, '当前产品不支持该接口')
  })

  it('拒绝回填其他连接或资源类型的响应', () => {
    const state = createClusterResourceCollectionState('connection-a', 'node')

    assert.throws(
      () => applyClusterResourceListResult(
        state,
        listResult({ connectionId: 'connection-b', kind: 'task' })
      ),
      /响应上下文不匹配/u
    )
  })

  it('请求失败保留旧数据并把权限与不支持错误映射为不同状态', () => {
    const initial = createClusterResourceCollectionState('connection-a', 'node')
    const loaded = applyClusterResourceListResult(initial, listResult({ items: [resourceItem('node-1')] }))
    const forbidden = applyClusterResourceLoadError(loaded, {
      code: 'FORBIDDEN',
      message: '缺少权限',
      statusCode: 403,
      capability: 'cluster.nodes.read'
    })
    const unsupported = applyClusterResourceLoadError(loaded, {
      code: 'UNSUPPORTED',
      message: '版本不支持',
      statusCode: 404,
      capability: 'cluster.nodes.read'
    })

    assert.equal(forbidden.loadState, 'forbidden')
    assert.equal(unsupported.loadState, 'unsupported')
    assert.equal(forbidden.stale, true)
    assert.deepEqual(forbidden.items, loaded.items)
  })

  it('从状态码和错误码归一化权限、不支持与普通错误', () => {
    assert.equal(normalizeClusterResourceError({ statusCode: 403, message: 'denied' }).code, 'FORBIDDEN')
    assert.equal(normalizeClusterResourceError({ code: 'UNSUPPORTED', message: 'missing api' }).code, 'UNSUPPORTED')
    assert.equal(normalizeClusterResourceError(new Error('network down')).code, 'UNKNOWN')
  })
})

describe('集群资源写操作保护', () => {
  it('只有等待和运行中的任务允许请求取消', () => {
    assert.equal(canCancelClusterTask({ ...resourceItem('waiting'), taskState: 'waiting' }), true)
    assert.equal(canCancelClusterTask({ ...resourceItem('running'), taskState: 'running' }), true)
    assert.equal(canCancelClusterTask({ ...resourceItem('canceling'), taskState: 'canceling' }), false)
    assert.equal(canCancelClusterTask({ ...resourceItem('completed'), taskState: 'completed' }), false)
  })

  it('只读连接、403 和不支持能力均禁用写操作', () => {
    const supported = operationCapability('update-index-template', 'available')
    const forbidden = operationCapability('update-index-template', 'forbidden')
    const unsupported = operationCapability('update-index-template', 'unsupported')

    assert.equal(canExecuteClusterResourceOperation(false, supported), true)
    assert.equal(canExecuteClusterResourceOperation(true, supported), false)
    assert.equal(canExecuteClusterResourceOperation(false, forbidden), false)
    assert.equal(canExecuteClusterResourceOperation(false, unsupported), false)
  })

  it('确认请求完整携带连接、资源和影响范围', () => {
    const capability = operationCapability('update-index-template', 'available')
    const payload = reactive({ index_patterns: ['orders-*'] })
    const request = createClusterResourceOperationRequest({
      requestId: 'request-1',
      connectionId: 'connection-a',
      connectionName: '生产集群',
      kind: 'index-template',
      capability,
      resource: resourceItem('orders-template'),
      resourceName: 'orders-template',
      payload,
      readOnly: false
    })

    assert.deepEqual(request, {
      requestId: 'request-1',
      connectionId: 'connection-a',
      connectionName: '生产集群',
      kind: 'index-template',
      action: 'update-index-template',
      resourceId: 'orders-template',
      resourceName: 'orders-template',
      impactScope: '更新目标模板及后续匹配索引',
      destructive: false,
      payload: { index_patterns: ['orders-*'] }
    })
    assert.equal(isProxy(request.payload), false)
    assert.doesNotThrow(() => structuredClone(request))
  })

  it('数据流创建和快照恢复生成可序列化确认契约', () => {
    const createDataStreamRequest = createClusterResourceOperationRequest({
      requestId: 'request-data-stream',
      connectionId: 'connection-a',
      connectionName: '生产集群',
      kind: 'data-stream',
      capability: operationCapability('create-data-stream', 'available'),
      resource: null,
      resourceName: 'logs-app',
      payload: null,
      readOnly: false
    })
    const snapshot = resourceItem('repository-a/nightly')
    const restoreRequest = createClusterResourceOperationRequest({
      requestId: 'request-restore',
      connectionId: 'connection-a',
      connectionName: '生产集群',
      kind: 'snapshot',
      capability: {
        ...operationCapability('restore-snapshot', 'available'),
        destructive: true
      },
      resource: snapshot,
      resourceName: snapshot.id,
      payload: reactive({ indices: 'orders-*', include_global_state: false }),
      readOnly: false
    })

    assert.equal(createDataStreamRequest.resourceId, null)
    assert.equal(createDataStreamRequest.resourceName, 'logs-app')
    assert.equal(restoreRequest.resourceId, 'repository-a/nightly')
    assert.equal(restoreRequest.resourceName, 'repository-a/nightly')
    assert.deepEqual(restoreRequest.payload, {
      indices: 'orders-*',
      include_global_state: false
    })
    assert.doesNotThrow(() => structuredClone(createDataStreamRequest))
    assert.doesNotThrow(() => structuredClone(restoreRequest))
  })

  it('拒绝只读、能力不可用、类型错配和不可取消任务', () => {
    const capability = operationCapability('cancel-task', 'available')
    const completedTask = { ...resourceItem('task-1'), taskState: 'completed' as const }
    const baseInput = {
      requestId: 'request-1',
      connectionId: 'connection-a',
      connectionName: '生产集群',
      kind: 'task' as const,
      capability,
      resource: completedTask,
      resourceName: completedTask.name,
      payload: null,
      readOnly: false
    }

    assert.throws(() => createClusterResourceOperationRequest({ ...baseInput, readOnly: true }), /只读/u)
    assert.throws(
      () => createClusterResourceOperationRequest({
        ...baseInput,
        capability: { ...capability, state: 'forbidden' }
      }),
      /能力不可用/u
    )
    assert.throws(
      () => createClusterResourceOperationRequest({ ...baseInput, kind: 'node' }),
      /资源类型不匹配/u
    )
    assert.throws(() => createClusterResourceOperationRequest(baseInput), /任务状态不允许取消/u)
  })
})

function listResult(options: {
  connectionId?: string
  kind?: ClusterResourceListResult['kind']
  items?: ClusterResourceItem[]
  accessState?: ClusterResourceListResult['access']['state']
  reason?: string | null
} = {}): ClusterResourceListResult {
  return {
    connectionId: options.connectionId ?? 'connection-a',
    kind: options.kind ?? 'node',
    collectedAt: '2026-08-16T00:00:00.000Z',
    access: {
      state: options.accessState ?? 'available',
      capability: 'cluster.nodes.read',
      reason: options.reason ?? null
    },
    items: options.items ?? [],
    operations: []
  }
}

function resourceItem(id: string): ClusterResourceItem {
  return {
    id,
    name: id,
    status: null,
    summary: null,
    updatedAt: null,
    facts: []
  }
}

function operationCapability(
  action: ClusterResourceOperationCapability['action'],
  state: ClusterResourceOperationCapability['state']
): ClusterResourceOperationCapability {
  return {
    action,
    state,
    reason: state === 'available' ? null : '能力不可用',
    impactScope: '更新目标模板及后续匹配索引',
    destructive: false
  }
}
