# DealPilot DSH

DealPilot 是运行在 DeepSeek Harness 上的 AI 原生销售工作台。它复用 DSH 的原生对话、会话、模型和工具运行时，把客户、交易和跟进任务放在同一个 Workspace 中管理。

## 路由

| 地址 | 用途 |
| --- | --- |
| `/` | 原始 DSH 对话页面。默认 Workspace、会话和 Agent 行为保持原样。 |
| `/dealpilot` | DealPilot 销售工作台。固定使用 `dealpilot-sales` Agent，并提供业务上下文和看板视图。 |

DealPilot 不替换 DSH 默认页面，也不需要用户手动编辑本地目录或 Markdown 文件。

## 快速开始

### 环境要求

- 已安装并能运行 `dsh` CLI
- Node.js 22 或更高版本
- pnpm 11 或更高版本
- Node.js 22.19 或更高版本（Univer Gateway 和渲染 Worker 的运行要求）

### 安装插件

推荐让 DSH profile 从 GitHub 的 `dist` 发布压缩包安装。压缩包不会触发 Git 源码包的 `prepare` 构建流程，适合普通用户首次安装和更新：

```powershell
dsh plugin --profile web add https://github.com/round123/dealpilot-dsh/archive/refs/heads/dist.tar.gz --allow-build=sharp --allow-build=tesseract.js
```

`sharp` 和 `tesseract.js` 是办公文件处理所需的原生依赖，参数只允许这两个依赖执行安装构建脚本。

更新已安装版本时，先移除当前插件再安装最新发布压缩包：

```powershell
dsh plugin --profile web remove dealpilot-dsh
dsh plugin --profile web add https://github.com/round123/dealpilot-dsh/archive/refs/heads/dist.tar.gz --allow-build=sharp --allow-build=tesseract.js
```

更新只替换插件及其生产依赖，不会删除 Workspace 或业务数据。完成后重新启动 DSH：

```powershell
dsh web --no-open
```

如果网络环境缓存了旧压缩包，可在 URL 后追加当前 `dist` 提交的短 SHA 作为查询参数，或重新执行一次安装命令。

安装包会同时启用 `dsh-univer-office`。它提供 Sheet/Doc/Slide/Base/Board 的创建、编辑、导入、导出和审阅能力。

如果使用 GitHub Release 下载的压缩包，先在解压后的插件目录安装生产依赖，再执行本地 link。`dsh plugin add` 对本地目录只创建 link，不会替插件目录安装 `node_modules`：

```powershell
cd D:\path\to\dealpilot-dsh
pnpm install --prod --frozen-lockfile
dsh plugin --profile web add .
```

如果你的 pnpm 使用了企业镜像或供应链白名单，并且锁文件中的地址不被允许，可以让 pnpm 按当前配置重新解析一次：

```powershell
pnpm install --prod --no-frozen-lockfile --registry=<你环境允许的 registry>
dsh plugin --profile web add .
```

本地开发也可以直接使用仓库目录：

```powershell
cd "D:\Ai Native\dealpilot-dsh\plugin"
pnpm install
pnpm run build
dsh plugin --profile web add .
```

### 启动

```powershell
dsh web --no-open
```

通用文件上传由随 DealPilot 一起安装的 `dsh-file-upload` 提供；办公文件由 `dsh-univer-office`
导入为隔离工作簿，在会话内预览、编辑、校验并导出。资料写回沿着
evidence → interpretation → change-set → approval → mutation kernel 链路进行。

### 资料写回闭环

```text
来源归档（原始字节 + manifest）
  → evidence/v2（逐 sheet/row/column/cell observation，可分页重读）
  → interpretation/v2（LLM claim、证据引用、未知/冲突和 coverage）
  → change-set/v2（typed before/after、目标版本、accounting 和 hash）
  → 宿主展示完整预览并返回 allowed-once
  → durable approval（绑定 Workspace/session/解释/变更集）
  → mutation kernel（锁、WAL、staging、幂等、事件和索引）
  → 可重建的 OKF/snapshot 投影
```

`dealpilot_ingest` 只归档和转换，不创建业务对象；LLM 必须先读取完整相关
evidence 并记录 interpretation，才能形成 proposal。调用 `dealpilot_apply`
后，宿主展示完整变更集；用户返回 `allowed-once` 时，同一次工具执行直接提交
该 proposal。持久化 `approval_id` 只用于审计、崩溃恢复和内部重试，不作为模型
需要携带的秘密。任何版本漂移、冲突或未映射内容都会停在可审阅状态。

