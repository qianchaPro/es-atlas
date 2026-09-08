import { contextBridge, ipcRenderer } from 'electron'
import type { ClusterApi } from '../../src/shared/types/cluster'
import type {
  ConnectionGroupsApi,
  ConnectionsApi,
  CreateConnectionGroupInput,
  ConnectionTestInput,
  CreateConnectionInput,
  MoveConnectionsInput,
  UpdateConnectionGroupInput,
  UpdateConnectionInput
} from '../../src/shared/types/connection'
import type {
  IndexApi,
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
  IndexUpdateDocumentInput
} from '../../src/shared/types/index'
import type { TrashApi, TrashListInput } from '../../src/shared/types/trash'
import type { SavePreferencesInput, SettingsApi } from '../../src/shared/types/settings'
import type { RequestHistoryApi, RequestHistoryQuery } from '../../src/shared/types/request-history'
import type { RestApi, RestCancelInput, RestExecuteInput } from '../../src/shared/types/rest'
import type { LogApi, LogExportFormat, LogFilter, LogQueryInput, LogRetentionPolicy } from '../../src/shared/types/log'
import type { ClusterResourceApi, ClusterResourceDetailInput, ClusterResourceListInput, ClusterResourceOperationRequest } from '../../src/shared/types/cluster-resource'
import type {
  AsyncSearchDeleteInput,
  AsyncSearchGetInput,
  AsyncSearchSubmitInput,
  ClusterOperationApi,
  ReindexSubmitInput
} from '../../src/shared/types/cluster-operation'
import type {
  DesktopConfigurationRequest,
  DiagnosticsApi,
  LocalDiagnosticRequest,
  UpdateCheckRequest
} from '../../src/shared/types/diagnostics'

const connections: ConnectionsApi = {
  list: () => ipcRenderer.invoke('connections:list'),
  get: (connectionId: string) => ipcRenderer.invoke('connections:get', connectionId),
  create: (input: CreateConnectionInput) => ipcRenderer.invoke('connections:create', input),
  update: (input: UpdateConnectionInput) => ipcRenderer.invoke('connections:update', input),
  delete: (connectionId: string) => ipcRenderer.invoke('connections:delete', connectionId),
  test: (input: ConnectionTestInput) => ipcRenderer.invoke('connections:test', input),
  connect: (connectionId: string) => ipcRenderer.invoke('connections:connect', connectionId),
  disconnect: (connectionId: string) => ipcRenderer.invoke('connections:disconnect', connectionId)
}

const cluster: ClusterApi = {
  getOverview: (connectionId: string) => ipcRenderer.invoke('cluster:get-overview', connectionId)
}

const requestHistory: RequestHistoryApi = {
  list: (query: RequestHistoryQuery) => ipcRenderer.invoke('request-history:list', query)
}

const connectionGroups: ConnectionGroupsApi = {
  list: () => ipcRenderer.invoke('connection-groups:list'),
  create: (input: CreateConnectionGroupInput) => ipcRenderer.invoke('connection-groups:create', input),
  update: (input: UpdateConnectionGroupInput) => ipcRenderer.invoke('connection-groups:update', input),
  delete: (groupId: string) => ipcRenderer.invoke('connection-groups:delete', groupId),
  moveConnections: (input: MoveConnectionsInput) =>
    ipcRenderer.invoke('connection-groups:move-connections', input)
}

const settings: SettingsApi = {
  get: () => ipcRenderer.invoke('settings:get'),
  getDiagnostic: () => ipcRenderer.invoke('settings:get-diagnostic'),
  save: (input: SavePreferencesInput) => ipcRenderer.invoke('settings:save', input),
  reset: () => ipcRenderer.invoke('settings:reset')
}

