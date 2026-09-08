<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Clock,
  DataAnalysis,
  DArrowLeft,
  DArrowRight,
  Delete,
  Document,
  Download,
  Grid,
  Plus,
  Refresh,
  RefreshLeft,
  Search,
  SortDown,
  SortUp,
  Upload,
  View
} from '@element-plus/icons-vue'
import type { ConnectionSummary } from '../../../shared/types/connection'
import type {
  IndexApi,
  IndexBulkImportResult,
  IndexBulkOperation,
  IndexDocumentChange,
  IndexDocument,
  IndexDocumentsPage,
  IndexHealth,
  IndexCreateInput,
  IndexImportDocument,
  IndexMetadata,
  IndexSortOrder,
  IndexSummary
} from '../../../shared/types/index'
import {
  formatCellEditorValue,
  toIpcDocumentSource
} from './index-document-editing'

type IndexListSortField = 'name' | 'health' | 'documents' | 'store'
type DocumentViewMode = 'table' | 'json'
type DetailTab = 'documents' | 'mapping' | 'settings' | 'aliases' | 'stats'
type DocumentEditorMode = 'create' | 'edit'
type TransferScope = 'page' | 'query'
type ExportFormat = 'csv' | 'dsv' | 'json' | 'bulk' | 'dump'
type ImportFormat = 'csv' | 'json' | 'dump' | 'copy'
type CopyOperation = IndexBulkOperation
type DocumentSelectionMode = 'rows' | 'cells'

type DocumentTableColumn = {
  property?: string
  label?: string
}

type QueryHistoryEntry = {
  id: string
  index: string
  query: string
  sortField: string
  sortOrder: IndexSortOrder
  createdAt: string
}

type QuerySuggestion = {
  value: string
  label: string
  kind: string
  detail: string
  stage: 'field' | 'operator' | 'syntax'
}

type QueryAutocompleteInstance = {
  activated: boolean
  focus: () => void
  getData: (query: string) => Promise<void>
}

type MappingField = {
  name: string
  type: string
}

type CopyIndexInput = {
  sourceConnectionId: string
  sourceIndex: string
  targetConnectionId: string
  targetIndex: string
  createTargetIndex: boolean
  operation: CopyOperation
  batchSize: number
  throttleMs: number
  fieldMappings: Array<{ source: string; target: string }>
  query?: string
}

type LocalChangeOperation = 'create' | 'update' | 'delete'

type LocalDocumentChange = {
  localKey: string
  connectionId: string
  index: string
  id: string
  sequenceNumber: number | null
  primaryTerm: number | null
  operation: LocalChangeOperation
  source: Record<string, unknown>
  originalSource: Record<string, unknown>
  dirtyFields: string[]
}

type EditableDocument = IndexDocument & {
  localKey: string
  localOperation?: LocalChangeOperation
  dirtyFields: string[]
}

type CellEditorState = {
  localKey: string
  field: string
  value: string
  valueType: string
  touched: boolean
}

type IndexWorkspaceState = {
  queryText: string
  sortField: string
  sortOrder: IndexSortOrder
  pageFrom: number
  pageSize: number
  activeDetailTab: DetailTab
  documentViewMode: DocumentViewMode
}

type WritableIndexApi = IndexApi & {
  copyIndex?: (input: CopyIndexInput) => Promise<unknown>
}

const MAX_BROWSABLE_DOCUMENTS = 10_000
const DOCUMENT_ID_SELECTION_FIELD = '$metadata:_id'
const DOCUMENT_SCORE_SELECTION_FIELD = '$metadata:_score'

const props = withDefaults(
  defineProps<{
    connectionId: string
    connected: boolean
    defaultQuerySize: number
    language: string
  }>(),
  {
    defaultQuerySize: 50,
    language: 'zh-CN'
  }
)

const indicesApi: WritableIndexApi = window.electronAPI.indices
const importFileInput = ref<HTMLInputElement | null>(null)
const queryAutocomplete = ref<QueryAutocompleteInstance | null>(null)
const documentTableRegion = ref<HTMLDivElement | null>(null)

const indices = ref<IndexSummary[]>([])
const selectedIndexName = ref('')
const openedIndexNames = ref<string[]>([])
const indexWorkspaceStates = ref<Record<string, IndexWorkspaceState>>({})
const indexFilter = ref('')
const indexSortField = ref<IndexListSortField>('name')
const indexSortOrder = ref<IndexSortOrder>('asc')
const isIndexListLoading = ref(false)
const indexListError = ref('')
const indexListWarnings = ref<string[]>([])
const isCreateIndexDialogVisible = ref(false)
const createIndexName = ref('')
const createIndexSettingsJson = ref('')
const createIndexMappingsJson = ref('')
const createIndexAliasesJson = ref('')
const createIndexError = ref('')
const isCreatingIndex = ref(false)
const activeDetailTab = ref<DetailTab>('documents')
const metadata = ref<IndexMetadata | null>(null)
const isMetadataLoading = ref(false)
const isIndexDeleting = ref(false)
const metadataError = ref('')
const documentsPage = ref<IndexDocumentsPage | null>(null)
const isDocumentsLoading = ref(false)
const documentsError = ref('')
const queryText = ref('')
const sortField = ref('')
const sortOrder = ref<IndexSortOrder>('asc')
const documentViewMode = ref<DocumentViewMode>('table')
const pageFrom = ref(0)
const pageSize = ref(normalizeQuerySize(props.defaultQuerySize))
const queryHistory = ref<QueryHistoryEntry[]>([])
const operatorSuggestionQuery = ref('')
const historyStorageError = ref('')
const isDocumentEditorVisible = ref(false)
const documentEditorMode = ref<DocumentEditorMode>('create')
const documentEditorId = ref('')
const documentEditorJson = ref('{}')
const documentEditorError = ref('')
const isDocumentMutationLoading = ref(false)
const isImportDialogVisible = ref(false)
const importFormat = ref<ImportFormat>('json')
const importOperation = ref<CopyOperation>('index')
const importFile = ref<File | null>(null)
const importError = ref('')
const isImporting = ref(false)
const isExportDialogVisible = ref(false)
const exportFormat = ref<ExportFormat>('json')
const exportScope = ref<TransferScope>('page')
const exportDelimiter = ref(',')
const exportGzip = ref(false)
const exportIncludeHeader = ref(true)
const exportAlwaysQuote = ref(false)
const exportTranspose = ref(false)
const isExporting = ref(false)
const exportError = ref('')
const isCopyDialogVisible = ref(false)
const availableConnections = ref<ConnectionSummary[]>([])
const targetConnectionId = ref('')
const targetIndexName = ref('')
const createTargetIndex = ref(true)
const copyOperation = ref<CopyOperation>('index')
const copyBatchSize = ref(200)
const copyThrottleMs = ref(0)
const copyFieldMappings = ref<Array<{ source: string; target: string }>>([])
const copyError = ref('')
const isCopying = ref(false)
const localDocumentChanges = ref<Record<string, LocalDocumentChange>>({})
const selectedDocumentRows = ref<EditableDocument[]>([])
const lastSelectedRowIndex = ref<number | null>(null)
const selectedCellKeys = ref<string[]>([])
const cellSelectionAnchor = ref<{ rowIndex: number; columnIndex: number } | null>(null)
const documentSelectionMode = ref<DocumentSelectionMode | null>(null)
const editingCell = ref<CellEditorState | null>(null)
const isBulkPreviewVisible = ref(false)
const isCommittingChanges = ref(false)
const commitError = ref('')
let indexListGeneration = 0
let metadataGeneration = 0
let documentsGeneration = 0

const isEnglish = computed(() => props.language.toLowerCase().startsWith('en'))
const selectedIndex = computed(() =>
  indices.value.find((index) => index.name === selectedIndexName.value) ?? null
)
const openedIndices = computed(() =>
  openedIndexNames.value.flatMap((indexName) => {
    const index = indices.value.find((item) => item.name === indexName)
    return index ? [index] : []
  })
)
const filteredIndices = computed(() => {
  const keyword = indexFilter.value.trim().toLocaleLowerCase(props.language)
  const visibleIndices = keyword
    ? indices.value.filter((index) => index.name.toLocaleLowerCase(props.language).includes(keyword))
    : indices.value
  const direction = indexSortOrder.value === 'asc' ? 1 : -1

  return [...visibleIndices].sort((left, right) => {
    const comparison = compareIndices(left, right, indexSortField.value)
    if (comparison !== 0) return comparison * direction
    return left.name.localeCompare(right.name) * direction
  })
})
const currentPage = computed(() => Math.floor(pageFrom.value / pageSize.value) + 1)
const cappedDocumentTotal = computed(() =>
  Math.min(documentsPage.value?.total ?? 0, MAX_BROWSABLE_DOCUMENTS)
)
const lastPage = computed(() => Math.max(1, Math.ceil(cappedDocumentTotal.value / pageSize.value)))
const canGoToPreviousPage = computed(() => currentPage.value > 1)
const canGoToNextPage = computed(() => currentPage.value < lastPage.value)
const pageRangeText = computed(() => {
  if (!documentsPage.value?.total) return '0-0'
  return `${pageFrom.value + 1}-${Math.min(pageFrom.value + pageSize.value, cappedDocumentTotal.value)}`
})
const documentColumns = computed(() => {
  const fields = new Set<string>()
  for (const document of documentsPage.value?.documents ?? []) {
    Object.keys(document.source ?? {}).forEach((field) => fields.add(field))
  }
  extractMappingFields(metadata.value?.mapping)
    .filter((field) => !field.name.includes('.'))
    .forEach((field) => fields.add(field.name))
  return [...fields]
})
const selectableDocumentFields = computed(() => [
  DOCUMENT_ID_SELECTION_FIELD,
  DOCUMENT_SCORE_SELECTION_FIELD,
  ...documentColumns.value
])
const displayedDocuments = computed<EditableDocument[]>(() => {
  const serverRows = (documentsPage.value?.documents ?? []).map((document) => {
    const localKey = documentKey(props.connectionId, selectedIndexName.value, document.id)
    const change = localDocumentChanges.value[localKey]
    return {
      ...document,
      source: change ? { ...change.source } : document.source,
      localKey,
      localOperation: change?.operation,
      dirtyFields: change?.dirtyFields ?? []
    }
  })
  const createdRows = Object.values(localDocumentChanges.value)
    .filter(
      (change) =>
        change.connectionId === props.connectionId &&
        change.index === selectedIndexName.value &&
        change.operation === 'create'
    )
    .map((change): EditableDocument => ({
      id: change.id,
      index: change.index,
      score: null,
      sequenceNumber: null,
      primaryTerm: null,
      source: { ...change.source },
      fields: null,
      sortValues: [],
      localKey: change.localKey,
      localOperation: 'create',
      dirtyFields: change.dirtyFields
    }))
  return [...createdRows, ...serverRows]
})
const currentIndexChanges = computed(() =>
  Object.values(localDocumentChanges.value).filter(
    (change) => change.connectionId === props.connectionId && change.index === selectedIndexName.value
  )
)
const hasCurrentIndexChanges = computed(() => currentIndexChanges.value.length > 0)
const mappingFields = computed<MappingField[]>(() => extractMappingFields(metadata.value?.mapping))
const sortableFields = computed(() => {
  const fields = new Set<string>(['_score', '_doc'])
  const mappingTypes = new Map(mappingFields.value.map((field) => [field.name, field.type]))
  mappingFields.value
    .filter((field) => isSortableFieldType(field.type))
    .forEach((field) => fields.add(field.name))
  documentColumns.value
    .filter((field) => {
      const type = mappingTypes.get(field)
      return !type || isSortableFieldType(type)
    })
    .forEach((field) => fields.add(field))
  return [...fields]
})
const selectedIndexQueryHistory = computed(() =>
  queryHistory.value.filter((entry) => entry.index === selectedIndexName.value)
)
const currentConnection = computed(() =>
  availableConnections.value.find((connection) => connection.id === props.connectionId) ?? null
)
const writableTargetConnections = computed(() =>
  availableConnections.value.filter(
    (connection) => connection.status === 'connected' && !connection.readOnly
  )
)
const isCurrentConnectionReadOnly = computed(() => currentConnection.value?.readOnly === true)
const isLegacyWriteUnsupported = computed(() => {
  if (currentConnection.value?.engine?.toLowerCase() !== 'elasticsearch') return false
  const version = currentConnection.value?.version
  if (!version) return false
  const major = Number.parseInt(version.split('.')[0] ?? '', 10)
  return Number.isInteger(major) && major < 7
})
const isDocumentWriteDisabled = computed(() =>
  !currentConnection.value || isCurrentConnectionReadOnly.value || isLegacyWriteUnsupported.value
)
const documentWriteDisabledReason = computed(() => {
  if (!currentConnection.value) return text('正在读取连接写入能力', 'Loading connection write capability')
  if (isCurrentConnectionReadOnly.value) return text('当前连接为只读', 'The current connection is read-only')
  if (isLegacyWriteUnsupported.value) return text('批量编辑仅支持 Elasticsearch 7+', 'Bulk editing requires Elasticsearch 7+')
  return ''
})
const documentsJson = computed(() => JSON.stringify(displayedDocuments.value, null, 2))
const bulkPreviewText = computed(() => currentIndexChanges.value.flatMap((change) => {
  const operation = toCommitOperation(change.operation)
  const metadata: Record<string, unknown> = { _index: change.index }
  if (change.id) metadata._id = change.id
  if (change.sequenceNumber !== null && change.primaryTerm !== null && operation !== 'create') {
    metadata.if_seq_no = change.sequenceNumber
    metadata.if_primary_term = change.primaryTerm
  }
  const lines = [JSON.stringify({ [operation]: metadata })]
  if (operation !== 'delete') lines.push(JSON.stringify(change.source))
  return lines
}).join('\n'))
const indexSortOptions = computed(() => [
  { value: 'name', label: text('名称', 'Name') },
  { value: 'health', label: text('健康', 'Health') },
  { value: 'documents', label: text('文档数', 'Documents') },
  { value: 'store', label: text('存储', 'Store') }
])

function text(chinese: string, english: string): string {
  return isEnglish.value ? english : chinese
}

function getErrorMessage(error: unknown, chineseContext: string, englishContext: string): string {
  const context = text(chineseContext, englishContext)
  if (error instanceof Error && error.message) return `${context}: ${error.message}`
  return `${context}: ${text('未知错误', 'Unknown error')}`
}

function parseOptionalJsonObject(value: string, field: string): Record<string, unknown> | undefined {
  if (!value.trim()) return undefined
  const parsed: unknown = JSON.parse(value)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError(text(`${field}必须是 JSON 对象`, `${field} must be a JSON object`))
  }
  return parsed as Record<string, unknown>
}

function normalizeQuerySize(value: number): number {
  if (!Number.isInteger(value)) return 50
  return Math.min(Math.max(value, 1), 200)
}

function openCreateIndexDialog(): void {
  createIndexName.value = ''
  createIndexSettingsJson.value = ''
  createIndexMappingsJson.value = ''
  createIndexAliasesJson.value = ''
  createIndexError.value = ''
  isCreateIndexDialogVisible.value = true
}

