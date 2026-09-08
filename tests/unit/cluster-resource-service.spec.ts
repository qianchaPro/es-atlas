import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  ClusterResourceService,
  ClusterResourceServiceError,
  type ClusterResourceConnectionService
} from '../../electron/main/es/cluster-resource-service.ts'
import type { ConnectionSummary } from '../../src/shared/types/connection.ts'
import type {
  ClusterResourceKind,
  ClusterResourceOperationAction,
  ClusterResourceOperationRequest,
  ClusterResourceValue
} from '../../src/shared/types/cluster-resource.ts'

type RequestOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  body?: string
  contentType?: 'application/json' | 'application/x-ndjson'
}

type CapturedRequest = {
  connectionId: string
  path: string
  options: RequestOptions
}

const NOW = Date.UTC(2026, 7, 16, 12, 0, 0)

describe('集群资源读取', () => {
  it('按官方路径列出节点、任务、模板、数据流、Pipeline 和脚本', async () => {
    const cases: Array<{
      kind: Exclude<ClusterResourceKind, 'snapshot'>
      path: string
      response: unknown
      expectedId: string
    }> = [
      {
        kind: 'node',
        path: '/_nodes',
        response: { nodes: { 'node-1': { name: 'data-1', version: '8.12.0', roles: ['data'] } } },
        expectedId: 'node-1'
      },
      {
        kind: 'task',
        path: '/_tasks?detailed=true',
        response: {
          nodes: {
            'node-1': {
              name: 'data-1',
              tasks: {
                'node-1:42': { action: 'indices:data/write/reindex', cancellable: true }
              }
            }
          }
        },
        expectedId: 'node-1:42'
      },
      {
        kind: 'index-template',
        path: '/_index_template',
        response: {
          index_templates: [{ name: 'orders', index_template: { index_patterns: ['orders-*'], priority: 10 } }]
        },
        expectedId: 'orders'
      },
      {
        kind: 'component-template',
        path: '/_component_template',
        response: { component_templates: [{ name: 'shared', component_template: { version: 2 } }] },
        expectedId: 'shared'
      },
      {
        kind: 'data-stream',
        path: '/_data_stream',
        response: { data_streams: [{ name: 'logs-app', status: 'GREEN', generation: 3 }] },
        expectedId: 'logs-app'
      },
      {
        kind: 'ingest-pipeline',
        path: '/_ingest/pipeline',
        response: { normalize: { description: 'normalize input', version: 4, processors: [] } },
        expectedId: 'normalize'
      },
      {
        kind: 'stored-script',
        path: '/_cluster/state/metadata?filter_path=metadata.stored_scripts',
        response: { metadata: { stored_scripts: { calculate: { lang: 'painless', source: 'return 1' } } } },
        expectedId: 'calculate'
      }
    ]

    for (const testCase of cases) {
      const requests: CapturedRequest[] = []
      const service = createService(requests, async () => testCase.response)

      const result = await service.list({ connectionId: 'connection-1', kind: testCase.kind })

      assert.equal(requests[0]?.path, testCase.path)
      assert.deepEqual(requests[0]?.options, {})
      assert.equal(result.access.state, 'available')
      assert.equal(result.items[0]?.id, testCase.expectedId)
      assert.equal(result.collectedAt, new Date(NOW).toISOString())
    }
  })

  it('先列出仓库，再并行读取各仓库快照', async () => {
    const requests: CapturedRequest[] = []
    const service = createService(requests, async (request) => {
      if (request.path === '/_snapshot') {
        return { repository_a: { type: 'fs' }, 'repository b': { type: 's3' } }
      }
      if (request.path === '/_snapshot/repository_a/*?verbose=false') {
        return { snapshots: [{ snapshot: 'nightly', state: 'SUCCESS' }] }
      }
      if (request.path === '/_snapshot/repository%20b/*?verbose=false') {
        return { snapshots: [{ snapshot: 'daily', state: 'IN_PROGRESS' }] }
      }
      throw new Error(`unexpected path: ${request.path}`)
    })

    const result = await service.list({ connectionId: 'connection-1', kind: 'snapshot' })

    assert.deepEqual(requests.map((request) => request.path), [
      '/_snapshot',
      '/_snapshot/repository%20b/*?verbose=false',
      '/_snapshot/repository_a/*?verbose=false'
    ])
    assert.deepEqual(result.items.map((item) => item.id), [
      'repository b/daily',
      'repository_a/nightly'
    ])
  })

  it('无存储脚本时兼容 filter_path 空响应并拒绝畸形字段', async () => {
    for (const response of [{}, { metadata: {} }]) {
      const service = createService([], async () => response)

      const result = await service.list({ connectionId: 'connection-1', kind: 'stored-script' })

      assert.equal(result.access.state, 'available')
      assert.deepEqual(result.items, [])
    }

    for (const response of [{ metadata: [] }, { metadata: { stored_scripts: [] } }]) {
      const service = createService([], async () => response)

      await assert.rejects(
        service.list({ connectionId: 'connection-1', kind: 'stored-script' }),
        (error: unknown) =>
          error instanceof ClusterResourceServiceError && error.code === 'INVALID_RESPONSE'
      )
    }
  })

  it('详情路径对资源 ID 每个路径段执行 encodeURIComponent', async () => {
    const requests: CapturedRequest[] = []
    const service = createService(requests, async () => ({ value: true }))

    await service.getDetail({
      connectionId: 'connection-1',
      kind: 'ingest-pipeline',
      resourceId: 'folder/name with space'
    })
    await service.getDetail({
      connectionId: 'connection-1',
      kind: 'snapshot',
      resourceId: 'repository one/snapshot two'
    })

    assert.deepEqual(requests.map((request) => request.path), [
      '/_ingest/pipeline/folder%2Fname%20with%20space',
      '/_snapshot/repository%20one/snapshot%20two'
    ])
  })

  it('未验证能力不发送请求', async () => {
    const requests: CapturedRequest[] = []
    const service = createService(
      requests,
      async () => ({}),
      connectionSummary({ engine: null, version: null })
    )

    const result = await service.list({ connectionId: 'connection-1', kind: 'ingest-pipeline' })

    assert.equal(requests.length, 0)
    assert.equal(result.access.state, 'unsupported')
    assert.equal(result.items.length, 0)
  })

  it('将读取 403 映射为 forbidden，能力路径 404 映射为 unsupported', async () => {
    const forbidden = createService([], async () => {
      throw httpError(403)
    })
    const unsupported = createService([], async () => {
      throw httpError(404)
    })

    const forbiddenResult = await forbidden.list({ connectionId: 'connection-1', kind: 'node' })
    const unsupportedResult = await unsupported.list({ connectionId: 'connection-1', kind: 'node' })

    assert.equal(forbiddenResult.access.state, 'forbidden')
    assert.equal(unsupportedResult.access.state, 'unsupported')
  })

  it('将详情 404 保留为资源不存在', async () => {
    const service = createService([], async () => {
      throw httpError(404)
    })

    await assert.rejects(
      service.getDetail({ connectionId: 'connection-1', kind: 'node', resourceId: 'missing' }),
      (error: unknown) => error instanceof ClusterResourceServiceError && error.code === 'NOT_FOUND'
    )
  })
})

