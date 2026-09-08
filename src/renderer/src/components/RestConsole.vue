<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { CircleClose, Clock, Delete, MagicStick, RefreshLeft, Star, VideoPlay } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type {
  RestApi,
  RestExecuteResult,
  RestRequestMethod,
  RestRequestState
} from '../../../shared/types/rest'
import {
  addRestRequestHistory,
  clearRestRequestHistory,
  isRestRequestFavorite,
  readRestConsoleDraft,
  readRestRequestFavorites,
  readRestRequestHistory,
  toggleRestRequestFavorite,
  writeRestConsoleDraft,
  type RestConsoleDraft,
  type RestSavedRequest
} from './rest-console-storage'

const props = defineProps<{
  connectionId: string
  tabId: string
  connected: boolean
  readOnly: boolean
  language: string
}>()

const messages = {
  'zh-CN': {
    requestPath: '请求路径',
    requestBody: '请求体',
    response: '响应',
    execute: '执行请求',
    cancel: '取消请求',
    clear: '清空响应',
    formatJson: '格式化 JSON',
    noResponse: '尚未执行请求',
    disconnected: '当前连接尚未建立，不能执行 REST 请求。',
    readOnly: '当前连接为只读模式，仅允许执行 GET 请求。',
    apiUnavailable: 'REST API 尚未完成主进程接线',
    invalidJson: '请求体不是有效 JSON',
    contextMismatch: 'REST 响应上下文与当前标签不匹配，结果已拒绝回填',
    cancelFailed: '取消 REST 请求失败',
    requestFailed: '执行 REST 请求失败',
    draft: '草稿',
    running: '执行中',
    success: '成功',
    failed: '失败',
    canceled: '已取消',
    timedOut: '超时',
    statusCode: '状态码',
    duration: '耗时',
    dataFormat: '格式',
    responseHeaders: '响应 Header',
    requestLibrary: '请求历史与收藏',
    history: '历史',
    favorites: '收藏',
    favorite: '收藏当前请求',
    unfavorite: '取消收藏',
    reload: '载入',
    clearHistory: '清空历史',
    clearHistoryConfirm: '确认清空当前连接的本地 REST 请求历史？',
    noHistory: '暂无本地请求历史',
    noFavorites: '暂无收藏请求',
    storageFailed: 'REST 本地数据处理失败',
    loaded: '请求已载入',
    bodySavedLocally: '请求体仅保存在当前设备'
  },
  'en-US': {
    requestPath: 'Request path',
    requestBody: 'Request body',
    response: 'Response',
    execute: 'Execute request',
    cancel: 'Cancel request',
    clear: 'Clear response',
    formatJson: 'Format JSON',
    noResponse: 'No request executed',
    disconnected: 'The current connection is not connected.',
    readOnly: 'This connection is read-only. Only GET requests are allowed.',
    apiUnavailable: 'The REST API has not been wired to the main process',
    invalidJson: 'The request body is not valid JSON',
    contextMismatch: 'The REST response does not belong to the current tab and was rejected',
    cancelFailed: 'Failed to cancel the REST request',
    requestFailed: 'Failed to execute the REST request',
    draft: 'Draft',
    running: 'Running',
    success: 'Success',
    failed: 'Failed',
    canceled: 'Canceled',
    timedOut: 'Timed out',
    statusCode: 'Status',
    duration: 'Duration',
    dataFormat: 'Format',
    responseHeaders: 'Response headers',
    requestLibrary: 'Request history and favorites',
    history: 'History',
    favorites: 'Favorites',
    favorite: 'Favorite current request',
    unfavorite: 'Remove favorite',
    reload: 'Load',
    clearHistory: 'Clear history',
    clearHistoryConfirm: 'Clear local REST request history for this connection?',
    noHistory: 'No local request history',
    noFavorites: 'No favorite requests',
    storageFailed: 'Failed to process local REST data',
    loaded: 'Request loaded',
    bodySavedLocally: 'Request bodies remain on this device'
  }
} as const

type RestWindow = Window & {
  electronAPI: {
    rest?: RestApi
  }
}

