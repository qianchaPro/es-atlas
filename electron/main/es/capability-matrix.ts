import type {
  CapabilityAccess,
  CapabilityDecision,
  CapabilityKey,
  CapabilityMatrix,
  CapabilityMatrixInput,
  CapabilityPermission,
  CapabilityReasonKind,
  EngineFamily,
  EngineVersion
} from '../../../src/shared/types/capability'
import { isCapabilityUnsupportedByProductVersion } from '../../../src/shared/capability-support.ts'

export const CAPABILITY_KEYS = [
  'health',
  'stats',
  'state',
  'settings',
  'nodes',
  'shards',
  'tasks',
  'pendingTasks',
  'indexTemplates',
  'componentTemplates',
  'dataStreams',
  'pipelines',
  'scripts',
  'snapshots',
  'reindex',
  'asyncSearch'
] as const satisfies readonly CapabilityKey[]

type CapabilityDefinition = {
  access: CapabilityAccess
  endpoints: string[]
}

type StaticCapability = {
  supported: boolean
  writeSupported: boolean
  reasonKind: CapabilityReasonKind
  reason: string
}

const CAPABILITY_DEFINITIONS: Record<CapabilityKey, CapabilityDefinition> = {
  health: { access: 'read', endpoints: ['/_cluster/health'] },
  stats: { access: 'read', endpoints: ['/_cluster/stats'] },
  state: { access: 'read', endpoints: ['/_cluster/state'] },
  settings: { access: 'read-write', endpoints: ['/_cluster/settings'] },
  nodes: { access: 'read', endpoints: ['/_nodes'] },
  shards: { access: 'read', endpoints: ['/_cat/shards?format=json'] },
  tasks: { access: 'read', endpoints: ['/_tasks'] },
  pendingTasks: { access: 'read', endpoints: ['/_cluster/pending_tasks'] },
  indexTemplates: { access: 'read-write', endpoints: ['/_index_template', '/_template'] },
  componentTemplates: { access: 'read-write', endpoints: ['/_component_template'] },
  dataStreams: { access: 'read-write', endpoints: ['/_data_stream'] },
  pipelines: { access: 'read-write', endpoints: ['/_ingest/pipeline'] },
  scripts: { access: 'read-write', endpoints: ['/_scripts'] },
  snapshots: { access: 'read-write', endpoints: ['/_snapshot'] },
  reindex: { access: 'write', endpoints: ['/_reindex?wait_for_completion=false'] },
  asyncSearch: { access: 'read-write', endpoints: ['/_async_search'] }
}

const COMMON_READ_CAPABILITIES = new Set<CapabilityKey>([
  'health',
  'stats',
  'state',
  'settings',
  'nodes',
  'shards',
  'tasks',
  'pendingTasks'
])

export function parseEngineVersion(versionInput: string | null): EngineVersion {
  const raw = versionInput?.trim() ?? ''
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?(?:-([0-9A-Za-z][0-9A-Za-z.+-]*))?$/.exec(raw)
  if (!match) {
    return {
      raw,
      major: null,
      minor: null,
      patch: null,
      prerelease: null
    }
  }

  return {
    raw,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: match[3] === undefined ? 0 : Number(match[3]),
    prerelease: match[4] ?? null
  }
}

export function createCapabilityMatrix(input: CapabilityMatrixInput): CapabilityMatrix {
  const engine = detectEngineFamily(input.engine)
  const version = parseEngineVersion(input.version)
  const verifiedVersion = isVerifiedVersion(engine, version)
  const capabilities = Object.fromEntries(
    CAPABILITY_KEYS.map((key) => {
      const definition = CAPABILITY_DEFINITIONS[key]
      const permission = input.permissions?.[key] ?? 'unknown'
      const staticCapability = evaluateStaticCapability(
        key,
        definition.access,
        engine,
        version,
        input.mode
      )
      return [
        key,
        toCapabilityDecision(
          key,
          definition,
          engine,
          permission,
          staticCapability
        )
      ]
    })
  ) as Record<CapabilityKey, CapabilityDecision>

  return {
    engine,
    version,
    mode: input.mode,
    verifiedVersion,
    capabilities
  }
}

