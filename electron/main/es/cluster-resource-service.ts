import type { ConnectionSummary } from '../../../src/shared/types/connection'
import type {
  ClusterResourceAccess,
  ClusterResourceApi,
  ClusterResourceDetail,
  ClusterResourceDetailInput,
  ClusterResourceErrorCode,
  ClusterResourceFact,
  ClusterResourceItem,
  ClusterResourceKind,
  ClusterResourceListInput,
  ClusterResourceListResult,
  ClusterResourceOperationAction,
  ClusterResourceOperationCapability,
  ClusterResourceOperationRequest,
  ClusterResourceOperationResult,
  ClusterResourceValue,
  ClusterTaskState
} from '../../../src/shared/types/cluster-resource'
import type { CapabilityDecision, CapabilityKey, CapabilityMatrix } from '../../../src/shared/types/capability'
// Node 内置 TypeScript 测试器需要显式扩展名，Electron Vite 同样可以解析该源文件。
// @ts-expect-error TypeScript 测试运行时直接加载 .ts 源文件
import { createCapabilityMatrix } from './capability-matrix.ts'

type RequestOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  body?: string
  contentType?: 'application/json' | 'application/x-ndjson'
}

export type ClusterResourceConnectionService = {
  assertConnected: (connectionId: string) => string
  list: () => ConnectionSummary[]
  requestJson: <T>(
    connectionId: string,
    requestPath: string,
    options?: RequestOptions
  ) => Promise<T>
}

export type ClusterResourceServiceOptions = {
  now?: () => number
}

type ResourceContext = {
  connectionId: string
  kind: ClusterResourceKind
  connection: ConnectionSummary
  matrix: CapabilityMatrix
  decision: CapabilityDecision
  capability: string
}

type OperationDefinition = {
  kind: ClusterResourceKind
  method: 'POST' | 'PUT' | 'DELETE'
  destructive: boolean
  payload: 'required' | 'optional' | 'forbidden'
  path: (resourceId: string, context: ResourceContext) => string
}

const RESOURCE_KINDS = new Set<ClusterResourceKind>([
  'node',
  'task',
  'index-template',
  'component-template',
  'data-stream',
  'snapshot',
  'ingest-pipeline',
  'stored-script'
])

const RESOURCE_CAPABILITIES: Record<ClusterResourceKind, CapabilityKey> = {
  node: 'nodes',
  task: 'tasks',
  'index-template': 'indexTemplates',
  'component-template': 'componentTemplates',
  'data-stream': 'dataStreams',
  snapshot: 'snapshots',
  'ingest-pipeline': 'pipelines',
  'stored-script': 'scripts'
}

const OPERATIONS_BY_KIND: Record<ClusterResourceKind, ClusterResourceOperationAction[]> = {
  node: [],
  task: ['cancel-task'],
  'index-template': ['create-index-template', 'update-index-template', 'delete-index-template'],
  'component-template': [
    'create-component-template',
    'update-component-template',
    'delete-component-template'
  ],
  'data-stream': ['create-data-stream', 'delete-data-stream'],
  snapshot: ['create-snapshot', 'restore-snapshot', 'delete-snapshot'],
  'ingest-pipeline': [
    'create-ingest-pipeline',
    'update-ingest-pipeline',
    'delete-ingest-pipeline'
  ],
  'stored-script': ['create-stored-script', 'update-stored-script', 'delete-stored-script']
}

const OPERATION_IMPACTS: Record<ClusterResourceOperationAction, string> = {
  'create-index-template': '新增目标索引模板，影响后续匹配索引',
  'update-index-template': '更新目标索引模板，影响后续匹配索引',
  'delete-index-template': '删除目标索引模板，已有索引不受影响',
  'create-component-template': '新增可被索引模板引用的组件模板',
  'update-component-template': '更新组件模板及后续引用效果',
  'delete-component-template': '删除目标组件模板',
  'create-data-stream': '创建目标数据流，要求已有匹配的数据流索引模板',
  'delete-data-stream': '删除目标数据流及其所有后备索引和数据',
  'create-snapshot': '在指定仓库异步创建快照',
  'restore-snapshot': '从明确的 repository/snapshot 异步恢复索引和集群数据',
  'delete-snapshot': '从指定仓库删除目标快照',
  'create-ingest-pipeline': '新增目标 Ingest Pipeline',
  'update-ingest-pipeline': '更新目标 Ingest Pipeline',
  'delete-ingest-pipeline': '删除目标 Ingest Pipeline',
  'create-stored-script': '新增目标存储脚本',
  'update-stored-script': '更新目标存储脚本',
  'delete-stored-script': '删除目标存储脚本',
  'cancel-task': '请求取消目标运行中任务'
}