打开：

- 原生 DSH：<http://127.0.0.1:3080/>
- DealPilot：<http://127.0.0.1:3080/dealpilot>

### 首次进入 DealPilot

1. 打开 `/dealpilot`。
2. 在首屏选择一个 DSH Workspace。
3. DealPilot 检查 Workspace 是否已有业务资料：
   - `可复用`：直接进入销售工作台。
   - `新工作区`：点击“初始化并进入”，只创建 DealPilot 所需目录和元数据。
4. 进入后，新建对话会自动绑定当前 Workspace 和 `dealpilot-sales` Agent preset。

初始化是幂等的，不会覆盖已有客户、交易、行动或事件文件。切换 Workspace 会创建新的 DealPilot 对话上下文，旧会话仍保留。

## 工作台能力

DealPilot 页面由原生 DSH Conversation/Composer 加上产品业务视图组成：

- 今日工作、周复盘、高风险交易、停滞交易
- 客户、交易和跟进任务列表
- 漏斗、交易生命周期、行动生命周期和活动时间线
- 搜索、字段筛选、排序和详情面板
- Univer 工作簿：XLSX/CSV/TSV 导入，单元格编辑、公式、格式、筛选、图表和审阅
- 客户资料写回：从完整 evidence 生成带来源的解释和变更预览
- Customer、Contact、Deal、Action、Relationship、Note 的 typed change-set
- 用户批准、幂等提交、事务恢复和索引校验
- Goal/Workflow 运行时投影
- Workspace 快照导出和归档

业务视图中的写入操作先展示逐项 before/after、证据、冲突和未决项，获得明确用户批准后才由 mutation kernel 写入 OKF，并追加业务事件。

## Agent 和工具

`/dealpilot` 新建的会话固定使用 `dealpilot-sales`：

| 工具 | 能力 |
| --- | --- |
| `dealpilot_snapshot` | 读取 Today、客户、交易、漏斗、行动和活动快照 |
| `dealpilot_search` | 按名称模糊搜索，并按市场、阶段、风险等字段筛选 |
| `dealpilot_ingest` | 将当前 session 附件或 Workspace 文件归档为无损 `dealpilot.evidence/v2` |
| `dealpilot_read` | 分页读取 evidence、interpretation 和 OKF 原文 |
| `dealpilot_record_interpretation` | 保存覆盖完整 observation 的可修正 LLM interpretation |
| `dealpilot_propose` | 保存带 claim/evidence、版本和 accounting 的 `dealpilot.change-set/v2` |
| `dealpilot_apply` | 消费绑定具体 change-set 的用户批准并通过事务内核应用 |
| `dealpilot_feedback_*` | 生成脱敏反馈草稿，并在独立 approval 后生成 GitHub Issue 地址 |
| `dealpilot_whatsapp` | 记录待审阅的消息草稿 |

所有业务工具都从当前 DealPilot session 读取 Workspace。`dealpilot_ingest` 的 `source` 支持 `session_attachment`（当前 session 的附件）和 `workspace_file`（当前 Workspace 内的相对路径）；路径会经过真实路径边界校验，并复制到 Import Job 专属归档目录。没有绑定 Workspace 时，工具会返回“请先选择 DealPilot Workspace”。业务写入只能通过宿主对完整预览返回的 `allowed-once` 执行；持久化 `approval_id` 仅用于审计和内部恢复，解释与证据版本变化会使批准失效。

## Workspace 数据

Workspace 使用 OKF 文件作为权威数据源，Storage index 用于加速查询：

```text
<workspace>/
├── .dsh/workspace.json
├── knowledge/
│   ├── customers/*.md
│   ├── contacts/*.md
│   ├── deals/*.md
│   ├── actions/*.md
│   ├── relationships/*.md
│   ├── notes/*.md
│   ├── products/*.md
│   └── events/business-events.jsonl
├── sources/imports/{job}/      # 原始来源、manifest 和 evidence/v2
└── storage/
    ├── interpretations/         # 可重解释的 claim ledger
    ├── change-sets/              # 不可变 typed 变更集
    ├── proposals/                # session 绑定的 proposal 状态
    ├── approvals/                # 用户批准记录
    ├── transactions/             # WAL 和恢复状态
    └── indexes/                  # 可重建的查询索引
```

