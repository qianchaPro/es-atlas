<script setup lang="ts">
import { computed, markRaw, onBeforeUnmount, onMounted, ref, watch, type Component } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  ArrowRight,
  Close,
  Connection,
  DataAnalysis,
  Delete,
  Document,
  Expand,
  Fold,
  FolderOpened,
  Grid,
  HomeFilled,
  Reading,
  MoreFilled,
  Monitor,
  Plus,
  Refresh,
  Setting,
  SwitchButton,
  Tickets,
  Timer,
  Tools,
  WarningFilled
} from '@element-plus/icons-vue'
import ConnectionDialog from './components/ConnectionDialog.vue'
import ConnectionGroupManagerDialog from './components/ConnectionGroupManagerDialog.vue'
import IndexBrowser from './components/IndexBrowser.vue'
import MoveConnectionDialog from './components/MoveConnectionDialog.vue'
import RequestHistoryDialog from './components/RequestHistoryDialog.vue'
import RequestHistoryPage from './components/RequestHistoryPage.vue'
import RestConsole from './components/RestConsole.vue'
import ClusterResourceManager from './components/ClusterResourceManager.vue'
import ClusterOperationPage from './components/ClusterOperationPage.vue'
import LogPage from './components/LogPage.vue'
import SettingsDialog from './components/SettingsDialog.vue'
import TabContextMenu from './components/TabContextMenu.vue'
import TrashBin from './components/TrashBin.vue'
import appIconUrl from './assets/es-atlas-icon.svg'
import type { ClusterOverviewSnapshot } from '../../shared/types/cluster'
import { isCapabilityUnsupportedByProductVersion } from '../../shared/capability-support'
import type { CapabilityKey } from '../../shared/types/capability'
import type { RequestHistoryRecord } from '../../shared/types/request-history'
import type { ClusterResourceKind, ClusterResourceOperationRequest } from '../../shared/types/cluster-resource'
import type {
  ConnectionGroup,
  ConnectionGroupColor,
  ConnectionFormValue,
  ConnectionProfile,
  ConnectionSummary,
  CreateConnectionGroupInput,
  UpdateConnectionGroupInput
} from '../../shared/types/connection'
import {
  DEFAULT_CONNECTION_PREFERENCES,
  DEFAULT_GLOBAL_PREFERENCES,
  PREFERENCES_VERSION,
  type AppTheme,
  type ConnectionPreferences,
  type EasterEggTheme,
  type PreferencesSnapshot,
  type SavePreferencesInput
} from '../../shared/types/settings'
import {
  applyAppWorkspaceTabCloseAction,
  createRestConsoleWorkspaceTab,
  ensureClusterResourceWorkspaceTab,
  toContextMenuWorkspaceTab,
  type AppWorkspaceTab as WorkspaceTab,
  type AppWorkspaceTabCloseAction,
  type AppWorkspaceTabKind as WorkspaceTabKind
} from './stores/app-workspace-tab-actions'

type ClusterHealth = ClusterOverviewSnapshot['health']

type ConnectionTab = {
  connectionId: string
  title: string
}

type GlobalView = 'connections' | 'logs' | 'history' | 'trash'

type PersistedWorkspaceState = {
  activeConnectionId: string
  connectionIds: string[]
  tabs: WorkspaceTab[]
  activeTabIds: Record<string, string>
  activeTabKinds: Record<string, WorkspaceTabKind>
  clusterResourceKinds: Record<string, ClusterResourceKind>
  connectionListCollapsed: boolean
  resourceTreeCollapsed: boolean
}

type ResourceTreeItem = {
  id: string
  label: string
  icon?: Component
  children?: ResourceTreeItem[]
}

type ConnectionGroupSection = {
  id: string | null
  name: string
  color: ConnectionGroupColor
  connections: ConnectionSummary[]
}

const RESOURCE_TREE_CAPABILITIES: Partial<Record<string, CapabilityKey>> = {
  nodes: 'nodes',
  templates: 'indexTemplates',
  'component-templates': 'componentTemplates',
  'data-streams': 'dataStreams',
  'pending-tasks': 'tasks',
  snapshots: 'snapshots',
  'ingest-pipeline': 'pipelines',
  scripts: 'scripts'
}

const BRAND_CLICKS_TO_UNLOCK = 9
const BRAND_CLICK_RESET_DELAY_MS = 1600
const PIXEL_THEME_SEQUENCE = [
  'ArrowUp',
  'ArrowUp',
  'ArrowDown',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'ArrowLeft',
  'ArrowRight',
  'b',
  'a',
  'b',
  'a'
] as const
const EASTER_EGG_DIALOG_SEEN_KEY_PREFIX = 'es-atlas:easter-egg-dialog-seen:'
const WORKSPACE_STORAGE_KEY = 'es-atlas:workspace'

function createDefaultPreferencesSnapshot(): PreferencesSnapshot {
  return {
    version: PREFERENCES_VERSION,
    global: { ...DEFAULT_GLOBAL_PREFERENCES },
    connections: {}
  }
}

const connections = ref<ConnectionSummary[]>([])
const connectionGroups = ref<ConnectionGroup[]>([])
const activeConnectionId = ref('')
const connectionFilter = ref('')
const isConnectionListLoading = ref(false)
const connectionListError = ref('')
const connectionActionId = ref('')
const isConnectionListCollapsed = ref(false)
const isResourceTreeCollapsed = ref(false)
const isAutoRefreshEnabled = ref(true)
const refreshIntervalSeconds = ref(5)
const connectionTabs = ref<ConnectionTab[]>([])
const workspaceTabs = ref<WorkspaceTab[]>([])
const activeWorkspaceTabIds = ref<Record<string, string>>({})
const overviewByConnection = ref<Record<string, ClusterOverviewSnapshot | undefined>>({})
const overviewLoadingByConnection = ref<Record<string, boolean>>({})
const overviewErrorByConnection = ref<Record<string, string>>({})
const overviewGenerationByConnection = ref<Record<string, number>>({})
const isConnectionDialogVisible = ref(false)
const editingConnection = ref<ConnectionSummary | null>(null)
const editingConnectionProfile = ref<ConnectionProfile | null>(null)
const isConnectionProfileLoading = ref(false)
const isConnectionSaving = ref(false)
const isConnectionTesting = ref(false)
const isConnectionDeleting = ref(false)
const connectionDialogError = ref('')
const collapsedConnectionGroupIds = ref<string[]>(readCollapsedGroupIds())
const isGroupManagerVisible = ref(false)
const isMoveConnectionDialogVisible = ref(false)
const movingConnection = ref<ConnectionSummary | null>(null)
const isGroupActionBusy = ref(false)
const groupActionError = ref('')
const preferencesSnapshot = ref<PreferencesSnapshot>(createDefaultPreferencesSnapshot())
const isSettingsDialogVisible = ref(false)
const isSettingsLoading = ref(false)
const isSettingsSaving = ref(false)
const settingsError = ref('')
const isRequestHistoryVisible = ref(false)
const requestHistoryConnectionId = ref<string | null>(null)
const isIssueOpening = ref(false)
const tabContextMenuVisible = ref(false)
const tabContextMenuX = ref(0)
const tabContextMenuY = ref(0)
const tabContextMenuTabId = ref('')
const clusterResourceKindsByConnection = ref<Record<string, ClusterResourceKind>>({})
const activeClusterResourceKind = computed<ClusterResourceKind>(() => {
  const activeTabId = activeWorkspaceTabIds.value[activeConnectionId.value]
  const resourceKey = workspaceTabs.value.find((tab) => tab.id === activeTabId)?.resourceKey
  return isClusterResourceKind(resourceKey)
    ? resourceKey
    : clusterResourceKindsByConnection.value[activeConnectionId.value] ?? 'node'
})
const clusterResourceRevision = ref(0)
const clusterResourcesApi = window.electronAPI.clusterResources
const operationsApi = window.electronAPI.operations
const logsApi = window.electronAPI.logs
const activeGlobalView = ref<GlobalView>('connections')
const logConnectionOptions = computed(() => connections.value.map((connection) => ({ id: connection.id, name: connection.name })))