const methods: RestRequestMethod[] = ['GET', 'POST', 'PUT', 'DELETE']
const requestMethod = ref<RestRequestMethod>('GET')
const requestPath = ref('/_cluster/health?pretty=true')
const requestBody = ref('')
const requestState = ref<RestRequestState>('draft')
const result = ref<RestExecuteResult | null>(null)
const transportError = ref('')
const activeRequestId = ref<string | null>(null)
const isCanceling = ref(false)
const requestLibraryVisible = ref(false)
const requestLibraryTab = ref<'history' | 'favorites'>('history')
const requestHistory = ref<RestSavedRequest[]>([])
const requestFavorites = ref<RestSavedRequest[]>([])
const storageError = ref('')
let draftSaveTimer: number | undefined
let isRestoringDraft = false

const isEnglish = computed(() => props.language.toLowerCase().startsWith('en'))
const copy = computed(() => messages[isEnglish.value ? 'en-US' : 'zh-CN'])
const isRunning = computed(() => requestState.value === 'running')
const isWriteBlocked = computed(() => props.readOnly && requestMethod.value !== 'GET')
const canExecute = computed(() =>
  props.connected &&
  !isRunning.value &&
  !isWriteBlocked.value &&
  Boolean(requestPath.value.trim())
)
const stateLabel = computed(() => {
  const labels: Record<RestRequestState, string> = {
    draft: copy.value.draft,
    running: copy.value.running,
    success: copy.value.success,
    failed: copy.value.failed,
    canceled: copy.value.canceled,
    'timed-out': copy.value.timedOut
  }
  return labels[requestState.value]
})
const stateTagType = computed<'info' | 'warning' | 'success' | 'danger'>(() => {
  if (requestState.value === 'success') return 'success'
  if (requestState.value === 'failed') return 'danger'
  if (requestState.value === 'running' || requestState.value === 'timed-out') return 'warning'
  return 'info'
})
const responseText = computed(() => {
  if (!result.value || result.value.body === null || result.value.body === undefined) return ''
  if (typeof result.value.body === 'string') return result.value.body
  try {
    return JSON.stringify(result.value.body, null, 2)
  } catch {
    return String(result.value.body)
  }
})
const displayedError = computed(() => transportError.value || result.value?.error?.message || '')
const currentDraft = computed<RestConsoleDraft>(() => ({
  method: requestMethod.value,
  path: requestPath.value,
  body: requestBody.value
}))
const currentRequestIsFavorite = computed(() =>
  isRestRequestFavorite(requestFavorites.value, currentDraft.value)
)

watch([requestMethod, requestPath, requestBody], () => {
  if (!isRunning.value) requestState.value = 'draft'
  if (!isRestoringDraft) scheduleDraftSave()
}, { flush: 'sync' })

watch(
  () => [props.connectionId, props.tabId] as const,
  () => {
    cancelActiveRequest()
    result.value = null
    transportError.value = ''
    requestState.value = 'draft'
    loadLocalState()
  },
  { immediate: true }
)

onBeforeUnmount(() => {
  cancelActiveRequest()
  if (draftSaveTimer !== undefined) window.clearTimeout(draftSaveTimer)
  persistDraft()
})

function getRestApi(): RestApi {
  const api = (window as unknown as RestWindow).electronAPI.rest
  if (!api) throw new Error(copy.value.apiUnavailable)
  return api
}

function loadLocalState(): void {
  if (draftSaveTimer !== undefined) {
    window.clearTimeout(draftSaveTimer)
    draftSaveTimer = undefined
  }
  storageError.value = ''
  isRestoringDraft = true
  try {
    const draft = readRestConsoleDraft(window.localStorage, props.connectionId, props.tabId) ?? {
      method: 'GET' as const,
      path: '/_cluster/health?pretty=true',
      body: ''
    }
    requestMethod.value = draft.method
    requestPath.value = draft.path
    requestBody.value = draft.body
    requestHistory.value = readRestRequestHistory(window.localStorage, props.connectionId)
    requestFavorites.value = readRestRequestFavorites(window.localStorage, props.connectionId)
  } catch (error: unknown) {
    storageError.value = getErrorMessage(error, copy.value.storageFailed)
  } finally {
    isRestoringDraft = false
  }
}

function scheduleDraftSave(): void {
  if (draftSaveTimer !== undefined) window.clearTimeout(draftSaveTimer)
  draftSaveTimer = window.setTimeout(() => {
    draftSaveTimer = undefined
    persistDraft()
  }, 250)
}

