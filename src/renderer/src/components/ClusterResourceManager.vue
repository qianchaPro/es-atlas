<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue'
import {
  Close,
  Delete,
  Edit,
  Plus,
  Refresh,
  RefreshLeft,
  View
} from '@element-plus/icons-vue'
import type {
  ClusterResourceApi,
  ClusterResourceDetail,
  ClusterResourceError,
  ClusterResourceItem,
  ClusterResourceKind,
  ClusterResourceOperationAction,
  ClusterResourceOperationCapability,
  ClusterResourceOperationRequest,
  ClusterResourceValue
} from '../../../shared/types/cluster-resource'
import {
  applyClusterResourceListResult,
  applyClusterResourceLoadError,
  beginClusterResourceLoad,
  canCancelClusterTask,
  canExecuteClusterResourceOperation,
  createClusterResourceCollectionState,
  createClusterResourceOperationRequest,
  normalizeClusterResourceError
} from './cluster-resource-state'

const props = withDefaults(
  defineProps<{
    connectionId: string
    connectionName: string
    connected: boolean
    readOnly: boolean
    resourceKind: ClusterResourceKind
    language?: 'zh-CN' | 'en-US'
    api?: ClusterResourceApi
  }>(),
  {
    language: 'zh-CN',
    api: undefined
  }
)

const emit = defineEmits<{
  'confirm-operation': [request: ClusterResourceOperationRequest]
  loaded: [connectionId: string, kind: ClusterResourceKind]
  'load-error': [error: ClusterResourceError]
}>()

const messages = {
  'zh-CN': {
    node: '节点',
    task: '任务',
    indexTemplate: '索引模板',
    componentTemplate: '组件模板',
    dataStream: '数据流',
    snapshot: '快照',
    ingestPipeline: 'Ingest Pipeline',
    storedScript: '脚本',
    refresh: '刷新',
    create: '新建',
    edit: '编辑',
    remove: '删除',
    restore: '恢复',
    cancelTask: '取消任务',
    resourceName: '资源名称',
    resourceDefinition: '资源定义',
    saveAndConfirm: '提交确认',
    cancel: '取消',
    status: '状态',
    summary: '摘要',
    updatedAt: '更新时间',
    detail: '详情',
    rawDocument: '原始内容',
    noResources: '暂无资源',
    selectResource: '选择资源查看详情',
    disconnected: '当前连接尚未建立',
    forbidden: '权限不足',
    unsupported: '当前产品或版本不支持',
    loadFailed: '加载集群资源失败',
    detailLoadFailed: '加载资源详情失败',
    apiUnavailable: '集群资源 API 尚未接线',
    stale: '刷新失败，当前保留上一次成功数据',
    collectedAt: '采集时间',
    readOnly: '当前连接为只读模式',
    capabilityUnavailable: '操作能力不可用',
    invalidJson: '资源定义不是有效 JSON',
    operationFailed: '无法创建操作确认请求',
    pending: '等待',
    running: '运行中',
    completed: '已完成',
    canceling: '取消中',
    canceled: '已取消',
    failed: '失败'
  },
  'en-US': {
    node: 'Nodes',
    task: 'Tasks',
    indexTemplate: 'Index templates',
    componentTemplate: 'Component templates',
    dataStream: 'Data streams',
    snapshot: 'Snapshots',
    ingestPipeline: 'Ingest pipelines',
    storedScript: 'Stored scripts',
    refresh: 'Refresh',
    create: 'Create',
    edit: 'Edit',
    remove: 'Delete',
    restore: 'Restore',
    cancelTask: 'Cancel task',
    resourceName: 'Resource name',
    resourceDefinition: 'Resource definition',
    saveAndConfirm: 'Review operation',
    cancel: 'Cancel',
    status: 'Status',
    summary: 'Summary',
    updatedAt: 'Updated',
    detail: 'Details',
    rawDocument: 'Raw document',
    noResources: 'No resources',
    selectResource: 'Select a resource to inspect',
    disconnected: 'The current connection is not connected',
    forbidden: 'Permission denied',
    unsupported: 'Unsupported by this product or version',
    loadFailed: 'Failed to load cluster resources',
    detailLoadFailed: 'Failed to load resource details',
    apiUnavailable: 'The cluster resource API has not been wired',
    stale: 'Refresh failed. Showing the last successful data.',
    collectedAt: 'Collected',
    readOnly: 'This connection is read-only',
    capabilityUnavailable: 'Operation is unavailable',
    invalidJson: 'The resource definition is not valid JSON',
    operationFailed: 'Failed to create the operation request',
    pending: 'Waiting',
    running: 'Running',
    completed: 'Completed',
    canceling: 'Canceling',
    canceled: 'Canceled',
    failed: 'Failed'
  }
} as const