function handleGlobalMenuSelect(index: string): void {
  if (index === 'connections' || index === 'logs' || index === 'history' || index === 'trash') {
    activeGlobalView.value = index
  }
}
const messages = {
  'zh-CN': {
    connections: '连接',
    logs: '日志',
    trash: '废纸篓',
    history: '历史',
    settings: '设置',
    tools: '工具',
    reportIssue: '报告错误',
    reportIssueMessage: '请在项目 Issues 中提交错误、复现步骤和必要日志。',
    openIssues: '打开 Issues',
    openIssuesFailed: '打开 Issues 失败',
    homepage: '产品首页',
    homepageOpenFailed: '打开产品首页失败',
    blog: '我的博客',
    blogOpenFailed: '打开博客失败',
    updateCheck: '更新检查',
    upToDateNow: '当前是最新版，真棒！',
    updateAvailable: '发现新版本：{version}',
    downloadUpdate: '下载更新',
    downloadUpdateFailed: '打开更新下载地址失败',
    onlineUpdateQuestion: '发现新版本 {version}，是否在线更新？',
    updateCheckNetworkFailed: '检查更新失败，网络连接失败',
    cancel: '取消',
    updateCheckFailed: '检查更新失败',
    updateSourceRequired: '请先在设置的“更新与隐私”中配置 Atlas Admin 地址或 Manifest URL。',
    manageConnectionGroups: '管理连接分组',
    addConnection: '新增连接',
    collapseConnectionList: '收起连接列表',
    expandConnectionList: '展开连接列表',
    filterConnections: '筛选连接',
    reload: '重新加载',
    expandGroup: '展开分组',
    collapseGroup: '收起分组',
    connectionActions: '连接操作',
    editConnection: '编辑连接',
    moveToGroup: '移动到分组',
    noMatchingConnections: '没有匹配的连接',
    noConnections: '还没有连接',
    adjustFilterHint: '调整筛选条件后重试',
    addConnectionHint: '新增一个 HTTP(S) 连接开始使用',
    connectionCount: '{count} 个连接',
    ungrouped: '未分组',
    collapseResourceTree: '收起连接树',
    expandResourceTree: '展开连接树',
    noConnectionSelected: '未选择连接',
    disconnectConnection: '断开连接',
    reconnectConnection: '重新连接',
    clusterOverview: '集群概览',
    indices: '索引',
    nodes: '节点{count}',
    templates: '模板',
    componentTemplates: '组件模板',
    dataStreams: '数据流',
    pendingTasks: '待处理任务{count}',
    snapshots: '快照',
    ingestPipeline: 'Ingest Pipeline',
    storedScripts: '脚本',
    longOperations: '长任务',
    openRestConsole: '打开 REST Console',
    closeConnectionTab: '关闭连接标签',
    closePage: '关闭页面',
    selectConnection: '选择一个连接',
    selectConnectionHint: '从左侧选择已有连接，或新增一个 HTTP(S) 连接。',
    connectionDetails: '连接详情',
    refreshClusterOverview: '刷新集群概览',
    autoRefresh: '自动刷新',
    refreshInterval: '刷新间隔',
    refreshIntervalSeconds: '刷新间隔秒数',
    seconds: '秒',
    recentlyUpdated: '最近更新 {time}',
    neverRefreshed: '尚未成功刷新',
    retainedOverview: '当前保留并显示 {time} 的上次成功数据',
    disconnectedStaleOverview: '连接已断开，当前显示上次成功获取的数据',
    fetchingOverview: '正在获取集群概览',
    overviewAfterConnection: '连接后显示集群概览',
    overviewCollectedAfterConnection: '概览数据仅在连接成功后采集',
    refreshAgain: '重新刷新',
    clusterRuntimeInfo: '集群运行信息',
    runtimeInfo: '运行信息',
    historicalSnapshot: '历史快照',
    currentConnection: '当前连接',
    clusterName: '集群名称',
    version: '版本',
    uptime: '运行时间',
    nodeRoles: '节点角色',
    clusterUuid: '集群 UUID',
    clusterHealth: '集群健康',
    unassigned: '未分配 {count}',
    nodeStatus: '节点状态',
    masterNode: '主节点 {name}',
    activeShards: '活动分片',
    searchP95: '搜索 P95（本应用）',
    writeRejected: '写入拒绝 {count}',
    requestMetrics: '集群请求指标',
    currentSnapshot: '集群近 60 秒；P95/错误率为本应用',
    searchQps: '搜索 QPS',
    writeQps: '写入 QPS',
    errorRate: '错误率（本应用）',
    noFakeRequestTrend: '最近 60 秒暂无集群搜索或写入操作',
    resourcePressure: '资源压力',
    nodePeak: '节点峰值',
    jvmHeap: 'JVM 堆',
    disk: '磁盘',
    highestPressureNode: '压力最高节点',
    gcDuration: 'GC 累计耗时',
    currentRisks: '当前风险',
    riskCount: '{count} 项需要关注',
    noCurrentRisks: '当前未发现需要处理的问题',
    noCurrentRisksHint: '本次快照中的集群健康、分片和资源指标均未触发风险规则',
    recentRequests: '最近请求',
    recordedByApp: '由本应用记录',
    allRequests: '全部',
    noRequestRecords: '暂无请求记录',
    source: '来源',
    method: '方法',
    path: '路径',
    status: '状态',
    duration: '耗时',
    overviewSource: '概览',
    indexSource: '索引',
    connectionSource: '连接',
    otherSource: '其他',
    failedStatus: '失败',
    goToRestConsole: '转到 REST Console',
    restConsoleUnavailable: 'REST Console 尚未接入。',
    unknownError: '未知错误',
    errorSeparator: '：',
    issueOpen: '（',
    issueClose: '）',
    issueSeparator: '；',
    loadSettingsFailed: '加载设置失败',
    loadConnectionGroupsFailed: '加载连接分组失败',
    createConnectionGroupFailed: '新建连接分组失败',
    updateConnectionGroupFailed: '更新连接分组失败',
    deleteConnectionGroupFailed: '删除连接分组失败',
    moveConnectionFailed: '移动连接失败',
    settingsSaved: '设置已保存',
    starlightDialogTitle: '星图已点亮',
    starlightDialogMessage: '我们的目标是星辰大海。星空主题已为你开启，之后也可以在“设置 > 常规 > 主题”中随时切换。',
    starlightDialogConfirm: '向星辰出发',
    pixelDialogTitle: '隐藏关卡已解锁',
    pixelDialogMessage: '经典秘籍验证成功，像素游戏主题已加载。之后也可以在“设置 > 常规 > 主题”中随时切换。',
    pixelDialogConfirm: '进入像素世界',
    showEasterEggDialogFailed: '显示彩蛋确认弹窗失败',
    saveSettingsFailed: '保存设置失败',
    resetSettingsFailed: '重置设置失败',
    saveRefreshSettingsFailed: '保存当前连接刷新设置失败',
    healthGreen: '健康',
    healthYellow: '注意',
    healthRed: '异常',
    healthUnknown: '未知',
    statusConnected: '已连接',
    statusUnavailable: '连接异常',
    statusDisconnected: '未连接',
    loadConnectionListFailed: '加载连接列表失败',
    connectionNotConnected: '连接“{name}”尚未连接，无法刷新集群概览',
    refreshOverviewFailed: '刷新连接“{name}”的集群概览失败',
    readConnectionFailed: '读取连接“{name}”配置失败',
    cannotEditConnection: '无法编辑连接',
    close: '关闭',
    connectionUpdated: '连接已更新',
    connectionCreated: '连接已新增',
    updateConnectionFailed: '更新连接失败',
    createConnectionFailed: '新增连接失败',
    connectionTestFailed: '连接测试失败',
    unrecognizedCluster: '连接“{name}”未返回可识别的集群信息',
    returnToEdit: '返回修改',
    connectionTestSucceeded: '连接测试成功',
    testConnectionFailed: '测试连接“{name}”失败',
    connectionDeleted: '连接已删除',
    deleteConnectionFailed: '删除连接“{name}”失败',
    connectionDisconnected: '连接“{name}”已断开',
    connectionSucceeded: '连接“{name}”成功',
    disconnectFailed: '断开连接“{name}”失败',
    connectFailed: '连接“{name}”失败',
    disconnectFailedTitle: '断开失败',
    connectFailedTitle: '连接失败'
  },
  'en-US': {
    connections: 'Connections',
    logs: 'Logs',
    trash: 'Trash',
    history: 'History',
    settings: 'Settings',
    tools: 'Tools',
    reportIssue: 'Report an issue',
    reportIssueMessage: 'Use the project Issues page to report the error with reproduction steps and relevant logs.',
    openIssues: 'Open Issues',
    openIssuesFailed: 'Failed to open Issues',
    homepage: 'Product home',
    homepageOpenFailed: 'Failed to open product home',
    blog: 'My blog',
    blogOpenFailed: 'Failed to open blog',
    updateCheck: 'Check for updates',
    upToDateNow: 'You are on the latest version. Nice!',
    updateAvailable: 'New version available: {version}',
    downloadUpdate: 'Download update',
    downloadUpdateFailed: 'Failed to open update download',
    onlineUpdateQuestion: 'Version {version} is available. Update online now?',
    updateCheckNetworkFailed: 'Update check failed: network connection failed',
    cancel: 'Cancel',
    updateCheckFailed: 'Update check failed',
    updateSourceRequired: 'Configure an Atlas Admin URL or Manifest URL under Updates & privacy first.',
    manageConnectionGroups: 'Manage connection groups',
    addConnection: 'Add connection',
    collapseConnectionList: 'Collapse connection list',
    expandConnectionList: 'Expand connection list',
    filterConnections: 'Filter connections',
    reload: 'Reload',
    expandGroup: 'Expand group',
    collapseGroup: 'Collapse group',
    connectionActions: 'Connection actions',
    editConnection: 'Edit connection',
    moveToGroup: 'Move to group',
    noMatchingConnections: 'No matching connections',
    noConnections: 'No connections yet',
    adjustFilterHint: 'Adjust the filter and try again',
    addConnectionHint: 'Add an HTTP(S) connection to get started',
    connectionCount: '{count} connections',
    ungrouped: 'Ungrouped',
    collapseResourceTree: 'Collapse resource tree',
    expandResourceTree: 'Expand resource tree',
    noConnectionSelected: 'No connection selected',
    disconnectConnection: 'Disconnect',
    reconnectConnection: 'Reconnect',
    clusterOverview: 'Cluster overview',
    indices: 'Indices',
    nodes: 'Nodes{count}',
    templates: 'Templates',
    componentTemplates: 'Component templates',
    dataStreams: 'Data streams',
    pendingTasks: 'Pending tasks{count}',
    snapshots: 'Snapshots',
    ingestPipeline: 'Ingest Pipeline',
    storedScripts: 'Scripts',
    longOperations: 'Long-running operations',
    openRestConsole: 'Open REST Console',
    closeConnectionTab: 'Close connection tab',
    closePage: 'Close page',
    selectConnection: 'Select a connection',
    selectConnectionHint: 'Select a saved connection on the left or add an HTTP(S) connection.',
    connectionDetails: 'Connection details',
    refreshClusterOverview: 'Refresh cluster overview',
    autoRefresh: 'Auto refresh',
    refreshInterval: 'Refresh interval',
    refreshIntervalSeconds: 'Refresh interval in seconds',
    seconds: 'sec',
    recentlyUpdated: 'Last updated {time}',
    neverRefreshed: 'Never refreshed successfully',
    retainedOverview: 'Showing the last successful data from {time}',
    disconnectedStaleOverview: 'Disconnected; showing the last successfully fetched data',
    fetchingOverview: 'Fetching cluster overview',
    overviewAfterConnection: 'Connect to view the cluster overview',
    overviewCollectedAfterConnection: 'Overview data is collected only after a successful connection',
    refreshAgain: 'Refresh again',
    clusterRuntimeInfo: 'Cluster runtime information',
    runtimeInfo: 'Runtime information',
    historicalSnapshot: 'Historical snapshot',
    currentConnection: 'Current connection',
    clusterName: 'Cluster name',
    version: 'Version',
    uptime: 'Uptime',
    nodeRoles: 'Node roles',
    clusterUuid: 'Cluster UUID',
    clusterHealth: 'Cluster health',
    unassigned: 'Unassigned {count}',
    nodeStatus: 'Node status',
    masterNode: 'Master node {name}',
    activeShards: 'Active shards',
    searchP95: 'Search P95 (this app)',
    writeRejected: 'Write rejections {count}',
    requestMetrics: 'Cluster request metrics',
    currentSnapshot: 'Cluster last 60s; P95/error rate from this app',
    searchQps: 'Search QPS',
    writeQps: 'Write QPS',
    errorRate: 'Error rate (this app)',
    noFakeRequestTrend: 'No cluster search or write operations in the last 60 seconds',
    resourcePressure: 'Resource pressure',
    nodePeak: 'Peak node values',
    jvmHeap: 'JVM heap',
    disk: 'Disk',
    highestPressureNode: 'Highest-pressure node',
    gcDuration: 'Total GC time',
    currentRisks: 'Current risks',
    riskCount: '{count} items need attention',
    noCurrentRisks: 'No issues currently require attention',
    noCurrentRisksHint: 'Cluster health, shard, and resource metrics did not trigger any risk rules in this snapshot',
    recentRequests: 'Recent requests',
    recordedByApp: 'Recorded by this app',
    allRequests: 'All',
    noRequestRecords: 'No request records',
    source: 'Source',
    method: 'Method',
    path: 'Path',
    status: 'Status',
    duration: 'Duration',
    overviewSource: 'Overview',
    indexSource: 'Index',
    connectionSource: 'Connection',
    otherSource: 'Other',
    failedStatus: 'Failed',
    goToRestConsole: 'Go to REST Console',
    restConsoleUnavailable: 'REST Console is not available yet.',
    unknownError: 'Unknown error',
    errorSeparator: ': ',
    issueOpen: ' (',
    issueClose: ')',
    issueSeparator: '; ',
    loadSettingsFailed: 'Failed to load settings',
    loadConnectionGroupsFailed: 'Failed to load connection groups',
    createConnectionGroupFailed: 'Failed to create connection group',
    updateConnectionGroupFailed: 'Failed to update connection group',
    deleteConnectionGroupFailed: 'Failed to delete connection group',
    moveConnectionFailed: 'Failed to move connection',
    settingsSaved: 'Settings saved',
    starlightDialogTitle: 'Star map illuminated',
    starlightDialogMessage: 'Our destination is the sea of stars. Starlight theme is now active, and you can change it anytime in Settings > General > Theme.',
    starlightDialogConfirm: 'Set course for the stars',
    pixelDialogTitle: 'Secret level unlocked',
    pixelDialogMessage: 'Classic code accepted. Pixel game theme is now active, and you can change it anytime in Settings > General > Theme.',
    pixelDialogConfirm: 'Enter the pixel world',
    showEasterEggDialogFailed: 'Failed to show the easter egg confirmation',
    saveSettingsFailed: 'Failed to save settings',
    resetSettingsFailed: 'Failed to reset settings',
    saveRefreshSettingsFailed: 'Failed to save refresh settings for this connection',
    healthGreen: 'Healthy',
    healthYellow: 'Warning',
    healthRed: 'Critical',
    healthUnknown: 'Unknown',
    statusConnected: 'Connected',
    statusUnavailable: 'Connection error',
    statusDisconnected: 'Disconnected',
    loadConnectionListFailed: 'Failed to load connections',
    connectionNotConnected: 'Connection “{name}” is not connected, so the cluster overview cannot be refreshed',
    refreshOverviewFailed: 'Failed to refresh the cluster overview for “{name}”',
    readConnectionFailed: 'Failed to read configuration for “{name}”',
    cannotEditConnection: 'Cannot edit connection',
    close: 'Close',
    connectionUpdated: 'Connection updated',
    connectionCreated: 'Connection added',
    updateConnectionFailed: 'Failed to update connection',
    createConnectionFailed: 'Failed to add connection',
    connectionTestFailed: 'Connection test failed',
    unrecognizedCluster: 'Connection “{name}” did not return recognizable cluster information',
    returnToEdit: 'Return to edit',
    connectionTestSucceeded: 'Connection test succeeded',
    testConnectionFailed: 'Failed to test connection “{name}”',
    connectionDeleted: 'Connection deleted',
    deleteConnectionFailed: 'Failed to delete connection “{name}”',
    connectionDisconnected: 'Connection “{name}” disconnected',
    connectionSucceeded: 'Connection “{name}” connected',
    disconnectFailed: 'Failed to disconnect “{name}”',
    connectFailed: 'Failed to connect “{name}”',
    disconnectFailedTitle: 'Disconnect failed',
    connectFailedTitle: 'Connection failed'
  }
} as const
const copy = computed(() => messages[preferencesSnapshot.value.global.language])

async function showReportIssueDialog(): Promise<void> {
  if (isIssueOpening.value) return
  isIssueOpening.value = true

  try {
    await ElMessageBox.alert(copy.value.reportIssueMessage, copy.value.reportIssue, {
      confirmButtonText: copy.value.openIssues,
      showClose: true,
      closeOnClickModal: false,
      closeOnPressEscape: true,
      distinguishCancelAndClose: true
    })
    await window.electronAPI.openGitHubIssues()
  } catch (error: unknown) {
    if (error === 'close' || error === 'cancel') return
    ElMessage.error(getErrorMessage(error, copy.value.openIssuesFailed))
  } finally {
    isIssueOpening.value = false
  }
}

async function openHomepage(): Promise<void> {
  try {
    await window.electronAPI.openExternal(preferencesSnapshot.value.global.homepageUrl)
  } catch (error: unknown) {
    ElMessage.error(getErrorMessage(error, copy.value.homepageOpenFailed))
  }
}

async function openBlog(): Promise<void> {
  try {
    await window.electronAPI.openExternal(preferencesSnapshot.value.global.blogUrl)
  } catch (error: unknown) {
    ElMessage.error(getErrorMessage(error, copy.value.blogOpenFailed))
  }
}

async function checkForUpdates(silent = false): Promise<void> {
  try {
    const result = await window.electronAPI.diagnostics.checkForUpdates({})
    if (result.status === 'available') {
      if (!result.downloadUrl) {
        ElMessage.success(formatMessage(copy.value.updateAvailable, {
          version: result.latestVersion ?? result.currentVersion
        }))
        return
      }
      try {
        await ElMessageBox.confirm(
          formatMessage(copy.value.onlineUpdateQuestion, {
            version: result.latestVersion ?? result.currentVersion
          }),
          copy.value.updateCheck,
          { confirmButtonText: copy.value.downloadUpdate, cancelButtonText: copy.value.cancel }
        )
        await window.electronAPI.openExternal(result.downloadUrl)
      } catch (error: unknown) {
        if (error === 'cancel' || error === 'close') return
        ElMessage.error(getErrorMessage(error, copy.value.downloadUpdateFailed))
      }
      return
    }
    ElMessage.success(copy.value.upToDateNow)
  } catch (error: unknown) {
    if (!silent) ElMessage.error(copy.value.updateCheckNetworkFailed)
  }
}

