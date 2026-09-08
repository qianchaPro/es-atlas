import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { request as httpRequest, type RequestOptions } from 'node:http'
import { request as httpsRequest, type RequestOptions as HttpsRequestOptions } from 'node:https'
import { dirname } from 'node:path'
import { connect as connectTls } from 'node:tls'
import { safeStorage } from 'electron'
import type {
  AuthorizationType,
  AwsCredentialSource,
  AwsService,
  ConnectionGroup,
  ConnectionGroupColor,
  ConnectionFormValue,
  ConnectionHeader,
  ConnectionMode,
  ConnectionProfile,
  ConnectionStatus,
  ConnectionSummary,
  ConnectionTestInput,
  ConnectionTestResult,
  CreateConnectionGroupInput,
  CreateConnectionInput,
  MoveConnectionsInput,
  SshAuthorizationType,
  UpdateConnectionGroupInput,
  UpdateConnectionInput
} from '../../../src/shared/types/connection'
import { RequestHistoryService } from '../request-history/request-history-service'
import type { RecordRequestInput } from '../request-history/request-history-service'
import { signAwsRequest } from './aws-signer'
import { SshTunnel, SshTunnelError } from './ssh-tunnel'

type StoredHeader = Omit<ConnectionHeader, 'value'> & { encryptedValue: string }

type StoredSshSettings = {
  enabled: boolean
  host: string
  port: number
  username: string
  authorizationType: SshAuthorizationType
  encryptedPassword: string
  privateKeyPath: string
  encryptedPassphrase: string
  agentSocket: string
  hostFingerprint: string
}

type StoredAwsSettings = {
  enabled: boolean
  region: string
  service: AwsService
  credentialSource: AwsCredentialSource
  profile: string
  accessKeyId: string
  encryptedSecretAccessKey: string
  encryptedSessionToken: string
}

type StoredConnection = {
  id: string
  groupId: string | null
  name: string
  endpoints: string[]
  readOnly: boolean
  mode: ConnectionMode
  trustInsecureCertificate: boolean
  authorization: {
    type: AuthorizationType
    username: string
    encryptedSecret: string
  }
  headers: StoredHeader[]
  ssh: StoredSshSettings
  aws: StoredAwsSettings
  filters: {
    indices: string
    aliases: string
    templates: string
  }
}

type RuntimeConnectionState = {
  status: ConnectionStatus
  engine: string | null
  version: string | null
  lastError: string | null
  activeEndpointIndex: number
}

type RootResponse = {
  cluster_name?: unknown
  version?: {
    number?: unknown
    distribution?: unknown
  }
  tagline?: unknown
}

type PersistedConnections = {
  version: 5
  groups: ConnectionGroup[]
  connections: StoredConnection[]
}

type LegacyPersistedConnections = {
  version: 1
  connections: Array<{ id: unknown; name: unknown; endpoint: unknown }>
}

type ParsedConnections = {
  groups: ConnectionGroup[]
  connections: StoredConnection[]
  migrated: boolean
}

const DEFAULT_REQUEST_TIMEOUT_MS = 5_000
const MAX_RESPONSE_SIZE_BYTES = 5 * 1024 * 1024
const FORBIDDEN_HEADER_NAMES = new Set(['authorization', 'connection', 'content-length', 'host'])
const GROUP_COLOR_PATTERN = /^#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$/
const LEGACY_CONNECTION_GROUP_COLORS = {
  gray: '#7d8791',
  red: '#c94f4f',
  orange: '#db7437',
  amber: '#bf8a20',
  green: '#2e8b68',
  blue: '#3d7fae',
  purple: '#8062a8'
} as const satisfies Record<string, Exclude<ConnectionGroupColor, null>>

export class ConnectionServiceError extends Error {
  constructor(
    readonly code: string,
    readonly connectionId: string | null,
    operation: string,
    reason: string,
    options?: ErrorOptions,
    readonly statusCode: number | null = null
  ) {
    super(
      `连接模块失败：connectionId=${connectionId ?? '未提供'}，操作=${operation}，原因=${reason}`,
      options
    )
    this.name = 'ConnectionServiceError'
  }
}

export type JsonRequestOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  body?: string
  contentType?: 'application/json' | 'application/x-ndjson'
}

export type ConnectionRequestObservation = Omit<RecordRequestInput, 'connectionId'> & {
  connectionId: string | null
}

export type ConnectionRequestObserver = (input: Readonly<ConnectionRequestObservation>) => void

type JsonResponse<T> = {
  body: T
  statusCode: number
}

export class ConnectionService {
  private groups: ConnectionGroup[] = []
  private connections: StoredConnection[] = []
  private readonly runtimeStates = new Map<string, RuntimeConnectionState>()
  private readonly tunnels = new Map<string, SshTunnel>()
  private mutationQueue: Promise<void> = Promise.resolve()

  constructor(
    private readonly storagePath: string,
    private readonly requestHistoryService: RequestHistoryService,
    private readonly requestObserver: ConnectionRequestObserver = () => undefined
  ) {}

  async initialize(): Promise<void> {
    this.dispose()
    try {
      const content = await readFile(this.storagePath, 'utf8')
      const parsed = parsePersistedConnections(content)
      this.groups = parsed.groups
      this.connections = parsed.connections
      if (parsed.migrated) await this.persist(this.connections, this.groups)
    } catch (error: unknown) {
      if (isFileNotFoundError(error)) {
        await this.persist([], [])
        this.groups = []
        this.connections = []
      } else if (error instanceof ConnectionServiceError) {
        throw error
      } else {
        throw new ConnectionServiceError(
          'CONNECTION_STORAGE_READ_FAILED',
          null,
          '读取连接配置',
          getErrorMessage(error),
          { cause: error }
        )
      }
    }

    this.runtimeStates.clear()
    for (const connection of this.connections) {
      this.runtimeStates.set(connection.id, createDisconnectedState())
    }
  }

  list(): ConnectionSummary[] {
    return this.connections.map((connection) => this.toSummary(connection))
  }

  listGroups(): ConnectionGroup[] {
    return this.groups.map(copyConnectionGroup)
  }

  async createGroup(input: CreateConnectionGroupInput): Promise<ConnectionGroup> {
    return this.runPersistedMutation(async () => {
      const group: ConnectionGroup = {
        id: randomUUID(),
        name: normalizeGroupName(input?.name, null),
        color: normalizeGroupColor(input?.color, null)
      }
      assertUniqueGroupName(this.groups, group.name, null)
      const nextGroups = [...this.groups, group]
      await this.persist(this.connections, nextGroups)
      this.groups = nextGroups
      return copyConnectionGroup(group)
    })
  }

  async updateGroup(input: UpdateConnectionGroupInput): Promise<ConnectionGroup> {
    return this.runPersistedMutation(async () => {
      const groupId = normalizeGroupId(input?.id)
      const groupIndex = this.groups.findIndex((group) => group.id === groupId)
      if (groupIndex === -1) throw createGroupNotFoundError(groupId, '更新连接分组')

      const updatedGroup: ConnectionGroup = {
        id: groupId,
        name: normalizeGroupName(input?.name, groupId),
        color: normalizeGroupColor(input?.color, groupId)
      }
      assertUniqueGroupName(this.groups, updatedGroup.name, groupId)
      const nextGroups = this.groups.map((group, index) =>
        index === groupIndex ? updatedGroup : group
      )
      await this.persist(this.connections, nextGroups)
      this.groups = nextGroups
      return copyConnectionGroup(updatedGroup)
    })
  }

