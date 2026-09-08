export const REDACTED_VALUE = '[REDACTED]'

export type RedactionResult<T> = {
  value: T
  redacted: boolean
}

export type LogHeaders = Readonly<Record<string, string | readonly string[] | undefined>>

const SENSITIVE_KEYS = new Set([
  'authorization',
  'proxyauthorization',
  'cookie',
  'setcookie',
  'password',
  'passwd',
  'pwd',
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'apikey',
  'xapikey',
  'secret',
  'clientsecret',
  'privatekey',
  'sshprivatekey',
  'credential',
  'credentials',
  'session',
  'sessionid',
  'jsessionid'
])

const SENSITIVE_KEY_PATTERN = [
  'authorization',
  'proxy[-_]?authorization',
  'password',
  'passwd',
  'pwd',
  'token',
  'access[-_]?token',
  'refresh[-_]?token',
  'id[-_]?token',
  'api[-_]?key',
  'x[-_]?api[-_]?key',
  'secret',
  'client[-_]?secret',
  'private[-_]?key',
  'ssh[-_]?private[-_]?key',
  'credentials?',
  'cookies?',
  'set[-_]?cookie',
  'sessions?',
  'session[-_]?id',
  'jsessionid',
  '[a-z\\d_-]*(?:token|password|secret|api[-_]?key|private[-_]?key)'
].join('|')