type ClusterResourceWindow = Window & {
  electronAPI: {
    clusterResources?: ClusterResourceApi
  }
}

type EditorMode = 'create' | 'update' | 'restore'

const CREATE_ACTION_BY_KIND: Partial<Record<ClusterResourceKind, ClusterResourceOperationAction>> = {
  'index-template': 'create-index-template',
  'component-template': 'create-component-template',
  'data-stream': 'create-data-stream',
  snapshot: 'create-snapshot',
  'ingest-pipeline': 'create-ingest-pipeline',
  'stored-script': 'create-stored-script'
}

const UPDATE_ACTION_BY_KIND: Partial<Record<ClusterResourceKind, ClusterResourceOperationAction>> = {
  'index-template': 'update-index-template',
  'component-template': 'update-component-template',
  'ingest-pipeline': 'update-ingest-pipeline',
  'stored-script': 'update-stored-script'
}

const DELETE_ACTION_BY_KIND: Partial<Record<ClusterResourceKind, ClusterResourceOperationAction>> = {
  'index-template': 'delete-index-template',
  'component-template': 'delete-component-template',
  'data-stream': 'delete-data-stream',
  snapshot: 'delete-snapshot',
  'ingest-pipeline': 'delete-ingest-pipeline',
  'stored-script': 'delete-stored-script'
}

const copy = computed(() => messages[props.language])
const resourceTitle = computed(() => resourceKindLabel(props.resourceKind))
const collectionState = ref(createClusterResourceCollectionState(props.connectionId, props.resourceKind))
const selectedResourceId = ref<string | null>(null)
const detail = shallowRef<ClusterResourceDetail | null>(null)
const detailLoading = ref(false)
const detailError = ref<ClusterResourceError | null>(null)
const operationError = ref('')
const editorVisible = ref(false)
const editorMode = ref<EditorMode>('create')
const editorAction = ref<ClusterResourceOperationAction | null>(null)
const editorResourceName = ref('')
const editorJson = ref('{}')
const editorError = ref('')
const editorAcceptsPayload = computed(() => editorAction.value !== 'create-data-stream')
let listGeneration = 0
let detailGeneration = 0

const selectedResource = computed(() =>
  collectionState.value.items.find((item) => item.id === selectedResourceId.value) ?? null
)
const createCapability = computed(() => getCapability(CREATE_ACTION_BY_KIND[props.resourceKind]))
const updateCapability = computed(() => getCapability(UPDATE_ACTION_BY_KIND[props.resourceKind]))
const deleteCapability = computed(() => getCapability(DELETE_ACTION_BY_KIND[props.resourceKind]))
const restoreCapability = computed(() => getCapability(
  props.resourceKind === 'snapshot' ? 'restore-snapshot' : undefined
))
const cancelTaskCapability = computed(() => getCapability(
  props.resourceKind === 'task' ? 'cancel-task' : undefined
))
const hasCollectionAlert = computed(() =>
  collectionState.value.loadState === 'forbidden' ||
  collectionState.value.loadState === 'unsupported' ||
  collectionState.value.loadState === 'error'
)
const collectionAlertType = computed<'error' | 'warning'>(() =>
  collectionState.value.loadState === 'forbidden' ? 'error' : 'warning'
)
const collectionAlertTitle = computed(() => {
  if (collectionState.value.loadState === 'forbidden') return copy.value.forbidden
  if (collectionState.value.loadState === 'unsupported') return copy.value.unsupported
  return copy.value.loadFailed
})
const collectionAlertDescription = computed(() =>
  collectionState.value.error?.message ??
  collectionState.value.access?.reason ??
  copy.value.loadFailed
)
const formattedDetail = computed<string>(() => formatJson(detail.value?.document))

