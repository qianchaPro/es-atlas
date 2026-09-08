import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  applyAppWorkspaceTabCloseAction,
  createClusterResourceWorkspaceTab,
  createRestConsoleWorkspaceTab,
  ensureClusterResourceWorkspaceTab,
  toContextMenuWorkspaceTab,
  type AppWorkspaceTab,
  type AppWorkspaceTabState
} from '../../src/renderer/src/stores/app-workspace-tab-actions.ts'

describe('应用工作区标签右键操作', () => {
  it('为同一连接的不同集群资源创建独立标签', () => {
    const indexTemplate = createClusterResourceWorkspaceTab(
      'connection-a',
      'index-template',
      '模板'
    )
    const componentTemplate = createClusterResourceWorkspaceTab(
      'connection-a',
      'component-template',
      '组件模板'
    )

    assert.equal(indexTemplate.id, 'cluster-resource-connection-a-index-template')
    assert.equal(indexTemplate.resourceKey, 'index-template')
    assert.equal(componentTemplate.id, 'cluster-resource-connection-a-component-template')
    assert.equal(componentTemplate.resourceKey, 'component-template')
    assert.notEqual(indexTemplate.id, componentTemplate.id)
  })

  it('首次打开资源页时迁移旧版单一资源标签', () => {
    const legacyTab: AppWorkspaceTab = {
      id: 'cluster-resource-connection-a',
      connectionId: 'connection-a',
      title: '脚本',
      kind: 'cluster-resource'
    }
    const result = ensureClusterResourceWorkspaceTab(
      [legacyTab],
      'connection-a',
      'stored-script',
      '脚本'
    )

    assert.deepEqual(result.tabs.map((tab) => tab.id), [
      'cluster-resource-connection-a-stored-script'
    ])
    assert.equal(result.tab.resourceKey, 'stored-script')
  })

  it('为同一连接创建多个具有稳定资源键的 REST Console 标签', () => {
    const first = createRestConsoleWorkspaceTab([], 'connection-a', 'console-key-1')
    const second = createRestConsoleWorkspaceTab([first], 'connection-a', 'console-key-2')

    assert.equal(first.id, 'rest:connection-a:console-key-1')
    assert.equal(first.resourceKey, 'console-key-1')
    assert.equal(first.title, 'REST Console 1')
    assert.equal(second.id, 'rest:connection-a:console-key-2')
    assert.equal(second.title, 'REST Console 2')
    assert.equal(toContextMenuWorkspaceTab(second).resourceKey, 'console-key-2')
  })

  it('将连接作为工作区边界并保护概览标签', () => {
    const state = createState()
    const result = applyAppWorkspaceTabCloseAction(state, 'close-others', 'index-a')

    assert.deepEqual(result.tabs.map((tab) => tab.id), ['dashboard-a', 'index-a', 'dashboard-b', 'rest-b'])
    assert.equal(result.activeTabIds['connection-a'], 'index-a')
    assert.equal(result.activeTabIds['connection-b'], 'rest-b')
    assert.equal(toContextMenuWorkspaceTab(state.tabs[0]).closable, false)
  })

  it('关闭右侧和关闭全部只修改目标连接并正确回退活动标签', () => {
    const state = createState()
    const closedRight = applyAppWorkspaceTabCloseAction(state, 'close-right', 'index-a')

    assert.deepEqual(closedRight.tabs.map((tab) => tab.id), [
      'dashboard-a',
      'index-a',
      'dashboard-b',
      'rest-b'
    ])
    assert.equal(closedRight.activeTabIds['connection-a'], 'index-a')

    const closedAll = applyAppWorkspaceTabCloseAction(state, 'close-all', 'connection-a')
    assert.deepEqual(closedAll.tabs.map((tab) => tab.id), ['dashboard-a', 'dashboard-b', 'rest-b'])
    assert.equal(closedAll.activeTabIds['connection-a'], 'dashboard-a')
    assert.equal(closedAll.activeTabIds['connection-b'], 'rest-b')
  })

  it('将长任务页签映射为可关闭的任务详情页', () => {
    const tab = toContextMenuWorkspaceTab({
      id: 'operation-a',
      connectionId: 'connection-a',
      title: '长任务',
      kind: 'operation'
    })

    assert.equal(tab.kind, 'task-detail')
    assert.equal(tab.closable, true)
  })
})

function createState(): AppWorkspaceTabState {
  const tabs: AppWorkspaceTab[] = [
    { id: 'dashboard-a', connectionId: 'connection-a', title: '概览 A', kind: 'dashboard' },
    { id: 'index-a', connectionId: 'connection-a', title: '索引 A', kind: 'index' },
    { id: 'rest-a', connectionId: 'connection-a', title: 'REST A', kind: 'rest' },
    { id: 'dashboard-b', connectionId: 'connection-b', title: '概览 B', kind: 'dashboard' },
    { id: 'rest-b', connectionId: 'connection-b', title: 'REST B', kind: 'rest' }
  ]
  return {
    tabs,
    activeTabIds: {
      'connection-a': 'rest-a',
      'connection-b': 'rest-b'
    }
  }
}
