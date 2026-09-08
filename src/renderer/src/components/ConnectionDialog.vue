<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { DataLine, Delete, Plus } from '@element-plus/icons-vue'
import { ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import type {
  AuthorizationType,
  AwsCredentialSource,
  AwsService,
  ConnectionFormValue,
  ConnectionHeader,
  ConnectionProfile,
  ConnectionSummary,
  SshAuthorizationType
} from '../../../shared/types/connection'

const props = withDefaults(defineProps<{
  visible: boolean
  connection: ConnectionSummary | null
  profile: ConnectionProfile | null
  loading: boolean
  saving: boolean
  testing: boolean
  deleting: boolean
  error: string
  language?: string
}>(), {
  language: 'zh-CN'
})

const emit = defineEmits<{
  'update:visible': [visible: boolean]
  submit: [value: ConnectionFormValue]
  test: [value: ConnectionFormValue]
  delete: []
}>()

const formRef = ref<FormInstance>()
const activeSection = ref('general')
const form = reactive<ConnectionFormValue>(createEmptyForm())

const messages = {
  'zh-CN': {
    productScope: 'ES / OPENSEARCH',
    protocol: 'HTTP REST',
    createTitle: '新增 Elasticsearch 连接',
    editTitle: '编辑 Elasticsearch 连接',
    generalTab: '常规',
    authorizationTab: '认证',
    headersTab: 'Headers',
    sshTab: 'SSH',
    awsTab: 'AWS',
    filtersTab: '过滤',
    name: '名称',
    namePlaceholder: '例如：本地开发环境',
    accessMode: '访问模式',
    readOnly: '只读连接',
    readOnlyHint: '后续写请求必须再次确认',
    connectionSection: '连接',
    connectionMode: '连接方式',
    direct: '直接连接',
    kibanaProxy: '通过 Kibana 代理',
    directEndpointPlaceholder: 'http://127.0.0.1:9200',
    kibanaEndpointPlaceholder: 'http://127.0.0.1:5601',
    directEndpointHint: '多个 Elasticsearch 或 OpenSearch 地址使用分号分隔',
    kibanaEndpointHint: '填写 Kibana 或 OpenSearch Dashboards 地址',
    url: 'URL',
    tls: 'TLS',
    trustInsecureCertificate: '信任不安全或自签名证书',
    authorizationType: '认证类型',
    authorizationNone: '无认证',
    basicAuth: 'Basic Auth',
    apiKey: 'API Key',
    bearerToken: 'Bearer Token',
    oauth2Token: 'OAuth2 Token',
    username: '用户名',
    password: '密码',
    token: 'Token',
    credentialsStored: '认证凭据由系统安全存储加密后保存。',
    noAuthorizationTitle: '当前连接不发送认证信息',
    noAuthorizationHint: '适用于未启用安全认证的本地或测试集群。',
    customHeaders: '自定义请求 Header',
    headerRestriction: 'Authorization、Host 等受控 Header 不允许覆盖',
    add: '添加',
    enabled: '启用',
    headerName: '名称',
    headerValue: '值',
    enableHeader: '启用 Header {index}',
    deleteHeader: '删除 Header {index}',
    headerNamePlaceholder: 'X-Custom-Header',
    headerValuePlaceholder: 'Header value',
    noHeadersTitle: '暂无自定义 Header',
    noHeadersHint: '所有启用项会自动附加到连接测试和后续集群请求。',
    sshTunnel: 'SSH 隧道',
    sshTunnelHint: '通过跳板机访问内网集群',
    host: '主机',
    sshHostPlaceholder: 'bastion.example.com',
    portAndUser: '端口 / 用户',
    sshUserPlaceholder: 'root',
    authorizationMethod: '认证方式',
    privateKey: '私钥',
    sshAgent: 'SSH Agent',
    privateKeyPath: '私钥路径',
    privateKeyPathPlaceholder: '/Users/name/.ssh/id_ed25519',
    privateKeyPassphrase: '私钥口令',
    optional: '可选',
    agentSocket: 'Agent Socket',
    agentSocketPlaceholder: '留空使用 SSH_AUTH_SOCK',
    hostFingerprint: '主机指纹',
    hostFingerprintPlaceholder: 'SHA-256 十六进制，可选',
    hostFingerprintHint: '填写后会严格校验服务器主机密钥；留空表示不校验。',
    sshSecurityHint: 'SSH 密码和私钥口令由系统安全存储加密；URL 中的主机从跳板机侧访问。',
    sshDisabledTitle: '直接从本机访问集群',
    sshDisabledHint: '启用后，所有连接测试和集群请求都会经过同一条 SSH 隧道。',
    awsSigV4: 'AWS SigV4',
    awsSignHint: '签名访问 Amazon OpenSearch',
    region: '区域',
    regionPlaceholder: 'cn-north-1',
    serviceType: '服务类型',
    credentialSource: '凭证来源',
    defaultCredentialChain: '默认凭证链',
    accessKey: '访问密钥',
    amazonOpenSearchService: 'Amazon OpenSearch Service',
    openSearchServerless: 'OpenSearch Serverless',
    awsProfile: 'AWS Profile',
    awsProfilePlaceholder: '留空使用默认凭证链',
    awsDefaultCredentialHint: '支持环境变量、共享配置、SSO、Web Identity、ECS 和 EC2 凭证。',
    accessKeyId: 'Access Key ID',
    secretKey: 'Secret Key',
    sessionToken: 'Session Token',
    awsStaticCredentialHint: 'Secret Access Key 与 Session Token 由系统安全存储加密保存。',
    awsConflictAlert: 'AWS SigV4 需要直接连接模式，并且认证类型必须为无认证。',
    awsDisabledTitle: '当前不签名 AWS 请求',
    awsDisabledHint: '普通 Elasticsearch、OpenSearch 或已有代理认证的连接无需启用。',
    indexPattern: '索引模式',
    indexPatternPlaceholder: 'logs-*, metrics-*',
    aliasPattern: '别名模式',
    aliasPatternPlaceholder: 'public-*',
    templatePattern: '模板模式',
    templatePatternPlaceholder: 'app-*',
    filterHint: '使用逗号分隔多个通配符模式；空值表示不过滤。',
    nameRequired: '请输入连接名称',
    nameTooLong: '连接名称不能超过 64 个字符',
    endpointRequired: '请输入 HTTP(S) 地址',
    endpointMinimum: '至少需要一个 HTTP(S) 地址',
    endpointProtocol: '地址必须使用 http:// 或 https://',
    endpointParts: '地址不能包含凭据、查询参数或锚点',
    endpointComplete: '请输入完整的 HTTP(S) 地址',
    authorizationIncomplete: '认证信息不完整',
    basicUsernameRequired: 'Basic Auth 需要填写用户名。',
    authorizationCredentialRequired: '{authorization} 需要填写认证凭据。',
    returnToEdit: '返回修改',
    sshIncomplete: 'SSH 配置不完整',
    sshHostRequired: 'SSH 主机、1-65535 端口和用户名均为必填项。',
    sshPasswordRequired: '密码认证需要填写 SSH 密码。',
    sshPrivateKeyRequired: '私钥认证需要填写本机私钥文件路径。',
    awsConflict: 'AWS 配置冲突',
    awsDirectRequired: 'AWS SigV4 仅支持直接连接模式。',
    awsAuthorizationConflict: 'AWS SigV4 不能与 Basic、API Key 或 Token 认证同时启用。',
    awsIncomplete: 'AWS 配置不完整',
    awsRegionRequired: 'AWS SigV4 需要填写区域，例如 cn-north-1。',
    awsAccessKeyRequired: '访问密钥模式需要填写 Access Key ID 和 Secret Access Key。',
    deleteConnectionMessage: '删除连接“{name}”后无法恢复，是否继续？',
    deleteConnectionTitle: '删除连接',
    testConnection: '测试连接',
    delete: '删除',
    cancel: '取消',
    save: '保存'
  },
  'en-US': {
    productScope: 'ES / OPENSEARCH',
    protocol: 'HTTP REST',
    createTitle: 'New Elasticsearch connection',
    editTitle: 'Edit Elasticsearch connection',
    generalTab: 'General',
    authorizationTab: 'Authentication',
    headersTab: 'Headers',
    sshTab: 'SSH',
    awsTab: 'AWS',
    filtersTab: 'Filters',
    name: 'Name',
    namePlaceholder: 'For example: Local development',
    accessMode: 'Access mode',
    readOnly: 'Read-only connection',
    readOnlyHint: 'Write requests will require additional confirmation',
    connectionSection: 'Connection',
    connectionMode: 'Connection method',
    direct: 'Direct connection',
    kibanaProxy: 'Kibana proxy',
    directEndpointPlaceholder: 'http://127.0.0.1:9200',
    kibanaEndpointPlaceholder: 'http://127.0.0.1:5601',
    directEndpointHint: 'Separate multiple Elasticsearch or OpenSearch addresses with semicolons',
    kibanaEndpointHint: 'Enter a Kibana or OpenSearch Dashboards address',
    url: 'URL',
    tls: 'TLS',
    trustInsecureCertificate: 'Trust insecure or self-signed certificates',
    authorizationType: 'Authentication type',
    authorizationNone: 'No authentication',
    basicAuth: 'Basic Auth',
    apiKey: 'API Key',
    bearerToken: 'Bearer Token',
    oauth2Token: 'OAuth2 Token',
    username: 'Username',
    password: 'Password',
    token: 'Token',
    credentialsStored: 'Authentication credentials are encrypted by secure system storage.',
    noAuthorizationTitle: 'No authentication data will be sent',
    noAuthorizationHint: 'Suitable for local or test clusters without security enabled.',
    customHeaders: 'Custom request headers',
    headerRestriction: 'Managed headers such as Authorization and Host cannot be overridden',
    add: 'Add',
    enabled: 'Enabled',
    headerName: 'Name',
    headerValue: 'Value',
    enableHeader: 'Enable Header {index}',
    deleteHeader: 'Delete Header {index}',
    headerNamePlaceholder: 'X-Custom-Header',
    headerValuePlaceholder: 'Header value',
    noHeadersTitle: 'No custom headers',
    noHeadersHint: 'Enabled entries are included in connection tests and subsequent cluster requests.',
    sshTunnel: 'SSH tunnel',
    sshTunnelHint: 'Access an internal cluster through a bastion host',
    host: 'Host',
    sshHostPlaceholder: 'bastion.example.com',
    portAndUser: 'Port / user',
    sshUserPlaceholder: 'root',
    authorizationMethod: 'Authentication method',
    privateKey: 'Private key',
    sshAgent: 'SSH Agent',
    privateKeyPath: 'Private key path',
    privateKeyPathPlaceholder: '/Users/name/.ssh/id_ed25519',
    privateKeyPassphrase: 'Private key passphrase',
    optional: 'Optional',
    agentSocket: 'Agent Socket',
    agentSocketPlaceholder: 'Leave empty to use SSH_AUTH_SOCK',
    hostFingerprint: 'Host fingerprint',
    hostFingerprintPlaceholder: 'SHA-256 hexadecimal, optional',
    hostFingerprintHint: 'When provided, the server host key is verified strictly; leave empty to skip verification.',
    sshSecurityHint: 'SSH passwords and key passphrases are encrypted by secure system storage; URL hosts are resolved from the bastion.',
    sshDisabledTitle: 'Access the cluster directly from this computer',
    sshDisabledHint: 'When enabled, connection tests and cluster requests use the same SSH tunnel.',
    awsSigV4: 'AWS SigV4',
    awsSignHint: 'Sign requests to Amazon OpenSearch',
    region: 'Region',
    regionPlaceholder: 'cn-north-1',
    serviceType: 'Service type',
    credentialSource: 'Credential source',
    defaultCredentialChain: 'Default credential chain',
    accessKey: 'Access key',
    amazonOpenSearchService: 'Amazon OpenSearch Service',
    openSearchServerless: 'OpenSearch Serverless',
    awsProfile: 'AWS Profile',
    awsProfilePlaceholder: 'Leave empty to use the default credential chain',
    awsDefaultCredentialHint: 'Supports environment variables, shared configuration, SSO, Web Identity, ECS, and EC2 credentials.',
    accessKeyId: 'Access Key ID',
    secretKey: 'Secret Key',
    sessionToken: 'Session Token',
    awsStaticCredentialHint: 'Secret Access Key and Session Token are encrypted by secure system storage.',
    awsConflictAlert: 'AWS SigV4 requires direct connection mode with no other authentication type.',
    awsDisabledTitle: 'AWS request signing is disabled',
    awsDisabledHint: 'Standard Elasticsearch, OpenSearch, and proxy-authenticated connections do not require it.',
    indexPattern: 'Index patterns',
    indexPatternPlaceholder: 'logs-*, metrics-*',
    aliasPattern: 'Alias patterns',
    aliasPatternPlaceholder: 'public-*',
    templatePattern: 'Template patterns',
    templatePatternPlaceholder: 'app-*',
    filterHint: 'Separate wildcard patterns with commas; leave empty to disable filtering.',
    nameRequired: 'Enter a connection name',
    nameTooLong: 'Connection name cannot exceed 64 characters',
    endpointRequired: 'Enter an HTTP(S) address',
    endpointMinimum: 'At least one HTTP(S) address is required',
    endpointProtocol: 'Addresses must use http:// or https://',
    endpointParts: 'Addresses cannot include credentials, query parameters, or fragments',
    endpointComplete: 'Enter a complete HTTP(S) address',
    authorizationIncomplete: 'Authentication incomplete',
    basicUsernameRequired: 'Basic Auth requires a username.',
    authorizationCredentialRequired: '{authorization} requires credentials.',
    returnToEdit: 'Return to edit',
    sshIncomplete: 'SSH configuration incomplete',
    sshHostRequired: 'SSH host, port from 1 to 65535, and username are required.',
    sshPasswordRequired: 'Password authentication requires an SSH password.',
    sshPrivateKeyRequired: 'Private key authentication requires a local private key path.',
    awsConflict: 'AWS configuration conflict',
    awsDirectRequired: 'AWS SigV4 only supports direct connection mode.',
    awsAuthorizationConflict: 'AWS SigV4 cannot be combined with Basic, API Key, or Token authentication.',
    awsIncomplete: 'AWS configuration incomplete',
    awsRegionRequired: 'AWS SigV4 requires a region, for example cn-north-1.',
    awsAccessKeyRequired: 'Access key mode requires an Access Key ID and Secret Access Key.',
    deleteConnectionMessage: 'Deleting “{name}” cannot be undone. Continue?',
    deleteConnectionTitle: 'Delete connection',
    testConnection: 'Test connection',
    delete: 'Delete',
    cancel: 'Cancel',
    save: 'Save'
  }
} as const

const copy = computed(() => messages[props.language === 'en-US' ? 'en-US' : 'zh-CN'])
const dialogVisible = computed({
  get: () => props.visible,
  set: (visible: boolean) => emit('update:visible', visible)
})
const dialogTitle = computed(() =>
  props.connection ? copy.value.editTitle : copy.value.createTitle
)
const isBusy = computed(() => props.loading || props.saving || props.testing || props.deleting)
const authorizationLabel = computed<Record<AuthorizationType, string>>(() => ({
  none: copy.value.authorizationNone,
  basic: copy.value.basicAuth,
  'api-key': copy.value.apiKey,
  bearer: copy.value.bearerToken,
  oauth2: copy.value.oauth2Token
}))
const sshAuthorizationLabel = computed<Record<SshAuthorizationType, string>>(() => ({
  password: copy.value.password,
  'private-key': copy.value.privateKey,
  agent: copy.value.sshAgent
}))
const awsCredentialSourceLabel = computed<Record<AwsCredentialSource, string>>(() => ({
  default: copy.value.defaultCredentialChain,
  static: copy.value.accessKey
}))
const awsServiceLabel = computed<Record<AwsService, string>>(() => ({
  es: copy.value.amazonOpenSearchService,
  aoss: copy.value.openSearchServerless
}))

const rules = computed<FormRules<ConnectionFormValue>>(() => ({
  name: [
    { required: true, message: copy.value.nameRequired, trigger: 'blur' },
    { max: 64, message: copy.value.nameTooLong, trigger: 'blur' }
  ],
  endpoints: [
    { required: true, message: copy.value.endpointRequired, trigger: 'blur' },
    {
      validator: (_rule, value: string, callback) => {
        const endpoints = value.split(';').map((endpoint) => endpoint.trim()).filter(Boolean)
        if (!endpoints.length) {
          callback(new Error(copy.value.endpointMinimum))
          return
        }
        try {
          for (const endpointValue of endpoints) {
            const endpoint = new URL(endpointValue)
            if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') {
              throw new Error(copy.value.endpointProtocol)
            }
            if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
              throw new Error(copy.value.endpointParts)
            }
          }
          callback()
        } catch (error: unknown) {
          callback(error instanceof Error ? error : new Error(copy.value.endpointComplete))
        }
      },
      trigger: 'blur'
    }
  ]
}))

