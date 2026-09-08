export function formatCellEditorValue(value: unknown): string {
  if (value === null) return ''
  if (typeof value === 'object') return JSON.stringify(value)
  return value === undefined ? '' : String(value)
}

export function toIpcDocumentSource(
  source: Record<string, unknown>
): Record<string, unknown> {
  try {
    return JSON.parse(JSON.stringify(source)) as Record<string, unknown>
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new TypeError(`索引文档 IPC 转换失败：_source 不是有效 JSON，原因=${reason}`)
  }
}