async function createIndex(): Promise<void> {
  if (!props.connected || !props.connectionId || !currentConnection.value || isCurrentConnectionReadOnly.value || isCreatingIndex.value) return
  createIndexError.value = ''
  isCreatingIndex.value = true
  try {
    const input: IndexCreateInput = {
      connectionId: props.connectionId,
      index: createIndexName.value.trim(),
      settings: parseOptionalJsonObject(createIndexSettingsJson.value, text('Settings', 'Settings')),
      mappings: parseOptionalJsonObject(createIndexMappingsJson.value, text('Mapping', 'Mapping')),
      aliases: parseOptionalJsonObject(createIndexAliasesJson.value, text('Aliases', 'Aliases'))
    }
    if (!input.index) throw new TypeError(text('索引名称不能为空', 'Index name is required'))
    await indicesApi.createIndex(input)
    isCreateIndexDialogVisible.value = false
    ElMessage.success(text(`索引“${input.index}”已创建`, `Index "${input.index}" created`))
    await loadIndices()
    const createdIndex = indices.value.find((index) => index.name === input.index)
    if (createdIndex) selectIndex(createdIndex)
  } catch (error: unknown) {
    createIndexError.value = getErrorMessage(error, '创建索引失败', 'Failed to create index')
  } finally {
    isCreatingIndex.value = false
  }
}

function compareIndices(
  left: IndexSummary,
  right: IndexSummary,
  field: IndexListSortField
): number {
  if (field === 'name') return left.name.localeCompare(right.name)
  if (field === 'health') return healthRank(left.health) - healthRank(right.health)
  if (field === 'documents') {
    return compareNullableNumbers(left.documentCount, right.documentCount)
  }
  return compareNullableNumbers(left.storeSizeBytes, right.storeSizeBytes)
}

function compareNullableNumbers(left: number | null, right: number | null): number {
  if (left === null && right === null) return 0
  if (left === null) return 1
  if (right === null) return -1
  return left - right
}

function healthRank(health: IndexHealth): number {
  const ranks: Record<IndexHealth, number> = {
    green: 0,
    yellow: 1,
    red: 2,
    unknown: 3
  }
  return ranks[health]
}

function healthText(health: IndexHealth): string {
  const labels: Record<IndexHealth, [string, string]> = {
    green: ['健康', 'Green'],
    yellow: ['注意', 'Yellow'],
    red: ['异常', 'Red'],
    unknown: ['未知', 'Unknown']
  }
  return text(...labels[health])
}

function healthTagType(health: IndexHealth): 'success' | 'warning' | 'danger' | 'info' {
  if (health === 'green') return 'success'
  if (health === 'yellow') return 'warning'
  if (health === 'red') return 'danger'
  return 'info'
}

function formatCount(value: number | null): string {
  return value === null ? '--' : new Intl.NumberFormat(props.language).format(value)
}

function formatBytes(value: number | null): string {
  if (value === null) return '--'
  if (value < 1_024) return `${value} B`
  const units = ['KB', 'MB', 'GB', 'TB', 'PB']
  let size = value
  let unitIndex = -1
  do {
    size /= 1_024
    unitIndex += 1
  } while (size >= 1_024 && unitIndex < units.length - 1)
  return `${size >= 10 ? size.toFixed(1) : size.toFixed(2)} ${units[unitIndex]}`
}

function formatCellValue(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return '--'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return text('[无法显示]', '[Unrenderable]')
  }
}

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

function cellValueClass(value: unknown): string {
  if (value === null) return 'null-value'
  if (value === undefined) return 'undefined-value'
  if (typeof value === 'number') return 'number-value'
  if (typeof value === 'boolean') return 'boolean-value'
  if (typeof value === 'object') return 'object-value'
  return 'string-value'
}

function isSortableFieldType(type: string): boolean {
  return [
    'keyword', 'wildcard', 'constant_keyword', 'boolean', 'byte', 'short', 'integer', 'long',
    'unsigned_long', 'half_float', 'float', 'double', 'scaled_float', 'date', 'date_nanos', 'ip',
    'version'
  ].includes(type)
}

function extractMappingFields(mapping: Record<string, unknown> | undefined): MappingField[] {
  if (!mapping) return []
  const fields = new Map<string, string>()

  function visit(value: unknown, parentPath: string): void {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return
    const record = value as Record<string, unknown>
    const properties = record.properties
    if (properties && typeof properties === 'object' && !Array.isArray(properties)) {
      for (const [fieldName, rawDefinition] of Object.entries(properties)) {
        if (!rawDefinition || typeof rawDefinition !== 'object' || Array.isArray(rawDefinition)) continue
        const definition = rawDefinition as Record<string, unknown>
        const path = parentPath ? `${parentPath}.${fieldName}` : fieldName
        fields.set(path, typeof definition.type === 'string' ? definition.type : 'object')
        const multiFields = definition.fields
        if (multiFields && typeof multiFields === 'object' && !Array.isArray(multiFields)) {
          for (const [multiFieldName, rawMultiField] of Object.entries(multiFields)) {
            if (!rawMultiField || typeof rawMultiField !== 'object' || Array.isArray(rawMultiField)) continue
            const multiField = rawMultiField as Record<string, unknown>
            fields.set(
              `${path}.${multiFieldName}`,
              typeof multiField.type === 'string' ? multiField.type : 'keyword'
            )
          }
        }
        visit(definition, path)
      }
    }

    for (const [key, child] of Object.entries(record)) {
      if (key !== 'properties') visit(child, parentPath)
    }
  }

  visit(mapping, '')
  return [...fields.entries()]
    .map(([name, type]) => ({ name, type }))
    .sort((left, right) => left.name.localeCompare(right.name))
}

function queryCompletionItems(query: string): QuerySuggestion[] {
  if (operatorSuggestionQuery.value === query) {
    const operators = [
      { value: ':', label: ':', detail: text('等于', 'Equals') },
      { value: ':*', label: ': *', detail: text('字段存在', 'Exists') },
      { value: ':<', label: '<', detail: text('小于', 'Less than') },
      { value: ':<=', label: '<=', detail: text('小于或等于', 'Less than or equal') },
      { value: ':>', label: '>', detail: text('大于', 'Greater than') },
      { value: ':>=', label: '>=', detail: text('大于或等于', 'Greater than or equal') }
    ]
    return operators.map((operator) => ({
      value: `${query}${operator.value}`,
      label: operator.label,
      kind: text('操作符', 'Operator'),
      detail: operator.detail,
      stage: 'operator'
    }))
  }

  const tokenMatch = query.match(/(?:^|\s|\()([^\s()]*)$/)
  const token = tokenMatch?.[1] ?? ''
  if (!token) return []
  const prefix = query.slice(0, query.length - token.length)
  const keyword = token.toLocaleLowerCase(props.language)
  const fieldSuggestions = mappingFields.value
    .filter((field) => field.name.toLocaleLowerCase(props.language).includes(keyword))
    .slice(0, 40)
    .map((field) => ({
      value: `${prefix}${field.name}`,
      label: field.name,
      kind: text('字段', 'Field'),
      detail: field.type,
      stage: 'field' as const
    }))
  const syntaxSuggestions = querySyntaxSuggestions()
    .filter((item) => item.label.toLocaleLowerCase(props.language).includes(keyword))
    .map((item): QuerySuggestion => ({
      ...item,
      value: `${prefix}${item.value}`,
      kind: text('函数/语法', 'Function/Syntax'),
      stage: 'syntax'
    }))
  return [...fieldSuggestions, ...syntaxSuggestions].slice(0, 40)
}

function querySyntaxSuggestions(): Array<{ value: string; label: string; detail: string }> {
  const suggestions = [
    { value: '_exists_:', label: '_exists_:', detail: text('字段存在函数', 'Field exists function') },
    { value: '_id:', label: '_id:', detail: text('按文档 ID 查询', 'Query by document ID') },
    { value: '_index:', label: '_index:', detail: text('按索引名称查询', 'Query by index name') },
    { value: 'AND ', label: 'AND', detail: text('并且', 'Boolean AND') },
    { value: 'OR ', label: 'OR', detail: text('或者', 'Boolean OR') },
    { value: 'NOT ', label: 'NOT', detail: text('排除', 'Boolean NOT') }
  ]
  const engine = currentConnection.value?.engine?.trim().toLowerCase()
  const major = Number.parseInt(currentConnection.value?.version?.split('.')[0] ?? '', 10)
  if (engine === 'elasticsearch' && Number.isInteger(major) && major < 8) {
    suggestions.push({
      value: '_type:',
      label: '_type:',
      detail: text('旧版文档类型字段（Elasticsearch 7 及以下）', 'Legacy type field (Elasticsearch 7 and earlier)')
    })
  }
  if (engine === 'elasticsearch' && Number.isInteger(major) && major < 7) {
    suggestions.push({
      value: '_uid:',
      label: '_uid:',
      detail: text('旧版 UID 字段（Elasticsearch 6 及以下）', 'Legacy UID field (Elasticsearch 6 and earlier)')
    })
  }
  return suggestions
}

function fetchQuerySuggestions(query: string, callback: (items: QuerySuggestion[]) => void): void {
  callback(queryCompletionItems(query))
}

function handleQuerySuggestionSelect(suggestion: QuerySuggestion): void {
  if (suggestion.stage !== 'field') {
    operatorSuggestionQuery.value = ''
    return
  }
  operatorSuggestionQuery.value = suggestion.value
  void nextTick(async () => {
    const autocomplete = queryAutocomplete.value
    if (!autocomplete) return
    autocomplete.focus()
    autocomplete.activated = true
    await autocomplete.getData(suggestion.value)
  })
}

function handleQueryInput(value: string | number): void {
  if (String(value) !== operatorSuggestionQuery.value) operatorSuggestionQuery.value = ''
}

function handleQueryEnter(): void {
  if (operatorSuggestionQuery.value || /:(?:|[<>]=?)$/u.test(queryText.value.trim())) return
  runDocumentQuery()
}

function queryHistoryStorageKey(): string {
  return `es-atlas:query-history:${props.connectionId}`
}

function loadQueryHistory(): void {
  historyStorageError.value = ''
  if (!props.connectionId) {
    queryHistory.value = []
    return
  }
  try {
    const rawHistory = window.localStorage.getItem(queryHistoryStorageKey())
    const parsedHistory: unknown = rawHistory ? JSON.parse(rawHistory) : []
    queryHistory.value = Array.isArray(parsedHistory)
      ? parsedHistory.filter(isQueryHistoryEntry).slice(0, 30)
      : []
  } catch (error: unknown) {
    queryHistory.value = []
    historyStorageError.value = getErrorMessage(
      error,
      '读取查询历史失败',
      'Failed to read query history'
    )
  }
}

function isQueryHistoryEntry(value: unknown): value is QueryHistoryEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const entry = value as Partial<QueryHistoryEntry>
  return (
    typeof entry.id === 'string' &&
    typeof entry.index === 'string' &&
    typeof entry.query === 'string' &&
    typeof entry.sortField === 'string' &&
    (entry.sortOrder === 'asc' || entry.sortOrder === 'desc') &&
    typeof entry.createdAt === 'string'
  )
}

function recordCurrentQuery(): void {
  const query = queryText.value.trim()
  const field = sortField.value.trim()
  if (!selectedIndexName.value || (!query && !field)) return
  const entry: QueryHistoryEntry = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    index: selectedIndexName.value,
    query,
    sortField: field,
    sortOrder: sortOrder.value,
    createdAt: new Date().toISOString()
  }
  const deduplicated = queryHistory.value.filter(
    (item) =>
      !(
        item.index === entry.index &&
        item.query === entry.query &&
        item.sortField === entry.sortField &&
        item.sortOrder === entry.sortOrder
      )
  )
  queryHistory.value = [entry, ...deduplicated].slice(0, 30)
  persistQueryHistory()
}

function persistQueryHistory(): void {
  historyStorageError.value = ''
  try {
    window.localStorage.setItem(queryHistoryStorageKey(), JSON.stringify(queryHistory.value))
  } catch (error: unknown) {
    historyStorageError.value = getErrorMessage(
      error,
      '保存查询历史失败',
      'Failed to save query history'
    )
    ElMessage.error(historyStorageError.value)
  }
}

function applyQueryHistory(entry: QueryHistoryEntry): void {
  operatorSuggestionQuery.value = ''
  queryText.value = entry.query
  sortField.value = entry.sortField
  sortOrder.value = entry.sortOrder
  runDocumentQuery(false)
}

function clearQueryHistory(): void {
  queryHistory.value = queryHistory.value.filter((entry) => entry.index !== selectedIndexName.value)
  persistQueryHistory()
}

function formatHistoryTime(timestamp: string): string {
  const date = new Date(timestamp)
  return Number.isNaN(date.getTime()) ? '--' : date.toLocaleString(props.language)
}

async function loadAvailableConnections(): Promise<void> {
  try {
    availableConnections.value = await window.electronAPI.connections.list()
  } catch (error: unknown) {
    ElMessage.error(getErrorMessage(error, '加载连接列表失败', 'Failed to load connections'))
  }
}

function documentKey(connectionId: string, index: string, id: string): string {
  return `${connectionId}\u0000${index}\u0000${id}`
}

function toCommitOperation(operation: LocalChangeOperation): IndexDocumentChange['action'] {
  return operation === 'update' ? 'index' : operation
}

function isNumericMappingType(type: string): boolean {
  return [
    'byte', 'short', 'integer', 'long', 'unsigned_long', 'half_float', 'float', 'double',
    'scaled_float'
  ].includes(type)
}

function resolveCellValueType(field: string, value: unknown): string {
  const mappingType = mappingFields.value.find((item) => item.name === field)?.type
  if (mappingType) return mappingType
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function parseEditedCellValue(value: string, valueType: string): unknown {
  if (value.trim() === 'null') return null
  if (valueType === 'boolean') {
    if (value.trim() === 'true') return true
    if (value.trim() === 'false') return false
    throw new TypeError(text('布尔字段仅支持 true、false 或 null', 'Boolean fields accept true, false, or null'))
  }
  if (isNumericMappingType(valueType) || valueType === 'number') {
    const numberValue = Number(value.trim())
    if (!value.trim() || !Number.isFinite(numberValue)) {
      throw new TypeError(text('数值字段必须输入有效数字', 'A numeric field requires a valid number'))
    }
    if (Number.isInteger(numberValue) && !Number.isSafeInteger(numberValue)) {
      throw new TypeError(text('整数超出安全精度范围，请改用字符串字段保存', 'Integer exceeds safe precision; store it in a string field'))
    }
    return numberValue
  }
  if (valueType === 'object' || valueType === 'array' || valueType === 'nested') {
    const parsed: unknown = JSON.parse(value)
    if (valueType === 'array' && !Array.isArray(parsed)) {
      throw new TypeError(text('数组字段必须输入 JSON 数组', 'An array field requires a JSON array'))
    }
    if ((valueType === 'object' || valueType === 'nested') && (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))) {
      throw new TypeError(text('对象字段必须输入 JSON 对象', 'An object field requires a JSON object'))
    }
    return parsed
  }
  return value
}

function startCellEdit(row: EditableDocument, column: { property?: string }): void {
  const field = column.property ?? ''
  if (isDocumentWriteDisabled.value || isCommittingChanges.value || row.localOperation === 'delete' || !documentColumns.value.includes(field)) return
  const currentValue = row.source?.[field]
  editingCell.value = {
    localKey: row.localKey,
    field,
    value: formatCellEditorValue(currentValue),
    valueType: resolveCellValueType(field, currentValue),
    touched: false
  }
}

function markCellEditorTouched(): void {
  if (editingCell.value) editingCell.value.touched = true
}

function cancelCellEdit(): void {
  editingCell.value = null
}