function detectEngineFamily(engineInput: string | null): EngineFamily {
  const normalized = engineInput?.trim().toLowerCase() ?? ''
  if (normalized.includes('opensearch')) return 'opensearch'
  if (normalized.includes('elasticsearch')) return 'elasticsearch'
  return 'unknown'
}

function isVerifiedVersion(engine: EngineFamily, version: EngineVersion): boolean {
  if (version.major === null || version.minor === null) return false
  if (engine === 'elasticsearch') return version.major >= 7 && version.major <= 9
  if (engine === 'opensearch') return version.major >= 1 && version.major <= 3
  return false
}

function evaluateStaticCapability(
  key: CapabilityKey,
  access: CapabilityAccess,
  engine: EngineFamily,
  version: EngineVersion,
  mode: CapabilityMatrixInput['mode']
): StaticCapability {
  if (engine === 'unknown') {
    return createUnverifiedCapability(key, access, 'unknown-product', '无法识别产品')
  }
  if (!isVerifiedVersion(engine, version)) {
    return createUnverifiedCapability(
      key,
      access,
      'unknown-version',
      `尚未验证 ${formatEngine(engine)} ${version.raw || '空版本'}`
    )
  }

  if (isCapabilityUnsupportedByProductVersion(key, engine, version.raw)) {
    return {
      supported: false,
      writeSupported: false,
      reasonKind: 'product-version-unsupported',
      reason: `${formatEngine(engine)} ${version.raw} 不支持 ${key}`
    }
  }

  if (mode === 'kibana') {
    if (access === 'write') {
      return {
        supported: false,
        writeSupported: false,
        reasonKind: 'proxy-unverified',
        reason: `Kibana 代理模式未验证 ${key} 写入能力`
      }
    }
    return {
      supported: true,
      writeSupported: false,
      reasonKind: 'proxy-unverified',
      reason: `Kibana 代理模式仅保留 ${key} 读取候选，写入已禁用`
    }
  }

  return {
    supported: true,
    writeSupported: access !== 'read',
    reasonKind: 'supported',
    reason: `${formatEngine(engine)} ${version.raw} 支持 ${key}`
  }
}

function createUnverifiedCapability(
  key: CapabilityKey,
  access: CapabilityAccess,
  reasonKind: 'unknown-product' | 'unknown-version',
  context: string
): StaticCapability {
  const readonlyCandidate = access !== 'write' && COMMON_READ_CAPABILITIES.has(key)
  return {
    supported: readonlyCandidate,
    writeSupported: false,
    reasonKind,
    reason: readonlyCandidate
      ? `${context}：${key} 仅作为公共只读能力尝试`
      : `${context}：已禁用未验证的 ${key} 能力`
  }
}

function toCapabilityDecision(
  key: CapabilityKey,
  definition: CapabilityDefinition,
  engine: EngineFamily,
  permission: CapabilityPermission,
  staticCapability: StaticCapability
): CapabilityDecision {
  const endpointVariants =
    key === 'asyncSearch' && engine === 'opensearch'
      ? ['/_plugins/_asynchronous_search']
      : [...definition.endpoints]

  if (!staticCapability.supported) {
    return {
      key,
      access: definition.access,
      supported: false,
      writeSupported: false,
      permission,
      reasonKind: staticCapability.reasonKind,
      reason: staticCapability.reason,
      endpointVariants
    }
  }

  if (permission === 'denied') {
    return {
      key,
      access: definition.access,
      supported: false,
      writeSupported: false,
      permission,
      reasonKind: 'permission-denied',
      reason: `${key} 的产品能力已匹配，但当前连接权限不足`,
      endpointVariants
    }
  }

  const keepsStaticReason = staticCapability.reasonKind !== 'supported'
  return {
    key,
    access: definition.access,
    supported: true,
    writeSupported: staticCapability.writeSupported,
    permission,
    reasonKind: keepsStaticReason
      ? staticCapability.reasonKind
      : permission === 'granted'
        ? 'supported'
        : 'permission-unknown',
    reason: keepsStaticReason
      ? staticCapability.reason
      : permission === 'granted'
        ? `${staticCapability.reason}，且权限已确认`
        : `${staticCapability.reason}，当前权限尚未探测`,
    endpointVariants
  }
}

function formatEngine(engine: Exclude<EngineFamily, 'unknown'>): string {
  return engine === 'elasticsearch' ? 'Elasticsearch' : 'OpenSearch'
}
