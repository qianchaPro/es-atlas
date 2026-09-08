<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Delete, Download, Refresh, Search, Setting, View } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type {
  AppLog,
  LogApi,
  LogConnectionOption,
  LogExportFormat,
  LogFilter,
  LogLevel,
  LogRetentionPolicy,
  LogSortOrder
} from '../../../shared/types/log'

const props = withDefaults(
  defineProps<{
    api: LogApi
    connectionOptions?: LogConnectionOption[]
    initialConnectionId?: string | null
    language?: 'zh-CN' | 'en-US'
    mode?: 'global' | 'slow'
    retentionPolicy?: LogRetentionPolicy
  }>(),
  {
    connectionOptions: () => [],
    initialConnectionId: null,
    language: 'zh-CN',
    mode: 'global',
    retentionPolicy: () => ({ maxAgeDays: 30, maxRecords: 100_000 })
  }
)

const messages = {
  'zh-CN': {
    allConnections: '全部连接',
    currentConnection: '当前连接',
    allLevels: '全部级别',
    keyword: '搜索操作、路径、摘要或追踪 ID',
    timeRange: '时间范围',
    startTime: '开始时间',
    endTime: '结束时间',
    statusCode: '状态码',
    search: '查询',
    refresh: '刷新',
    reset: '重置',
    clear: '清空当前筛选',
    export: '导出脱敏日志',
    retention: '保留策略',
    time: '时间',
    connection: '连接',
    level: '级别',
    operation: '操作',
    request: '请求',
    status: '状态',
    duration: '耗时',
    message: '摘要',
    detail: '详情',
    logDetail: '日志详情',
    traceId: '追踪 ID',
    path: '路径',
    errorSummary: '错误摘要',
    redacted: '已脱敏',
    noRecords: '暂无日志',
    loadFailed: '加载日志失败',
    totalRecords: '共 {count} 条',
    clearTitle: '确认清空日志',
    clearMessage: '将永久清空当前筛选命中的 {count} 条日志。',
    confirmClear: '确认清空',
    cancel: '取消',
    clearSucceeded: '已清空 {count} 条日志',
    clearFailed: '清空日志失败',
    exportSucceeded: '已导出 {count} 条日志',
    exportFailed: '导出日志失败',
    maxAgeDays: '保留天数',
    maxRecords: '最大条数',
    save: '保存',
    retentionSucceeded: '保留策略已更新，清理 {count} 条',
    retentionFailed: '更新保留策略失败',
    slowOnly: '仅看慢日志',
    slowThreshold: '慢日志阈值',
    milliseconds: '毫秒',
    unknownConnection: '未知连接',
    ascending: '最早优先',
    descending: '最新优先',
    yes: '是',
    no: '否'
  },
  'en-US': {
    allConnections: 'All connections',
    currentConnection: 'Current connection',
    allLevels: 'All levels',
    keyword: 'Search operation, path, summary, or trace ID',
    timeRange: 'Time range',
    startTime: 'Start time',
    endTime: 'End time',
    statusCode: 'Status',
    search: 'Search',
    refresh: 'Refresh',
    reset: 'Reset',
    clear: 'Clear filtered logs',
    export: 'Export redacted logs',
    retention: 'Retention policy',
    time: 'Time',
    connection: 'Connection',
    level: 'Level',
    operation: 'Operation',
    request: 'Request',
    status: 'Status',
    duration: 'Duration',
    message: 'Message',
    detail: 'Details',
    logDetail: 'Log details',
    traceId: 'Trace ID',
    path: 'Path',
    errorSummary: 'Error summary',
    redacted: 'Redacted',
    noRecords: 'No logs',
    loadFailed: 'Failed to load logs',
    totalRecords: '{count} records',
    clearTitle: 'Confirm log clearing',
    clearMessage: 'Permanently clear {count} logs matching the current filters.',
    confirmClear: 'Clear logs',
    cancel: 'Cancel',
    clearSucceeded: 'Cleared {count} logs',
    clearFailed: 'Failed to clear logs',
    exportSucceeded: 'Exported {count} logs',
    exportFailed: 'Failed to export logs',
    maxAgeDays: 'Retention days',
    maxRecords: 'Maximum records',
    save: 'Save',
    retentionSucceeded: 'Retention updated; removed {count} logs',
    retentionFailed: 'Failed to update retention',
    slowOnly: 'Slow logs only',
    slowThreshold: 'Slow log threshold',
    milliseconds: 'ms',
    unknownConnection: 'Unknown connection',
    ascending: 'Oldest first',
    descending: 'Newest first',
    yes: 'Yes',
    no: 'No'
  }
} as const

