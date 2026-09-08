<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { View } from '@element-plus/icons-vue'
import type { RequestHistoryConnectionOption, RequestHistoryRecord } from '../../../shared/types/request-history'

const props = defineProps<{
  active: boolean
  initialConnectionId: string | null
  connectionOptions: RequestHistoryConnectionOption[]
  language: 'zh-CN' | 'en-US'
}>()

const messages = {
  'zh-CN': {
    allConnections: '全部连接',
    connection: '连接',
    timeRange: '时间范围',
    startedAt: '开始时间',
    endedAt: '结束时间',
    search: '查询',
    reset: '重置',
    time: '时间',
    source: '来源',
    method: '方法',
    path: '路径',
    status: '状态',
    duration: '耗时',
    category: '请求分类',
    errorCode: '错误码',
    detail: '详情',
    requestDetail: '请求详情',
    searchCategory: '搜索',
    writeCategory: '写入',
    otherCategory: '其他',
    overview: '集群概览',
    index: '索引工作台',
    connectionSource: '连接检查',
    other: '其他',
    failed: '失败',
    noRecords: '暂无请求历史',
    loadFailed: '加载请求历史失败',
    retainedHint: '仅保留最近 30 天',
    totalRecords: '全部{count}条'
  },
  'en-US': {
    allConnections: 'All connections',
    connection: 'Connection',
    timeRange: 'Time range',
    startedAt: 'Start time',
    endedAt: 'End time',
    search: 'Search',
    reset: 'Reset',
    time: 'Time',
    source: 'Source',
    method: 'Method',
    path: 'Path',
    status: 'Status',
    duration: 'Duration',
    category: 'Category',
    errorCode: 'Error code',
    detail: 'Details',
    requestDetail: 'Request details',
    searchCategory: 'Search',
    writeCategory: 'Write',
    otherCategory: 'Other',
    overview: 'Cluster overview',
    index: 'Index workspace',
    connectionSource: 'Connection check',
    other: 'Other',
    failed: 'Failed',
    noRecords: 'No request history',
    loadFailed: 'Failed to load request history',
    retainedHint: 'Only the last 30 days are retained',
    totalRecords: '{count} records'
  }
} as const

const copy = computed(() => messages[props.language])
const selectedConnectionId = ref<string | null>(null)
const selectedTimeRange = ref<[Date, Date] | null>(null)
const records = ref<RequestHistoryRecord[]>([])
const historyConnectionOptions = ref<RequestHistoryConnectionOption[]>([])
const currentPage = ref(1)
const pageSize = 20
const total = ref(0)
const loading = ref(false)
const errorMessage = ref('')
const detailRecord = ref<RequestHistoryRecord | null>(null)
let requestGeneration = 0