const indices: IndexApi = {
  listIndices: (connectionId: string) => ipcRenderer.invoke('indices:list', connectionId),
  createIndex: (input: IndexCreateInput) => ipcRenderer.invoke('indices:create-index', input),
  deleteIndex: (input: IndexDeleteInput) => ipcRenderer.invoke('indices:delete-index', input),
  getMetadata: (input: IndexMetadataInput) => ipcRenderer.invoke('indices:get-metadata', input),
  getDocuments: (input: IndexDocumentsInput) => ipcRenderer.invoke('indices:get-documents', input),
  createDocument: (input: IndexCreateDocumentInput) =>
    ipcRenderer.invoke('indices:create-document', input),
  updateDocument: (input: IndexUpdateDocumentInput) =>
    ipcRenderer.invoke('indices:update-document', input),
  deleteDocument: (input: IndexDeleteDocumentInput) =>
    ipcRenderer.invoke('indices:delete-document', input),
  bulkImport: (input: IndexBulkImportInput) => ipcRenderer.invoke('indices:bulk-import', input),
  commitDocumentChanges: (input: IndexCommitDocumentChangesInput) =>
    ipcRenderer.invoke('indices:commit-document-changes', input),
  exportDocuments: (input: IndexExportDocumentsInput) =>
    ipcRenderer.invoke('indices:export-documents', input),
  saveExportFile: (input: IndexSaveExportFileInput) =>
    ipcRenderer.invoke('indices:save-export-file', input)
}

const trash: TrashApi = {
  list: (input?: TrashListInput) => ipcRenderer.invoke('trash:list', input ?? {}),
  restore: (id: string) => ipcRenderer.invoke('trash:restore', id),
  remove: (id: string) => ipcRenderer.invoke('trash:remove', id)
}

const rest: RestApi = {
  execute: (input: RestExecuteInput) => ipcRenderer.invoke('rest:execute', input),
  cancel: (input: RestCancelInput) => ipcRenderer.invoke('rest:cancel', input)
}

const logs: LogApi = {
  query: (input: LogQueryInput) => ipcRenderer.invoke('logs:query', input),
  clear: (filter: LogFilter) => ipcRenderer.invoke('logs:clear', filter),
  export: (filter: LogFilter, format: LogExportFormat) => ipcRenderer.invoke('logs:export', filter, format),
  updateRetention: (policy: LogRetentionPolicy) => ipcRenderer.invoke('logs:update-retention', policy)
}

const clusterResources: ClusterResourceApi = {
  list: (input: ClusterResourceListInput) => ipcRenderer.invoke('cluster-resources:list', input),
  getDetail: (input: ClusterResourceDetailInput) => ipcRenderer.invoke('cluster-resources:get-detail', input),
  executeOperation: (input: ClusterResourceOperationRequest) => ipcRenderer.invoke('cluster-resources:execute-operation', input)
}

const operations: ClusterOperationApi = {
  getCapabilities: (connectionId: string) =>
    ipcRenderer.invoke('operations:get-capabilities', connectionId),
  submitReindex: (input: ReindexSubmitInput) =>
    ipcRenderer.invoke('operations:submit-reindex', input),
  submitAsyncSearch: (input: AsyncSearchSubmitInput) =>
    ipcRenderer.invoke('operations:submit-async-search', input),
  getAsyncSearch: (input: AsyncSearchGetInput) =>
    ipcRenderer.invoke('operations:get-async-search', input),
  deleteAsyncSearch: (input: AsyncSearchDeleteInput) =>
    ipcRenderer.invoke('operations:delete-async-search', input)
}

const diagnostics: DiagnosticsApi = {
  createLocalSummary: (input: LocalDiagnosticRequest) =>
    ipcRenderer.invoke('diagnostics:create-local-summary', input),
  checkForUpdates: (input: UpdateCheckRequest) => ipcRenderer.invoke('updates:check', input),
  loadDesktopConfiguration: (input: DesktopConfigurationRequest) =>
    ipcRenderer.invoke('atlas-admin:get-desktop-configuration', input)
}

contextBridge.exposeInMainWorld('electronAPI', {
  getAppInfo: () => ipcRenderer.invoke('app:get-info'),
  openGitHubIssues: () => ipcRenderer.invoke('app:open-github-issues'),
  openExternal: (externalUrl: string) => ipcRenderer.invoke('app:open-external', externalUrl),
  connections,
  connectionGroups,
  cluster,
  requestHistory,
  settings,
  indices,
  trash,
  rest,
  logs,
  clusterResources,
  operations,
  diagnostics
})
