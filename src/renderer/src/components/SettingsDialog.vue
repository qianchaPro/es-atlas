<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  Bell,
  Check,
  Close,
  Connection,
  Document,
  InfoFilled,
  RefreshLeft,
  Setting
} from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { ConnectionSummary } from '../../../shared/types/connection'
import type {
  DesktopConfigurationResult,
  LocalDiagnosticSummary,
  UpdateCheckResult
} from '../../../shared/types/diagnostics'
import {
  DEFAULT_CONNECTION_PREFERENCES,
  DEFAULT_GLOBAL_PREFERENCES,
  MAX_DEFAULT_QUERY_SIZE,
  MAX_FONT_SIZE,
  MAX_REFRESH_INTERVAL_SECONDS,
  MIN_DEFAULT_QUERY_SIZE,
  MIN_FONT_SIZE,
  MIN_REFRESH_INTERVAL_SECONDS,
  PREFERENCES_VERSION,
  type AppLanguage,
  type ConnectionPreferences,
  type PreferencesSnapshot,
  type SavePreferencesInput
} from '../../../shared/types/settings'

type SettingsSection = 'general' | 'connection' | 'privacy' | 'about'

const props = defineProps<{
  visible: boolean
  snapshot: PreferencesSnapshot
  connections: ConnectionSummary[]
  activeConnectionId: string
  busy: boolean
  error: string
}>()

const emit = defineEmits<{
  'update:visible': [visible: boolean]
  save: [input: SavePreferencesInput]
  reset: []
}>()