const availableConnections = computed<RequestHistoryConnectionOption[]>(() => {
  const namesById = new Map<string, string>()
  for (const option of [...props.connectionOptions, ...historyConnectionOptions.value]) {
    if (!namesById.has(option.id)) namesById.set(option.id, option.name)
  }
  return [...namesById.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((left, right) => left.name.localeCompare(right.name, props.language))
})

watch(
  () => props.active,
  (active) => {
    if (!active) return
    selectedConnectionId.value = props.initialConnectionId
    selectedTimeRange.value = null
    currentPage.value = 1
    void loadHistory()
  },
  { immediate: true }
)

async function loadHistory(): Promise<void> {
  const generation = ++requestGeneration
  loading.value = true
  errorMessage.value = ''
  try {
    const page = await window.electronAPI.requestHistory.list({
      connectionId: selectedConnectionId.value,
      startedAt: selectedTimeRange.value?.[0].toISOString() ?? null,
      endedAt: selectedTimeRange.value?.[1].toISOString() ?? null,
      page: currentPage.value,
      pageSize
    })
    if (generation !== requestGeneration) return
    records.value = page.records
    total.value = page.total
    historyConnectionOptions.value = page.connections
  } catch (error: unknown) {
    if (generation !== requestGeneration) return
    errorMessage.value = error instanceof Error && error.message
      ? `${copy.value.loadFailed}：${error.message}`
      : copy.value.loadFailed
  } finally {
    if (generation === requestGeneration) loading.value = false
  }
}

function searchHistory(): void {
  currentPage.value = 1
  void loadHistory()
}

function resetFilters(): void {
  selectedConnectionId.value = null
  selectedTimeRange.value = null
  currentPage.value = 1
  void loadHistory()
}

function changePage(page: number): void {
  currentPage.value = page
  void loadHistory()
}

function formatTime(value: string): string {
  return new Date(value).toLocaleString(props.language, { hour12: false })
}

function formatSource(record: RequestHistoryRecord): string {
  if (record.source === 'overview') return copy.value.overview
  if (record.source === 'index') return copy.value.index
  if (record.source === 'connection') return copy.value.connectionSource
  return copy.value.other
}

function formatStatus(record: RequestHistoryRecord): string {
  return record.statusCode === null ? record.errorCode ?? copy.value.failed : String(record.statusCode)
}

function formatCategory(record: RequestHistoryRecord): string {
  if (record.category === 'search') return copy.value.searchCategory
  if (record.category === 'write') return copy.value.writeCategory
  return copy.value.otherCategory
}

function formatTotalRecords(): string {
  return copy.value.totalRecords.replace('{count}', String(total.value))
}
</script>

<template>
  <div class="history-content">
    <div class="history-toolbar">
      <el-select v-model="selectedConnectionId" clearable :placeholder="copy.allConnections" class="connection-filter">
        <el-option v-for="option in availableConnections" :key="option.id" :label="option.name" :value="option.id" />
      </el-select>
      <el-date-picker
        v-model="selectedTimeRange"
        type="datetimerange"
        :range-separator="'-'"
        :start-placeholder="copy.startedAt"
        :end-placeholder="copy.endedAt"
        class="time-filter"
      />
      <el-button type="primary" @click="searchHistory">{{ copy.search }}</el-button>
      <el-button @click="resetFilters">{{ copy.reset }}</el-button>
      <small>{{ copy.retainedHint }}</small>
    </div>

    <el-alert v-if="errorMessage" :title="errorMessage" type="error" :closable="false" show-icon />
    <el-table v-loading="loading" :data="records" height="430" size="small" :empty-text="copy.noRecords">
      <el-table-column :label="copy.time" width="170"><template #default="{ row }">{{ formatTime(row.startedAt) }}</template></el-table-column>
      <el-table-column prop="connectionName" :label="copy.connection" width="140" show-overflow-tooltip />
      <el-table-column :label="copy.source" width="110"><template #default="{ row }">{{ formatSource(row) }}</template></el-table-column>
      <el-table-column prop="method" :label="copy.method" width="72" />
      <el-table-column prop="path" :label="copy.path" min-width="300" show-overflow-tooltip class-name="history-request-path" />
      <el-table-column :label="copy.status" width="150"><template #default="{ row }"><el-tag :type="row.successful ? 'success' : 'danger'" effect="plain" size="small">{{ formatStatus(row) }}</el-tag></template></el-table-column>
      <el-table-column :label="copy.duration" width="88" align="right"><template #default="{ row }">{{ row.durationMs }} ms</template></el-table-column>
      <el-table-column :label="copy.detail" width="58" align="center">
        <template #default="{ row }"><el-tooltip :content="copy.requestDetail" placement="left"><el-button text circle :icon="View" :aria-label="copy.requestDetail" @click="detailRecord = row" /></el-tooltip></template>
      </el-table-column>
    </el-table>

    <div class="history-pagination">
      <span>{{ formatTotalRecords() }}</span>
      <el-pagination background layout="prev, pager, next" :total="total" :page-size="pageSize" :current-page="currentPage" @current-change="changePage" />
    </div>

    <el-drawer :model-value="Boolean(detailRecord)" :title="copy.requestDetail" size="min(560px, 88vw)" append-to-body @close="detailRecord = null">
      <dl v-if="detailRecord" class="request-detail-list">
        <div><dt>{{ copy.time }}</dt><dd>{{ formatTime(detailRecord.startedAt) }}</dd></div>
        <div><dt>{{ copy.connection }}</dt><dd>{{ detailRecord.connectionName }}</dd></div>
        <div><dt>{{ copy.source }}</dt><dd>{{ formatSource(detailRecord) }}</dd></div>
        <div><dt>{{ copy.method }}</dt><dd><code>{{ detailRecord.method }}</code></dd></div>
        <div><dt>{{ copy.category }}</dt><dd>{{ formatCategory(detailRecord) }}</dd></div>
        <div><dt>{{ copy.status }}</dt><dd>{{ formatStatus(detailRecord) }}</dd></div>
        <div><dt>{{ copy.duration }}</dt><dd>{{ detailRecord.durationMs }} ms</dd></div>
        <div v-if="detailRecord.errorCode"><dt>{{ copy.errorCode }}</dt><dd><code>{{ detailRecord.errorCode }}</code></dd></div>
        <div class="request-detail-path"><dt>{{ copy.path }}</dt><dd><pre>{{ detailRecord.path }}</pre></dd></div>
      </dl>
    </el-drawer>
  </div>
</template>

<style scoped>
.history-content { height: 100%; padding: 28px 32px; overflow: auto; }
.history-toolbar { display: flex; min-height: 40px; align-items: center; gap: 8px; margin-bottom: 12px; }
.history-toolbar small { margin-left: auto; color: var(--color-text-muted); white-space: nowrap; }
.connection-filter { width: 190px; }
.time-filter { width: 390px; }
.el-alert { margin-bottom: 12px; }
.history-request-path :deep(.cell) { font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace; }
.history-pagination { display: flex; min-height: 44px; align-items: end; justify-content: flex-end; gap: 12px; color: var(--color-text-secondary); font-size: 12px; }
.request-detail-list { display: grid; gap: 0; margin: 0; }
.request-detail-list > div { display: grid; grid-template-columns: 110px minmax(0, 1fr); gap: 14px; padding: 11px 0; border-bottom: 1px solid var(--color-line); }
.request-detail-list dt { color: var(--color-text-muted); font-size: 11px; }
.request-detail-list dd { min-width: 0; margin: 0; color: var(--color-text); font-size: 12px; }
.request-detail-list code, .request-detail-list pre { font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace; }
.request-detail-path { grid-template-columns: 1fr !important; }
.request-detail-path pre { max-height: 360px; margin: 0; padding: 12px; overflow: auto; border: 1px solid var(--color-line); border-radius: 4px; background: var(--color-panel-muted); line-height: 1.6; overflow-wrap: anywhere; white-space: pre-wrap; word-break: break-word; }
@media (max-width: 900px) {
  .history-toolbar { flex-wrap: wrap; }
  .history-toolbar small { width: 100%; margin-left: 0; }
  .time-filter { width: min(390px, 100%); }
}
</style>