const OPERATION_DEFINITIONS: Partial<Record<ClusterResourceOperationAction, OperationDefinition>> = {
  'create-index-template': putDefinition('index-template', indexTemplateResourcePath),
  'update-index-template': putDefinition('index-template', indexTemplateResourcePath),
  'delete-index-template': deleteDefinition('index-template', indexTemplateResourcePath),
  'create-component-template': putDefinition('component-template', (id) => `/_component_template/${encodeResourceId(id)}`),
  'update-component-template': putDefinition('component-template', (id) => `/_component_template/${encodeResourceId(id)}`),
  'delete-component-template': deleteDefinition('component-template', (id) => `/_component_template/${encodeResourceId(id)}`),
  'create-data-stream': {
    kind: 'data-stream',
    method: 'PUT',
    destructive: false,
    payload: 'forbidden',
    path: (id) => `/_data_stream/${encodeResourceId(id)}`
  },
  'delete-data-stream': deleteDefinition('data-stream', (id) => `/_data_stream/${encodeResourceId(id)}`),
  'create-snapshot': {
    kind: 'snapshot',
    method: 'PUT',
    destructive: false,
    payload: 'optional',
    path: (id) => `${snapshotResourcePath(id)}?wait_for_completion=false`
  },
  'restore-snapshot': {
    kind: 'snapshot',
    method: 'POST',
    destructive: true,
    payload: 'required',
    path: (id) => `${snapshotResourcePath(id)}/_restore?wait_for_completion=false`
  },
  'delete-snapshot': deleteDefinition('snapshot', snapshotResourcePath),
  'create-ingest-pipeline': putDefinition('ingest-pipeline', (id) => `/_ingest/pipeline/${encodeResourceId(id)}`),
  'update-ingest-pipeline': putDefinition('ingest-pipeline', (id) => `/_ingest/pipeline/${encodeResourceId(id)}`),
  'delete-ingest-pipeline': deleteDefinition('ingest-pipeline', (id) => `/_ingest/pipeline/${encodeResourceId(id)}`),
  'create-stored-script': putDefinition('stored-script', (id) => `/_scripts/${encodeResourceId(id)}`),
  'update-stored-script': putDefinition('stored-script', (id) => `/_scripts/${encodeResourceId(id)}`),
  'delete-stored-script': deleteDefinition('stored-script', (id) => `/_scripts/${encodeResourceId(id)}`),
  'cancel-task': {
    kind: 'task',
    method: 'POST',
    destructive: true,
    payload: 'forbidden',
    path: (id) => `/_tasks/${encodeResourceId(id)}/_cancel`
  }
}

const MAX_IDENTIFIER_LENGTH = 160
const MAX_RESOURCE_ID_LENGTH = 512
const MAX_TEXT_LENGTH = 1_024
const MAX_PAYLOAD_BYTES = 5 * 1024 * 1024
const MAX_JSON_DEPTH = 64
const IDENTIFIER_PATTERN = /^[A-Za-z0-9._:-]+$/u
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u
const RESTORE_SNAPSHOT_PAYLOAD_FIELDS = new Set([
  'indices',
  'ignore_unavailable',
  'include_global_state',
  'feature_states',
  'rename_pattern',
  'rename_replacement',
  'include_aliases',
  'index_settings',
  'ignore_index_settings',
  'partial'
])

export class ClusterResourceServiceError extends Error {
  readonly code: ClusterResourceErrorCode
  readonly statusCode: number | null
  readonly capability: string | null

  constructor(
    code: ClusterResourceErrorCode,
    operation: string,
    reason: string,
    statusCode: number | null = null,
    capability: string | null = null,
    options?: ErrorOptions
  ) {
    super(`集群资源模块失败：操作=${operation}，原因=${reason}`, options)
    this.name = 'ClusterResourceServiceError'
    this.code = code
    this.statusCode = statusCode
    this.capability = capability
  }
}

export class ClusterResourceService implements ClusterResourceApi {
  private readonly connectionService: ClusterResourceConnectionService
  private readonly now: () => number

  constructor(
    connectionService: ClusterResourceConnectionService,
    options: ClusterResourceServiceOptions = {}
  ) {
    this.connectionService = connectionService
    this.now = options.now ?? Date.now
  }

  async list(input: ClusterResourceListInput): Promise<ClusterResourceListResult> {
    const normalized = normalizeListInput(input)
    const context = this.createContext(normalized.connectionId, normalized.kind)
    if (!context.decision.supported) {
      return createListResult(context, this.now(), createUnsupportedAccess(context), [])
    }

    try {
      const items = await this.readListItems(context)
      return createListResult(context, this.now(), createAvailableAccess(context), items)
    } catch (error: unknown) {
      const access = readAccessFailure(error, context)
      if (access) return createListResult(context, this.now(), access, [])
      throw normalizeServiceError(error, '列出集群资源', context.capability, true)
    }
  }