  async deleteGroup(groupIdInput: string): Promise<void> {
    return this.runPersistedMutation(async () => {
      const groupId = normalizeGroupId(groupIdInput)
      if (!this.groups.some((group) => group.id === groupId)) {
        throw createGroupNotFoundError(groupId, '删除连接分组')
      }

      const nextGroups = this.groups.filter((group) => group.id !== groupId)
      const nextConnections = this.connections.map((connection) =>
        connection.groupId === groupId ? { ...connection, groupId: null } : connection
      )
      await this.persist(nextConnections, nextGroups)
      this.groups = nextGroups
      this.connections = nextConnections
    })
  }

  async moveConnections(input: MoveConnectionsInput): Promise<ConnectionSummary[]> {
    return this.runPersistedMutation(async () => {
      const connectionIds = normalizeConnectionIds(input?.connectionIds)
      const groupId = normalizeOptionalGroupId(input?.groupId)
      assertGroupExists(this.groups, groupId, '移动连接')

      const connectionIdSet = new Set(connectionIds)
      const missingConnectionId = connectionIds.find(
        (connectionId) => !this.connections.some((connection) => connection.id === connectionId)
      )
      if (missingConnectionId) throw createNotFoundError(missingConnectionId, '移动连接')

      const nextConnections = this.connections.map((connection) =>
        connectionIdSet.has(connection.id) ? { ...connection, groupId } : connection
      )
      await this.persist(nextConnections, this.groups)
      this.connections = nextConnections
      return connectionIds.map((connectionId) =>
        this.toSummary(this.getStoredConnection(connectionId, '读取移动结果'))
      )
    })
  }

  get(connectionIdInput: string): ConnectionProfile {
    const connectionId = normalizeConnectionId(connectionIdInput)
    return toProfile(this.getStoredConnection(connectionId, '读取连接配置'))
  }

  async create(input: CreateConnectionInput): Promise<ConnectionSummary> {
    return this.runPersistedMutation(async () => {
      const groupId = normalizeOptionalGroupId(input?.groupId)
      assertGroupExists(this.groups, groupId, '新增连接')
      const connection = toStoredConnection(randomUUID(), input, null, groupId)
      const nextConnections = [...this.connections, connection]
      await this.persist(nextConnections)
      this.connections = nextConnections
      this.runtimeStates.set(connection.id, createDisconnectedState())
      return this.toSummary(connection)
    })
  }

  async update(input: UpdateConnectionInput): Promise<ConnectionSummary> {
    return this.runPersistedMutation(async () => {
      const connectionId = normalizeConnectionId(input?.id)
      const existingIndex = this.connections.findIndex((connection) => connection.id === connectionId)
      if (existingIndex === -1) throw createNotFoundError(connectionId, '更新连接')

      const existing = this.connections[existingIndex]
      const groupId = input.groupId === undefined
        ? existing.groupId
        : normalizeOptionalGroupId(input.groupId)
      assertGroupExists(this.groups, groupId, '更新连接')
      const updated = toStoredConnection(connectionId, input, existing, groupId)
      const nextConnections = this.connections.map((connection, index) =>
        index === existingIndex ? updated : connection
      )
      await this.persist(nextConnections)
      this.connections = nextConnections

      if (hasRequestConfigurationChanged(existing, updated)) {
        this.closeTunnel(connectionId)
        this.runtimeStates.set(connectionId, createDisconnectedState())
      }
      return this.toSummary(updated)
    })
  }

  async delete(connectionIdInput: string): Promise<void> {
    return this.runPersistedMutation(async () => {
      const connectionId = normalizeConnectionId(connectionIdInput)
      if (!this.connections.some((connection) => connection.id === connectionId)) {
        throw createNotFoundError(connectionId, '删除连接')
      }

      const nextConnections = this.connections.filter((connection) => connection.id !== connectionId)
      await this.persist(nextConnections)
      this.connections = nextConnections
      this.closeTunnel(connectionId)
      this.runtimeStates.delete(connectionId)
    })
  }

  async test(input: ConnectionTestInput): Promise<ConnectionTestResult> {
    const connectionId = normalizeOptionalConnectionId(input?.connectionId)
    const existing = connectionId ? this.getStoredConnection(connectionId, '测试连接') : null
    const connection = toStoredConnection(
      connectionId ?? 'test',
      input?.profile,
      existing,
      existing?.groupId ?? null
    )
    const startedAt = Date.now()
    let temporaryTunnel: SshTunnel | null = null
    try {
      temporaryTunnel = await this.createTunnel(connectionId, connection)
      return await this.probeConnection(connectionId, connection, temporaryTunnel)
    } catch (error: unknown) {
      return createFailedTestResult(connectionId, Date.now() - startedAt, getErrorMessage(error))
    } finally {
      temporaryTunnel?.close()
    }
  }

  async connect(connectionIdInput: string): Promise<ConnectionSummary> {
    const connectionId = normalizeConnectionId(connectionIdInput)
    const connection = this.getStoredConnection(connectionId, '建立连接')
    this.closeTunnel(connectionId)
    let tunnel: SshTunnel | null = null
    let result: ConnectionTestResult
    try {
      tunnel = await this.createTunnel(connectionId, connection)
      result = await this.probeConnection(connectionId, connection, tunnel)
    } catch (error: unknown) {
      result = createFailedTestResult(connectionId, 0, getErrorMessage(error))
    }
    if (!result.success) {
      tunnel?.close()
      this.runtimeStates.set(connectionId, {
        ...createDisconnectedState(),
        status: 'unavailable',
        lastError: result.error
      })
      throw new ConnectionServiceError(
        'CONNECTION_UNAVAILABLE',
        connectionId,
        '建立连接',
        result.error ?? '连接测试失败'
      )
    }

    if (tunnel) this.tunnels.set(connectionId, tunnel)

    const activeEndpointIndex = result.endpoint
      ? connection.endpoints.indexOf(result.endpoint)
      : 0
    this.runtimeStates.set(connectionId, {
      status: 'connected',
      engine: result.engine,
      version: result.version,
      lastError: null,
      activeEndpointIndex: Math.max(activeEndpointIndex, 0)
    })
    return this.toSummary(connection)
  }

  disconnect(connectionIdInput: string): ConnectionSummary {
    const connectionId = normalizeConnectionId(connectionIdInput)
    const connection = this.getStoredConnection(connectionId, '断开连接')
    this.closeTunnel(connectionId)
    const previousState = this.runtimeStates.get(connectionId) ?? createDisconnectedState()
    this.runtimeStates.set(connectionId, {
      ...previousState,
      status: 'disconnected',
      lastError: null
    })
    return this.toSummary(connection)
  }

  dispose(): void {
    for (const tunnel of this.tunnels.values()) tunnel.close()
    this.tunnels.clear()
  }

  assertConnected(connectionIdInput: string): string {
    const connectionId = normalizeConnectionId(connectionIdInput)
    this.getStoredConnection(connectionId, '读取集群')
    if (this.runtimeStates.get(connectionId)?.status !== 'connected') {
      throw new ConnectionServiceError(
        'CONNECTION_NOT_CONNECTED',
        connectionId,
        '读取集群',
        '连接尚未建立'
      )
    }
    return connectionId
  }