watch(
  () => [props.connectionId, props.resourceKind, props.connected] as const,
  ([connectionId, kind, connected]) => {
    listGeneration += 1
    detailGeneration += 1
    collectionState.value = createClusterResourceCollectionState(connectionId, kind)
    selectedResourceId.value = null
    detail.value = null
    detailError.value = null
    operationError.value = ''
    if (connected && connectionId) void loadResources()
  },
  { immediate: true }
)

defineExpose({
  refresh: refreshResources,
  refreshDetail
})

async function loadResources(): Promise<void> {
  if (!props.connected || !props.connectionId) return
  const generation = ++listGeneration
  collectionState.value = beginClusterResourceLoad(collectionState.value)

  try {
    const result = await getApi().list({
      connectionId: props.connectionId,
      kind: props.resourceKind
    })
    if (generation !== listGeneration) return

    // 主进程响应必须与当前连接和资源类型一致，避免切换标签后的迟到结果串页。
    collectionState.value = applyClusterResourceListResult(collectionState.value, result)
    if (
      selectedResourceId.value &&
      !collectionState.value.items.some((item) => item.id === selectedResourceId.value)
    ) {
      selectedResourceId.value = null
      detail.value = null
    }
    emit('loaded', props.connectionId, props.resourceKind)
  } catch (error: unknown) {
    if (generation !== listGeneration) return
    collectionState.value = applyClusterResourceLoadError(collectionState.value, error)
    if (collectionState.value.error) emit('load-error', collectionState.value.error)
  }
}

async function refreshResources(): Promise<void> {
  await loadResources()
  if (selectedResourceId.value) await loadDetail(selectedResourceId.value)
}

async function selectResource(resource: ClusterResourceItem): Promise<void> {
  if (selectedResourceId.value === resource.id && detail.value) return
  selectedResourceId.value = resource.id
  await loadDetail(resource.id)
}

async function loadDetail(resourceId: string): Promise<void> {
  const generation = ++detailGeneration
  detailLoading.value = true
  detailError.value = null
  try {
    const result = await getApi().getDetail({
      connectionId: props.connectionId,
      kind: props.resourceKind,
      resourceId
    })
    if (generation !== detailGeneration || selectedResourceId.value !== resourceId) return
    if (
      result.connectionId !== props.connectionId ||
      result.kind !== props.resourceKind ||
      result.resourceId !== resourceId
    ) {
      throw {
        code: 'CONTEXT_MISMATCH',
        message: '集群资源详情响应上下文不匹配',
        statusCode: null,
        capability: result.access.capability
      }
    }
    detail.value = result
  } catch (error: unknown) {
    if (generation !== detailGeneration) return
    detail.value = null
    detailError.value = normalizeClusterResourceError(error)
  } finally {
    if (generation === detailGeneration) detailLoading.value = false
  }
}

async function refreshDetail(): Promise<void> {
  if (selectedResourceId.value) await loadDetail(selectedResourceId.value)
}

function getApi(): ClusterResourceApi {
  const api = props.api ?? (window as unknown as ClusterResourceWindow).electronAPI.clusterResources
  if (!api) throw new Error(copy.value.apiUnavailable)
  return api
}