  async getDetail(input: ClusterResourceDetailInput): Promise<ClusterResourceDetail> {
    const normalized = normalizeDetailInput(input)
    const context = this.createContext(normalized.connectionId, normalized.kind)
    if (!context.decision.supported) {
      return {
        connectionId: context.connectionId,
        kind: context.kind,
        resourceId: normalized.resourceId,
        collectedAt: new Date(this.now()).toISOString(),
        access: createUnsupportedAccess(context),
        document: null
      }
    }

    try {
      const response = await this.connectionService.requestJson<unknown>(
        context.connectionId,
        detailPath(context, normalized.resourceId)
      )
      return {
        connectionId: context.connectionId,
        kind: context.kind,
        resourceId: normalized.resourceId,
        collectedAt: new Date(this.now()).toISOString(),
        access: createAvailableAccess(context),
        document: toResourceValue(response, '资源详情')
      }
    } catch (error: unknown) {
      const statusCode = readStatusCode(error)
      if (statusCode === 403) {
        return {
          connectionId: context.connectionId,
          kind: context.kind,
          resourceId: normalized.resourceId,
          collectedAt: new Date(this.now()).toISOString(),
          access: createForbiddenAccess(context),
          document: null
        }
      }
      throw normalizeServiceError(error, '读取集群资源详情', context.capability, false)
    }
  }

  executeOperation(input: ClusterResourceOperationRequest): Promise<ClusterResourceOperationResult> {
    return this.executeConfirmedOperation(input)
  }

  async executeConfirmedOperation(
    input: ClusterResourceOperationRequest
  ): Promise<ClusterResourceOperationResult> {
    const normalized = normalizeOperationRequest(input)
    const definition = OPERATION_DEFINITIONS[normalized.action]
    if (!definition) {
      throw new ClusterResourceServiceError(
        'UNSUPPORTED',
        '校验集群资源操作',
        `${normalized.action} 未开放`
      )
    }
    if (definition.kind !== normalized.kind) {
      throw new ClusterResourceServiceError(
        'CONTEXT_MISMATCH',
        '校验集群资源操作',
        `资源类型不匹配：action=${normalized.action}，expected=${definition.kind}，actual=${normalized.kind}`
      )
    }
    if (definition.destructive !== normalized.destructive) {
      throw new ClusterResourceServiceError(
        'CONTEXT_MISMATCH',
        '校验集群资源操作',
        `破坏性标记不匹配：action=${normalized.action}`
      )
    }

    const context = this.createContext(normalized.connectionId, normalized.kind)
    if (context.connection.name !== normalized.connectionName) {
      throw new ClusterResourceServiceError(
        'CONTEXT_MISMATCH',
        '校验集群资源操作',
        '确认时的连接名称与当前连接不一致',
        null,
        context.capability
      )
    }
    if (context.connection.readOnly) {
      throw new ClusterResourceServiceError(
        'FORBIDDEN',
        '校验集群资源写入能力',
        '当前连接已开启只读模式',
        null,
        context.capability
      )
    }
    if (!isWriteSupported(context)) {
      throw new ClusterResourceServiceError(
        'UNSUPPORTED',
        '校验集群资源写入能力',
        context.decision.reason,
        null,
        context.capability
      )
    }

    const options = createOperationRequestOptions(definition, normalized.payload)
    const path = definition.path(normalized.resourceId, context)
    try {
      const response = await this.connectionService.requestJson<unknown>(
        context.connectionId,
        path,
        options
      )
      return createOperationResult(normalized, response)
    } catch (error: unknown) {
      throw normalizeServiceError(
        error,
        '执行已确认集群资源操作',
        context.capability,
        normalized.action.startsWith('create-') || normalized.action.startsWith('update-')
      )
    }
  }

  private createContext(connectionIdInput: string, kind: ClusterResourceKind): ResourceContext {
    const connectionId = this.connectionService.assertConnected(connectionIdInput)
    const connection = this.connectionService.list().find((item) => item.id === connectionId)
    if (!connection) {
      throw new ClusterResourceServiceError(
        'CONTEXT_MISMATCH',
        '读取连接能力',
        `找不到已连接配置：connectionId=${connectionId}`
      )
    }
    const matrix = createCapabilityMatrix({
      engine: connection.engine,
      version: connection.version,
      mode: connection.mode
    })
    const capabilityKey = RESOURCE_CAPABILITIES[kind]
    return {
      connectionId,
      kind,
      connection,
      matrix,
      decision: matrix.capabilities[capabilityKey],
      capability: `cluster.${capabilityKey}`
    }
  }

  private async readListItems(context: ResourceContext): Promise<ClusterResourceItem[]> {
    if (context.kind === 'snapshot') return this.readSnapshots(context)
    const response = await this.connectionService.requestJson<unknown>(
      context.connectionId,
      listPath(context)
    )
    return parseListResponse(context.kind, response)
  }

  private async readSnapshots(context: ResourceContext): Promise<ClusterResourceItem[]> {
    const repositoriesResponse = await this.connectionService.requestJson<unknown>(
      context.connectionId,
      '/_snapshot'
    )
    if (!isRecord(repositoriesResponse)) {
      throw invalidResponse('快照仓库列表不是对象', context.capability)
    }
    const repositories = Object.keys(repositoriesResponse).sort((left, right) => left.localeCompare(right))
    const results = await Promise.all(repositories.map(async (repository) => {
      const response = await this.connectionService.requestJson<unknown>(
        context.connectionId,
        `/_snapshot/${encodeResourceId(repository)}/*?verbose=false`
      )
      return parseSnapshots(response, repository, context.capability)
    }))
    return sortItems(results.flat())
  }
}