  async requestJson<T>(
    connectionIdInput: string,
    requestPath: string,
    options: JsonRequestOptions = {}
  ): Promise<T> {
    const connectionId = normalizeConnectionId(connectionIdInput)
    const method = options.method ?? 'GET'
    const connection = this.getStoredConnection(connectionId, method)
    if (method !== 'GET' && connection.readOnly) {
      throw new ConnectionServiceError(
        'CONNECTION_READ_ONLY',
        connectionId,
        `${method} ${requestPath}`,
        '当前连接已开启只读模式，禁止写入操作'
      )
    }
    const runtimeState = this.runtimeStates.get(connectionId) ?? createDisconnectedState()
    const availableEndpointOrder = createEndpointOrder(
      connection.endpoints,
      runtimeState.activeEndpointIndex
    )
    // 写请求可能已在服务端落库却在返回前断链，不能跨 endpoint 自动重试。
    const endpointOrder = method === 'GET' ? availableEndpointOrder : availableEndpointOrder.slice(0, 1)
    const tunnel = connection.ssh.enabled ? this.tunnels.get(connectionId) : undefined
    if (connection.ssh.enabled && !tunnel) {
      throw new ConnectionServiceError(
        'SSH_TUNNEL_NOT_CONNECTED',
        connectionId,
        `${method} ${requestPath}`,
        'SSH 隧道尚未建立'
      )
    }
    const startedAtMs = Date.now()
    const failures: string[] = []
    let lastFailure: ConnectionServiceError | null = null

    for (const endpointIndex of endpointOrder) {
      try {
        const response = await this.requestEndpointJson<T>(
          connectionId,
          connection,
          endpointIndex,
          requestPath,
          tunnel,
          { ...options, method }
        )
        runtimeState.activeEndpointIndex = endpointIndex
        this.runtimeStates.set(connectionId, runtimeState)
        this.recordRequest({
          connectionId,
          connectionName: connection.name,
          startedAtMs,
          method,
          path: requestPath,
          successful: true,
          statusCode: response.statusCode,
          errorCode: null,
          durationMs: Date.now() - startedAtMs
        })
        return response.body
      } catch (error: unknown) {
        lastFailure = error instanceof ConnectionServiceError ? error : null
        failures.push(`${connection.endpoints[endpointIndex]}：${getErrorMessage(error)}`)
      }
    }

    const requestError = new ConnectionServiceError(
      'CONNECTION_ALL_ENDPOINTS_FAILED',
      connectionId,
      `${method} ${requestPath}`,
      failures.join('；'),
      undefined,
      lastFailure?.statusCode ?? null
    )
    this.recordRequest({
      connectionId,
      connectionName: connection.name,
      startedAtMs,
      method,
      path: requestPath,
      successful: false,
      statusCode: requestError.statusCode,
      errorCode: lastFailure?.code ?? requestError.code,
      durationMs: Date.now() - startedAtMs
    })
    throw requestError
  }

  private recordRequest(input: ConnectionRequestObservation): void {
    if (input.connectionId !== null) {
      void this.requestHistoryService.record({ ...input, connectionId: input.connectionId })
        .catch((error: unknown) => {
          console.error(getErrorMessage(error))
        })
    }
    try {
      this.requestObserver({ ...input })
    } catch (error: unknown) {
      console.error(getErrorMessage(error))
    }
  }

  private async probeConnection(
    connectionId: string | null,
    connection: StoredConnection,
    tunnel: SshTunnel | null
  ): Promise<ConnectionTestResult> {
    const startedAt = Date.now()
    const failures: string[] = []
    let lastFailure: ConnectionServiceError | null = null

    for (let endpointIndex = 0; endpointIndex < connection.endpoints.length; endpointIndex += 1) {
      try {
        const rootResponse = await this.requestEndpointJson<RootResponse>(
          connectionId,
          connection,
          endpointIndex,
          '/',
          tunnel ?? undefined
        )
        const detected = detectEngine(rootResponse.body)
        const clusterName = readString(rootResponse.body.cluster_name)
        if (!detected.engine || !detected.version || !clusterName) {
          throw new ConnectionServiceError(
            'CONNECTION_UNSUPPORTED_PRODUCT',
            connectionId,
            '测试连接',
            '根接口响应无法识别为 Elasticsearch 或 OpenSearch'
          )
        }
        this.recordRequest({
          connectionId,
          connectionName: connection.name,
          startedAtMs: startedAt,
          method: 'GET',
          path: '/',
          successful: true,
          statusCode: rootResponse.statusCode,
          errorCode: null,
          durationMs: Date.now() - startedAt,
          source: 'connection'
        })
        return {
          connectionId,
          success: true,
          engine: detected.engine,
          version: detected.version,
          clusterName,
          endpoint: connection.endpoints[endpointIndex],
          latencyMs: Date.now() - startedAt,
          error: null
        }
      } catch (error: unknown) {
        lastFailure = error instanceof ConnectionServiceError ? error : null
        failures.push(`${connection.endpoints[endpointIndex]}：${getErrorMessage(error)}`)
      }
    }

    this.recordRequest({
      connectionId,
      connectionName: connection.name,
      startedAtMs: startedAt,
      method: 'GET',
      path: '/',
      successful: false,
      statusCode: lastFailure?.statusCode ?? null,
      errorCode: lastFailure?.code ?? 'CONNECTION_TEST_FAILED',
      durationMs: Date.now() - startedAt,
      source: 'connection'
    })

    return {
      connectionId,
      success: false,
      engine: null,
      version: null,
      clusterName: null,
      endpoint: null,
      latencyMs: Date.now() - startedAt,
      error: failures.join('；')
    }
  }

  private async requestEndpointJson<T>(
    connectionId: string | null,
    connection: StoredConnection,
    endpointIndex: number,
    requestPath: string,
    tunnel?: SshTunnel,
    options: JsonRequestOptions = {}
  ): Promise<JsonResponse<T>> {
    const targetMethod = options.method ?? 'GET'
    if (!requestPath.startsWith('/')) {
      throw new ConnectionServiceError(
        'CONNECTION_INVALID_REQUEST_PATH',
        connectionId,
        targetMethod,
        `请求路径必须以 / 开头：path=${requestPath}`
      )
    }

    const endpoint = connection.endpoints[endpointIndex]
    const requestUrl = createRequestUrl(endpoint, connection.mode, requestPath, targetMethod)
    const method = connection.mode === 'kibana' ? 'POST' : targetMethod
    let headers = createRequestHeaders(connection)
    if (connection.mode === 'kibana') headers['kbn-xsrf'] = 'es-atlas'
    if (options.body !== undefined) {
      headers['content-type'] = options.contentType ?? 'application/json'
    }
    if (connection.aws.enabled) {
      try {
        headers = await signAwsRequest({
          method,
          requestUrl,
          headers,
          body: options.body,
          settings: toAwsSigningSettings(connection.aws, connection.id)
        })
      } catch (error: unknown) {
        throw new ConnectionServiceError(
          'CONNECTION_AWS_SIGNING_FAILED',
          connectionId,
          `${method} ${requestPath}`,
          getErrorMessage(error),
          { cause: error }
        )
      }
    }

    const response = await requestText({
      connectionId,
      method,
      requestPath,
      requestUrl,
      headers,
      body: options.body,
      trustInsecureCertificate: connection.trustInsecureCertificate,
      tunnel
    })

    try {
      return {
        body: JSON.parse(response.body) as T,
        statusCode: response.statusCode
      }
    } catch (error: unknown) {
      throw new ConnectionServiceError(
        'CONNECTION_INVALID_JSON',
        connectionId,
        `${method} ${requestPath}`,
        '服务端未返回有效 JSON',
        { cause: error },
        response.statusCode
      )
    }
  }

  private getStoredConnection(connectionId: string, operation: string): StoredConnection {
    const connection = this.connections.find((item) => item.id === connectionId)
    if (!connection) throw createNotFoundError(connectionId, operation)
    return copyStoredConnection(connection)
  }

