<script setup lang="ts">
import { computed } from 'vue'
import type { ConnectionGroupColor } from '../../../shared/types/connection'

const PREDEFINED_COLORS = [
  '#7d8791',
  '#c94f4f',
  '#db7437',
  '#bf8a20',
  '#2e8b68',
  '#3d7fae',
  '#8062a8'
]

const props = withDefaults(defineProps<{
  modelValue: ConnectionGroupColor
  language?: string
}>(), {
  language: 'zh-CN'
})

const emit = defineEmits<{
  'update:modelValue': [color: ConnectionGroupColor]
}>()

const colorValue = computed({
  get: () => props.modelValue,
  set: (value: string | null) => emit('update:modelValue', value as ConnectionGroupColor)
})
const noColorLabel = computed(() => props.language === 'en-US' ? 'No color' : '无颜色')
</script>

<template>
  <div class="group-color-picker-control">
    <el-color-picker
      v-model="colorValue"
      show-alpha
      color-format="hex"
      :predefine="PREDEFINED_COLORS"
      :aria-label="noColorLabel"
    />
    <span class="group-color-value">{{ colorValue ?? noColorLabel }}</span>
  </div>
</template>