function putDefinition(
  kind: ClusterResourceKind,
  path: OperationDefinition['path']
): OperationDefinition {
  return { kind, method: 'PUT', destructive: false, payload: 'required', path }
}

function deleteDefinition(
  kind: ClusterResourceKind,
  path: OperationDefinition['path']
): OperationDefinition {
  return { kind, method: 'DELETE', destructive: true, payload: 'forbidden', path }
}

function normalizeListInput(input: ClusterResourceListInput): ClusterResourceListInput {
  if (!isRecord(input)) throw invalidInput('list 输入必须是对象')
  return {
    connectionId: normalizeIdentifier(input.connectionId, 'connectionId'),
    kind: normalizeResourceKind(input.kind)
  }
}

function normalizeDetailInput(input: ClusterResourceDetailInput): ClusterResourceDetailInput {
  const listInput = normalizeListInput(input)
  return {
    ...listInput,
    resourceId: normalizeResourceId(input.resourceId, listInput.kind)
  }
}

function normalizeOperationRequest(
  input: ClusterResourceOperationRequest
): Omit<ClusterResourceOperationRequest, 'resourceId'> & { resourceId: string } {
  if (!isRecord(input)) throw invalidInput('操作输入必须是对象')
  const kind = normalizeResourceKind(input.kind)
  const action = normalizeOperationAction(input.action)
  const resourceName = normalizeText(input.resourceName, 'resourceName')
  const resourceIdInput = input.resourceId ?? (action.startsWith('create-') ? resourceName : null)
  if (resourceIdInput === null) throw invalidInput('非新建操作必须包含 resourceId')
  return {
    requestId: normalizeIdentifier(input.requestId, 'requestId'),
    connectionId: normalizeIdentifier(input.connectionId, 'connectionId'),
    connectionName: normalizeText(input.connectionName, 'connectionName'),
    kind,
    action,
    resourceId: normalizeResourceId(resourceIdInput, kind),
    resourceName,
    impactScope: normalizeText(input.impactScope, 'impactScope'),
    destructive: normalizeBoolean(input.destructive, 'destructive'),
    payload: normalizeOperationPayload(action, clonePayload(input.payload))
  }
}

function normalizeIdentifier(value: unknown, fieldName: string): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    !IDENTIFIER_PATTERN.test(value)
  ) {
    throw invalidInput(`${fieldName} 必须是 1-${MAX_IDENTIFIER_LENGTH} 位字母、数字、点、冒号、下划线或连字符`)
  }
  return value
}

function normalizeText(value: unknown, fieldName: string): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > MAX_TEXT_LENGTH ||
    CONTROL_CHARACTERS.test(value)
  ) {
    throw invalidInput(`${fieldName} 必须是不含控制字符的非空字符串`)
  }
  return value.trim()
}

function normalizeResourceId(value: unknown, kind: ClusterResourceKind): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > MAX_RESOURCE_ID_LENGTH ||
    CONTROL_CHARACTERS.test(value) ||
    value.includes('?') ||
    value.includes('#')
  ) {
    throw invalidInput(`resourceId 必须是 1-${MAX_RESOURCE_ID_LENGTH} 位且不含控制字符、? 或 #`)
  }
  const normalized = value.trim()
  if (kind === 'snapshot') splitSnapshotResourceId(normalized)
  return normalized
}

function normalizeResourceKind(value: unknown): ClusterResourceKind {
  if (typeof value === 'string' && RESOURCE_KINDS.has(value as ClusterResourceKind)) {
    return value as ClusterResourceKind
  }
  throw invalidInput('资源类型不在已知枚举中')
}

function normalizeOperationAction(value: unknown): ClusterResourceOperationAction {
  if (typeof value === 'string' && value in OPERATION_DEFINITIONS) {
    return value as ClusterResourceOperationAction
  }
  throw invalidInput('操作类型不在已知枚举中')
}

function normalizeBoolean(value: unknown, fieldName: string): boolean {
  if (typeof value !== 'boolean') throw invalidInput(`${fieldName} 必须是布尔值`)
  return value
}

function clonePayload(value: unknown): ClusterResourceValue | null {
  if (value === null) return null
  const normalized = toResourceValue(value, '操作 payload')
  const serialized = JSON.stringify(normalized)
  if (Buffer.byteLength(serialized, 'utf8') > MAX_PAYLOAD_BYTES) {
    throw invalidInput(`payload 不能超过 ${MAX_PAYLOAD_BYTES} 字节`)
  }
  return JSON.parse(serialized) as ClusterResourceValue
}