function commitCellEdit(row: EditableDocument): void {
  const editor = editingCell.value
  if (!editor || editor.localKey !== row.localKey) return
  if (!editor.touched) {
    editingCell.value = null
    return
  }
  try {
    const value = parseEditedCellValue(editor.value, editor.valueType)
    const existingChange = localDocumentChanges.value[row.localKey]
    const serverDocument = documentsPage.value?.documents.find((document) => document.id === row.id)
    const originalSource = existingChange?.originalSource ?? { ...(serverDocument?.source ?? {}) }
    const nextSource = { ...(existingChange?.source ?? row.source ?? {}) }
    nextSource[editor.field] = value
    const dirtyFields = new Set(existingChange?.dirtyFields ?? [])
    const originalValue = originalSource[editor.field]
    if (JSON.stringify(value) === JSON.stringify(originalValue) && existingChange?.operation !== 'create') {
      dirtyFields.delete(editor.field)
    } else {
      dirtyFields.add(editor.field)
    }

    const operation = existingChange?.operation === 'create' ? 'create' : 'update'
    const nextChanges = { ...localDocumentChanges.value }
    if (operation === 'update' && dirtyFields.size === 0) {
      delete nextChanges[row.localKey]
    } else {
      nextChanges[row.localKey] = {
        localKey: row.localKey,
        connectionId: props.connectionId,
        index: selectedIndexName.value,
        id: row.id,
        sequenceNumber: existingChange?.sequenceNumber ?? row.sequenceNumber,
        primaryTerm: existingChange?.primaryTerm ?? row.primaryTerm,
        operation,
        source: nextSource,
        originalSource,
        dirtyFields: [...dirtyFields]
      }
    }
    localDocumentChanges.value = nextChanges
    editingCell.value = null
  } catch (error: unknown) {
    ElMessage.error(getErrorMessage(error, '单元格值无效', 'Invalid cell value'))
  }
}

function addLocalRow(): void {
  if (isDocumentWriteDisabled.value || isCommittingChanges.value || !selectedIndexName.value) return
  const id = crypto.randomUUID()
  const localKey = documentKey(props.connectionId, selectedIndexName.value, id)
  const source = Object.fromEntries(documentColumns.value.map((field) => [field, null]))
  localDocumentChanges.value = {
    ...localDocumentChanges.value,
    [localKey]: {
      localKey,
      connectionId: props.connectionId,
      index: selectedIndexName.value,
      id,
      sequenceNumber: null,
      primaryTerm: null,
      operation: 'create',
      source,
      originalSource: {},
      dirtyFields: [...documentColumns.value]
    }
  }
  void nextTick(() => {
    const createdRow = displayedDocuments.value.find((row) => row.localKey === localKey)
    if (!createdRow) return
    selectedDocumentRows.value = [createdRow]
    lastSelectedRowIndex.value = 0
  })
}

function isTextSelectionTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA'
}

function focusDocumentTable(): void {
  documentTableRegion.value?.focus({ preventScroll: true })
}

function activateRowSelection(): void {
  documentSelectionMode.value = 'rows'
  selectedCellKeys.value = []
  cellSelectionAnchor.value = null
  focusDocumentTable()
}

function activateCellSelection(): void {
  documentSelectionMode.value = 'cells'
  selectedDocumentRows.value = []
  lastSelectedRowIndex.value = null
  focusDocumentTable()
}

function handleDocumentSelectionKeydown(event: KeyboardEvent): void {
  if (
    event.key.toLowerCase() !== 'a' ||
    (!event.metaKey && !event.ctrlKey) ||
    event.altKey ||
    event.shiftKey ||
    isTextSelectionTarget(event.target) ||
    documentViewMode.value !== 'table' ||
    !displayedDocuments.value.length
  ) return

  event.preventDefault()
  event.stopPropagation()
  if (documentSelectionMode.value === 'cells') {
    selectedCellKeys.value = displayedDocuments.value.flatMap((row) =>
      selectableDocumentFields.value.map((field) => cellSelectionKey(row.localKey, field))
    )
    cellSelectionAnchor.value = { rowIndex: 0, columnIndex: 0 }
    return
  }

  documentSelectionMode.value = 'rows'
  selectedDocumentRows.value = [...displayedDocuments.value]
  lastSelectedRowIndex.value = displayedDocuments.value.length - 1
}

function handleRowNumberClick(row: EditableDocument, event: MouseEvent): void {
  const rowIndex = displayedDocuments.value.findIndex((item) => item.localKey === row.localKey)
  if (rowIndex < 0) return
  activateRowSelection()
  if (event.shiftKey && lastSelectedRowIndex.value !== null) {
    const start = Math.min(lastSelectedRowIndex.value, rowIndex)
    const end = Math.max(lastSelectedRowIndex.value, rowIndex)
    const range = displayedDocuments.value.slice(start, end + 1)
    const existing = event.metaKey || event.ctrlKey ? selectedDocumentRows.value : []
    const merged = new Map([...existing, ...range].map((item) => [item.localKey, item]))
    selectedDocumentRows.value = [...merged.values()]
  } else if (event.metaKey || event.ctrlKey) {
    const selected = selectedDocumentRows.value.some((item) => item.localKey === row.localKey)
    selectedDocumentRows.value = selected
      ? selectedDocumentRows.value.filter((item) => item.localKey !== row.localKey)
      : [...selectedDocumentRows.value, row]
  } else {
    selectedDocumentRows.value = [row]
  }
  lastSelectedRowIndex.value = rowIndex
}

function documentRowNumber(row: EditableDocument): string {
  if (row.localOperation === 'create') return '+'
  const serverIndex = documentsPage.value?.documents.findIndex((document) => document.id === row.id) ?? -1
  return serverIndex < 0 ? '--' : String(pageFrom.value + serverIndex + 1)
}

function cellSelectionKey(localKey: string, field: string): string {
  return `${localKey}\u0000${field}`
}

function documentSelectionField(column: DocumentTableColumn): string {
  if (column.label === '_id') return DOCUMENT_ID_SELECTION_FIELD
  if (column.label === '_score') return DOCUMENT_SCORE_SELECTION_FIELD
  const field = column.property ?? ''
  return documentColumns.value.includes(field) ? field : ''
}

function handleDocumentCellClick(
  row: EditableDocument,
  column: DocumentTableColumn,
  _cell: HTMLTableCellElement,
  event: MouseEvent
): void {
  if (isTextSelectionTarget(event.target)) return
  const field = documentSelectionField(column)
  const rowIndex = displayedDocuments.value.findIndex((item) => item.localKey === row.localKey)
  const columnIndex = selectableDocumentFields.value.indexOf(field)
  if (rowIndex < 0 || columnIndex < 0) return
  activateCellSelection()
  const key = cellSelectionKey(row.localKey, field)
  if (event.shiftKey && cellSelectionAnchor.value) {
    const rowStart = Math.min(cellSelectionAnchor.value.rowIndex, rowIndex)
    const rowEnd = Math.max(cellSelectionAnchor.value.rowIndex, rowIndex)
    const columnStart = Math.min(cellSelectionAnchor.value.columnIndex, columnIndex)
    const columnEnd = Math.max(cellSelectionAnchor.value.columnIndex, columnIndex)
    const rectangle: string[] = []
    for (let currentRow = rowStart; currentRow <= rowEnd; currentRow += 1) {
      const visibleRow = displayedDocuments.value[currentRow]
      if (!visibleRow) continue
      for (let currentColumn = columnStart; currentColumn <= columnEnd; currentColumn += 1) {
        const visibleField = selectableDocumentFields.value[currentColumn]
        if (visibleField) rectangle.push(cellSelectionKey(visibleRow.localKey, visibleField))
      }
    }
    selectedCellKeys.value = event.metaKey || event.ctrlKey
      ? [...new Set([...selectedCellKeys.value, ...rectangle])]
      : rectangle
  } else if (event.metaKey || event.ctrlKey) {
    selectedCellKeys.value = selectedCellKeys.value.includes(key)
      ? selectedCellKeys.value.filter((item) => item !== key)
      : [...selectedCellKeys.value, key]
    cellSelectionAnchor.value = { rowIndex, columnIndex }
  } else {
    selectedCellKeys.value = [key]
    cellSelectionAnchor.value = { rowIndex, columnIndex }
  }
}

function markRowsDeleted(rows = selectedDocumentRows.value): void {
  if (isDocumentWriteDisabled.value || isCommittingChanges.value || !rows.length) return
  const nextChanges = { ...localDocumentChanges.value }
  rows.forEach((row) => {
    const existingChange = nextChanges[row.localKey]
    if (existingChange?.operation === 'create') {
      delete nextChanges[row.localKey]
      return
    }
    const serverDocument = documentsPage.value?.documents.find((document) => document.id === row.id)
    const originalSource = existingChange?.originalSource ?? { ...(serverDocument?.source ?? row.source ?? {}) }
    nextChanges[row.localKey] = {
      localKey: row.localKey,
      connectionId: props.connectionId,
      index: selectedIndexName.value,
      id: row.id,
      sequenceNumber: existingChange?.sequenceNumber ?? row.sequenceNumber,
      primaryTerm: existingChange?.primaryTerm ?? row.primaryTerm,
      operation: 'delete',
      source: { ...(existingChange?.source ?? row.source ?? {}) },
      originalSource,
      dirtyFields: []
    }
  })
  localDocumentChanges.value = nextChanges
  clearDocumentSelection()
}

function revertSelectedRows(): void {
  if (isCommittingChanges.value) return
  const nextChanges = { ...localDocumentChanges.value }
  selectedDocumentRows.value.forEach((row) => delete nextChanges[row.localKey])
  localDocumentChanges.value = nextChanges
  editingCell.value = null
  clearDocumentSelection()
}

function clearDocumentSelection(): void {
  selectedDocumentRows.value = []
  lastSelectedRowIndex.value = null
  selectedCellKeys.value = []
  cellSelectionAnchor.value = null
  documentSelectionMode.value = null
  editingCell.value = null
}

function documentRowClassName(input: { row: EditableDocument }): string {
  const classes: string[] = []
  if (input.row.localOperation) classes.push(`document-row-${input.row.localOperation}`)
  if (selectedDocumentRows.value.some((row) => row.localKey === input.row.localKey)) {
    classes.push('document-row-selected')
  }
  return classes.join(' ')
}

function documentCellClassName(input: { row: EditableDocument; column: DocumentTableColumn }): string {
  const field = documentSelectionField(input.column)
  const classes: string[] = []
  if (input.row.dirtyFields.includes(field)) classes.push('document-cell-dirty')
  if (field && selectedCellKeys.value.includes(cellSelectionKey(input.row.localKey, field))) {
    classes.push('document-cell-selected')
  }
  return classes.join(' ')
}

function openBulkPreview(): void {
  commitError.value = ''
  isBulkPreviewVisible.value = true
}

async function submitDocumentChanges(): Promise<void> {
  if (isDocumentWriteDisabled.value || isCommittingChanges.value || !currentIndexChanges.value.length) return
  const pendingChanges = [...currentIndexChanges.value]
  const actions: IndexDocumentChange[] = pendingChanges.map((change) => {
    const action = toCommitOperation(change.operation)
    const concurrency = change.sequenceNumber !== null && change.primaryTerm !== null
      ? { sequenceNumber: change.sequenceNumber, primaryTerm: change.primaryTerm }
      : {}
    if (action === 'delete') return { action, id: change.id, ...concurrency }
    // Electron IPC 无法克隆 Vue Proxy，文档源必须先转换为纯 JSON DTO。
    const source = toIpcDocumentSource(change.source)
    if (action === 'index') return { action, id: change.id, source, ...concurrency }
    return { action, id: change.id, source }
  })
  commitError.value = ''
  isCommittingChanges.value = true
  try {
    const result = await indicesApi.commitDocumentChanges({
      connectionId: props.connectionId,
      index: selectedIndexName.value,
      actions
    })
    const failedPositions = new Set(result.items.filter((item) => !item.succeeded).map((item) => item.position))
    const nextChanges = { ...localDocumentChanges.value }
    pendingChanges.forEach((change, position) => {
      if (!failedPositions.has(position)) delete nextChanges[change.localKey]
    })
    localDocumentChanges.value = nextChanges
    if (result.failed > 0) {
      const firstFailure = result.items.find((item) => !item.succeeded)
      commitError.value = text(
        `批量提交部分失败：成功=${result.succeeded}，失败=${result.failed}，首个错误=${firstFailure?.error ?? '未知错误'}`,
        `Bulk submit partially failed: succeeded=${result.succeeded}, failed=${result.failed}, first error=${firstFailure?.error ?? 'unknown error'}`
      )
      ElMessage.error(commitError.value)
    } else {
      isBulkPreviewVisible.value = false
      ElMessage.success(text(`已提交 ${result.succeeded} 项变更`, `Submitted ${result.succeeded} changes`))
    }
    await refreshSelectedIndex()
  } catch (error: unknown) {
    commitError.value = getErrorMessage(error, '批量提交失败', 'Failed to submit document changes')
    ElMessage.error(commitError.value)
  } finally {
    isCommittingChanges.value = false
  }
}

function openCreateDocument(): void {
  documentEditorMode.value = 'create'
  documentEditorId.value = ''
  documentEditorJson.value = '{}'
  documentEditorError.value = ''
  isDocumentEditorVisible.value = true
}

function openEditDocument(document: IndexDocument): void {
  documentEditorMode.value = 'edit'
  documentEditorId.value = document.id
  documentEditorJson.value = formatJson(document.source ?? {})
  documentEditorError.value = ''
  isDocumentEditorVisible.value = true
}

function parseDocumentJson(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError(text('文档内容必须是 JSON 对象', 'Document body must be a JSON object'))
  }
  return parsed as Record<string, unknown>
}

async function saveDocument(): Promise<void> {
  const index = selectedIndex.value
  if (!index) return
  if (isCurrentConnectionReadOnly.value) {
    documentEditorError.value = text('当前连接为只读，不能写入文档', 'The current connection is read-only')
    return
  }
  documentEditorError.value = ''
  isDocumentMutationLoading.value = true
  try {
    const document = parseDocumentJson(documentEditorJson.value)
    if (documentEditorMode.value === 'edit') {
      if (!documentEditorId.value.trim()) {
        throw new TypeError(text('编辑文档必须包含 _id', 'An _id is required to update a document'))
      }
      await indicesApi.updateDocument({
        connectionId: props.connectionId,
        index: index.name,
        id: documentEditorId.value.trim(),
        document
      })
    } else {
      await indicesApi.createDocument({
        connectionId: props.connectionId,
        index: index.name,
        id: documentEditorId.value.trim() || undefined,
        document
      })
    }
    isDocumentEditorVisible.value = false
    ElMessage.success(
      documentEditorMode.value === 'edit'
        ? text('文档已更新', 'Document updated')
        : text('文档已新增', 'Document created')
    )
    await refreshSelectedIndex()
  } catch (error: unknown) {
    documentEditorError.value = getErrorMessage(error, '保存文档失败', 'Failed to save document')
  } finally {
    isDocumentMutationLoading.value = false
  }
}

function handleTableSortChange(input: { prop: string; order: 'ascending' | 'descending' | null }): void {
  sortField.value = input.order ? input.prop : ''
  sortOrder.value = input.order === 'descending' ? 'desc' : 'asc'
  runDocumentQuery()
}

function openImportDialog(): void {
  importFile.value = null
  importError.value = ''
  isImportDialogVisible.value = true
}

function chooseImportFile(): void {
  importFileInput.value?.click()
}