describe('集群资源确认写操作', () => {
  it('仅使用明确允许的安全路径执行写操作', async () => {
    const cases: Array<{
      action: ClusterResourceOperationAction
      kind: ClusterResourceKind
      resourceId: string
      method: RequestOptions['method']
      path: string
      payload: ClusterResourceValue | null
      destructive: boolean
    }> = [
      ['create-index-template', 'index-template', 'orders template', 'PUT', '/_index_template/orders%20template', { index_patterns: ['orders-*'] }, false],
      ['update-index-template', 'index-template', 'orders/template', 'PUT', '/_index_template/orders%2Ftemplate', { priority: 20 }, false],
      ['delete-index-template', 'index-template', 'orders', 'DELETE', '/_index_template/orders', null, true],
      ['create-component-template', 'component-template', 'shared', 'PUT', '/_component_template/shared', { template: {} }, false],
      ['update-component-template', 'component-template', 'shared', 'PUT', '/_component_template/shared', { version: 2 }, false],
      ['delete-component-template', 'component-template', 'shared', 'DELETE', '/_component_template/shared', null, true],
      ['create-data-stream', 'data-stream', 'logs-app', 'PUT', '/_data_stream/logs-app', null, false],
      ['delete-data-stream', 'data-stream', 'logs app', 'DELETE', '/_data_stream/logs%20app', null, true],
      ['create-ingest-pipeline', 'ingest-pipeline', 'normalize', 'PUT', '/_ingest/pipeline/normalize', { processors: [] }, false],
      ['update-ingest-pipeline', 'ingest-pipeline', 'normalize', 'PUT', '/_ingest/pipeline/normalize', { version: 2, processors: [] }, false],
      ['delete-ingest-pipeline', 'ingest-pipeline', 'normalize', 'DELETE', '/_ingest/pipeline/normalize', null, true],
      ['create-stored-script', 'stored-script', 'calculate', 'PUT', '/_scripts/calculate', { script: { lang: 'painless', source: 'return 1' } }, false],
      ['update-stored-script', 'stored-script', 'calculate', 'PUT', '/_scripts/calculate', { script: { lang: 'painless', source: 'return 2' } }, false],
      ['delete-stored-script', 'stored-script', 'calculate', 'DELETE', '/_scripts/calculate', null, true],
      ['create-snapshot', 'snapshot', 'repository one/nightly', 'PUT', '/_snapshot/repository%20one/nightly?wait_for_completion=false', { indices: 'orders-*' }, false],
      [
        'restore-snapshot',
        'snapshot',
        'repository one/nightly',
        'POST',
        '/_snapshot/repository%20one/nightly/_restore?wait_for_completion=false',
        {
          indices: 'orders-*',
          ignore_unavailable: true,
          include_global_state: false,
          feature_states: ['geoip'],
          rename_pattern: '(.+)',
          rename_replacement: 'restored-$1',
          include_aliases: false,
          index_settings: { 'index.number_of_replicas': 0 },
          ignore_index_settings: ['index.refresh_interval'],
          partial: false
        },
        true
      ],
      ['delete-snapshot', 'snapshot', 'repository one/nightly', 'DELETE', '/_snapshot/repository%20one/nightly', null, true],
      ['cancel-task', 'task', 'node:42', 'POST', '/_tasks/node%3A42/_cancel', null, true]
    ].map(([action, kind, resourceId, method, path, payload, destructive]) => ({
      action,
      kind,
      resourceId,
      method,
      path,
      payload,
      destructive
    }))

    for (const testCase of cases) {
      const requests: CapturedRequest[] = []
      const service = createService(requests, async () => ({ acknowledged: true }))
      const request = operationRequest({
        action: testCase.action,
        kind: testCase.kind,
        resourceId: testCase.resourceId,
        payload: testCase.payload,
        destructive: testCase.destructive
      })

      const result = await service.executeConfirmedOperation(request)

      assert.equal(requests.length, 1)
      assert.equal(requests[0]?.path, testCase.path)
      assert.equal(requests[0]?.options.method, testCase.method)
      if (testCase.payload === null) {
        assert.equal(requests[0]?.options.body, undefined)
      } else {
        assert.deepEqual(JSON.parse(requests[0]?.options.body ?? ''), testCase.payload)
        assert.equal(requests[0]?.options.contentType, 'application/json')
      }
      assert.equal(result.requestId, request.requestId)
      assert.equal(result.traceId, request.requestId)
    }
  })

  it('只读连接在网络请求前拒绝写入', async () => {
    let requestCount = 0
    const service = createService([], async () => {
      requestCount += 1
      throw Object.assign(new Error('当前连接已开启只读模式'), {
        code: 'CONNECTION_READ_ONLY',
        statusCode: null
      })
    }, connectionSummary({ readOnly: true }))

    await assert.rejects(
      service.executeConfirmedOperation(operationRequest({
        action: 'delete-ingest-pipeline',
        kind: 'ingest-pipeline',
        resourceId: 'normalize',
        payload: null,
        destructive: true
      })),
      (error: unknown) => error instanceof ClusterResourceServiceError && error.code === 'FORBIDDEN'
    )
    assert.equal(requestCount, 0)
  })

  it('按数据流版本能力发布创建和删除动作', async () => {
    const unsupportedRequests: CapturedRequest[] = []
    const unsupported = createService(
      unsupportedRequests,
      async () => ({}),
      connectionSummary({ engine: 'Elasticsearch', version: '7.8.0' })
    )
    const supported = createService([], async () => ({ data_streams: [] }))

    const unsupportedResult = await unsupported.list({
      connectionId: 'connection-1',
      kind: 'data-stream'
    })
    const supportedResult = await supported.list({
      connectionId: 'connection-1',
      kind: 'data-stream'
    })

    assert.equal(unsupportedRequests.length, 0)
    assert.deepEqual(
      unsupportedResult.operations.map((item) => [item.action, item.state]),
      [['create-data-stream', 'unsupported'], ['delete-data-stream', 'unsupported']]
    )
    assert.deepEqual(
      supportedResult.operations.map((item) => [item.action, item.state]),
      [['create-data-stream', 'available'], ['delete-data-stream', 'available']]
    )
  })

  it('新建动作仅使用已确认名称生成资源 ID', async () => {
    const requests: CapturedRequest[] = []
    const service = createService(requests, async () => ({ acknowledged: true }))

    await service.executeConfirmedOperation(operationRequest({
      action: 'create-data-stream',
      kind: 'data-stream',
      resourceId: null,
      resourceName: 'logs-app',
      payload: null,
      destructive: false
    }))

    assert.equal(requests[0]?.path, '/_data_stream/logs-app')
  })

  it('返回任务 ID 和可审计摘要', async () => {
    const service = createService([], async () => ({ accepted: true, task: 'node-1:99' }))
    const request = operationRequest({
      action: 'create-snapshot',
      kind: 'snapshot',
      resourceId: 'repository/nightly',
      payload: {},
      destructive: false
    })

    const result = await service.executeConfirmedOperation(request)

    assert.equal(result.state, 'accepted')
    assert.equal(result.taskId, 'node-1:99')
    assert.match(result.message, /request-1/u)
    assert.match(result.message, /create-snapshot/u)
    assert.match(result.message, /repository\/nightly/u)
  })

  it('快照恢复审计摘要包含完整仓库、快照和任务 ID', async () => {
    const service = createService([], async () => ({ accepted: true, task: 'node-1:restore-9' }))
    const request = operationRequest({
      action: 'restore-snapshot',
      kind: 'snapshot',
      resourceId: 'repository-a/nightly',
      payload: { indices: 'orders-*', include_global_state: false },
      destructive: true
    })

    const result = await service.executeConfirmedOperation(request)

    assert.equal(result.state, 'accepted')
    assert.equal(result.taskId, 'node-1:restore-9')
    assert.match(result.message, /request-1/u)
    assert.match(result.message, /restore-snapshot/u)
    assert.match(result.message, /repository-a\/nightly/u)
  })

  it('区分写入权限不足、能力路径不支持和目标资源不存在', async () => {
    const createRequest = operationRequest({
      action: 'create-ingest-pipeline',
      kind: 'ingest-pipeline',
      resourceId: 'normalize',
      payload: { processors: [] },
      destructive: false
    })
    const deleteRequest = operationRequest({
      action: 'delete-ingest-pipeline',
      kind: 'ingest-pipeline',
      resourceId: 'normalize',
      payload: null,
      destructive: true
    })

    await assert.rejects(
      createService([], async () => { throw httpError(403) }).executeConfirmedOperation(createRequest),
      (error: unknown) => error instanceof ClusterResourceServiceError && error.code === 'FORBIDDEN'
    )
    await assert.rejects(
      createService([], async () => { throw httpError(404) }).executeConfirmedOperation(createRequest),
      (error: unknown) => error instanceof ClusterResourceServiceError && error.code === 'UNSUPPORTED'
    )
    await assert.rejects(
      createService([], async () => { throw httpError(404) }).executeConfirmedOperation(deleteRequest),
      (error: unknown) => error instanceof ClusterResourceServiceError && error.code === 'NOT_FOUND'
    )
  })

  it('在请求主进程前拒绝未开放动作、类型错配和非法输入', async () => {
    let requestCount = 0
    const service = createService([], async () => {
      requestCount += 1
      return {}
    })

    await assert.rejects(
      service.executeConfirmedOperation(operationRequest({
        action: 'restore-snapshot',
        kind: 'snapshot',
        resourceId: 'repository/nightly',
        payload: { unknown_field: true },
        destructive: true
      })),
      /payload 不允许字段 unknown_field/u
    )
    await assert.rejects(
      service.executeConfirmedOperation(operationRequest({
        action: 'restore-snapshot',
        kind: 'snapshot',
        resourceId: 'repository/nightly',
        payload: { include_global_state: 'false' },
        destructive: true
      })),
      /include_global_state 必须是布尔值/u
    )
    await assert.rejects(
      service.executeConfirmedOperation(operationRequest({
        action: 'delete-index-template',
        kind: 'stored-script',
        resourceId: 'orders',
        payload: null,
        destructive: true
      })),
      /资源类型不匹配/u
    )
    await assert.rejects(
      service.executeConfirmedOperation(operationRequest({
        action: 'delete-snapshot',
        kind: 'snapshot',
        resourceId: 'missing-repository-separator',
        payload: null,
        destructive: true
      })),
      /快照资源 ID/u
    )
    const circularPayload: Record<string, ClusterResourceValue> = {}
    circularPayload.self = circularPayload
    await assert.rejects(
      service.executeConfirmedOperation(operationRequest({
        action: 'create-ingest-pipeline',
        kind: 'ingest-pipeline',
        resourceId: 'normalize',
        payload: circularPayload,
        destructive: false
      })),
      /循环引用/u
    )
    assert.equal(requestCount, 0)
  })
})

