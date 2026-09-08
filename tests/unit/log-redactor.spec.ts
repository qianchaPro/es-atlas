import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  REDACTED_VALUE,
  redactError,
  redactHeaders,
  redactJson,
  redactText,
  redactUrl
} from '../../electron/main/log/log-redactor.ts'

describe('log redactor', () => {
  it('redacts sensitive headers without modifying the input', () => {
    const headers = {
      Authorization: 'Bearer header-secret',
      'X-Api-Key': 'api-secret',
      Accept: 'application/json',
      'X-Metadata': 'token=metadata-secret'
    }

    const result = redactHeaders(headers)

    assert.deepEqual(result.value, {
      Authorization: REDACTED_VALUE,
      'X-Api-Key': REDACTED_VALUE,
      Accept: 'application/json',
      'X-Metadata': `token=${REDACTED_VALUE}`
    })
    assert.equal(result.redacted, true)
    assert.equal(headers.Authorization, 'Bearer header-secret')
  })

  it('redacts URL credentials and sensitive query parameters', () => {
    const result = redactUrl(
      'https://elastic:plain-password@example.com/index/_search?pretty=true&token=query-secret&ApiKey=second-secret#fragment'
    )

    assert.equal(result.redacted, true)
    assert.doesNotMatch(result.value, /plain-password|query-secret|second-secret/u)
    assert.match(result.value, /pretty=true/u)
    assert.match(result.value, /REDACTED/u)
  })

  it('deeply redacts sensitive JSON fields and preserves the source object', () => {
    const source = {
      user: 'reader',
      password: 'plain-password',
      nested: {
        access_token: 'access-secret',
        authToken: 'auth-secret',
        enabled: true,
        entries: [{ apiKey: 'api-secret' }]
      }
    }

    const result = redactJson(source)

    assert.deepEqual(result.value, {
      user: 'reader',
      password: REDACTED_VALUE,
      nested: {
        access_token: REDACTED_VALUE,
        authToken: REDACTED_VALUE,
        enabled: true,
        entries: [{ apiKey: REDACTED_VALUE }]
      }
    })
    assert.equal(result.redacted, true)
    assert.equal(source.password, 'plain-password')
    assert.equal(source.nested.entries[0]?.apiKey, 'api-secret')
  })

  it('redacts credentials from messages and error stacks', () => {
    const message = 'request failed: Authorization: Bearer message-secret, password=plain-password'
    const error = new Error('token=error-secret')
    error.stack = `Error: token=error-secret\n    at https://host.test/path?api_key=stack-secret`

    const messageResult = redactText(message)
    const errorResult = redactError(error)

    assert.equal(messageResult.redacted, true)
    assert.doesNotMatch(messageResult.value, /message-secret|plain-password/u)
    assert.equal(errorResult.redacted, true)
    assert.doesNotMatch(errorResult.value, /error-secret|stack-secret/u)
  })

  it('redacts JWTs, AWS access keys and private key blocks', () => {
    const result = redactText([
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature-value',
      'AKIA1234567890ABCDEF',
      '-----BEGIN PRIVATE KEY----- secret -----END PRIVATE KEY-----'
    ].join(' '))

    assert.equal(result.redacted, true)
    assert.doesNotMatch(result.value, /eyJhbGci|AKIA123|BEGIN PRIVATE KEY/u)
  })
})
