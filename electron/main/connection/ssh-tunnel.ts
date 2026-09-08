import { readFile } from 'node:fs/promises'
import type { Duplex } from 'node:stream'
import { Client, type ConnectConfig } from 'ssh2'

export type SshTunnelSettings = {
  host: string
  port: number
  username: string
  authorizationType: 'password' | 'private-key' | 'agent'
  password: string
  privateKeyPath: string
  passphrase: string
  agentSocket: string
  hostFingerprint: string
}

const SSH_READY_TIMEOUT_MS = 10_000

export class SshTunnelError extends Error {
  constructor(
    readonly code: string,
    operation: string,
    reason: string,
    options?: ErrorOptions
  ) {
    super(`SSH 隧道失败：操作=${operation}，原因=${reason}`, options)
    this.name = 'SshTunnelError'
  }
}

export class SshTunnel {
  private closed = false
  private failure: Error | null = null

  private constructor(private readonly client: Client) {
    client.on('error', (error: Error) => {
      this.failure = error
    })
    client.on('close', () => {
      this.closed = true
    })
  }

  static async connect(settings: SshTunnelSettings): Promise<SshTunnel> {
    const connectConfig = await createConnectConfig(settings)
    const client = new Client()

    await new Promise<void>((resolve, reject) => {
      let fingerprintMismatch = false
      if (settings.hostFingerprint) {
        connectConfig.hostHash = 'sha256'
        connectConfig.hostVerifier = (fingerprint: string): boolean => {
          fingerprintMismatch = fingerprint.toLowerCase() !== settings.hostFingerprint
          return !fingerprintMismatch
        }
      }

      const handleReady = (): void => {
        cleanup()
        resolve()
      }
      const handleError = (error: Error): void => {
        cleanup()
        client.end()
        reject(
          new SshTunnelError(
            fingerprintMismatch ? 'SSH_HOST_FINGERPRINT_MISMATCH' : 'SSH_CONNECTION_FAILED',
            '建立 SSH 连接',
            fingerprintMismatch ? '服务端 SHA256 指纹与配置不一致' : error.message,
            { cause: error }
          )
        )
      }
      const handleClose = (): void => {
        cleanup()
        reject(
          new SshTunnelError(
            'SSH_CONNECTION_CLOSED',
            '建立 SSH 连接',
            '连接在认证完成前已关闭'
          )
        )
      }
      const cleanup = (): void => {
        client.off('ready', handleReady)
        client.off('error', handleError)
        client.off('close', handleClose)
      }

      client.once('ready', handleReady)
      client.once('error', handleError)
      client.once('close', handleClose)
      client.connect(connectConfig)
    })

    return new SshTunnel(client)
  }

  openStream(destinationHost: string, destinationPort: number): Promise<Duplex> {
    if (this.closed || this.failure) {
      throw new SshTunnelError(
        'SSH_TUNNEL_UNAVAILABLE',
        '打开转发通道',
        this.failure?.message ?? 'SSH 连接已关闭'
      )
    }

    return new Promise((resolve, reject) => {
      this.client.forwardOut('127.0.0.1', 0, destinationHost, destinationPort, (error, stream) => {
        if (error) {
          reject(
            new SshTunnelError(
              'SSH_FORWARD_FAILED',
              '打开转发通道',
              `target=${destinationHost}:${destinationPort}，${error.message}`,
              { cause: error }
            )
          )
          return
        }
        resolve(stream)
      })
    })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.client.end()
  }
}

async function createConnectConfig(settings: SshTunnelSettings): Promise<ConnectConfig> {
  const config: ConnectConfig = {
    host: settings.host,
    port: settings.port,
    username: settings.username,
    readyTimeout: SSH_READY_TIMEOUT_MS,
    keepaliveInterval: 10_000,
    keepaliveCountMax: 3
  }

  if (settings.authorizationType === 'password') {
    config.password = settings.password
    return config
  }
  if (settings.authorizationType === 'agent') {
    config.agent = settings.agentSocket
    return config
  }

  try {
    config.privateKey = await readFile(settings.privateKeyPath)
    if (settings.passphrase) config.passphrase = settings.passphrase
    return config
  } catch (error: unknown) {
    throw new SshTunnelError(
      'SSH_PRIVATE_KEY_READ_FAILED',
      '读取 SSH 私钥',
      `path=${settings.privateKeyPath}，${getErrorMessage(error)}`,
      { cause: error }
    )
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
