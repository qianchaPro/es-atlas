import { defaultProvider } from '@aws-sdk/credential-provider-node'
import { Hash } from '@smithy/hash-node'
import { SignatureV4 } from '@smithy/signature-v4'
import type { AwsCredentialIdentity, HttpRequest, QueryParameterBag } from '@smithy/types'

export type AwsSigningSettings = {
  region: string
  service: 'es' | 'aoss'
  credentialSource: 'default' | 'static'
  profile: string
  accessKeyId: string
  secretAccessKey: string
  sessionToken: string
}

export type AwsSignRequestInput = {
  method: string
  requestUrl: URL
  headers: Record<string, string>
  body?: string
  settings: AwsSigningSettings
}

export class AwsSigningError extends Error {
  constructor(reason: string, options?: ErrorOptions) {
    super(`AWS SigV4 签名失败：${reason}`, options)
    this.name = 'AwsSigningError'
  }
}

export async function signAwsRequest(input: AwsSignRequestInput): Promise<Record<string, string>> {
  try {
    const credentials = createCredentialProvider(input.settings)
    const signer = new SignatureV4({
      credentials,
      region: input.settings.region,
      service: input.settings.service,
      sha256: Hash.bind(null, 'sha256')
    })
    const request: HttpRequest = {
      method: input.method,
      protocol: input.requestUrl.protocol,
      hostname: input.requestUrl.hostname,
      port: readPort(input.requestUrl),
      path: input.requestUrl.pathname,
      query: toQuery(input.requestUrl.searchParams),
      headers: {
        ...input.headers,
        host: input.requestUrl.host
      },
      body: input.body
    }
    const signedRequest = await signer.sign(request)
    return { ...signedRequest.headers }
  } catch (error: unknown) {
    if (error instanceof AwsSigningError) throw error
    throw new AwsSigningError(getErrorMessage(error), { cause: error })
  }
}

function createCredentialProvider(
  settings: AwsSigningSettings
): AwsCredentialIdentity | (() => Promise<AwsCredentialIdentity>) {
  if (settings.credentialSource === 'static') {
    return {
      accessKeyId: settings.accessKeyId,
      secretAccessKey: settings.secretAccessKey,
      ...(settings.sessionToken ? { sessionToken: settings.sessionToken } : {})
    }
  }
  return defaultProvider(settings.profile ? { profile: settings.profile } : {})
}

function toQuery(searchParams: URLSearchParams): QueryParameterBag {
  const query: QueryParameterBag = {}
  for (const [name, value] of searchParams.entries()) {
    const existing = query[name]
    if (existing === undefined) query[name] = value
    else if (Array.isArray(existing)) existing.push(value)
    else query[name] = [existing ?? '', value]
  }
  return query
}

function readPort(url: URL): number | undefined {
  if (url.port) return Number(url.port)
  return undefined
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