function handleImportFileChange(event: Event): void {
  const input = event.target as HTMLInputElement
  importFile.value = input.files?.[0] ?? null
  input.value = ''
}

function openExportDialog(): void {
  exportError.value = ''
  isExportDialogVisible.value = true
}

async function collectDocumentsForTransfer(
  scope: TransferScope,
  queryTotalOverride?: number
): Promise<IndexDocument[]> {
  const currentDocuments = documentsPage.value?.documents ?? []
  if (scope === 'page' || !selectedIndex.value) return [...currentDocuments]
  const maximum = Math.min(
    queryTotalOverride ?? documentsPage.value?.total ?? 0,
    MAX_BROWSABLE_DOCUMENTS
  )
  const collected: IndexDocument[] = []
  for (let from = 0; from < maximum; from += 200) {
    const result = await indicesApi.getDocuments({
      connectionId: props.connectionId,
      index: selectedIndex.value.name,
      from,
      size: Math.min(200, maximum - from),
      q: queryText.value.trim() || undefined,
      sort: sortField.value.trim()
        ? { field: sortField.value.trim(), order: sortOrder.value }
        : undefined
    })
    collected.push(...result.documents)
    if (!result.documents.length) break
  }
  return collected
}

function escapeDelimitedValue(value: unknown, delimiter: string): string {
  const stringValue = value === null || value === undefined
    ? ''
    : typeof value === 'object'
      ? JSON.stringify(value)
      : String(value)
  return exportAlwaysQuote.value || /["\r\n]/.test(stringValue) || stringValue.includes(delimiter)
    ? `"${stringValue.replaceAll('"', '""')}"`
    : stringValue
}

function serializeDocuments(
  documents: IndexDocument[],
  format: ExportFormat,
  delimiter: string
): { content: string; extension: string; mimeType: string } {
  if (format === 'json') {
    return {
      content: JSON.stringify(documents.map((document) => ({ _id: document.id, _source: document.source })), null, 2),
      extension: 'json',
      mimeType: 'application/json'
    }
  }
  if (format === 'bulk') {
    const lines = documents.flatMap((document) => [
      JSON.stringify({ index: { _index: selectedIndexName.value, _id: document.id } }),
      JSON.stringify(document.source ?? {})
    ])
    return { content: `${lines.join('\n')}\n`, extension: 'ndjson', mimeType: 'application/x-ndjson' }
  }
  if (format === 'dump') {
    return {
      content: JSON.stringify({
        version: 1,
        index: selectedIndexName.value,
        exportedAt: new Date().toISOString(),
        mapping: metadata.value?.mapping ?? {},
        settings: metadata.value?.settings ?? {},
        documents: documents.map((document) => ({ _id: document.id, _source: document.source }))
      }, null, 2),
      extension: 'dump.json',
      mimeType: 'application/json'
    }
  }

  const fields = new Set<string>()
  documents.forEach((document) => Object.keys(document.source ?? {}).forEach((field) => fields.add(field)))
  const columns = ['_id', ...fields]
  const rawRows: unknown[][] = [
    columns,
    ...documents.map((document) =>
      columns.map((column) => column === '_id' ? document.id : document.source?.[column])
    )
  ]
  const transposedRows = exportTranspose.value
    ? columns.map((_, columnIndex) => rawRows.map((row) => row[columnIndex]))
    : rawRows
  const dataRows = exportIncludeHeader.value
    ? transposedRows
    : exportTranspose.value
      ? transposedRows.map((row) => row.slice(1))
      : transposedRows.slice(1)
  const rows = dataRows.map((row) =>
    row.map((value) => escapeDelimitedValue(value, delimiter)).join(delimiter)
  )
  return {
    content: rows.join('\n'),
    extension: format === 'csv' ? 'csv' : 'dsv',
    mimeType: 'text/csv;charset=utf-8'
  }
}

async function exportDocuments(): Promise<void> {
  if (!selectedIndex.value) return
  exportError.value = ''
  isExporting.value = true
  try {
    const documents = await collectDocumentsForTransfer(exportScope.value)
    const delimiter = exportFormat.value === 'csv' ? ',' : exportDelimiter.value || '\t'
    const serialized = serializeDocuments(documents, exportFormat.value, delimiter)
    const result = await indicesApi.saveExportFile({
      suggestedName: `${selectedIndex.value.name}-${Date.now()}.${serialized.extension}`,
      content: serialized.content,
      gzip: exportGzip.value
    })
    if (result.canceled) return
    isExportDialogVisible.value = false
    ElMessage.success(text(`已导出 ${documents.length} 条文档`, `Exported ${documents.length} documents`))
  } catch (error: unknown) {
    exportError.value = getErrorMessage(error, '导出文档失败', 'Failed to export documents')
  } finally {
    isExporting.value = false
  }
}

function parseDelimitedRows(content: string, delimiter: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false

  for (let index = 0; index < content.length; index += 1) {
    const character = content[index]
    const nextCharacter = content[index + 1]
    if (character === '"' && quoted && nextCharacter === '"') {
      cell += '"'
      index += 1
    } else if (character === '"') {
      quoted = !quoted
    } else if (character === delimiter && !quoted) {
      row.push(cell)
      cell = ''
    } else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && nextCharacter === '\n') index += 1
      row.push(cell)
      if (row.some((value) => value.length > 0)) rows.push(row)
      row = []
      cell = ''
    } else {
      cell += character
    }
  }
  row.push(cell)
  if (row.some((value) => value.length > 0)) rows.push(row)
  if (quoted) throw new TypeError(text('CSV 包含未闭合的引号', 'CSV contains an unclosed quote'))
  return rows
}

function parseScalarValue(value: string): unknown {
  const trimmed = value.trim()
  if (!trimmed) return null
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  if (trimmed === 'null') return null
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
    const unsigned = trimmed.startsWith('-') ? trimmed.slice(1) : trimmed
    if (unsigned.length > 1 && unsigned.startsWith('0') && !unsigned.startsWith('0.')) return value
    const numberValue = Number(trimmed)
    if (Number.isInteger(numberValue) && !Number.isSafeInteger(numberValue)) return value
    return numberValue
  }
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      return JSON.parse(trimmed)
    } catch {
      return value
    }
  }
  return value
}

function parseCsvDocuments(content: string): IndexImportDocument[] {
  const firstLine = content.split(/\r?\n/, 1)[0] ?? ''
  const delimiter = firstLine.includes('\t') ? '\t' : ','
  const rows = parseDelimitedRows(content, delimiter)
  const headers = rows[0]?.map((header, index) =>
    (index === 0 ? header.replace(/^\uFEFF/u, '') : header).trim()
  ) ?? []
  if (!headers.length) throw new TypeError(text('CSV 缺少表头', 'CSV header is missing'))
  return rows.slice(1).map((row) => {
    const source: Record<string, unknown> = {}
    let id: string | undefined
    headers.forEach((header, index) => {
      if (!header) return
      if (header === '_id') id = row[index]?.trim() || undefined
      else source[header] = parseScalarValue(row[index] ?? '')
    })
    return { id, source }
  })
}

function normalizeJsonDocument(value: unknown): IndexImportDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(text('导入文档必须是 JSON 对象', 'Each imported document must be a JSON object'))
  }
  const record = value as Record<string, unknown>
  if (record._source && typeof record._source === 'object' && !Array.isArray(record._source)) {
    return {
      id: typeof record._id === 'string' ? record._id : undefined,
      source: record._source as Record<string, unknown>
    }
  }
  return {
    id: typeof record._id === 'string' ? record._id : undefined,
    source: Object.fromEntries(Object.entries(record).filter(([key]) => key !== '_id'))
  }
}

function parseJsonDocuments(content: string): IndexImportDocument[] {
  const parsed: unknown = JSON.parse(content)
  if (Array.isArray(parsed)) return parsed.map(normalizeJsonDocument)
  if (parsed && typeof parsed === 'object') {
    const record = parsed as Record<string, unknown>
    if (Array.isArray(record.documents)) return record.documents.map(normalizeJsonDocument)
    const hits = record.hits
    if (hits && typeof hits === 'object' && Array.isArray((hits as Record<string, unknown>).hits)) {
      return ((hits as Record<string, unknown>).hits as unknown[]).map(normalizeJsonDocument)
    }
  }
  return [normalizeJsonDocument(parsed)]
}

function assertBulkImportSucceeded(result: IndexBulkImportResult, batchStart: number): void {
  if (result.failed === 0) return
  const firstFailure = result.items.find((item) => item.error)
  throw new Error(text(
    `批量写入失败：批次起始=${batchStart + 1}，成功=${result.succeeded}，失败=${result.failed}，首个错误=${firstFailure?.error ?? '未知错误'}`,
    `Bulk write failed: batch starts at ${batchStart + 1}, succeeded=${result.succeeded}, failed=${result.failed}, first error=${firstFailure?.error ?? 'unknown error'}`
  ))
}

async function importDocuments(): Promise<void> {
  const index = selectedIndex.value
  if (!index) return
  if (importFormat.value === 'copy') {
    isImportDialogVisible.value = false
    await openCopyDialog()
    return
  }
  if (!importFile.value) return
  if (isCurrentConnectionReadOnly.value) {
    importError.value = text('当前连接为只读，不能导入文档', 'The current connection is read-only')
    return
  }
  importError.value = ''
  isImporting.value = true
  try {
    const content = await importFile.value.text()
    const documents = importFormat.value === 'csv'
      ? parseCsvDocuments(content)
      : parseJsonDocuments(content)
    if (!documents.length) throw new TypeError(text('导入文件中没有文档', 'No documents found in the import file'))
    for (let from = 0; from < documents.length; from += 1_000) {
      const result = await indicesApi.bulkImport({
        connectionId: props.connectionId,
        index: index.name,
        documents: documents.slice(from, from + 1_000),
        operation: importOperation.value
      })
      assertBulkImportSucceeded(result, from)
    }
    isImportDialogVisible.value = false
    ElMessage.success(text(`已导入 ${documents.length} 条文档`, `Imported ${documents.length} documents`))
    await refreshSelectedIndex()
  } catch (error: unknown) {
    importError.value = getErrorMessage(error, '导入文档失败', 'Failed to import documents')
  } finally {
    isImporting.value = false
  }
}

async function openCopyDialog(): Promise<void> {
  copyError.value = ''
  targetConnectionId.value = ''
  targetIndexName.value = selectedIndexName.value
  copyFieldMappings.value = mappingFields.value.map((field) => ({ source: field.name, target: field.name }))
  await loadAvailableConnections()
  targetConnectionId.value = writableTargetConnections.value.find(
    (connection) => connection.id !== props.connectionId
  )?.id ?? writableTargetConnections.value[0]?.id ?? ''
  isCopyDialogVisible.value = true
}

function updateDocumentField(
  source: Record<string, unknown>,
  mappings: Array<{ source: string; target: string }>
): Record<string, unknown> {
  if (!mappings.length) return { ...source }
  const result: Record<string, unknown> = {}
  for (const mapping of mappings) {
    const sourceField = mapping.source.trim()
    const targetField = mapping.target.trim()
    if (!sourceField || !targetField) continue
    const value = readNestedValue(source, sourceField)
    if (value !== undefined) writeNestedValue(result, targetField, value)
  }
  return result
}

function readNestedValue(source: Record<string, unknown>, path: string): unknown {
  let current: unknown = source
  for (const segment of path.split('.')) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

function writeNestedValue(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split('.')
  let current = target
  segments.forEach((segment, index) => {
    if (index === segments.length - 1) {
      current[segment] = value
      return
    }
    const existing = current[segment]
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) current[segment] = {}
    current = current[segment] as Record<string, unknown>
  })
}

async function copyIndexDocuments(): Promise<void> {
  const index = selectedIndex.value
  if (!index || !targetConnectionId.value || !targetIndexName.value.trim()) return
  const targetIndex = targetIndexName.value.trim()
  copyError.value = ''
  isCopying.value = true
  const fieldMappings = copyFieldMappings.value.filter(
    (mapping) => mapping.source.trim() && mapping.target.trim()
  )
  try {
    const queryCount = await indicesApi.getDocuments({
      connectionId: props.connectionId,
      index: index.name,
      from: 0,
      size: 1,
      q: queryText.value.trim() || undefined,
      sort: sortField.value.trim()
        ? { field: sortField.value.trim(), order: sortOrder.value }
        : undefined
    })
    const queryTotal = queryCount.total
    const queryTotalIsLowerBound = queryCount.totalRelation === 'gte'
    if (queryTotal > MAX_BROWSABLE_DOCUMENTS || (queryTotalIsLowerBound && queryTotal >= MAX_BROWSABLE_DOCUMENTS)) {
      throw new RangeError(text(
        `当前查询结果超过 ${MAX_BROWSABLE_DOCUMENTS.toLocaleString()} 条，兼容复制模式无法保证完整复制，请缩小查询范围后重试`,
        `The current query exceeds ${MAX_BROWSABLE_DOCUMENTS.toLocaleString()} documents. Narrow the query before copying so compatibility mode does not truncate data`
      ))
    }
    if (targetConnectionId.value === props.connectionId && targetIndex === index.name) {
      throw new TypeError(text(
        '目标连接和索引不能与来源完全相同，以免原地覆盖文档',
        'The target connection and index must differ from the source to prevent in-place overwrites'
      ))
    }
    const targetIndexResult = await indicesApi.listIndices(targetConnectionId.value)
    const targetIndexExists = targetIndexResult.indices.some((item) => item.name === targetIndex)
    if (createTargetIndex.value && targetIndexExists) {
      throw new TypeError(text(`目标索引“${targetIndex}”已存在`, `Target index "${targetIndex}" already exists`))
    }
    if (!createTargetIndex.value && !targetIndexExists) {
      throw new TypeError(text(`目标索引“${targetIndex}”不存在`, `Target index "${targetIndex}" does not exist`))
    }
    if (indicesApi.copyIndex) {
      await indicesApi.copyIndex({
        sourceConnectionId: props.connectionId,
        sourceIndex: index.name,
        targetConnectionId: targetConnectionId.value,
        targetIndex,
        createTargetIndex: createTargetIndex.value,
        operation: copyOperation.value,
        batchSize: copyBatchSize.value,
        throttleMs: copyThrottleMs.value,
        fieldMappings,
        query: queryText.value.trim() || undefined
      })
    } else {
      const sourceDocuments = await collectDocumentsForTransfer('query', queryTotal)
      const documents = sourceDocuments.map((document) => ({
        id: document.id,
        source: updateDocumentField(document.source ?? {}, fieldMappings)
      }))
      for (let from = 0; from < documents.length; from += copyBatchSize.value) {
        const result = await indicesApi.bulkImport({
          connectionId: targetConnectionId.value,
          index: targetIndex,
          documents: documents.slice(from, from + copyBatchSize.value),
          operation: copyOperation.value
        })
        assertBulkImportSucceeded(result, from)
        if (copyThrottleMs.value > 0 && from + copyBatchSize.value < documents.length) {
          await new Promise<void>((resolve) => window.setTimeout(resolve, copyThrottleMs.value))
        }
      }
    }
    isCopyDialogVisible.value = false
    ElMessage.success(text('索引复制任务已完成', 'Index copy completed'))
  } catch (error: unknown) {
    copyError.value = getErrorMessage(error, '复制索引失败', 'Failed to copy index')
  } finally {
    isCopying.value = false
  }
}

