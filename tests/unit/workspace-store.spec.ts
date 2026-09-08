import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  activateWorkspaceTab,
  closeAllWorkspaceTabs,
  closeConnectionWorkspaceTabs,
  closeOtherWorkspaceTabs,
  closeWorkspaceTab,
  closeWorkspaceTabsToRight,
  createEmptyWorkspaceState,
  openWorkspaceTab,
  restoreWorkspaceState,
  serializeWorkspaceState,
  setWorkspaceTabExecutionState
} from '../../src/renderer/src/stores/workspace-store.ts'
import type { TabPayload, WorkspaceState } from '../../src/shared/types/workspace.ts'

describe('工作区标签状态', () => {
  it('按工作区、连接、类型和资源键打开并复用标签', () => {
    const initialState = createEmptyWorkspaceState()
    const payload: TabPayload = {
      workspaceId: 'main',
      connectionId: 'connection-a',
      kind: 'index-browser',
      resourceKey: 'orders',
      title: 'orders',
      state: { queryText: 'status:open' }
    }

    const firstOpen = openWorkspaceTab(initialState, payload)
    const secondOpen = openWorkspaceTab(firstOpen.state, {
      ...payload,
      title: '不会覆盖已打开标签',
      state: { queryText: 'status:closed' }
    })

    assert.equal(firstOpen.reused, false)
    assert.equal(secondOpen.reused, true)
    assert.equal(secondOpen.state.tabs.length, 1)
    assert.equal(secondOpen.tab.id, firstOpen.tab.id)
    assert.deepEqual(secondOpen.tab.state, { queryText: 'status:open' })
    assert.equal(secondOpen.state.activeTabIds.main, firstOpen.tab.id)
  })

  it('不同资源键可以打开多个 REST 控制台且不同连接互不复用', () => {
    let state = createEmptyWorkspaceState()
    const first = openTab(state, {
      workspaceId: 'main',
      connectionId: 'connection-a',
      kind: 'rest-console',
      resourceKey: 'console-1',
      title: 'Console 1'
    })
    state = first.state
    state = openTab(state, {
      workspaceId: 'main',
      connectionId: 'connection-a',
      kind: 'rest-console',
      resourceKey: 'console-2',
      title: 'Console 2'
    }).state
    state = openTab(state, {
      workspaceId: 'main',
      connectionId: 'connection-b',
      kind: 'rest-console',
      resourceKey: 'console-1',
      title: 'Connection B Console'
    }).state

    assert.equal(state.tabs.length, 3)
    assert.equal(new Set(state.tabs.map((tab) => tab.id)).size, 3)
  })

  it('激活标签只更新所属工作区的活动标签', () => {
    let state = createEmptyWorkspaceState()
    const workspaceAFirst = openTab(state, dashboard('workspace-a', 'connection-a'))
    state = workspaceAFirst.state
    const workspaceASecond = openTab(state, indexTab('workspace-a', 'connection-a', 'orders'))
    state = workspaceASecond.state
    const workspaceB = openTab(state, dashboard('workspace-b', 'connection-b'))
    state = workspaceB.state

    state = activateWorkspaceTab(state, workspaceAFirst.tab.id)

    assert.equal(state.activeTabIds['workspace-a'], workspaceAFirst.tab.id)
    assert.equal(state.activeTabIds['workspace-b'], workspaceB.tab.id)
  })

  it('关闭活动标签优先激活左侧，无左侧时激活右侧', () => {
    let state = createEmptyWorkspaceState()
    const left = openTab(state, indexTab('main', 'connection-a', 'left'))
    state = left.state
    const right = openTab(state, indexTab('main', 'connection-a', 'right'))
    state = activateWorkspaceTab(right.state, left.tab.id)

    state = closeWorkspaceTab(state, left.tab.id)
    assert.equal(state.activeTabIds.main, right.tab.id)

    const center = openTab(state, indexTab('main', 'connection-a', 'center'))
    state = center.state
    const farRight = openTab(state, indexTab('main', 'connection-a', 'far-right'))
    state = farRight.state
    state = closeWorkspaceTab(state, farRight.tab.id)
    assert.equal(state.activeTabIds.main, center.tab.id)
  })

  it('关闭非活动标签不改变当前活动标签且不可关闭标签受到保护', () => {
    let state = createEmptyWorkspaceState()
    const fixed = openTab(state, dashboard('main', 'connection-a'))
    state = fixed.state
    const closable = openTab(state, indexTab('main', 'connection-a', 'orders'))
    state = closable.state

    state = closeWorkspaceTab(state, fixed.tab.id)

    assert.equal(state.tabs.length, 2)
    assert.equal(state.activeTabIds.main, closable.tab.id)
  })

  it('关闭其他保留目标和不可关闭标签并激活目标', () => {
    let state = createEmptyWorkspaceState()
    const fixed = openTab(state, dashboard('main', 'connection-a'))
    state = fixed.state
    const target = openTab(state, indexTab('main', 'connection-a', 'orders'))
    state = target.state
    state = openTab(state, indexTab('main', 'connection-a', 'customers')).state
    state = openTab(state, indexTab('other', 'connection-a', 'other-workspace')).state

    state = closeOtherWorkspaceTabs(state, target.tab.id)

    assert.deepEqual(
      state.tabs.map((tab) => tab.title),
      [fixed.tab.title, target.tab.title, 'other-workspace']
    )
    assert.equal(state.activeTabIds.main, target.tab.id)
  })

  it('关闭右侧只移除同一工作区中目标右侧的可关闭标签', () => {
    let state = createEmptyWorkspaceState()
    const left = openTab(state, indexTab('main', 'connection-a', 'left'))
    state = left.state
    const target = openTab(state, indexTab('main', 'connection-a', 'target'))
    state = target.state
    state = openTab(state, indexTab('main', 'connection-a', 'right')).state
    state = openTab(state, dashboard('main', 'connection-a')).state
    state = openTab(state, indexTab('other', 'connection-a', 'other-workspace')).state

    state = closeWorkspaceTabsToRight(state, target.tab.id)

    assert.deepEqual(
      state.tabs.map((tab) => tab.title),
      [left.tab.title, target.tab.title, '概览', 'other-workspace']
    )
  })

  it('关闭全部只关闭指定工作区的可关闭标签', () => {
    let state = createEmptyWorkspaceState()
    const fixed = openTab(state, dashboard('main', 'connection-a'))
    state = fixed.state
    state = openTab(state, indexTab('main', 'connection-a', 'orders')).state
    const other = openTab(state, indexTab('other', 'connection-a', 'other-workspace'))
    state = other.state

    state = closeAllWorkspaceTabs(state, 'main')

    assert.deepEqual(state.tabs.map((tab) => tab.id), [fixed.tab.id, other.tab.id])
    assert.equal(state.activeTabIds.main, fixed.tab.id)
    assert.equal(state.activeTabIds.other, other.tab.id)
  })

  it('连接级清理移除该连接的全部子标签但保留其他连接', () => {
    let state = createEmptyWorkspaceState()
    state = openTab(state, dashboard('main', 'connection-a')).state
    state = openTab(state, indexTab('main', 'connection-a', 'orders')).state
    const otherConnection = openTab(state, dashboard('main', 'connection-b'))
    state = otherConnection.state
    state = openTab(state, indexTab('secondary', 'connection-a', 'logs')).state

    state = closeConnectionWorkspaceTabs(state, 'connection-a')

    assert.deepEqual(state.tabs.map((tab) => tab.connectionId), ['connection-b'])
    assert.equal(state.activeTabIds.main, otherConnection.tab.id)
    assert.equal(state.activeTabIds.secondary, undefined)
  })
})

