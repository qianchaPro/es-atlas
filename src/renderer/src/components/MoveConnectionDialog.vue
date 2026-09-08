<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { ConnectionGroup, ConnectionSummary } from '../../../shared/types/connection'

const UNGROUPED_VALUE = '__ungrouped__'

const props = withDefaults(defineProps<{
  visible: boolean
  connection: ConnectionSummary | null
  groups: ConnectionGroup[]
  busy: boolean
  error: string
  language?: string
}>(), {
  language: 'zh-CN'
})

const emit = defineEmits<{
  'update:visible': [visible: boolean]
  move: [connectionId: string, groupId: string | null]
}>()

const messages = {
  'zh-CN': {
    title: '移动连接',
    ungrouped: '未分组',
    cancel: '取消',
    move: '移动'
  },
  'en-US': {
    title: 'Move connection',
    ungrouped: 'Ungrouped',
    cancel: 'Cancel',
    move: 'Move'
  }
} as const

const targetGroupId = ref(UNGROUPED_VALUE)
const copy = computed(() => messages[props.language === 'en-US' ? 'en-US' : 'zh-CN'])
const dialogTitle = computed(() => `${copy.value.title} · ${props.connection?.name ?? ''}`)
const dialogVisible = computed({
  get: () => props.visible,
  set: (visible: boolean) => emit('update:visible', visible)
})

watch(
  () => [props.visible, props.connection] as const,
  ([visible, connection]) => {
    if (!visible) return
    targetGroupId.value = connection?.groupId ?? UNGROUPED_VALUE
  },
  { immediate: true }
)

function moveConnection(): void {
  if (!props.connection || props.busy) return
  const groupId = targetGroupId.value === UNGROUPED_VALUE ? null : targetGroupId.value
  if (groupId === props.connection.groupId) {
    dialogVisible.value = false
    return
  }
  emit('move', props.connection.id, groupId)
}
</script>

<template>
  <el-dialog
    v-model="dialogVisible"
    :title="dialogTitle"
    width="min(420px, calc(100vw - 48px))"
    class="move-connection-dialog"
    :close-on-click-modal="false"
    :close-on-press-escape="!busy"
    :show-close="!busy"
    align-center
  >
    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
    <el-radio-group v-model="targetGroupId" class="move-group-list">
      <el-radio :value="UNGROUPED_VALUE" class="move-group-option">
        <span class="group-swatch no-color" /><span>{{ copy.ungrouped }}</span>
      </el-radio>
      <el-radio v-for="group in groups" :key="group.id" :value="group.id" class="move-group-option">
        <span
          class="group-swatch"
          :class="{ 'no-color': !group.color }"
          :style="group.color ? { '--group-color': group.color } : undefined"
        /><span>{{ group.name }}</span>
      </el-radio>
    </el-radio-group>
    <template #footer>
      <el-button :disabled="busy" @click="dialogVisible = false">{{ copy.cancel }}</el-button>
      <el-button type="primary" :loading="busy" :disabled="!connection" @click="moveConnection">{{ copy.move }}</el-button>
    </template>
  </el-dialog>
</template>