  private toSummary(connection: StoredConnection): ConnectionSummary {
    const state = this.runtimeStates.get(connection.id) ?? createDisconnectedState()
    return {
      id: connection.id,
      groupId: connection.groupId,
      name: connection.name,
      endpoint: connection.endpoints[state.activeEndpointIndex] ?? connection.endpoints[0],
      endpointCount: connection.endpoints.length,
      readOnly: connection.readOnly,
      mode: connection.mode,
      authorizationType: connection.authorization.type,
      sshEnabled: connection.ssh.enabled,
      awsEnabled: connection.aws.enabled,
      status: state.status,
      engine: state.engine,
      version: state.version,
      lastError: state.lastError
    }
  }

  private async persist(
    connections: StoredConnection[],
    groups: ConnectionGroup[] = this.groups
  ): Promise<void> {
    const payload: PersistedConnections = {
      version: 5,
      groups: groups.map(copyConnectionGroup),
      connections: connections.map(copyStoredConnection)
    }
    const temporaryPath = `${this.storagePath}.tmp`

    try {
      await mkdir(dirname(this.storagePath), { recursive: true })
      await writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600
      })
      await rename(temporaryPath, this.storagePath)
    } catch (error: unknown) {
      throw new ConnectionServiceError(
        'CONNECTION_STORAGE_WRITE_FAILED',
        null,
        '保存连接配置',
        getErrorMessage(error),
        { cause: error }
      )
    }
  }

  private runPersistedMutation<T>(mutation: () => Promise<T>): Promise<T> {
    // 写事务必须覆盖状态读取、校验、持久化和内存提交，避免并发操作基于旧快照互相覆盖。
    const result = this.mutationQueue.then(mutation)
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private async createTunnel(
    connectionId: string | null,
    connection: StoredConnection
  ): Promise<SshTunnel | null> {
    if (!connection.ssh.enabled) return null
    try {
      return await SshTunnel.connect(toSshTunnelSettings(connection.ssh, connection.id))
    } catch (error: unknown) {
      const code = error instanceof SshTunnelError ? error.code : 'SSH_CONNECTION_FAILED'
      throw new ConnectionServiceError(
        code,
        connectionId,
        '建立 SSH 隧道',
        getErrorMessage(error),
        { cause: error }
      )
    }
  }

  private closeTunnel(connectionId: string): void {
    this.tunnels.get(connectionId)?.close()
    this.tunnels.delete(connectionId)
  }
}

type RequestTextInput = {
  connectionId: string | null
  method: string
  requestPath: string
  requestUrl: URL
  headers: Record<string, string>
  body?: string
  trustInsecureCertificate: boolean
  tunnel?: SshTunnel
}

type RequestTextResponse = {
  body: string
  statusCode: number
}

async function requestText(input: RequestTextInput): Promise<RequestTextResponse> {
  const destinationPort = readEndpointPort(input.requestUrl)
  const tunnelStream = input.tunnel
    ? await input.tunnel.openStream(input.requestUrl.hostname, destinationPort)
    : null

  return new Promise((resolve, reject) => {
    const requestOptions: RequestOptions & HttpsRequestOptions = {
      method: input.method,
      headers: input.headers,
      rejectUnauthorized: !input.trustInsecureCertificate
    }
    if (tunnelStream) {
      requestOptions.agent = false
      requestOptions.createConnection = () =>
        input.requestUrl.protocol === 'https:'
          ? connectTls({
              socket: tunnelStream,
              servername: input.requestUrl.hostname,
              rejectUnauthorized: !input.trustInsecureCertificate
            })
          : tunnelStream
    }

    const request = (input.requestUrl.protocol === 'https:' ? httpsRequest : httpRequest)(
      input.requestUrl,
      requestOptions,
      (response) => {
        const chunks: Buffer[] = []
        let responseSize = 0
        response.on('data', (chunk: Buffer) => {
          responseSize += chunk.length
          if (responseSize > MAX_RESPONSE_SIZE_BYTES) {
            request.destroy(
              new ConnectionServiceError(
                'CONNECTION_RESPONSE_TOO_LARGE',
                input.connectionId,
                `${input.method} ${input.requestPath}`,
                '响应内容超过 5 MiB 限制'
              )
            )
            return
          }
          chunks.push(chunk)
        })
        response.on('end', () => {
          const statusCode = response.statusCode ?? 0
          if (statusCode < 200 || statusCode >= 300) {
            reject(
              createHttpError(
                input.connectionId,
                input.method,
                input.requestPath,
                statusCode,
                response.statusMessage ?? ''
              )
            )
            return
          }
          resolve({ body: Buffer.concat(chunks).toString('utf8'), statusCode })
        })
      }
    )

    request.setTimeout(DEFAULT_REQUEST_TIMEOUT_MS, () => {
      request.destroy(
        new ConnectionServiceError(
          'CONNECTION_TIMEOUT',
          input.connectionId,
          `${input.method} ${input.requestPath}`,
          `请求超过 ${DEFAULT_REQUEST_TIMEOUT_MS}ms`
        )
      )
    })
    request.on('error', (error: Error) => {
      tunnelStream?.destroy()
      if (error instanceof ConnectionServiceError) {
        reject(error)
        return
      }
      reject(
        new ConnectionServiceError(
          'CONNECTION_NETWORK_ERROR',
          input.connectionId,
          `${input.method} ${input.requestPath}`,
          error.message,
          { cause: error }
        )
      )
    })
    request.end(input.body)
  })
}

function parsePersistedConnections(content: string): ParsedConnections {
  try {
    const parsed = JSON.parse(content) as unknown
    if (!isRecord(parsed) || !Array.isArray(parsed.connections)) {
      throw new Error('配置文件结构不完整')
    }

    if (parsed.version === 1) {
      const legacy = parsed as LegacyPersistedConnections
      return {
        migrated: true,
        groups: [],
        connections: legacy.connections.map((item) =>
          createDefaultConnection(
            normalizeConnectionId(item.id),
            normalizeName(item.name, null),
            normalizeEndpoints(item.endpoint, null)[0]
          )
        )
      }
    }
    if (
      parsed.version !== 2 &&
      parsed.version !== 3 &&
      parsed.version !== 4 &&
      parsed.version !== 5
    ) {
      throw new Error(`不支持的配置版本：${String(parsed.version)}`)
    }
    const storageVersion: 2 | 3 | 4 | 5 = parsed.version
    const groups = storageVersion === 4 || storageVersion === 5
      ? parseStoredGroups(parsed.groups, storageVersion)
      : []
    const groupIds = new Set(groups.map((group) => group.id))

    const connectionIds = new Set<string>()
    const connections = parsed.connections.map((item: unknown) => {
      if (!isRecord(item)) throw new Error('连接配置项不是对象')
      const connectionId = normalizeConnectionId(item.id)
      if (connectionIds.has(connectionId)) throw new Error(`存在重复连接 ID：${connectionId}`)
      connectionIds.add(connectionId)
      const connection = validateStoredConnection(item, connectionId, storageVersion)
      if (connection.groupId !== null && !groupIds.has(connection.groupId)) {
        throw new Error(`连接 ${connectionId} 引用了不存在的分组：${connection.groupId}`)
      }
      return connection
    })
    return { groups, connections, migrated: storageVersion !== 5 }
  } catch (error: unknown) {
    throw new ConnectionServiceError(
      'CONNECTION_STORAGE_INVALID',
      null,
      '解析连接配置',
      getErrorMessage(error),
      { cause: error }
    )
  }
}

