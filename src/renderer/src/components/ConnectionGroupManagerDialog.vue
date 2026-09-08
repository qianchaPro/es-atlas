<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { Check, Close, Delete, Edit, Plus } from '@element-plus/icons-vue'
import { ElMessageBox } from 'element-plus'
import type {
  ConnectionGroup,
  ConnectionGroupColor,
  CreateConnectionGroupInput,
  UpdateConnectionGroupInput
} from '../../../shared/types/connection'
import GroupColorPicker from './GroupColorPicker.vue'

const props = withDefaults(defineProps<{
  visible: boolean
  groups: ConnectionGroup[]
  memberCounts: Record<string, number>
  busy: boolean
  error: string
  language?: string
}>(), {
  language: 'zh-CN'
})

const emit = defineEmits<{
  'update:visible': [visible: boolean]
  create: [input: CreateConnectionGroupInput]
  update: [input: UpdateConnectionGroupInput]
  delete: [groupId: string]
}>()

const messages = {
  'zh-CN': {
    title: '管理连接分组',
    createSection: '新建分组',
    createPlaceholder: '例如：生产环境',
    colorPalette: '分组颜色',
    editColorPalette: '编辑分组颜色',
    create: '新建',
    existingSection: '已有分组',
    save: '保存',
    saveAriaLabel: '保存分组',
    cancel: '取消',
    cancelAriaLabel: '取消编辑分组',
    edit: '编辑分组',
    delete: '删除分组',
    empty: '暂无自定义分组',
    done: '完成',
    deleteTitle: '删除分组',
    deleteConfirm: '删除分组'
  },
  'en-US': {
    title: 'Manage connection groups',
    createSection: 'Create group',
    createPlaceholder: 'For example: Production',
    colorPalette: 'Group color',
    editColorPalette: 'Edit group color',
    create: 'Create',
    existingSection: 'Existing groups',
    save: 'Save',
    saveAriaLabel: 'Save group',
    cancel: 'Cancel',
    cancelAriaLabel: 'Cancel group editing',
    edit: 'Edit group',
    delete: 'Delete group',
    empty: 'No custom groups',
    done: 'Done',
    deleteTitle: 'Delete group',
    deleteConfirm: 'Delete group'
  }
} as const
const newGroup = reactive<CreateConnectionGroupInput>({ name: '', color: '#3d7fae' })
const editingGroupId = ref('')
const editingName = ref('')
const editingColor = ref<ConnectionGroupColor>('#3d7fae')

const copy = computed(() => messages[props.language === 'en-US' ? 'en-US' : 'zh-CN'])
const dialogVisible = computed({
  get: () => props.visible,
  set: (visible: boolean) => emit('update:visible', visible)
})

watch(
  () => props.visible,
  (visible) => {
    if (!visible) return
    newGroup.name = ''
    newGroup.color = '#3d7fae'
    cancelEditing()
  }
)

function createGroup(): void {
  if (!newGroup.name.trim() || props.busy) return
  emit('create', { name: newGroup.name.trim(), color: newGroup.color })
  newGroup.name = ''
}

function startEditing(group: ConnectionGroup): void {
  editingGroupId.value = group.id
  editingName.value = group.name
  editingColor.value = group.color
}

function cancelEditing(): void {
  editingGroupId.value = ''
  editingName.value = ''
  editingColor.value = '#3d7fae'
}

function saveEditing(): void {
  if (!editingGroupId.value || !editingName.value.trim() || props.busy) return
  emit('update', {
    id: editingGroupId.value,
    name: editingName.value.trim(),
    color: editingColor.value
  })
  cancelEditing()
}

function groupCountLabel(count: number): string {
  if (props.language === 'en-US') {
    return `${count} custom ${count === 1 ? 'group' : 'groups'}`
  }
  return `${count} 个自定义分组`
}

function memberCountLabel(count: number): string {
  if (props.language === 'en-US') {
    return `${count} ${count === 1 ? 'connection' : 'connections'}`
  }
  return `${count} 个连接`
}

