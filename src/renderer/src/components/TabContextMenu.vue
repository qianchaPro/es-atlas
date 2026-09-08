<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { WorkspaceTab } from '../../../shared/types/workspace'

const MENU_WIDTH = 184
const MENU_ESTIMATED_HEIGHT = 164
const VIEWPORT_GAP = 8

const props = defineProps<{
  visible: boolean
  x: number
  y: number
  tab: WorkspaceTab
  tabs: WorkspaceTab[]
}>()

const emit = defineEmits<{
  'update:visible': [visible: boolean]
  close: [tabId: string]
  'close-others': [tabId: string]
  'close-right': [tabId: string]
  'close-all': [workspaceId: string]
}>()

const menuElement = ref<HTMLDivElement | null>(null)
const workspaceTabs = computed(() =>
  props.tabs.filter((tab) => tab.workspaceId === props.tab.workspaceId)
)
const tabIndex = computed(() => workspaceTabs.value.findIndex((tab) => tab.id === props.tab.id))
const canCloseOthers = computed(() =>
  workspaceTabs.value.some((tab) => tab.id !== props.tab.id && tab.closable)
)
const canCloseRight = computed(() =>
  workspaceTabs.value.slice(tabIndex.value + 1).some((tab) => tab.closable)
)
const canCloseAll = computed(() => workspaceTabs.value.some((tab) => tab.closable))
const menuStyle = computed(() => {
  const maximumLeft = Math.max(VIEWPORT_GAP, window.innerWidth - MENU_WIDTH - VIEWPORT_GAP)
  const maximumTop = Math.max(VIEWPORT_GAP, window.innerHeight - MENU_ESTIMATED_HEIGHT - VIEWPORT_GAP)
  return {
    left: `${Math.max(VIEWPORT_GAP, Math.min(props.x, maximumLeft))}px`,
    top: `${Math.max(VIEWPORT_GAP, Math.min(props.y, maximumTop))}px`
  }
})

watch(
  () => props.visible,
  async (visible) => {
    if (!visible) return
    await nextTick()
    menuElement.value?.focus()
  }
)

onMounted(() => {
  window.addEventListener('pointerdown', handleWindowPointerDown, true)
  window.addEventListener('keydown', handleWindowKeydown)
  window.addEventListener('blur', closeMenu)
})

onBeforeUnmount(() => {
  window.removeEventListener('pointerdown', handleWindowPointerDown, true)
  window.removeEventListener('keydown', handleWindowKeydown)
  window.removeEventListener('blur', closeMenu)
})

function handleWindowPointerDown(event: PointerEvent): void {
  if (!props.visible || menuElement.value?.contains(event.target as Node)) return
  closeMenu()
}

function handleWindowKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && props.visible) closeMenu()
}

function closeMenu(): void {
  emit('update:visible', false)
}

function runCommand(
  enabled: boolean,
  event: 'close' | 'close-others' | 'close-right' | 'close-all'
): void {
  if (!enabled) return
  if (event === 'close-all') {
    emit(event, props.tab.workspaceId)
  } else if (event === 'close') {
    emit('close', props.tab.id)
  } else if (event === 'close-others') {
    emit('close-others', props.tab.id)
  } else {
    emit('close-right', props.tab.id)
  }
  closeMenu()
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="visible"
      ref="menuElement"
      class="tab-context-menu"
      :style="menuStyle"
      role="menu"
      tabindex="-1"
      :aria-label="`标签操作：${tab.title}`"
      @contextmenu.prevent
    >
      <button
        type="button"
        role="menuitem"
        :disabled="!tab.closable"
        @click="runCommand(tab.closable, 'close')"
      >
        关闭
      </button>
      <button
        type="button"
        role="menuitem"
        :disabled="!canCloseOthers"
        @click="runCommand(canCloseOthers, 'close-others')"
      >
        关闭其他
      </button>
      <button
        type="button"
        role="menuitem"
        :disabled="!canCloseRight"
        @click="runCommand(canCloseRight, 'close-right')"
      >
        关闭右侧
      </button>
      <span class="menu-separator" role="separator" />
      <button
        type="button"
        role="menuitem"
        :disabled="!canCloseAll"
        @click="runCommand(canCloseAll, 'close-all')"
      >
        关闭全部
      </button>
    </div>
  </Teleport>
</template>

<style scoped>
.tab-context-menu {
  position: fixed;
  z-index: 4000;
  width: 184px;
  padding: 4px;
  border: 1px solid var(--el-border-color-light);
  border-radius: 6px;
  background: var(--el-bg-color-overlay);
  box-shadow: var(--el-box-shadow-light);
  outline: none;
}

.tab-context-menu button {
  width: 100%;
  min-height: 34px;
  padding: 0 10px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--el-text-color-primary);
  font: inherit;
  letter-spacing: 0;
  text-align: left;
  cursor: pointer;
}

.tab-context-menu button:hover:not(:disabled),
.tab-context-menu button:focus-visible:not(:disabled) {
  background: var(--el-fill-color-light);
}

.tab-context-menu button:disabled {
  color: var(--el-text-color-disabled);
  cursor: not-allowed;
}

.menu-separator {
  display: block;
  height: 1px;
  margin: 4px 6px;
  background: var(--el-border-color-lighter);
}
</style>