function parseStoredGroups(value: unknown, storageVersion: 4 | 5): ConnectionGroup[] {
  if (!Array.isArray(value)) throw new Error(`v${storageVersion} 配置缺少 groups 数组`)
  const groupIds = new Set<string>()
  const groupNames = new Set<string>()
  return value.map((item: unknown) => {
    if (!isRecord(item)) throw new Error('连接分组配置项不是对象')
    const groupId = normalizeGroupId(item.id)
    const groupName = normalizeGroupName(item.name, groupId)
    const normalizedName = groupName.toLowerCase()
    if (groupIds.has(groupId)) throw new Error(`存在重复分组 ID：${groupId}`)
    if (groupNames.has(normalizedName)) throw new Error(`存在重复分组名称：${groupName}`)
    groupIds.add(groupId)
    groupNames.add(normalizedName)
    return {
      id: groupId,
      name: groupName,
      color: normalizeStoredGroupColor(item.color, groupId, storageVersion)
    }
  })
}

function toStoredConnection(
  id: string,
  input: ConnectionFormValue | null | undefined,
  existing: StoredConnection | null,
  groupId: string | null
): StoredConnection {
  if (!input) {
    throw new ConnectionServiceError('CONNECTION_INVALID_INPUT', id, '校验连接配置', '连接配置不能为空')
  }
  const authorizationType = normalizeAuthorizationType(input.authorization?.type, id)
  const providedSecret = normalizeOptionalSecret(input.authorization?.secret)
  const existingSecret =
    existing?.authorization.type === authorizationType ? existing.authorization.encryptedSecret : ''
  const encryptedSecret = providedSecret ? encryptValue(providedSecret, id) : existingSecret
  validateAuthorization(authorizationType, input.authorization?.username, encryptedSecret, id)
  const mode = normalizeMode(input.mode, id)
  const ssh = normalizeSshSettings(input.ssh, existing?.ssh ?? null, id)
  const aws = normalizeAwsSettings(input.aws, existing?.aws ?? null, id)
  validateAuthenticationCombination(mode, authorizationType, aws, id)

  return {
    id,
    groupId,
    name: normalizeName(input.name, id),
    endpoints: normalizeEndpoints(input.endpoints, id),
    readOnly: Boolean(input.readOnly),
    mode,
    trustInsecureCertificate: Boolean(input.trustInsecureCertificate),
    authorization: {
      type: authorizationType,
      username: normalizeOptionalText(input.authorization?.username),
      encryptedSecret
    },
    headers: normalizeHeaders(input.headers, id),
    ssh,
    aws,
    filters: {
      indices: normalizeOptionalText(input.filters?.indices),
      aliases: normalizeOptionalText(input.filters?.aliases),
      templates: normalizeOptionalText(input.filters?.templates)
    }
  }
}

function toProfile(connection: StoredConnection): ConnectionProfile {
  return {
    id: connection.id,
    groupId: connection.groupId,
    name: connection.name,
    endpoints: connection.endpoints.join('; '),
    readOnly: connection.readOnly,
    mode: connection.mode,
    trustInsecureCertificate: connection.trustInsecureCertificate,
    authorization: {
      type: connection.authorization.type,
      username: connection.authorization.username,
      secret: decryptValue(connection.authorization.encryptedSecret, connection.id)
    },
    headers: connection.headers.map((header) => ({
      id: header.id,
      name: header.name,
      value: decryptValue(header.encryptedValue, connection.id),
      enabled: header.enabled
    })),
    ssh: {
      enabled: connection.ssh.enabled,
      host: connection.ssh.host,
      port: connection.ssh.port,
      username: connection.ssh.username,
      authorizationType: connection.ssh.authorizationType,
      password: decryptValue(connection.ssh.encryptedPassword, connection.id),
      privateKeyPath: connection.ssh.privateKeyPath,
      passphrase: decryptValue(connection.ssh.encryptedPassphrase, connection.id),
      agentSocket: connection.ssh.agentSocket,
      hostFingerprint: connection.ssh.hostFingerprint
    },
    aws: {
      enabled: connection.aws.enabled,
      region: connection.aws.region,
      service: connection.aws.service,
      credentialSource: connection.aws.credentialSource,
      profile: connection.aws.profile,
      accessKeyId: connection.aws.accessKeyId,
      secretAccessKey: decryptValue(connection.aws.encryptedSecretAccessKey, connection.id),
      sessionToken: decryptValue(connection.aws.encryptedSessionToken, connection.id)
    },
    filters: { ...connection.filters }
  }
}

function validateStoredConnection(
  item: Record<string, unknown>,
  connectionId: string,
  storageVersion: 2 | 3 | 4 | 5
): StoredConnection {
  if (!isRecord(item.authorization) || !Array.isArray(item.headers) || !isRecord(item.filters)) {
    throw new Error(`连接 ${connectionId} 的配置结构不完整`)
  }
  if (storageVersion !== 2 && (!isRecord(item.ssh) || !isRecord(item.aws))) {
    throw new Error(`连接 ${connectionId} 的 SSH/AWS 配置结构不完整`)
  }
  const mode = normalizeMode(item.mode, connectionId)
  const authorizationType = normalizeAuthorizationType(item.authorization.type, connectionId)
  const ssh = storageVersion !== 2
    ? validateStoredSshSettings(item.ssh as Record<string, unknown>, connectionId)
    : createDefaultSshSettings()
  const aws = storageVersion !== 2
    ? validateStoredAwsSettings(item.aws as Record<string, unknown>, connectionId)
    : createDefaultAwsSettings()
  validateAuthenticationCombination(mode, authorizationType, aws, connectionId)

  return {
    id: connectionId,
    groupId: storageVersion >= 4 ? normalizeOptionalGroupId(item.groupId) : null,
    name: normalizeName(item.name, connectionId),
    endpoints: normalizeEndpoints(item.endpoints, connectionId),
    readOnly: Boolean(item.readOnly),
    mode,
    trustInsecureCertificate: Boolean(item.trustInsecureCertificate),
    authorization: {
      type: authorizationType,
      username: normalizeOptionalText(item.authorization.username),
      encryptedSecret: normalizeOptionalText(item.authorization.encryptedSecret)
    },
    headers: item.headers.map((header: unknown) => {
      if (!isRecord(header)) throw new Error(`连接 ${connectionId} 的 Header 配置无效`)
      return {
        id: normalizeName(header.id, connectionId),
        name: normalizeHeaderName(header.name, connectionId),
        encryptedValue: normalizeOptionalText(header.encryptedValue),
        enabled: Boolean(header.enabled)
      }
    }),
    ssh,
    aws,
    filters: {
      indices: normalizeOptionalText(item.filters.indices),
      aliases: normalizeOptionalText(item.filters.aliases),
      templates: normalizeOptionalText(item.filters.templates)
    }
  }
}

function normalizeHeaders(headers: ConnectionHeader[] | undefined, connectionId: string): StoredHeader[] {
  if (!Array.isArray(headers)) return []
  const names = new Set<string>()
  return headers
    .filter((header) => header.name.trim() || header.value.trim())
    .map((header) => {
      const name = normalizeHeaderName(header.name, connectionId)
      const lowerName = name.toLowerCase()
      if (FORBIDDEN_HEADER_NAMES.has(lowerName)) {
        throw new ConnectionServiceError(
          'CONNECTION_FORBIDDEN_HEADER',
          connectionId,
          '校验请求 Header',
          `Header ${name} 由连接模块统一管理，不能自定义`
        )
      }
      if (names.has(lowerName)) {
        throw new ConnectionServiceError(
          'CONNECTION_DUPLICATE_HEADER',
          connectionId,
          '校验请求 Header',
          `Header ${name} 重复`
        )
      }
      names.add(lowerName)
      return {
        id: normalizeOptionalText(header.id) || randomUUID(),
        name,
        encryptedValue: encryptValue(typeof header.value === 'string' ? header.value : '', connectionId),
        enabled: Boolean(header.enabled)
      }
    })
}

