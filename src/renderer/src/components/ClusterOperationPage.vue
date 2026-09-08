<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Close, Refresh, Search, Upload } from '@element-plus/icons-vue'
import { ElMessageBox } from 'element-plus'
import type {
  ClusterOperationApi,
  ClusterOperationCapabilities,
  ClusterOperationResult
} from '../../../shared/types/cluster-operation'
import {
  createClusterOperationAvailability,
  normalizeClusterOperationError,
  parseClusterOperationJsonObject
} from './operation-page-state'

const props = withDefaults(
  defineProps<{
    connectionId: string
    connectionName: string
    connected: boolean
    api?: ClusterOperationApi
    language?: 'zh-CN' | 'en-US'
  }>(),
  {
    api: undefined,
    language: 'zh-CN'
  }
)

const mode = ref<'reindex' | 'async-search'>('reindex')
const capabilities = ref<ClusterOperationCapabilities | null>(null)
const capabilitiesLoading = ref(false)
const actionLoading = ref(false)
const errorMessage = ref('')
const result = ref<ClusterOperationResult | null>(null)
const sourceIndex = ref('')
const destinationIndex = ref('')
const reindexQuery = ref('{\n  "match_all": {}\n}')
const conflicts = ref<'abort' | 'proceed'>('abort')
const destinationOperation = ref<'index' | 'create'>('index')
const asyncIndex = ref('')
const asyncQuery = ref('{\n  "query": {\n    "match_all": {}\n  }\n}')
const keepAlive = ref('1h')
const waitForCompletionTimeout = ref('100ms')
const keepOnCompletion = ref(true)
const asyncTaskId = ref('')

const messages = {
  'zh-CN': {
    reindex: 'Reindex', asyncSearch: 'Async Search', sourceIndex: '源索引', destinationIndex: '目标索引',
    query: '查询 JSON', requestBody: '请求体 JSON', conflicts: '版本冲突', abort: '遇到冲突终止',
    proceed: '跳过冲突继续', destinationOperation: '目标写入方式', overwrite: '覆盖写入', createOnly: '仅创建',
    submit: '提交任务', index: '索引', keepAlive: '保留时间', waitTimeout: '等待超时', keepOnCompletion: '完成后保留',
    taskId: '任务 ID', refresh: '刷新状态', cancel: '取消任务', requestId: '请求 ID', status: '状态',
    result: '响应结果', disconnected: '当前连接尚未建立', apiUnavailable: '集群长任务 API 尚未接线',
    capabilityFailed: '读取集群长任务能力', reindexConfirm: '确认提交 Reindex',
    cancelConfirm: '确认取消 Async Search', confirm: '确认执行', canceled: '取消',
    missingIndex: '源索引和目标索引不能为空', sameIndex: '源索引与目标索引不能相同',
    missingAsyncIndex: '索引不能为空', missingTaskId: '任务 ID 不能为空',
    running: '运行中', completed: '已完成', failed: '失败', taskCanceled: '已取消'
  },
  'en-US': {
    reindex: 'Reindex', asyncSearch: 'Async Search', sourceIndex: 'Source index', destinationIndex: 'Destination index',
    query: 'Query JSON', requestBody: 'Request body JSON', conflicts: 'Version conflicts', abort: 'Abort on conflict',
    proceed: 'Proceed past conflicts', destinationOperation: 'Destination operation', overwrite: 'Index', createOnly: 'Create only',
    submit: 'Submit task', index: 'Index', keepAlive: 'Keep alive', waitTimeout: 'Wait timeout', keepOnCompletion: 'Keep on completion',
    taskId: 'Task ID', refresh: 'Refresh status', cancel: 'Cancel task', requestId: 'Request ID', status: 'Status',
    result: 'Response', disconnected: 'The current connection is not connected', apiUnavailable: 'Cluster operation API is unavailable',
    capabilityFailed: 'Load cluster operation capabilities', reindexConfirm: 'Confirm Reindex submission',
    cancelConfirm: 'Confirm Async Search cancellation', confirm: 'Confirm', canceled: 'Cancel',
    missingIndex: 'Source and destination indices are required', sameIndex: 'Source and destination indices must differ',
    missingAsyncIndex: 'Index is required', missingTaskId: 'Task ID is required',
    running: 'Running', completed: 'Completed', failed: 'Failed', taskCanceled: 'Canceled'
  }
} as const

