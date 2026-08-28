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
cd D:\Ai Native\dealpilot-dsh\plugin
pnpm install
pnpm exec tsc
dsh plugin --profile web add .
```

### 启动

```powershell
dsh web --no-open
```

通用文件上传由随 DealPilot 一起安装的 `dsh-file-upload` 提供；办公文件由 `dsh-univer-office`
导入为隔离工作簿，在会话内预览、编辑、校验并导出。客户资料写回仍经过 DealPilot 的去重、预览和确认流程。

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
- 客户资料写回：从已审阅工作簿生成导入预览，去重后确认写入
- 客户/交易/行动的创建、更新、归档和确认流程
- Action 的完成、取消、阻塞、重开和安排
- Goal/Workflow 运行时投影
- Workspace 快照导出和归档

业务视图中的写入操作先展示变更预览，得到明确确认后才写入 OKF，并追加业务事件。

## Agent 和工具

`/dealpilot` 新建的会话固定使用 `dealpilot-sales`：

| 工具 | 能力 |
| --- | --- |
| `dealpilot_snapshot` | 读取 Today、客户、交易、漏斗、行动和活动快照 |
| `dealpilot_write` | 创建、更新、归档 Customer/Deal/Action；支持 Customer 合并 |
| `dealpilot_action_transition` | 完成、取消、阻塞、重开或安排 Action |
| `dealpilot_ingest` | 将当前 session 附件或 Workspace 文件转换为 canonical import JSON |
| `dealpilot_import_preview` / `dealpilot_import_commit` | 对 canonical JSON 预览、去重并在确认后写入客户或交易 |
| `dealpilot_feedback_*` | 生成脱敏反馈草稿，并在确认后打开 GitHub Issue |
| `dealpilot_search` | 按名称模糊搜索，并按市场、阶段、风险等字段筛选 |
| `dealpilot_whatsapp` | 保留工具协议；Chrome 扩展实际闭环暂未包含 |

所有业务工具都从当前 DealPilot session 读取 Workspace。`dealpilot_ingest` 的 `source` 支持 `session_attachment`（当前 session 的附件）和 `workspace_file`（当前 Workspace 内的相对路径）；路径会经过真实路径边界校验，并复制到 Import Job 专属归档目录。没有绑定 Workspace 时，工具会返回“请先选择 DealPilot Workspace”。高影响操作必须使用一次性确认 token，系统不会自动发送外部消息。

## Workspace 数据

Workspace 使用 OKF 文件作为权威数据源，Storage index 用于加速查询：

```text
<workspace>/
├── .dsh/workspace.json
├── knowledge/
│   ├── customers/*.md
│   ├── deals/*.md
│   ├── actions/*.md
│   ├── contacts/*.md
│   ├── products/*.md
│   └── events/business-events.jsonl
├── sources/inbox/              # 待导入资料
└── storage/indexes/            # 查询索引和 DealPilot runtime
```

真实路径由 DSH Workspace Registry 解析，不返回给浏览器，也不应该写入对话内容。

## HTTP API

插件提供以下页面级接口：

```text
GET  /api/dealpilot/workspaces
POST /api/dealpilot/workspaces/inspect
POST /api/dealpilot/workspaces/initialize
POST /api/dealpilot/session
GET  /api/dealpilot/session/:id
POST /api/dealpilot/session/:id/workspace
GET  /api/dealpilot/sessions?workspaceId=...
GET  /api/dealpilot/snapshot?workspaceId=...
GET  /api/dealpilot/export?workspaceId=...
```

兼容接口 `/api/dealpilot/bootstrap`、`/customers`、`/deals`、`/actions`、`/events`、`/weekly-review`、`/risk` 和 `/stalled` 仍然保留。

## 开发和测试

```powershell
cd plugin
pnpm install
pnpm exec tsc --noEmit
cd ..
node --test tests/*.test.mjs
node --check plugin/client/client.js
git diff --check
```

当前验收覆盖 A2A 工具契约、Workspace/session 持久化、导入预览和去重、写入确认、Customer merge、搜索筛选、Goal/Workflow、20 个 Deal 性能、路径安全、损坏文件容错以及 Playwright 浏览器交互。

## 发布

推送后可使用以下脚本确认构建；如果 GitHub 没有创建对应的 push run，脚本会自动触发 `workflow_dispatch`：

```powershell
.\scripts\trigger-build.ps1
```

推送到 `master` 会触发 `.github/workflows/build.yml`：

1. 安装依赖并编译 TypeScript。
2. 运行全部 Node 测试和 Chromium 测试。
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
├── docs/                       # PRD、数据契约和实现规范
└── tests/                      # Node + Playwright 验收测试
```
