import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { RestExecutor, type RestConnectionService } from '../../electron/main/es/rest-executor.ts'

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
  execute: (request: CapturedRequest) => Promise<unknown>
): RestConnectionService {
  return {
    assertConnected(connectionId: string): string {
      return connectionId
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

function createInput(overrides: Record<string, unknown> = {}) {
  return {
    requestId: 'request-1',
    connectionId: 'connection-1',
    tabId: 'rest-connection-1',
    request: {
      method: 'GET' as const,
      path: '/_cluster/health?pretty=true',
      body: null
    },
    ...overrides
  }
}

describe('REST 执行器', () => {
  it('复用连接服务执行 JSON 请求且不伪造响应元数据', async () => {
    let capturedRequest: CapturedRequest | null = null
    const executor = new RestExecutor(createConnectionService(async (request) => {
      capturedRequest = request
      return { status: 'green' }
    }))

    const result = await executor.execute(createInput())

    assert.deepEqual(capturedRequest, {
      connectionId: 'connection-1',
      path: '/_cluster/health?pretty=true',
      options: { method: 'GET' }
    })
    assert.equal(result.state, 'success')
    assert.equal(result.statusCode, null)
    assert.deepEqual(result.headers, [])
    assert.deepEqual(result.body, { status: 'green' })
    assert.equal(result.error, null)
  })

  it('校验并原样提交 JSON 请求体', async () => {
    let capturedRequest: CapturedRequest | null = null
    const executor = new RestExecutor(createConnectionService(async (request) => {
      capturedRequest = request
      return { acknowledged: true }
    }))
    const body = '{\n  "index.blocks.read_only": false\n}'

    const result = await executor.execute(createInput({
      request: { method: 'PUT', path: '/sample/_settings', body }
    }))

    assert.equal(result.state, 'success')
    assert.deepEqual((capturedRequest as CapturedRequest | null)?.options, {
      method: 'PUT',
      body,
      contentType: 'application/json'
    })
  })

  it('在调用连接服务前拒绝非法路径和非法 JSON', async () => {
    let callCount = 0
    const executor = new RestExecutor(createConnectionService(async () => {
      callCount += 1
      return {}
    }))

    const invalidPath = await executor.execute(createInput({
      request: { method: 'GET', path: 'http://localhost:9200/', body: null }
    }))
    const invalidBody = await executor.execute(createInput({
      requestId: 'request-2',
      request: { method: 'POST', path: '/_search', body: '{invalid' }
    }))

    assert.equal(callCount, 0)
    assert.equal(invalidPath.error?.kind, 'validation')
    assert.equal(invalidBody.error?.kind, 'validation')
  })

  it('按 HTTP 状态区分认证、权限、资源、限流和服务端错误', async () => {
    const cases = [
      [401, 'unauthorized'],
      [403, 'forbidden'],
      [404, 'not-found'],
      [429, 'rate-limited'],
      [503, 'server']
    ] as const

    for (const [statusCode, expectedKind] of cases) {
      const executor = new RestExecutor(createConnectionService(async () => {
        throw Object.assign(new Error(`HTTP ${statusCode}`), {
          code: 'CONNECTION_ALL_ENDPOINTS_FAILED',
          statusCode
        })
      }))
      const result = await executor.execute(createInput({ requestId: `request-${statusCode}` }))

      assert.equal(result.state, 'failed')
      assert.equal(result.statusCode, statusCode)
      assert.equal(result.error?.kind, expectedKind)
    }
  })

  it('将只读和超时错误映射为明确状态', async () => {
    const readOnlyExecutor = new RestExecutor(createConnectionService(async () => {
      throw Object.assign(new Error('当前连接已开启只读模式'), {
        code: 'CONNECTION_READ_ONLY',
        statusCode: null
      })
    }))
    const timeoutExecutor = new RestExecutor(createConnectionService(async () => {
      throw Object.assign(new Error('请求超过 5000ms'), {
        code: 'CONNECTION_ALL_ENDPOINTS_FAILED',
        statusCode: null
      })
    }))

    const readOnlyResult = await readOnlyExecutor.execute(createInput())
    const timeoutResult = await timeoutExecutor.execute(createInput())

    assert.equal(readOnlyResult.state, 'failed')
    assert.equal(readOnlyResult.error?.kind, 'read-only')
    assert.equal(timeoutResult.state, 'timed-out')
    assert.equal(timeoutResult.error?.kind, 'timeout')
  })

  it('取消活动请求后立即返回 canceled 并忽略迟到响应', async () => {
    let resolveRequest: ((value: unknown) => void) | null = null
    const executor = new RestExecutor(createConnectionService(() =>
      new Promise((resolve) => {
        resolveRequest = resolve
      })
    ))

    const execution = executor.execute(createInput())
    await Promise.resolve()
    const cancellation = executor.cancel({ requestId: 'request-1' })
    const result = await execution

    assert.deepEqual(cancellation, { requestId: 'request-1', canceled: true })
    assert.equal(result.state, 'canceled')
    assert.equal(result.error?.kind, 'canceled')
    const resolveLateRequest = resolveRequest as ((value: unknown) => void) | null
    resolveLateRequest?.({ late: true })
    assert.deepEqual(executor.cancel({ requestId: 'request-1' }), {
      requestId: 'request-1',
      canceled: false
    })
  })
})