const copy = computed(() => messages[props.language])
const availability = computed(() => createClusterOperationAvailability(props.connected, capabilities.value))
const statusLabel = computed(() => {
  if (!result.value) return ''
  if (result.value.status === 'running') return copy.value.running
  if (result.value.status === 'completed') return copy.value.completed
  if (result.value.status === 'failed') return copy.value.failed
  return copy.value.taskCanceled
})
const statusType = computed(() => {
  if (result.value?.status === 'completed') return 'success'
  if (result.value?.status === 'failed') return 'danger'
  if (result.value?.status === 'canceled') return 'info'
  return 'warning'
})
const formattedPayload = computed(() => result.value ? JSON.stringify(result.value.payload, null, 2) : '')

watch(
  [() => props.connectionId, () => props.connected, () => props.api],
  () => void loadCapabilities(),
  { immediate: true }
)

async function loadCapabilities(): Promise<void> {
  capabilities.value = null
  result.value = null
  errorMessage.value = ''
  if (!props.connected) {
    errorMessage.value = copy.value.disconnected
    return
  }
  if (!props.api) {
    errorMessage.value = copy.value.apiUnavailable
    return
  }
  capabilitiesLoading.value = true
  try {
    capabilities.value = await props.api.getCapabilities(props.connectionId)
  } catch (error: unknown) {
    errorMessage.value = normalizeClusterOperationError(error, copy.value.capabilityFailed)
  } finally {
    capabilitiesLoading.value = false
  }
}

async function submitReindex(): Promise<void> {
  if (!props.api || !availability.value.reindex) return
  const source = sourceIndex.value.trim()
  const destination = destinationIndex.value.trim()
  if (!source || !destination) {
    errorMessage.value = copy.value.missingIndex
    return
  }
  if (source === destination) {
    errorMessage.value = copy.value.sameIndex
    return
  }
  let query
  try {
    query = parseClusterOperationJsonObject(reindexQuery.value, copy.value.query)
    await ElMessageBox.confirm(
      `${props.connectionName}\n${source} -> ${destination}`,
      copy.value.reindexConfirm,
      { type: 'warning', confirmButtonText: copy.value.confirm, cancelButtonText: copy.value.canceled }
    )
  } catch (error: unknown) {
    if (error === 'cancel' || error === 'close') return
    errorMessage.value = normalizeClusterOperationError(error, copy.value.reindex)
    return
  }
  await execute(copy.value.reindex, async () => props.api!.submitReindex({
    requestId: crypto.randomUUID(),
    connectionId: props.connectionId,
    sourceIndex: source,
    destinationIndex: destination,
    query,
    conflicts: conflicts.value,
    destinationOperation: destinationOperation.value
  }), 'reindex')
}

async function submitAsyncSearch(): Promise<void> {
  if (!props.api || !availability.value.asyncSubmit || !capabilities.value?.asyncSearchPathPrefix) return
  const index = asyncIndex.value.trim()
  if (!index) {
    errorMessage.value = copy.value.missingAsyncIndex
    return
  }
  let query
  try {
    query = parseClusterOperationJsonObject(asyncQuery.value, copy.value.requestBody)
  } catch (error: unknown) {
    errorMessage.value = normalizeClusterOperationError(error, copy.value.asyncSearch)
    return
  }
  const pathPrefix = capabilities.value.asyncSearchPathPrefix
  await execute(copy.value.asyncSearch, async () => props.api!.submitAsyncSearch({
    requestId: crypto.randomUUID(),
    connectionId: props.connectionId,
    pathPrefix,
    index,
    query,
    keepAlive: keepAlive.value.trim() || undefined,
    waitForCompletionTimeout: waitForCompletionTimeout.value.trim() || undefined,
    keepOnCompletion: keepOnCompletion.value
  }), 'async-search')
}