function handleSettingsMenuCommand(command: string): void {
  if (command === 'settings') {
    openSettingsDialog()
    return
  }
  if (command === 'report-issue') {
    void showReportIssueDialog()
    return
  }
  if (command === 'homepage') {
    void openHomepage()
    return
  }
  if (command === 'blog') {
    void openBlog()
    return
  }
  if (command === 'update-check') void checkForUpdates()
}

let isApplyingConnectionPreferences = false
let preferencesSaveTimer: number | undefined
const workspaceTabIcons: Record<WorkspaceTabKind, Component> = {
  dashboard: markRaw(DataAnalysis),
  index: markRaw(Grid),
  rest: markRaw(Tools),
  'cluster-resource': markRaw(FolderOpened),
  operation: markRaw(Timer)
}
const globalTabDefinitions: Array<{ id: Exclude<GlobalView, 'connections'>; title: keyof typeof messages['zh-CN']; icon: Component }> = [
  { id: 'logs', title: 'logs', icon: markRaw(Tickets) },
  { id: 'history', title: 'history', icon: markRaw(Timer) },
  { id: 'trash', title: 'trash', icon: markRaw(Delete) }
]
let refreshTimer: number | undefined
let brandClickCount = 0
let brandClickResetTimer: number | undefined
let pixelThemeSequenceIndex = 0
let isEasterEggThemeSaving = false
let isWorkspaceInitialized = false

const activeEasterEggTheme = computed<EasterEggTheme | null>(() => {
  const theme = preferencesSnapshot.value.global.theme
  return theme === 'starlight' || theme === 'pixel' ? theme : null
})

function getEasterEggDialogSeenKey(theme: EasterEggTheme): string {
  return `${EASTER_EGG_DIALOG_SEEN_KEY_PREFIX}${theme}`
}

async function activateEasterEggTheme(theme: EasterEggTheme): Promise<void> {
  if (isEasterEggThemeSaving) return
  isEasterEggThemeSaving = true

  const input: SavePreferencesInput = {
    global: {
      ...preferencesSnapshot.value.global,
      theme,
      unlockedEasterEggThemes: [...new Set([
        ...preferencesSnapshot.value.global.unlockedEasterEggThemes,
        theme
      ])]
    },
    connections: Object.fromEntries(
      Object.entries(preferencesSnapshot.value.connections).map(([connectionId, preferences]) => [
        connectionId,
        { ...preferences }
      ])
    )
  }

  try {
    applyPreferences(await window.electronAPI.settings.save(input))
  } catch (error: unknown) {
    ElMessage.error(getErrorMessage(error, copy.value.saveSettingsFailed))
    isEasterEggThemeSaving = false
    return
  }

  if (window.localStorage.getItem(getEasterEggDialogSeenKey(theme)) === 'true') {
    isEasterEggThemeSaving = false
    return
  }

  try {
    await ElMessageBox.alert(
      theme === 'starlight' ? copy.value.starlightDialogMessage : copy.value.pixelDialogMessage,
      theme === 'starlight' ? copy.value.starlightDialogTitle : copy.value.pixelDialogTitle,
      {
        confirmButtonText: theme === 'starlight'
          ? copy.value.starlightDialogConfirm
          : copy.value.pixelDialogConfirm,
        showClose: false,
        closeOnClickModal: false,
        closeOnPressEscape: false,
        customClass: `easter-egg-dialog ${theme}-easter-egg-dialog`
      }
    )
    window.localStorage.setItem(getEasterEggDialogSeenKey(theme), 'true')
  } catch (error: unknown) {
    ElMessage.error(getErrorMessage(error, copy.value.showEasterEggDialogFailed))
  } finally {
    isEasterEggThemeSaving = false
  }
}

function handleBrandClick(): void {
  if (brandClickResetTimer !== undefined) window.clearTimeout(brandClickResetTimer)
  brandClickCount += 1

  if (brandClickCount === BRAND_CLICKS_TO_UNLOCK) {
    brandClickCount = 0
    brandClickResetTimer = undefined
    void activateEasterEggTheme('starlight')
    return
  }

  brandClickResetTimer = window.setTimeout(() => {
    brandClickCount = 0
    brandClickResetTimer = undefined
  }, BRAND_CLICK_RESET_DELAY_MS)
}

function handleEasterEggKeydown(event: KeyboardEvent): void {
  if (event.repeat || isSettingsDialogVisible.value) return

  const inputKey = event.key.length === 1 ? event.key.toLocaleLowerCase('en-US') : event.key
  const expectedKey = PIXEL_THEME_SEQUENCE[pixelThemeSequenceIndex]
  if (inputKey === expectedKey) {
    pixelThemeSequenceIndex += 1
  } else {
    pixelThemeSequenceIndex = inputKey === PIXEL_THEME_SEQUENCE[0] ? 1 : 0
  }

  if (pixelThemeSequenceIndex === PIXEL_THEME_SEQUENCE.length) {
    pixelThemeSequenceIndex = 0
    void activateEasterEggTheme('pixel')
  }
}

const filteredConnections = computed(() => {
  const keyword = connectionFilter.value.trim().toLocaleLowerCase('zh-CN')
  if (!keyword) return connections.value

  return connections.value.filter((connection) =>
    [connection.name, connection.endpoint, connection.engine, connection.version]
      .filter((value): value is string => Boolean(value))
      .some((value) => value.toLocaleLowerCase('zh-CN').includes(keyword))
  )
})
const groupedConnections = computed<ConnectionGroupSection[]>(() => {
  const keyword = connectionFilter.value.trim().toLocaleLowerCase('zh-CN')
  const sections: ConnectionGroupSection[] = connectionGroups.value.map((group) => {
    const members = connections.value.filter((connection) => connection.groupId === group.id)
    const groupMatches = Boolean(keyword) && group.name.toLocaleLowerCase('zh-CN').includes(keyword)
    return {
      id: group.id,
      name: group.name,
      color: group.color,
      connections: groupMatches ? members : members.filter((connection) => filteredConnections.value.includes(connection))
    }
  })
  const ungrouped = connections.value.filter((connection) => connection.groupId === null)
  const ungroupedMatches = Boolean(keyword) && ['未分组', 'ungrouped'].some((name) => name.includes(keyword))
  const visibleUngrouped = ungroupedMatches
    ? ungrouped
    : ungrouped.filter((connection) => filteredConnections.value.includes(connection))
  if (visibleUngrouped.length > 0 || (!keyword && ungrouped.length > 0)) {
    sections.push({ id: null, name: copy.value.ungrouped, color: null, connections: visibleUngrouped })
  }
  return sections.filter((section) => section.connections.length > 0)
})
const connectionGroupMemberCounts = computed<Record<string, number>>(() =>
  Object.fromEntries(
    connectionGroups.value.map((group) => [
      group.id,
      connections.value.filter((connection) => connection.groupId === group.id).length
    ])
  )
)
const activeConnection = computed(() =>
  connections.value.find((connection) => connection.id === activeConnectionId.value)
)
const visibleWorkspaceTabs = computed(() =>
  workspaceTabs.value
    .filter((tab) => tab.connectionId === activeConnectionId.value)
    .map((tab) => ({
      ...tab,
      title: tab.kind === 'rest'
        ? tab.title
        : getWorkspaceTabTitle(tab.kind, tab.connectionId, tab.resourceKey)
    }))
)
const activeWorkspaceTabId = computed(() => activeWorkspaceTabIds.value[activeConnectionId.value])
const activeTab = computed(() =>
  visibleWorkspaceTabs.value.find((tab) => tab.id === activeWorkspaceTabId.value)
)
const tabContextMenuTab = computed(() => {
  const tab = workspaceTabs.value.find((item) => item.id === tabContextMenuTabId.value)
  return tab ? toContextMenuWorkspaceTab(tab) : null
})
const contextMenuWorkspaceTabs = computed(() =>
  workspaceTabs.value.map(toContextMenuWorkspaceTab)
)
const activeOverview = computed(() => overviewByConnection.value[activeConnectionId.value])
const activeRecentRequests = computed(() => activeOverview.value?.recentRequests ?? [])
const hasRequestTrend = computed(() =>
  (activeOverview.value?.requestTrend ?? []).some(
    (bucket) => bucket.searchCount > 0 || bucket.writeCount > 0
  )
)
const requestTrendMaximum = computed(() =>
  Math.max(
    1,
    ...(activeOverview.value?.requestTrend ?? []).flatMap((bucket) => [
      bucket.searchCount,
      bucket.writeCount
    ])
  )
)
const activeConnectionPreferences = computed<ConnectionPreferences>(() =>
  preferencesSnapshot.value.connections[activeConnectionId.value] ?? {
    ...DEFAULT_CONNECTION_PREFERENCES
  }
)
const activeDefaultQuerySize = computed(() => activeConnectionPreferences.value.defaultQuerySize)
const activeOverviewError = computed(() => overviewErrorByConnection.value[activeConnectionId.value] ?? '')
const isActiveOverviewLoading = computed(
  () => overviewLoadingByConnection.value[activeConnectionId.value] ?? false
)
const hasStaleOverview = computed(
  () => Boolean(activeOverview.value) && (Boolean(activeOverviewError.value) || activeConnection.value?.status !== 'connected')
)
const lastRefreshText = computed(() => {
  const collectedAt = activeOverview.value?.collectedAt
  if (!collectedAt) return copy.value.neverRefreshed

  return new Date(collectedAt).toLocaleTimeString(preferencesSnapshot.value.global.language, {
    hour12: false
  })
})
const resourceTree = computed<ResourceTreeItem[]>(() => {
  const items: ResourceTreeItem[] = [
    { id: 'overview', label: copy.value.clusterOverview, icon: markRaw(DataAnalysis) },
    { id: 'indices', label: copy.value.indices, icon: markRaw(Grid) },
    {
      id: 'nodes',
      label: formatMessage(copy.value.nodes, {
        count: formatResourceTreeCount(activeOverview.value?.nodesTotal)
      }),
      icon: markRaw(Monitor),
      children: activeOverview.value?.masterNode
        ? [{ id: 'master-node', label: activeOverview.value.masterNode }]
        : undefined
    },
    { id: 'templates', label: copy.value.templates, icon: markRaw(FolderOpened) },
    { id: 'component-templates', label: copy.value.componentTemplates, icon: markRaw(FolderOpened) },
    { id: 'data-streams', label: copy.value.dataStreams, icon: markRaw(Document) },
    {
      id: 'pending-tasks',
      label: formatMessage(copy.value.pendingTasks, {
        count: formatResourceTreeCount(activeOverview.value?.pendingTasks)
      }),
      icon: markRaw(Timer)
    },
    { id: 'snapshots', label: copy.value.snapshots, icon: markRaw(Tickets) },
    { id: 'ingest-pipeline', label: copy.value.ingestPipeline, icon: markRaw(Tools) },
    { id: 'scripts', label: copy.value.storedScripts, icon: markRaw(Document) },
    { id: 'long-operations', label: copy.value.longOperations, icon: markRaw(Timer) }
  ]
  const connection = activeConnection.value

  return items.filter((item) => {
    const capability = RESOURCE_TREE_CAPABILITIES[item.id]
    if (!capability || !connection) return true
    return !isCapabilityUnsupportedByProductVersion(
      capability,
      connection.engine,
      connection.version
    )
  })
})

function formatMessage(
  template: string,
  values: Record<string, string | number>
): string {
  return Object.entries(values).reduce(
    (message, [key, value]) => message.replaceAll(`{${key}}`, String(value)),
    template
  )
}

function getErrorMessage(error: unknown, context: string): string {
  if (error instanceof Error && error.message) {
    return `${context}${copy.value.errorSeparator}${error.message}`
  }
  return `${context}${copy.value.errorSeparator}${copy.value.unknownError}`
}

