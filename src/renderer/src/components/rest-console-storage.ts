import type { RestRequestMethod } from '../../../shared/types/rest'

export type RestConsoleStorage = Pick<Storage, 'getItem' | 'setItem'>

export type RestConsoleDraft = {
  method: RestRequestMethod
  path: string
  body: string
}

export type RestSavedRequest = RestConsoleDraft & {
  id: string
  savedAt: string
}

type StoredDraft = {
  version: 1
  draft: RestConsoleDraft
}

type StoredRequestCollection = {
  version: 1
  requests: RestSavedRequest[]
}

export const MAX_REST_HISTORY_COUNT = 50
export const MAX_REST_FAVORITE_COUNT = 50
export const MAX_REST_BODY_BYTES = 512 * 1024
const MAX_REST_PATH_LENGTH = 8_192
const MAX_IDENTIFIER_LENGTH = 256
const MAX_DRAFT_STORAGE_BYTES = 600 * 1024
const MAX_COLLECTION_STORAGE_BYTES = 2 * 1024 * 1024
const METHODS = new Set<RestRequestMethod>(['GET', 'POST', 'PUT', 'DELETE'])

export class RestConsoleStorageError extends Error {
  constructor(operation: string, reason: string, options?: ErrorOptions) {
    super(`REST 本地存储失败：操作=${operation}，原因=${reason}`, options)
    this.name = 'RestConsoleStorageError'
  }
}

export function readRestConsoleDraft(
  storage: RestConsoleStorage,
  connectionId: string,
  tabId: string
): RestConsoleDraft | null {
  const raw = readStorageItem(storage, draftStorageKey(connectionId, tabId), '读取草稿')
  if (raw === null) return null
  assertStorageSize(raw, MAX_DRAFT_STORAGE_BYTES, '草稿')
  const stored = parseJsonRecord(raw, '草稿')
  if (stored.version !== 1) throw invalidStorage('草稿版本不受支持')
  return normalizeDraft(stored.draft, '草稿')
}

export function writeRestConsoleDraft(
  storage: RestConsoleStorage,
  connectionId: string,
  tabId: string,
  draft: RestConsoleDraft
): void {
  const stored: StoredDraft = { version: 1, draft: normalizeDraft(draft, '草稿') }
  writeStorageItem(
    storage,
    draftStorageKey(connectionId, tabId),
    serializeWithinLimit(stored, MAX_DRAFT_STORAGE_BYTES, '草稿'),
    '保存草稿'
  )
}

export function readRestRequestHistory(
  storage: RestConsoleStorage,
  connectionId: string
): RestSavedRequest[] {
  return readRequestCollection(storage, historyStorageKey(connectionId), MAX_REST_HISTORY_COUNT, '请求历史')
}

export function addRestRequestHistory(
  storage: RestConsoleStorage,
  connectionId: string,
  request: RestSavedRequest
): RestSavedRequest[] {
  const history = readRestRequestHistory(storage, connectionId)
  const normalized = normalizeSavedRequest(request, '请求历史')
  const deduplicated = history.filter((item) => !isSameRequest(item, normalized))
  const next = fitRequestCollection([normalized, ...deduplicated], MAX_REST_HISTORY_COUNT, '请求历史')
  writeRequestCollection(storage, historyStorageKey(connectionId), next, '保存请求历史')
  return next
}

export function clearRestRequestHistory(storage: RestConsoleStorage, connectionId: string): void {
  writeRequestCollection(storage, historyStorageKey(connectionId), [], '清空请求历史')
}

export function readRestRequestFavorites(
  storage: RestConsoleStorage,
  connectionId: string
): RestSavedRequest[] {
  return readRequestCollection(storage, favoriteStorageKey(connectionId), MAX_REST_FAVORITE_COUNT, '请求收藏')
}

export function toggleRestRequestFavorite(
  storage: RestConsoleStorage,
  connectionId: string,
  request: RestSavedRequest
): { favorites: RestSavedRequest[]; favorite: boolean } {
  const favorites = readRestRequestFavorites(storage, connectionId)
  const normalized = normalizeSavedRequest(request, '请求收藏')
  const existing = favorites.find((item) => isSameRequest(item, normalized))
  const next = existing
    ? favorites.filter((item) => item.id !== existing.id)
    : fitRequestCollection([normalized, ...favorites], MAX_REST_FAVORITE_COUNT, '请求收藏')
  writeRequestCollection(storage, favoriteStorageKey(connectionId), next, '保存请求收藏')
  return { favorites: next, favorite: !existing }
}

export function isRestRequestFavorite(
  favorites: readonly RestSavedRequest[],
  draft: RestConsoleDraft
): boolean {
  return favorites.some((item) => isSameRequest(item, draft))
}