function createService(
  requests: CapturedRequest[],
  execute: (request: CapturedRequest) => Promise<unknown>,
  summary = connectionSummary()
): ClusterResourceService {
  const connectionService: ClusterResourceConnectionService = {
    assertConnected(connectionId: string): string {
      return connectionId
    },
    list(): ConnectionSummary[] {
      return [{ ...summary }]
    },
    requestJson<T>(connectionId: string, path: string, options: RequestOptions = {}): Promise<T> {
      const request = { connectionId, path, options }
      requests.push(request)
      return execute(request) as Promise<T>
    }
  }
  return new ClusterResourceService(connectionService, { now: () => NOW })
}

function connectionSummary(overrides: Partial<ConnectionSummary> = {}): ConnectionSummary {
  return {
    id: 'connection-1',
    groupId: null,
    name: 'Production',
    endpoint: 'http://127.0.0.1:9200',
    endpointCount: 1,
    readOnly: false,
    mode: 'direct',
    authorizationType: 'none',
    sshEnabled: false,
    awsEnabled: false,
    status: 'connected',
    engine: 'elasticsearch',
    version: '8.12.0',
    lastError: null,
    ...overrides
  }
}

function operationRequest(overrides: {
  action: ClusterResourceOperationAction
  kind: ClusterResourceKind
  resourceId: string | null
  resourceName?: string
  payload: ClusterResourceValue | null
  destructive: boolean
}): ClusterResourceOperationRequest {
  return {
    requestId: 'request-1',
    connectionId: 'connection-1',
    connectionName: 'Production',
    resourceName: overrides.resourceName ?? overrides.resourceId ?? '',
    impactScope: `operate ${overrides.resourceName ?? overrides.resourceId}`,
    ...overrides,
    resourceName: overrides.resourceName ?? overrides.resourceId ?? ''
  }
}

function httpError(statusCode: number): Error {
  return Object.assign(new Error(`HTTP ${statusCode}`), {
    code: 'CONNECTION_ALL_ENDPOINTS_FAILED',
    statusCode
  })
}
