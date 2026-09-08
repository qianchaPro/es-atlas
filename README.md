# ES Atlas

面向 Elasticsearch 与 OpenSearch 的跨平台桌面管理工具。使用 Electron、Vue 3 和 TypeScript 构建，将连接管理、索引数据浏览、REST 调试和集群资源管理放在同一个工作区。

[产品官网](https://ideaatlas.online/esAtlas) · [博客](https://ideaatlas.online/) · [下载安装包](https://github.com/qianchaPro/es-atlas/releases/latest) · [反馈问题](https://github.com/qianchaPro/es-atlas/issues)

## 下载与安装

在 [GitHub Releases](https://github.com/qianchaPro/es-atlas/releases) 的 Assets 中选择对应系统与处理器的安装包。源码压缩包不包含可直接运行的桌面程序。

| 系统 | 安装包 |
| --- | --- |
| macOS Intel | `ES.Atlas-0.1.1-mac-x64.dmg` |
| macOS Apple Silicon（M 系列） | `ES.Atlas-0.1.1-mac-arm64.dmg` |
| Windows 64 位（Intel / AMD） | `ES.Atlas-0.1.1-win-x64.exe` |

macOS：打开 DMG，将 ES Atlas 拖入“应用程序”。Windows：运行 EXE，按向导选择安装位置。安装包当前未进行开发者证书签名和 Apple 公证，系统可能显示来源提示；下载后可使用同一 Release 中的 `SHA256SUMS.txt` 校验文件完整性。Windows ARM64 和 Linux 暂不提供本次预构建安装包。

## 主要功能

- **连接管理**：连接分组、多地址故障切换、只读模式、HTTP/HTTPS、Basic Auth、API Key、Bearer/OAuth2 Token、SSH 隧道和 AWS SigV4。
- **集群概览**：健康状态、节点、分片、JVM、请求耗时与错误统计。
- **索引与文档**：索引、别名、Mapping 与 Settings 浏览，文档筛选、排序、编辑、批量提交和 JSON/CSV 导入导出。
- **REST 工作台**：多标签请求编辑、本地草稿、历史和收藏。
- **资源管理**：模板、数据流、Pipeline、脚本、快照、Reindex 和 Async Search；根据产品版本与权限限制可用操作。
- **本地工作区**：中英文界面、主题设置、标签恢复、请求日志，以及保留 30 天的索引/文档恢复记录。

首次启动不预置集群或账号。在左侧新建连接，填写自己的 Elasticsearch/OpenSearch **HTTP 服务地址**，先测试再连接。生产环境建议先启用只读模式。SSH、TLS 和认证参数应按自己的服务配置填写。

## 兼容性与限制

代码包含 Elasticsearch 5/6 的部分兼容逻辑、Elasticsearch 7/8/9 与 OpenSearch 1/2/3 的能力判断。现有真实集群验证记录主要来自 Elasticsearch 7.3.1；其他版本、Kibana Proxy、SSH、AWS 和各类认证组合尚未完成完整的真实环境验证。契约测试通过不代表所有版本和操作均经过实测。

查询与导出当前最多读取 10,000 条文档。索引复制/导出不等同于完整备份；恢复能力依赖本机保存的记录，不替代 Elasticsearch 快照。REST 取消采用结果丢弃方式，不能保证服务端请求已停止。自动更新仅检查版本并打开下载地址，不会自动安装或重启。

## 隐私与本地数据

连接、偏好、请求历史和恢复记录保存在 Electron 的 `userData` 目录。认证凭据和敏感 Header 值通过 Electron `safeStorage` 加密。运行日志不保存请求体、认证 Header 或明文凭据；REST 草稿和恢复记录可能包含业务数据，应按敏感文件管理。

客户端访问所配置的集群；更新检查和远程配置默认访问 `https://ideaatlas.online/prod-api`。更新请求包含应用标识、平台和处理器架构，不发送集群凭据或文档内容。升级前建议备份应用数据；加密凭据依赖当前操作系统用户，跨设备复制后可能需要重新输入。0.1.1 会将旧官方 IP 默认设置迁移到 HTTPS 域名，保留其他自定义地址。

## 本地开发

需要 Git、npm 和支持 `--experimental-strip-types` 的 Node.js（22.18+ 或 24+）。macOS DMG 必须在 macOS 上构建。依赖版本由 `package-lock.json` 固定。

```bash
git clone https://github.com/qianchaPro/es-atlas.git
cd es-atlas
npm ci
npm run dev
```

```bash
npm test            # 单元测试与契约测试
npm run build      # TypeScript/Vue 类型检查与构建
npm run preview    # 预览构建结果
npm run package:select  # 选择系统与架构，构建并审计安装包
```

非交互打包示例：

```bash
npm run package:select -- --target macos-arm64 --yes
npm run package:select -- --target macos-x64 --yes
npm run package:select -- --target windows-x64 --yes
```

首次打包可能下载 Electron 运行时与平台打包组件。`--yes` 表示允许脚本继续。产物位于 `release/<目标>/`；脚本检查运行依赖、排除用户数据并输出 SHA-256。签名/公证需要自行配置相应开发者证书。

## 源码结构

```text
electron/main/       Electron 主进程、连接、集群操作和本地存储
electron/preload/    受限 IPC 桥接
src/renderer/        Vue 界面
src/shared/          共享类型与能力规则
tests/               单元测试与契约测试
scripts/             打包及产物审计
build/               应用图标与构建资源
```

此仓库仅包含 ES Atlas 桌面客户端。官网和管理后台 Atlas Admin 是独立项目，不包含在本次开源范围内。连接集群和本地管理功能不需要自行部署 Atlas Admin；它用于官网配置与更新分发。

## 反馈与贡献

欢迎通过 [Issues](https://github.com/qianchaPro/es-atlas/issues) 提交可复现问题或通过 Pull Request 贡献改动。请说明应用版本、操作系统、集群产品/版本、复现步骤和脱敏错误信息，不要上传密码、Token、私钥、完整连接配置或业务文档。提交前运行 `npm test` 和 `npm run build`。

## 许可证

[MIT License](LICENSE) · Copyright (c) 2026 qianchaPro。
