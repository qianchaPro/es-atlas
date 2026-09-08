import { randomUUID } from 'node:crypto'
import type { AppLogInput } from '../../../src/shared/types/log'
import type { ConnectionRequestObservation } from '../connection/connection-service'

type RequestLogSink = {
  record: (input: AppLogInput) => unknown
}

export function createRequestLogObserver(
  logSink: RequestLogSink
): (input: ConnectionRequestObservation) => void {
  return (input) => {
    const operation = classifyOperation(input)
    logSink.record({
      createdAt: input.startedAtMs,
      connectionId: input.connectionId,
      connectionName: input.connectionName,
      level: input.successful ? 'info' : 'error',
      operation,
      method: input.method,
      path: input.path,
      statusCode: input.statusCode,
      durationMs: input.durationMs,
      traceId: randomUUID(),
      message: input.successful ? '请求完成' : `请求失败：code=${input.errorCode ?? 'UNKNOWN'}`,
      error: input.successful
        ? null
        : { code: input.errorCode ?? 'UNKNOWN', statusCode: input.statusCode }
    })
  }
}

function classifyOperation(input: ConnectionRequestObservation): string {
  if (input.source === 'connection') return 'connection.test'
  if (
    input.path.includes('/_reindex') ||
    input.path.includes('/_async_search') ||
    input.path.includes('/_asynchronous_search')
  ) {
    return 'cluster.long-operation'
  }
  if (
    input.source === 'overview' ||
    input.path.startsWith('/_cluster/') ||
    input.path.startsWith('/_nodes') ||
    input.path.startsWith('/_cat/')
  ) {
    return 'cluster.request'
  }
  if (input.source === 'index' || input.path !== '/') return 'index.request'
  return 'es.request'
}