async function refreshAsyncSearch(): Promise<void> {
  if (!props.api || !availability.value.asyncRead || !capabilities.value?.asyncSearchPathPrefix) return
  const taskId = asyncTaskId.value.trim()
  if (!taskId) {
    errorMessage.value = copy.value.missingTaskId
    return
  }
  const pathPrefix = capabilities.value.asyncSearchPathPrefix
  await execute(copy.value.refresh, async () => props.api!.getAsyncSearch({
    requestId: crypto.randomUUID(),
    connectionId: props.connectionId,
    pathPrefix,
    taskId,
    keepAlive: keepAlive.value.trim() || undefined,
    waitForCompletionTimeout: waitForCompletionTimeout.value.trim() || undefined
  }), 'async-search')
}

async function cancelAsyncSearch(): Promise<void> {
  if (!props.api || !availability.value.asyncDelete || !capabilities.value?.asyncSearchPathPrefix) return
  const taskId = asyncTaskId.value.trim()
  if (!taskId) {
    errorMessage.value = copy.value.missingTaskId
    return
  }
  try {
    await ElMessageBox.confirm(
      `${props.connectionName}\n${taskId}`,
      copy.value.cancelConfirm,
      { type: 'warning', confirmButtonText: copy.value.confirm, cancelButtonText: copy.value.canceled }
    )
  } catch (error: unknown) {
    if (error === 'cancel' || error === 'close') return
    errorMessage.value = normalizeClusterOperationError(error, copy.value.cancel)
    return
  }
  const pathPrefix = capabilities.value.asyncSearchPathPrefix
  await execute(copy.value.cancel, async () => props.api!.deleteAsyncSearch({
    requestId: crypto.randomUUID(),
    connectionId: props.connectionId,
    pathPrefix,
    taskId
  }), 'async-search')
}

async function execute(
  operation: string,
  request: () => Promise<ClusterOperationResult>,
  operationKind: 'reindex' | 'async-search'
): Promise<void> {
  actionLoading.value = true
  errorMessage.value = ''
  try {
    const response = await request()
    result.value = response
    if (operationKind === 'async-search' && response.taskId) asyncTaskId.value = response.taskId
  } catch (error: unknown) {
    errorMessage.value = normalizeClusterOperationError(error, operation)
  } finally {
    actionLoading.value = false
  }
}
</script>

