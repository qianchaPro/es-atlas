import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  OperationService,
  OperationServiceError,
  type OperationConnectionService
} from '../../electron/main/es/operation-service.ts'
import type { ConnectionSummary } from '../../src/shared/types/connection.ts'

type CapturedRequest = {
  connectionId: string
  path: string
  options: {
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
    body?: string
    contentType?: 'application/json' | 'application/x-ndjson'
  }
}

function createConnectionService(
  execute: (request: CapturedRequest) => Promise<unknown>,
  connectionOverrides: Partial<ConnectionSummary> = {}
): OperationConnectionService {
  const connection: ConnectionSummary = {
    id: 'connection-1',
    groupId: null,
    name: '测试连接',
    endpoint: 'http://127.0.0.1:9200',
    endpointCount: 1,
    readOnly: false,
    mode: 'direct',
    authorizationType: 'none',
    sshEnabled: false,
    awsEnabled: false,
    status: 'connected',
    engine: 'Elasticsearch',
    version: '8.17.3',
    lastError: null,
    ...connectionOverrides
  }
  return {
    assertConnected(connectionId: string): string {
      return connectionId
    },
    list(): ConnectionSummary[] {
      return [{ ...connection }]
    },
    requestJson<T>(
      connectionId: string,
      path: string,
      options: CapturedRequest['options'] = {}
    ): Promise<T> {
      return execute({ connectionId, path, options }) as Promise<T>
    }
  }
}