function createRequestHeaders(connection: StoredConnection): Record<string, string> {
  const headers: Record<string, string> = { accept: 'application/json' }
  for (const header of connection.headers) {
    if (header.enabled) headers[header.name] = decryptValue(header.encryptedValue, connection.id)
  }

  const secret = decryptValue(connection.authorization.encryptedSecret, connection.id)
  if (connection.authorization.type === 'basic') {
    headers.authorization = `Basic ${Buffer.from(`${connection.authorization.username}:${secret}`).toString('base64')}`
  } else if (connection.authorization.type === 'api-key') {
    headers.authorization = `ApiKey ${secret}`
  } else if (connection.authorization.type === 'bearer' || connection.authorization.type === 'oauth2') {
    headers.authorization = `Bearer ${secret}`
  }
  return headers
}

function createRequestUrl(
  endpoint: string,
  mode: ConnectionMode,
  requestPath: string,
  method: JsonRequestOptions['method'] = 'GET'
): URL {
  if (mode === 'direct') return new URL(requestPath, `${endpoint}/`)
  const url = new URL('/api/console/proxy', `${endpoint}/`)
  url.searchParams.set('path', requestPath.replace(/^\//, ''))
  url.searchParams.set('method', method)
  return url
}

function normalizeEndpoints(value: unknown, connectionId: string | null): string[] {
  const rawEndpoints = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(';')
      : []
  const endpoints = rawEndpoints
    .map((endpoint) => normalizeEndpoint(endpoint, connectionId))
    .filter((endpoint, index, all) => all.indexOf(endpoint) === index)
  if (!endpoints.length) {
    throw new ConnectionServiceError(
      'CONNECTION_INVALID_ENDPOINT',
      connectionId,
      '校验连接地址',
      '至少需要一个 HTTP(S) 地址'
    )
  }
  return endpoints
}

function normalizeEndpoint(value: unknown, connectionId: string | null): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ConnectionServiceError('CONNECTION_INVALID_ENDPOINT', connectionId, '校验连接地址', '连接地址不能为空')
  }
  try {
    const endpoint = new URL(value.trim())
    if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') throw new Error('仅允许 http 或 https 协议')
    if (endpoint.username || endpoint.password) throw new Error('连接地址不能包含明文凭据')
    if (endpoint.search || endpoint.hash) throw new Error('连接地址不能包含查询参数或锚点')
    return endpoint.toString().replace(/\/$/, '')
  } catch (error: unknown) {
    throw new ConnectionServiceError('CONNECTION_INVALID_ENDPOINT', connectionId, '校验连接地址', getErrorMessage(error), { cause: error })
  }
}

function normalizeName(value: unknown, connectionId: string | null): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ConnectionServiceError('CONNECTION_INVALID_NAME', connectionId, '校验连接名称', '名称不能为空')
  }
  return value.trim()
}

function normalizeHeaderName(value: unknown, connectionId: string): string {
  const name = normalizeName(value, connectionId)
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) {
    throw new ConnectionServiceError('CONNECTION_INVALID_HEADER', connectionId, '校验请求 Header', `Header 名称无效：${name}`)
  }
  return name
}

function normalizeMode(value: unknown, connectionId: string): ConnectionMode {
  if (value === 'direct' || value === 'kibana') return value
  throw new ConnectionServiceError('CONNECTION_INVALID_MODE', connectionId, '校验连接模式', `不支持的模式：${String(value)}`)
}

function normalizeAuthorizationType(value: unknown, connectionId: string): AuthorizationType {
  if (value === 'none' || value === 'basic' || value === 'api-key' || value === 'bearer' || value === 'oauth2') return value
  throw new ConnectionServiceError('CONNECTION_INVALID_AUTH_TYPE', connectionId, '校验认证方式', `不支持的认证方式：${String(value)}`)
}

function validateAuthorization(type: AuthorizationType, username: unknown, encryptedSecret: string, connectionId: string): void {
  if (type === 'basic' && !normalizeOptionalText(username)) {
    throw new ConnectionServiceError('CONNECTION_INVALID_AUTH', connectionId, '校验认证信息', 'Basic Auth 用户名不能为空')
  }
  if (type !== 'none' && !encryptedSecret) {
    throw new ConnectionServiceError('CONNECTION_INVALID_AUTH', connectionId, '校验认证信息', '认证凭据不能为空')
  }
}

function normalizeSshSettings(
  input: ConnectionFormValue['ssh'] | null | undefined,
  existing: StoredSshSettings | null,
  connectionId: string
): StoredSshSettings {
  const authorizationType = normalizeSshAuthorizationType(input?.authorizationType, connectionId)
  const providedPassword = normalizeOptionalSecret(input?.password)
  const providedPassphrase = normalizeOptionalSecret(input?.passphrase)
  const encryptedPassword = providedPassword
    ? encryptValue(providedPassword, connectionId)
    : existing?.authorizationType === 'password'
      ? existing.encryptedPassword
      : ''
  const encryptedPassphrase = providedPassphrase
    ? encryptValue(providedPassphrase, connectionId)
    : existing?.authorizationType === 'private-key'
      ? existing.encryptedPassphrase
      : ''
  const settings: StoredSshSettings = {
    enabled: Boolean(input?.enabled),
    host: normalizeOptionalText(input?.host),
    port: normalizePort(input?.port, 22, connectionId, 'SSH'),
    username: normalizeOptionalText(input?.username),
    authorizationType,
    encryptedPassword,
    privateKeyPath: normalizeOptionalText(input?.privateKeyPath),
    encryptedPassphrase,
    agentSocket: normalizeOptionalText(input?.agentSocket),
    hostFingerprint: normalizeHostFingerprint(input?.hostFingerprint, connectionId)
  }
  validateSshSettings(settings, connectionId)
  return settings
}

function normalizeAwsSettings(
  input: ConnectionFormValue['aws'] | null | undefined,
  existing: StoredAwsSettings | null,
  connectionId: string
): StoredAwsSettings {
  const credentialSource = normalizeAwsCredentialSource(input?.credentialSource, connectionId)
  const providedSecretAccessKey = normalizeOptionalSecret(input?.secretAccessKey)
  const providedSessionToken = normalizeOptionalSecret(input?.sessionToken)
  const encryptedSecretAccessKey = providedSecretAccessKey
    ? encryptValue(providedSecretAccessKey, connectionId)
    : existing?.credentialSource === 'static'
      ? existing.encryptedSecretAccessKey
      : ''
  const encryptedSessionToken = providedSessionToken
    ? encryptValue(providedSessionToken, connectionId)
    : existing?.credentialSource === 'static'
      ? existing.encryptedSessionToken
      : ''
  const settings: StoredAwsSettings = {
    enabled: Boolean(input?.enabled),
    region: normalizeOptionalText(input?.region),
    service: normalizeAwsService(input?.service, connectionId),
    credentialSource,
    profile: normalizeOptionalText(input?.profile),
    accessKeyId: normalizeOptionalText(input?.accessKeyId),
    encryptedSecretAccessKey,
    encryptedSessionToken
  }
  validateAwsSettings(settings, connectionId)
  return settings
}

function validateStoredSshSettings(
  item: Record<string, unknown>,
  connectionId: string
): StoredSshSettings {
  const settings: StoredSshSettings = {
    enabled: Boolean(item.enabled),
    host: normalizeOptionalText(item.host),
    port: normalizePort(item.port, 22, connectionId, 'SSH'),
    username: normalizeOptionalText(item.username),
    authorizationType: normalizeSshAuthorizationType(item.authorizationType, connectionId),
    encryptedPassword: normalizeOptionalText(item.encryptedPassword),
    privateKeyPath: normalizeOptionalText(item.privateKeyPath),
    encryptedPassphrase: normalizeOptionalText(item.encryptedPassphrase),
    agentSocket: normalizeOptionalText(item.agentSocket),
    hostFingerprint: normalizeHostFingerprint(item.hostFingerprint, connectionId)
  }
  validateSshSettings(settings, connectionId)
  return settings
}