function getCapability(
  action: ClusterResourceOperationAction | undefined
): ClusterResourceOperationCapability | undefined {
  if (!action) return undefined
  return collectionState.value.operations.find((item) => item.action === action)
}

function operationDisabledReason(
  capability: ClusterResourceOperationCapability | undefined
): string {
  if (props.readOnly) return copy.value.readOnly
  return capability?.reason ?? copy.value.capabilityUnavailable
}

function openEditor(mode: Exclude<EditorMode, 'restore'>): void {
  const capability = mode === 'create' ? createCapability.value : updateCapability.value
  if (!canExecuteClusterResourceOperation(props.readOnly, capability) || !capability) return
  if (mode === 'update' && (!selectedResource.value || !detail.value)) return

  editorMode.value = mode
  editorAction.value = capability.action
  editorResourceName.value = mode === 'create' ? '' : selectedResource.value?.name ?? ''
  editorJson.value = mode === 'create' ? '{}' : formatJson(detail.value?.document)
  editorError.value = ''
  editorVisible.value = true
}

function openRestoreEditor(): void {
  const capability = restoreCapability.value
  if (
    !selectedResource.value ||
    !capability ||
    !canExecuteClusterResourceOperation(props.readOnly, capability)
  ) return

  editorMode.value = 'restore'
  editorAction.value = capability.action
  // 快照列表 ID 已由主进程规范为 repository/snapshot；确认界面必须展示完整目标。
  editorResourceName.value = selectedResource.value.id
  editorJson.value = '{}'
  editorError.value = ''
  editorVisible.value = true
}

function submitEditor(): void {
  const action = editorAction.value
  const capability = getCapability(action ?? undefined)
  if (!action || !capability) return

  let payload: ClusterResourceValue | null = null
  if (editorAcceptsPayload.value) {
    try {
      payload = JSON.parse(editorJson.value) as ClusterResourceValue
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error)
      editorError.value = `${copy.value.invalidJson}：${reason}`
      return
    }
  }

  const resource = editorMode.value === 'create' ? null : selectedResource.value
  if (emitOperationRequest(capability, resource, editorResourceName.value, payload)) {
    editorVisible.value = false
  }
}

function requestSelectedOperation(capability: ClusterResourceOperationCapability | undefined): void {
  if (!capability || !selectedResource.value) return
  emitOperationRequest(capability, selectedResource.value, selectedResource.value.name, null)
}

function requestTaskCancel(): void {
  if (!selectedResource.value || !canCancelClusterTask(selectedResource.value)) return
  requestSelectedOperation(cancelTaskCapability.value)
}

function emitOperationRequest(
  capability: ClusterResourceOperationCapability,
  resource: ClusterResourceItem | null,
  resourceName: string,
  payload: ClusterResourceValue | null
): boolean {
  operationError.value = ''
  try {
    // 组件只产生完整确认契约，不直接调用写 IPC；确认、审计和执行由接线层负责。
    const request = createClusterResourceOperationRequest({
      requestId: crypto.randomUUID(),
      connectionId: props.connectionId,
      connectionName: props.connectionName,
      kind: props.resourceKind,
      capability,
      resource,
      resourceName,
      payload,
      readOnly: props.readOnly
    })
    emit('confirm-operation', request)
    return true
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error)
    operationError.value = `${copy.value.operationFailed}：${reason}`
    return false
  }
}

function resourceKindLabel(kind: ClusterResourceKind): string {
  const labels: Record<ClusterResourceKind, string> = {
    node: copy.value.node,
    task: copy.value.task,
    'index-template': copy.value.indexTemplate,
    'component-template': copy.value.componentTemplate,
    'data-stream': copy.value.dataStream,
    snapshot: copy.value.snapshot,
    'ingest-pipeline': copy.value.ingestPipeline,
    'stored-script': copy.value.storedScript
  }
  return labels[kind]
}