function normalizeOperationPayload(
  action: ClusterResourceOperationAction,
  payload: ClusterResourceValue | null
): ClusterResourceValue | null {
  if (action !== 'restore-snapshot') return payload
  if (!isRecord(payload)) throw invalidInput('restore-snapshot payload 必须是 JSON 对象')

  for (const [field, value] of Object.entries(payload)) {
    if (!RESTORE_SNAPSHOT_PAYLOAD_FIELDS.has(field)) {
      throw invalidInput(`restore-snapshot payload 不允许字段 ${field}`)
    }
    validateRestoreSnapshotField(field, value)
  }
  return payload
}

function validateRestoreSnapshotField(field: string, value: unknown): void {
  if (
    field === 'ignore_unavailable' ||
    field === 'include_global_state' ||
    field === 'include_aliases' ||
    field === 'partial'
  ) {
    if (typeof value !== 'boolean') {
      throw invalidInput(`restore-snapshot payload.${field} 必须是布尔值`)
    }
    return
  }
  if (field === 'feature_states' || field === 'ignore_index_settings') {
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
      throw invalidInput(`restore-snapshot payload.${field} 必须是非空字符串数组`)
    }
    return
  }
  if (field === 'index_settings') {
    if (!isRecord(value)) {
      throw invalidInput('restore-snapshot payload.index_settings 必须是 JSON 对象')
    }
    return
  }
  if (typeof value !== 'string' || !value.trim() || CONTROL_CHARACTERS.test(value)) {
    throw invalidInput(`restore-snapshot payload.${field} 必须是非空字符串`)
  }
}

function createOperationRequestOptions(
  definition: OperationDefinition,
  payload: ClusterResourceValue | null
): RequestOptions {
  if (definition.payload === 'forbidden' && payload !== null) {
    throw invalidInput('该操作不允许 payload')
  }
  if (definition.payload === 'required' && !isRecord(payload)) {
    throw invalidInput('该操作必须提供 JSON 对象 payload')
  }
  if (definition.payload === 'optional' && payload !== null && !isRecord(payload)) {
    throw invalidInput('该操作 payload 必须是 JSON 对象或 null')
  }
  if (payload === null) return { method: definition.method }
  return {
    method: definition.method,
    body: JSON.stringify(payload),
    contentType: 'application/json'
  }
}

function listPath(context: ResourceContext): string {
  if (context.kind === 'node') return '/_nodes'
  if (context.kind === 'task') return '/_tasks?detailed=true'
  if (context.kind === 'index-template') return indexTemplateBasePath(context)
  if (context.kind === 'component-template') return '/_component_template'
  if (context.kind === 'data-stream') return '/_data_stream'
  if (context.kind === 'ingest-pipeline') return '/_ingest/pipeline'
  if (context.kind === 'stored-script') {
    return '/_cluster/state/metadata?filter_path=metadata.stored_scripts'
  }
  throw invalidInput(`资源 ${context.kind} 不使用单一列表路径`)
}

function detailPath(context: ResourceContext, resourceId: string): string {
  if (context.kind === 'node') return `/_nodes/${encodeResourceId(resourceId)}`
  if (context.kind === 'task') return `/_tasks/${encodeResourceId(resourceId)}`
  if (context.kind === 'index-template') return indexTemplateResourcePath(resourceId, context)
  if (context.kind === 'component-template') return `/_component_template/${encodeResourceId(resourceId)}`
  if (context.kind === 'data-stream') return `/_data_stream/${encodeResourceId(resourceId)}`
  if (context.kind === 'snapshot') return snapshotResourcePath(resourceId)
  if (context.kind === 'ingest-pipeline') return `/_ingest/pipeline/${encodeResourceId(resourceId)}`
  return `/_scripts/${encodeResourceId(resourceId)}`
}

function indexTemplateBasePath(context: ResourceContext): string {
  const version = context.matrix.version
  if (
    context.matrix.engine === 'elasticsearch' &&
    version.major === 7 &&
    version.minor !== null &&
    version.minor < 8
  ) {
    return '/_template'
  }
  return '/_index_template'
}

function indexTemplateResourcePath(resourceId: string, context: ResourceContext): string {
  return `${indexTemplateBasePath(context)}/${encodeResourceId(resourceId)}`
}

function snapshotResourcePath(resourceId: string): string {
  const [repository, snapshot] = splitSnapshotResourceId(resourceId)
  return `/_snapshot/${encodeResourceId(repository)}/${encodeResourceId(snapshot)}`
}

function splitSnapshotResourceId(resourceId: string): [string, string] {
  const segments = resourceId.split('/')
  if (segments.length !== 2 || !segments[0] || !segments[1]) {
    throw invalidInput('快照资源 ID 必须使用 repository/snapshot 格式')
  }
  return [segments[0], segments[1]]
}

function encodeResourceId(resourceId: string): string {
  return encodeURIComponent(resourceId)
}