function validateStoredAwsSettings(
  item: Record<string, unknown>,
  connectionId: string
): StoredAwsSettings {
  const settings: StoredAwsSettings = {
    enabled: Boolean(item.enabled),
    region: normalizeOptionalText(item.region),
    service: normalizeAwsService(item.service, connectionId),
    credentialSource: normalizeAwsCredentialSource(item.credentialSource, connectionId),
    profile: normalizeOptionalText(item.profile),
    accessKeyId: normalizeOptionalText(item.accessKeyId),
    encryptedSecretAccessKey: normalizeOptionalText(item.encryptedSecretAccessKey),
    encryptedSessionToken: normalizeOptionalText(item.encryptedSessionToken)
  }
  validateAwsSettings(settings, connectionId)
  return settings
}

function validateSshSettings(settings: StoredSshSettings, connectionId: string): void {
  if (!settings.enabled) return
  if (!settings.host || !settings.username) {
    throw new ConnectionServiceError(
      'CONNECTION_INVALID_SSH',
      connectionId,
      '校验 SSH 配置',
      'SSH 主机和用户名不能为空'
    )
  }
  if (settings.authorizationType === 'password' && !settings.encryptedPassword) {
    throw new ConnectionServiceError(
      'CONNECTION_INVALID_SSH',
      connectionId,
      '校验 SSH 配置',
      'SSH 密码不能为空'
    )
  }
  if (settings.authorizationType === 'private-key' && !settings.privateKeyPath) {
    throw new ConnectionServiceError(
      'CONNECTION_INVALID_SSH',
      connectionId,
      '校验 SSH 配置',
      'SSH 私钥路径不能为空'
    )
  }
}

function validateAwsSettings(settings: StoredAwsSettings, connectionId: string): void {
  if (!settings.enabled) return
  if (!settings.region) {
    throw new ConnectionServiceError(
      'CONNECTION_INVALID_AWS',
      connectionId,
      '校验 AWS 配置',
      'AWS Region 不能为空'
    )
  }
  if (
    settings.credentialSource === 'static' &&
    (!settings.accessKeyId || !settings.encryptedSecretAccessKey)
  ) {
    throw new ConnectionServiceError(
      'CONNECTION_INVALID_AWS',
      connectionId,
      '校验 AWS 配置',
      'Static Credential 必须提供 Access Key ID 和 Secret Access Key'
    )
  }
}

function validateAuthenticationCombination(
  mode: ConnectionMode,
  authorizationType: AuthorizationType,
  aws: StoredAwsSettings,
  connectionId: string
): void {
  if (!aws.enabled) return
  if (mode === 'kibana') {
    throw new ConnectionServiceError(
      'CONNECTION_INCOMPATIBLE_AUTH',
      connectionId,
      '校验 AWS 认证',
      'AWS SigV4 不能与 Kibana 代理模式同时开启'
    )
  }
  if (authorizationType !== 'none') {
    throw new ConnectionServiceError(
      'CONNECTION_INCOMPATIBLE_AUTH',
      connectionId,
      '校验 AWS 认证',
      'AWS SigV4 不能与 Basic、API Key、Bearer 或 OAuth2 认证同时开启'
    )
  }
}

function normalizeSshAuthorizationType(
  value: unknown,
  connectionId: string
): SshAuthorizationType {
  if (value === 'password' || value === 'private-key' || value === 'agent') return value
  throw new ConnectionServiceError(
    'CONNECTION_INVALID_SSH_AUTH',
    connectionId,
    '校验 SSH 认证方式',
    `不支持的认证方式：${String(value)}`
  )
}

function normalizeAwsCredentialSource(
  value: unknown,
  connectionId: string
): AwsCredentialSource {
  if (value === 'default' || value === 'static') return value
  throw new ConnectionServiceError(
    'CONNECTION_INVALID_AWS_CREDENTIAL_SOURCE',
    connectionId,
    '校验 AWS 凭据来源',
    `不支持的凭据来源：${String(value)}`
  )
}

function normalizeAwsService(value: unknown, connectionId: string): AwsService {
  if (value === 'es' || value === 'aoss') return value
  throw new ConnectionServiceError(
    'CONNECTION_INVALID_AWS_SERVICE',
    connectionId,
    '校验 AWS Service',
    `不支持的 Service：${String(value)}`
  )
}

function normalizePort(
  value: unknown,
  defaultPort: number,
  connectionId: string,
  moduleName: string
): number {
  const port = typeof value === 'number' ? value : defaultPort
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ConnectionServiceError(
      'CONNECTION_INVALID_PORT',
      connectionId,
      `校验 ${moduleName} 端口`,
      `端口必须是 1-65535 的整数：value=${String(value)}`
    )
  }
  return port
}

function normalizeHostFingerprint(value: unknown, connectionId: string): string {
  const fingerprint = normalizeOptionalText(value).replace(/:/g, '').toLowerCase()
  if (fingerprint && !/^[0-9a-f]{64}$/.test(fingerprint)) {
    throw new ConnectionServiceError(
      'CONNECTION_INVALID_SSH_FINGERPRINT',
      connectionId,
      '校验 SSH 主机指纹',
      '指纹必须是 SHA256 hex（64 个十六进制字符）'
    )
  }
  return fingerprint
}

function encryptValue(value: string, connectionId: string): string {
  if (!value) return ''
  if (!safeStorage.isEncryptionAvailable()) {
    throw new ConnectionServiceError('CONNECTION_ENCRYPTION_UNAVAILABLE', connectionId, '加密连接凭据', '当前系统安全存储不可用')
  }
  return safeStorage.encryptString(value).toString('base64')
}

function decryptValue(value: string, connectionId: string): string {
  if (!value) return ''
  try {
    return safeStorage.decryptString(Buffer.from(value, 'base64'))
  } catch (error: unknown) {
    throw new ConnectionServiceError('CONNECTION_DECRYPTION_FAILED', connectionId, '解密连接凭据', getErrorMessage(error), { cause: error })
  }
}

function createDefaultConnection(id: string, name: string, endpoint: string): StoredConnection {
  return {
    id,
    groupId: null,
    name,
    endpoints: [endpoint],
    readOnly: false,
    mode: 'direct',
    trustInsecureCertificate: false,
    authorization: { type: 'none', username: '', encryptedSecret: '' },
    headers: [],
    ssh: createDefaultSshSettings(),
    aws: createDefaultAwsSettings(),
    filters: { indices: '', aliases: '', templates: '' }
  }
}

function createDefaultSshSettings(): StoredSshSettings {
  return {
    enabled: false,
    host: '',
    port: 22,
    username: '',
    authorizationType: 'password',
    encryptedPassword: '',
    privateKeyPath: '',
    encryptedPassphrase: '',
    agentSocket: '',
    hostFingerprint: ''
  }
}

function createDefaultAwsSettings(): StoredAwsSettings {
  return {
    enabled: false,
    region: '',
    service: 'es',
    credentialSource: 'default',
    profile: '',
    accessKeyId: '',
    encryptedSecretAccessKey: '',
    encryptedSessionToken: ''
  }
}

