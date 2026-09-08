/// <reference types="vite/client" />

import type { ClusterApi } from '../../../shared/types/cluster'
import type { ConnectionGroupsApi, ConnectionsApi } from '../../../shared/types/connection'
import type { IndexApi } from '../../../shared/types/index'
import type { TrashApi } from '../../../shared/types/trash'
import type { SettingsApi } from '../../../shared/types/settings'
import type { RequestHistoryApi } from '../../../shared/types/request-history'
import type { RestApi } from '../../../shared/types/rest'
import type { LogApi } from '../../../shared/types/log'
import type { ClusterResourceApi } from '../../../shared/types/cluster-resource'
import type { ClusterOperationApi } from '../../../shared/types/cluster-operation'
import type { DiagnosticsApi } from '../../../shared/types/diagnostics'

type AppInfo = {
  name: string
  version: string
  platform: NodeJS.Platform
}

declare global {
  interface Window {
    electronAPI: {
      getAppInfo: () => Promise<AppInfo>
      openGitHubIssues: () => Promise<void>
      openExternal: (externalUrl: string) => Promise<void>
      connections: ConnectionsApi
      connectionGroups: ConnectionGroupsApi
      cluster: ClusterApi
      requestHistory: RequestHistoryApi
      settings: SettingsApi
      indices: IndexApi
      trash: TrashApi
      rest: RestApi
      logs: LogApi
      clusterResources: ClusterResourceApi
      operations: ClusterOperationApi
      diagnostics: DiagnosticsApi
    }
  }
}

export {}