async function loadIndices(): Promise<void> {
  const requestGeneration = ++indexListGeneration
  const connectionId = props.connectionId
  if (!props.connected || !connectionId) {
    resetForUnavailableConnection()
    return
  }

  isIndexListLoading.value = true
  indexListError.value = ''
  indexListWarnings.value = []
  try {
    const result = await indicesApi.listIndices(connectionId)
    if (requestGeneration !== indexListGeneration || connectionId !== props.connectionId) return
    indices.value = result.indices
    indexListWarnings.value = result.warnings.map((warning) => warning.reason)
    const availableIndexNames = new Set(result.indices.map((index) => index.name))
    openedIndexNames.value = openedIndexNames.value.filter((indexName) =>
      availableIndexNames.has(indexName)
    )

    const retainedIndex = result.indices.find((index) => index.name === selectedIndexName.value)
    const nextIndex = retainedIndex ?? result.indices[0] ?? null
    if (!nextIndex) {
      clearSelectedIndex()
      return
    }
    if (nextIndex.name !== selectedIndexName.value) selectIndex(nextIndex)
  } catch (error: unknown) {
    if (requestGeneration !== indexListGeneration) return
    indexListError.value = getErrorMessage(error, '加载索引列表失败', 'Failed to load indices')
  } finally {
    if (requestGeneration === indexListGeneration) isIndexListLoading.value = false
  }
}

function selectIndex(index: IndexSummary): void {
  if (!openedIndexNames.value.includes(index.name)) {
    openedIndexNames.value = [...openedIndexNames.value, index.name]
  }
  if (selectedIndexName.value === index.name) return
  saveSelectedIndexWorkspaceState()
  clearDocumentSelection()
  selectedIndexName.value = index.name
  restoreIndexWorkspaceState(index.name)
  metadata.value = null
  documentsPage.value = null
  metadataError.value = ''
  documentsError.value = ''
  operatorSuggestionQuery.value = ''
  void loadMetadata(index.name)
  void loadDocuments(index.name, pageFrom.value, pageSize.value)
}

function saveSelectedIndexWorkspaceState(): void {
  if (!selectedIndexName.value) return
  indexWorkspaceStates.value = {
    ...indexWorkspaceStates.value,
    [selectedIndexName.value]: {
      queryText: queryText.value,
      sortField: sortField.value,
      sortOrder: sortOrder.value,
      pageFrom: pageFrom.value,
      pageSize: pageSize.value,
      activeDetailTab: activeDetailTab.value,
      documentViewMode: documentViewMode.value
    }
  }
}

function restoreIndexWorkspaceState(indexName: string): void {
  const state = indexWorkspaceStates.value[indexName]
  queryText.value = state?.queryText ?? ''
  sortField.value = state?.sortField ?? ''
  sortOrder.value = state?.sortOrder ?? 'asc'
  pageFrom.value = state?.pageFrom ?? 0
  pageSize.value = state?.pageSize ?? normalizeQuerySize(props.defaultQuerySize)
  activeDetailTab.value = state?.activeDetailTab ?? 'documents'
  documentViewMode.value = state?.documentViewMode ?? 'table'
}

function activateOpenedIndex(indexName: string | number): void {
  const index = indices.value.find((item) => item.name === String(indexName))
  if (index) selectIndex(index)
}

function closeOpenedIndex(indexName: string | number): void {
  const normalizedIndexName = String(indexName)
  const closingIndex = openedIndexNames.value.indexOf(normalizedIndexName)
  if (closingIndex === -1) return

  const remainingIndexNames = openedIndexNames.value.filter(
    (item) => item !== normalizedIndexName
  )
  openedIndexNames.value = remainingIndexNames
  if (selectedIndexName.value !== normalizedIndexName) return

  const nextIndexName =
    remainingIndexNames[closingIndex - 1] ?? remainingIndexNames[closingIndex] ?? null
  const nextIndex = indices.value.find((index) => index.name === nextIndexName)
  if (nextIndex) {
    selectIndex(nextIndex)
    return
  }
  clearSelectedIndex()
}

function getIndexChangeCount(indexName: string): number {
  return Object.values(localDocumentChanges.value).filter(
    (change) => change.connectionId === props.connectionId && change.index === indexName
  ).length
}

async function refreshSelectedIndex(): Promise<void> {
  const index = selectedIndex.value
  if (!index) return
  await Promise.all([loadMetadata(index.name), loadDocuments(index.name, pageFrom.value)])
}

async function loadMetadata(indexName: string): Promise<void> {
  const requestGeneration = ++metadataGeneration
  const connectionId = props.connectionId
  isMetadataLoading.value = true
  metadataError.value = ''
  try {
    const result = await indicesApi.getMetadata({ connectionId, index: indexName })
    if (
      requestGeneration !== metadataGeneration ||
      connectionId !== props.connectionId ||
      indexName !== selectedIndexName.value
    ) {
      return
    }
    metadata.value = result
  } catch (error: unknown) {
    if (requestGeneration !== metadataGeneration) return
    metadataError.value = getErrorMessage(
      error,
      `加载索引“${indexName}”元数据失败`,
      `Failed to load metadata for index "${indexName}"`
    )
  } finally {
    if (requestGeneration === metadataGeneration) isMetadataLoading.value = false
  }
}

async function loadDocuments(
  indexName: string,
  from: number,
  requestedPageSize = pageSize.value
): Promise<void> {
  const requestGeneration = ++documentsGeneration
  const connectionId = props.connectionId
  isDocumentsLoading.value = true
  documentsError.value = ''
  try {
    const result = await indicesApi.getDocuments({
      connectionId,
      index: indexName,
      from,
      size: requestedPageSize,
      q: queryText.value.trim() || undefined,
      sort: sortField.value.trim()
        ? { field: sortField.value.trim(), order: sortOrder.value }
        : undefined
    })
    if (
      requestGeneration !== documentsGeneration ||
      connectionId !== props.connectionId ||
      indexName !== selectedIndexName.value
    ) {
      return
    }
    pageFrom.value = result.from
    pageSize.value = result.size
    documentsPage.value = result
    selectedDocumentRows.value = []
    lastSelectedRowIndex.value = null
    selectedCellKeys.value = []
    cellSelectionAnchor.value = null
    editingCell.value = null
  } catch (error: unknown) {
    if (requestGeneration !== documentsGeneration) return
    documentsError.value = getErrorMessage(
      error,
      `查询索引“${indexName}”文档失败`,
      `Failed to query documents in index "${indexName}"`
    )
  } finally {
    if (requestGeneration === documentsGeneration) isDocumentsLoading.value = false
  }
}

function runDocumentQuery(shouldRecordHistory = true): void {
  if (!selectedIndex.value) return
  if (shouldRecordHistory) recordCurrentQuery()
  void loadDocuments(selectedIndex.value.name, 0)
}

function resetDocumentQuery(): void {
  operatorSuggestionQuery.value = ''
  queryText.value = ''
  sortField.value = ''
  sortOrder.value = 'asc'
  runDocumentQuery(false)
}

function changePage(page: number): void {
  if (!selectedIndex.value) return
  const nextFrom = (page - 1) * pageSize.value
  void loadDocuments(selectedIndex.value.name, nextFrom)
}

function changePageSize(size: number): void {
  if (!selectedIndex.value) return
  void loadDocuments(selectedIndex.value.name, 0, normalizeQuerySize(size))
}

function reloadDocumentPage(): void {
  if (!selectedIndex.value) return
  void loadDocuments(selectedIndex.value.name, pageFrom.value)
}

async function deleteSelectedIndex(): Promise<void> {
  const index = selectedIndex.value
  if (!index || isCurrentConnectionReadOnly.value || isIndexDeleting.value) return
  try {
    await ElMessageBox.confirm(
      text(`删除索引“${index.name}”前会先保存最多 10,000 条文档快照，确认继续？`, `Before deleting “${index.name}”, up to 10,000 document snapshots will be saved. Continue?`),
      text('删除索引', 'Delete index'),
      { type: 'warning', confirmButtonText: text('删除并放入废纸篓', 'Delete to trash'), cancelButtonText: text('取消', 'Cancel') }
    )
  } catch (reason: unknown) {
    if (reason === 'cancel' || reason === 'close') return
    ElMessage.error(getErrorMessage(reason, '确认删除索引失败', 'Failed to confirm index deletion'))
    return
  }
  isIndexDeleting.value = true
  try {
    const result = await indicesApi.deleteIndex({ connectionId: props.connectionId, index: index.name })
    ElMessage.success(text(`索引已删除，快照已保存（${result.documentCount} 条文档）`, `Index deleted; ${result.documentCount} documents saved`))
    clearSelectedIndex()
    await loadIndices()
  } catch (reason: unknown) {
    ElMessage.error(getErrorMessage(reason, '删除索引失败', 'Failed to delete index'))
  } finally {
    isIndexDeleting.value = false
  }
}

function toggleIndexSortOrder(): void {
  indexSortOrder.value = indexSortOrder.value === 'asc' ? 'desc' : 'asc'
}

function clearSelectedIndex(): void {
  clearDocumentSelection()
  selectedIndexName.value = ''
  metadata.value = null
  documentsPage.value = null
  metadataError.value = ''
  documentsError.value = ''
  metadataGeneration += 1
  documentsGeneration += 1
  isMetadataLoading.value = false
  isDocumentsLoading.value = false
}

function resetForUnavailableConnection(): void {
  indexListGeneration += 1
  indices.value = []
  indexListError.value = ''
  indexListWarnings.value = []
  openedIndexNames.value = []
  indexWorkspaceStates.value = {}
  isIndexListLoading.value = false
  clearSelectedIndex()
}

watch(
  () => [props.connectionId, props.connected] as const,
  () => {
    resetForUnavailableConnection()
    loadQueryHistory()
    void loadAvailableConnections()
    if (props.connected && props.connectionId) void loadIndices()
  }
)
watch(
  () => props.defaultQuerySize,
  (value) => {
    pageSize.value = normalizeQuerySize(value)
  }
)
onMounted(() => {
  loadQueryHistory()
  void loadAvailableConnections()
  if (props.connected && props.connectionId) void loadIndices()
})
</script>

