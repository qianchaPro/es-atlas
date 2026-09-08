import { defineStore } from 'pinia'
import type {
  OpenWorkspaceTabResult,
  PersistedWorkspaceTab,
  TabKind,
  TabPayload,
  WorkspacePageState,
  WorkspaceRestoreError,
  WorkspaceRestoreOptions,
  WorkspaceRestoreResult,
  WorkspaceSerializableValue,
  WorkspaceSnapshot,
  WorkspaceState,
  WorkspaceTab,
  WorkspaceTabExecutionState
} from '../../../shared/types/workspace'

const WORKSPACE_SNAPSHOT_VERSION = 1
const WORKSPACE_TAB_KINDS: readonly TabKind[] = [
  'connection-dashboard',
  'index-browser',
  'rest-console',
  'node-detail',
  'template-editor',
  'task-detail',
  'log-view'
]

type RawWorkspaceSnapshot = {
  tabs: unknown[]
  activeTabIds: Record<string, unknown>
}

const NON_PERSISTED_STATE_KEYS = new Set([
  'accessToken',
  'apiKey',
  'authorization',
  'autoExecute',
  'credentials',
  'executeOnRestore',
  'isExecuting',
  'password',
  'refreshToken',
  'response',
  'responseBody',
  'responses',
  'secret',
  'token'
])

export function createEmptyWorkspaceState(): WorkspaceState {
  return {
    tabs: [],
    activeTabIds: {}
  }
}

export function createWorkspaceTabReuseKey(payload: Pick<
  TabPayload,
  'workspaceId' | 'connectionId' | 'kind' | 'resourceKey'
>): string {
  return JSON.stringify([
    requireNonEmptyString(payload.workspaceId, 'workspaceId'),
    payload.connectionId ?? null,
    payload.kind,
    payload.resourceKey ?? null
  ])
}

export function createWorkspaceTabId(payload: Pick<
  TabPayload,
  'workspaceId' | 'connectionId' | 'kind' | 'resourceKey'
>): string {
  const segments = [
    payload.workspaceId,
    payload.connectionId ?? 'global',
    payload.kind,
    payload.resourceKey ?? 'default'
  ]
  return segments.map((segment) => encodeURIComponent(segment)).join(':')
}

export function openWorkspaceTab(state: WorkspaceState, payload: TabPayload): OpenWorkspaceTabResult {
  validateTabPayload(payload)
  const reuseKey = createWorkspaceTabReuseKey(payload)
  const existingTab = state.tabs.find((tab) => createWorkspaceTabReuseKey(tab) === reuseKey)

  if (existingTab) {
    return {
      state: activateWorkspaceTab(state, existingTab.id),
      tab: existingTab,
      reused: true
    }
  }

  const tab: WorkspaceTab = {
    id: createWorkspaceTabId(payload),
    workspaceId: payload.workspaceId,
    ...(payload.connectionId === undefined ? {} : { connectionId: payload.connectionId }),
    kind: payload.kind,
    title: payload.title,
    ...(payload.resourceKey === undefined ? {} : { resourceKey: payload.resourceKey }),
    closable: payload.closable ?? true,
    state: clonePageState(payload.state ?? {}),
    dirty: payload.dirty ?? false,
    loadState: 'loaded',
    executionState: 'idle',
    readOnly: false,
    closing: false
  }

  return {
    state: {
      tabs: [...state.tabs, tab],
      activeTabIds: {
        ...state.activeTabIds,
        [tab.workspaceId]: tab.id
      }
    },
    tab,
    reused: false
  }
}

export function activateWorkspaceTab(state: WorkspaceState, tabId: string): WorkspaceState {
  const tab = state.tabs.find((item) => item.id === tabId)
  if (!tab) return state
  if (state.activeTabIds[tab.workspaceId] === tab.id) return state

  return {
    tabs: state.tabs,
    activeTabIds: {
      ...state.activeTabIds,
      [tab.workspaceId]: tab.id
    }
  }
}

export function closeWorkspaceTab(state: WorkspaceState, tabId: string): WorkspaceState {
  const tab = state.tabs.find((item) => item.id === tabId)
  if (!tab || !tab.closable) return state
  return removeWorkspaceTabs(state, new Set([tab.id]))
}

