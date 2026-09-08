<script setup lang="ts">
import RequestHistoryContent from './RequestHistoryContent.vue'
import type { RequestHistoryConnectionOption } from '../../../shared/types/request-history'

defineProps<{
  connectionOptions: RequestHistoryConnectionOption[]
  language: 'zh-CN' | 'en-US'
}>()
</script>

<template>
  <RequestHistoryContent
    :active="true"
    :initial-connection-id="null"
    :connection-options="connectionOptions"
    :language="language"
  />
</template>