function persistDraft(): void {
  if (!props.connectionId || !props.tabId) return
  try {
    writeRestConsoleDraft(
      window.localStorage,
      props.connectionId,
      props.tabId,
      currentDraft.value
    )
    storageError.value = ''
  } catch (error: unknown) {
    storageError.value = getErrorMessage(error, copy.value.storageFailed)
  }
}

function createSavedRequest(): RestSavedRequest {
  return {
    id: crypto.randomUUID(),
    ...currentDraft.value,
    savedAt: new Date().toISOString()
  }
}

function recordRequestHistory(): void {
  try {
    requestHistory.value = addRestRequestHistory(
      window.localStorage,
      props.connectionId,
      createSavedRequest()
    )
  } catch (error: unknown) {
    storageError.value = getErrorMessage(error, copy.value.storageFailed)
  }
}

function toggleCurrentFavorite(): void {
  try {
    const result = toggleRestRequestFavorite(
      window.localStorage,
      props.connectionId,
      createSavedRequest()
    )
    requestFavorites.value = result.favorites
  } catch (error: unknown) {
    storageError.value = getErrorMessage(error, copy.value.storageFailed)
  }
}

function removeFavorite(request: RestSavedRequest): void {
  try {
    requestFavorites.value = toggleRestRequestFavorite(
      window.localStorage,
      props.connectionId,
      request
    ).favorites
  } catch (error: unknown) {
    storageError.value = getErrorMessage(error, copy.value.storageFailed)
  }
}

function loadSavedRequest(request: RestSavedRequest): void {
  isRestoringDraft = true
  requestMethod.value = request.method
  requestPath.value = request.path
  requestBody.value = request.body
  isRestoringDraft = false
  clearResponse()
  persistDraft()
  requestLibraryVisible.value = false
  ElMessage.success(copy.value.loaded)
}

async function clearHistory(): Promise<void> {
  try {
    await ElMessageBox.confirm(copy.value.clearHistoryConfirm, copy.value.clearHistory, {
      type: 'warning',
      confirmButtonText: copy.value.clearHistory,
      cancelButtonText: copy.value.cancel
    })
  } catch (error: unknown) {
    if (error === 'cancel' || error === 'close') return
    storageError.value = getErrorMessage(error, copy.value.storageFailed)
    return
  }
  try {
    clearRestRequestHistory(window.localStorage, props.connectionId)
    requestHistory.value = []
  } catch (error: unknown) {
    storageError.value = getErrorMessage(error, copy.value.storageFailed)
  }
}

function formatSavedAt(value: string): string {
  return new Date(value).toLocaleString(props.language, { hour12: false })
}

async function executeRequest(): Promise<void> {
  if (!canExecute.value) return
  const requestId = crypto.randomUUID()
  activeRequestId.value = requestId
  requestState.value = 'running'
  transportError.value = ''
  result.value = null
  recordRequestHistory()

  try {
    const executionResult = await getRestApi().execute({
      requestId,
      connectionId: props.connectionId,
      tabId: props.tabId,
      request: {
        method: requestMethod.value,
        path: requestPath.value,
        body: requestBody.value || null
      }
    })
    if (activeRequestId.value !== requestId) return
    if (
      executionResult.requestId !== requestId ||
      executionResult.connectionId !== props.connectionId ||
      executionResult.tabId !== props.tabId
    ) {
      requestState.value = 'failed'
      transportError.value = copy.value.contextMismatch
      return
    }
    result.value = executionResult
    requestState.value = executionResult.state
  } catch (error: unknown) {
    if (activeRequestId.value !== requestId) return
    requestState.value = 'failed'
    transportError.value = getErrorMessage(error, copy.value.requestFailed)
  } finally {
    if (activeRequestId.value === requestId) activeRequestId.value = null
  }
}

async function cancelRequest(): Promise<void> {
  const requestId = activeRequestId.value
  if (!requestId || isCanceling.value) return
  isCanceling.value = true
  try {
    await getRestApi().cancel({ requestId })
  } catch (error: unknown) {
    transportError.value = getErrorMessage(error, copy.value.cancelFailed)
  } finally {
    isCanceling.value = false
  }
}