function toSshTunnelSettings(
  settings: StoredSshSettings,
  connectionId: string
): Parameters<typeof SshTunnel.connect>[0] {
  const agentSocket = settings.agentSocket || process.env.SSH_AUTH_SOCK || ''
  if (settings.authorizationType === 'agent' && !agentSocket) {
    throw new ConnectionServiceError(
      'CONNECTION_INVALID_SSH',
      connectionId,
      '建立 SSH 隧道',
      'SSH Agent Socket 不可用'
    )
  }
  return {
    host: settings.host,
    port: settings.port,
    username: settings.username,
    authorizationType: settings.authorizationType,
    password: decryptValue(settings.encryptedPassword, connectionId),
    privateKeyPath: settings.privateKeyPath,
    passphrase: decryptValue(settings.encryptedPassphrase, connectionId),
    agentSocket,
    hostFingerprint: settings.hostFingerprint
  }
}

function toAwsSigningSettings(
  settings: StoredAwsSettings,
  connectionId: string
): Parameters<typeof signAwsRequest>[0]['settings'] {
  return {
    region: settings.region,
    service: settings.service,
    credentialSource: settings.credentialSource,
    profile: settings.profile,
    accessKeyId: settings.accessKeyId,
    secretAccessKey: decryptValue(settings.encryptedSecretAccessKey, connectionId),
    sessionToken: decryptValue(settings.encryptedSessionToken, connectionId)
  }
}

function createEndpointOrder(endpoints: string[], activeEndpointIndex: number): number[] {
  return endpoints.map((_, offset) => (activeEndpointIndex + offset) % endpoints.length)
}

function hasRequestConfigurationChanged(previous: StoredConnection, next: StoredConnection): boolean {
  return JSON.stringify({ ...previous, name: undefined, readOnly: undefined, groupId: undefined }) !==
    JSON.stringify({ ...next, name: undefined, readOnly: undefined, groupId: undefined })
}

function createDisconnectedState(): RuntimeConnectionState {
  return { status: 'disconnected', engine: null, version: null, lastError: null, activeEndpointIndex: 0 }
}

function copyStoredConnection(connection: StoredConnection): StoredConnection {
  return {
    ...connection,
    endpoints: [...connection.endpoints],
    authorization: { ...connection.authorization },
    headers: connection.headers.map((header) => ({ ...header })),
    ssh: { ...connection.ssh },
    aws: { ...connection.aws },
    filters: { ...connection.filters }
  }
}

function copyConnectionGroup(group: ConnectionGroup): ConnectionGroup {
  return { id: group.id, name: group.name, color: group.color }
}

function createFailedTestResult(
  connectionId: string | null,
  latencyMs: number,
  error: string
): ConnectionTestResult {
  return {
    connectionId,
    success: false,
    engine: null,
    version: null,
    clusterName: null,
    endpoint: null,
    latencyMs,
    error
  }
}

function readEndpointPort(url: URL): number {
  if (url.port) return Number(url.port)
  return url.protocol === 'https:' ? 443 : 80
}

function detectEngine(response: RootResponse): { engine: string | null; version: string | null } {
  const distribution = readString(response.version?.distribution)?.toLowerCase()
  const tagline = readString(response.tagline)?.toLowerCase()
  let engine: string | null = null
  if (distribution === 'opensearch' || tagline?.includes('opensearch')) engine = 'OpenSearch'
  else if (tagline?.includes('you know, for search') || response.version) engine = 'Elasticsearch'
  return { engine, version: readString(response.version?.number) }
}

function createHttpError(
  connectionId: string | null,
  method: string,
  requestPath: string,
  status: number,
  statusText: string
): ConnectionServiceError {
  const code = status === 401
    ? 'CONNECTION_AUTHENTICATION_FAILED'
    : status === 403
      ? 'CONNECTION_FORBIDDEN'
      : status >= 300 && status < 400
        ? 'CONNECTION_REDIRECT_REJECTED'
        : 'CONNECTION_HTTP_ERROR'
  return new ConnectionServiceError(
    code,
    connectionId,
    `${method} ${requestPath}`,
    `HTTP ${status}${statusText ? ` ${statusText}` : ''}`,
    undefined,
    status
  )
}

function createNotFoundError(connectionId: string, operation: string): ConnectionServiceError {
  return new ConnectionServiceError('CONNECTION_NOT_FOUND', connectionId, operation, '未找到对应的连接配置')
}

function createGroupNotFoundError(groupId: string, operation: string): ConnectionServiceError {
  return new ConnectionServiceError(
    'CONNECTION_GROUP_NOT_FOUND',
    null,
    operation,
    `未找到连接分组：groupId=${groupId}`
  )
}

function normalizeGroupId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ConnectionServiceError(
      'CONNECTION_GROUP_INVALID_ID',
      null,
      '校验连接分组 ID',
      '分组 ID 不能为空'
    )
  }
  return value.trim()
}

function normalizeOptionalGroupId(value: unknown): string | null {
  return value === null || value === undefined ? null : normalizeGroupId(value)
}

function normalizeGroupName(value: unknown, groupId: string | null): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ConnectionServiceError(
      'CONNECTION_GROUP_INVALID_NAME',
      null,
      '校验连接分组',
      `分组名称不能为空：groupId=${groupId ?? '未创建'}`
    )
  }
  return value.trim()
}

function normalizeGroupColor(value: unknown, groupId: string | null): ConnectionGroupColor {
  if (value === null) return null
  if (typeof value === 'string' && GROUP_COLOR_PATTERN.test(value)) {
    return value as ConnectionGroupColor
  }
  throw new ConnectionServiceError(
    'CONNECTION_GROUP_INVALID_COLOR',
    null,
    '校验连接分组',
    `不支持的颜色：groupId=${groupId ?? '未创建'}，color=${String(value)}`
  )
}

function normalizeStoredGroupColor(
  value: unknown,
  groupId: string,
  storageVersion: 4 | 5
): ConnectionGroupColor {
  // v4 使用固定 token；迁移时保留旧界面的实际色值，随后由 initialize 写回 v5。
  if (storageVersion === 4 && typeof value === 'string') {
    const legacyColor = LEGACY_CONNECTION_GROUP_COLORS[
      value as keyof typeof LEGACY_CONNECTION_GROUP_COLORS
    ]
    if (legacyColor) return legacyColor
  }
  return normalizeGroupColor(value, groupId)
}

function normalizeConnectionIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ConnectionServiceError(
      'CONNECTION_GROUP_EMPTY_MOVE',
      null,
      '移动连接',
      '至少需要一个连接 ID'
    )
  }
  const connectionIds = value.map(normalizeConnectionId)
  if (new Set(connectionIds).size !== connectionIds.length) {
    throw new ConnectionServiceError(
      'CONNECTION_GROUP_DUPLICATE_CONNECTION',
      null,
      '移动连接',
      '连接 ID 不能重复'
    )
  }
  return connectionIds
}

function assertUniqueGroupName(
  groups: ConnectionGroup[],
  name: string,
  excludedGroupId: string | null
): void {
  const normalizedName = name.toLowerCase()
  const duplicate = groups.find(
    (group) => group.id !== excludedGroupId && group.name.toLowerCase() === normalizedName
  )
  if (duplicate) {
    throw new ConnectionServiceError(
      'CONNECTION_GROUP_DUPLICATE_NAME',
      null,
      '校验连接分组',
      `分组名称已存在：name=${name}`
    )
  }
}

function assertGroupExists(
  groups: ConnectionGroup[],
  groupId: string | null,
  operation: string
): void {
  if (groupId !== null && !groups.some((group) => group.id === groupId)) {
    throw createGroupNotFoundError(groupId, operation)
  }
}

function normalizeConnectionId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ConnectionServiceError('CONNECTION_INVALID_ID', null, '校验连接 ID', '连接 ID 不能为空')
  }
  return value.trim()
}

function normalizeOptionalConnectionId(value: unknown): string | null {
  return value === null || value === undefined ? null : normalizeConnectionId(value)
}

function normalizeOptionalText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeOptionalSecret(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function isFileNotFoundError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