const messages = {
  'zh-CN': {
    title: '设置',
    subtitle: 'ES ATLAS PREFERENCES',
    general: '常规',
    connection: '连接偏好',
    privacy: '更新与隐私',
    about: '关于',
    appearance: '外观与语言',
    theme: '主题',
    themeLight: '浅色',
    themeDark: '深色',
    themeStarlight: '星空',
    themePixel: '像素游戏',
    language: '语言',
    chinese: '简体中文',
    english: 'English',
    fontFamily: '界面字体',
    fontPlaceholder: '输入或选择字体族',
    fontSize: '字号',
    density: '界面密度',
    densityCompact: '紧凑',
    densityStandard: '标准',
    densityComfortable: '宽松',
    selectConnection: '目标连接',
    noConnections: '暂无可配置的连接',
    noConnectionsHint: '创建连接后，可在此设置该连接的刷新和查询默认值。',
    autoRefresh: '自动刷新',
    autoRefreshHint: '进入集群视图后按固定间隔刷新概览数据。',
    refreshInterval: '刷新间隔',
    seconds: '秒',
    querySize: '默认查询条数',
    querySizeHint: '作为新查询的默认 size，不会改写已保存的查询。',
    workspaceRestore: '工作区恢复',
    workspaceRestoreHint: '重新打开应用时恢复上次访问的连接和页面。',
    homepageUrl: '产品首页地址',
    homepageUrlHint: '用于设置菜单中的“产品首页”入口。',
    homepageUrlPlaceholder: 'https://ideaatlas.online/esAtlas',
    atlasAdminBaseUrl: 'Atlas Admin 地址',
    atlasAdminBaseUrlHint: '用于读取桌面配置与默认更新清单。线上服务通过 HTTPS 域名访问。',
    atlasAdminBaseUrlPlaceholder: 'https://ideaatlas.online/prod-api',
    manifestUrl: 'Manifest URL',
    manifestUrlHint: '可选。填写后优先使用此地址检查更新。',
    manifestUrlPlaceholder: 'https://admin.example.com/manifest.json',
    remoteConfiguration: '桌面远程配置',
    remoteConfigurationHint: '由主进程读取 Atlas Admin 的公开 desktop-config，不会向 Elasticsearch 集群发送数据。',
    loadRemoteConfiguration: '读取配置',
    configurationLoaded: '已读取 {count} 个顶层配置项',
    updateCheck: '手动检查更新',
    updateCheckHint: '检查版本并提供安装包下载地址，不会自动安装或重启应用。',
    checkNow: '立即检查',
    downloadUpdate: '下载更新',
    downloadUpdateFailed: '打开更新下载地址失败',
    updateCheckNetworkFailed: '检查更新失败，网络连接失败',
    onlineUpdateQuestion: '发现新版本 {version}，是否在线更新？',
    latestVersion: '当前已是最新版：{version}',
    availableVersion: '发现新版本：{version}',
    localDiagnostic: '本地诊断摘要',
    localDiagnosticHint: '仅在本机生成版本、平台、错误码和追踪 ID，不上传数据。',
    generateSummary: '生成摘要',
    applicationVersion: '应用版本',
    platform: '运行平台',
    errorCode: '错误码',
    traceId: '追踪 ID',
    noTraceId: '无',
    product: 'ES Atlas',
    productDescription: 'Elasticsearch 与 OpenSearch 桌面管理工具',
    preferencesFormat: '偏好设置格式',
    localStorage: '本地持久化',
    localStorageHint: '设置保存在当前设备，不会发送到集群。',
    reset: '恢复默认',
    cancel: '取消',
    save: '保存',
    discardTitle: '放弃未保存的更改？',
    discardMessage: '当前设置尚未保存，关闭后这些更改会丢失。',
    discardConfirm: '放弃更改',
    continueEditing: '继续编辑',
    resetTitle: '恢复默认设置？',
    resetMessage: '这会清除全部全局设置和连接偏好，并恢复默认值。',
    resetConfirm: '恢复默认',
    invalidFont: '界面字体不能为空'
  },
  'en-US': {
    title: 'Settings',
    subtitle: 'ES ATLAS PREFERENCES',
    general: 'General',
    connection: 'Connection preferences',
    privacy: 'Updates & privacy',
    about: 'About',
    appearance: 'Appearance & language',
    theme: 'Theme',
    themeLight: 'Light',
    themeDark: 'Dark',
    themeStarlight: 'Starlight',
    themePixel: 'Pixel game',
    language: 'Language',
    chinese: '简体中文',
    english: 'English',
    fontFamily: 'Interface font',
    fontPlaceholder: 'Enter or select a font family',
    fontSize: 'Font size',
    density: 'Interface density',
    densityCompact: 'Compact',
    densityStandard: 'Standard',
    densityComfortable: 'Comfortable',
    selectConnection: 'Connection',
    noConnections: 'No connections available',
    noConnectionsHint: 'Create a connection to configure its refresh and query defaults.',
    autoRefresh: 'Auto refresh',
    autoRefreshHint: 'Refresh cluster overview data at a fixed interval.',
    refreshInterval: 'Refresh interval',
    seconds: 'sec',
    querySize: 'Default query size',
    querySizeHint: 'Used for new queries without changing saved queries.',
    workspaceRestore: 'Workspace restore',
    workspaceRestoreHint: 'Restore the last connection and page when the app reopens.',
    homepageUrl: 'Product home URL',
    homepageUrlHint: 'Used by the Product home entry in the settings menu.',
    homepageUrlPlaceholder: 'https://ideaatlas.online/esAtlas',
    atlasAdminBaseUrl: 'Atlas Admin URL',
    atlasAdminBaseUrlHint: 'Loads desktop configuration and the default update manifest over HTTPS.',
    atlasAdminBaseUrlPlaceholder: 'https://ideaatlas.online/prod-api',
    manifestUrl: 'Manifest URL',
    manifestUrlHint: 'Optional. When set, this URL takes priority for update checks.',
    manifestUrlPlaceholder: 'https://admin.example.com/manifest.json',
    remoteConfiguration: 'Remote desktop configuration',
    remoteConfigurationHint: 'The main process reads the public desktop-config endpoint. Nothing is sent to an Elasticsearch cluster.',
    loadRemoteConfiguration: 'Load configuration',
    configurationLoaded: 'Loaded {count} top-level configuration items',
    updateCheck: 'Manual update check',
    updateCheckHint: 'Checks the version and provides an installer URL. It will not install or restart automatically.',
    checkNow: 'Check now',
    downloadUpdate: 'Download update',
    downloadUpdateFailed: 'Failed to open update download',
    updateCheckNetworkFailed: 'Update check failed: network connection failed',
    onlineUpdateQuestion: 'Version {version} is available. Update online now?',
    latestVersion: 'You are up to date: {version}',
    availableVersion: 'New version available: {version}',
    localDiagnostic: 'Local diagnostic summary',
    localDiagnosticHint: 'Generate only version, platform, error code, and trace ID locally. No data is uploaded.',
    generateSummary: 'Generate summary',
    applicationVersion: 'App version',
    platform: 'Platform',
    errorCode: 'Error code',
    traceId: 'Trace ID',
    noTraceId: 'None',
    product: 'ES Atlas',
    productDescription: 'Desktop management for Elasticsearch and OpenSearch',
    preferencesFormat: 'Preferences format',
    localStorage: 'Local persistence',
    localStorageHint: 'Settings remain on this device and are never sent to a cluster.',
    reset: 'Reset defaults',
    cancel: 'Cancel',
    save: 'Save',
    discardTitle: 'Discard unsaved changes?',
    discardMessage: 'Your current settings have not been saved and will be lost.',
    discardConfirm: 'Discard changes',
    continueEditing: 'Keep editing',
    resetTitle: 'Reset all settings?',
    resetMessage: 'This clears global and connection preferences and restores defaults.',
    resetConfirm: 'Reset defaults',
    invalidFont: 'Interface font cannot be empty'
  }
} satisfies Record<AppLanguage, Record<string, string>>

const fontOptions = [
  {
    label: 'Avenir Next / PingFang SC',
    value: '"Avenir Next", "PingFang SC", "Microsoft YaHei", sans-serif'
  },
  { label: 'PingFang SC', value: '"PingFang SC", "Microsoft YaHei", sans-serif' },
  { label: 'Microsoft YaHei', value: '"Microsoft YaHei", sans-serif' },
  { label: 'System UI', value: 'system-ui, sans-serif' }
]