function readRequestCollection(
  storage: RestConsoleStorage,
  key: string,
  maximumCount: number,
  label: string
): RestSavedRequest[] {
  const raw = readStorageItem(storage, key, `读取${label}`)
  if (raw === null) return []
  assertStorageSize(raw, MAX_COLLECTION_STORAGE_BYTES, label)
  const stored = parseJsonRecord(raw, label)
  if (stored.version !== 1 || !Array.isArray(stored.requests)) {
    throw invalidStorage(`${label}结构无效`)
  }
  if (stored.requests.length > maximumCount) {
    throw invalidStorage(`${label}条数不能超过 ${maximumCount}`)
  }
  return stored.requests.map((item, index) => normalizeSavedRequest(item, `${label}[${index}]`))
}

function writeRequestCollection(
  storage: RestConsoleStorage,
  key: string,
  requests: RestSavedRequest[],
  operation: string
): void {
  const stored: StoredRequestCollection = { version: 1, requests }
  writeStorageItem(
    storage,
    key,
    serializeWithinLimit(stored, MAX_COLLECTION_STORAGE_BYTES, operation),
    operation
  )
}

function fitRequestCollection(
  requests: RestSavedRequest[],
  maximumCount: number,
  label: string
): RestSavedRequest[] {
  const next = requests.slice(0, maximumCount)
  while (next.length > 0) {
    const serialized = JSON.stringify({ version: 1, requests: next })
    if (byteLength(serialized) <= MAX_COLLECTION_STORAGE_BYTES) return next
    next.pop()
  }
  throw invalidStorage(`${label}单条记录超过存储上限`)
}

function normalizeDraft(value: unknown, label: string): RestConsoleDraft {
  if (!isRecord(value) || !METHODS.has(value.method as RestRequestMethod)) {
    throw invalidStorage(`${label} method 无效`)
  }
  if (
    typeof value.path !== 'string' ||
    value.path.length === 0 ||
    value.path.length > MAX_REST_PATH_LENGTH ||
    !value.path.startsWith('/')
  ) {
    throw invalidStorage(`${label} path 无效`)
  }
  if (typeof value.body !== 'string' || byteLength(value.body) > MAX_REST_BODY_BYTES) {
    throw invalidStorage(`${label} body 必须是大小不超过 ${MAX_REST_BODY_BYTES} 字节的字符串`)
  }
  return { method: value.method as RestRequestMethod, path: value.path, body: value.body }
}

function normalizeSavedRequest(value: unknown, label: string): RestSavedRequest {
  if (!isRecord(value)) throw invalidStorage(`${label}必须是对象`)
  const draft = normalizeDraft(value, label)
  const id = normalizeIdentifier(value.id, `${label}.id`)
  if (typeof value.savedAt !== 'string' || !Number.isFinite(Date.parse(value.savedAt))) {
    throw invalidStorage(`${label}.savedAt 必须是有效时间`)
  }
  return { ...draft, id, savedAt: new Date(value.savedAt).toISOString() }
}

function normalizeIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_IDENTIFIER_LENGTH) {
    throw invalidStorage(`${label} 必须是 1-${MAX_IDENTIFIER_LENGTH} 位字符串`)
  }
  return value
}

function draftStorageKey(connectionId: string, tabId: string): string {
  return `es-atlas:rest:draft:${encodeStorageSegment(connectionId)}:${encodeStorageSegment(tabId)}`
}

function historyStorageKey(connectionId: string): string {
  return `es-atlas:rest:history:${encodeStorageSegment(connectionId)}`
}

function favoriteStorageKey(connectionId: string): string {
  return `es-atlas:rest:favorites:${encodeStorageSegment(connectionId)}`
}

function encodeStorageSegment(value: string): string {
  return encodeURIComponent(normalizeIdentifier(value, '存储键'))
}

function readStorageItem(storage: RestConsoleStorage, key: string, operation: string): string | null {
  try {
    return storage.getItem(key)
  } catch (error: unknown) {
    throw new RestConsoleStorageError(operation, getErrorMessage(error), { cause: error })
  }
}

function writeStorageItem(
  storage: RestConsoleStorage,
  key: string,
  value: string,
  operation: string
): void {
  try {
    storage.setItem(key, value)
  } catch (error: unknown) {
    throw new RestConsoleStorageError(operation, getErrorMessage(error), { cause: error })
  }
}

function parseJsonRecord(value: string, label: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown
    if (!isRecord(parsed)) throw invalidStorage(`${label}必须是 JSON 对象`)
    return parsed
  } catch (error: unknown) {
    if (error instanceof RestConsoleStorageError) throw error
    throw new RestConsoleStorageError(`解析${label}`, getErrorMessage(error), { cause: error })
  }
}

function serializeWithinLimit(value: unknown, maximumBytes: number, label: string): string {
  const serialized = JSON.stringify(value)
  assertStorageSize(serialized, maximumBytes, label)
  return serialized
}

function assertStorageSize(value: string, maximumBytes: number, label: string): void {
  const size = byteLength(value)
  if (size > maximumBytes) throw invalidStorage(`${label}不能超过 ${maximumBytes} 字节，当前=${size}`)
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function isSameRequest(left: RestConsoleDraft, right: RestConsoleDraft): boolean {
  return left.method === right.method && left.path === right.path && left.body === right.body
}

function invalidStorage(reason: string): RestConsoleStorageError {
  return new RestConsoleStorageError('校验数据', reason)
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