export function closeOtherWorkspaceTabs(state: WorkspaceState, tabId: string): WorkspaceState {
  const tab = state.tabs.find((item) => item.id === tabId)
  if (!tab) return state

  const removedTabIds = new Set(
    state.tabs
      .filter((item) => item.workspaceId === tab.workspaceId && item.id !== tab.id && item.closable)
      .map((item) => item.id)
  )
  const nextState = removeWorkspaceTabs(state, removedTabIds)
  return activateWorkspaceTab(nextState, tab.id)
}

export function closeWorkspaceTabsToRight(state: WorkspaceState, tabId: string): WorkspaceState {
  const workspaceTabs = getWorkspaceTabsForTab(state, tabId)
  const tabIndex = workspaceTabs.findIndex((tab) => tab.id === tabId)
  if (tabIndex === -1) return state

  const removedTabIds = new Set(
    workspaceTabs
      .slice(tabIndex + 1)
      .filter((tab) => tab.closable)
      .map((tab) => tab.id)
  )
  return removeWorkspaceTabs(state, removedTabIds)
}

export function closeAllWorkspaceTabs(state: WorkspaceState, workspaceId: string): WorkspaceState {
  const removedTabIds = new Set(
    state.tabs
      .filter((tab) => tab.workspaceId === workspaceId && tab.closable)
      .map((tab) => tab.id)
  )
  return removeWorkspaceTabs(state, removedTabIds)
}

export function closeConnectionWorkspaceTabs(
  state: WorkspaceState,
  connectionId: string
): WorkspaceState {
  const removedTabIds = new Set(
    state.tabs.filter((tab) => tab.connectionId === connectionId).map((tab) => tab.id)
  )
  return removeWorkspaceTabs(state, removedTabIds)
}

export function updateWorkspaceTabState(
  state: WorkspaceState,
  tabId: string,
  pageState: WorkspacePageState,
  dirty?: boolean
): WorkspaceState {
  return updateWorkspaceTab(state, tabId, (tab) => ({
    ...tab,
    state: clonePageState(pageState),
    dirty: dirty ?? tab.dirty
  }))
}

export function markWorkspaceTabLoaded(state: WorkspaceState, tabId: string): WorkspaceState {
  return updateWorkspaceTab(state, tabId, (tab) => ({
    ...tab,
    loadState: 'loaded',
    readOnly: false
  }))
}

export function setWorkspaceTabExecutionState(
  state: WorkspaceState,
  tabId: string,
  executionState: WorkspaceTabExecutionState
): WorkspaceState {
  return updateWorkspaceTab(state, tabId, (tab) => ({ ...tab, executionState }))
}

export function createWorkspaceSnapshot(state: WorkspaceState): WorkspaceSnapshot {
  const tabs: PersistedWorkspaceTab[] = state.tabs.map((tab) => ({
    id: tab.id,
    workspaceId: tab.workspaceId,
    ...(tab.connectionId === undefined ? {} : { connectionId: tab.connectionId }),
    kind: tab.kind,
    title: tab.title,
    ...(tab.resourceKey === undefined ? {} : { resourceKey: tab.resourceKey }),
    closable: tab.closable,
    state: clonePageState(tab.state, true),
    dirty: tab.dirty
  }))
  const validTabIds = new Set(tabs.map((tab) => tab.id))
  const activeTabIds = Object.fromEntries(
    Object.entries(state.activeTabIds).filter(([, tabId]) => validTabIds.has(tabId))
  )

  return {
    version: WORKSPACE_SNAPSHOT_VERSION,
    tabs,
    activeTabIds
  }
}

export function serializeWorkspaceState(state: WorkspaceState): string {
  return JSON.stringify(createWorkspaceSnapshot(state))
}

