import type { CapabilityKey } from './types/capability'

export function isCapabilityUnsupportedByProductVersion(
  key: CapabilityKey,
  engineInput: string | null,
  versionInput: string | null
): boolean {
  const engine = engineInput?.trim().toLowerCase() ?? ''
  if (!engine.includes('elasticsearch')) return false

  const version = /^(\d+)\.(\d+)/u.exec(versionInput?.trim() ?? '')
  if (!version || Number(version[1]) !== 7) return false

  const minor = Number(version[2])
  if (key === 'componentTemplates') return minor < 8
  if (key === 'dataStreams') return minor < 9
  if (key === 'asyncSearch') return minor < 7
  return false
}