const SLOW_LOG_THRESHOLD_MS = 1_000
const PAGE_SIZE = 30
const copy = computed(() => messages[props.language])
const selectedConnectionId = ref<string | null>(props.initialConnectionId)
const selectedLevel = ref<LogLevel | null>(null)
const selectedTimeRange = ref<[Date, Date] | null>(null)
const keyword = ref('')
const statusCode = ref<number | null>(null)
const sortOrder = ref<LogSortOrder>('desc')
const slowOnly = ref(props.mode === 'slow')
const slowThresholdMs = ref(SLOW_LOG_THRESHOLD_MS)
const records = ref<AppLog[]>([])
const storedConnectionOptions = ref<LogConnectionOption[]>([])
const currentPage = ref(1)
const total = ref(0)
const loading = ref(false)
const actionLoading = ref(false)
const errorMessage = ref('')
const detailRecord = ref<AppLog | null>(null)
const retentionVisible = ref(false)
const retentionDraft = ref<LogRetentionPolicy>({ ...props.retentionPolicy })
let requestGeneration = 0

const availableConnections = computed<LogConnectionOption[]>(() => {
  const namesById = new Map<string, string>()
  for (const option of [...props.connectionOptions, ...storedConnectionOptions.value]) {
    if (!namesById.has(option.id)) namesById.set(option.id, option.name)
  }
  return [...namesById.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((left, right) => left.name.localeCompare(right.name, props.language))
})
const currentConnectionName = computed(() =>
  availableConnections.value.find((option) => option.id === props.initialConnectionId)?.name ??
  copy.value.unknownConnection
)
const levelOptions: LogLevel[] = ['debug', 'info', 'warn', 'error']

watch(
  [() => props.initialConnectionId, () => props.mode],
  ([connectionId]) => {
    selectedConnectionId.value = connectionId
    slowOnly.value = props.mode === 'slow'
    slowThresholdMs.value = SLOW_LOG_THRESHOLD_MS
    currentPage.value = 1
    void loadLogs()
  },
  { immediate: true }
)

async function loadLogs(): Promise<void> {
  const generation = ++requestGeneration
  loading.value = true
  errorMessage.value = ''
  if (props.mode === 'slow' && !props.initialConnectionId) {
    records.value = []
    total.value = 0
    loading.value = false
    return
  }
  try {
    const page = await props.api.query({
      ...buildFilter(),
      page: currentPage.value,
      pageSize: PAGE_SIZE,
      sortOrder: sortOrder.value
    })
    if (generation !== requestGeneration) return
    records.value = page.records
    total.value = page.total
    storedConnectionOptions.value = page.connections
  } catch (error: unknown) {
    if (generation !== requestGeneration) return
    errorMessage.value = withErrorContext(copy.value.loadFailed, error)
  } finally {
    if (generation === requestGeneration) loading.value = false
  }
}

function buildFilter(): LogFilter {
  return {
    connectionId: props.mode === 'slow' ? props.initialConnectionId : selectedConnectionId.value,
    level: selectedLevel.value,
    startedAt: selectedTimeRange.value?.[0].toISOString() ?? null,
    endedAt: selectedTimeRange.value?.[1].toISOString() ?? null,
    keyword: keyword.value.trim() || null,
    statusCode: statusCode.value,
    minimumDurationMs: slowOnly.value ? slowThresholdMs.value : null
  }
}

function searchLogs(): void {
  currentPage.value = 1
  void loadLogs()
}

function resetFilters(): void {
  selectedConnectionId.value = props.initialConnectionId
  selectedLevel.value = null
  selectedTimeRange.value = null
  keyword.value = ''
  statusCode.value = null
  sortOrder.value = 'desc'
  slowOnly.value = props.mode === 'slow'
  slowThresholdMs.value = SLOW_LOG_THRESHOLD_MS
  currentPage.value = 1
  void loadLogs()
}

function changePage(page: number): void {
  currentPage.value = page
  void loadLogs()
}

async function clearLogs(): Promise<void> {
  if (total.value === 0 || actionLoading.value) return
  try {
    await ElMessageBox.confirm(
      replaceCount(copy.value.clearMessage, total.value),
      copy.value.clearTitle,
      {
        type: 'warning',
        confirmButtonText: copy.value.confirmClear,
        cancelButtonText: copy.value.cancel
      }
    )
  } catch (error: unknown) {
    if (error === 'cancel' || error === 'close') return
    ElMessage.error(withErrorContext(copy.value.clearFailed, error))
    return
  }

  actionLoading.value = true
  try {
    const result = await props.api.clear(buildFilter())
    ElMessage.success(replaceCount(copy.value.clearSucceeded, result.deleted))
    currentPage.value = 1
    await loadLogs()
  } catch (error: unknown) {
    ElMessage.error(withErrorContext(copy.value.clearFailed, error))
  } finally {
    actionLoading.value = false
  }
}

async function exportLogs(format: LogExportFormat): Promise<void> {
  if (actionLoading.value) return
  actionLoading.value = true
  try {
    const result = await props.api.export(buildFilter(), format)
    if (!result.canceled) {
      ElMessage.success(replaceCount(copy.value.exportSucceeded, result.recordCount))
    }
  } catch (error: unknown) {
    ElMessage.error(withErrorContext(copy.value.exportFailed, error))
  } finally {
    actionLoading.value = false
  }
}

async function updateRetention(): Promise<void> {
  if (actionLoading.value) return
  actionLoading.value = true
  try {
    const result = await props.api.updateRetention({ ...retentionDraft.value })
    retentionDraft.value = { ...result.policy }
    retentionVisible.value = false
    ElMessage.success(replaceCount(copy.value.retentionSucceeded, result.totalDeleted))
    currentPage.value = 1
    await loadLogs()
  } catch (error: unknown) {
    ElMessage.error(withErrorContext(copy.value.retentionFailed, error))
  } finally {
    actionLoading.value = false
  }
}

function formatTime(value: string): string {
  return new Date(value).toLocaleString(props.language, { hour12: false })
}

function formatRequest(record: AppLog): string {
  if (!record.method && !record.path) return '--'
  return [record.method, record.path].filter(Boolean).join(' ')
}

function formatStatus(record: AppLog): string {
  return record.statusCode === null ? '--' : String(record.statusCode)
}

function formatDuration(record: AppLog): string {
  return record.durationMs === null ? '--' : `${record.durationMs} ms`
}

function levelTagType(level: LogLevel): 'info' | 'success' | 'warning' | 'danger' {
  if (level === 'error') return 'danger'
  if (level === 'warn') return 'warning'
  if (level === 'info') return 'success'
  return 'info'
}

function replaceCount(value: string, count: number): string {
  return value.replace('{count}', String(count))
}

function withErrorContext(context: string, error: unknown): string {
  return error instanceof Error && error.message ? `${context}：${error.message}` : context
}
</script>

<template>
  <section class="log-page">
    <div class="log-toolbar">
      <el-select
        v-if="mode === 'global'"
        v-model="selectedConnectionId"
        clearable
        :placeholder="copy.allConnections"
        class="connection-filter"
      >
        <el-option v-for="option in availableConnections" :key="option.id" :label="option.name" :value="option.id" />
      </el-select>
      <el-tag v-else effect="plain" size="large">
        {{ copy.currentConnection }}: {{ currentConnectionName }}
      </el-tag>
      <el-select v-model="selectedLevel" clearable :placeholder="copy.allLevels" class="level-filter">
        <el-option v-for="level in levelOptions" :key="level" :label="level.toUpperCase()" :value="level" />
      </el-select>
      <el-date-picker
        v-model="selectedTimeRange"
        type="datetimerange"
        :range-separator="'-'"
        :start-placeholder="copy.startTime"
        :end-placeholder="copy.endTime"
        class="time-filter"
      />
      <el-input v-model="keyword" clearable :placeholder="copy.keyword" class="keyword-filter" @keyup.enter="searchLogs" />
      <el-input-number
        v-model="statusCode"
        :min="100"
        :max="599"
        :controls="false"
        :placeholder="copy.statusCode"
        class="status-filter"
      />
      <el-select v-model="sortOrder" class="sort-filter" @change="searchLogs">
        <el-option :label="copy.descending" value="desc" />
        <el-option :label="copy.ascending" value="asc" />
      </el-select>
      <el-tooltip :content="copy.search" placement="top">
        <el-button type="primary" :icon="Search" :aria-label="copy.search" @click="searchLogs" />
      </el-tooltip>
      <el-tooltip :content="copy.refresh" placement="top">
        <el-button :icon="Refresh" :aria-label="copy.refresh" :loading="loading" @click="loadLogs" />
      </el-tooltip>
      <el-button @click="resetFilters">{{ copy.reset }}</el-button>
    </div>

    <div class="log-actions">
      <div class="log-summary-controls">
        <span>{{ replaceCount(copy.totalRecords, total) }}</span>
        <div class="slow-log-filter">
          <el-switch
            v-model="slowOnly"
            size="small"
            :disabled="mode === 'slow'"
            :aria-label="copy.slowOnly"
            @change="searchLogs"
          />
          <span>{{ copy.slowOnly }}</span>
          <el-input-number
            v-model="slowThresholdMs"
            :min="1"
            :max="600000"
            :step="100"
            :controls="false"
            :disabled="!slowOnly"
            :aria-label="copy.slowThreshold"
            class="slow-threshold-input"
            @change="searchLogs"
          />
          <span>{{ copy.milliseconds }}</span>
        </div>
      </div>
      <div>
        <el-tooltip :content="copy.retention" placement="top">
          <el-button :icon="Setting" :aria-label="copy.retention" :disabled="actionLoading" @click="retentionVisible = true" />
        </el-tooltip>
        <el-dropdown :disabled="actionLoading" @command="exportLogs">
          <el-button :icon="Download">{{ copy.export }}</el-button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="json">JSON</el-dropdown-item>
              <el-dropdown-item command="csv">CSV</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
        <el-button
          type="danger"
          plain
          :icon="Delete"
          :disabled="total === 0 || actionLoading"
          @click="clearLogs"
        >{{ copy.clear }}</el-button>
      </div>
    </div>

    <div class="log-table-region">
      <el-alert v-if="errorMessage" :title="errorMessage" type="error" :closable="false" show-icon />
      <el-table v-loading="loading" :data="records" height="100%" size="small" :empty-text="copy.noRecords">
      <el-table-column :label="copy.time" width="168">
        <template #default="{ row }: { row: AppLog }">{{ formatTime(row.createdAt) }}</template>
      </el-table-column>
      <el-table-column :label="copy.connection" width="140" show-overflow-tooltip>
        <template #default="{ row }: { row: AppLog }">{{ row.connectionName ?? row.connectionId ?? '--' }}</template>
      </el-table-column>
      <el-table-column :label="copy.level" width="82">
        <template #default="{ row }: { row: AppLog }">
          <el-tag :type="levelTagType(row.level)" effect="plain" size="small">{{ row.level.toUpperCase() }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="operation" :label="copy.operation" min-width="150" show-overflow-tooltip />
      <el-table-column :label="copy.request" min-width="260" show-overflow-tooltip class-name="log-request-cell">
        <template #default="{ row }: { row: AppLog }">{{ formatRequest(row) }}</template>
      </el-table-column>
      <el-table-column :label="copy.status" width="76" align="center">
        <template #default="{ row }: { row: AppLog }">{{ formatStatus(row) }}</template>
      </el-table-column>
      <el-table-column :label="copy.duration" width="92" align="right">
        <template #default="{ row }: { row: AppLog }">{{ formatDuration(row) }}</template>
      </el-table-column>
      <el-table-column prop="message" :label="copy.message" min-width="220" show-overflow-tooltip />
      <el-table-column :label="copy.detail" width="58" align="center">
        <template #default="{ row }: { row: AppLog }">
          <el-tooltip :content="copy.logDetail" placement="left">
            <el-button text circle :icon="View" :aria-label="copy.logDetail" @click="detailRecord = row" />
          </el-tooltip>
        </template>
      </el-table-column>
      </el-table>
    </div>

    <div class="log-pagination">
      <span>{{ replaceCount(copy.totalRecords, total) }}</span>
      <el-pagination
        background
        layout="prev, pager, next"
        :total="total"
        :page-size="PAGE_SIZE"
        :current-page="currentPage"
        @current-change="changePage"
      />
    </div>

    <el-drawer
      :model-value="Boolean(detailRecord)"
      :title="copy.logDetail"
      size="min(620px, 88vw)"
      append-to-body
      @close="detailRecord = null"
    >
      <dl v-if="detailRecord" class="log-detail-list">
        <div><dt>{{ copy.time }}</dt><dd>{{ formatTime(detailRecord.createdAt) }}</dd></div>
        <div><dt>{{ copy.connection }}</dt><dd>{{ detailRecord.connectionName ?? detailRecord.connectionId ?? '--' }}</dd></div>
        <div><dt>{{ copy.level }}</dt><dd>{{ detailRecord.level.toUpperCase() }}</dd></div>
        <div><dt>{{ copy.operation }}</dt><dd><code>{{ detailRecord.operation }}</code></dd></div>
        <div><dt>{{ copy.traceId }}</dt><dd><code>{{ detailRecord.traceId }}</code></dd></div>
        <div><dt>{{ copy.status }}</dt><dd>{{ formatStatus(detailRecord) }}</dd></div>
        <div><dt>{{ copy.duration }}</dt><dd>{{ formatDuration(detailRecord) }}</dd></div>
        <div><dt>{{ copy.redacted }}</dt><dd>{{ detailRecord.redacted ? copy.yes : copy.no }}</dd></div>
        <div v-if="detailRecord.path" class="wide-detail"><dt>{{ copy.path }}</dt><dd><pre>{{ detailRecord.path }}</pre></dd></div>
        <div class="wide-detail"><dt>{{ copy.message }}</dt><dd><pre>{{ detailRecord.message }}</pre></dd></div>
        <div v-if="detailRecord.errorSummary" class="wide-detail"><dt>{{ copy.errorSummary }}</dt><dd><pre>{{ detailRecord.errorSummary }}</pre></dd></div>
      </dl>
    </el-drawer>

    <el-dialog v-model="retentionVisible" :title="copy.retention" width="420px" append-to-body>
      <el-form label-position="top">
        <el-form-item :label="copy.maxAgeDays">
          <el-input-number v-model="retentionDraft.maxAgeDays" :min="1" :max="3650" controls-position="right" />
        </el-form-item>
        <el-form-item :label="copy.maxRecords">
          <el-input-number v-model="retentionDraft.maxRecords" :min="1" :max="1000000" controls-position="right" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="retentionVisible = false">{{ copy.cancel }}</el-button>
        <el-button type="primary" :loading="actionLoading" @click="updateRetention">{{ copy.save }}</el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.log-page {
  display: grid;
  min-width: 0;
  height: 100%;
  grid-template-rows: auto auto minmax(280px, 1fr) auto;
  gap: 10px;
  padding: 12px 14px;
  overflow: hidden;
}

.log-toolbar,
.log-actions,
.log-pagination {
  display: flex;
  align-items: center;
  gap: 8px;
}

.log-toolbar {
  flex-wrap: wrap;
}

.log-actions,
.log-pagination {
  justify-content: space-between;
  color: var(--color-text-secondary);
  font-size: 12px;
}

.log-actions > div {
  display: flex;
  gap: 8px;
}

.log-summary-controls {
  min-width: 0;
  align-items: center;
  flex-wrap: wrap;
}

.slow-log-filter {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 7px;
  padding-left: 10px;
  border-left: 1px solid var(--color-line);
}

.slow-threshold-input {
  width: 104px;
}

.log-table-region {
  display: grid;
  min-height: 0;
  grid-template-rows: auto minmax(0, 1fr);
  gap: 8px;
}

.connection-filter {
  width: 180px;
}

.level-filter,
.sort-filter {
  width: 136px;
}

.time-filter {
  width: 350px;
}

.keyword-filter {
  width: min(320px, 100%);
}

.status-filter {
  width: 108px;
}

.log-request-cell :deep(.cell),
.log-detail-list code,
.log-detail-list pre {
  font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
}

.log-detail-list {
  display: grid;
  margin: 0;
}

.log-detail-list > div {
  display: grid;
  grid-template-columns: 110px minmax(0, 1fr);
  gap: 14px;
  padding: 10px 0;
  border-bottom: 1px solid var(--color-line);
}

.log-detail-list dt {
  color: var(--color-text-muted);
  font-size: 11px;
}

.log-detail-list dd {
  min-width: 0;
  margin: 0;
  color: var(--color-text);
  font-size: 12px;
}

.log-detail-list .wide-detail {
  grid-template-columns: 1fr;
}

.log-detail-list pre {
  max-height: 300px;
  margin: 0;
  padding: 10px;
  overflow: auto;
  border: 1px solid var(--color-line);
  border-radius: 4px;
  background: var(--color-panel-muted);
  line-height: 1.55;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
  word-break: break-word;
}

@media (max-width: 900px) {
  .log-page {
    overflow: auto;
  }

  .time-filter,
  .keyword-filter {
    width: min(100%, 420px);
  }

  .log-actions {
    align-items: flex-start;
    flex-direction: column;
  }

  .log-actions > div {
    flex-wrap: wrap;
  }

  .slow-log-filter {
    padding-left: 0;
    border-left: 0;
  }
}
</style>