function parseListResponse(kind: ClusterResourceKind, response: unknown): ClusterResourceItem[] {
  if (kind === 'node') return parseNodes(response)
  if (kind === 'task') return parseTasks(response)
  if (kind === 'index-template') return parseIndexTemplates(response)
  if (kind === 'component-template') return parseComponentTemplates(response)
  if (kind === 'data-stream') return parseDataStreams(response)
  if (kind === 'ingest-pipeline') return parseNamedResources(response, 'Pipeline')
  if (kind === 'stored-script') return parseStoredScripts(response)
  throw invalidResponse(`没有 ${kind} 的列表解析器`, `cluster.${RESOURCE_CAPABILITIES[kind]}`)
}

function parseNodes(response: unknown): ClusterResourceItem[] {
  const nodes = requireRecordProperty(response, 'nodes', 'cluster.nodes')
  return sortItems(Object.entries(nodes).map(([id, value]) => {
    const node = requireRecord(value, '节点', 'cluster.nodes')
    const roles = readStringArray(node.roles)
    return {
      id,
      name: readOptionalString(node.name) ?? id,
      status: null,
      summary: readOptionalString(node.transport_address) ?? readOptionalString(node.ip),
      updatedAt: null,
      facts: compactFacts([
        ['version', readOptionalString(node.version)],
        ['roles', roles.length > 0 ? roles.join(', ') : null],
        ['ip', readOptionalString(node.ip)]
      ])
    }
  }))
}

function parseTasks(response: unknown): ClusterResourceItem[] {
  const nodes = requireRecordProperty(response, 'nodes', 'cluster.tasks')
  const items: ClusterResourceItem[] = []
  for (const [nodeId, value] of Object.entries(nodes)) {
    const node = requireRecord(value, '任务节点', 'cluster.tasks')
    const tasks = node.tasks === undefined
      ? {}
      : requireRecord(node.tasks, '任务列表', 'cluster.tasks')
    for (const [taskId, taskValue] of Object.entries(tasks)) {
      const task = requireRecord(taskValue, '任务', 'cluster.tasks')
      const action = readOptionalString(task.action)
      const taskState = readTaskState(task)
      items.push({
        id: taskId,
        name: readOptionalString(task.description) ?? action ?? taskId,
        status: action,
        summary: readOptionalString(node.name) ?? nodeId,
        updatedAt: toIsoDate(task.start_time_in_millis),
        taskState,
        facts: compactFacts([
          ['node', readOptionalString(node.name) ?? nodeId],
          ['action', action],
          ['cancellable', readOptionalBoolean(task.cancellable)],
          ['runningTimeMs', nanosecondsToMilliseconds(task.running_time_in_nanos)]
        ])
      })
    }
  }
  return sortItems(items)
}

function parseIndexTemplates(response: unknown): ClusterResourceItem[] {
  if (!isRecord(response)) throw invalidResponse('索引模板响应不是对象', 'cluster.indexTemplates')
  if (Array.isArray(response.index_templates)) {
    return sortItems(response.index_templates.map((value) => {
      const wrapper = requireRecord(value, '索引模板', 'cluster.indexTemplates')
      const name = requireString(wrapper.name, '索引模板名称', 'cluster.indexTemplates')
      const template = requireRecord(wrapper.index_template, '索引模板内容', 'cluster.indexTemplates')
      return namedResourceItem(name, template, readOptionalString(template.version))
    }))
  }
  return parseNamedResources(response, '索引模板')
}

function parseComponentTemplates(response: unknown): ClusterResourceItem[] {
  if (!isRecord(response) || !Array.isArray(response.component_templates)) {
    throw invalidResponse('组件模板响应缺少 component_templates', 'cluster.componentTemplates')
  }
  return sortItems(response.component_templates.map((value) => {
    const wrapper = requireRecord(value, '组件模板', 'cluster.componentTemplates')
    const name = requireString(wrapper.name, '组件模板名称', 'cluster.componentTemplates')
    const template = requireRecord(wrapper.component_template, '组件模板内容', 'cluster.componentTemplates')
    return namedResourceItem(name, template, readOptionalString(template.version))
  }))
}

function parseDataStreams(response: unknown): ClusterResourceItem[] {
  if (!isRecord(response) || !Array.isArray(response.data_streams)) {
    throw invalidResponse('数据流响应缺少 data_streams', 'cluster.dataStreams')
  }
  return sortItems(response.data_streams.map((value) => {
    const stream = requireRecord(value, '数据流', 'cluster.dataStreams')
    const name = requireString(stream.name, '数据流名称', 'cluster.dataStreams')
    return {
      id: name,
      name,
      status: readOptionalString(stream.status),
      summary: readOptionalString(stream.template),
      updatedAt: null,
      facts: compactFacts([
        ['generation', readOptionalNumber(stream.generation)],
        ['hidden', readOptionalBoolean(stream.hidden)],
        ['system', readOptionalBoolean(stream.system)]
      ])
    }
  }))
}

function parseStoredScripts(response: unknown): ClusterResourceItem[] {
  const responseRecord = requireRecord(response, '存储脚本响应', 'cluster.scripts')
  if (responseRecord.metadata === undefined) return []
  const metadata = requireRecord(responseRecord.metadata, 'metadata', 'cluster.scripts')
  if (metadata.stored_scripts === undefined) return []
  return parseNamedResources(
    requireRecord(metadata.stored_scripts, '存储脚本列表', 'cluster.scripts'),
    '存储脚本'
  )
}