<template>
  <section class="index-browser" :aria-label="text('索引浏览器', 'Index browser')">
    <aside class="index-sidebar">
      <header class="index-sidebar-header">
        <div>
          <strong>{{ text('索引', 'Indices') }}</strong>
          <small>{{ formatCount(indices.length) }}</small>
        </div>
        <div class="index-sidebar-header-actions">
          <el-tooltip :content="text('添加索引', 'Add index')" placement="bottom">
            <el-button
              text
              circle
              :icon="Plus"
              :aria-label="text('添加索引', 'Add index')"
              :disabled="!connected || !currentConnection || isCurrentConnectionReadOnly"
              @click="openCreateIndexDialog"
            />
          </el-tooltip>
          <el-tooltip :content="text('刷新索引列表', 'Refresh index list')" placement="bottom">
            <el-button
              text
              circle
              :icon="Refresh"
              :aria-label="text('刷新索引列表', 'Refresh index list')"
              :loading="isIndexListLoading"
              :disabled="!connected"
              @click="loadIndices"
            />
          </el-tooltip>
        </div>
      </header>

      <div class="index-sidebar-controls">
        <el-input
          v-model="indexFilter"
          clearable
          :prefix-icon="Search"
          :placeholder="text('筛选索引', 'Filter indices')"
          :aria-label="text('筛选索引', 'Filter indices')"
        />
        <div class="index-sort-controls">
          <el-select v-model="indexSortField" :aria-label="text('排序字段', 'Sort field')">
            <el-option
              v-for="option in indexSortOptions"
              :key="option.value"
              :label="option.label"
              :value="option.value"
            />
          </el-select>
          <el-tooltip
            :content="indexSortOrder === 'asc' ? text('升序', 'Ascending') : text('降序', 'Descending')"
            placement="bottom"
          >
            <el-button
              :icon="indexSortOrder === 'asc' ? SortUp : SortDown"
              :aria-label="indexSortOrder === 'asc' ? text('升序', 'Ascending') : text('降序', 'Descending')"
              @click="toggleIndexSortOrder"
            />
          </el-tooltip>
        </div>
      </div>

      <div v-if="!connected" class="index-sidebar-empty">
        <el-icon><Grid /></el-icon>
        <strong>{{ text('连接后查看索引', 'Connect to view indices') }}</strong>
        <small>{{ text('当前连接尚未建立', 'The current connection is offline') }}</small>
      </div>
      <div v-else-if="indexListError" class="index-sidebar-message">
        <el-alert :title="indexListError" type="error" :closable="false" show-icon />
        <el-button size="small" @click="loadIndices">{{ text('重新加载', 'Retry') }}</el-button>
      </div>
      <div v-else v-loading="isIndexListLoading" class="index-list">
        <el-alert
          v-for="warning in indexListWarnings"
          :key="warning"
          :title="text('兼容增强未启用', 'Compatibility enhancement unavailable')"
          :description="warning"
          type="warning"
          :closable="false"
          show-icon
          class="index-compatibility-warning"
        />
        <button
          v-for="index in filteredIndices"
          :key="index.name"
          type="button"
          class="index-list-item"
          :class="{ active: index.name === selectedIndexName }"
          @click="selectIndex(index)"
        >
          <span class="index-health-dot" :class="`health-${index.health}`" />
          <span class="index-list-copy">
            <strong :title="index.name">{{ index.name }}</strong>
            <small>{{ formatCount(index.documentCount) }} {{ text('文档', 'docs') }} · {{ formatBytes(index.storeSizeBytes) }}</small>
          </span>
          <span class="index-status">
            {{ [
              index.status === 'close' ? text('已关闭', 'Closed') : '',
              index.hidden ? text('隐藏', 'Hidden') : '',
              index.dataStream ? text('数据流', 'Data stream') : ''
            ].filter(Boolean).join(' · ') }}
          </span>
        </button>
        <div v-if="!isIndexListLoading && !filteredIndices.length" class="index-sidebar-empty compact">
          <strong>{{ indices.length ? text('没有匹配项', 'No matches') : text('暂无索引', 'No indices') }}</strong>
          <small>{{ indices.length ? text('请调整筛选条件', 'Try another filter') : text('集群未返回任何索引', 'The cluster returned no indices') }}</small>
        </div>
      </div>
    </aside>

    <main class="index-detail">
      <el-tabs
        v-if="openedIndices.length"
        :model-value="selectedIndexName"
        type="card"
        class="opened-index-tabs"
        @tab-change="activateOpenedIndex"
        @tab-remove="closeOpenedIndex"
      >
        <el-tab-pane
          v-for="index in openedIndices"
          :key="index.name"
          :name="index.name"
          closable
        >
          <template #label>
            <span class="opened-index-tab-label">
              <i class="index-health-dot" :class="`health-${index.health}`" />
              <span :title="index.name">{{ index.name }}</span>
              <b v-if="getIndexChangeCount(index.name)" :title="text('未提交变更', 'Pending changes')">
                {{ getIndexChangeCount(index.name) }}
              </b>
            </span>
          </template>
        </el-tab-pane>
      </el-tabs>

      <div v-if="!selectedIndex" class="index-detail-empty">
        <el-icon><DataAnalysis /></el-icon>
        <strong>{{ text('选择一个索引', 'Select an index') }}</strong>
        <small>{{ text('查看映射、设置、别名、统计和文档', 'Inspect mappings, settings, aliases, stats, and documents') }}</small>
      </div>

      <template v-else>
        <header class="index-detail-header">
          <div class="index-title">
            <span class="index-health-dot" :class="`health-${selectedIndex.health}`" />
            <div>
              <strong :title="selectedIndex.name">{{ selectedIndex.name }}</strong>
              <small>{{ formatCount(selectedIndex.documentCount) }} {{ text('文档', 'documents') }} · {{ formatBytes(selectedIndex.storeSizeBytes) }}</small>
            </div>
          </div>
          <div class="index-header-actions">
            <el-tag :type="healthTagType(selectedIndex.health)" effect="plain" size="small">
              {{ healthText(selectedIndex.health) }}
            </el-tag>
            <el-tooltip :content="text('刷新当前索引', 'Refresh current index')" placement="bottom">
              <el-button
                text
                circle
                :icon="Refresh"
                :aria-label="text('刷新当前索引', 'Refresh current index')"
                :loading="isMetadataLoading || isDocumentsLoading"
                @click="refreshSelectedIndex"
              />
            </el-tooltip>
            <el-tooltip :content="text('删除索引并保存到废纸篓', 'Delete index and save to trash')" placement="bottom">
              <el-button
                text
                circle
                type="danger"
                :icon="Delete"
                :aria-label="text('删除索引并保存到废纸篓', 'Delete index and save to trash')"
                :loading="isIndexDeleting"
                :disabled="isCurrentConnectionReadOnly"
                @click="deleteSelectedIndex"
              />
            </el-tooltip>
          </div>
        </header>

        <el-tabs v-model="activeDetailTab" class="index-detail-tabs">
          <el-tab-pane :label="text('文档', 'Documents')" name="documents">
            <div class="documents-pane">
              <div class="documents-toolbar">
                <el-autocomplete
                  ref="queryAutocomplete"
                  v-model="queryText"
                  clearable
                  :prefix-icon="Search"
                  :fetch-suggestions="fetchQuerySuggestions"
                  :trigger-on-focus="true"
                  :placeholder="text('Query string，例如 status:active', 'Query string, e.g. status:active')"
                  :aria-label="text('文档查询', 'Document query')"
                  @input="handleQueryInput"
                  @select="handleQuerySuggestionSelect"
                  @keyup.enter="handleQueryEnter"
                >
                  <template #default="{ item }: { item: QuerySuggestion }">
                    <span class="query-suggestion-label">{{ item.label }}</span>
                    <el-tag size="small" effect="plain">{{ item.kind }}</el-tag>
                    <small>{{ item.detail }}</small>
                  </template>
                </el-autocomplete>
                <el-select
                  v-model="sortField"
                  clearable
                  filterable
                  allow-create
                  default-first-option
                  :placeholder="text('排序字段', 'Sort field')"
                  :aria-label="text('文档排序字段', 'Document sort field')"
                >
                  <el-option v-for="field in sortableFields" :key="field" :label="field" :value="field" />
                </el-select>
                <el-select v-model="sortOrder" :aria-label="text('排序方向', 'Sort order')">
                  <el-option :label="text('升序', 'Ascending')" value="asc" />
                  <el-option :label="text('降序', 'Descending')" value="desc" />
                </el-select>
                <el-button type="primary" :icon="Search" :loading="isDocumentsLoading" @click="runDocumentQuery">
                  {{ text('查询', 'Query') }}
                </el-button>
                <el-button :disabled="isDocumentsLoading" @click="resetDocumentQuery">
                  {{ text('重置', 'Reset') }}
                </el-button>
                <el-popover trigger="click" placement="bottom-end" :width="420">
                  <template #reference>
                    <el-button :icon="Clock">{{ text('历史', 'History') }}</el-button>
                  </template>
                  <div class="query-history-header">
                    <strong>{{ text('当前索引查询历史', 'Query history for this index') }}</strong>
                    <el-button text type="danger" size="small" :disabled="!selectedIndexQueryHistory.length" @click="clearQueryHistory">
                      {{ text('清空', 'Clear') }}
                    </el-button>
                  </div>
                  <el-alert v-if="historyStorageError" :title="historyStorageError" type="error" :closable="false" />
                  <div v-if="selectedIndexQueryHistory.length" class="query-history-list">
                    <button
                      v-for="entry in selectedIndexQueryHistory"
                      :key="entry.id"
                      type="button"
                      class="query-history-item"
                      @click="applyQueryHistory(entry)"
                    >
                      <code>{{ entry.query || text('全部文档', 'All documents') }}</code>
                      <span v-if="entry.sortField">{{ entry.sortField }} {{ entry.sortOrder }}</span>
                      <small>{{ formatHistoryTime(entry.createdAt) }}</small>
                    </button>
                  </div>
                  <el-empty v-else :description="text('暂无查询历史', 'No query history')" :image-size="48" />
                </el-popover>
              </div>
              <div class="documents-subtoolbar">
                <div class="documents-page-toolbar">
                  <el-tooltip :content="text('第一页', 'First page')">
                    <el-button text :icon="DArrowLeft" :disabled="!canGoToPreviousPage || isDocumentsLoading" @click="changePage(1)" />
                  </el-tooltip>
                  <el-tooltip :content="text('上一页', 'Previous page')">
                    <el-button text :icon="ArrowLeft" :disabled="!canGoToPreviousPage || isDocumentsLoading" @click="changePage(currentPage - 1)" />
                  </el-tooltip>
                  <el-dropdown @command="changePageSize">
                    <el-button class="page-range-button">{{ pageRangeText }}</el-button>
                    <template #dropdown>
                      <el-dropdown-menu>
                        <el-dropdown-item v-for="size in [25, 50, 100, 200]" :key="size" :command="size">{{ size }} / {{ text('页', 'page') }}</el-dropdown-item>
                      </el-dropdown-menu>
                    </template>
                  </el-dropdown>
                  <span class="page-total">{{ text('共', 'of') }} {{ formatCount(documentsPage?.total ?? null) }}{{ documentsPage?.totalRelation === 'gte' ? '+' : '' }}</span>
                  <el-tooltip :content="text('下一页', 'Next page')">
                    <el-button text :icon="ArrowRight" :disabled="!canGoToNextPage || isDocumentsLoading" @click="changePage(currentPage + 1)" />
                  </el-tooltip>
                  <el-tooltip :content="text('最后一页', 'Last page')">
                    <el-button text :icon="DArrowRight" :disabled="!canGoToNextPage || isDocumentsLoading" @click="changePage(lastPage)" />
                  </el-tooltip>
                  <el-tooltip :content="text('重新加载', 'Reload')">
                    <el-button text :icon="Refresh" :loading="isDocumentsLoading" @click="reloadDocumentPage" />
                  </el-tooltip>
                  <small v-if="documentsPage?.tookMs !== null && documentsPage?.tookMs !== undefined">{{ documentsPage.tookMs }} ms</small>
                </div>
                <div class="documents-subtoolbar-actions">
                  <el-radio-group v-model="documentViewMode" size="small" :aria-label="text('文档视图', 'Document view')">
                    <el-radio-button value="table">{{ text('表格', 'Table') }}</el-radio-button>
                    <el-radio-button value="json">JSON</el-radio-button>
                  </el-radio-group>
                  <el-tooltip :content="isDocumentWriteDisabled ? documentWriteDisabledReason : text('新增行', 'Add Row')">
                    <el-button circle size="small" :icon="Plus" :disabled="isDocumentWriteDisabled || isCommittingChanges" @click="addLocalRow" />
                  </el-tooltip>
                  <el-tooltip :content="text('标记选中行删除', 'Delete selected rows')">
                    <el-button circle size="small" type="danger" plain :icon="Delete" :disabled="isDocumentWriteDisabled || isCommittingChanges || !selectedDocumentRows.length" @click="markRowsDeleted()" />
                  </el-tooltip>
                  <el-tooltip :content="text('撤销选中行变更', 'Revert selected changes')">
                    <el-button circle size="small" :icon="RefreshLeft" :disabled="isCommittingChanges || !selectedDocumentRows.length" @click="revertSelectedRows" />
                  </el-tooltip>
                  <el-tooltip :content="text('预览批量变更', 'Preview changes')">
                    <el-badge :value="currentIndexChanges.length" :hidden="!hasCurrentIndexChanges">
                      <el-button circle size="small" :icon="View" :disabled="!hasCurrentIndexChanges" @click="openBulkPreview" />
                    </el-badge>
                  </el-tooltip>
                  <el-tooltip :content="text('提交全部变更', 'Submit changes')">
                    <el-button circle size="small" type="primary" :icon="Check" :loading="isCommittingChanges" :disabled="isDocumentWriteDisabled || !hasCurrentIndexChanges" @click="submitDocumentChanges" />
                  </el-tooltip>
                  <el-tooltip :content="text('导入文档', 'Import documents')">
                    <el-button circle size="small" :icon="Upload" :disabled="isDocumentWriteDisabled || isCommittingChanges" @click="openImportDialog" />
                  </el-tooltip>
                  <el-tooltip :content="text('导出文档', 'Export documents')">
                    <el-button circle size="small" :icon="Download" @click="openExportDialog" />
                  </el-tooltip>
                  <el-tooltip :content="text('复制索引', 'Copy index')">
                    <el-button circle size="small" :icon="Document" :disabled="isCommittingChanges" @click="openCopyDialog" />
                  </el-tooltip>
                </div>
              </div>

              <el-alert v-if="documentsError" :title="documentsError" type="error" :closable="false" show-icon />
              <div
                ref="documentTableRegion"
                v-loading="isDocumentsLoading"
                class="documents-content"
                tabindex="0"
                @keydown="handleDocumentSelectionKeydown"
              >
                <el-table
                  v-if="documentViewMode === 'table'"
                  :data="displayedDocuments"
                  row-key="localKey"
                  height="100%"
                  size="small"
                  :empty-text="text('暂无文档', 'No documents')"
                  :row-class-name="documentRowClassName"
                  :cell-class-name="documentCellClassName"
                  @cell-click="handleDocumentCellClick"
                  @cell-dblclick="startCellEdit"
                  @sort-change="handleTableSortChange"
                >
                  <el-table-column prop="rowNumber" label="#" width="48" fixed>
                    <template #default="{ row }: { row: EditableDocument }">
                      <button
                        type="button"
                        class="document-row-number"
                        :class="{ active: selectedDocumentRows.some((item) => item.localKey === row.localKey) }"
                        @click.stop="handleRowNumberClick(row, $event)"
                      >{{ documentRowNumber(row) }}</button>
                    </template>
                  </el-table-column>
                  <el-table-column prop="id" label="_id" min-width="180" fixed>
                    <template #default="{ row }: { row: EditableDocument }">
                      <span :class="{ 'new-document-id': row.localOperation === 'create' }">{{ row.id || text('自动生成', 'Auto') }}</span>
                    </template>
                  </el-table-column>
                  <el-table-column prop="_score" label="_score" width="96" sortable="custom">
                    <template #default="{ row }: { row: IndexDocument }">
                      <span class="cell-value" :class="cellValueClass(row.score)">{{ formatCellValue(row.score) }}</span>
                    </template>
                  </el-table-column>
                  <el-table-column
                    v-for="field in documentColumns"
                    :key="field"
                    :prop="field"
                    :label="field"
                    min-width="150"
                    show-overflow-tooltip
                    :sortable="sortableFields.includes(field) ? 'custom' : false"
                  >
                    <template #default="{ row }: { row: EditableDocument }">
                      <el-input
                        v-if="editingCell?.localKey === row.localKey && editingCell.field === field"
                        v-model="editingCell.value"
                        size="small"
                        autofocus
                        class="inline-cell-editor"
                        @input="markCellEditorTouched"
                        @blur="commitCellEdit(row)"
                        @keyup.enter="commitCellEdit(row)"
                        @keyup.esc="cancelCellEdit"
                      />
                      <span v-else class="cell-value" :class="cellValueClass(row.source?.[field])">
                        {{ formatCellValue(row.source?.[field]) }}
                        <i v-if="row.dirtyFields.includes(field)" class="dirty-indicator" />
                      </span>
                    </template>
                  </el-table-column>
                </el-table>
                <pre v-else class="json-view">{{ documentsJson }}</pre>
              </div>
            </div>
          </el-tab-pane>

          <el-tab-pane :label="text('映射', 'Mapping')" name="mapping">
            <div v-loading="isMetadataLoading" class="metadata-pane">
              <el-alert v-if="metadataError" :title="metadataError" type="error" :closable="false" show-icon />
              <pre v-else-if="metadata" class="json-view">{{ formatJson(metadata.mapping) }}</pre>
              <div v-else class="metadata-empty"><Document /><span>{{ text('暂无映射数据', 'No mapping data') }}</span></div>
            </div>
          </el-tab-pane>

          <el-tab-pane :label="text('设置', 'Settings')" name="settings">
            <div v-loading="isMetadataLoading" class="metadata-pane">
              <el-alert v-if="metadataError" :title="metadataError" type="error" :closable="false" show-icon />
              <pre v-else-if="metadata" class="json-view">{{ formatJson(metadata.settings) }}</pre>
              <div v-else class="metadata-empty"><Document /><span>{{ text('暂无设置数据', 'No settings data') }}</span></div>
            </div>
          </el-tab-pane>

          <el-tab-pane :label="text('别名', 'Aliases')" name="aliases">
            <div v-loading="isMetadataLoading" class="metadata-pane">
              <el-alert v-if="metadataError" :title="metadataError" type="error" :closable="false" show-icon />
              <el-table v-else :data="metadata?.aliases ?? []" height="100%" size="small" :empty-text="text('暂无别名', 'No aliases')">
                <el-table-column prop="name" :label="text('名称', 'Name')" min-width="180" />
                <el-table-column prop="routing" label="routing" min-width="130" />
                <el-table-column prop="indexRouting" label="index_routing" min-width="130" />
                <el-table-column prop="searchRouting" label="search_routing" min-width="130" />
                <el-table-column :label="text('写索引', 'Write index')" width="96">
                  <template #default="{ row }">{{ row.isWriteIndex === null ? '--' : row.isWriteIndex ? text('是', 'Yes') : text('否', 'No') }}</template>
                </el-table-column>
                <el-table-column :label="text('过滤器', 'Filter')" min-width="220" show-overflow-tooltip>
                  <template #default="{ row }">{{ row.filter ? formatCellValue(row.filter) : '--' }}</template>
                </el-table-column>
              </el-table>
            </div>
          </el-tab-pane>

          <el-tab-pane :label="text('统计', 'Stats')" name="stats">
            <div v-loading="isMetadataLoading" class="metadata-pane stats-pane">
              <el-alert v-if="metadataError" :title="metadataError" type="error" :closable="false" show-icon />
              <dl v-else-if="metadata" class="stats-grid">
                <div><dt>{{ text('文档数', 'Documents') }}</dt><dd>{{ formatCount(metadata.stats.documentCount) }}</dd></div>
                <div><dt>{{ text('已删除文档', 'Deleted documents') }}</dt><dd>{{ formatCount(metadata.stats.deletedDocumentCount) }}</dd></div>
                <div><dt>{{ text('总存储', 'Total store') }}</dt><dd>{{ formatBytes(metadata.stats.storeSizeBytes) }}</dd></div>
                <div><dt>{{ text('主分片存储', 'Primary store') }}</dt><dd>{{ formatBytes(metadata.stats.primaryStoreSizeBytes) }}</dd></div>
                <div><dt>{{ text('主分片', 'Primary shards') }}</dt><dd>{{ formatCount(selectedIndex.primaryShards) }}</dd></div>
                <div><dt>{{ text('副本分片', 'Replica shards') }}</dt><dd>{{ formatCount(selectedIndex.replicaShards) }}</dd></div>
              </dl>
              <div v-else class="metadata-empty"><DataAnalysis /><span>{{ text('暂无统计数据', 'No stats data') }}</span></div>
            </div>
          </el-tab-pane>
        </el-tabs>
      </template>
    </main>

    <el-dialog
      v-model="isCreateIndexDialogVisible"
      append-to-body
      width="720px"
      :close-on-click-modal="false"
      :title="text('添加索引', 'Add index')"
    >
      <el-form label-position="top" class="index-create-form">
        <el-form-item :label="text('索引名称', 'Index name')">
          <el-input
            v-model="createIndexName"
            clearable
            autofocus
            :placeholder="text('只能使用小写精确名称，例如 orders-2026', 'Lowercase exact name, for example orders-2026')"
          />
        </el-form-item>
        <el-form-item :label="text('Settings（可选 JSON 对象）', 'Settings (optional JSON object)')">
          <el-input v-model="createIndexSettingsJson" type="textarea" :rows="5" spellcheck="false" class="json-editor" />
        </el-form-item>
        <el-form-item :label="text('Mapping（可选 JSON 对象）', 'Mapping (optional JSON object)')">
          <el-input v-model="createIndexMappingsJson" type="textarea" :rows="7" spellcheck="false" class="json-editor" />
        </el-form-item>
        <el-form-item :label="text('Aliases（可选 JSON 对象）', 'Aliases (optional JSON object)')">
          <el-input v-model="createIndexAliasesJson" type="textarea" :rows="4" spellcheck="false" class="json-editor" />
        </el-form-item>
        <el-alert
          :title="text('留空配置会创建空索引，并使用集群默认 Settings。', 'Leaving configuration empty creates an empty index with cluster defaults.')"
          type="info"
          :closable="false"
          show-icon
        />
        <el-alert v-if="createIndexError" :title="createIndexError" type="error" :closable="false" show-icon />
      </el-form>
      <template #footer>
        <el-button :disabled="isCreatingIndex" @click="isCreateIndexDialogVisible = false">{{ text('取消', 'Cancel') }}</el-button>
        <el-button type="primary" :loading="isCreatingIndex" :disabled="!createIndexName.trim()" @click="createIndex">
          {{ text('创建索引', 'Create index') }}
        </el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="isBulkPreviewVisible"
      append-to-body
      width="760px"
      :close-on-click-modal="false"
      :title="text('批量变更预览', 'Bulk Change Preview')"
    >
      <div class="bulk-preview-summary">
        <el-tag type="success">create {{ currentIndexChanges.filter((item) => item.operation === 'create').length }}</el-tag>
        <el-tag type="warning">index {{ currentIndexChanges.filter((item) => item.operation === 'update').length }}</el-tag>
        <el-tag type="danger">delete {{ currentIndexChanges.filter((item) => item.operation === 'delete').length }}</el-tag>
      </div>
      <pre class="bulk-preview-code">{{ bulkPreviewText }}</pre>
      <el-alert v-if="commitError" :title="commitError" type="error" :closable="false" show-icon />
      <template #footer>
        <el-button :disabled="isCommittingChanges" @click="isBulkPreviewVisible = false">{{ text('关闭', 'Close') }}</el-button>
        <el-button type="primary" :loading="isCommittingChanges" :disabled="isDocumentWriteDisabled || !hasCurrentIndexChanges" @click="submitDocumentChanges">
          {{ text('提交全部变更', 'Submit All Changes') }}
        </el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="isDocumentEditorVisible"
      append-to-body
      width="680px"
      :close-on-click-modal="false"
      :title="documentEditorMode === 'create' ? text('新增文档', 'Create document') : text('编辑文档', 'Edit document')"
    >
      <el-form label-position="top" class="document-editor-form">
        <el-form-item label="_id">
          <el-input
            v-model="documentEditorId"
            clearable
            :disabled="documentEditorMode === 'edit'"
            :placeholder="text('留空则由 Elasticsearch 自动生成', 'Leave blank to generate automatically')"
          />
        </el-form-item>
        <el-form-item :label="text('文档内容（JSON 对象）', 'Document body (JSON object)')">
          <el-input v-model="documentEditorJson" type="textarea" :rows="16" spellcheck="false" class="json-editor" />
        </el-form-item>
        <el-alert v-if="documentEditorError" :title="documentEditorError" type="error" :closable="false" show-icon />
      </el-form>
      <template #footer>
        <el-button :disabled="isDocumentMutationLoading" @click="isDocumentEditorVisible = false">{{ text('取消', 'Cancel') }}</el-button>
        <el-button type="primary" :loading="isDocumentMutationLoading" @click="saveDocument">{{ text('保存', 'Save') }}</el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="isImportDialogVisible"
      append-to-body
      width="600px"
      :close-on-click-modal="false"
      :title="text('导入文档', 'Import documents')"
    >
      <el-form label-position="top" class="transfer-form">
        <el-form-item :label="text('文件格式', 'File format')">
          <el-radio-group v-model="importFormat">
            <el-radio-button value="csv">CSV</el-radio-button>
            <el-radio-button value="json">JSON</el-radio-button>
            <el-radio-button value="dump">Dump</el-radio-button>
            <el-radio-button value="copy">Copy Index</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item v-if="importFormat !== 'copy'" :label="text('写入操作', 'Operation')">
          <el-segmented v-model="importOperation" :options="['index', 'create', 'update']" />
        </el-form-item>
        <el-form-item v-if="importFormat !== 'copy'" :label="text('导入文件', 'Import file')">
          <input ref="importFileInput" type="file" hidden accept=".csv,.json,.dump" @change="handleImportFileChange" />
          <div class="file-picker-row">
            <el-button :icon="Upload" @click="chooseImportFile">{{ text('选择文件', 'Choose file') }}</el-button>
            <span :title="importFile?.name">{{ importFile?.name || text('尚未选择文件', 'No file selected') }}</span>
          </div>
        </el-form-item>
        <el-alert
          v-if="importFormat !== 'copy'"
          :title="text('文件将按每批 1,000 条写入；update 操作要求每条文档包含 _id。', 'Files are written in batches of 1,000; update requires an _id for every document.')"
          type="info"
          :closable="false"
          show-icon
        />
        <el-alert v-if="importError" :title="importError" type="error" :closable="false" show-icon />
      </el-form>
      <template #footer>
        <el-button :disabled="isImporting" @click="isImportDialogVisible = false">{{ text('取消', 'Cancel') }}</el-button>
        <el-button
          type="primary"
          :loading="isImporting"
          :disabled="importFormat !== 'copy' && !importFile"
          @click="importDocuments"
        >{{ importFormat === 'copy' ? text('下一步', 'Next') : text('开始导入', 'Import') }}</el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="isExportDialogVisible"
      append-to-body
      width="620px"
      :close-on-click-modal="false"
      :title="text('导出文档', 'Export documents')"
    >
      <el-form label-position="top" class="transfer-form">
        <el-form-item :label="text('导出格式', 'Export format')">
          <el-radio-group v-model="exportFormat">
            <el-radio-button value="csv">CSV</el-radio-button>
            <el-radio-button value="dsv">DSV</el-radio-button>
            <el-radio-button value="json">JSON</el-radio-button>
            <el-radio-button value="bulk">Bulk API</el-radio-button>
            <el-radio-button value="dump">Dump</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item :label="text('导出范围', 'Export scope')">
          <el-radio-group v-model="exportScope">
            <el-radio value="page">{{ text('当前页', 'Current page') }}</el-radio>
            <el-radio value="query">{{ text('当前查询全部（最多 10,000 条）', 'All query results (up to 10,000)') }}</el-radio>
          </el-radio-group>
        </el-form-item>
        <template v-if="exportFormat === 'csv' || exportFormat === 'dsv'">
          <el-form-item v-if="exportFormat === 'dsv'" :label="text('分隔符', 'Delimiter')">
            <el-input v-model="exportDelimiter" maxlength="1" :placeholder="text('例如 | 或制表符', 'For example | or a tab')" />
          </el-form-item>
          <el-form-item :label="text('提取选项', 'Extractor options')">
            <div class="transfer-options">
              <el-checkbox v-model="exportTranspose">Transpose</el-checkbox>
              <el-checkbox v-model="exportAlwaysQuote">{{ text('总是加引号', 'Always quote') }}</el-checkbox>
              <el-checkbox v-model="exportIncludeHeader">{{ text('包含表头', 'Add row header') }}</el-checkbox>
            </div>
          </el-form-item>
        </template>
        <el-form-item :label="text('压缩', 'Compression')">
          <el-switch v-model="exportGzip" size="small" active-text="gzip" />
        </el-form-item>
        <el-alert v-if="exportError" :title="exportError" type="error" :closable="false" show-icon />
      </el-form>
      <template #footer>
        <el-button :disabled="isExporting" @click="isExportDialogVisible = false">{{ text('取消', 'Cancel') }}</el-button>
        <el-button type="primary" :icon="Download" :loading="isExporting" @click="exportDocuments">{{ text('导出', 'Export') }}</el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="isCopyDialogVisible"
      append-to-body
      width="760px"
      :close-on-click-modal="false"
      :title="text('复制索引', 'Copy index')"
    >
      <el-form label-position="top" class="transfer-form copy-index-form">
        <div class="copy-form-grid">
          <el-form-item :label="text('目标连接', 'Target connection')">
            <el-select v-model="targetConnectionId" filterable :placeholder="text('选择可写连接', 'Select a writable connection')">
              <el-option v-for="connection in writableTargetConnections" :key="connection.id" :label="connection.name" :value="connection.id" />
            </el-select>
          </el-form-item>
          <el-form-item :label="text('目标索引', 'Target index')">
            <el-input v-model="targetIndexName" />
          </el-form-item>
          <el-form-item :label="text('目标模式', 'Target mode')">
            <el-radio-group v-model="createTargetIndex">
              <el-radio :value="true">{{ text('新建索引', 'New index') }}</el-radio>
              <el-radio :value="false">{{ text('已有索引', 'Existing index') }}</el-radio>
            </el-radio-group>
          </el-form-item>
          <el-form-item :label="text('写入操作', 'Operation')">
            <el-select v-model="copyOperation">
              <el-option label="index" value="index" />
              <el-option label="create" value="create" />
              <el-option label="update" value="update" />
            </el-select>
          </el-form-item>
          <el-form-item label="Batch size">
            <el-input-number v-model="copyBatchSize" :min="1" :max="1000" controls-position="right" />
          </el-form-item>
          <el-form-item :label="text('每批限速（毫秒）', 'Throttle per batch (ms)')">
            <el-input-number v-model="copyThrottleMs" :min="0" :max="60000" :step="100" controls-position="right" />
          </el-form-item>
        </div>
        <div class="field-mapping-header">
          <strong>{{ text('字段映射', 'Field mapping') }}</strong>
          <small>{{ text('留空的映射不会复制；默认保持字段名不变。', 'Empty mappings are skipped; field names are preserved by default.') }}</small>
        </div>
        <div class="field-mapping-list">
          <div v-for="(mapping, index) in copyFieldMappings" :key="`${mapping.source}-${index}`" class="field-mapping-row">
            <el-input v-model="mapping.source" readonly />
            <span>→</span>
            <el-input v-model="mapping.target" clearable />
          </div>
        </div>
        <el-alert
          v-if="createTargetIndex && !indicesApi.copyIndex"
          :title="text('当前使用批量写入兼容模式，新建目标索引依赖 Elasticsearch 自动建索引配置。', 'Compatibility mode uses bulk writes; creating the target depends on Elasticsearch automatic index creation.')"
          type="warning"
          :closable="false"
          show-icon
        />
        <el-alert v-if="copyError" :title="copyError" type="error" :closable="false" show-icon />
      </el-form>
      <template #footer>
        <el-button :disabled="isCopying" @click="isCopyDialogVisible = false">{{ text('取消', 'Cancel') }}</el-button>
        <el-button
          type="primary"
          :loading="isCopying"
          :disabled="!targetConnectionId || !targetIndexName.trim()"
          @click="copyIndexDocuments"
        >{{ text('开始复制', 'Copy') }}</el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.index-browser {
  --document-row-base: #ffffff;

  display: grid;
  grid-template-columns: 280px minmax(0, 1fr);
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--color-canvas, #f4f6f8);
  color: var(--color-text, #20262d);
}

:global(html[data-theme="dark"]) .index-browser {
  --document-row-base: #1d232a;
}

:global(html[data-theme="starlight"]) .index-browser {
  --document-row-base: #0f172a;
}

:global(html[data-theme="pixel"]) .index-browser {
  --document-row-base: #18221c;
}

.index-sidebar {
  display: grid;
  grid-template-rows: 48px auto minmax(0, 1fr);
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  border-right: 1px solid var(--color-line, #dde2e7);
  background: var(--color-panel-muted, #f8fafb);
}

.index-sidebar-header,
.index-detail-header,
.documents-subtoolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.index-sidebar-header {
  padding: 0 12px 0 14px;
  border-bottom: 1px solid var(--color-line, #dde2e7);
}

.index-sidebar-header > div {
  display: flex;
  min-width: 0;
  align-items: baseline;
  gap: 7px;
}

.index-sidebar-header strong,
.index-title strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.index-sidebar-header strong {
  font-size: 12px;
}

.index-sidebar-header small,
.index-title small {
  color: var(--color-text-muted, #8a949e);
  font-size: 10px;
}

.index-sidebar-header-actions {
  display: flex;
  align-items: center;
  gap: 2px;
}

.index-sidebar-controls {
  display: grid;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--color-line, #dde2e7);
}

.index-sidebar-controls :deep(.el-input__wrapper),
.index-sidebar-controls :deep(.el-select__wrapper),
.documents-toolbar :deep(.el-input__wrapper),
.documents-toolbar :deep(.el-select__wrapper) {
  border-radius: 4px;
}

.index-sort-controls {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 32px;
  gap: 6px;
}

.index-sort-controls .el-button {
  width: 32px;
  margin: 0;
  padding: 0;
}

.index-list {
  min-height: 0;
  padding: 8px;
  overflow: auto;
}

.index-compatibility-warning {
  margin-bottom: 8px;
}

.index-list-item {
  display: grid;
  grid-template-columns: 8px minmax(0, 1fr) auto;
  width: 100%;
  min-height: 52px;
  align-items: center;
  gap: 9px;
  padding: 8px 9px;
  border: 1px solid transparent;
  border-radius: 5px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.index-list-item + .index-list-item {
  margin-top: 3px;
}

.index-list-item:hover {
  border-color: var(--color-line, #dde2e7);
  background: var(--color-panel, #fff);
  outline: none;
}

.documents-content:focus-visible {
  border-color: var(--color-info, #367fb5);
  box-shadow: 0 0 0 1px var(--color-info, #367fb5);
}

.index-list-item.active {
  border-color: #edaa9f;
  background: var(--color-accent-soft, #fff1ee);
}

.index-list-copy {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 3px;
}

.index-list-copy strong,
.index-list-copy small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.index-list-copy strong {
  font-family: "SFMono-Regular", Consolas, monospace;
  font-size: 11px;
  font-weight: 600;
}

.index-list-copy small,
.index-status {
  color: var(--color-text-muted, #8a949e);
  font-size: 9px;
}

.index-status {
  max-width: 76px;
  line-height: 14px;
  text-align: right;
}

.index-health-dot {
  width: 8px;
  height: 8px;
  flex: 0 0 auto;
  border-radius: 50%;
  background: var(--color-text-muted, #8a949e);
}

.index-health-dot.health-green {
  background: var(--color-success, #218b69);
}

.index-health-dot.health-yellow {
  background: var(--color-warning, #c98220);
}

.index-health-dot.health-red {
  background: var(--color-danger, #c43d3d);
}

.index-sidebar-empty,
.index-detail-empty,
.metadata-empty {
  display: grid;
  place-content: center;
  justify-items: center;
  color: var(--color-text-muted, #8a949e);
  text-align: center;
}

.index-sidebar-empty {
  min-height: 160px;
  padding: 20px;
  gap: 6px;
}

.index-sidebar-empty.compact {
  min-height: 120px;
}

.index-sidebar-empty .el-icon,
.index-detail-empty .el-icon {
  margin-bottom: 4px;
  color: var(--color-accent, #e6533f);
  font-size: 26px;
}

.index-sidebar-empty strong,
.index-detail-empty strong {
  color: var(--color-text-secondary, #5f6b76);
  font-size: 12px;
}

.index-sidebar-empty small,
.index-detail-empty small {
  font-size: 10px;
  line-height: 17px;
}

.index-sidebar-message {
  display: flex;
  min-height: 0;
  flex-direction: column;
  align-items: flex-start;
  gap: 10px;
  padding: 10px;
  overflow: auto;
}

.index-detail {
  display: grid;
  grid-template-rows: 34px 56px minmax(0, 1fr);
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--color-panel, #fff);
}

.opened-index-tabs {
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  border-bottom: 1px solid var(--color-line, #dde2e7);
  background: var(--color-panel-muted, #f8fafb);
}

.opened-index-tabs :deep(.el-tabs__header) {
  height: 34px;
  margin: 0;
  border-bottom: 0;
}

.opened-index-tabs :deep(.el-tabs__nav) {
  border: 0;
}

.opened-index-tabs :deep(.el-tabs__item) {
  max-width: 240px;
  height: 34px;
  border-top: 0;
  border-bottom: 0;
  border-left-color: var(--color-line, #dde2e7);
  color: var(--color-text-secondary, #5b6670);
  font-size: 11px;
}

.opened-index-tabs :deep(.el-tabs__item.is-active) {
  background: var(--color-panel, #fff);
  color: var(--color-accent, #e6533f);
}

.opened-index-tabs :deep(.el-tabs__content) {
  display: none;
}

.opened-index-tab-label {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 7px;
}

.opened-index-tab-label > span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.opened-index-tab-label b {
  display: grid;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  place-items: center;
  border-radius: 8px;
  background: var(--color-warning, #c98220);
  color: #fff;
  font-size: 9px;
  font-weight: 700;
  line-height: 16px;
}

:global(html:is([data-theme="starlight"], [data-theme="pixel"]) .index-browser .opened-index-tab-label b) {
  color: var(--color-canvas);
}

.index-detail-empty {
  grid-row: 1 / -1;
  gap: 7px;
}

.index-detail-header {
  min-width: 0;
  padding: 0 14px 0 16px;
  border-bottom: 1px solid var(--color-line, #dde2e7);
}

.index-title {
  display: grid;
  grid-template-columns: 8px minmax(0, 1fr);
  min-width: 0;
  align-items: center;
  gap: 10px;
}

.index-title > div {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 3px;
}

.index-title strong {
  font-family: "SFMono-Regular", Consolas, monospace;
  font-size: 13px;
}

.index-header-actions {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 8px;
}

.index-detail-tabs {
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.index-detail-tabs :deep(.el-tabs__header) {
  height: 42px;
  margin: 0;
  padding: 0 16px;
}

.index-detail-tabs :deep(.el-tabs__nav-wrap::after) {
  height: 1px;
  background: var(--color-line, #dde2e7);
}

.index-detail-tabs :deep(.el-tabs__item) {
  height: 42px;
  padding: 0 15px;
  font-size: 11px;
}

.index-detail-tabs :deep(.el-tabs__item.is-active),
.index-detail-tabs :deep(.el-tabs__item:hover) {
  color: var(--color-accent, #e6533f);
}

.index-detail-tabs :deep(.el-tabs__active-bar) {
  background: var(--color-accent, #e6533f);
}

.index-detail-tabs :deep(.el-tabs__content),
.index-detail-tabs :deep(.el-tab-pane) {
  height: 100%;
  min-height: 0;
}

.index-detail-tabs :deep(.el-tabs__content) {
  height: calc(100% - 42px);
  overflow: hidden;
}

.documents-pane {
  display: grid;
  grid-template-rows: auto auto auto minmax(0, 1fr);
  height: 100%;
  min-height: 0;
  padding: 12px 14px;
  gap: 10px;
}

.documents-toolbar {
  display: grid;
  grid-row: 2;
  grid-template-columns: minmax(240px, 1fr) minmax(130px, 0.48fr) 104px auto auto auto;
  gap: 7px;
}

.documents-toolbar :deep(.el-autocomplete) {
  width: 100%;
}

.documents-toolbar .el-button {
  margin: 0;
}

.documents-subtoolbar {
  grid-row: 1;
  min-width: 0;
  min-height: 36px;
  gap: 12px;
  overflow-x: auto;
  border-bottom: 1px solid var(--color-line, #dde2e7);
}

.documents-subtoolbar > span {
  display: flex;
  align-items: baseline;
  gap: 6px;
  color: var(--color-text-muted, #8a949e);
  font-size: 10px;
}

.documents-subtoolbar strong {
  color: var(--color-text, #20262d);
  font-size: 12px;
}

.documents-subtoolbar small {
  padding-left: 6px;
  border-left: 1px solid var(--color-line, #dde2e7);
}

.documents-subtoolbar-actions,
.documents-page-toolbar,
.file-picker-row,
.transfer-options {
  display: flex;
  align-items: center;
  gap: 8px;
}

.documents-page-toolbar,
.documents-subtoolbar-actions {
  flex: 0 0 auto;
}

.documents-page-toolbar {
  gap: 1px;
}

.documents-page-toolbar .el-button {
  width: 28px;
  height: 28px;
  margin: 0;
}

.documents-page-toolbar .page-range-button {
  width: auto;
  min-width: 64px;
  padding: 0 9px;
  font-family: "SFMono-Regular", Consolas, monospace;
}

.page-total {
  padding: 0 7px;
  color: var(--color-text-secondary, #5f6b76);
  font-size: 11px;
  white-space: nowrap;
}

.documents-subtoolbar-actions .el-button {
  margin: 0;
}

.documents-content,
.metadata-pane {
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  border: 1px solid var(--color-line, #dde2e7);
  border-radius: 5px;
  background: var(--color-panel, #fff);
}

.documents-content :deep(.el-table),
.metadata-pane :deep(.el-table) {
  --el-table-border-color: var(--color-line, #dde2e7);
  --el-table-header-bg-color: var(--color-panel-muted, #f8fafb);
  color: var(--color-text, #20262d);
  font-family: "SFMono-Regular", Consolas, monospace;
  font-size: 12px;
  line-height: 18px;
}

.documents-content :deep(.el-table th.el-table__cell) {
  color: var(--color-text-secondary, #5f6b76);
  font-weight: 700;
}

.document-row-number {
  display: grid;
  width: 26px;
  height: 22px;
  margin: 0 auto;
  place-items: center;
  border: 0;
  border-radius: 3px;
  background: transparent;
  color: var(--color-text-muted, #8a949e);
  cursor: pointer;
}

.document-row-number:hover,
.document-row-number.active {
  background: var(--color-accent-soft, #fff1ee);
  color: var(--color-accent, #e6533f);
  font-weight: 700;
}

.documents-content :deep(.document-row-selected > td.el-table__cell) {
  background: #fff6f4;
  background: color-mix(in srgb, var(--color-accent, #e6533f) 6%, var(--document-row-base));
}

.documents-content :deep(.document-row-create > td.el-table__cell) {
  background: #f1faf7;
  background: color-mix(in srgb, var(--color-success, #218b69) 8%, var(--document-row-base));
}

.documents-content :deep(.document-row-delete > td.el-table__cell) {
  background: #fbf2f2;
  background: color-mix(in srgb, var(--color-danger, #c43d3d) 8%, var(--document-row-base));
  color: var(--color-text-muted, #8a949e);
  text-decoration: line-through;
}

.documents-content :deep(td.document-cell-dirty) {
  box-shadow: inset 0 -2px 0 var(--color-warning, #c98220);
}

.documents-content :deep(td.document-cell-selected) {
  box-shadow: inset 0 0 0 2px var(--color-info, #367fb5);
}

.inline-cell-editor :deep(.el-input__wrapper) {
  padding: 0 6px;
  box-shadow: 0 0 0 1px var(--color-info, #367fb5) inset;
}

.dirty-indicator {
  display: inline-block;
  width: 5px;
  height: 5px;
  margin-left: 4px;
  border-radius: 50%;
  background: var(--color-warning, #c98220);
  vertical-align: top;
}

.new-document-id {
  color: var(--color-success, #218b69);
  font-style: italic;
}

.cell-value {
  display: inline-block;
  max-width: 100%;
  overflow: hidden;
  vertical-align: middle;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cell-value.null-value {
  padding: 0 4px;
  border-radius: 3px;
  color: #1c6ea4;
  background: rgb(54 127 181 / 10%);
  font-style: italic;
  font-weight: 650;
}

.cell-value.undefined-value {
  color: var(--color-text-muted, #8a949e);
}

.cell-value.number-value {
  color: #9a4d00;
}

.cell-value.boolean-value {
  color: #7b3fb2;
  font-weight: 600;
}

.cell-value.object-value {
  color: #21765b;
}

:global(html:is([data-theme="dark"], [data-theme="starlight"], [data-theme="pixel"]) .index-browser .cell-value.null-value) {
  color: var(--color-info);
  background: color-mix(in srgb, var(--color-info) 18%, transparent);
}

:global(html:is([data-theme="dark"], [data-theme="starlight"], [data-theme="pixel"]) .index-browser .cell-value.number-value) {
  color: var(--color-warning);
}

:global(html:is([data-theme="dark"], [data-theme="starlight"], [data-theme="pixel"]) .index-browser .cell-value.boolean-value) {
  color: var(--color-accent-hover);
}

:global(html:is([data-theme="dark"], [data-theme="starlight"], [data-theme="pixel"]) .index-browser .cell-value.object-value) {
  color: var(--color-success);
}

.json-view {
  width: 100%;
  height: 100%;
  margin: 0;
  padding: 14px;
  overflow: auto;
  color: var(--color-text-secondary, #5f6b76);
  background: var(--color-panel-muted, #f8fafb);
  font-family: "SFMono-Regular", Consolas, monospace;
  font-size: 12px;
  line-height: 20px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

:global(html:is([data-theme="dark"], [data-theme="starlight"], [data-theme="pixel"]) .index-browser .json-view) {
  color: var(--color-text-secondary);
  background: var(--color-panel-muted);
}

.bulk-preview-summary {
  display: flex;
  gap: 8px;
  margin-bottom: 10px;
}

.bulk-preview-code {
  max-height: 440px;
  margin: 0 0 12px;
  padding: 12px;
  overflow: auto;
  border: 1px solid var(--color-line, #dde2e7);
  border-radius: 4px;
  background: var(--color-panel-muted, #f8fafb);
  color: var(--color-text, #20262d);
  font-family: "SFMono-Regular", Consolas, monospace;
  font-size: 11px;
  line-height: 18px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.query-suggestion-label {
  display: inline-block;
  max-width: 190px;
  margin-right: 8px;
  overflow: hidden;
  color: var(--color-text, #20262d);
  font-family: "SFMono-Regular", Consolas, monospace;
  font-weight: 650;
  text-overflow: ellipsis;
  vertical-align: middle;
  white-space: nowrap;
}

.query-suggestion-label + .el-tag {
  margin-right: 8px;
}

.query-history-header,
.field-mapping-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.query-history-list {
  max-height: 320px;
  margin-top: 8px;
  overflow: auto;
}

.query-history-item {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  width: 100%;
  gap: 4px 12px;
  padding: 9px 8px;
  border: 0;
  border-bottom: 1px solid var(--color-line, #dde2e7);
  background: transparent;
  color: var(--color-text-secondary, #5f6b76);
  text-align: left;
  cursor: pointer;
}

.query-history-item:hover {
  background: var(--color-panel-muted, #f8fafb);
}

.query-history-item code {
  overflow: hidden;
  color: var(--color-text, #20262d);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.query-history-item small {
  grid-column: 1 / -1;
  color: var(--color-text-muted, #8a949e);
}

.document-editor-form,
.index-create-form,
.transfer-form {
  display: grid;
  gap: 4px;
}

.json-editor :deep(textarea) {
  font-family: "SFMono-Regular", Consolas, monospace;
  font-size: 12px;
  line-height: 19px;
}

.file-picker-row {
  width: 100%;
  min-width: 0;
}

.file-picker-row span {
  min-width: 0;
  overflow: hidden;
  color: var(--color-text-secondary, #5f6b76);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.copy-form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0 16px;
}

.copy-form-grid :deep(.el-select),
.copy-form-grid :deep(.el-input-number) {
  width: 100%;
}

.field-mapping-header {
  margin: 6px 0 8px;
}

.field-mapping-header small {
  color: var(--color-text-muted, #8a949e);
}

.field-mapping-list {
  max-height: 240px;
  padding: 8px;
  overflow: auto;
  border: 1px solid var(--color-line, #dde2e7);
  border-radius: 4px;
}

.field-mapping-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 20px minmax(0, 1fr);
  align-items: center;
  gap: 6px;
}

.field-mapping-row + .field-mapping-row {
  margin-top: 6px;
}

.field-mapping-row > span {
  color: var(--color-text-muted, #8a949e);
  text-align: center;
}

.metadata-pane {
  height: calc(100% - 24px);
  margin: 12px 14px;
}

.metadata-pane > .el-alert {
  margin: 12px;
  width: calc(100% - 24px);
}

.metadata-empty {
  height: 100%;
  gap: 8px;
  font-size: 11px;
}

.metadata-empty > svg {
  width: 26px;
  height: 26px;
  color: var(--color-accent, #e6533f);
}

.stats-pane {
  border: 0;
  background: transparent;
}

.stats-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  margin: 0;
  overflow: hidden;
  border: 1px solid var(--color-line, #dde2e7);
  border-radius: 5px;
  background: var(--color-panel, #fff);
}

.stats-grid > div {
  min-width: 0;
  padding: 16px;
  border-right: 1px solid var(--color-line, #dde2e7);
  border-bottom: 1px solid var(--color-line, #dde2e7);
}

.stats-grid > div:nth-child(3n) {
  border-right: 0;
}

.stats-grid > div:nth-last-child(-n + 3) {
  border-bottom: 0;
}

.stats-grid dt {
  margin-bottom: 7px;
  color: var(--color-text-muted, #8a949e);
  font-size: 10px;
}

.stats-grid dd {
  margin: 0;
  overflow: hidden;
  color: var(--color-text, #20262d);
  font-size: 17px;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (max-width: 900px) {
  .index-browser {
    grid-template-columns: 230px minmax(0, 1fr);
  }

  .documents-toolbar {
    grid-template-columns: minmax(180px, 1fr) minmax(120px, 0.6fr) 100px auto;
  }

  .documents-toolbar .el-button {
    grid-row: 2;
  }
}
</style>