const activeSection = ref<SettingsSection>('general')
const selectedConnectionId = ref('')
const draft = ref<SavePreferencesInput>(createDraft(props.snapshot, props.connections))
const baseline = ref(serializeDraft(draft.value))
const localDiagnostic = ref<LocalDiagnosticSummary | null>(null)
const diagnosticsError = ref('')
const isGeneratingDiagnostic = ref(false)
const desktopConfiguration = ref<DesktopConfigurationResult | null>(null)
const updateCheckResult = ref<UpdateCheckResult | null>(null)
const isLoadingDesktopConfiguration = ref(false)
const isCheckingUpdate = ref(false)

const copy = computed(() => messages[draft.value.global.language])
const isDirty = computed(() => serializeDraft(draft.value) !== baseline.value)
const hasInvalidFont = computed(() => !draft.value.global.fontFamily.trim())
const canSave = computed(() => isDirty.value && !hasInvalidFont.value && !props.busy)
const selectedConnection = computed(() =>
  props.connections.find((connection) => connection.id === selectedConnectionId.value) ?? null
)
const selectedConnectionPreferences = computed<ConnectionPreferences | null>(() => {
  if (!selectedConnectionId.value) return null
  return draft.value.connections[selectedConnectionId.value] ?? null
})

watch(
  () => [props.visible, props.snapshot] as const,
  ([visible, snapshot]) => {
    if (!visible) return
    const nextDraft = createDraft(snapshot, props.connections)
    draft.value = nextDraft
    baseline.value = serializeDraft(nextDraft)
    selectedConnectionId.value = resolveSelectedConnectionId(
      props.connections,
      props.activeConnectionId
    )
    localDiagnostic.value = null
    diagnosticsError.value = ''
    isGeneratingDiagnostic.value = false
    desktopConfiguration.value = null
    updateCheckResult.value = null
    isLoadingDesktopConfiguration.value = false
    isCheckingUpdate.value = false
    activeSection.value = 'general'
  },
  { immediate: true }
)

function createDraft(
  snapshot: PreferencesSnapshot,
  connections: ConnectionSummary[]
): SavePreferencesInput {
  const connectionPreferences: Record<string, ConnectionPreferences> = Object.fromEntries(
    Object.entries(snapshot.connections).map(([connectionId, preferences]) => [
      connectionId,
      { ...preferences }
    ])
  )

  for (const connection of connections) {
    if (!connectionPreferences[connection.id]) {
      connectionPreferences[connection.id] = { ...DEFAULT_CONNECTION_PREFERENCES }
    }
  }

  return {
    global: {
      ...snapshot.global,
      unlockedEasterEggThemes: [...snapshot.global.unlockedEasterEggThemes]
    },
    connections: connectionPreferences
  }
}

function resolveSelectedConnectionId(
  connections: ConnectionSummary[],
  activeConnectionId: string
): string {
  if (connections.some((connection) => connection.id === activeConnectionId)) {
    return activeConnectionId
  }
  return connections[0]?.id ?? ''
}

function serializeDraft(value: SavePreferencesInput): string {
  return JSON.stringify(value)
}

function createSaveInput(): SavePreferencesInput {
  return {
    global: {
      ...draft.value.global,
      unlockedEasterEggThemes: [...draft.value.global.unlockedEasterEggThemes],
      fontFamily: draft.value.global.fontFamily.trim()
    },
    connections: Object.fromEntries(
      Object.entries(draft.value.connections).map(([connectionId, preferences]) => [
        connectionId,
        { ...preferences }
      ])
    )
  }
}

async function confirmDiscard(): Promise<boolean> {
  if (!isDirty.value) return true
  try {
    await ElMessageBox.confirm(copy.value.discardMessage, copy.value.discardTitle, {
      type: 'warning',
      confirmButtonText: copy.value.discardConfirm,
      cancelButtonText: copy.value.continueEditing
    })
    return true
  } catch {
    return false
  }
}

async function requestClose(): Promise<void> {
  if (props.busy || !(await confirmDiscard())) return
  emit('update:visible', false)
}

async function beforeClose(done: () => void): Promise<void> {
  if (props.busy || !(await confirmDiscard())) return
  emit('update:visible', false)
  done()
}

async function requestReset(): Promise<void> {
  if (props.busy) return
  try {
    await ElMessageBox.confirm(copy.value.resetMessage, copy.value.resetTitle, {
      type: 'warning',
      confirmButtonText: copy.value.resetConfirm,
      cancelButtonText: copy.value.cancel
    })
  } catch {
    return
  }
  emit('reset')
}

function saveSettings(): void {
  if (!canSave.value) return
  emit('save', createSaveInput())
}