export function restoreWorkspaceState(
  serializedSnapshot: string | unknown,
  options: WorkspaceRestoreOptions = {}
): WorkspaceRestoreResult {
  const errors: WorkspaceRestoreError[] = []
  const snapshot = parseWorkspaceSnapshot(serializedSnapshot, errors)
  if (!snapshot) return { state: createEmptyWorkspaceState(), errors }

  const validConnectionIds = createValidConnectionIdSet(options.validConnectionIds)
  const tabs: WorkspaceTab[] = []
  const tabIds = new Set<string>()
  const reuseKeys = new Set<string>()

  // 恢复阶段逐个校验并去重，单个损坏标签不能阻断其他可恢复页面。
  snapshot.tabs.forEach((value: unknown, index: number) => {
    const tab = restoreWorkspaceTab(value, index, validConnectionIds, errors)
    if (!tab) return

    const reuseKey = createWorkspaceTabReuseKey(tab)
    if (tabIds.has(tab.id) || reuseKeys.has(reuseKey)) {
      errors.push({
        code: 'DUPLICATE_TAB',
        tabId: tab.id,
        connectionId: tab.connectionId,
        message: `工作区恢复跳过重复标签：tabId=${tab.id}`
      })
      return
    }
    tabs.push(tab)
    tabIds.add(tab.id)
    reuseKeys.add(reuseKey)
  })

  const activeTabIds: Record<string, string> = {}
  Object.entries(snapshot.activeTabIds).forEach(([workspaceId, tabId]) => {
    if (typeof tabId !== 'string') return
    const tab = tabs.find((item) => item.id === tabId && item.workspaceId === workspaceId)
    if (tab) activeTabIds[workspaceId] = tabId
  })

  tabs.forEach((tab) => {
    if (!activeTabIds[tab.workspaceId]) activeTabIds[tab.workspaceId] = tab.id
  })

  return {
    state: { tabs, activeTabIds },
    errors
  }
}

export const useWorkspaceStore = defineStore('workspace', {
  state: (): WorkspaceState => createEmptyWorkspaceState(),
  getters: {
    tabsForWorkspace: (state) => (workspaceId: string): WorkspaceTab[] =>
      state.tabs.filter((tab) => tab.workspaceId === workspaceId),
    activeTabForWorkspace: (state) => (workspaceId: string): WorkspaceTab | undefined => {
      const activeTabId = state.activeTabIds[workspaceId]
      return state.tabs.find((tab) => tab.id === activeTabId)
    }
  },
  actions: {
    openTab(payload: TabPayload): OpenWorkspaceTabResult {
      const result = openWorkspaceTab(this.$state, payload)
      this.tabs = result.state.tabs
      this.activeTabIds = result.state.activeTabIds
      return { ...result, state: this.$state }
    },
    activateTab(tabId: string): void {
      const state = activateWorkspaceTab(this.$state, tabId)
      this.tabs = state.tabs
      this.activeTabIds = state.activeTabIds
    },
    closeTab(tabId: string): void {
      const state = closeWorkspaceTab(this.$state, tabId)
      this.tabs = state.tabs
      this.activeTabIds = state.activeTabIds
    },
    closeOtherTabs(tabId: string): void {
      const state = closeOtherWorkspaceTabs(this.$state, tabId)
      this.tabs = state.tabs
      this.activeTabIds = state.activeTabIds
    },
    closeTabsToRight(tabId: string): void {
      const state = closeWorkspaceTabsToRight(this.$state, tabId)
      this.tabs = state.tabs
      this.activeTabIds = state.activeTabIds
    },
    closeAllTabs(workspaceId: string): void {
      const state = closeAllWorkspaceTabs(this.$state, workspaceId)
      this.tabs = state.tabs
      this.activeTabIds = state.activeTabIds
    },
    closeConnectionTabs(connectionId: string): void {
      const state = closeConnectionWorkspaceTabs(this.$state, connectionId)
      this.tabs = state.tabs
      this.activeTabIds = state.activeTabIds
    },
    updateTabState(tabId: string, pageState: WorkspacePageState, dirty?: boolean): void {
      const state = updateWorkspaceTabState(this.$state, tabId, pageState, dirty)
      this.tabs = state.tabs
    },
    markTabLoaded(tabId: string): void {
      const state = markWorkspaceTabLoaded(this.$state, tabId)
      this.tabs = state.tabs
    },
    setTabExecutionState(tabId: string, executionState: WorkspaceTabExecutionState): void {
      const state = setWorkspaceTabExecutionState(this.$state, tabId, executionState)
      this.tabs = state.tabs
    },
    serialize(): string {
      return serializeWorkspaceState(this.$state)
    },
    restore(serializedSnapshot: string | unknown, options: WorkspaceRestoreOptions = {}): WorkspaceRestoreError[] {
      const result = restoreWorkspaceState(serializedSnapshot, options)
      this.tabs = result.state.tabs
      this.activeTabIds = result.state.activeTabIds
      return result.errors
    }
  }
})