function readCollapsedGroupIds(): string[] {
  try {
    const value = JSON.parse(window.localStorage.getItem('es-atlas:collapsed-connection-groups') ?? '[]') as unknown
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function isWorkspaceTabKind(value: unknown): value is WorkspaceTabKind {
  return value === 'dashboard' ||
    value === 'index' ||
    value === 'rest' ||
    value === 'cluster-resource' ||
    value === 'operation'
}

function isClusterResourceKind(value: unknown): value is ClusterResourceKind {
  return value === 'node' ||
    value === 'task' ||
    value === 'index-template' ||
    value === 'component-template' ||
    value === 'data-stream' ||
    value === 'snapshot' ||
    value === 'ingest-pipeline' ||
    value === 'stored-script'
}

function readWorkspaceState(): PersistedWorkspaceState | null {
  try {
    const value = JSON.parse(window.localStorage.getItem(WORKSPACE_STORAGE_KEY) ?? 'null') as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const record = value as Record<string, unknown>
    if (typeof record.activeConnectionId !== 'string' || !Array.isArray(record.connectionIds)) return null

    const connectionIds = record.connectionIds.filter((item): item is string => typeof item === 'string')
    const tabs = Array.isArray(record.tabs)
      ? record.tabs.flatMap((item) => {
          if (!item || typeof item !== 'object' || Array.isArray(item)) return []
          const tab = item as Record<string, unknown>
          if (typeof tab.connectionId !== 'string' || !isWorkspaceTabKind(tab.kind)) return []
          const fallbackId = `${tab.kind}-${tab.connectionId}`
          const id = typeof tab.id === 'string' && tab.id.length > 0 && tab.id.length <= 768
            ? tab.id
            : fallbackId
          const title = typeof tab.title === 'string' && tab.title.length > 0 && tab.title.length <= 256
            ? tab.title
            : ''
          const resourceKey = typeof tab.resourceKey === 'string' && tab.resourceKey.length > 0 && tab.resourceKey.length <= 256
            ? tab.resourceKey
            : id
          return [{ id, connectionId: tab.connectionId, kind: tab.kind, title, resourceKey }]
        })
      : []
    const activeTabIds = record.activeTabIds && typeof record.activeTabIds === 'object' && !Array.isArray(record.activeTabIds)
      ? Object.fromEntries(
          Object.entries(record.activeTabIds).filter(([, tabId]) => typeof tabId === 'string')
        ) as Record<string, string>
      : {}
    const activeTabKinds = record.activeTabKinds && typeof record.activeTabKinds === 'object' && !Array.isArray(record.activeTabKinds)
      ? Object.fromEntries(
          Object.entries(record.activeTabKinds).filter(([, kind]) => isWorkspaceTabKind(kind))
        ) as Record<string, WorkspaceTabKind>
      : {}
    const clusterResourceKinds = record.clusterResourceKinds && typeof record.clusterResourceKinds === 'object' && !Array.isArray(record.clusterResourceKinds)
      ? Object.fromEntries(
          Object.entries(record.clusterResourceKinds).filter(([, kind]) => isClusterResourceKind(kind))
        ) as Record<string, ClusterResourceKind>
      : {}

    return {
      activeConnectionId: record.activeConnectionId,
      connectionIds,
      tabs,
      activeTabIds,
      activeTabKinds,
      clusterResourceKinds,
      connectionListCollapsed: record.connectionListCollapsed === true,
      resourceTreeCollapsed: record.resourceTreeCollapsed === true
    }
  } catch {
    return null
  }
}

function persistWorkspaceState(): void {
  if (!isWorkspaceInitialized || !preferencesSnapshot.value.global.workspaceRestoreEnabled) return

  const state: PersistedWorkspaceState = {
    activeConnectionId: activeConnectionId.value,
    connectionIds: connectionTabs.value.map((tab) => tab.connectionId),
    tabs: workspaceTabs.value.map((tab) => ({ ...tab })),
    activeTabIds: { ...activeWorkspaceTabIds.value },
    activeTabKinds: Object.fromEntries(
      Object.entries(activeWorkspaceTabIds.value).flatMap(([connectionId, tabId]) => {
        const tab = workspaceTabs.value.find((item) => item.id === tabId)
        return tab ? [[connectionId, tab.kind]] : []
      })
    ),
    clusterResourceKinds: { ...clusterResourceKindsByConnection.value },
    connectionListCollapsed: isConnectionListCollapsed.value,
    resourceTreeCollapsed: isResourceTreeCollapsed.value
  }
  window.localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(state))
}

function isConnectionGroupCollapsed(groupId: string | null): boolean {
  return !connectionFilter.value.trim() && collapsedConnectionGroupIds.value.includes(groupId ?? '__ungrouped__')
}

function toggleConnectionGroup(groupId: string | null): void {
  const storedGroupId = groupId ?? '__ungrouped__'
  collapsedConnectionGroupIds.value = collapsedConnectionGroupIds.value.includes(storedGroupId)
    ? collapsedConnectionGroupIds.value.filter((item) => item !== storedGroupId)
    : [...collapsedConnectionGroupIds.value, storedGroupId]
  window.localStorage.setItem(
    'es-atlas:collapsed-connection-groups',
    JSON.stringify(collapsedConnectionGroupIds.value)
  )
}

function applyPreferences(snapshot: PreferencesSnapshot): void {
  preferencesSnapshot.value = snapshot
  document.documentElement.dataset.theme = snapshot.global.theme
  document.documentElement.dataset.density = snapshot.global.density
  document.documentElement.dataset.language = snapshot.global.language
  document.documentElement.style.setProperty('--app-font-family', snapshot.global.fontFamily)
  document.documentElement.style.setProperty('--app-font-size', `${snapshot.global.fontSize}px`)
  applyActiveConnectionPreferences()
}

function applyActiveConnectionPreferences(): void {
  isApplyingConnectionPreferences = true
  const preferences = activeConnectionPreferences.value
  isAutoRefreshEnabled.value = preferences.autoRefreshEnabled
  refreshIntervalSeconds.value = preferences.refreshIntervalSeconds
  window.queueMicrotask(() => {
    isApplyingConnectionPreferences = false
    scheduleDashboardRefresh()
  })
}

async function loadSettings(): Promise<void> {
  isSettingsLoading.value = true
  settingsError.value = ''
  try {
    const [snapshot, diagnostic] = await Promise.all([
      window.electronAPI.settings.get(),
      window.electronAPI.settings.getDiagnostic()
    ])
    applyPreferences(snapshot)
    if (diagnostic) {
      settingsError.value = `${diagnostic.operation}${copy.value.errorSeparator}${diagnostic.reason}${diagnostic.issues.length ? `${copy.value.issueOpen}${diagnostic.issues.join(copy.value.issueSeparator)}${copy.value.issueClose}` : ''}`
    }
  } catch (error: unknown) {
    settingsError.value = getErrorMessage(error, copy.value.loadSettingsFailed)
    applyPreferences(createDefaultPreferencesSnapshot())
  } finally {
    isSettingsLoading.value = false
  }
}

async function loadConnectionGroups(): Promise<void> {
  try {
    connectionGroups.value = await window.electronAPI.connectionGroups.list()
  } catch (error: unknown) {
    connectionListError.value = getErrorMessage(error, copy.value.loadConnectionGroupsFailed)
  }
}

function openGroupManager(): void {
  groupActionError.value = ''
  isGroupManagerVisible.value = true
}

function openMoveConnectionDialog(connection: ConnectionSummary): void {
  movingConnection.value = connection
  groupActionError.value = ''
  isMoveConnectionDialogVisible.value = true
}

function handleConnectionCommand(command: string, connection: ConnectionSummary): void {
  if (command === 'edit') {
    void openEditConnectionDialog(connection)
    return
  }
  if (command === 'move') openMoveConnectionDialog(connection)
}

async function createConnectionGroup(input: CreateConnectionGroupInput): Promise<void> {
  isGroupActionBusy.value = true
  groupActionError.value = ''
  try {
    connectionGroups.value.push(await window.electronAPI.connectionGroups.create(input))
  } catch (error: unknown) {
    groupActionError.value = getErrorMessage(error, copy.value.createConnectionGroupFailed)
  } finally {
    isGroupActionBusy.value = false
  }
}

async function updateConnectionGroup(input: UpdateConnectionGroupInput): Promise<void> {
  isGroupActionBusy.value = true
  groupActionError.value = ''
  try {
    const updatedGroup = await window.electronAPI.connectionGroups.update(input)
    connectionGroups.value = connectionGroups.value.map((group) =>
      group.id === updatedGroup.id ? updatedGroup : group
    )
  } catch (error: unknown) {
    groupActionError.value = getErrorMessage(error, copy.value.updateConnectionGroupFailed)
  } finally {
    isGroupActionBusy.value = false
  }
}

async function deleteConnectionGroup(groupId: string): Promise<void> {
  isGroupActionBusy.value = true
  groupActionError.value = ''
  try {
    await window.electronAPI.connectionGroups.delete(groupId)
    connectionGroups.value = connectionGroups.value.filter((group) => group.id !== groupId)
    connections.value = connections.value.map((connection) =>
      connection.groupId === groupId ? { ...connection, groupId: null } : connection
    )
  } catch (error: unknown) {
    groupActionError.value = getErrorMessage(error, copy.value.deleteConnectionGroupFailed)
  } finally {
    isGroupActionBusy.value = false
  }
}

async function moveConnection(connectionId: string, groupId: string | null): Promise<void> {
  isGroupActionBusy.value = true
  groupActionError.value = ''
  try {
    const movedConnections = await window.electronAPI.connectionGroups.moveConnections({
      connectionIds: [connectionId],
      groupId
    })
    movedConnections.forEach(updateConnectionSummary)
    isMoveConnectionDialogVisible.value = false
  } catch (error: unknown) {
    groupActionError.value = getErrorMessage(error, copy.value.moveConnectionFailed)
  } finally {
    isGroupActionBusy.value = false
  }
}

function openSettingsDialog(): void {
  isSettingsDialogVisible.value = true
}

async function saveSettings(input: SavePreferencesInput): Promise<void> {
  isSettingsSaving.value = true
  settingsError.value = ''
  try {
    applyPreferences(await window.electronAPI.settings.save(input))
    isSettingsDialogVisible.value = false
    ElMessage.success(copy.value.settingsSaved)
  } catch (error: unknown) {
    settingsError.value = getErrorMessage(error, copy.value.saveSettingsFailed)
  } finally {
    isSettingsSaving.value = false
  }
}

async function resetSettings(): Promise<void> {
  isSettingsSaving.value = true
  settingsError.value = ''
  try {
    applyPreferences(await window.electronAPI.settings.reset())
  } catch (error: unknown) {
    settingsError.value = getErrorMessage(error, copy.value.resetSettingsFailed)
  } finally {
    isSettingsSaving.value = false
  }
}

function persistDashboardPreferences(): void {
  if (isApplyingConnectionPreferences || !activeConnectionId.value) return
  const connectionId = activeConnectionId.value
  const nextSnapshot: PreferencesSnapshot = {
    ...preferencesSnapshot.value,
    global: { ...preferencesSnapshot.value.global },
    connections: {
      ...preferencesSnapshot.value.connections,
      [connectionId]: {
        ...activeConnectionPreferences.value,
        autoRefreshEnabled: isAutoRefreshEnabled.value,
        refreshIntervalSeconds: refreshIntervalSeconds.value
      }
    }
  }
  preferencesSnapshot.value = nextSnapshot
  if (preferencesSaveTimer !== undefined) window.clearTimeout(preferencesSaveTimer)
  preferencesSaveTimer = window.setTimeout(async () => {
    try {
      applyPreferences(await window.electronAPI.settings.save({
        global: nextSnapshot.global,
        connections: nextSnapshot.connections
      }))
    } catch (error: unknown) {
      ElMessage.error(getErrorMessage(error, copy.value.saveRefreshSettingsFailed))
    }
  }, 400)
}

async function showConnectionResult(
  title: string,
  message: string,
  type: 'success' | 'error' | 'warning',
  confirmButtonText: string
): Promise<void> {
  await ElMessageBox.alert(message, title, {
    type,
    confirmButtonText,
    showClose: false,
    customClass: `connection-result-dialog is-${type}`
  })
}

function getClusterHealthText(health: ClusterHealth | undefined): string {
  const healthText: Record<ClusterHealth, string> = {
    green: copy.value.healthGreen,
    yellow: copy.value.healthYellow,
    red: copy.value.healthRed,
    unknown: copy.value.healthUnknown
  }
  return healthText[health ?? 'unknown']
}

function getConnectionStatusText(connection: ConnectionSummary | undefined): string {
  if (connection?.status === 'connected') return copy.value.statusConnected
  if (connection?.status === 'unavailable') return copy.value.statusUnavailable
  return copy.value.statusDisconnected
}

function getConnectionStatusType(
  connection: ConnectionSummary | undefined
): 'success' | 'danger' | 'info' {
  if (connection?.status === 'connected') return 'success'
  if (connection?.status === 'unavailable') return 'danger'
  return 'info'
}

function formatMetric(value: number | null | undefined, suffix = ''): string {
  return value === null || value === undefined ? '--' : `${value}${suffix}`
}

function formatResourceTreeCount(value: number | null | undefined): string {
  return value === null || value === undefined ? '' : ` ${value}`
}

function formatText(value: string | null | undefined): string {
  return value || '--'
}

function formatRequestSource(record: RequestHistoryRecord): string {
  if (record.source === 'overview') return copy.value.overviewSource
  if (record.source === 'index') return copy.value.indexSource
  if (record.source === 'connection') return copy.value.connectionSource
  return copy.value.otherSource
}

function formatRequestStatus(record: RequestHistoryRecord): string {
  return record.statusCode === null
    ? record.errorCode ?? copy.value.failedStatus
    : String(record.statusCode)
}

function getRequestTrendHeight(requestCount: number): string {
  if (requestCount <= 0) return '3px'
  return `${Math.max(8, Math.round((requestCount / requestTrendMaximum.value) * 100))}%`
}

function openRequestHistory(connectionId: string | null): void {
  requestHistoryConnectionId.value = connectionId
  isRequestHistoryVisible.value = true
}

function getDashboardTabId(connectionId: string): string {
  return `dashboard-${connectionId}`
}

function getWorkspaceTabTitle(
  kind: WorkspaceTabKind,
  connectionId = '',
  resourceKey?: string
): string {
  if (kind === 'dashboard') return copy.value.clusterOverview
  if (kind === 'index') return copy.value.indices
  if (kind === 'rest') return 'REST Console'
  if (kind === 'operation') return copy.value.longOperations
  if (isClusterResourceKind(resourceKey)) return getClusterResourceTitle(resourceKey)
  return getClusterResourceTitle(clusterResourceKindsByConnection.value[connectionId] ?? 'node')
}

function getClusterResourceTitle(kind: ClusterResourceKind): string {
  if (kind === 'node') return formatMessage(copy.value.nodes, { count: '' })
  if (kind === 'task') return formatMessage(copy.value.pendingTasks, { count: '' })
  if (kind === 'index-template') return copy.value.templates
  if (kind === 'component-template') return copy.value.componentTemplates
  if (kind === 'data-stream') return copy.value.dataStreams
  if (kind === 'snapshot') return copy.value.snapshots
  if (kind === 'ingest-pipeline') return copy.value.ingestPipeline
  return copy.value.storedScripts
}

function ensureConnectionWorkspace(connection: ConnectionSummary): void {
  const connectionTab = connectionTabs.value.find((tab) => tab.connectionId === connection.id)
  if (connectionTab) {
    connectionTab.title = connection.name
  } else {
    connectionTabs.value.push({ connectionId: connection.id, title: connection.name })
  }

  const dashboardTabId = getDashboardTabId(connection.id)
  if (!workspaceTabs.value.some((tab) => tab.id === dashboardTabId)) {
    workspaceTabs.value.push({
      id: dashboardTabId,
      connectionId: connection.id,
      title: copy.value.clusterOverview,
      kind: 'dashboard'
    })
  }

  if (!activeWorkspaceTabIds.value[connection.id]) {
    activeWorkspaceTabIds.value = {
      ...activeWorkspaceTabIds.value,
      [connection.id]: dashboardTabId
    }
  }
}

function ensureWorkspaceTab(connectionId: string, kind: WorkspaceTabKind): string {
  const tabId = `${kind}-${connectionId}`
  if (!workspaceTabs.value.some((tab) => tab.id === tabId)) {
    workspaceTabs.value.push({
      id: tabId,
      connectionId,
      title: getWorkspaceTabTitle(kind, connectionId),
      kind
    })
  }
  return tabId
}

function ensurePersistedWorkspaceTab(tab: WorkspaceTab): string {
  if (tab.kind === 'dashboard') return getDashboardTabId(tab.connectionId)
  const existing = workspaceTabs.value.find((item) => item.id === tab.id)
  if (existing) return existing.id
  workspaceTabs.value.push({
    ...tab,
    title: tab.title || getWorkspaceTabTitle(tab.kind, tab.connectionId),
    resourceKey: tab.resourceKey ?? tab.id
  })
  return tab.id
}

function restoreWorkspaceState(loadedConnections: ConnectionSummary[]): string | undefined {
  if (!preferencesSnapshot.value.global.workspaceRestoreEnabled) return undefined
  const state = readWorkspaceState()
  if (!state) return undefined

  const loadedConnectionIds = new Set(loadedConnections.map((connection) => connection.id))
  clusterResourceKindsByConnection.value = Object.fromEntries(
    Object.entries(state.clusterResourceKinds).filter(([connectionId]) => loadedConnectionIds.has(connectionId))
  )
  state.connectionIds.forEach((connectionId) => {
    const connection = loadedConnections.find((item) => item.id === connectionId)
    if (connection) ensureConnectionWorkspace(connection)
  })
  state.tabs.forEach((tab) => {
    if (!loadedConnectionIds.has(tab.connectionId)) return
    const connection = loadedConnections.find((item) => item.id === tab.connectionId)
    if (!connection) return
    ensureConnectionWorkspace(connection)
    ensurePersistedWorkspaceTab(tab)
  })

  Object.entries(state.activeTabIds).forEach(([connectionId, tabId]) => {
    if (!loadedConnectionIds.has(connectionId)) return
    const tab = workspaceTabs.value.find(
      (item) => item.id === tabId && item.connectionId === connectionId
    )
    if (tab) {
      activeWorkspaceTabIds.value = { ...activeWorkspaceTabIds.value, [connectionId]: tab.id }
    }
  })

  Object.entries(state.activeTabKinds).forEach(([connectionId, kind]) => {
    if (!loadedConnectionIds.has(connectionId) || state.activeTabIds[connectionId]) return
    activeWorkspaceTabIds.value = {
      ...activeWorkspaceTabIds.value,
      [connectionId]: ensureWorkspaceTab(connectionId, kind)
    }
  })
  isConnectionListCollapsed.value = state.connectionListCollapsed
  isResourceTreeCollapsed.value = state.resourceTreeCollapsed
  return loadedConnectionIds.has(state.activeConnectionId) ? state.activeConnectionId : undefined
}

function pruneMissingConnectionWorkspaces(): void {
  const connectionIds = new Set(connections.value.map((connection) => connection.id))
  connectionTabs.value = connectionTabs.value.filter((tab) => connectionIds.has(tab.connectionId))
  workspaceTabs.value = workspaceTabs.value.filter((tab) => connectionIds.has(tab.connectionId))

  const nextActiveWorkspaceTabIds = { ...activeWorkspaceTabIds.value }
  Object.keys(nextActiveWorkspaceTabIds).forEach((connectionId) => {
    if (!connectionIds.has(connectionId)) delete nextActiveWorkspaceTabIds[connectionId]
  })
  activeWorkspaceTabIds.value = nextActiveWorkspaceTabIds

  clusterResourceKindsByConnection.value = Object.fromEntries(
    Object.entries(clusterResourceKindsByConnection.value).filter(([connectionId]) => connectionIds.has(connectionId))
  )
}

async function loadConnections(preferredConnectionId = ''): Promise<void> {
  isConnectionListLoading.value = true
  connectionListError.value = ''

  try {
    const loadedConnections: ConnectionSummary[] = await window.electronAPI.connections.list()
    connections.value = loadedConnections
    pruneMissingConnectionWorkspaces()

    const restoredConnectionId = isWorkspaceInitialized ? undefined : restoreWorkspaceState(loadedConnections)

    const nextActiveConnection =
      loadedConnections.find((connection) => connection.id === preferredConnectionId) ??
      loadedConnections.find((connection) => connection.id === restoredConnectionId) ??
      loadedConnections.find((connection) => connection.id === activeConnectionId.value) ??
      loadedConnections[0]

    if (!nextActiveConnection) {
      activeConnectionId.value = ''
      isWorkspaceInitialized = true
      return
    }

    ensureConnectionWorkspace(nextActiveConnection)
    activeConnectionId.value = nextActiveConnection.id
    if (nextActiveConnection.status === 'connected' && !overviewByConnection.value[nextActiveConnection.id]) {
      void refreshDashboard(nextActiveConnection.id)
    }
    isWorkspaceInitialized = true
  } catch (error: unknown) {
    connectionListError.value = getErrorMessage(error, copy.value.loadConnectionListFailed)
  } finally {
    isConnectionListLoading.value = false
  }
}

async function refreshDashboard(connectionId = activeConnectionId.value): Promise<void> {
  if (!connectionId || overviewLoadingByConnection.value[connectionId]) return

  const connection = connections.value.find((item) => item.id === connectionId)
  if (!connection || connection.status !== 'connected') {
    overviewErrorByConnection.value = {
      ...overviewErrorByConnection.value,
      [connectionId]: formatMessage(copy.value.connectionNotConnected, {
        name: connection?.name ?? connectionId
      })
    }
    return
  }

  const requestGeneration = overviewGenerationByConnection.value[connectionId] ?? 0
  const requestEndpoint = connection.endpoint

  overviewLoadingByConnection.value = {
    ...overviewLoadingByConnection.value,
    [connectionId]: true
  }
  overviewErrorByConnection.value = {
    ...overviewErrorByConnection.value,
    [connectionId]: ''
  }

  try {
    const overview = await window.electronAPI.cluster.getOverview(connectionId)
    const currentConnection = connections.value.find((item) => item.id === connectionId)
    if (
      (overviewGenerationByConnection.value[connectionId] ?? 0) !== requestGeneration ||
      currentConnection?.endpoint !== requestEndpoint
    ) {
      return
    }
    overviewByConnection.value = {
      ...overviewByConnection.value,
      [connectionId]: overview
    }
  } catch (error: unknown) {
    if ((overviewGenerationByConnection.value[connectionId] ?? 0) !== requestGeneration) return
    overviewErrorByConnection.value = {
      ...overviewErrorByConnection.value,
      [connectionId]: getErrorMessage(
        error,
        formatMessage(copy.value.refreshOverviewFailed, { name: connection.name })
      )
    }
  } finally {
    if ((overviewGenerationByConnection.value[connectionId] ?? 0) !== requestGeneration) return
    overviewLoadingByConnection.value = {
      ...overviewLoadingByConnection.value,
      [connectionId]: false
    }
  }
}

function invalidateOverview(connectionId: string): void {
  overviewGenerationByConnection.value = {
    ...overviewGenerationByConnection.value,
    [connectionId]: (overviewGenerationByConnection.value[connectionId] ?? 0) + 1
  }
  const nextOverviewByConnection = { ...overviewByConnection.value }
  const nextOverviewErrorByConnection = { ...overviewErrorByConnection.value }
  delete nextOverviewByConnection[connectionId]
  delete nextOverviewErrorByConnection[connectionId]
  overviewByConnection.value = nextOverviewByConnection
  overviewErrorByConnection.value = nextOverviewErrorByConnection
  overviewLoadingByConnection.value = {
    ...overviewLoadingByConnection.value,
    [connectionId]: false
  }
}

function scheduleDashboardRefresh(): void {
  if (refreshTimer !== undefined) window.clearInterval(refreshTimer)
  refreshTimer = undefined

  if (isAutoRefreshEnabled.value && activeConnection.value?.status === 'connected') {
    refreshTimer = window.setInterval(() => {
      void refreshDashboard()
    }, refreshIntervalSeconds.value * 1000)
  }
}

function activateConnection(connectionId: string): void {
  const connection = connections.value.find((item) => item.id === connectionId)
  if (!connection) return

  activeGlobalView.value = 'connections'
  ensureConnectionWorkspace(connection)
  activeConnectionId.value = connectionId
  if (connection.status === 'connected' && !overviewByConnection.value[connectionId]) {
    void refreshDashboard(connectionId)
  }
}

async function openConnection(connection: ConnectionSummary): Promise<void> {
  activateConnection(connection.id)
  if (connection.status === 'connected') {
    isConnectionListCollapsed.value = true
    return
  }

  await changeConnectionState(connection, 'connect', true)
  if (connections.value.find((item) => item.id === connection.id)?.status === 'connected') {
    isConnectionListCollapsed.value = true
  }
}

function openCreateConnectionDialog(): void {
  editingConnection.value = null
  editingConnectionProfile.value = null
  connectionDialogError.value = ''
  isConnectionDialogVisible.value = true
}

async function openEditConnectionDialog(connection: ConnectionSummary): Promise<void> {
  editingConnection.value = connection
  editingConnectionProfile.value = null
  connectionDialogError.value = ''
  isConnectionDialogVisible.value = true
  isConnectionProfileLoading.value = true
  try {
    editingConnectionProfile.value = await window.electronAPI.connections.get(connection.id)
  } catch (error: unknown) {
    const message = getErrorMessage(
      error,
      formatMessage(copy.value.readConnectionFailed, { name: connection.name })
    )
    connectionDialogError.value = message
    await showConnectionResult(
      copy.value.cannotEditConnection,
      message,
      'error',
      copy.value.close
    )
    isConnectionDialogVisible.value = false
  } finally {
    isConnectionProfileLoading.value = false
  }
}

async function saveConnection(value: ConnectionFormValue): Promise<void> {
  isConnectionSaving.value = true
  connectionDialogError.value = ''

  try {
    const previousEndpoint = editingConnection.value?.endpoint ?? null
    const savedConnection = editingConnection.value
      ? await window.electronAPI.connections.update({
          id: editingConnection.value.id,
          ...value
        })
      : await window.electronAPI.connections.create(value)

    if (previousEndpoint !== null) {
      invalidateOverview(savedConnection.id)
    }
    updateConnectionSummary(savedConnection)
    activeConnectionId.value = savedConnection.id
    isConnectionDialogVisible.value = false
    ElMessage.success(
      editingConnection.value ? copy.value.connectionUpdated : copy.value.connectionCreated
    )
  } catch (error: unknown) {
    connectionDialogError.value = getErrorMessage(
      error,
      editingConnection.value ? copy.value.updateConnectionFailed : copy.value.createConnectionFailed
    )
  } finally {
    isConnectionSaving.value = false
  }
}

async function testConnection(value: ConnectionFormValue): Promise<void> {
  const connectionName = editingConnection.value?.name ?? value.name
  isConnectionTesting.value = true
  connectionDialogError.value = ''

  try {
    const result = await window.electronAPI.connections.test({
      connectionId: editingConnection.value?.id ?? null,
      profile: value
    })
    if (!result.success) {
      await showConnectionResult(
        copy.value.connectionTestFailed,
        result.error || formatMessage(copy.value.unrecognizedCluster, { name: connectionName }),
        'error',
        copy.value.returnToEdit
      )
      return
    }

    ElMessage.success({
      message: `${copy.value.connectionTestSucceeded} · ${result.clusterName ?? '--'} · ${[result.engine, result.version].filter(Boolean).join(' ') || '--'} · ${result.latencyMs} ms`,
      duration: 3500
    })
  } catch (error: unknown) {
    await showConnectionResult(
      copy.value.connectionTestFailed,
      getErrorMessage(
        error,
        formatMessage(copy.value.testConnectionFailed, { name: connectionName })
      ),
      'error',
      copy.value.returnToEdit
    )
  } finally {
    isConnectionTesting.value = false
  }
}

async function deleteConnection(): Promise<void> {
  const connection = editingConnection.value
  if (!connection) return

  isConnectionDeleting.value = true
  connectionDialogError.value = ''

  try {
    await window.electronAPI.connections.delete(connection.id)
    invalidateOverview(connection.id)
    connections.value = connections.value.filter((item) => item.id !== connection.id)
    pruneMissingConnectionWorkspaces()
    const nextConnection = connections.value[0]
    activeConnectionId.value = ''
    if (nextConnection) activateConnection(nextConnection.id)
    isConnectionDialogVisible.value = false
    ElMessage.success(copy.value.connectionDeleted)
  } catch (error: unknown) {
    connectionDialogError.value = getErrorMessage(
      error,
      formatMessage(copy.value.deleteConnectionFailed, { name: connection.name })
    )
  } finally {
    isConnectionDeleting.value = false
  }
}

function updateConnectionSummary(updatedConnection: ConnectionSummary): void {
  const connectionIndex = connections.value.findIndex(
    (connection) => connection.id === updatedConnection.id
  )
  if (connectionIndex === -1) {
    connections.value.push(updatedConnection)
  } else {
    connections.value.splice(connectionIndex, 1, updatedConnection)
  }
  ensureConnectionWorkspace(updatedConnection)
}

async function changeConnectionState(
  connection: ConnectionSummary,
  action: 'connect' | 'disconnect',
  showResult: boolean
): Promise<void> {
  if (!connection || connectionActionId.value) return

  connectionActionId.value = connection.id
  overviewErrorByConnection.value = {
    ...overviewErrorByConnection.value,
    [connection.id]: ''
  }

  try {
    if (action === 'disconnect') {
      const disconnectedConnection = await window.electronAPI.connections.disconnect(connection.id)
      updateConnectionSummary(disconnectedConnection)
      scheduleDashboardRefresh()
      if (showResult) {
        ElMessage.success(
          formatMessage(copy.value.connectionDisconnected, { name: connection.name })
        )
      }
      return
    }

    const connectedConnection = await window.electronAPI.connections.connect(connection.id)
    updateConnectionSummary(connectedConnection)
    await refreshDashboard(connection.id)
    scheduleDashboardRefresh()
    if (showResult) {
      ElMessage.success(formatMessage(copy.value.connectionSucceeded, { name: connection.name }))
    }
  } catch (error: unknown) {
    const message = getErrorMessage(
      error,
      action === 'disconnect'
        ? formatMessage(copy.value.disconnectFailed, { name: connection.name })
        : formatMessage(copy.value.connectFailed, { name: connection.name })
    )
    overviewErrorByConnection.value = {
      ...overviewErrorByConnection.value,
      [connection.id]: message
    }
    await loadConnections(connection.id)
    await showConnectionResult(
      action === 'disconnect'
        ? copy.value.disconnectFailedTitle
        : copy.value.connectFailedTitle,
      message,
      'error',
      copy.value.close
    )
  } finally {
    connectionActionId.value = ''
  }
}

async function toggleConnection(): Promise<void> {
  const connection = activeConnection.value
  if (!connection) return
  await changeConnectionState(
    connection,
    connection.status === 'connected' ? 'disconnect' : 'connect',
    true
  )
}

function handleResourceTreeNodeClick(data: ResourceTreeItem): void {
  const resourceKinds: Partial<Record<string, ClusterResourceKind>> = {
    nodes: 'node',
    templates: 'index-template',
    'component-templates': 'component-template',
    'data-streams': 'data-stream',
    'pending-tasks': 'task',
    snapshots: 'snapshot',
    'ingest-pipeline': 'ingest-pipeline',
    scripts: 'stored-script'
  }
  const resourceKind = resourceKinds[data.id]
  if (data.id !== 'overview' && data.id !== 'indices' && data.id !== 'long-operations' && !resourceKind) return

  activeGlobalView.value = 'connections'
  if (data.id === 'overview') openDashboard()
  if (data.id === 'indices') openIndex()
  if (data.id === 'long-operations') openClusterOperations()
  if (resourceKind) openClusterResource(resourceKind, data.label)
}

function openDashboard(): void {
  const connection = activeConnection.value
  if (!connection) return
  ensureConnectionWorkspace(connection)
  activeWorkspaceTabIds.value = {
    ...activeWorkspaceTabIds.value,
    [connection.id]: getDashboardTabId(connection.id)
  }
}

function openClusterResource(resourceKind: ClusterResourceKind, title: string): void {
  const connectionId = activeConnectionId.value
  if (!connectionId) return
  clusterResourceKindsByConnection.value = {
    ...clusterResourceKindsByConnection.value,
    [connectionId]: resourceKind
  }
  const result = ensureClusterResourceWorkspaceTab(
    workspaceTabs.value,
    connectionId,
    resourceKind,
    title
  )
  workspaceTabs.value = result.tabs
  activeWorkspaceTabIds.value = { ...activeWorkspaceTabIds.value, [connectionId]: result.tab.id }
}

async function confirmClusterResourceOperation(request: ClusterResourceOperationRequest): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `${request.connectionName}\n${request.resourceName}\n${request.impactScope}`,
      request.destructive ? '确认危险操作' : '确认操作',
      { type: request.destructive ? 'warning' : 'info', confirmButtonText: '确认执行', cancelButtonText: '取消' }
    )
  } catch (error: unknown) {
    if (error === 'cancel' || error === 'close') return
    ElMessage.error(getErrorMessage(error, '确认集群资源操作失败'))
    return
  }

  try {
    const result = await window.electronAPI.clusterResources.executeOperation(request)
    ElMessage.success(result.message)
    clusterResourceRevision.value += 1
  } catch (error: unknown) {
    ElMessage.error(getErrorMessage(error, '执行集群资源操作失败'))
  }
}

