export const WORKSPACE_SNAPSHOT_VERSION = 1

export const WORKSPACE_TAB_KINDS = [
  'connection-dashboard',
  'index-browser',
  'rest-console',
  'node-detail',
  'template-editor',
  'task-detail',
  'log-view'
] as const

export type TabKind = (typeof WORKSPACE_TAB_KINDS)[number]
export type WorkspaceTabKind = TabKind

export type WorkspaceSerializableValue =
  | null
  | boolean
  | number
  | string
  | WorkspaceSerializableValue[]
  | { [key: string]: WorkspaceSerializableValue }

export type WorkspacePageState = Record<string, WorkspaceSerializableValue>

export type WorkspaceTabLoadState = 'loaded' | 'restored-unloaded'
export type WorkspaceTabExecutionState = 'idle' | 'running'

export type WorkspaceTab = {
  id: string
  workspaceId: string
  connectionId?: string
  kind: TabKind
  title: string
  resourceKey?: string
  closable: boolean
  state: WorkspacePageState
  dirty: boolean
  loadState: WorkspaceTabLoadState
  executionState: WorkspaceTabExecutionState
  readOnly: boolean
  closing: boolean
}

export type TabPayload = {
  workspaceId: string
  connectionId?: string
  kind: TabKind
  title: string
  resourceKey?: string
  closable?: boolean
  state?: WorkspacePageState
  dirty?: boolean
}

export type WorkspaceState = {
  tabs: WorkspaceTab[]
  activeTabIds: Record<string, string>
}

export type PersistedWorkspaceTab = Pick<
  WorkspaceTab,
  | 'id'
  | 'workspaceId'
  | 'connectionId'
  | 'kind'
  | 'title'
  | 'resourceKey'
  | 'closable'
  | 'state'
  | 'dirty'
>

export type WorkspaceSnapshot = {
  version: typeof WORKSPACE_SNAPSHOT_VERSION
  tabs: PersistedWorkspaceTab[]
  activeTabIds: Record<string, string>
}

export type WorkspaceRestoreError = {
  code: 'INVALID_SNAPSHOT' | 'INVALID_TAB' | 'MISSING_CONNECTION' | 'DUPLICATE_TAB'
  message: string
  tabId?: string
  connectionId?: string
}

export type WorkspaceRestoreOptions = {
  validConnectionIds?: readonly string[] | ReadonlySet<string>
}

export type WorkspaceRestoreResult = {
  state: WorkspaceState
  errors: WorkspaceRestoreError[]
}

export type OpenWorkspaceTabResult = {
  state: WorkspaceState
  tab: WorkspaceTab
  reused: boolean
}