function cancelActiveRequest(): void {
  const requestId = activeRequestId.value
  activeRequestId.value = null
  if (!requestId) return
  try {
    void getRestApi().cancel({ requestId }).catch(() => undefined)
  } catch {
    // 组件销毁或切换标签时不再回填错误，活动请求结果会被 requestId 守卫丢弃。
  }
}

function formatRequestBody(): void {
  if (!requestBody.value.trim()) return
  try {
    requestBody.value = JSON.stringify(JSON.parse(requestBody.value), null, 2)
  } catch (error: unknown) {
    ElMessage.error(getErrorMessage(error, copy.value.invalidJson))
  }
}

function clearResponse(): void {
  if (isRunning.value) return
  result.value = null
  transportError.value = ''
  requestState.value = 'draft'
}

function handleShortcut(event: KeyboardEvent): void {
  if (event.key !== 'Enter' || (!event.metaKey && !event.ctrlKey)) return
  event.preventDefault()
  void executeRequest()
}

function getErrorMessage(error: unknown, context: string): string {
  if (error instanceof Error && error.message) return `${context}：${error.message}`
  return context
}
</script>

<template>
  <section class="rest-console" @keydown="handleShortcut">
    <header class="rest-request-bar">
      <el-select v-model="requestMethod" class="method-select" :disabled="isRunning" aria-label="HTTP method">
        <el-option v-for="method in methods" :key="method" :label="method" :value="method" />
      </el-select>
      <el-input
        v-model="requestPath"
        class="path-input"
        :placeholder="copy.requestPath"
        :disabled="isRunning"
        spellcheck="false"
      />
      <el-tooltip :content="copy.execute">
        <el-button
          circle
          type="primary"
          :icon="VideoPlay"
          :disabled="!canExecute"
          :loading="isRunning && !isCanceling"
          :aria-label="copy.execute"
          @click="executeRequest"
        />
      </el-tooltip>
      <el-tooltip :content="copy.cancel">
        <el-button
          circle
          :icon="CircleClose"
          :disabled="!isRunning"
          :loading="isCanceling"
          :aria-label="copy.cancel"
          @click="cancelRequest"
        />
      </el-tooltip>
      <el-tooltip :content="currentRequestIsFavorite ? copy.unfavorite : copy.favorite">
        <el-button
          circle
          :type="currentRequestIsFavorite ? 'primary' : undefined"
          :icon="Star"
          :disabled="isRunning || !requestPath.trim()"
          :aria-label="currentRequestIsFavorite ? copy.unfavorite : copy.favorite"
          @click="toggleCurrentFavorite"
        />
      </el-tooltip>
      <el-tooltip :content="copy.requestLibrary">
        <el-button
          circle
          :icon="Clock"
          :aria-label="copy.requestLibrary"
          @click="requestLibraryVisible = true"
        />
      </el-tooltip>
      <el-tag :type="stateTagType" effect="plain" class="request-state">{{ stateLabel }}</el-tag>
    </header>

    <el-alert
      v-if="!connected"
      :title="copy.disconnected"
      type="warning"
      :closable="false"
      show-icon
      class="rest-alert"
    />
    <el-alert
      v-else-if="isWriteBlocked"
      :title="copy.readOnly"
      type="warning"
      :closable="false"
      show-icon
      class="rest-alert"
    />
    <el-alert
      v-if="storageError"
      :title="storageError"
      type="error"
      :closable="false"
      show-icon
      class="rest-alert"
    />

    <div class="rest-panels">
      <section class="rest-panel request-panel">
        <header class="panel-heading">
          <strong>{{ copy.requestBody }}</strong>
          <el-tooltip :content="copy.formatJson">
            <el-button
              text
              circle
              :icon="MagicStick"
              :disabled="isRunning || !requestBody.trim()"
              :aria-label="copy.formatJson"
              @click="formatRequestBody"
            />
          </el-tooltip>
        </header>
        <el-input
          v-model="requestBody"
          type="textarea"
          class="code-editor"
          :disabled="isRunning"
          :autosize="false"
          resize="none"
          spellcheck="false"
          aria-label="JSON request body"
        />
      </section>

      <section class="rest-panel response-panel">
        <header class="panel-heading response-heading">
          <strong>{{ copy.response }}</strong>
          <dl v-if="result" class="response-facts">
            <div><dt>{{ copy.statusCode }}</dt><dd>{{ result.statusCode ?? '--' }}</dd></div>
            <div><dt>{{ copy.duration }}</dt><dd>{{ result.durationMs }} ms</dd></div>
            <div><dt>{{ copy.dataFormat }}</dt><dd>{{ result.dataFormat ?? '--' }}</dd></div>
          </dl>
          <el-tooltip :content="copy.clear">
            <el-button
              text
              circle
              :icon="Delete"
              :disabled="isRunning || (!result && !displayedError)"
              :aria-label="copy.clear"
              @click="clearResponse"
            />
          </el-tooltip>
        </header>
        <div class="response-content">
          <el-alert
            v-if="displayedError"
            :title="displayedError"
            :type="requestState === 'timed-out' ? 'warning' : 'error'"
            :closable="false"
            show-icon
            class="response-error"
          />
          <pre v-if="responseText" class="response-code">{{ responseText }}</pre>
          <el-empty v-else-if="!displayedError" :description="copy.noResponse" :image-size="64" />
          <dl v-if="result?.headers.length" class="response-headers">
            <dt>{{ copy.responseHeaders }}</dt>
            <dd v-for="header in result.headers" :key="header.name">
              <code>{{ header.name }}</code><span>{{ header.value }}</span>
            </dd>
          </dl>
        </div>
      </section>
    </div>

    <el-drawer
      v-model="requestLibraryVisible"
      :title="copy.requestLibrary"
      size="min(620px, 88vw)"
      append-to-body
    >
      <el-tabs v-model="requestLibraryTab" class="request-library-tabs">
        <el-tab-pane :label="`${copy.history} (${requestHistory.length})`" name="history">
          <div class="request-library-heading">
            <small>{{ copy.bodySavedLocally }}</small>
            <el-button
              text
              type="danger"
              :icon="Delete"
              :disabled="requestHistory.length === 0"
              @click="clearHistory"
            >{{ copy.clearHistory }}</el-button>
          </div>
          <div v-if="requestHistory.length" class="saved-request-list">
            <div v-for="request in requestHistory" :key="request.id" class="saved-request-row">
              <el-tag effect="plain" size="small">{{ request.method }}</el-tag>
              <div class="saved-request-copy">
                <code>{{ request.path }}</code>
                <small>{{ formatSavedAt(request.savedAt) }}</small>
              </div>
              <el-tooltip :content="copy.reload">
                <el-button
                  text
                  circle
                  :icon="RefreshLeft"
                  :aria-label="copy.reload"
                  @click="loadSavedRequest(request)"
                />
              </el-tooltip>
            </div>
          </div>
          <el-empty v-else :description="copy.noHistory" :image-size="56" />
        </el-tab-pane>
        <el-tab-pane :label="`${copy.favorites} (${requestFavorites.length})`" name="favorites">
          <div class="request-library-heading">
            <small>{{ copy.bodySavedLocally }}</small>
          </div>
          <div v-if="requestFavorites.length" class="saved-request-list">
            <div v-for="request in requestFavorites" :key="request.id" class="saved-request-row">
              <el-tag effect="plain" size="small">{{ request.method }}</el-tag>
              <div class="saved-request-copy">
                <code>{{ request.path }}</code>
                <small>{{ formatSavedAt(request.savedAt) }}</small>
              </div>
              <el-tooltip :content="copy.reload">
                <el-button
                  text
                  circle
                  :icon="RefreshLeft"
                  :aria-label="copy.reload"
                  @click="loadSavedRequest(request)"
                />
              </el-tooltip>
              <el-tooltip :content="copy.unfavorite">
                <el-button
                  text
                  circle
                  type="danger"
                  :icon="Delete"
                  :aria-label="copy.unfavorite"
                  @click="removeFavorite(request)"
                />
              </el-tooltip>
            </div>
          </div>
          <el-empty v-else :description="copy.noFavorites" :image-size="56" />
        </el-tab-pane>
      </el-tabs>
    </el-drawer>
  </section>
