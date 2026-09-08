const NON_RESTORABLE_INDEX_SETTINGS = new Set([
  'index.creation_date',
  'index.uuid',
  'index.version.created',
  'index.version.upgraded',
  'index.provided_name'
])

export function sanitizeRestorableIndexSettings(
  settings: Record<string, unknown>
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(settings).filter(([key]) => !NON_RESTORABLE_INDEX_SETTINGS.has(key))
  )
}
