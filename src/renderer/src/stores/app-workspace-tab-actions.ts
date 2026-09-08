import type { TabKind, WorkspaceState, WorkspaceTab } from '../../../shared/types/workspace'
import type { ClusterResourceKind } from '../../../shared/types/cluster-resource'
import {
  closeAllWorkspaceTabs,
  closeOtherWorkspaceTabs,
  closeWorkspaceTab,
  closeWorkspaceTabsToRight
// Node 内置 TypeScript 测试器需要显式扩展名，Vite 同样可以解析该源文件。
// @ts-expect-error TypeScript 测试运行时直接加载 .ts 源文件
} from './workspace-store.ts'

export type AppWorkspaceTabKind = 'dashboard' | 'index' | 'rest' | 'cluster-resource' | 'operation'

export type AppWorkspaceTab = {
  id: string
  connectionId: string
  title: string
  kind: AppWorkspaceTabKind
  resourceKey?: string
}

export type AppWorkspaceTabCloseAction = 'close' | 'close-others' | 'close-right' | 'close-all'

export type AppWorkspaceTabState = {
  tabs: AppWorkspaceTab[]
  activeTabIds: Record<string, string>
}

export type EnsureClusterResourceWorkspaceTabResult = {
  tabs: AppWorkspaceTab[]
  tab: AppWorkspaceTab
}

const TAB_KIND_MAP: Record<AppWorkspaceTabKind, TabKind> = {
  dashboard: 'connection-dashboard',
  index: 'index-browser',
  rest: 'rest-console',
  'cluster-resource': 'template-editor',
  operation: 'task-detail'
}

export function toContextMenuWorkspaceTab(tab: AppWorkspaceTab): WorkspaceTab {
  return {
    id: tab.id,
    workspaceId: tab.connectionId,
    connectionId: tab.connectionId,
    kind: TAB_KIND_MAP[tab.kind],
    title: tab.title,
    resourceKey: tab.resourceKey ?? tab.id,
    closable: tab.kind !== 'dashboard',
    state: {},
    dirty: false,
    loadState: 'loaded',
    executionState: 'idle',
    readOnly: false,
    closing: false
  }
}

export function createRestConsoleWorkspaceTab(
  tabs: readonly AppWorkspaceTab[],
  connectionId: string,
  resourceKey: string
): AppWorkspaceTab {
  const normalizedConnectionId = requireNonEmptyValue(connectionId, 'connectionId')
  const normalizedResourceKey = requireNonEmptyValue(resourceKey, 'resourceKey')
  const id = `rest:${encodeURIComponent(normalizedConnectionId)}:${encodeURIComponent(normalizedResourceKey)}`
  if (tabs.some((tab) => tab.id === id)) {
    throw new Error(`REST Console 标签 ID 冲突：id=${id}`)
  }
  const sequence = Math.max(
    0,
    ...tabs
      .filter((tab) => tab.connectionId === normalizedConnectionId && tab.kind === 'rest')
      .map((tab) => /^REST Console (\d+)$/u.exec(tab.title))
      .map((match) => match ? Number(match[1]) : 0)
  ) + 1
  return {
    id,
    connectionId: normalizedConnectionId,
    title: `REST Console ${sequence}`,
    kind: 'rest',
    resourceKey: normalizedResourceKey
  }
}

export function createClusterResourceWorkspaceTab(
  connectionId: string,
  resourceKind: ClusterResourceKind,
  title: string
): AppWorkspaceTab {
  const normalizedConnectionId = requireNonEmptyValue(connectionId, 'connectionId')
  const normalizedResourceKind = requireNonEmptyValue(resourceKind, 'resourceKind')
  const normalizedTitle = requireNonEmptyValue(title, 'title')
  return {
    id: `cluster-resource-${normalizedConnectionId}-${normalizedResourceKind}`,
    connectionId: normalizedConnectionId,
    title: normalizedTitle,
    kind: 'cluster-resource',
    resourceKey: normalizedResourceKind
  }
}

export function ensureClusterResourceWorkspaceTab(
  tabs: readonly AppWorkspaceTab[],
  connectionId: string,
  resourceKind: ClusterResourceKind,
  title: string
): EnsureClusterResourceWorkspaceTabResult {
  const tab = createClusterResourceWorkspaceTab(connectionId, resourceKind, title)
  const legacyTabId = `cluster-resource-${tab.connectionId}`
  const retainedTabs = tabs.filter((item) => item.id !== legacyTabId)
  const existingTab = retainedTabs.find((item) => item.id === tab.id)
  return {
    tabs: existingTab ? retainedTabs : [...retainedTabs, tab],
    tab: existingTab ?? tab
  }
}

function requireNonEmptyValue(value: string, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
    throw new TypeError(`工作区标签参数无效：${field} 必须是 1-256 位字符串`)
  }
  return value
}

export function applyAppWorkspaceTabCloseAction(
  state: AppWorkspaceTabState,
  action: AppWorkspaceTabCloseAction,
  targetId: string
): AppWorkspaceTabState {
  const workspaceState: WorkspaceState = {
    tabs: state.tabs.map(toContextMenuWorkspaceTab),
    activeTabIds: { ...state.activeTabIds }
  }
  const nextState = action === 'close'
    ? closeWorkspaceTab(workspaceState, targetId)
    : action === 'close-others'
      ? closeOtherWorkspaceTabs(workspaceState, targetId)
      : action === 'close-right'
        ? closeWorkspaceTabsToRight(workspaceState, targetId)
        : closeAllWorkspaceTabs(workspaceState, targetId)
  const retainedTabIds = new Set(nextState.tabs.map((tab) => tab.id))
  return {
    tabs: state.tabs.filter((tab) => retainedTabIds.has(tab.id)),
    activeTabIds: nextState.activeTabIds
  }
}