function openIndex(): void {
  const connectionId = activeConnectionId.value
  if (!connectionId) return

  const tabId = `index-${connectionId}`
  if (!workspaceTabs.value.some((tab) => tab.id === tabId)) {
    workspaceTabs.value.push({
      connectionId,
      id: tabId,
      title: copy.value.indices,
      kind: 'index'
    })
  }
  activeWorkspaceTabIds.value = { ...activeWorkspaceTabIds.value, [connectionId]: tabId }
}

function openRestConsole(): void {
  const connectionId = activeConnectionId.value
  if (!connectionId) return

  activeGlobalView.value = 'connections'
  const tab = createRestConsoleWorkspaceTab(
    workspaceTabs.value,
    connectionId,
    crypto.randomUUID()
  )
  workspaceTabs.value.push(tab)
  activeWorkspaceTabIds.value = { ...activeWorkspaceTabIds.value, [connectionId]: tab.id }
}

function openClusterOperations(): void {
  const connectionId = activeConnectionId.value
  if (!connectionId) return

  const tabId = `operation-${connectionId}`
  if (!workspaceTabs.value.some((tab) => tab.id === tabId)) {
    workspaceTabs.value.push({
      connectionId,
      id: tabId,
      title: copy.value.longOperations,
      kind: 'operation'
    })
  }
  activeWorkspaceTabIds.value = { ...activeWorkspaceTabIds.value, [connectionId]: tabId }
}