function taskStateLabel(resource: ClusterResourceItem): string {
  if (!resource.taskState) return resource.status ?? '-'
  const labels = {
    waiting: copy.value.pending,
    running: copy.value.running,
    completed: copy.value.completed,
    canceling: copy.value.canceling,
    canceled: copy.value.canceled,
    failed: copy.value.failed
  }
  return labels[resource.taskState]
}

function statusTagType(resource: ClusterResourceItem): 'info' | 'warning' | 'success' | 'danger' {
  if (resource.taskState === 'completed') return 'success'
  if (resource.taskState === 'failed') return 'danger'
  if (resource.taskState === 'waiting' || resource.taskState === 'running' || resource.taskState === 'canceling') {
    return 'warning'
  }
  return 'info'
}

function formatJson(value: ClusterResourceValue | undefined): string {
  if (value === undefined) return ''
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function formatTime(value: string | null): string {
  if (!value) return '-'
  return new Date(value).toLocaleString(props.language, { hour12: false })
}
</script>

<template>
  <section class="cluster-resource-manager">
    <header class="resource-header">
      <div class="resource-heading">
        <span class="resource-eyebrow">{{ connectionName }}</span>
        <h2>{{ resourceTitle }}</h2>
        <el-tag v-if="collectionState.collectedAt" effect="plain" type="info" size="small">
          {{ copy.collectedAt }} {{ formatTime(collectionState.collectedAt) }}
        </el-tag>
      </div>
      <div class="resource-actions">
        <el-tooltip :content="copy.refresh">
          <el-button
            circle
            :icon="Refresh"
            :aria-label="copy.refresh"
            :loading="collectionState.loadState === 'loading'"
            :disabled="!connected"
            @click="refreshResources"
          />
        </el-tooltip>
        <el-tooltip
          v-if="createCapability"
          :content="canExecuteClusterResourceOperation(readOnly, createCapability) ? copy.create : operationDisabledReason(createCapability)"
        >
          <el-button
            type="primary"
            :icon="Plus"
            :disabled="!canExecuteClusterResourceOperation(readOnly, createCapability)"
            @click="openEditor('create')"
          >
            {{ copy.create }}
          </el-button>
        </el-tooltip>
      </div>
    </header>

    <el-alert v-if="!connected" :title="copy.disconnected" type="warning" :closable="false" show-icon />
    <el-alert
      v-else-if="hasCollectionAlert"
      :title="collectionAlertTitle"
      :description="collectionAlertDescription"
      :type="collectionAlertType"
      :closable="false"
      show-icon
    />
    <el-alert
      v-if="collectionState.stale"
      :title="copy.stale"
      type="warning"
      :closable="false"
      show-icon
    />
    <el-alert v-if="operationError" :title="operationError" type="error" :closable="false" show-icon />

    <div v-if="connected" class="resource-workbench">
      <div class="resource-list-pane">
        <el-table
          v-loading="collectionState.loadState === 'loading' && collectionState.items.length === 0"
          :data="collectionState.items"
          row-key="id"
          highlight-current-row
          height="100%"
          size="small"
          :empty-text="copy.noResources"
          @row-click="selectResource"
        >
          <el-table-column prop="name" :label="resourceTitle" min-width="180" show-overflow-tooltip />
          <el-table-column :label="copy.status" width="104">
            <template #default="{ row }">
              <el-tag :type="statusTagType(row)" effect="plain" size="small">
                {{ taskStateLabel(row) }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="summary" :label="copy.summary" min-width="190" show-overflow-tooltip />
          <el-table-column :label="copy.updatedAt" width="166">
            <template #default="{ row }">{{ formatTime(row.updatedAt) }}</template>
          </el-table-column>
          <el-table-column :label="copy.detail" width="52" align="center">
            <template #default="{ row }">
              <el-tooltip :content="copy.detail">
                <el-button text circle :icon="View" :aria-label="copy.detail" @click.stop="selectResource(row)" />
              </el-tooltip>
            </template>
          </el-table-column>
        </el-table>
      </div>

      <aside class="resource-detail-pane">
        <div v-if="selectedResource" class="detail-shell">
          <header class="detail-header">
            <div class="detail-title">
              <h3>{{ selectedResource.name }}</h3>
              <span>{{ selectedResource.id }}</span>
            </div>
            <div class="detail-actions">
              <el-tooltip :content="copy.refresh">
                <el-button
                  text
                  circle
                  :icon="RefreshLeft"
                  :aria-label="copy.refresh"
                  :loading="detailLoading"
                  @click="refreshDetail"
                />
              </el-tooltip>
              <el-tooltip
                v-if="updateCapability"
                :content="canExecuteClusterResourceOperation(readOnly, updateCapability) ? copy.edit : operationDisabledReason(updateCapability)"
              >
                <el-button
                  text
                  circle
                  :icon="Edit"
                  :aria-label="copy.edit"
                  :disabled="!detail || !canExecuteClusterResourceOperation(readOnly, updateCapability)"
                  @click="openEditor('update')"
                />
              </el-tooltip>
              <el-tooltip
                v-if="restoreCapability"
                :content="canExecuteClusterResourceOperation(readOnly, restoreCapability) ? copy.restore : operationDisabledReason(restoreCapability)"
              >
                <el-button
                  text
                  :icon="RefreshLeft"
                  :disabled="!canExecuteClusterResourceOperation(readOnly, restoreCapability)"
                  @click="openRestoreEditor"
                >
                  {{ copy.restore }}
                </el-button>
              </el-tooltip>
              <el-tooltip
                v-if="cancelTaskCapability"
                :content="canExecuteClusterResourceOperation(readOnly, cancelTaskCapability) ? copy.cancelTask : operationDisabledReason(cancelTaskCapability)"
              >
                <el-button
                  text
                  :icon="Close"
                  :disabled="!canCancelClusterTask(selectedResource) || !canExecuteClusterResourceOperation(readOnly, cancelTaskCapability)"
                  @click="requestTaskCancel"
                >
                  {{ copy.cancelTask }}
                </el-button>
              </el-tooltip>
              <el-tooltip
                v-if="deleteCapability"
                :content="canExecuteClusterResourceOperation(readOnly, deleteCapability) ? copy.remove : operationDisabledReason(deleteCapability)"
              >
                <el-button
                  text
                  type="danger"
                  circle
                  :icon="Delete"
                  :aria-label="copy.remove"
                  :disabled="!canExecuteClusterResourceOperation(readOnly, deleteCapability)"
                  @click="requestSelectedOperation(deleteCapability)"
                />
              </el-tooltip>
            </div>
          </header>

          <dl v-if="selectedResource.facts.length > 0" class="resource-facts">
            <div v-for="fact in selectedResource.facts" :key="fact.key">
              <dt>{{ fact.key }}</dt>
              <dd>{{ fact.value ?? '-' }}</dd>
            </div>
          </dl>

          <el-alert
            v-if="detailError"
            :title="detailError.code === 'FORBIDDEN' ? copy.forbidden : detailError.code === 'UNSUPPORTED' ? copy.unsupported : copy.detailLoadFailed"
            :description="detailError.message"
            :type="detailError.code === 'FORBIDDEN' ? 'error' : 'warning'"
            :closable="false"
            show-icon
          />
          <div v-loading="detailLoading" class="raw-detail">
            <span>{{ copy.rawDocument }}</span>
            <pre v-if="detail">{{ formattedDetail }}</pre>
          </div>
        </div>
        <el-empty v-else :description="copy.selectResource" :image-size="56" />
      </aside>
    </div>

    <el-dialog
      v-model="editorVisible"
      :title="`${editorMode === 'create' ? copy.create : editorMode === 'restore' ? copy.restore : copy.edit} ${resourceTitle}`"
      width="min(760px, 90vw)"
      append-to-body
      destroy-on-close
    >
      <el-form label-position="top">
        <el-form-item :label="copy.resourceName">
          <el-input v-model="editorResourceName" :disabled="editorMode !== 'create'" />
        </el-form-item>
        <el-form-item v-if="editorAcceptsPayload" :label="copy.resourceDefinition">
          <el-input
            v-model="editorJson"
            type="textarea"
            :rows="16"
            resize="vertical"
            class="resource-json-editor"
            spellcheck="false"
          />
        </el-form-item>
      </el-form>
      <el-alert v-if="editorError" :title="editorError" type="error" :closable="false" show-icon />
      <template #footer>
        <el-button @click="editorVisible = false">{{ copy.cancel }}</el-button>
        <el-button type="primary" @click="submitEditor">{{ copy.saveAndConfirm }}</el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.cluster-resource-manager {
  display: flex;
  min-width: 0;
  min-height: 520px;
  height: 100%;
  flex-direction: column;
  gap: 10px;
  color: var(--el-text-color-primary);
}

.resource-header,
.detail-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.resource-heading {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 10px;
}

.resource-heading h2,
.detail-title h3 {
  overflow: hidden;
  margin: 0;
  font-size: 16px;
  font-weight: 650;
  letter-spacing: 0;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.resource-eyebrow,
.detail-title span,
.raw-detail > span {
  color: var(--el-text-color-secondary);
  font-size: 12px;
  letter-spacing: 0;
}

.resource-eyebrow {
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.resource-actions,
.detail-actions {
  display: flex;
  flex: none;
  align-items: center;
  gap: 4px;
}

.resource-workbench {
  display: grid;
  min-height: 0;
  flex: 1;
  grid-template-columns: minmax(420px, 1.35fr) minmax(320px, 0.85fr);
  border-top: 1px solid var(--el-border-color-light);
}

.resource-list-pane,
.resource-detail-pane {
  min-width: 0;
  min-height: 0;
  padding-top: 10px;
}

.resource-detail-pane {
  overflow: auto;
  padding-left: 14px;
  border-left: 1px solid var(--el-border-color-light);
}

.detail-shell {
  display: flex;
  min-height: 100%;
  flex-direction: column;
  gap: 12px;
}

.detail-title {
  min-width: 0;
}

.detail-title span {
  display: block;
  overflow: hidden;
  margin-top: 2px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.resource-facts {
  display: grid;
  margin: 0;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  border-top: 1px solid var(--el-border-color-lighter);
  border-left: 1px solid var(--el-border-color-lighter);
}

.resource-facts div {
  min-width: 0;
  padding: 8px 10px;
  border-right: 1px solid var(--el-border-color-lighter);
  border-bottom: 1px solid var(--el-border-color-lighter);
}

.resource-facts dt {
  color: var(--el-text-color-secondary);
  font-size: 11px;
}

.resource-facts dd {
  overflow: hidden;
  margin: 3px 0 0;
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.raw-detail {
  min-height: 180px;
  flex: 1;
}

.raw-detail pre {
  min-height: 160px;
  margin: 6px 0 0;
  padding: 12px;
  overflow: auto;
  border: 1px solid var(--color-line);
  border-radius: 4px;
  background: var(--color-panel-muted);
  color: var(--color-text-secondary);
  font-family: "JetBrains Mono", "SFMono-Regular", Consolas, monospace;
  font-size: 12px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
}

:deep(.resource-json-editor textarea) {
  font-family: "JetBrains Mono", "SFMono-Regular", Consolas, monospace;
  font-size: 12px;
  line-height: 1.55;
}

@media (max-width: 980px) {
  .resource-workbench {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: minmax(280px, 1fr) minmax(300px, 1fr);
  }

  .resource-detail-pane {
    padding-left: 0;
    border-top: 1px solid var(--el-border-color-light);
    border-left: 0;
  }
}
</style>