watch(
  () => [props.visible, props.profile, props.connection] as const,
  ([visible, profile, connection]) => {
    if (!visible || (connection && !profile)) return
    assignForm(profile ?? createEmptyForm())
    activeSection.value = 'general'
    formRef.value?.clearValidate()
  },
  { immediate: true }
)

function createEmptyForm(): ConnectionFormValue {
  return {
    name: '',
    endpoints: 'http://127.0.0.1:9200',
    readOnly: false,
    mode: 'direct',
    trustInsecureCertificate: false,
    authorization: { type: 'none', username: '', secret: '' },
    headers: [],
    ssh: {
      enabled: false,
      host: '',
      port: 22,
      username: '',
      authorizationType: 'password',
      password: '',
      privateKeyPath: '',
      passphrase: '',
      agentSocket: '',
      hostFingerprint: ''
    },
    aws: {
      enabled: false,
      region: '',
      service: 'es',
      credentialSource: 'default',
      profile: '',
      accessKeyId: '',
      secretAccessKey: '',
      sessionToken: ''
    },
    filters: { indices: '', aliases: '', templates: '' }
  }
}

function assignForm(value: ConnectionFormValue): void {
  form.name = value.name
  form.endpoints = value.endpoints
  form.readOnly = value.readOnly
  form.mode = value.mode
  form.trustInsecureCertificate = value.trustInsecureCertificate
  form.authorization = { ...value.authorization }
  form.headers = value.headers.map((header) => ({ ...header }))
  form.ssh = { ...value.ssh }
  form.aws = { ...value.aws }
  form.filters = { ...value.filters }
}

