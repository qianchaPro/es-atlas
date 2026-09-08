export type ConnectionStatus = 'disconnected' | 'connected' | 'unavailable'
export type ConnectionMode = 'direct' | 'kibana'
export type AuthorizationType = 'none' | 'basic' | 'api-key' | 'bearer' | 'oauth2'
export type SshAuthorizationType = 'password' | 'private-key' | 'agent'
export type AwsCredentialSource = 'default' | 'static'
export type AwsService = 'es' | 'aoss'

export type ConnectionGroupColor = `#${string}` | null

export type ConnectionGroup = {
  id: string
  name: string
  color: ConnectionGroupColor
}

export type CreateConnectionGroupInput = {
  name: string
  color: ConnectionGroupColor
}

export type UpdateConnectionGroupInput = CreateConnectionGroupInput & {
  id: string
}

export type MoveConnectionsInput = {
  connectionIds: string[]
  groupId: string | null
}

export type ConnectionHeader = {
  id: string
  name: string
  value: string
  enabled: boolean
}

export type ConnectionFilters = {
  indices: string
  aliases: string
  templates: string
}

export type ConnectionAuthorization = {
  type: AuthorizationType
  username: string
  secret: string
}

export type SshConnectionSettings = {
  enabled: boolean
  host: string
  port: number
  username: string
  authorizationType: SshAuthorizationType
  password: string
  privateKeyPath: string
  passphrase: string
  agentSocket: string
  hostFingerprint: string
}

export type AwsConnectionSettings = {
  enabled: boolean
  region: string
  service: AwsService
  credentialSource: AwsCredentialSource
  profile: string
  accessKeyId: string
  secretAccessKey: string
  sessionToken: string
}

export type ConnectionFormValue = {
  name: string
  endpoints: string
  readOnly: boolean
  mode: ConnectionMode
  trustInsecureCertificate: boolean
  authorization: ConnectionAuthorization
  headers: ConnectionHeader[]
  ssh: SshConnectionSettings
  aws: AwsConnectionSettings
  filters: ConnectionFilters
}

export type ConnectionProfile = ConnectionFormValue & {
  id: string
  groupId: string | null
}

export type ConnectionSummary = {
  id: string
  groupId: string | null
  name: string
  endpoint: string
  endpointCount: number
  readOnly: boolean
  mode: ConnectionMode
  authorizationType: AuthorizationType
  sshEnabled: boolean
  awsEnabled: boolean
  status: ConnectionStatus
  engine: string | null
  version: string | null
  lastError: string | null
}

export type CreateConnectionInput = ConnectionFormValue & {
  groupId?: string | null
}

export type UpdateConnectionInput = ConnectionFormValue & {
  id: string
  groupId?: string | null
}

export type ConnectionTestInput = {
  connectionId: string | null
  profile: ConnectionFormValue
}

export type ConnectionTestResult = {
  connectionId: string | null
  success: boolean
  engine: string | null
  version: string | null
  clusterName: string | null
  endpoint: string | null
  latencyMs: number
  error: string | null
}

export type ConnectionsApi = {
  list: () => Promise<ConnectionSummary[]>
  get: (connectionId: string) => Promise<ConnectionProfile>
  create: (input: CreateConnectionInput) => Promise<ConnectionSummary>
  update: (input: UpdateConnectionInput) => Promise<ConnectionSummary>
  delete: (connectionId: string) => Promise<void>
  test: (input: ConnectionTestInput) => Promise<ConnectionTestResult>
  connect: (connectionId: string) => Promise<ConnectionSummary>
  disconnect: (connectionId: string) => Promise<ConnectionSummary>
}

export type ConnectionGroupsApi = {
  list: () => Promise<ConnectionGroup[]>
  create: (input: CreateConnectionGroupInput) => Promise<ConnectionGroup>
  update: (input: UpdateConnectionGroupInput) => Promise<ConnectionGroup>
  delete: (groupId: string) => Promise<void>
  moveConnections: (input: MoveConnectionsInput) => Promise<ConnectionSummary[]>
}
