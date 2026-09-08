<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, RefreshLeft } from '@element-plus/icons-vue'
import type { TrashApi, TrashRecordSummary } from '../../../shared/types/trash'

const props = withDefaults(defineProps<{
  api?: TrashApi
  language?: 'zh-CN' | 'en-US'
}>(), {
  language: 'zh-CN'
})

const api = props.api ?? window.electronAPI?.trash
const records = ref<TrashRecordSummary[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(20)
const loading = ref(false)
const error = ref('')
const restoringId = ref('')

function text(zh: string, en: string): string {
  return props.language === 'zh-CN' ? zh : en
}

async function loadRecords(targetPage = page.value): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    if (!api) {
      error.value = text('废纸篓接口尚未加载，请完全退出并重新启动 ES Atlas。', 'The trash API is not loaded. Fully quit and restart ES Atlas.')
      return
    }
    const result = await api.list({ page: targetPage, pageSize: pageSize.value })
    records.value = result.records
    total.value = result.total
    page.value = result.page
  } catch (reason: unknown) {
    error.value = reason instanceof Error ? reason.message : String(reason)
  } finally {
    loading.value = false
  }
}

function changePage(value: number): void {
  void loadRecords(value)
}

async function restore(record: TrashRecordSummary): Promise<void> {
  try {
    await ElMessageBox.confirm(
      text(`确认还原 ${record.kind === 'index' ? '索引' : '文档'}“${record.documentId ?? record.index}”？`, `Restore ${record.kind === 'index' ? 'index' : 'document'} "${record.documentId ?? record.index}"?`),
      text('确认还原', 'Confirm restore'),
      { type: 'warning', confirmButtonText: text('还原', 'Restore'), cancelButtonText: text('取消', 'Cancel') }
    )
  } catch (reason: unknown) {
    if (reason === 'cancel' || reason === 'close') return
    ElMessage.error(reason instanceof Error ? reason.message : String(reason))
    return
  }
  restoringId.value = record.id
  try {
    if (!api) {
      ElMessage.error(text('废纸篓接口尚未加载，请完全退出并重新启动 ES Atlas。', 'The trash API is not loaded. Fully quit and restart ES Atlas.'))
      return
    }
    const result = await api.restore(record.id)
    ElMessage.success(result.message)
    await loadRecords(1)
  } catch (reason: unknown) {
    ElMessage.error(reason instanceof Error ? reason.message : String(reason))
  } finally {
    restoringId.value = ''
  }
}

async function remove(record: TrashRecordSummary): Promise<void> {
  try {
    await ElMessageBox.confirm(
      text('删除后将无法恢复，是否继续？', 'This record cannot be restored after removal. Continue?'),
      text('永久删除记录', 'Remove trash record'),
      { type: 'error', confirmButtonText: text('永久删除', 'Remove'), cancelButtonText: text('取消', 'Cancel') }
    )
    if (!api) {
      ElMessage.error(text('废纸篓接口尚未加载，请完全退出并重新启动 ES Atlas。', 'The trash API is not loaded. Fully quit and restart ES Atlas.'))
      return
    }
    await api.remove(record.id)
    await loadRecords()
  } catch (reason: unknown) {
    if (reason !== 'cancel' && reason !== 'close') ElMessage.error(reason instanceof Error ? reason.message : String(reason))
  }
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString(props.language)
}

onMounted(() => { void loadRecords() })
</script>

<template>
  <section class="trash-page">
    <header class="page-heading trash-page-heading">
      <div>
        <span class="eyebrow">{{ text('本地快照', 'Local snapshots') }}</span>
        <h1>{{ text('废纸篓', 'Trash') }}</h1>
        <p>{{ text(`保留最近 30 天的删除和更新记录（共 ${total} 条）`, `Deleted and updated records kept for 30 days (${total})`) }}</p>
      </div>
      <el-button text circle :icon="RefreshLeft" :loading="loading" :aria-label="text('刷新废纸篓', 'Refresh trash')" @click="loadRecords" />
    </header>
    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
    <el-table v-loading="loading" :data="records" class="trash-table" row-key="id" :empty-text="text('暂无可恢复记录', 'No recoverable records')">
      <el-table-column :label="text('类型', 'Type')" width="100">
        <template #default="{ row }"><el-tag :type="row.kind === 'index' ? 'danger' : 'warning'" effect="plain">{{ row.kind === 'index' ? text('索引', 'Index') : text('文档', 'Document') }}</el-tag></template>
      </el-table-column>
      <el-table-column prop="connectionName" :label="text('连接', 'Connection')" min-width="150" />
      <el-table-column prop="index" :label="text('索引', 'Index')" min-width="180" />
      <el-table-column prop="documentId" :label="text('文档 ID', 'Document ID')" min-width="160">
        <template #default="{ row }">{{ row.documentId || '--' }}</template>
      </el-table-column>
      <el-table-column :label="text('操作', 'Operation')" width="100">
        <template #default="{ row }">{{ row.operation === 'delete' ? text('删除', 'Delete') : text('更新', 'Update') }}</template>
      </el-table-column>
      <el-table-column :label="text('删除/更新时间', 'Changed at')" min-width="180"><template #default="{ row }">{{ formatDate(row.createdAt) }}</template></el-table-column>
      <el-table-column :label="text('到期时间', 'Expires')" min-width="180"><template #default="{ row }">{{ formatDate(row.expiresAt) }}</template></el-table-column>
      <el-table-column :label="text('操作', 'Actions')" width="170" fixed="right">
        <template #default="{ row }">
          <el-button type="primary" size="small" :loading="restoringId === row.id" :icon="RefreshLeft" @click="restore(row)">{{ text('还原', 'Restore') }}</el-button>
          <el-button text type="danger" size="small" :icon="Delete" @click="remove(row)" />
        </template>
      </el-table-column>
    </el-table>
    <el-pagination
      v-if="total > pageSize"
      class="trash-pagination"
      background
      layout="prev, pager, next"
      :current-page="page"
      :page-size="pageSize"
      :total="total"
      @current-change="changePage"
    />
  </section>
</template>

<style scoped>
.trash-page { height: 100%; padding: 28px 32px; overflow: auto; }
.trash-page-heading { margin-bottom: 20px; }
.trash-page-heading p { margin: 8px 0 0; color: var(--color-text-secondary); }
.trash-table { margin-top: 16px; }
.trash-pagination { justify-content: flex-end; margin-top: 16px; }
</style>