function createSubmitValue(): ConnectionFormValue {
  return {
    name: form.name.trim(),
    endpoints: form.endpoints
      .split(';')
      .map((endpoint) => endpoint.trim())
      .filter(Boolean)
      .join('; '),
    readOnly: form.readOnly,
    mode: form.mode,
    trustInsecureCertificate: form.trustInsecureCertificate,
    authorization: {
      type: form.authorization.type,
      username: form.authorization.username.trim(),
      secret: form.authorization.secret
    },
    headers: form.headers.map((header) => ({
      ...header,
      name: header.name.trim(),
      value: header.value
    })),
    ssh: {
      ...form.ssh,
      host: form.ssh.host.trim(),
      username: form.ssh.username.trim(),
      privateKeyPath: form.ssh.privateKeyPath.trim(),
      agentSocket: form.ssh.agentSocket.trim(),
      hostFingerprint: form.ssh.hostFingerprint.trim()
    },
    aws: {
      ...form.aws,
      region: form.aws.region.trim(),
      profile: form.aws.profile.trim(),
      accessKeyId: form.aws.accessKeyId.trim()
    },
    filters: {
      indices: form.filters.indices.trim(),
      aliases: form.filters.aliases.trim(),
      templates: form.filters.templates.trim()
    }
  }
}