</template>

<style scoped>
.rest-console {
  container-type: inline-size;
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--color-panel);
}

.rest-request-bar {
  display: grid;
  grid-template-columns: 108px minmax(220px, 1fr) repeat(4, 32px) auto;
  min-height: 54px;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--color-line);
  background: var(--color-panel-muted);
}

.request-library-heading {
  display: flex;
  min-height: 36px;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  color: var(--el-text-color-secondary);
}

.saved-request-list {
  display: flex;
  min-width: 0;
  flex-direction: column;
}

.saved-request-row {
  display: grid;
  min-width: 0;
  min-height: 58px;
  grid-template-columns: 64px minmax(0, 1fr) 32px 32px;
  align-items: center;
  gap: 8px;
  border-bottom: 1px solid var(--el-border-color-lighter);
}

.saved-request-copy {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 4px;
}

.saved-request-copy code {
  overflow: hidden;
  color: var(--el-text-color-primary);
  font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.saved-request-copy small {
  color: var(--el-text-color-secondary);
}

.method-select,
.path-input {
  width: 100%;
}

.method-select :deep(.el-select__wrapper),
.path-input :deep(.el-input__wrapper) {
  font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
}

.request-state {
  justify-self: end;
  min-width: 64px;
  text-align: center;
}

.rest-alert {
  border-radius: 0;
}

.rest-panels {
  display: grid;
  flex: 1;
  grid-template-columns: minmax(300px, 0.88fr) minmax(360px, 1.12fr);
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.rest-panel {
  display: grid;
  grid-template-rows: 42px minmax(0, 1fr);
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--color-panel);
}

.request-panel {
  border-right: 1px solid var(--color-line);
}

.panel-heading {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 8px;
  padding: 0 10px 0 14px;
  border-bottom: 1px solid var(--color-line);
  color: var(--color-text-secondary);
  background: var(--color-panel-muted);
  font-size: 12px;
}

.panel-heading strong {
  color: var(--color-text);
  font-weight: 650;
}

.panel-heading > .el-button {
  margin-left: auto;
}

.code-editor {
  height: 100%;
}

.code-editor :deep(.el-textarea__inner) {
  height: 100%;
  min-height: 100% !important;
  padding: 14px 16px;
  border: 0;
  border-radius: 0;
  box-shadow: none;
  color: var(--color-text);
  background: var(--color-panel);
  font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
  font-size: 12px;
  line-height: 1.65;
  tab-size: 2;
}

.response-heading {
  padding-left: 14px;
}

.response-facts {
  display: flex;
  min-width: 0;
  gap: 12px;
  margin: 0 0 0 auto;
}

.response-facts div {
  display: flex;
  gap: 4px;
  white-space: nowrap;
}

.response-facts dt {
  color: var(--color-text-muted);
}

.response-facts dd {
  margin: 0;
  color: var(--color-text-secondary);
  font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
}

.response-heading > .el-button {
  margin-left: 0;
}

.response-content {
  min-width: 0;
  min-height: 0;
  overflow: auto;
  background: var(--color-panel);
}

.response-error {
  border-radius: 0;
}

.response-code {
  min-width: max-content;
  margin: 0;
  padding: 14px 16px 28px;
  color: var(--color-text);
  font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
  font-size: 12px;
  line-height: 1.65;
  white-space: pre;
}

.response-content :deep(.el-empty) {
  height: 100%;
  min-height: 220px;
}

.response-headers {
  margin: 0;
  padding: 12px 16px;
  border-top: 1px solid var(--color-line);
}

.response-headers dt {
  margin-bottom: 8px;
  color: var(--color-text-secondary);
  font-size: 12px;
  font-weight: 650;
}

.response-headers dd {
  display: grid;
  grid-template-columns: minmax(120px, 0.4fr) minmax(0, 1fr);
  gap: 12px;
  margin: 4px 0;
  color: var(--color-text-secondary);
  overflow-wrap: anywhere;
}

@container (max-width: 760px) {
  .rest-panels {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: minmax(220px, 0.8fr) minmax(260px, 1.2fr);
    overflow: auto;
  }

  .request-panel {
    border-right: 0;
    border-bottom: 1px solid var(--color-line);
  }

  .response-facts {
    gap: 8px;
  }

  .response-facts dt {
    display: none;
  }
}
</style>
