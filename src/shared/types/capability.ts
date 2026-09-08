export type EngineFamily = 'elasticsearch' | 'opensearch' | 'unknown'

export type CapabilityConnectionMode = 'direct' | 'kibana'

export type EngineVersion = {
  raw: string
  major: number | null
  minor: number | null
  patch: number | null
  prerelease: string | null
}

export type CapabilityKey =
  | 'health'
  | 'stats'
  | 'state'
  | 'settings'
  | 'nodes'
  | 'shards'
  | 'tasks'
  | 'pendingTasks'
  | 'indexTemplates'
  | 'componentTemplates'
  | 'dataStreams'
  | 'pipelines'
  | 'scripts'
  | 'snapshots'
  | 'reindex'
  | 'asyncSearch'

export type CapabilityAccess = 'read' | 'read-write' | 'write'

export type CapabilityPermission = 'unknown' | 'granted' | 'denied'

export type CapabilityReasonKind =
  | 'supported'
  | 'permission-unknown'
  | 'permission-denied'
  | 'product-version-unsupported'
  | 'unknown-product'
  | 'unknown-version'
  | 'proxy-unverified'

export type CapabilityDecision = {
  key: CapabilityKey
  access: CapabilityAccess
  supported: boolean
  writeSupported: boolean
  permission: CapabilityPermission
  reasonKind: CapabilityReasonKind
  reason: string
  endpointVariants: string[]
}

export type CapabilityMatrixInput = {
  engine: string | null
  version: string | null
  mode: CapabilityConnectionMode
  permissions?: Partial<Record<CapabilityKey, CapabilityPermission>>
}

export type CapabilityMatrix = {
  engine: EngineFamily
  version: EngineVersion
  mode: CapabilityConnectionMode
  verifiedVersion: boolean
  capabilities: Record<CapabilityKey, CapabilityDecision>
}