function formatMessage(
  template: string,
  values: Record<string, string | number>
): string {
  return Object.entries(values).reduce(
    (message, [key, value]) => message.replaceAll(`{${key}}`, String(value)),
    template
  )
}

async function validateForm(): Promise<boolean> {
  const isValid = await formRef.value?.validate().catch(() => false)
  if (!isValid) return false

  if (form.authorization.type === 'basic' && !form.authorization.username.trim()) {
    activeSection.value = 'authorization'
    await ElMessageBox.alert(copy.value.basicUsernameRequired, copy.value.authorizationIncomplete, {
      type: 'warning',
      customClass: 'connection-result-dialog is-warning',
      showClose: false,
      confirmButtonText: copy.value.returnToEdit
    })
    return false
  }
  if (form.authorization.type !== 'none' && !form.authorization.secret) {
    activeSection.value = 'authorization'
    await ElMessageBox.alert(
      formatMessage(copy.value.authorizationCredentialRequired, {
        authorization: authorizationLabel.value[form.authorization.type]
      }),
      copy.value.authorizationIncomplete,
      {
        type: 'warning',
        customClass: 'connection-result-dialog is-warning',
        showClose: false,
        confirmButtonText: copy.value.returnToEdit
      }
    )
    return false
  }
  if (form.ssh.enabled) {
    if (!form.ssh.host.trim() || !form.ssh.username.trim() || form.ssh.port < 1 || form.ssh.port > 65535) {
      activeSection.value = 'ssh'
      await showValidationWarning(copy.value.sshHostRequired, copy.value.sshIncomplete)
      return false
    }
    if (form.ssh.authorizationType === 'password' && !form.ssh.password) {
      activeSection.value = 'ssh'
      await showValidationWarning(copy.value.sshPasswordRequired, copy.value.sshIncomplete)
      return false
    }
    if (form.ssh.authorizationType === 'private-key' && !form.ssh.privateKeyPath.trim()) {
      activeSection.value = 'ssh'
      await showValidationWarning(copy.value.sshPrivateKeyRequired, copy.value.sshIncomplete)
      return false
    }
  }
  if (form.aws.enabled) {
    if (form.mode !== 'direct') {
      activeSection.value = 'aws'
      await showValidationWarning(copy.value.awsDirectRequired, copy.value.awsConflict)
      return false
    }
    if (form.authorization.type !== 'none') {
      activeSection.value = 'aws'
      await showValidationWarning(copy.value.awsAuthorizationConflict, copy.value.awsConflict)
      return false
    }
    if (!form.aws.region.trim()) {
      activeSection.value = 'aws'
      await showValidationWarning(copy.value.awsRegionRequired, copy.value.awsIncomplete)
      return false
    }
    if (
      form.aws.credentialSource === 'static' &&
      (!form.aws.accessKeyId.trim() || !form.aws.secretAccessKey)
    ) {
      activeSection.value = 'aws'
      await showValidationWarning(copy.value.awsAccessKeyRequired, copy.value.awsIncomplete)
      return false
    }
  }
  return true
}