function parseNamedResources(response: unknown, label: string): ClusterResourceItem[] {
  const record = requireRecord(response, `${label}列表`, `cluster.${label}`)
  return sortItems(Object.entries(record).map(([id, value]) => {
    const document = requireRecord(value, label, `cluster.${label}`)
    return namedResourceItem(id, document, readOptionalString(document.version))
  }))
}

function parseSnapshots(
  response: unknown,
  repository: string,
  capability: string
): ClusterResourceItem[] {
  if (!isRecord(response) || !Array.isArray(response.snapshots)) {
    throw invalidResponse('快照响应缺少 snapshots', capability)
  }
  return response.snapshots.map((value) => {
    const snapshot = requireRecord(value, '快照', capability)
    const name = requireString(snapshot.snapshot, '快照名称', capability)
    return {
      id: `${repository}/${name}`,
      name,
      status: readOptionalString(snapshot.state),
      summary: repository,
      updatedAt: toIsoDate(snapshot.end_time_in_millis) ?? toIsoDate(snapshot.start_time_in_millis),
      facts: compactFacts([
        ['repository', repository],
        ['uuid', readOptionalString(snapshot.uuid)],
        ['durationMs', readOptionalNumber(snapshot.duration_in_millis)]
      ])
    }
  })
}

function namedResourceItem(
  id: string,
  document: Record<string, unknown>,
  status: string | null
): ClusterResourceItem {
  const patterns = readStringArray(document.index_patterns)
  return {
    id,
    name: id,
    status,
    summary: readOptionalString(document.description) ?? (patterns.length > 0 ? patterns.join(', ') : null),
    updatedAt: null,
    facts: compactFacts([
      ['version', primitiveFact(document.version)],
      ['priority', primitiveFact(document.priority)]
    ])
  }
}

function readTaskState(task: Record<string, unknown>): ClusterTaskState {
  if (task.cancelled === true || task.canceled === true) return 'canceled'
  if (task.cancellation_requested === true) return 'canceling'
  if (task.completed === true) return 'completed'
  if (task.error !== undefined) return 'failed'
  return 'running'
}

function createListResult(
  context: ResourceContext,
  nowMs: number,
  access: ClusterResourceAccess,
  items: ClusterResourceItem[]
): ClusterResourceListResult {
  return {
    connectionId: context.connectionId,
    kind: context.kind,
    collectedAt: new Date(nowMs).toISOString(),
    access,
    items,
    operations: createOperationCapabilities(context, access)
  }
}

function createOperationCapabilities(
  context: ResourceContext,
  access: ClusterResourceAccess
): ClusterResourceOperationCapability[] {
  const actions = OPERATIONS_BY_KIND[context.kind]
  const writeSupported = isWriteSupported(context)
  return actions.map((action) => {
    const definition = OPERATION_DEFINITIONS[action]
    if (!definition) throw invalidInput(`操作 ${action} 没有路径定义`)
    const state = access.state !== 'available'
      ? access.state
      : context.connection.readOnly
        ? 'forbidden'
        : writeSupported
          ? 'available'
          : 'unsupported'
    const reason = state === 'available'
      ? null
      : state === 'forbidden'
        ? (context.connection.readOnly ? '当前连接为只读' : access.reason)
        : context.decision.reason
    return {
      action,
      state,
      reason,
      impactScope: OPERATION_IMPACTS[action],
      destructive: definition.destructive
    }
  })
}

function isWriteSupported(context: ResourceContext): boolean {
  if (context.kind === 'task') {
    return context.matrix.verifiedVersion && context.matrix.mode === 'direct' && context.decision.supported
  }
  return context.decision.writeSupported
}

function createAvailableAccess(context: ResourceContext): ClusterResourceAccess {
  return { state: 'available', capability: context.capability, reason: null }
}

function createForbiddenAccess(context: ResourceContext): ClusterResourceAccess {
  return {
    state: 'forbidden',
    capability: context.capability,
    reason: `当前连接缺少 ${context.decision.key} 读取权限`
  }
}

function createUnsupportedAccess(context: ResourceContext): ClusterResourceAccess {
  return {
    state: 'unsupported',
    capability: context.capability,
    reason: context.decision.reason
  }
}

function readAccessFailure(error: unknown, context: ResourceContext): ClusterResourceAccess | null {
  const statusCode = readStatusCode(error)
  if (statusCode === 403) return createForbiddenAccess(context)
  if (statusCode === 404) {
    return {
      state: 'unsupported',
      capability: context.capability,
      reason: `当前产品或版本未提供 ${context.decision.key} 列表路径`
    }
  }
  return null
}