<template>
  <section class="operation-page" v-loading="capabilitiesLoading">
    <header class="operation-header">
      <el-segmented v-model="mode" :options="[{ label: copy.reindex, value: 'reindex' }, { label: copy.asyncSearch, value: 'async-search' }]" />
      <el-button :icon="Refresh" circle :aria-label="copy.refresh" @click="loadCapabilities" />
    </header>

    <el-alert v-if="errorMessage" :title="errorMessage" type="error" show-icon :closable="true" @close="errorMessage = ''" />
    <el-alert
      v-if="mode === 'reindex' && !availability.reindex"
      :title="availability.reindexReason"
      type="warning"
      show-icon
      :closable="false"
    />
    <el-alert
      v-if="mode === 'async-search' && !availability.asyncSubmit"
      :title="availability.asyncSearchReason"
      type="warning"
      show-icon
      :closable="false"
    />

    <el-form v-if="mode === 'reindex'" label-position="top" class="operation-form">
      <div class="form-grid">
        <el-form-item :label="copy.sourceIndex"><el-input v-model="sourceIndex" /></el-form-item>
        <el-form-item :label="copy.destinationIndex"><el-input v-model="destinationIndex" /></el-form-item>
        <el-form-item :label="copy.conflicts">
          <el-select v-model="conflicts"><el-option :label="copy.abort" value="abort" /><el-option :label="copy.proceed" value="proceed" /></el-select>
        </el-form-item>
        <el-form-item :label="copy.destinationOperation">
          <el-select v-model="destinationOperation"><el-option :label="copy.overwrite" value="index" /><el-option :label="copy.createOnly" value="create" /></el-select>
        </el-form-item>
      </div>
      <el-form-item :label="copy.query"><el-input v-model="reindexQuery" type="textarea" :rows="10" class="json-editor" /></el-form-item>
      <el-button type="primary" :icon="Upload" :loading="actionLoading" :disabled="!availability.reindex" @click="submitReindex">{{ copy.submit }}</el-button>
    </el-form>

    <el-form v-else label-position="top" class="operation-form">
      <div class="form-grid async-grid">
        <el-form-item :label="copy.index"><el-input v-model="asyncIndex" /></el-form-item>
        <el-form-item :label="copy.keepAlive"><el-input v-model="keepAlive" /></el-form-item>
        <el-form-item :label="copy.waitTimeout"><el-input v-model="waitForCompletionTimeout" /></el-form-item>
        <el-form-item :label="copy.keepOnCompletion"><el-switch v-model="keepOnCompletion" /></el-form-item>
      </div>
      <el-form-item :label="copy.requestBody"><el-input v-model="asyncQuery" type="textarea" :rows="10" class="json-editor" /></el-form-item>
      <div class="operation-actions">
        <el-button type="primary" :icon="Search" :loading="actionLoading" :disabled="!availability.asyncSubmit" @click="submitAsyncSearch">{{ copy.submit }}</el-button>
        <el-input v-model="asyncTaskId" :placeholder="copy.taskId" class="task-id-input" />
        <el-button :icon="Refresh" :loading="actionLoading" :disabled="!availability.asyncRead" @click="refreshAsyncSearch">{{ copy.refresh }}</el-button>
        <el-button type="danger" plain :icon="Close" :loading="actionLoading" :disabled="!availability.asyncDelete" @click="cancelAsyncSearch">{{ copy.cancel }}</el-button>
      </div>
    </el-form>

    <section v-if="result" class="operation-result">
      <header>
        <strong>{{ copy.result }}</strong>
        <el-tag :type="statusType" effect="plain">{{ statusLabel }}</el-tag>
      </header>
      <dl>
        <div><dt>{{ copy.requestId }}</dt><dd>{{ result.requestId }}</dd></div>
        <div><dt>{{ copy.taskId }}</dt><dd>{{ result.taskId ?? '--' }}</dd></div>
      </dl>
      <pre>{{ formattedPayload }}</pre>
    </section>
  </section>
</template>

<style scoped>
.operation-page { height: 100%; overflow: auto; padding: 18px 22px 28px; background: var(--color-canvas); color: var(--color-text); }
.operation-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
.operation-page :deep(.el-alert) { margin-bottom: 12px; }
.operation-form { max-width: 980px; padding: 18px; border: 1px solid var(--color-line); border-radius: 6px; background: var(--color-panel); }
.form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 16px; }
.async-grid { grid-template-columns: minmax(220px, 2fr) repeat(3, minmax(130px, 1fr)); }
.json-editor :deep(textarea) { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; line-height: 1.5; }
.operation-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.task-id-input { width: min(420px, 100%); }
.operation-result { max-width: 980px; margin-top: 16px; border: 1px solid var(--color-line); border-radius: 6px; background: var(--color-panel); overflow: hidden; }
.operation-result > header { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-bottom: 1px solid var(--color-line); }
.operation-result dl { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px 20px; margin: 0; padding: 14px 16px; }
.operation-result dl div { min-width: 0; }
.operation-result dt { color: var(--color-text-muted); font-size: 12px; }
.operation-result dd { margin: 3px 0 0; overflow-wrap: anywhere; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.operation-result pre { max-height: 360px; margin: 0; padding: 16px; overflow: auto; border-top: 1px solid var(--color-line); background: var(--color-panel-muted); font-size: 12px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
@media (max-width: 900px) { .form-grid, .async-grid, .operation-result dl { grid-template-columns: 1fr; } }
</style>