async function showValidationWarning(message: string, title: string): Promise<void> {
  await ElMessageBox.alert(message, title, {
    type: 'warning',
    customClass: 'connection-result-dialog is-warning',
    showClose: false,
    confirmButtonText: copy.value.returnToEdit
  })
}

async function submitForm(): Promise<void> {
  if (!(await validateForm())) return
  emit('submit', createSubmitValue())
}

async function testForm(): Promise<void> {
  if (!(await validateForm())) return
  emit('test', createSubmitValue())
}

function addHeader(): void {
  form.headers.push({ id: crypto.randomUUID(), name: '', value: '', enabled: true })
}

function removeHeader(headerId: string): void {
  form.headers = form.headers.filter((header) => header.id !== headerId)
}

function getHeaderKey(_index: number, header: ConnectionHeader): string {
  return header.id
}

async function confirmDelete(): Promise<void> {
  if (!props.connection) return
  try {
    await ElMessageBox.confirm(
      formatMessage(copy.value.deleteConnectionMessage, { name: props.connection.name }),
      copy.value.deleteConnectionTitle,
      {
        confirmButtonText: copy.value.delete,
        cancelButtonText: copy.value.cancel,
        confirmButtonClass: 'el-button--danger',
        type: 'warning'
      }
    )
  } catch {
    return
  }
  emit('delete')
}
</script>