const KEY_VALUE_PATTERN = new RegExp(
  `(["']?)(${SENSITIVE_KEY_PATTERN})\\1(\\s*[:=]\\s*)(?:"[^"]*"|'[^']*'|[^\\s,;&}]+)`,
  'giu'
)
const SENSITIVE_PATH_PATTERN = new RegExp(
  `/(?:${SENSITIVE_KEY_PATTERN})/[^/?#]+`,
  'giu'
)
const PRIVATE_KEY_PATTERN = /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/giu
const AUTH_SCHEME_PATTERN = /\b(Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/giu
const JWT_PATTERN = /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu
const AWS_ACCESS_KEY_PATTERN = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu
const URL_PATTERN = /https?:\/\/[^\s"'<>]+/giu

export function redactHeaders(headers: LogHeaders): RedactionResult<Record<string, string | string[]>> {
  const value: Record<string, string | string[]> = {}
  let redacted = false

  for (const [name, headerValue] of Object.entries(headers)) {
    if (headerValue === undefined) continue
    if (isSensitiveKey(name)) {
      value[name] = REDACTED_VALUE
      redacted = true
      continue
    }
    if (Array.isArray(headerValue)) {
      const values = headerValue.map((item) => redactText(item))
      value[name] = values.map((item) => item.value)
      if (values.some((item) => item.redacted)) redacted = true
      continue
    }
    const result = redactText(headerValue as string)
    value[name] = result.value
    if (result.redacted) redacted = true
  }

  return { value, redacted }
}

export function redactUrl(input: string): RedactionResult<string> {
  return redactUrlValue(input)
}

export function redactJson<T>(input: T): RedactionResult<unknown> {
  return redactJsonValue(input, new WeakSet<object>())
}

export function redactError(error: unknown): RedactionResult<string> {
  if (error instanceof Error) {
    return redactText(error.stack || `${error.name}: ${error.message}`)
  }
  if (typeof error === 'string') return redactText(error)

  const jsonResult = redactJson(error)
  let serialized: string
  try {
    serialized = JSON.stringify(jsonResult.value)
  } catch {
    serialized = String(jsonResult.value)
  }
  const textResult = redactText(serialized)
  return {
    value: textResult.value,
    redacted: jsonResult.redacted || textResult.redacted
  }
}

export function redactText(input: string): RedactionResult<string> {
  const scalarResult = redactScalarText(input)
  let redacted = scalarResult.redacted
  const value = scalarResult.value.replace(URL_PATTERN, (url) => {
    const result = redactUrlValue(url)
    if (result.redacted) redacted = true
    return result.value
  })
  return { value, redacted }
}

function redactUrlValue(input: string): RedactionResult<string> {
  try {
    const absoluteUrl = /^[a-z][a-z\d+.-]*:\/\//iu.test(input)
    const protocolRelativeUrl = input.startsWith('//')
    const parsed = new URL(input, 'http://redaction.invalid')
    let redacted = false

    if (parsed.username || parsed.password) {
      parsed.username = REDACTED_VALUE
      parsed.password = REDACTED_VALUE
      redacted = true
    }

    const redactedPath = parsed.pathname.replace(SENSITIVE_PATH_PATTERN, (match) => {
      redacted = true
      return `${match.slice(0, match.lastIndexOf('/') + 1)}${REDACTED_VALUE}`
    })
    parsed.pathname = redactedPath

    for (const [name, queryValue] of [...parsed.searchParams.entries()]) {
      if (isSensitiveKey(name)) {
        parsed.searchParams.set(name, REDACTED_VALUE)
        redacted = true
        continue
      }
      const result = redactScalarText(queryValue)
      if (result.redacted) {
        parsed.searchParams.set(name, result.value)
        redacted = true
      }
    }

    if (parsed.hash) {
      const result = redactScalarText(parsed.hash)
      parsed.hash = result.value
      if (result.redacted) redacted = true
    }

    let value: string
    if (absoluteUrl) {
      value = parsed.toString()
    } else if (protocolRelativeUrl) {
      value = `//${parsed.host}${parsed.pathname}${parsed.search}${parsed.hash}`
    } else {
      value = `${parsed.pathname}${parsed.search}${parsed.hash}`
    }
    return {
      value: value.replaceAll('%5BREDACTED%5D', REDACTED_VALUE),
      redacted
    }
  } catch {
    return redactScalarText(input)
  }
}

function redactJsonValue(input: unknown, ancestors: WeakSet<object>): RedactionResult<unknown> {
  if (typeof input === 'string') return redactText(input)
  if (input === null || typeof input === 'number' || typeof input === 'boolean' || input === undefined) {
    return { value: input, redacted: false }
  }
  if (typeof input === 'bigint') return { value: input.toString(), redacted: false }
  if (typeof input !== 'object') return { value: String(input), redacted: false }
  if (input instanceof Date) return { value: input.toISOString(), redacted: false }
  if (input instanceof Error) return redactError(input)
  if (ancestors.has(input)) return { value: '[Circular]', redacted: true }

  ancestors.add(input)
  let redacted = false
  if (Array.isArray(input)) {
    const value = input.map((item) => {
      const result = redactJsonValue(item, ancestors)
      if (result.redacted) redacted = true
      return result.value
    })
    ancestors.delete(input)
    return { value, redacted }
  }

  const value: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(input)) {
    if (isSensitiveKey(key)) {
      value[key] = REDACTED_VALUE
      redacted = true
      continue
    }
    const result = redactJsonValue(item, ancestors)
    value[key] = result.value
    if (result.redacted) redacted = true
  }
  ancestors.delete(input)
  return { value, redacted }
}

function redactScalarText(input: string): RedactionResult<string> {
  let redacted = false
  let value = input

  value = replaceSensitive(value, PRIVATE_KEY_PATTERN, () => {
    redacted = true
    return REDACTED_VALUE
  })
  value = replaceSensitive(value, AUTH_SCHEME_PATTERN, (match, scheme: string) => {
    redacted = true
    return `${scheme} ${REDACTED_VALUE}`
  })
  value = replaceSensitive(value, JWT_PATTERN, () => {
    redacted = true
    return REDACTED_VALUE
  })
  value = replaceSensitive(value, AWS_ACCESS_KEY_PATTERN, () => {
    redacted = true
    return REDACTED_VALUE
  })
  value = value.replace(KEY_VALUE_PATTERN, (_match, quote: string, key: string, separator: string) => {
    redacted = true
    return `${quote}${key}${quote}${separator}${REDACTED_VALUE}`
  })

  return { value, redacted }
}

function replaceSensitive(
  value: string,
  pattern: RegExp,
  replacement: (...matches: string[]) => string
): string {
  return value.replace(pattern, (...matches: unknown[]) => {
    return replacement(...matches.slice(0, -2).map(String))
  })
}

function isSensitiveKey(key: string): boolean {
  const normalizedKey = key.toLowerCase().replace(/[^a-z\d]/gu, '')
  return SENSITIVE_KEYS.has(normalizedKey) ||
    normalizedKey.endsWith('token') ||
    normalizedKey.endsWith('password') ||
    normalizedKey.endsWith('secret') ||
    normalizedKey.endsWith('apikey') ||
    normalizedKey.endsWith('privatekey')
}