describe('工作区序列化与恢复', () => {
  it('仅持久化可恢复页面状态并强制以只读未加载状态恢复', () => {
    let state = createEmptyWorkspaceState()
    const opened = openTab(state, {
      ...indexTab('main', 'connection-a', 'orders'),
      dirty: true,
      state: {
        queryText: 'status:open',
        page: 2,
        scrollPosition: 480,
        draft: { name: 'edited' },
        password: 'secret',
        responseBody: { hits: ['sensitive'] },
        autoExecute: true
      }
    })
    state = setWorkspaceTabExecutionState(opened.state, opened.tab.id, 'running')

    const serialized = serializeWorkspaceState(state)
    const restored = restoreWorkspaceState(serialized, {
      validConnectionIds: ['connection-a']
    })
    const restoredTab = restored.state.tabs[0]

    assert.equal(restored.errors.length, 0)
    assert.deepEqual(restoredTab.state, {
      queryText: 'status:open',
      page: 2,
      scrollPosition: 480,
      draft: { name: 'edited' }
    })
    assert.equal(restoredTab.dirty, true)
    assert.equal(restoredTab.loadState, 'restored-unloaded')
    assert.equal(restoredTab.executionState, 'idle')
    assert.equal(restoredTab.readOnly, true)
    assert.equal(restoredTab.closing, false)
    assert.equal(serialized.includes('autoExecute'), false)
    assert.equal(serialized.includes('responseBody'), false)
    assert.equal(serialized.includes('secret'), false)
  })

  it('恢复时跳过不存在连接和重复资源标签并记录错误', () => {
    const snapshot = {
      version: 1,
      tabs: [
        persistedTab('first', 'connection-a', 'orders'),
        persistedTab('duplicate', 'connection-a', 'orders'),
        persistedTab('missing', 'connection-missing', 'logs')
      ],
      activeTabIds: { main: 'first' }
    }

    const restored = restoreWorkspaceState(snapshot, {
      validConnectionIds: new Set(['connection-a'])
    })

    assert.deepEqual(restored.state.tabs.map((tab) => tab.id), ['first'])
    assert.deepEqual(restored.errors.map((error) => error.code), [
      'DUPLICATE_TAB',
      'MISSING_CONNECTION'
    ])
  })

  it('损坏快照返回空状态和可诊断错误', () => {
    const restored = restoreWorkspaceState('{not-json')

    assert.deepEqual(restored.state, createEmptyWorkspaceState())
    assert.equal(restored.errors.length, 1)
    assert.equal(restored.errors[0].code, 'INVALID_SNAPSHOT')
    assert.match(restored.errors[0].message, /快照损坏/u)
  })
})

function openTab(state: WorkspaceState, payload: TabPayload) {
  return openWorkspaceTab(state, payload)
}

function dashboard(workspaceId: string, connectionId: string): TabPayload {
  return {
    workspaceId,
    connectionId,
    kind: 'connection-dashboard',
    title: '概览',
    resourceKey: connectionId,
    closable: false
  }
}

function indexTab(workspaceId: string, connectionId: string, index: string): TabPayload {
  return {
    workspaceId,
    connectionId,
    kind: 'index-browser',
    title: index,
    resourceKey: index
  }
}

function persistedTab(id: string, connectionId: string, resourceKey: string) {
  return {
    id,
    workspaceId: 'main',
    connectionId,
    kind: 'index-browser',
    title: resourceKey,
    resourceKey,
    closable: true,
    state: {},
    dirty: false
  }
}