async function generateLocalDiagnostic(): Promise<void> {
  if (isGeneratingDiagnostic.value) return
  diagnosticsError.value = ''
  isGeneratingDiagnostic.value = true
  try {
    localDiagnostic.value = await window.electronAPI.diagnostics.createLocalSummary({
      errorCode: 'MANUAL_DIAGNOSTIC'
    })
  } catch (error: unknown) {
    diagnosticsError.value = getErrorMessage(error)
  } finally {
    isGeneratingDiagnostic.value = false
  }
}

async function loadDesktopConfiguration(): Promise<void> {
  if (isLoadingDesktopConfiguration.value) return
  diagnosticsError.value = ''
  desktopConfiguration.value = null
  isLoadingDesktopConfiguration.value = true
  try {
    const result = await window.electronAPI.diagnostics.loadDesktopConfiguration({
      atlasAdminBaseUrl: draft.value.global.atlasAdminBaseUrl || DEFAULT_GLOBAL_PREFERENCES.atlasAdminBaseUrl
    })
    desktopConfiguration.value = result
    ElMessage.success(formatMessage(copy.value.configurationLoaded, {
      count: Object.keys(result.configuration).length
    }))
  } catch (error: unknown) {
    diagnosticsError.value = getErrorMessage(error)
  } finally {
    isLoadingDesktopConfiguration.value = false
  }
}

async function checkForUpdates(): Promise<void> {
  if (isCheckingUpdate.value) return
  diagnosticsError.value = ''
  updateCheckResult.value = null
  isCheckingUpdate.value = true
  try {
    const result = await window.electronAPI.diagnostics.checkForUpdates({
      manifestUrl: draft.value.global.updateManifestUrl,
      atlasAdminBaseUrl: draft.value.global.atlasAdminBaseUrl || DEFAULT_GLOBAL_PREFERENCES.atlasAdminBaseUrl
    })
    updateCheckResult.value = result
    const template = result.status === 'available'
      ? copy.value.availableVersion
      : copy.value.latestVersion
    ElMessage.success(formatMessage(template, {
      version: result.latestVersion ?? result.currentVersion
    }))
    if (result.status === 'available' && result.downloadUrl) {
      try {
        await ElMessageBox.confirm(
          formatMessage(copy.value.onlineUpdateQuestion, {
            version: result.latestVersion ?? result.currentVersion
          }),
          copy.value.updateCheck,
          { confirmButtonText: copy.value.downloadUpdate, cancelButtonText: copy.value.cancel }
        )
        await openUpdateDownload()
      } catch (error: unknown) {
        if (error !== 'cancel' && error !== 'close') {
          diagnosticsError.value = error instanceof Error ? error.message : copy.value.downloadUpdateFailed
        }
      }
    }
  } catch (error: unknown) {
    diagnosticsError.value = copy.value.updateCheckNetworkFailed
  } finally {
    isCheckingUpdate.value = false
  }
}

async function openUpdateDownload(): Promise<void> {
  const downloadUrl = updateCheckResult.value?.downloadUrl
  if (!downloadUrl) return
  try {
    await window.electronAPI.openExternal(downloadUrl)
  } catch (error: unknown) {
    diagnosticsError.value = error instanceof Error ? error.message : copy.value.downloadUpdateFailed
  }
}