function activateWorkspaceTab(tabId: string): void {
  activeWorkspaceTabIds.value = {
    ...activeWorkspaceTabIds.value,
    [activeConnectionId.value]: tabId
  }
}

function closeWorkspaceTab(tabId: string): void {
  applyWorkspaceTabCloseAction('close', tabId)
}

function openWorkspaceTabContextMenu(event: MouseEvent, tabId: string): void {
  tabContextMenuTabId.value = tabId
  tabContextMenuX.value = event.clientX
  tabContextMenuY.value = event.clientY
  tabContextMenuVisible.value = true
}

function applyWorkspaceTabCloseAction(action: AppWorkspaceTabCloseAction, targetId: string): void {
  const result = applyAppWorkspaceTabCloseAction(
    { tabs: workspaceTabs.value, activeTabIds: activeWorkspaceTabIds.value },
    action,
    targetId
  )
  workspaceTabs.value = result.tabs
  activeWorkspaceTabIds.value = result.activeTabIds
}

function closeConnectionTab(connectionId: string): void {
  const tabIndex = connectionTabs.value.findIndex((tab) => tab.connectionId === connectionId)
  if (tabIndex === -1) return

  connectionTabs.value.splice(tabIndex, 1)
  workspaceTabs.value = workspaceTabs.value.filter((tab) => tab.connectionId !== connectionId)
  const nextActiveWorkspaceTabIds = { ...activeWorkspaceTabIds.value }
  delete nextActiveWorkspaceTabIds[connectionId]
  activeWorkspaceTabIds.value = nextActiveWorkspaceTabIds

  if (activeConnectionId.value === connectionId) {
    const fallbackConnectionTab = connectionTabs.value[Math.max(0, tabIndex - 1)]
    activeConnectionId.value = ''
    if (fallbackConnectionTab) activateConnection(fallbackConnectionTab.connectionId)
  }
}

watch(activeConnectionId, applyActiveConnectionPreferences)
watch([isAutoRefreshEnabled, refreshIntervalSeconds], () => {
  scheduleDashboardRefresh()
  persistDashboardPreferences()
})
watch(
  [activeConnectionId, connectionTabs, workspaceTabs, activeWorkspaceTabIds, clusterResourceKindsByConnection, isConnectionListCollapsed, isResourceTreeCollapsed],
  persistWorkspaceState,
  { deep: true }
)
onMounted(async () => {
  window.addEventListener('keydown', handleEasterEggKeydown)
  await loadSettings()
  void checkForUpdates(true)
  await Promise.all([loadConnectionGroups(), loadConnections()])
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleEasterEggKeydown)
  persistWorkspaceState()
  if (refreshTimer !== undefined) window.clearInterval(refreshTimer)
  if (preferencesSaveTimer !== undefined) window.clearTimeout(preferencesSaveTimer)
  if (brandClickResetTimer !== undefined) window.clearTimeout(brandClickResetTimer)
})
</script>

