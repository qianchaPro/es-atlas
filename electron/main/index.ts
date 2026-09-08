import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import { writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import { gzip as gzipCallback } from 'node:zlib'
import { pathToFileURL } from 'node:url'
import type {
  CreateConnectionGroupInput,
  ConnectionTestInput,
  CreateConnectionInput,
  MoveConnectionsInput,
  UpdateConnectionGroupInput,
  UpdateConnectionInput
} from '../../src/shared/types/connection'
import type {
  IndexBulkImportInput,
  IndexCommitDocumentChangesInput,
  IndexCreateInput,
  IndexCreateDocumentInput,
  IndexDeleteDocumentInput,
  IndexDeleteInput,
  IndexDocumentsInput,
  IndexExportDocumentsInput,
  IndexMetadataInput,
  IndexSaveExportFileInput,
  IndexSaveExportFileResult,
  IndexUpdateDocumentInput
} from '../../src/shared/types/index'
import { DEFAULT_GLOBAL_PREFERENCES, type SavePreferencesInput } from '../../src/shared/types/settings'
import type { RequestHistoryQuery } from '../../src/shared/types/request-history'
import type { TrashListInput } from '../../src/shared/types/trash'
import type { RestCancelInput, RestExecuteInput } from '../../src/shared/types/rest'
import type { LogExportFormat, LogFilter, LogQueryInput, LogRetentionPolicy } from '../../src/shared/types/log'
import type { ClusterResourceDetailInput, ClusterResourceListInput, ClusterResourceOperationRequest } from '../../src/shared/types/cluster-resource'
import type {
  AsyncSearchDeleteInput,
  AsyncSearchGetInput,
  AsyncSearchSubmitInput,
  ReindexSubmitInput
} from '../../src/shared/types/cluster-operation'
import type {
  DesktopConfigurationRequest,
  LocalDiagnosticRequest,
  UpdateCheckRequest
} from '../../src/shared/types/diagnostics'
import { DiagnosticsService } from './app/diagnostics-service'
import { ConnectionService } from './connection/connection-service'
import { ClusterService } from './es/cluster-service'
import { IndexService } from './es/index-service'
import { RestExecutor } from './es/rest-executor'
import { RequestHistoryService } from './request-history/request-history-service'
import { SettingsService } from './settings/settings-service'
import { LogStore } from './log/log-store'
import { createRequestLogObserver } from './log/request-log-observer'
import { ClusterResourceService } from './es/cluster-resource-service'
import { OperationService } from './es/operation-service'
import { TrashService } from './trash/trash-service'

let mainWindow: BrowserWindow | null = null
let connectionService: ConnectionService | null = null
let activeRequestHistoryService: RequestHistoryService | null = null
let activeLogStore: LogStore | null = null
let activeTrashService: TrashService | null = null
const gzip = promisify(gzipCallback)
const MAX_EXPORT_FILE_CONTENT_BYTES = 50 * 1024 * 1024
const GITHUB_ISSUES_URL = 'https://github.com/qianchaPro/es-atlas/issues'

function createWindow(): void {
  mainWindow = new BrowserWindow({
    minWidth: 1180,
    minHeight: 720,
    width: 1440,
    height: 900,
    resizable: true,
    backgroundColor: '#f7f8fa',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event, navigationUrl) => {
    if (!isTrustedRendererUrl(navigationUrl)) event.preventDefault()
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  const requestHistoryService = new RequestHistoryService(
    join(app.getPath('userData'), 'request-history.sqlite')
  )
  await requestHistoryService.initialize()
  activeRequestHistoryService = requestHistoryService
  const logStore = new LogStore(join(app.getPath('userData'), 'app-logs.sqlite'))
  await logStore.initialize()
  activeLogStore = logStore
  const trashService = new TrashService(join(app.getPath('userData'), 'trash.sqlite'))
  await trashService.initialize()
  activeTrashService = trashService
  const activeConnectionService = new ConnectionService(
    join(app.getPath('userData'), 'connections.json'),
    requestHistoryService,
    createRequestLogObserver(logStore)
  )
  connectionService = activeConnectionService
  await activeConnectionService.initialize()
  const clusterService = new ClusterService(activeConnectionService, requestHistoryService)
  const indexService = new IndexService(activeConnectionService, trashService)
  const restExecutor = new RestExecutor(activeConnectionService)
  const clusterResourceService = new ClusterResourceService(activeConnectionService)
  const operationService = new OperationService(activeConnectionService)
  const settingsService = new SettingsService(join(app.getPath('userData'), 'preferences.json'))
  await settingsService.initialize()
  const diagnosticsService = new DiagnosticsService()

  ipcMain.handle('app:get-info', (event) => {
    assertTrustedIpcSender(event)
    return {
      name: 'ES Atlas',
      version: app.getVersion(),
      platform: process.platform
    }
  })
  ipcMain.handle('app:open-github-issues', async (event) => {
    assertTrustedIpcSender(event)
    await shell.openExternal(GITHUB_ISSUES_URL)
  })
  ipcMain.handle('app:open-external', async (event, externalUrl: string) => {
    assertTrustedIpcSender(event)
    const url = validateExternalUrl(externalUrl)
    await shell.openExternal(url)
  })
  ipcMain.handle('connections:list', (event) => {
    assertTrustedIpcSender(event)
    return activeConnectionService.list()
  })
  ipcMain.handle('connections:get', (event, connectionId: string) => {
    assertTrustedIpcSender(event)
    return activeConnectionService.get(connectionId)
  })
  ipcMain.handle('connections:create', (event, input: CreateConnectionInput) => {
    assertTrustedIpcSender(event)
    return activeConnectionService.create(input)
  })
  ipcMain.handle('connections:update', (event, input: UpdateConnectionInput) => {
    assertTrustedIpcSender(event)
    return activeConnectionService.update(input)
  })
  ipcMain.handle('connections:delete', async (event, connectionId: string) => {
    assertTrustedIpcSender(event)
    await settingsService.deleteConnectionPreferences(connectionId)
    await activeConnectionService.delete(connectionId)
  })
  ipcMain.handle('connections:test', (event, input: ConnectionTestInput) => {
    assertTrustedIpcSender(event)
    return activeConnectionService.test(input)
  })
  ipcMain.handle('connections:connect', (event, connectionId: string) => {
    assertTrustedIpcSender(event)
    return activeConnectionService.connect(connectionId)
  })
  ipcMain.handle('connections:disconnect', (event, connectionId: string) => {
    assertTrustedIpcSender(event)
    return activeConnectionService.disconnect(connectionId)
  })
  ipcMain.handle('cluster:get-overview', (event, connectionId: string) => {
    assertTrustedIpcSender(event)
    return clusterService.getOverview(connectionId)
  })
  ipcMain.handle('request-history:list', (event, query: RequestHistoryQuery) => {
    assertTrustedIpcSender(event)
    return requestHistoryService.list(query)
  })
  ipcMain.handle('connection-groups:list', (event) => {
    assertTrustedIpcSender(event)
    return activeConnectionService.listGroups()
  })
  ipcMain.handle('connection-groups:create', (event, input: CreateConnectionGroupInput) => {
    assertTrustedIpcSender(event)
    return activeConnectionService.createGroup(input)
  })
  ipcMain.handle('connection-groups:update', (event, input: UpdateConnectionGroupInput) => {
    assertTrustedIpcSender(event)
    return activeConnectionService.updateGroup(input)
  })
  ipcMain.handle('connection-groups:delete', (event, groupId: string) => {
    assertTrustedIpcSender(event)
    return activeConnectionService.deleteGroup(groupId)
  })
  ipcMain.handle('connection-groups:move-connections', (event, input: MoveConnectionsInput) => {
    assertTrustedIpcSender(event)
    return activeConnectionService.moveConnections(input)
  })
  ipcMain.handle('settings:get', (event) => {
    assertTrustedIpcSender(event)
    return settingsService.get()
  })
  ipcMain.handle('settings:get-diagnostic', (event) => {
    assertTrustedIpcSender(event)
    return settingsService.getDiagnostic()
  })
  ipcMain.handle('settings:save', (event, input: SavePreferencesInput) => {
    assertTrustedIpcSender(event)
    return settingsService.save(input)
  })
  ipcMain.handle('settings:reset', (event) => {
    assertTrustedIpcSender(event)
    return settingsService.reset()
  })
  ipcMain.handle('diagnostics:create-local-summary', (event, input: LocalDiagnosticRequest) => {
    assertTrustedIpcSender(event)
    return diagnosticsService.createLocalSummary({
      applicationVersion: app.getVersion(),
      platform: `${process.platform}-${process.arch}`,
      error: { code: input?.errorCode },
      traceId: input?.traceId
    })
  })
  ipcMain.handle('updates:check', (event, input: UpdateCheckRequest) => {
    assertTrustedIpcSender(event)
    const preferences = settingsService.get().global
    return diagnosticsService.checkForUpdates({
      enabled: true,
      currentVersion: app.getVersion(),
      manifestUrl: input?.manifestUrl || preferences.updateManifestUrl,
      atlasAdminBaseUrl: input?.atlasAdminBaseUrl || preferences.atlasAdminBaseUrl || DEFAULT_GLOBAL_PREFERENCES.atlasAdminBaseUrl,
      platform: toAtlasAdminPlatform(process.platform),
      architecture: process.arch
    })
  })
  ipcMain.handle(
    'atlas-admin:get-desktop-configuration',
    (event, input: DesktopConfigurationRequest) => {
      assertTrustedIpcSender(event)
      return diagnosticsService.loadDesktopConfiguration({
        atlasAdminBaseUrl: input?.atlasAdminBaseUrl || settingsService.get().global.atlasAdminBaseUrl || DEFAULT_GLOBAL_PREFERENCES.atlasAdminBaseUrl
      })
    }
  )
  ipcMain.handle('indices:list', (event, connectionId: string) => {
    assertTrustedIpcSender(event)
    return indexService.listIndices(connectionId)
  })
  ipcMain.handle('indices:create-index', (event, input: IndexCreateInput) => {
    assertTrustedIpcSender(event)
    return indexService.createIndex(input)
  })
  ipcMain.handle('indices:delete-index', (event, input: IndexDeleteInput) => {
    assertTrustedIpcSender(event)
    return indexService.deleteIndex(input)
  })
  ipcMain.handle('indices:get-metadata', (event, input: IndexMetadataInput) => {
    assertTrustedIpcSender(event)
    return indexService.getMetadata(input)
  })
  ipcMain.handle('indices:get-documents', (event, input: IndexDocumentsInput) => {
    assertTrustedIpcSender(event)
    return indexService.getDocuments(input)
  })
  ipcMain.handle('indices:create-document', (event, input: IndexCreateDocumentInput) => {
    assertTrustedIpcSender(event)
    return indexService.createDocument(input)
  })
  ipcMain.handle('indices:update-document', (event, input: IndexUpdateDocumentInput) => {
    assertTrustedIpcSender(event)
    return indexService.updateDocument(input)
  })
  ipcMain.handle('indices:delete-document', (event, input: IndexDeleteDocumentInput) => {
    assertTrustedIpcSender(event)
    return indexService.deleteDocument(input)
  })
  ipcMain.handle('indices:bulk-import', (event, input: IndexBulkImportInput) => {
    assertTrustedIpcSender(event)
    return indexService.bulkImport(input)
  })
  ipcMain.handle(
    'indices:commit-document-changes',
    (event, input: IndexCommitDocumentChangesInput) => {
      assertTrustedIpcSender(event)
      return indexService.commitDocumentChanges(input)
    }
  )
  ipcMain.handle('indices:export-documents', (event, input: IndexExportDocumentsInput) => {
    assertTrustedIpcSender(event)
    return indexService.exportDocuments(input)
  })
  ipcMain.handle('indices:save-export-file', (event, input: IndexSaveExportFileInput) => {
    assertTrustedIpcSender(event)
    return saveExportFile(input)
  })
  ipcMain.handle('trash:list', (event, input: TrashListInput) => {
    assertTrustedIpcSender(event)
    return trashService.list(input)
  })
  ipcMain.handle('trash:restore', async (event, id: string) => {
    assertTrustedIpcSender(event)
    const record = trashService.get(id)
    await indexService.restoreTrashRecord(record)
    trashService.remove(id)
    return {
      id: record.id,
      kind: record.kind,
      index: record.index,
      documentId: record.documentId,
      message: record.kind === 'index' ? `索引“${record.index}”已恢复` : `文档“${record.documentId ?? ''}”已恢复`
    }
  })
  ipcMain.handle('trash:remove', (event, id: string) => {
    assertTrustedIpcSender(event)
    trashService.remove(id)
  })
  ipcMain.handle('rest:execute', (event, input: RestExecuteInput) => {
    assertTrustedIpcSender(event)
    return restExecutor.execute(input)
  })
  ipcMain.handle('rest:cancel', (event, input: RestCancelInput) => {
    assertTrustedIpcSender(event)
    return restExecutor.cancel(input)
  })
  ipcMain.handle('logs:query', (event, input: LogQueryInput) => {
    assertTrustedIpcSender(event)
    return logStore.query(input)
  })
  ipcMain.handle('logs:clear', (event, input: LogFilter) => {
    assertTrustedIpcSender(event)
    return logStore.clear(input)
  })
  ipcMain.handle('logs:export', (event, filter: LogFilter, format: LogExportFormat) => {
    assertTrustedIpcSender(event)
    return saveLogExport(logStore, filter, format)
  })
  ipcMain.handle('logs:update-retention', (event, policy: LogRetentionPolicy) => {
    assertTrustedIpcSender(event)
    return logStore.updateRetention(policy)
  })
  ipcMain.handle('cluster-resources:list', (event, input: ClusterResourceListInput) => {
    assertTrustedIpcSender(event)
    return clusterResourceService.list(input)
  })
  ipcMain.handle('cluster-resources:get-detail', (event, input: ClusterResourceDetailInput) => {
    assertTrustedIpcSender(event)
    return clusterResourceService.getDetail(input)
  })
  ipcMain.handle('cluster-resources:execute-operation', (event, input: ClusterResourceOperationRequest) => {
    assertTrustedIpcSender(event)
    return clusterResourceService.executeOperation(input)
  })
  ipcMain.handle('operations:get-capabilities', (event, connectionId: string) => {
    assertTrustedIpcSender(event)
    return operationService.getCapabilities(connectionId)
  })
  ipcMain.handle('operations:submit-reindex', (event, input: ReindexSubmitInput) => {
    assertTrustedIpcSender(event)
    return operationService.submitReindex(input)
  })
  ipcMain.handle('operations:submit-async-search', (event, input: AsyncSearchSubmitInput) => {
    assertTrustedIpcSender(event)
    return operationService.submitAsyncSearch(input)
  })
  ipcMain.handle('operations:get-async-search', (event, input: AsyncSearchGetInput) => {
    assertTrustedIpcSender(event)
    return operationService.getAsyncSearch(input)
  })
  ipcMain.handle('operations:delete-async-search', (event, input: AsyncSearchDeleteInput) => {
    assertTrustedIpcSender(event)
    return operationService.deleteAsyncSearch(input)
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
}).catch((error: unknown) => {
  const reason = error instanceof Error ? error.message : String(error)
  console.error(`ES Atlas 主进程初始化失败：${reason}`)
  app.quit()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  connectionService?.dispose()
  connectionService = null
  activeRequestHistoryService?.close()
  activeRequestHistoryService = null
  activeLogStore?.close()
  activeLogStore = null
  activeTrashService?.close()
  activeTrashService = null
})

function assertTrustedIpcSender(event: IpcMainInvokeEvent): void {
  const senderUrl = event.senderFrame?.url ?? ''
  if (!mainWindow || event.sender !== mainWindow.webContents || !isTrustedRendererUrl(senderUrl)) {
    throw new Error(`IPC 请求被拒绝：channel sender=${senderUrl || '未知'}`)
  }
}

function validateExternalUrl(value: unknown): string {
  if (typeof value !== 'string' || !value) {
    throw new Error('打开外部地址失败：URL 不能为空')
  }
  let url: URL
  try {
    url = new URL(value)
  } catch (error: unknown) {
    throw new Error(`打开外部地址失败：URL 格式非法，url=${value}`, { cause: error })
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error(`打开外部地址失败：仅允许无凭据的 HTTP(S) URL，url=${value}`)
  }
  return url.toString()
}

function toAtlasAdminPlatform(platform: NodeJS.Platform): string {
  if (platform === 'darwin') return 'macos'
  if (platform === 'win32') return 'windows'
  return 'linux'
}

async function saveLogExport(
  logStore: LogStore,
  filter: LogFilter,
  format: LogExportFormat
): Promise<{ canceled: boolean; filePath: string | null; recordCount: number }> {
  if (!mainWindow) throw new Error('导出日志失败：主窗口不可用')
  const exportData = logStore.exportData(filter, format)
  const result = await dialog.showSaveDialog(mainWindow, {
    title: '导出脱敏日志',
    defaultPath: exportData.fileName
  })
  if (result.canceled || !result.filePath) {
    return { canceled: true, filePath: null, recordCount: 0 }
  }
  await writeFile(result.filePath, exportData.content, 'utf8')
  return { canceled: false, filePath: result.filePath, recordCount: exportData.recordCount }
}

async function saveExportFile(input: IndexSaveExportFileInput): Promise<IndexSaveExportFileResult> {
  if (!mainWindow) throw new Error('导出文件失败：主窗口不可用')
  if (typeof input?.content !== 'string') throw new TypeError('导出文件失败：content 必须是字符串')
  const contentSize = Buffer.byteLength(input.content, 'utf8')
  if (contentSize > MAX_EXPORT_FILE_CONTENT_BYTES) {
    throw new RangeError(`导出文件失败：内容不能超过 50 MiB，当前字节数=${contentSize}`)
  }
  const suggestedName = normalizeExportFileName(input?.suggestedName, Boolean(input?.gzip))
  const result = await dialog.showSaveDialog(mainWindow, {
    title: '导出索引文档',
    defaultPath: suggestedName
  })
  if (result.canceled || !result.filePath) return { canceled: true, filePath: null }
  const content = input.gzip ? await gzip(Buffer.from(input.content, 'utf8')) : input.content
  await writeFile(result.filePath, content)
  return { canceled: false, filePath: result.filePath }
}

function normalizeExportFileName(value: unknown, gzipEnabled: boolean): string {
  const fileName = typeof value === 'string' ? basename(value.trim()) : ''
  if (!fileName || fileName === '.' || fileName === '..' || fileName.length > 255) {
    throw new TypeError('导出文件失败：suggestedName 必须是不超过 255 个字符的文件名')
  }
  return gzipEnabled && !fileName.toLowerCase().endsWith('.gz') ? `${fileName}.gz` : fileName
}

function isTrustedRendererUrl(rendererUrl: string): boolean {
  try {
    const parsedUrl = new URL(rendererUrl)
    if (process.env.ELECTRON_RENDERER_URL) {
      return parsedUrl.origin === new URL(process.env.ELECTRON_RENDERER_URL).origin
    }
    const rendererEntryUrl = pathToFileURL(join(__dirname, '../renderer/index.html'))
    return parsedUrl.protocol === 'file:' && parsedUrl.pathname === rendererEntryUrl.pathname
  } catch {
    return false
  }
}
