<script setup lang="ts">
import RequestHistoryContent from './RequestHistoryContent.vue'
import type { RequestHistoryConnectionOption } from '../../../shared/types/request-history'

const props = defineProps<{
  visible: boolean
  initialConnectionId: string | null
  connectionOptions: RequestHistoryConnectionOption[]
  language: 'zh-CN' | 'en-US'
}>()

const emit = defineEmits<{
  'update:visible': [value: boolean]
}>()
</script>

<template>
  <el-dialog
    :model-value="props.visible"
    :title="props.language === 'zh-CN' ? '请求历史' : 'Request history'"
    width="min(1120px, 92vw)"
    class="request-history-dialog"
    @update:model-value="emit('update:visible', $event)"
  >
    <RequestHistoryContent
      :active="props.visible"
      :initial-connection-id="props.initialConnectionId"
      :connection-options="props.connectionOptions"
      :language="props.language"
    />
  </el-dialog>
</template>