function formatMessage(template: string, values: Record<string, string | number>): string {
  return Object.entries(values).reduce(
    (message, [key, value]) => message.replace(`{${key}}`, String(value)),
    template
  )
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
</script>

<template>
  <el-dialog
    :model-value="visible"
    width="min(880px, calc(100vw - 48px))"
    class="settings-dialog"
    :before-close="beforeClose"
    :close-on-click-modal="false"
    :close-on-press-escape="!busy"
    :show-close="!busy"
    align-center
  >
    <template #header>
      <div class="settings-heading">
        <span class="settings-emblem"><el-icon><Setting /></el-icon></span>
        <div>
          <small>{{ copy.subtitle }}</small>
          <strong>{{ copy.title }}</strong>
        </div>
      </div>
    </template>

    <div v-loading="busy" class="settings-layout">
      <nav class="settings-navigation" :aria-label="copy.title">
        <button
          type="button"
          :class="{ active: activeSection === 'general' }"
          :aria-current="activeSection === 'general' ? 'page' : undefined"
          @click="activeSection = 'general'"
        >
          <el-icon><Setting /></el-icon>
          <span>{{ copy.general }}</span>
        </button>
        <button
          type="button"
          :class="{ active: activeSection === 'connection' }"
          :aria-current="activeSection === 'connection' ? 'page' : undefined"
          @click="activeSection = 'connection'"
        >
          <el-icon><Connection /></el-icon>
          <span>{{ copy.connection }}</span>
        </button>
        <button
          type="button"
          :class="{ active: activeSection === 'privacy' }"
          :aria-current="activeSection === 'privacy' ? 'page' : undefined"
          @click="activeSection = 'privacy'"
        >
          <el-icon><Bell /></el-icon>
          <span>{{ copy.privacy }}</span>
        </button>
        <button
          type="button"
          :class="{ active: activeSection === 'about' }"
          :aria-current="activeSection === 'about' ? 'page' : undefined"
          @click="activeSection = 'about'"
        >
          <el-icon><InfoFilled /></el-icon>
          <span>{{ copy.about }}</span>
        </button>
      </nav>

      <main class="settings-content">
        <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />

        <section v-if="activeSection === 'general'" class="settings-section">
          <header>
            <h2>{{ copy.general }}</h2>
            <span>{{ copy.appearance }}</span>
          </header>

          <div class="settings-field">
            <label>{{ copy.theme }}</label>
            <el-radio-group v-model="draft.global.theme" class="theme-selector">
              <el-radio-button value="light">
                <span class="theme-option"><i class="theme-swatch light" />{{ copy.themeLight }}</span>
              </el-radio-button>
              <el-radio-button value="dark">
                <span class="theme-option"><i class="theme-swatch dark" />{{ copy.themeDark }}</span>
              </el-radio-button>
              <el-radio-button
                v-if="draft.global.unlockedEasterEggThemes.includes('starlight')"
                value="starlight"
              >
                <span class="theme-option"><i class="theme-swatch starlight" />{{ copy.themeStarlight }}</span>
              </el-radio-button>
              <el-radio-button
                v-if="draft.global.unlockedEasterEggThemes.includes('pixel')"
                value="pixel"
              >
                <span class="theme-option"><i class="theme-swatch pixel" />{{ copy.themePixel }}</span>
              </el-radio-button>
            </el-radio-group>
          </div>

          <div class="settings-field">
            <label>{{ copy.language }}</label>
            <el-radio-group v-model="draft.global.language">
              <el-radio-button value="zh-CN">{{ copy.chinese }}</el-radio-button>
              <el-radio-button value="en-US">{{ copy.english }}</el-radio-button>
            </el-radio-group>
          </div>

          <div class="settings-field">
            <label for="settings-font-family">{{ copy.fontFamily }}</label>
            <div class="field-control">
              <el-select
                id="settings-font-family"
                v-model="draft.global.fontFamily"
                filterable
                allow-create
                default-first-option
                :placeholder="copy.fontPlaceholder"
              >
                <el-option
                  v-for="option in fontOptions"
                  :key="option.value"
                  :label="option.label"
                  :value="option.value"
                />
              </el-select>
              <span v-if="hasInvalidFont" class="field-error">{{ copy.invalidFont }}</span>
            </div>
          </div>

          <div class="settings-field">
            <label>{{ copy.fontSize }}</label>
            <el-input-number
              v-model="draft.global.fontSize"
              :min="MIN_FONT_SIZE"
              :max="MAX_FONT_SIZE"
              controls-position="right"
            />
          </div>

          <div class="settings-field">
            <label>{{ copy.density }}</label>
            <el-radio-group v-model="draft.global.density">
              <el-radio-button value="compact">{{ copy.densityCompact }}</el-radio-button>
              <el-radio-button value="standard">{{ copy.densityStandard }}</el-radio-button>
              <el-radio-button value="comfortable">{{ copy.densityComfortable }}</el-radio-button>
            </el-radio-group>
          </div>
        </section>

        <section v-else-if="activeSection === 'connection'" class="settings-section">
          <header>
            <h2>{{ copy.connection }}</h2>
            <span v-if="selectedConnection">{{ selectedConnection.endpoint }}</span>
          </header>

          <template v-if="connections.length && selectedConnectionPreferences">
            <div class="settings-field">
              <label for="settings-connection">{{ copy.selectConnection }}</label>
              <el-select id="settings-connection" v-model="selectedConnectionId">
                <el-option
                  v-for="connectionItem in connections"
                  :key="connectionItem.id"
                  :label="connectionItem.name"
                  :value="connectionItem.id"
                >
                  <span class="connection-option-name">{{ connectionItem.name }}</span>
                  <span class="connection-option-endpoint">{{ connectionItem.endpoint }}</span>
                </el-option>
              </el-select>
            </div>

            <div class="settings-switch-row">
              <div>
                <strong>{{ copy.autoRefresh }}</strong>
                <span>{{ copy.autoRefreshHint }}</span>
              </div>
              <el-switch
                v-model="selectedConnectionPreferences.autoRefreshEnabled"
                size="small"
                class="settings-auto-refresh-switch"
              />
            </div>

            <div class="settings-field">
              <label>{{ copy.refreshInterval }}</label>
              <div class="number-control">
                <el-input-number
                  v-model="selectedConnectionPreferences.refreshIntervalSeconds"
                  :min="MIN_REFRESH_INTERVAL_SECONDS"
                  :max="MAX_REFRESH_INTERVAL_SECONDS"
                  :disabled="!selectedConnectionPreferences.autoRefreshEnabled"
                  controls-position="right"
                />
                <span>{{ copy.seconds }}</span>
              </div>
            </div>

            <div class="settings-field align-start">
              <label>{{ copy.querySize }}</label>
              <div class="field-control">
                <el-input-number
                  v-model="selectedConnectionPreferences.defaultQuerySize"
                  :min="MIN_DEFAULT_QUERY_SIZE"
                  :max="MAX_DEFAULT_QUERY_SIZE"
                  controls-position="right"
                />
                <span class="field-help">{{ copy.querySizeHint }}</span>
              </div>
            </div>
          </template>

          <div v-else class="settings-empty-state">
            <el-icon><Connection /></el-icon>
            <strong>{{ copy.noConnections }}</strong>
            <span>{{ copy.noConnectionsHint }}</span>
          </div>
        </section>

        <section v-else-if="activeSection === 'privacy'" class="settings-section">
          <header><h2>{{ copy.privacy }}</h2></header>

          <el-alert
            v-if="diagnosticsError"
            :title="diagnosticsError"
            type="error"
            :closable="false"
            show-icon
            class="diagnostics-alert"
          />

          <div class="privacy-operation">
            <div class="privacy-operation-heading">
              <div>
                <strong>{{ copy.updateCheck }}</strong>
                <span>{{ copy.updateCheckHint }}</span>
                <span v-if="updateCheckResult">
                  {{ updateCheckResult.status === 'available'
                    ? formatMessage(copy.availableVersion, { version: updateCheckResult.latestVersion ?? updateCheckResult.currentVersion })
                    : formatMessage(copy.latestVersion, { version: updateCheckResult.latestVersion ?? updateCheckResult.currentVersion }) }}
                </span>
              </div>
              <el-button
                :loading="isCheckingUpdate"
                @click="checkForUpdates"
              >
                {{ copy.checkNow }}
              </el-button>
              <el-button
                v-if="updateCheckResult?.status === 'available' && updateCheckResult.downloadUrl"
                @click="openUpdateDownload"
              >
                {{ copy.downloadUpdate }}
              </el-button>
            </div>
          </div>

          <div class="planned-row">
            <div>
              <strong>{{ copy.workspaceRestore }}</strong>
              <span>{{ copy.workspaceRestoreHint }}</span>
            </div>
            <el-switch v-model="draft.global.workspaceRestoreEnabled" size="small" />
          </div>
          <div class="privacy-operation">
            <div class="privacy-operation-heading">
              <div>
                <strong>{{ copy.localDiagnostic }}</strong>
                <span>{{ copy.localDiagnosticHint }}</span>
              </div>
              <el-tooltip :content="copy.generateSummary" placement="top">
                <el-button
                  text
                  circle
                  :icon="Document"
                  :loading="isGeneratingDiagnostic"
                  :aria-label="copy.generateSummary"
                  @click="generateLocalDiagnostic"
                />
              </el-tooltip>
            </div>
            <dl v-if="localDiagnostic" class="diagnostic-details">
              <div><dt>{{ copy.applicationVersion }}</dt><dd>{{ localDiagnostic.applicationVersion }}</dd></div>
              <div><dt>{{ copy.platform }}</dt><dd>{{ localDiagnostic.platform }}</dd></div>
              <div><dt>{{ copy.errorCode }}</dt><dd>{{ localDiagnostic.errorCode }}</dd></div>
              <div><dt>{{ copy.traceId }}</dt><dd>{{ localDiagnostic.traceId ?? copy.noTraceId }}</dd></div>
            </dl>
          </div>
        </section>

        <section v-else class="settings-section about-section">
          <header><h2>{{ copy.about }}</h2></header>
          <div class="about-product">
            <span class="about-mark">ES</span>
            <div>
              <strong>{{ copy.product }}</strong>
              <span>{{ copy.productDescription }}</span>
            </div>
          </div>
          <dl class="about-details">
            <div>
              <dt>{{ copy.preferencesFormat }}</dt>
              <dd>v{{ PREFERENCES_VERSION }}</dd>
            </div>
            <div>
              <dt>{{ copy.localStorage }}</dt>
              <dd>{{ copy.localStorageHint }}</dd>
            </div>
          </dl>
        </section>
      </main>
    </div>

    <template #footer>
      <div class="settings-footer">
        <el-button
          :icon="RefreshLeft"
          :disabled="busy"
          @click="requestReset"
        >
          {{ copy.reset }}
        </el-button>
        <div>
          <el-button :icon="Close" :disabled="busy" @click="requestClose">{{ copy.cancel }}</el-button>
          <el-button
            type="primary"
            :icon="Check"
            :loading="busy"
            :disabled="!canSave"
            @click="saveSettings"
          >
            {{ copy.save }}
          </el-button>
        </div>
      </div>
    </template>
  </el-dialog>
</template>

<style scoped>
:global(.settings-dialog) {
  --settings-nav-width: 190px;
  overflow: hidden;
  border: 1px solid var(--color-line);
  border-radius: var(--radius-medium);
  background: var(--color-panel);
  box-shadow: 0 18px 48px rgb(32 38 45 / 18%);
}

:global(.settings-dialog .el-dialog__header) {
  margin: 0;
  padding: 14px 18px;
  border-bottom: 1px solid var(--color-line);
}

:global(.settings-dialog .el-dialog__headerbtn) {
  top: 12px;
  right: 12px;
}

:global(.settings-dialog .el-dialog__body) {
  padding: 0;
}

:global(.settings-dialog .el-dialog__footer) {
  padding: 12px 18px;
  border-top: 1px solid var(--color-line);
}

.settings-heading {
  display: flex;
  align-items: center;
  gap: 11px;
  min-height: 34px;
}

.settings-emblem {
  display: grid;
  width: 32px;
  height: 32px;
  flex: 0 0 auto;
  place-items: center;
  border: 1px solid #f1bbb2;
  border-radius: var(--radius-small);
  background: var(--color-accent-soft);
  color: var(--color-accent);
}

.settings-heading > div {
  display: grid;
  gap: 2px;
}

.settings-heading small {
  color: var(--color-text-muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 9px;
  line-height: 1;
}

.settings-heading strong {
  color: var(--color-text);
  font-size: 15px;
  line-height: 1.25;
}

.settings-layout {
  display: grid;
  grid-template-columns: var(--settings-nav-width) minmax(0, 1fr);
  height: min(560px, calc(100vh - 190px));
  min-height: 420px;
  overflow: hidden;
}

.settings-navigation {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 3px;
  padding: 14px 10px;
  border-right: 1px solid var(--color-line);
  background: var(--color-panel-muted);
}

.settings-navigation button {
  display: grid;
  grid-template-columns: 20px minmax(0, 1fr);
  gap: 9px;
  align-items: center;
  width: 100%;
  min-height: 36px;
  padding: 7px 10px;
  border: 0;
  border-radius: var(--radius-small);
  background: transparent;
  color: var(--color-text-secondary);
  text-align: left;
  cursor: pointer;
}

.settings-navigation button:hover {
  background: var(--color-panel);
  color: var(--color-text);
}

.settings-navigation button.active {
  background: var(--color-accent-soft);
  color: var(--color-accent);
  font-weight: 700;
}

.settings-navigation button span {
  min-width: 0;
  overflow-wrap: anywhere;
}

.settings-content {
  min-width: 0;
  overflow: auto;
}

.settings-content > .el-alert {
  margin: 16px 22px 0;
}

.settings-section {
  display: grid;
  gap: 0;
  padding: 22px 26px 32px;
}

.settings-section > header {
  display: grid;
  gap: 4px;
  margin-bottom: 18px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--color-line);
}

.settings-section h2 {
  margin: 0;
  color: var(--color-text);
  font-size: 16px;
  line-height: 1.3;
}

.settings-section header span {
  overflow: hidden;
  color: var(--color-text-muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.settings-field {
  display: grid;
  grid-template-columns: 148px minmax(0, 1fr);
  gap: 18px;
  align-items: center;
  min-height: 58px;
  padding: 9px 0;
  border-bottom: 1px solid var(--color-line);
}

.settings-field.align-start {
  align-items: start;
}

.settings-field > label {
  color: var(--color-text-secondary);
  font-size: 12px;
  font-weight: 700;
}

.settings-field .el-select {
  width: 100%;
}

.theme-selector {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  width: 100%;
}

:deep(.theme-selector .el-radio-button) {
  width: 100%;
}

:deep(.theme-selector .el-radio-button__inner) {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--color-line) !important;
  border-radius: var(--radius-small) !important;
  box-shadow: none !important;
  text-align: left;
}

.theme-option {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 8px;
  overflow-wrap: anywhere;
}

.theme-swatch {
  width: 14px;
  height: 14px;
  flex: 0 0 auto;
  border: 1px solid rgb(138 148 158 / 55%);
  border-radius: 3px;
}

.theme-swatch.light {
  background: #f4f6f8;
}

.theme-swatch.dark {
  background: #1d232a;
}

.theme-swatch.starlight {
  background:
    radial-gradient(circle at 72% 28%, #ffffff 0 1px, transparent 1.5px),
    linear-gradient(145deg, #070b16, #18304a);
}

.theme-swatch.pixel {
  background: conic-gradient(#ffcc4d 25%, #1f2f25 0 50%, #70d6d2 0 75%, #111713 0);
  background-size: 7px 7px;
}

.field-control {
  display: grid;
  gap: 6px;
  min-width: 0;
}

.field-error {
  color: var(--color-danger);
  font-size: 11px;
}

.field-help {
  color: var(--color-text-muted);
  font-size: 11px;
  line-height: 1.5;
}

.number-control {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--color-text-muted);
  font-size: 11px;
}

.settings-switch-row,
.planned-row {
  display: flex;
  gap: 16px;
  align-items: center;
  min-height: 70px;
  padding: 13px 0;
  border-bottom: 1px solid var(--color-line);
}

.settings-switch-row > div,
.planned-row > div {
  display: grid;
  min-width: 0;
  flex: 1;
  gap: 4px;
}

.settings-switch-row strong,
.planned-row strong {
  color: var(--color-text);
  font-size: 12px;
}

.settings-switch-row span,
.planned-row div span {
  color: var(--color-text-muted);
  font-size: 11px;
  line-height: 1.5;
}

.planned-row > .el-tag {
  flex: 0 0 auto;
}

.diagnostics-alert {
  margin-bottom: 8px;
}

.privacy-operation {
  display: grid;
  gap: 12px;
  padding: 17px 0;
  border-bottom: 1px solid var(--color-line);
}

.privacy-operation-heading {
  display: flex;
  gap: 16px;
  align-items: center;
}

.privacy-operation-heading > div {
  display: grid;
  min-width: 0;
  flex: 1;
  gap: 4px;
}

.privacy-operation-heading strong {
  color: var(--color-text);
  font-size: 12px;
}

.privacy-operation-heading span {
  color: var(--color-text-muted);
  font-size: 11px;
  line-height: 1.5;
}

.diagnostic-details {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 1px;
  margin: 0;
  overflow: hidden;
  border: 1px solid var(--color-line);
  border-radius: var(--radius-small);
  background: var(--color-line);
}

.diagnostic-details > div {
  display: grid;
  min-width: 0;
  gap: 3px;
  padding: 9px 11px;
  background: var(--color-panel-muted);
}

.diagnostic-details dt {
  color: var(--color-text-muted);
  font-size: 10px;
}

.diagnostic-details dd {
  margin: 0;
  overflow-wrap: anywhere;
  color: var(--color-text-secondary);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 10px;
}

.connection-option-name {
  float: left;
}

.connection-option-endpoint {
  float: right;
  max-width: 58%;
  overflow: hidden;
  color: var(--color-text-muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.settings-empty-state {
  display: grid;
  justify-items: center;
  gap: 8px;
  padding: 64px 24px;
  color: var(--color-text-muted);
  text-align: center;
}

.settings-empty-state .el-icon {
  font-size: 28px;
}

.settings-empty-state strong {
  color: var(--color-text-secondary);
  font-size: 13px;
}

.settings-empty-state span {
  max-width: 360px;
  font-size: 11px;
  line-height: 1.6;
}

.about-product {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 12px 0 22px;
}

.about-mark {
  display: grid;
  width: 48px;
  height: 48px;
  flex: 0 0 auto;
  place-items: center;
  border-radius: var(--radius-small);
  background: var(--color-accent);
  color: #ffffff;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 14px;
  font-weight: 800;
}

.about-product > div {
  display: grid;
  gap: 4px;
}

.about-product strong {
  color: var(--color-text);
  font-size: 16px;
}

.about-product div span {
  color: var(--color-text-muted);
  font-size: 11px;
}

.about-details {
  margin: 0;
  border-top: 1px solid var(--color-line);
}

.about-details > div {
  display: grid;
  grid-template-columns: 148px minmax(0, 1fr);
  gap: 18px;
  padding: 15px 0;
  border-bottom: 1px solid var(--color-line);
}

.about-details dt {
  color: var(--color-text-secondary);
  font-size: 12px;
  font-weight: 700;
}

.about-details dd {
  margin: 0;
  color: var(--color-text-muted);
  font-size: 11px;
  line-height: 1.5;
}

.settings-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.settings-footer > div {
  display: flex;
  gap: 8px;
}

.settings-footer .el-button + .el-button {
  margin-left: 0;
}

:global(.settings-dialog .el-input-number) {
  width: 148px;
}

:global(.settings-dialog .el-switch) {
  --el-switch-on-color: var(--color-accent);
}

:global(.settings-dialog .settings-switch-row > .settings-auto-refresh-switch) {
  --el-switch-width: 44px;
  display: inline-flex;
  width: 44px;
  min-width: 44px;
  flex: 0 0 44px;
  gap: 0;
}

:global(.settings-dialog .planned-row > .el-switch) {
  --el-switch-width: 44px;
  display: inline-flex;
  width: 44px;
  min-width: 44px;
  flex: 0 0 44px;
  gap: 0;
}

:global(.settings-dialog .settings-auto-refresh-switch .el-switch__core),
:global(.settings-dialog .planned-row > .el-switch .el-switch__core) {
  width: 44px;
  min-width: 44px;
}

@media (max-width: 720px) {
  :global(.settings-dialog) {
    --settings-nav-width: 52px;
  }

  .settings-navigation {
    padding-inline: 7px;
  }

  .settings-navigation button {
    display: grid;
    grid-template-columns: 1fr;
    justify-items: center;
    padding-inline: 6px;
  }

  .settings-navigation button span {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  .settings-section {
    padding-inline: 18px;
  }

  .settings-field {
    grid-template-columns: 1fr;
    gap: 8px;
  }

  .about-details > div {
    grid-template-columns: 1fr;
    gap: 6px;
  }

  .privacy-operation-heading {
    align-items: stretch;
    flex-direction: column;
  }

  .diagnostic-details {
    grid-template-columns: 1fr;
  }
}
</style>