<template>
  <el-dialog
    v-model="dialogVisible"
    :title="dialogTitle"
    width="min(920px, calc(100vw - 48px))"
    class="connection-dialog"
    :close-on-click-modal="false"
    :close-on-press-escape="!isBusy"
    :show-close="!isBusy"
    align-center
  >
    <template #header>
      <div class="connection-dialog-heading">
        <span class="connection-dialog-emblem"><el-icon><DataLine /></el-icon></span>
        <div>
          <small>{{ copy.productScope }}</small>
          <strong>{{ dialogTitle }}</strong>
        </div>
        <span class="connection-dialog-protocol">{{ copy.protocol }}</span>
      </div>
    </template>
    <div v-loading="loading" class="connection-dialog-layout">
      <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
      <el-tabs v-model="activeSection" class="connection-tabs">
        <el-tab-pane :label="copy.generalTab" name="general">
          <el-form ref="formRef" :model="form" :rules="rules" label-width="112px" @submit.prevent="submitForm">
            <el-form-item :label="copy.name" prop="name">
              <el-input v-model="form.name" maxlength="64" :placeholder="copy.namePlaceholder" />
            </el-form-item>
            <el-form-item :label="copy.accessMode">
              <el-checkbox v-model="form.readOnly">{{ copy.readOnly }}</el-checkbox>
              <span class="field-help">{{ copy.readOnlyHint }}</span>
            </el-form-item>
            <div class="form-section-title"><span>{{ copy.connectionSection }}</span></div>
            <el-form-item :label="copy.connectionMode">
              <el-radio-group v-model="form.mode">
                <el-radio-button value="direct">{{ copy.direct }}</el-radio-button>
                <el-radio-button value="kibana">{{ copy.kibanaProxy }}</el-radio-button>
              </el-radio-group>
            </el-form-item>
            <el-form-item :label="copy.url" prop="endpoints">
              <div class="field-stack">
                <el-input
                  v-model="form.endpoints"
                  class="endpoint-field"
                  type="textarea"
                  :autosize="{ minRows: 2, maxRows: 4 }"
                  :placeholder="form.mode === 'direct' ? copy.directEndpointPlaceholder : copy.kibanaEndpointPlaceholder"
                />
                <span class="field-help">
                  {{ form.mode === 'direct' ? copy.directEndpointHint : copy.kibanaEndpointHint }}
                </span>
              </div>
            </el-form-item>
            <el-form-item :label="copy.tls">
              <el-checkbox v-model="form.trustInsecureCertificate">{{ copy.trustInsecureCertificate }}</el-checkbox>
            </el-form-item>
          </el-form>
        </el-tab-pane>

        <el-tab-pane :label="copy.authorizationTab" name="authorization">
          <div class="tab-form">
            <div class="tab-form-row">
              <label>{{ copy.authorizationType }}</label>
              <el-select v-model="form.authorization.type">
                <el-option v-for="(label, value) in authorizationLabel" :key="value" :label="label" :value="value" />
              </el-select>
            </div>
            <template v-if="form.authorization.type !== 'none'">
              <div v-if="form.authorization.type === 'basic'" class="tab-form-row">
                <label>{{ copy.username }}</label>
                <el-input v-model="form.authorization.username" autocomplete="off" />
              </div>
              <div class="tab-form-row">
                <label>{{ form.authorization.type === 'basic' ? copy.password : copy.token }}</label>
                <el-input v-model="form.authorization.secret" type="password" show-password autocomplete="new-password" />
              </div>
              <p class="security-note">{{ copy.credentialsStored }}</p>
            </template>
            <div v-else class="tab-empty-state">
              <strong>{{ copy.noAuthorizationTitle }}</strong>
              <span>{{ copy.noAuthorizationHint }}</span>
            </div>
          </div>
        </el-tab-pane>

        <el-tab-pane :label="copy.headersTab" name="headers">
          <div class="header-toolbar">
            <div><strong>{{ copy.customHeaders }}</strong><span>{{ copy.headerRestriction }}</span></div>
            <el-button :icon="Plus" @click="addHeader">{{ copy.add }}</el-button>
          </div>
          <div v-if="form.headers.length" class="header-table">
            <div class="header-table-heading"><span>{{ copy.enabled }}</span><span>{{ copy.headerName }}</span><span>{{ copy.headerValue }}</span><span /></div>
            <div v-for="(header, index) in form.headers" :key="getHeaderKey(index, header)" class="header-row">
              <el-checkbox v-model="header.enabled" :aria-label="formatMessage(copy.enableHeader, { index: index + 1 })" />
              <el-input v-model="header.name" :placeholder="copy.headerNamePlaceholder" />
              <el-input v-model="header.value" type="password" show-password :placeholder="copy.headerValuePlaceholder" />
              <el-button text circle :icon="Delete" :aria-label="formatMessage(copy.deleteHeader, { index: index + 1 })" @click="removeHeader(header.id)" />
            </div>
          </div>
          <div v-else class="tab-empty-state bordered">
            <strong>{{ copy.noHeadersTitle }}</strong>
            <span>{{ copy.noHeadersHint }}</span>
          </div>
        </el-tab-pane>

        <el-tab-pane :label="copy.sshTab" name="ssh">
          <div class="tab-form">
            <div class="connection-capability-switch">
              <div><strong>{{ copy.sshTunnel }}</strong><span>{{ copy.sshTunnelHint }}</span></div>
              <el-switch v-model="form.ssh.enabled" size="small" />
            </div>
            <template v-if="form.ssh.enabled">
              <div class="tab-form-row">
                <label>{{ copy.host }}</label>
                <el-input v-model="form.ssh.host" :placeholder="copy.sshHostPlaceholder" />
              </div>
              <div class="tab-form-row split-fields">
                <label>{{ copy.portAndUser }}</label>
                <div>
                  <el-input-number v-model="form.ssh.port" :min="1" :max="65535" controls-position="right" />
                  <el-input v-model="form.ssh.username" :placeholder="copy.sshUserPlaceholder" autocomplete="username" />
                </div>
              </div>
              <div class="tab-form-row">
                <label>{{ copy.authorizationMethod }}</label>
                <el-select v-model="form.ssh.authorizationType">
                  <el-option v-for="(label, value) in sshAuthorizationLabel" :key="value" :label="label" :value="value" />
                </el-select>
              </div>
              <div v-if="form.ssh.authorizationType === 'password'" class="tab-form-row">
                <label>{{ copy.password }}</label>
                <el-input v-model="form.ssh.password" type="password" show-password autocomplete="new-password" />
              </div>
              <template v-else-if="form.ssh.authorizationType === 'private-key'">
                <div class="tab-form-row">
                  <label>{{ copy.privateKeyPath }}</label>
                  <el-input v-model="form.ssh.privateKeyPath" :placeholder="copy.privateKeyPathPlaceholder" />
                </div>
                <div class="tab-form-row">
                  <label>{{ copy.privateKeyPassphrase }}</label>
                  <el-input v-model="form.ssh.passphrase" type="password" show-password :placeholder="copy.optional" />
                </div>
              </template>
              <div v-else class="tab-form-row">
                <label>{{ copy.agentSocket }}</label>
                <el-input v-model="form.ssh.agentSocket" :placeholder="copy.agentSocketPlaceholder" />
              </div>
              <div class="tab-form-row">
                <label>{{ copy.hostFingerprint }}</label>
                <div class="field-stack">
                  <el-input v-model="form.ssh.hostFingerprint" :placeholder="copy.hostFingerprintPlaceholder" />
                  <span class="field-help">{{ copy.hostFingerprintHint }}</span>
                </div>
              </div>
              <p class="security-note">{{ copy.sshSecurityHint }}</p>
            </template>
            <div v-else class="tab-empty-state compact">
              <strong>{{ copy.sshDisabledTitle }}</strong>
              <span>{{ copy.sshDisabledHint }}</span>
            </div>
          </div>
        </el-tab-pane>

        <el-tab-pane :label="copy.awsTab" name="aws">
          <div class="tab-form">
            <div class="connection-capability-switch">
              <div><strong>{{ copy.awsSigV4 }}</strong><span>{{ copy.awsSignHint }}</span></div>
              <el-switch v-model="form.aws.enabled" size="small" />
            </div>
            <template v-if="form.aws.enabled">
              <div class="tab-form-row">
                <label>{{ copy.region }}</label>
                <el-input v-model="form.aws.region" :placeholder="copy.regionPlaceholder" />
              </div>
              <div class="tab-form-row">
                <label>{{ copy.serviceType }}</label>
                <el-select v-model="form.aws.service">
                  <el-option v-for="(label, value) in awsServiceLabel" :key="value" :label="label" :value="value" />
                </el-select>
              </div>
              <div class="tab-form-row">
                <label>{{ copy.credentialSource }}</label>
                <el-select v-model="form.aws.credentialSource">
                  <el-option v-for="(label, value) in awsCredentialSourceLabel" :key="value" :label="label" :value="value" />
                </el-select>
              </div>
              <template v-if="form.aws.credentialSource === 'default'">
                <div class="tab-form-row">
                  <label>{{ copy.awsProfile }}</label>
                  <el-input v-model="form.aws.profile" :placeholder="copy.awsProfilePlaceholder" />
                </div>
                <p class="security-note">{{ copy.awsDefaultCredentialHint }}</p>
              </template>
              <template v-else>
                <div class="tab-form-row">
                  <label>{{ copy.accessKeyId }}</label>
                  <el-input v-model="form.aws.accessKeyId" autocomplete="off" />
                </div>
                <div class="tab-form-row">
                  <label>{{ copy.secretKey }}</label>
                  <el-input v-model="form.aws.secretAccessKey" type="password" show-password autocomplete="new-password" />
                </div>
                <div class="tab-form-row">
                  <label>{{ copy.sessionToken }}</label>
                  <el-input v-model="form.aws.sessionToken" type="password" show-password :placeholder="copy.optional" />
                </div>
                <p class="security-note">{{ copy.awsStaticCredentialHint }}</p>
              </template>
              <el-alert
                v-if="form.mode !== 'direct' || form.authorization.type !== 'none'"
                :title="copy.awsConflictAlert"
                type="warning"
                :closable="false"
                show-icon
              />
            </template>
            <div v-else class="tab-empty-state compact">
              <strong>{{ copy.awsDisabledTitle }}</strong>
              <span>{{ copy.awsDisabledHint }}</span>
            </div>
          </div>
        </el-tab-pane>

        <el-tab-pane :label="copy.filtersTab" name="filters">
          <div class="tab-form">
            <div class="tab-form-row">
              <label>{{ copy.indexPattern }}</label>
              <el-input v-model="form.filters.indices" :placeholder="copy.indexPatternPlaceholder" />
            </div>
            <div class="tab-form-row">
              <label>{{ copy.aliasPattern }}</label>
              <el-input v-model="form.filters.aliases" :placeholder="copy.aliasPatternPlaceholder" />
            </div>
            <div class="tab-form-row">
              <label>{{ copy.templatePattern }}</label>
              <el-input v-model="form.filters.templates" :placeholder="copy.templatePatternPlaceholder" />
            </div>
            <p class="security-note">{{ copy.filterHint }}</p>
          </div>
        </el-tab-pane>
      </el-tabs>
    </div>

    <template #footer>
      <div class="connection-dialog-footer">
        <div class="connection-dialog-left-actions">
          <el-button :loading="testing" :disabled="loading || saving || deleting" @click="testForm">{{ copy.testConnection }}</el-button>
          <el-button v-if="connection" type="danger" text :loading="deleting" :disabled="saving || testing" @click="confirmDelete">{{ copy.delete }}</el-button>
        </div>
        <div class="connection-dialog-actions">
          <el-button :disabled="isBusy" @click="dialogVisible = false">{{ copy.cancel }}</el-button>
          <el-button type="primary" :loading="saving" :disabled="loading || testing || deleting" @click="submitForm">{{ copy.save }}</el-button>
        </div>
      </div>
    </template>
  </el-dialog>
</template>