<template>
  <div
    class="app-shell"
    :class="{
      'connection-list-collapsed': isConnectionListCollapsed,
      'resource-tree-collapsed': isResourceTreeCollapsed
    }"
  >
    <div v-if="activeEasterEggTheme" :key="activeEasterEggTheme" class="easter-egg-backdrop" aria-hidden="true" />
    <aside class="global-rail">
      <button type="button" class="rail-brand" aria-label="ES Atlas" @click="handleBrandClick">
        <img :src="appIconUrl" alt="" />
      </button>
      <el-menu :key="activeGlobalView" :default-active="activeGlobalView" class="rail-menu" @select="handleGlobalMenuSelect">
        <el-menu-item index="connections" :aria-label="copy.connections">
          <el-tooltip :content="copy.connections" placement="right"><el-icon><Connection /></el-icon></el-tooltip>
        </el-menu-item>
        <el-menu-item index="logs" :aria-label="copy.logs">
          <el-tooltip :content="copy.logs" placement="right"><el-icon><Tickets /></el-icon></el-tooltip>
        </el-menu-item>
        <el-menu-item index="trash" :aria-label="copy.trash">
          <el-tooltip :content="copy.trash" placement="right"><el-icon><Delete /></el-icon></el-tooltip>
        </el-menu-item>
        <el-menu-item index="history" :aria-label="copy.history">
          <el-tooltip :content="copy.history" placement="right"><el-icon><Timer /></el-icon></el-tooltip>
        </el-menu-item>
      </el-menu>
      <div class="rail-bottom">
        <el-dropdown
          class="rail-settings-dropdown"
          trigger="hover"
          placement="right-end"
          @command="handleSettingsMenuCommand"
        >
          <el-button text circle :aria-label="copy.settings" @click="openSettingsDialog">
            <el-icon><Setting /></el-icon>
          </el-button>
          <template #dropdown>
            <el-dropdown-menu class="rail-settings-menu">
              <el-dropdown-item command="settings">
                <el-icon><Setting /></el-icon>
                <span>{{ copy.settings }}</span>
              </el-dropdown-item>
              <el-dropdown-item command="report-issue">
                <el-icon><WarningFilled /></el-icon>
                <span>{{ copy.reportIssue }}</span>
              </el-dropdown-item>
              <el-dropdown-item command="homepage">
                <el-icon><HomeFilled /></el-icon>
                <span>{{ copy.homepage }}</span>
              </el-dropdown-item>
              <el-dropdown-item command="blog">
                <el-icon><Reading /></el-icon>
                <span>{{ copy.blog }}</span>
              </el-dropdown-item>
              <el-dropdown-item command="update-check">
                <el-icon><Refresh /></el-icon>
                <span>{{ copy.updateCheck }}</span>
              </el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
        <el-tooltip :content="copy.tools" placement="right">
          <el-button text circle :aria-label="copy.tools"><el-icon><Tools /></el-icon></el-button>
        </el-tooltip>
      </div>
    </aside>

    <aside v-show="!isConnectionListCollapsed" class="connection-list-pane">
      <div class="pane-header">
        <span>{{ copy.connections }}</span>
        <div class="pane-header-actions">
          <el-tooltip :content="copy.manageConnectionGroups" placement="bottom">
            <el-button text circle :aria-label="copy.manageConnectionGroups" @click="openGroupManager">
              <el-icon><FolderOpened /></el-icon>
            </el-button>
          </el-tooltip>
          <el-tooltip :content="copy.addConnection" placement="bottom">
            <el-button text circle :aria-label="copy.addConnection" @click="openCreateConnectionDialog">
              <el-icon><Plus /></el-icon>
            </el-button>
          </el-tooltip>
          <el-tooltip :content="copy.collapseConnectionList" placement="bottom">
            <el-button text circle :aria-label="copy.collapseConnectionList" @click="isConnectionListCollapsed = true">
              <el-icon><Fold /></el-icon>
            </el-button>
          </el-tooltip>
        </div>
      </div>
      <el-input v-model="connectionFilter" :placeholder="copy.filterConnections" clearable class="connection-filter" />
      <div v-loading="isConnectionListLoading" class="connection-list">
        <el-alert
          v-if="connectionListError"
          :title="connectionListError"
          type="error"
          :closable="false"
          show-icon
        />
        <el-button
          v-if="connectionListError"
          size="small"
          class="connection-retry"
          @click="loadConnections()"
        >
          {{ copy.reload }}
        </el-button>
        <div v-for="group in groupedConnections" :key="group.id ?? '__ungrouped__'" class="connection-group">
          <div class="connection-group-header">
            <button
              type="button"
              class="connection-group-toggle"
              :class="{ collapsed: isConnectionGroupCollapsed(group.id) }"
              :aria-label="isConnectionGroupCollapsed(group.id) ? copy.expandGroup : copy.collapseGroup"
              @click="toggleConnectionGroup(group.id)"
            >
              <el-icon><ArrowRight /></el-icon>
            </button>
            <span
              class="group-swatch"
              :class="{ 'no-color': !group.color }"
              :style="group.color ? { '--group-color': group.color } : undefined"
            />
            <span class="connection-group-name">{{ group.name }}</span>
            <span class="connection-group-count">{{ group.connections.length }}</span>
          </div>
          <div v-show="!isConnectionGroupCollapsed(group.id)" class="connection-group-items">
            <div
              v-for="connectionItem in group.connections"
              :key="connectionItem.id"
              class="connection-card"
              :class="{
                active: connectionItem.id === activeConnectionId,
                'group-accented': Boolean(group.color)
              }"
              :style="group.color ? { '--group-color': group.color } : undefined"
              role="button"
              tabindex="0"
              @click="openConnection(connectionItem)"
              @keydown.enter.prevent="openConnection(connectionItem)"
            >
              <span
                class="connection-status"
                :class="{
                  offline: connectionItem.status === 'disconnected',
                  unavailable: connectionItem.status === 'unavailable'
                }"
              />
              <span class="connection-copy">
                <el-tooltip :content="connectionItem.name" placement="right" :show-after="500">
                  <strong>{{ connectionItem.name }}</strong>
                </el-tooltip>
                <small>
                  {{ connectionItem.engine ? `${connectionItem.engine} ${connectionItem.version ?? ''}` : connectionItem.endpoint }}
                </small>
              </span>
              <el-dropdown trigger="click" placement="bottom-end" @command="(command: string) => handleConnectionCommand(command, connectionItem)">
                <el-button text circle class="connection-action" :aria-label="copy.connectionActions" @click.stop>
                  <el-icon><MoreFilled /></el-icon>
                </el-button>
                <template #dropdown>
                  <el-dropdown-menu>
                    <el-dropdown-item command="edit">{{ copy.editConnection }}</el-dropdown-item>
                    <el-dropdown-item command="move">{{ copy.moveToGroup }}</el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>
            </div>
          </div>
        </div>
        <div v-if="!isConnectionListLoading && !connectionListError && !filteredConnections.length" class="connection-empty">
          <strong>{{ connections.length ? copy.noMatchingConnections : copy.noConnections }}</strong>
          <small>{{ connections.length ? copy.adjustFilterHint : copy.addConnectionHint }}</small>
        </div>
      </div>
      <div class="pane-footer">{{ formatMessage(copy.connectionCount, { count: connections.length }) }}</div>
    </aside>

    <aside v-show="!isResourceTreeCollapsed" class="resource-tree-pane">
      <div class="breadcrumb">
        <div class="breadcrumb-path"><span>{{ copy.connections }}</span><b>/</b><strong>{{ activeConnection?.name ?? '--' }}</strong></div>
        <el-tooltip :content="copy.collapseResourceTree" placement="bottom">
          <el-button text circle class="resource-tree-toggle" :aria-label="copy.collapseResourceTree" @click="isResourceTreeCollapsed = true">
            <el-icon><Fold /></el-icon>
          </el-button>
        </el-tooltip>
      </div>
      <div class="resource-header">
        <div
          class="status-dot"
          :class="{
            offline: activeConnection?.status === 'disconnected',
            unavailable: activeConnection?.status === 'unavailable'
          }"
        />
        <div class="resource-header-copy">
          <el-tooltip :content="activeConnection?.name ?? ''" placement="right" :show-after="500">
            <strong>{{ activeConnection?.name ?? copy.noConnectionSelected }}</strong>
          </el-tooltip>
          <el-tooltip :content="activeConnection?.endpoint ?? ''" placement="right" :show-after="500">
            <small>{{ activeConnection?.endpoint ?? '--' }}</small>
          </el-tooltip>
        </div>
        <el-tooltip
          :content="activeConnection?.status === 'connected' ? copy.disconnectConnection : copy.reconnectConnection"
          placement="bottom"
        >
          <el-button
            text
            circle
            class="resource-connection-action"
            :aria-label="activeConnection?.status === 'connected' ? copy.disconnectConnection : copy.reconnectConnection"
            :loading="connectionActionId === activeConnection?.id"
            :disabled="!activeConnection"
            @click="toggleConnection"
          >
            <el-icon><SwitchButton /></el-icon>
          </el-button>
        </el-tooltip>
      </div>
      <div class="resource-tree-scroll">
        <el-tree
          v-if="activeConnection"
          :data="resourceTree"
          node-key="id"
          class="resource-tree"
          @node-click="handleResourceTreeNodeClick"
        >
          <template #default="{ node, data }">
            <span class="tree-node">
              <el-icon v-if="data.icon"><component :is="data.icon" /></el-icon>
              <span>{{ node.label }}</span>
            </span>
          </template>
        </el-tree>
      </div>
      <el-button text class="tree-console-button" :disabled="!activeConnection" @click="openRestConsole">
        <el-icon><Tools /></el-icon>{{ copy.openRestConsole }}
      </el-button>
    </aside>

    <main class="workspace" :class="{ 'global-view-active': activeGlobalView !== 'connections' }">
      <div class="workspace-tabs">
        <div v-if="isConnectionListCollapsed || isResourceTreeCollapsed" class="workspace-pane-actions">
          <el-tooltip v-if="isConnectionListCollapsed" :content="copy.expandConnectionList" placement="bottom">
            <el-button text circle :aria-label="copy.expandConnectionList" @click="isConnectionListCollapsed = false">
              <el-icon><Expand /></el-icon>
            </el-button>
          </el-tooltip>
          <el-tooltip v-if="isResourceTreeCollapsed" :content="copy.expandResourceTree" placement="bottom">
            <el-button text circle :aria-label="copy.expandResourceTree" @click="isResourceTreeCollapsed = false">
              <el-icon><Expand /></el-icon>
            </el-button>
          </el-tooltip>
        </div>
        <div class="workspace-tab-list">
          <div
            v-for="globalTab in globalTabDefinitions"
            :key="globalTab.id"
            class="workspace-tab global-workspace-tab"
            :class="{ active: activeGlobalView === globalTab.id }"
            role="tab"
            :aria-selected="activeGlobalView === globalTab.id"
          >
            <button type="button" class="tab-activate" @click="handleGlobalMenuSelect(globalTab.id)">
              <el-icon class="resource-tab-icon"><component :is="globalTab.icon" /></el-icon>
              <el-tooltip :content="copy[globalTab.title]" placement="bottom" :show-after="500">
                <span class="tab-title">{{ copy[globalTab.title] }}</span>
              </el-tooltip>
            </button>
          </div>
          <div
            v-for="connectionTab in connectionTabs"
            :key="connectionTab.connectionId"
            class="workspace-tab"
            :class="{ active: activeGlobalView === 'connections' && connectionTab.connectionId === activeConnectionId }"
            role="tab"
            :aria-selected="activeGlobalView === 'connections' && connectionTab.connectionId === activeConnectionId"
          >
            <button type="button" class="tab-activate" @click="activateConnection(connectionTab.connectionId)">
              <el-tooltip :content="connectionTab.title" placement="bottom" :show-after="500">
                <span class="tab-title">{{ connectionTab.title }}</span>
              </el-tooltip>
            </button>
            <el-tooltip :content="copy.closeConnectionTab" placement="bottom">
              <button type="button" class="tab-close" :aria-label="copy.closeConnectionTab" @click.stop="closeConnectionTab(connectionTab.connectionId)">
                <el-icon><Close /></el-icon>
              </button>
            </el-tooltip>
          </div>
        </div>
      </div>

      <div v-if="activeGlobalView === 'connections'" class="resource-tabs">
        <div class="resource-tab-list">
          <div
            v-for="workspaceTab in visibleWorkspaceTabs"
            :key="workspaceTab.id"
            class="workspace-tab resource-tab"
            :class="{ active: workspaceTab.id === activeWorkspaceTabId }"
            role="tab"
            :aria-selected="workspaceTab.id === activeWorkspaceTabId"
            @contextmenu.prevent="openWorkspaceTabContextMenu($event, workspaceTab.id)"
          >
            <button type="button" class="tab-activate" @click="activateWorkspaceTab(workspaceTab.id)">
              <el-icon class="resource-tab-icon"><component :is="workspaceTabIcons[workspaceTab.kind]" /></el-icon>
              <el-tooltip :content="workspaceTab.title" placement="bottom" :show-after="500">
                <span class="tab-title">{{ workspaceTab.title }}</span>
              </el-tooltip>
            </button>
            <el-tooltip v-if="workspaceTab.kind !== 'dashboard'" :content="copy.closePage" placement="bottom">
              <button type="button" class="tab-close" :aria-label="copy.closePage" @click.stop="closeWorkspaceTab(workspaceTab.id)">
                <el-icon><Close /></el-icon>
              </button>
            </el-tooltip>
          </div>
        </div>
      </div>
      <TabContextMenu
        v-if="tabContextMenuTab"
        v-model:visible="tabContextMenuVisible"
        :x="tabContextMenuX"
        :y="tabContextMenuY"
        :tab="tabContextMenuTab"
        :tabs="contextMenuWorkspaceTabs"
        @close="applyWorkspaceTabCloseAction('close', $event)"
        @close-others="applyWorkspaceTabCloseAction('close-others', $event)"
        @close-right="applyWorkspaceTabCloseAction('close-right', $event)"
        @close-all="applyWorkspaceTabCloseAction('close-all', $event)"
      />

      <div class="workspace-content">
        <LogPage
          v-if="activeGlobalView === 'logs'"
          :api="logsApi"
          :connection-options="logConnectionOptions"
          :language="preferencesSnapshot.global.language"
        />
        <TrashBin
          v-else-if="activeGlobalView === 'trash'"
          :language="preferencesSnapshot.global.language"
        />
        <RequestHistoryPage
          v-else-if="activeGlobalView === 'history'"
          :connection-options="logConnectionOptions"
          :language="preferencesSnapshot.global.language"
        />
        <section v-else-if="!activeConnection" class="placeholder-page workspace-empty-page">
          <el-icon><Connection /></el-icon>
          <h2>{{ copy.selectConnection }}</h2>
          <p>{{ copy.selectConnectionHint }}</p>
          <el-button type="primary" @click="openCreateConnectionDialog">{{ copy.addConnection }}</el-button>
        </section>

        <section
          v-else-if="activeTab?.kind === 'dashboard'"
          v-loading="isActiveOverviewLoading && !activeOverview"
          class="dashboard-page"
        >
          <div class="page-heading">
            <div>
              <span class="eyebrow">{{ copy.connectionDetails }}</span>
              <h1>{{ activeConnection.name }}</h1>
            </div>
            <div class="page-heading-actions">
              <el-button text circle :aria-label="copy.editConnection" @click="openEditConnectionDialog(activeConnection)">
                <el-icon><Setting /></el-icon>
              </el-button>
              <el-tag :type="getConnectionStatusType(activeConnection)" effect="plain">
                {{ getConnectionStatusText(activeConnection) }}
              </el-tag>
              <el-popover trigger="hover" placement="bottom-end" :width="244" :show-after="200" popper-class="refresh-config-popper">
                <template #reference>
                  <el-button
                    text
                    circle
                    class="dashboard-refresh"
                    :aria-label="copy.refreshClusterOverview"
                    :loading="isActiveOverviewLoading"
                    :disabled="activeConnection.status !== 'connected'"
                    @click="refreshDashboard()"
                  >
                    <el-icon><Refresh /></el-icon>
                  </el-button>
                </template>
                <div class="refresh-config">
                  <div class="refresh-config-row"><span>{{ copy.autoRefresh }}</span><el-switch v-model="isAutoRefreshEnabled" size="small" :aria-label="copy.autoRefresh" /></div>
                  <div class="refresh-config-row">
                    <span>{{ copy.refreshInterval }}</span>
                    <div class="refresh-interval-control">
                      <el-input-number v-model="refreshIntervalSeconds" :min="5" :max="3600" :step="5" :controls="false" :disabled="!isAutoRefreshEnabled" :aria-label="copy.refreshIntervalSeconds" />
                      <span>{{ copy.seconds }}</span>
                    </div>
                  </div>
                  <small>{{ formatMessage(copy.recentlyUpdated, { time: lastRefreshText }) }}</small>
                </div>
              </el-popover>
            </div>
          </div>

          <el-alert
            v-if="activeOverviewError"
            :title="activeOverviewError"
            :type="activeOverview ? 'warning' : 'error'"
            :description="activeOverview ? formatMessage(copy.retainedOverview, { time: lastRefreshText }) : undefined"
            :closable="false"
            show-icon
            class="overview-alert"
          />
          <el-alert
            v-else-if="hasStaleOverview"
            :title="copy.disconnectedStaleOverview"
            type="info"
            :closable="false"
            show-icon
            class="overview-alert"
          />

          <div v-if="!activeOverview" class="overview-empty">
            <el-icon><DataAnalysis /></el-icon>
            <strong>{{ activeConnection.status === 'connected' ? copy.fetchingOverview : copy.overviewAfterConnection }}</strong>
            <small>{{ activeConnection.lastError || copy.overviewCollectedAfterConnection }}</small>
            <el-button v-if="activeConnection.status === 'connected'" :loading="isActiveOverviewLoading" @click="refreshDashboard()">{{ copy.refreshAgain }}</el-button>
          </div>

          <template v-else>
            <section class="cluster-facts" :aria-label="copy.clusterRuntimeInfo">
              <div class="cluster-facts-heading"><span>{{ copy.runtimeInfo }}</span><small>{{ hasStaleOverview ? copy.historicalSnapshot : copy.currentConnection }}</small></div>
              <dl class="cluster-facts-grid">
                <div class="cluster-fact"><dt>{{ copy.clusterName }}</dt><dd class="mono-value" :title="activeOverview.clusterName ?? ''">{{ formatText(activeOverview.clusterName) }}</dd></div>
                <div class="cluster-fact"><dt>{{ copy.version }}</dt><dd>{{ formatText([activeOverview.engine, activeOverview.version].filter(Boolean).join(' ')) }}</dd></div>
                <div class="cluster-fact"><dt>{{ copy.uptime }}</dt><dd>{{ formatText(activeOverview.uptime) }}</dd></div>
                <div class="cluster-fact"><dt>JVM</dt><dd class="mono-value">{{ formatText(activeOverview.jvmVersion) }}</dd></div>
                <div class="cluster-fact"><dt>{{ copy.nodeRoles }}</dt><dd class="mono-value" :title="activeOverview.nodeRoles ?? ''">{{ formatText(activeOverview.nodeRoles) }}</dd></div>
                <div class="cluster-fact"><dt>{{ copy.clusterUuid }}</dt><dd class="mono-value" :title="activeOverview.clusterUuid ?? ''">{{ formatText(activeOverview.clusterUuid) }}</dd></div>
              </dl>
            </section>
            <div class="metric-grid">
              <div class="metric-card health-card" :class="`health-${activeOverview.health}`">
                <span>{{ copy.clusterHealth }}</span><strong class="health-value"><i class="health-indicator" />{{ getClusterHealthText(activeOverview.health) }}</strong>
                <small>{{ activeOverview.health.toUpperCase() }} · {{ formatMessage(copy.unassigned, { count: formatMetric(activeOverview.unassignedShards) }) }}</small>
              </div>
              <div class="metric-card"><span>{{ copy.nodeStatus }}</span><strong>{{ formatMetric(activeOverview.nodesOnline) }} / {{ formatMetric(activeOverview.nodesTotal) }}</strong><small>{{ formatMessage(copy.masterNode, { name: formatText(activeOverview.masterNode) }) }}</small></div>
              <div class="metric-card"><span>{{ copy.activeShards }}</span><strong>{{ formatMetric(activeOverview.activeShards) }}</strong><small>{{ formatMessage(copy.unassigned, { count: formatMetric(activeOverview.unassignedShards) }) }}</small></div>
              <div class="metric-card" :class="{ warning: (activeOverview.writeRejected ?? 0) > 0 }"><span>{{ copy.searchP95 }}</span><strong>{{ formatMetric(activeOverview.searchP95Ms, ' ms') }}</strong><small>{{ formatMessage(copy.writeRejected, { count: formatMetric(activeOverview.writeRejected) }) }}</small></div>
            </div>
            <div class="content-grid">
              <el-card shadow="never" class="request-activity-card">
                <template #header><div class="card-heading"><span>{{ copy.requestMetrics }}</span><small>{{ copy.currentSnapshot }}</small></div></template>
                <div class="request-summary">
                  <div><span>{{ copy.searchQps }}</span><strong>{{ formatMetric(activeOverview.searchQps) }}</strong></div>
                  <div><span>{{ copy.writeQps }}</span><strong>{{ formatMetric(activeOverview.writeQps) }}</strong></div>
                  <div><span>{{ copy.errorRate }}</span><strong>{{ formatMetric(activeOverview.errorRate, '%') }}</strong></div>
                </div>
                <div v-if="hasRequestTrend" class="request-chart" aria-hidden="true">
                  <span v-for="bucket in activeOverview.requestTrend" :key="bucket.startedAt" class="request-bar-pair">
                    <i class="search-bar" :style="{ height: getRequestTrendHeight(bucket.searchCount) }" />
                    <i class="write-bar" :style="{ height: getRequestTrendHeight(bucket.writeCount) }" />
                  </span>
                </div>
                <div v-else class="chart-empty">{{ copy.noFakeRequestTrend }}</div>
                <div class="chart-legend">
                  <span>{{ copy.searchQps }}</span>
                  <span class="write-legend">{{ copy.writeQps }}</span>
                </div>
              </el-card>
              <el-card shadow="never" class="resource-pressure-card">
                <template #header><div class="card-heading"><span>{{ copy.resourcePressure }}</span><small>{{ copy.nodePeak }}</small></div></template>
                <div class="progress-line"><span>CPU</span><el-progress :percentage="activeOverview.cpuUsage ?? 0" :show-text="false" color="#218b69" /><b>{{ formatMetric(activeOverview.cpuUsage, '%') }}</b></div>
                <div class="progress-line"><span>{{ copy.jvmHeap }}</span><el-progress :percentage="activeOverview.heapUsage ?? 0" :show-text="false" color="#c98220" /><b>{{ formatMetric(activeOverview.heapUsage, '%') }}</b></div>
                <div class="progress-line"><span>{{ copy.disk }}</span><el-progress :percentage="activeOverview.diskUsage ?? 0" :show-text="false" color="#367fb5" /><b>{{ formatMetric(activeOverview.diskUsage, '%') }}</b></div>
                <dl class="resource-meta">
                  <div><dt>{{ copy.highestPressureNode }}</dt><dd>{{ formatText(activeOverview.pressureNode) }}</dd></div>
                  <div><dt>{{ copy.gcDuration }}</dt><dd>{{ formatText(activeOverview.gcDuration) }}</dd></div>
                </dl>
              </el-card>
            </div>
            <el-card shadow="never" class="risk-card">
              <template #header><div class="card-heading"><span>{{ copy.currentRisks }}</span><small>{{ formatMessage(copy.riskCount, { count: activeOverview.risks.length }) }}</small></div></template>
              <div class="risk-list">
                <div v-for="risk in activeOverview.risks" :key="risk.id" class="risk-item">
                  <el-tag :type="risk.level" effect="plain" size="small">{{ risk.label }}</el-tag>
                  <div class="risk-copy"><strong>{{ risk.title }}</strong><small>{{ risk.detail }}</small></div>
                </div>
                <div v-if="!activeOverview.risks.length" class="risk-empty">
                  <span class="status-dot" />
                  <div><strong>{{ copy.noCurrentRisks }}</strong><small>{{ copy.noCurrentRisksHint }}</small></div>
                </div>
              </div>
            </el-card>
            <el-card shadow="never" class="recent-card">
              <template #header>
                <div class="card-heading">
                  <span>{{ copy.recentRequests }}</span>
                  <div class="recent-heading-actions">
                    <small>{{ copy.recordedByApp }}</small>
                    <el-button text size="small" @click="openRequestHistory(activeConnectionId)">{{ copy.allRequests }}</el-button>
                  </div>
                </div>
              </template>
              <el-table :data="activeRecentRequests" size="small" :empty-text="copy.noRequestRecords">
                <el-table-column :label="copy.source" width="72">
                  <template #default="{ row }">{{ formatRequestSource(row) }}</template>
                </el-table-column>
                <el-table-column prop="method" :label="copy.method" width="68" />
                <el-table-column prop="path" :label="copy.path" class-name="request-path" />
                <el-table-column :label="copy.status" width="168">
                  <template #default="{ row }"><el-tag :type="row.successful ? 'success' : 'danger'" effect="plain" size="small">{{ formatRequestStatus(row) }}</el-tag></template>
                </el-table-column>
                <el-table-column :label="copy.duration" width="86"><template #default="{ row }"><span :class="{ 'duration-warning': row.durationMs >= 1000 }">{{ row.durationMs }} ms</span></template></el-table-column>
                <el-table-column width="42" align="center">
                  <template #default><el-tooltip :content="copy.goToRestConsole" placement="left"><el-button text circle class="request-open" :aria-label="copy.goToRestConsole" @click="openRestConsole"><el-icon><ArrowRight /></el-icon></el-button></el-tooltip></template>
                </el-table-column>
              </el-table>
            </el-card>
          </template>
        </section>
        <IndexBrowser
          v-else-if="activeTab?.kind === 'index'"
          :connection-id="activeConnection.id"
          :connected="activeConnection.status === 'connected'"
          :default-query-size="activeDefaultQuerySize"
          :language="preferencesSnapshot.global.language"
        />
        <RestConsole
          v-else-if="activeTab?.kind === 'rest'"
          :key="activeTab.id"
          :connection-id="activeConnection.id"
          :tab-id="activeTab.id"
          :connected="activeConnection.status === 'connected'"
          :read-only="activeConnection.readOnly"
          :language="preferencesSnapshot.global.language"
        />
        <ClusterResourceManager
          v-else-if="activeTab?.kind === 'cluster-resource'"
          :key="`${activeConnection.id}-${activeClusterResourceKind}-${clusterResourceRevision}`"
          :connection-id="activeConnection.id"
          :connection-name="activeConnection.name"
          :connected="activeConnection.status === 'connected'"
          :read-only="activeConnection.readOnly"
          :resource-kind="activeClusterResourceKind"
          :api="clusterResourcesApi"
          :language="preferencesSnapshot.global.language"
          @confirm-operation="confirmClusterResourceOperation"
        />
        <ClusterOperationPage
          v-else-if="activeTab?.kind === 'operation'"
          :connection-id="activeConnection.id"
          :connection-name="activeConnection.name"
          :connected="activeConnection.status === 'connected'"
          :api="operationsApi"
          :language="preferencesSnapshot.global.language"
        />
      </div>
    </main>

    <ConnectionDialog
      v-model:visible="isConnectionDialogVisible"
      :connection="editingConnection"
      :profile="editingConnectionProfile"
      :loading="isConnectionProfileLoading"
      :saving="isConnectionSaving"
      :testing="isConnectionTesting"
      :deleting="isConnectionDeleting"
      :error="connectionDialogError"
      :language="preferencesSnapshot.global.language"
      @submit="saveConnection"
      @test="testConnection"
      @delete="deleteConnection"
    />
    <ConnectionGroupManagerDialog
      v-model:visible="isGroupManagerVisible"
      :groups="connectionGroups"
      :member-counts="connectionGroupMemberCounts"
      :busy="isGroupActionBusy"
      :error="groupActionError"
      :language="preferencesSnapshot.global.language"
      @create="createConnectionGroup"
      @update="updateConnectionGroup"
      @delete="deleteConnectionGroup"
    />
    <MoveConnectionDialog
      v-model:visible="isMoveConnectionDialogVisible"
      :connection="movingConnection"
      :groups="connectionGroups"
      :busy="isGroupActionBusy"
      :error="groupActionError"
      :language="preferencesSnapshot.global.language"
      @move="moveConnection"
    />
    <SettingsDialog
      v-model:visible="isSettingsDialogVisible"
      :snapshot="preferencesSnapshot"
      :connections="connections"
      :active-connection-id="activeConnectionId"
      :busy="isSettingsSaving || isSettingsLoading"
      :error="settingsError"
      @save="saveSettings"
      @reset="resetSettings"
    />
    <RequestHistoryDialog
      v-model:visible="isRequestHistoryVisible"
      :initial-connection-id="requestHistoryConnectionId"
      :connection-options="connections.map((connection) => ({ id: connection.id, name: connection.name }))"
      :language="preferencesSnapshot.global.language"
    />
  </div>
</template>