真实路径由 DSH Workspace Registry 解析，不返回给浏览器，也不应该写入对话内容。

## HTTP API

插件提供以下页面级接口：

```text
GET  /api/dealpilot/workspaces
POST /api/dealpilot/workspaces/inspect
POST /api/dealpilot/workspaces/initialize
POST /api/dealpilot/workspaces/archive
POST /api/dealpilot/session
POST /api/dealpilot/native-session
GET  /api/dealpilot/session/:id
POST /api/dealpilot/session/:id/workspace
GET  /api/dealpilot/sessions?workspaceId=...
GET  /api/dealpilot/snapshot?workspaceId=...
GET  /api/dealpilot/memory?workspaceId=...&ref=...
POST /api/dealpilot/import/source?workspaceId=...
GET  /api/dealpilot/export?workspaceId=...
```

首次初始化是受控 bootstrap：客户端先由 DSH host 创建绑定目标 Workspace 的 native
session，再携带 `bootstrap=true` 和该 session id 初始化目录；该入口只接受本机
loopback 请求。初始化完成后，上传、归档和业务会话创建都要求 `x-dealpilot-session-id`
与 Workspace 一致，切换会话还必须与 URL 中的 session id 一致。native session id
不能被重复绑定到另一个 Workspace。

只读查询端点 `/api/dealpilot/bootstrap`、`/customers`、`/deals`、`/actions`、`/events`、`/weekly-review`、`/risk` 和 `/stalled` 继续提供给现有工作台视图；它们不提供业务写入能力。

## 开发和测试

面向开放世界导入、证据保留、LLM 解释、用户批准和可恢复写入的整体设计基线见
[`docs/DealPilot_Agent_Native_Memory_Architecture_V1.md`](docs/DealPilot_Agent_Native_Memory_Architecture_V1.md)。该文档定义了后续实现的统一协议和验收门槛。

最小协议回归（适合每次修改后快速确认）：

```powershell
cd plugin
pnpm install
pnpm run build
pnpm run test:core
```

宿主端到端验收：

```powershell
cd "D:\Ai Native\dealpilot-dsh"
node --check plugin/lib/index.js
node --check plugin/client/client.js
git diff --check
```

当前核心回归覆盖 A2A 工具契约、Workspace/session 持久化、无损 evidence、解释覆盖率、typed change-set、持久化 approval、事务恢复和路径安全；DSH/Univer/浏览器端到端验证在真实运行环境中执行。

## 发布

推送后可使用以下脚本确认构建；如果 GitHub 没有创建对应的 push run，脚本会自动触发 `workflow_dispatch`：

```powershell
.\scripts\trigger-build.ps1
```

推送到 `master` 会触发 `.github/workflows/build.yml`：

1. 安装依赖并构建 host 与 client 运行包。
2. 运行核心协议测试；宿主和浏览器端到端测试按发布环境单独执行。
3. 生成 `dealpilot-dsh-<commit>.tar.gz` 和 `.zip` 构建产物。
4. 将可直接安装的插件同步到 `dist` 分支。

GitHub Actions 页面中的构建 Artifacts 可用于本地安装；Release 页面应使用同一构建产物。

## 当前边界

- WhatsApp Chrome 扩展的消息抓取、草稿批准和输入框插入是本版本唯一未交付的产品闭环。
- DSH 的全局 session catalog 在已有历史 profile 中可能显示历史 DealPilot session；这是当前确认暂缓的宿主限制。新安装或干净 profile 下，DealPilot 业务 UI 只在 `/dealpilot` 挂载。
- 本项目是本地优先单用户工作台，不包含云端账号、团队协作、多设备同步或自动外发消息。

## 目录结构

```text
dealpilot-dsh/
├── plugin/
│   ├── lib/                    # Agent tools 和 HTTP API
│   ├── agent-preset/           # dealpilot-sales preset
│   └── client/                 # /dealpilot 页面 bundle
├── extension/                  # WhatsApp 扩展（后续能力）
├── workspace-template/         # OKF 示例 Workspace
├── docs/                       # Agent-native memory architecture and import integrity baseline
└── tests/                      # 核心协议回归；端到端在真实 DSH 中执行
```