async function confirmDelete(group: ConnectionGroup): Promise<void> {
  const memberCount = props.memberCounts[group.id] ?? 0
  try {
    await ElMessageBox.confirm(
      props.language === 'en-US'
        ? memberCount
          ? `Deleting “${group.name}” will move ${memberCountLabel(memberCount)} to Ungrouped.`
          : `Delete the empty group “${group.name}”?`
        : memberCount
          ? `删除分组“${group.name}”后，其中 ${memberCount} 个连接会移到“未分组”。`
          : `删除空分组“${group.name}”？`,
      copy.value.deleteTitle,
      {
        type: 'warning',
        confirmButtonText: copy.value.deleteConfirm,
        cancelButtonText: copy.value.cancel,
        customClass: 'connection-result-dialog is-warning'
      }
    )
  } catch {
    return
  }
  emit('delete', group.id)
}
</script>

<template>
  <el-dialog
    v-model="dialogVisible"
    :title="copy.title"
    width="min(620px, calc(100vw - 48px))"
    class="group-manager-dialog"
    :close-on-click-modal="false"
    :close-on-press-escape="!busy"
    :show-close="!busy"
    align-center
  >
    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />

    <section class="group-create-section">
      <div class="group-section-heading">
        <div><strong>{{ copy.createSection }}</strong></div>
      </div>
      <div class="group-editor-row">
        <el-input
          v-model="newGroup.name"
          maxlength="48"
          :placeholder="copy.createPlaceholder"
          @keyup.enter="createGroup"
        />
        <GroupColorPicker v-model="newGroup.color" :language="language" />
        <el-button type="primary" :icon="Plus" :disabled="!newGroup.name.trim()" :loading="busy" @click="createGroup">
          {{ copy.create }}
        </el-button>
      </div>
    </section>

    <section class="group-list-section">
      <div class="group-section-heading">
        <div><strong>{{ copy.existingSection }}</strong><small>{{ groupCountLabel(groups.length) }}</small></div>
      </div>
      <div v-if="groups.length" class="group-manager-list">
        <div v-for="group in groups" :key="group.id" class="group-manager-row">
          <template v-if="editingGroupId === group.id">
            <el-input v-model="editingName" maxlength="48" @keyup.enter="saveEditing" />
            <GroupColorPicker v-model="editingColor" :language="language" />
            <div class="group-row-actions">
              <el-tooltip :content="copy.save" placement="top">
                <el-button text circle :icon="Check" :aria-label="copy.saveAriaLabel" :disabled="!editingName.trim() || busy" @click="saveEditing" />
              </el-tooltip>
              <el-tooltip :content="copy.cancel" placement="top">
                <el-button text circle :icon="Close" :aria-label="copy.cancelAriaLabel" :disabled="busy" @click="cancelEditing" />
              </el-tooltip>
            </div>
          </template>
          <template v-else>
            <span
              class="group-swatch"
              :class="{ 'no-color': !group.color }"
              :style="group.color ? { '--group-color': group.color } : undefined"
            />
            <div class="group-manager-copy"><strong>{{ group.name }}</strong><small>{{ memberCountLabel(memberCounts[group.id] ?? 0) }}</small></div>
            <div class="group-row-actions">
              <el-tooltip :content="copy.edit" placement="top">
                <el-button text circle :icon="Edit" :aria-label="copy.edit" :disabled="busy" @click="startEditing(group)" />
              </el-tooltip>
              <el-tooltip :content="copy.delete" placement="top">
                <el-button text circle :icon="Delete" :aria-label="copy.delete" :disabled="busy" @click="confirmDelete(group)" />
              </el-tooltip>
            </div>
          </template>
        </div>
      </div>
      <div v-else class="group-manager-empty">{{ copy.empty }}</div>
    </section>

    <template #footer>
      <el-button :disabled="busy" @click="dialogVisible = false">{{ copy.done }}</el-button>
    </template>
  </el-dialog>
</template>