function createOperationResult(
  request: Omit<ClusterResourceOperationRequest, 'resourceId'> & { resourceId: string },
  response: unknown
): ClusterResourceOperationResult {
  if (!isRecord(response)) {
    throw invalidResponse('写操作响应不是 JSON 对象', `cluster.${RESOURCE_CAPABILITIES[request.kind]}`)
  }
  const taskId = readOptionalString(response.task) ?? readOptionalString(response.task_id)
  const failed = response.acknowledged === false || response.error !== undefined
  const accepted = !failed && (response.accepted === true || taskId !== null)
  const state = failed ? 'failed' : accepted ? 'accepted' : 'completed'
  const stateText = state === 'failed' ? '失败' : state === 'accepted' ? '已接受' : '已完成'
  return {
    requestId: request.requestId,
    connectionId: request.connectionId,
    kind: request.kind,
    action: request.action,
    state,
    taskId,
    traceId: request.requestId,
    message: `集群资源操作${stateText}：requestId=${request.requestId}，action=${request.action}，resource=${request.resourceId}`
  }
}

function toResourceValue(
  value: unknown,
  fieldName: string,
  ancestors = new WeakSet<object>(),
  depth = 0
): ClusterResourceValue {
  if (depth > MAX_JSON_DEPTH) throw invalidInput(`${fieldName} 超过最大 JSON 嵌套深度`)
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalidInput(`${fieldName} 包含非有限数值`)
    return value
  }
  if (typeof value === 'object' && value !== null && ancestors.has(value)) {
    throw invalidInput(`${fieldName} 包含循环引用`)
  }
  if (Array.isArray(value)) {
    ancestors.add(value)
    const result = value.map((item) => toResourceValue(item, fieldName, ancestors, depth + 1))
    ancestors.delete(value)
    return result
  }
  if (!isRecord(value)) throw invalidInput(`${fieldName} 包含非 JSON 值`)
  ancestors.add(value)
  const result = Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      toResourceValue(item, `${fieldName}.${key}`, ancestors, depth + 1)
    ])
  )
  ancestors.delete(value)
  return result
}

function requireRecordProperty(
  value: unknown,
  property: string,
  capability: string
): Record<string, unknown> {
  const record = requireRecord(value, '响应', capability)
  return requireRecord(record[property], property, capability)
}

function requireRecord(value: unknown, fieldName: string, capability: string): Record<string, unknown> {
  if (!isRecord(value)) throw invalidResponse(`${fieldName}不是对象`, capability)
  return value
}

function requireString(value: unknown, fieldName: string, capability: string): string {
  if (typeof value !== 'string' || !value) {
    throw invalidResponse(`${fieldName}不是非空字符串`, capability)
  }
  return value
}

function readOptionalString(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

function readOptionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readOptionalBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function primitiveFact(value: unknown): string | number | boolean | null {
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return null
}

function compactFacts(
  values: Array<[string, string | number | boolean | null]>
): ClusterResourceFact[] {
  return values
    .filter((entry): entry is [string, string | number | boolean] => entry[1] !== null)
    .map(([key, value]) => ({ key, value }))
}

function toIsoDate(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null
  return new Date(value).toISOString()
}

function nanosecondsToMilliseconds(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null
  return Math.round(value / 1_000_000)
}

function sortItems(items: ClusterResourceItem[]): ClusterResourceItem[] {
  return [...items].sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
}

function normalizeServiceError(
  error: unknown,
  operation: string,
  capability: string,
  notFoundAsUnsupported: boolean
): ClusterResourceServiceError {
  if (error instanceof ClusterResourceServiceError) return error
  const statusCode = readStatusCode(error)
  const rawCode = readErrorCode(error)
  const message = error instanceof Error && error.message ? error.message : '未知错误'
  let code: ClusterResourceErrorCode = 'UNKNOWN'
  if (rawCode === 'CONNECTION_READ_ONLY') code = 'FORBIDDEN'
  else if (statusCode === 401) code = 'UNAUTHORIZED'
  else if (statusCode === 403) code = 'FORBIDDEN'
  else if (statusCode === 404) code = notFoundAsUnsupported ? 'UNSUPPORTED' : 'NOT_FOUND'
  else if (/timeout|timed out|超时|请求超过/iu.test(message) || rawCode.includes('TIMEOUT')) code = 'TIMEOUT'
  else if (rawCode.includes('NETWORK') || rawCode.startsWith('CONNECTION_')) code = 'NETWORK'
  return new ClusterResourceServiceError(code, operation, message, statusCode, capability, { cause: error })
}

function readStatusCode(error: unknown): number | null {
  if (!isRecord(error)) return null
  return typeof error.statusCode === 'number' && Number.isInteger(error.statusCode)
    ? error.statusCode
    : null
}

function readErrorCode(error: unknown): string {
  return isRecord(error) && typeof error.code === 'string' ? error.code : ''
}

function invalidInput(reason: string): ClusterResourceServiceError {
  return new ClusterResourceServiceError('CONTEXT_MISMATCH', '校验输入', reason)
}

function invalidResponse(reason: string, capability: string): ClusterResourceServiceError {
  return new ClusterResourceServiceError('INVALID_RESPONSE', '解析集群资源响应', reason, null, capability)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
