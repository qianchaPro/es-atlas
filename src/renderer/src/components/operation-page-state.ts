import type {
  ClusterOperationCapabilities,
  ClusterOperationJsonObject
} from '../../../shared/types/cluster-operation'

export type ClusterOperationAvailability = {
  reindex: boolean
  asyncSubmit: boolean
  asyncRead: boolean
  asyncDelete: boolean
  reindexReason: string
  asyncSearchReason: string
}

export function createClusterOperationAvailability(
  connected: boolean,
  capabilities: ClusterOperationCapabilities | null
): ClusterOperationAvailability {
  if (!connected || !capabilities) {
    const reason = connected ? '正在读取集群能力' : '当前连接尚未建立'
    return {
      reindex: false,
      asyncSubmit: false,
      asyncRead: false,
      asyncDelete: false,
      reindexReason: reason,
      asyncSearchReason: reason
    }
  }

  const hasAsyncPath = capabilities.asyncSearchPathPrefix !== null
  const reindex = !capabilities.readOnly &&
    capabilities.reindex.supported &&
    capabilities.reindex.writeSupported
  const asyncRead = capabilities.asyncSearch.supported && hasAsyncPath
  const asyncWrite = !capabilities.readOnly &&
    capabilities.asyncSearch.writeSupported &&
    hasAsyncPath

  return {
    reindex,
    asyncSubmit: asyncWrite,
    asyncRead,
    asyncDelete: asyncWrite,
    reindexReason: capabilities.readOnly ? '当前连接为只读模式' : capabilities.reindex.reason,
    asyncSearchReason: capabilities.readOnly
      ? '当前连接为只读模式，仅允许查询已存在的异步搜索任务'
      : capabilities.asyncSearch.reason
  }
}

export function parseClusterOperationJsonObject(
  source: string,
  field: string
): ClusterOperationJsonObject {
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new TypeError(`${field} 不是有效 JSON：${reason}`, { cause: error })
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError(`${field} 必须是 JSON 对象`)
  }
  return parsed as ClusterOperationJsonObject
}

export function normalizeClusterOperationError(error: unknown, operation: string): string {
  if (error instanceof Error && error.message) return `${operation}失败：${error.message}`
  if (error && typeof error === 'object' && !Array.isArray(error)) {
    const message = (error as Record<string, unknown>).message
    if (typeof message === 'string' && message) return `${operation}失败：${message}`
  }
  return `${operation}失败：未知错误`
}