function removeWorkspaceTabs(state: WorkspaceState, removedTabIds: ReadonlySet<string>): WorkspaceState {
  if (removedTabIds.size === 0) return state

  const tabs = state.tabs.filter((tab) => !removedTabIds.has(tab.id))
  if (tabs.length === state.tabs.length) return state

  const activeTabIds = { ...state.activeTabIds }
  // 批量关闭也按原始顺序寻找回退目标，保证先左后右且不会落到已删除标签。
  Object.entries(state.activeTabIds).forEach(([workspaceId, activeTabId]) => {
    if (!removedTabIds.has(activeTabId)) return
    const workspaceTabs = state.tabs.filter((tab) => tab.workspaceId === workspaceId)
    const activeTabIndex = workspaceTabs.findIndex((tab) => tab.id === activeTabId)
    const fallbackTabId = findFallbackTabId(workspaceTabs, activeTabIndex, removedTabIds)
    if (fallbackTabId) {
      activeTabIds[workspaceId] = fallbackTabId
    } else {
      delete activeTabIds[workspaceId]
    }
  })

  return { tabs, activeTabIds }
}

function findFallbackTabId(
  workspaceTabs: WorkspaceTab[],
  activeTabIndex: number,
  removedTabIds: ReadonlySet<string>
): string | undefined {
  for (let index = activeTabIndex - 1; index >= 0; index -= 1) {
    if (!removedTabIds.has(workspaceTabs[index].id)) return workspaceTabs[index].id
  }
  for (let index = activeTabIndex + 1; index < workspaceTabs.length; index += 1) {
    if (!removedTabIds.has(workspaceTabs[index].id)) return workspaceTabs[index].id
  }
  return undefined
}

function getWorkspaceTabsForTab(state: WorkspaceState, tabId: string): WorkspaceTab[] {
  const tab = state.tabs.find((item) => item.id === tabId)
  return tab ? state.tabs.filter((item) => item.workspaceId === tab.workspaceId) : []
}

function updateWorkspaceTab(
  state: WorkspaceState,
  tabId: string,
  updater: (tab: WorkspaceTab) => WorkspaceTab
): WorkspaceState {
  const tabIndex = state.tabs.findIndex((tab) => tab.id === tabId)
  if (tabIndex === -1) return state

  const tabs = [...state.tabs]
  tabs[tabIndex] = updater(tabs[tabIndex])
  return { tabs, activeTabIds: state.activeTabIds }
}

function validateTabPayload(payload: TabPayload): void {
  requireNonEmptyString(payload.workspaceId, 'workspaceId')
  requireNonEmptyString(payload.title, 'title')
  if (!isWorkspaceTabKind(payload.kind)) {
    throw new TypeError(`打开工作区标签失败：kind=${String(payload.kind)} 不受支持`)
  }
  if (payload.connectionId !== undefined) requireNonEmptyString(payload.connectionId, 'connectionId')
  if (payload.resourceKey !== undefined) requireNonEmptyString(payload.resourceKey, 'resourceKey')
}

function requireNonEmptyString(value: string, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`工作区标签参数无效：${field} 必须是非空字符串`)
  }
  return value
}

function isWorkspaceTabKind(value: unknown): value is TabKind {
  return WORKSPACE_TAB_KINDS.includes(value as TabKind)
}

function clonePageState(state: WorkspacePageState, stripSensitiveValues = false): WorkspacePageState {
  if (!isPlainObject(state)) {
    throw new TypeError('工作区页面状态无效：state 必须是普通对象')
  }
  return cloneSerializableRecord(state, 'state', stripSensitiveValues)
}