describe('集群长任务服务', () => {
  it('使用固定 Reindex 路径提交结构化任务并返回 taskId', async () => {
    let capturedRequest: CapturedRequest | null = null
    const service = new OperationService(createConnectionService(async (request) => {
      capturedRequest = request
      return { task: 'node-1:42' }
    }))

    const result = await service.submitReindex({
      requestId: 'request-1',
      connectionId: 'connection-1',
      sourceIndex: 'source/index',
      destinationIndex: 'target-index',
      conflicts: 'proceed',
      query: { term: { status: 'ready' } }
    })

    assert.deepEqual(capturedRequest, {
      connectionId: 'connection-1',
      path: '/_reindex?wait_for_completion=false',
      options: {
        method: 'POST',
        contentType: 'application/json',
        body: JSON.stringify({
          source: {
            index: 'source/index',
            query: { term: { status: 'ready' } }
          },
          dest: { index: 'target-index' },
          conflicts: 'proceed'
        })
      }
    })
    assert.deepEqual(result, {
      requestId: 'request-1',
      taskId: 'node-1:42',
      status: 'running',
      payload: { task: 'node-1:42' }
    })
  })

  it('按 Elasticsearch 能力前缀编码索引并提交异步搜索', async () => {
    let capturedRequest: CapturedRequest | null = null
    const service = new OperationService(createConnectionService(async (request) => {
      capturedRequest = request
      return { id: 'async/id+1=', is_running: true, is_partial: true }
    }))

    const result = await service.submitAsyncSearch({
      requestId: 'request-es',
      connectionId: 'connection-1',
      pathPrefix: '/_async_search',
      index: 'logs/2026?scope=*',
      query: { match_all: {} },
      keepAlive: '1h',
      waitForCompletionTimeout: '100ms',
      keepOnCompletion: true
    })

    assert.equal(
      (capturedRequest as CapturedRequest | null)?.path,
      '/logs%2F2026%3Fscope%3D%2A/_async_search?keep_alive=1h&wait_for_completion_timeout=100ms&keep_on_completion=true'
    )
    assert.deepEqual((capturedRequest as CapturedRequest | null)?.options, {
      method: 'POST',
      contentType: 'application/json',
      body: JSON.stringify({ match_all: {} })
    })
    assert.equal(result.taskId, 'async/id+1=')
    assert.equal(result.status, 'running')
  })

  it('按 OpenSearch 能力前缀执行 submit/get/delete 并编码资源 ID', async () => {
    const requests: CapturedRequest[] = []
    const responses = [
      { id: 'open/id+1=', state: 'RUNNING' },
      { id: 'open/id+1=', state: 'STORE_RESIDENT' },
      { acknowledged: true }
    ]
    const service = new OperationService(
      createConnectionService(
        async (request) => {
          requests.push(request)
          return responses[requests.length - 1]
        },
        { engine: 'OpenSearch', version: '2.19.1' }
      )
    )

    const submitted = await service.submitAsyncSearch({
      requestId: 'request-submit',
      connectionId: 'connection-1',
      pathPrefix: '/_plugins/_asynchronous_search',
      index: 'logs-*',
      query: { size: 0 }
    })
    const loaded = await service.getAsyncSearch({
      requestId: 'request-get',
      connectionId: 'connection-1',
      pathPrefix: '/_plugins/_asynchronous_search',
      taskId: 'open/id+1='
    })
    const deleted = await service.deleteAsyncSearch({
      requestId: 'request-delete',
      connectionId: 'connection-1',
      pathPrefix: '/_plugins/_asynchronous_search',
      taskId: 'open/id+1='
    })

    assert.equal(requests[0].path, '/_plugins/_asynchronous_search?index=logs-%2A')
    assert.equal(requests[0].options.method, 'POST')
    assert.equal(requests[1].path, '/_plugins/_asynchronous_search/open%2Fid%2B1%3D')
    assert.equal(requests[1].options.method, 'GET')
    assert.equal(requests[2].path, '/_plugins/_asynchronous_search/open%2Fid%2B1%3D')
    assert.equal(requests[2].options.method, 'DELETE')
    assert.equal(submitted.status, 'running')
    assert.equal(loaded.status, 'completed')
    assert.equal(deleted.status, 'canceled')
  })

  it('拒绝自定义路径前缀和非 JSON 查询且不发送请求', async () => {
    let callCount = 0
    const service = new OperationService(createConnectionService(async () => {
      callCount += 1
      return {}
    }))

    await assert.rejects(
      service.getAsyncSearch({
        requestId: 'request-prefix',
        connectionId: 'connection-1',
        pathPrefix: '/../../_tasks' as '/_async_search',
        taskId: 'task-1'
      }),
      (error: unknown) => error instanceof OperationServiceError && error.code === 'VALIDATION'
    )
    await assert.rejects(
      service.submitAsyncSearch({
        requestId: 'request-query',
        connectionId: 'connection-1',
        pathPrefix: '/_async_search',
        index: 'logs',
        query: { invalid: undefined } as never
      }),
      (error: unknown) => error instanceof OperationServiceError && error.code === 'VALIDATION'
    )
    assert.equal(callCount, 0)
  })

  it('从能力矩阵返回固定前缀并拒绝产品路径错配和只读写入', async () => {
    let callCount = 0
    const openSearchService = new OperationService(
      createConnectionService(
        async () => {
          callCount += 1
          return {}
        },
        { engine: 'OpenSearch', version: '2.19.1' }
      )
    )

    const capabilities = openSearchService.getCapabilities('connection-1')
    assert.equal(capabilities.asyncSearchPathPrefix, '/_plugins/_asynchronous_search')
    await assert.rejects(
      openSearchService.submitAsyncSearch({
        requestId: 'request-wrong-prefix',
        connectionId: 'connection-1',
        pathPrefix: '/_async_search',
        index: 'logs',
        query: { size: 0 }
      }),
      (error: unknown) => error instanceof OperationServiceError && error.code === 'VALIDATION'
    )

    const readOnlyService = new OperationService(
      createConnectionService(async () => {
        callCount += 1
        return {}
      }, { readOnly: true })
    )
    await assert.rejects(
      readOnlyService.submitReindex({
        requestId: 'request-read-only',
        connectionId: 'connection-1',
        sourceIndex: 'source',
        destinationIndex: 'target'
      }),
      (error: unknown) => error instanceof OperationServiceError && error.code === 'READ_ONLY'
    )
    assert.equal(callCount, 0)
  })

  it('区分 403、404、超时和只读拒绝', async () => {
    const cases = [
      [{ statusCode: 403, code: 'CONNECTION_ALL_ENDPOINTS_FAILED' }, 'FORBIDDEN'],
      [{ statusCode: 404, code: 'CONNECTION_ALL_ENDPOINTS_FAILED' }, 'NOT_FOUND'],
      [{ statusCode: null, code: 'CONNECTION_TIMEOUT', message: '请求超过 5000ms' }, 'TIMEOUT'],
      [{ statusCode: null, code: 'CONNECTION_READ_ONLY' }, 'READ_ONLY']
    ] as const

    for (const [failure, expectedCode] of cases) {
      const service = new OperationService(createConnectionService(async () => {
        const message = 'message' in failure ? failure.message : 'request failed'
        throw Object.assign(new Error(message), failure)
      }))

      await assert.rejects(
        service.submitReindex({
          requestId: `request-${expectedCode}`,
          connectionId: 'connection-1',
          sourceIndex: 'source',
          destinationIndex: 'target'
        }),
        (error: unknown) =>
          error instanceof OperationServiceError &&
          error.code === expectedCode &&
          error.statusCode === failure.statusCode
      )
    }
  })
})