function cloneSerializableRecord(
  value: Record<string, unknown>,
  path: string,
  stripSensitiveValues: boolean
): WorkspacePageState {
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) => {
      if (stripSensitiveValues && NON_PERSISTED_STATE_KEYS.has(key)) return []
      return [[key, cloneSerializableValue(item, `${path}.${key}`, stripSensitiveValues)]]
    })
  )
}

function cloneSerializableValue(
  value: unknown,
  path: string,
  stripSensitiveValues: boolean
): WorkspaceSerializableValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value
    throw new TypeError(`工作区页面状态无效：${path} 不是有限数字`)
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => cloneSerializableValue(item, `${path}[${index}]`, stripSensitiveValues))
  }
  if (isPlainObject(value)) return cloneSerializableRecord(value, path, stripSensitiveValues)
  throw new TypeError(`工作区页面状态无效：${path} 不是可序列化 JSON 值`)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function parseWorkspaceSnapshot(
  serializedSnapshot: string | unknown,
  errors: WorkspaceRestoreError[]
): RawWorkspaceSnapshot | null {
  try {
    const value = typeof serializedSnapshot === 'string'
      ? JSON.parse(serializedSnapshot) as unknown
      : serializedSnapshot
    if (!isPlainObject(value)) throw new TypeError('快照根节点必须是对象')
    if (value.version !== WORKSPACE_SNAPSHOT_VERSION) {
      throw new TypeError(`不支持的快照版本=${String(value.version)}`)
    }
    if (!Array.isArray(value.tabs)) throw new TypeError('tabs 必须是数组')
    if (!isPlainObject(value.activeTabIds)) throw new TypeError('activeTabIds 必须是对象')
    return {
      tabs: value.tabs,
      activeTabIds: value.activeTabIds
    }
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error)
    errors.push({
      code: 'INVALID_SNAPSHOT',
      message: `工作区恢复失败：快照损坏，原因=${reason}`
    })
    return null
  }
}

function restoreWorkspaceTab(
  value: unknown,
  index: number,
  validConnectionIds: ReadonlySet<string> | undefined,
  errors: WorkspaceRestoreError[]
): WorkspaceTab | null {
  try {
    if (!isPlainObject(value)) throw new TypeError('标签必须是对象')
    const id = requireRestoredString(value.id, 'id')
    const workspaceId = requireRestoredString(value.workspaceId, 'workspaceId')
    const title = requireRestoredString(value.title, 'title')
    const connectionId = value.connectionId === undefined
      ? undefined
      : requireRestoredString(value.connectionId, 'connectionId')
    const resourceKey = value.resourceKey === undefined
      ? undefined
      : requireRestoredString(value.resourceKey, 'resourceKey')
    if (!isWorkspaceTabKind(value.kind)) throw new TypeError(`kind=${String(value.kind)} 不受支持`)
    if (typeof value.closable !== 'boolean') throw new TypeError('closable 必须是布尔值')
    if (typeof value.dirty !== 'boolean') throw new TypeError('dirty 必须是布尔值')
    if (!isPlainObject(value.state)) throw new TypeError('state 必须是普通对象')
    if (connectionId && validConnectionIds && !validConnectionIds.has(connectionId)) {
      errors.push({
        code: 'MISSING_CONNECTION',
        tabId: id,
        connectionId,
        message: `工作区恢复跳过无效连接标签：tabId=${id}，connectionId=${connectionId}`
      })
      return null
    }

    return {
      id,
      workspaceId,
      ...(connectionId === undefined ? {} : { connectionId }),
      kind: value.kind,
      title,
      ...(resourceKey === undefined ? {} : { resourceKey }),
      closable: value.closable,
      state: cloneSerializableRecord(value.state, 'state', false),
      dirty: value.dirty,
      loadState: 'restored-unloaded',
      executionState: 'idle',
      readOnly: true,
      closing: false
    }
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error)
    errors.push({
      code: 'INVALID_TAB',
      message: `工作区恢复跳过无效标签：index=${index}，原因=${reason}`
    })
    return null
  }
}

function requireRestoredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${field} 必须是非空字符串`)
  }
  return value
}

function createValidConnectionIdSet(
  value: WorkspaceRestoreOptions['validConnectionIds']
): ReadonlySet<string> | undefined {
  if (value === undefined) return undefined
  return value instanceof Set ? value : new Set(value)
}
