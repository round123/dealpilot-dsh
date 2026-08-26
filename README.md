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
- pnpm 9 或更高版本

### 安装插件

推荐直接让 DSH profile 从 GitHub 安装 `dist` 分支。这样 pnpm 会在 profile 中解析并安装插件的生产依赖：

```powershell
dsh plugin --profile web add github:round123/dealpilot-dsh#dist
```

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
- 导入中心：CSV、Markdown 表格和纯文本预览、去重、确认写入
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
| `dealpilot_artifact_*` | 上传资料、检查元数据和 XLSX 工作表，不暴露本地路径 |
| `dealpilot_import_preview` / `dealpilot_import_commit` | 对 Artifact 预览、去重并在确认后导入 CSV、Markdown、纯文本或 XLSX |
| `dealpilot_feedback_*` | 生成脱敏反馈草稿，并在确认后打开 GitHub Issue |
| `dealpilot_search` | 按名称模糊搜索，并按市场、阶段、风险等字段筛选 |
| `dealpilot_whatsapp` | 保留工具协议；Chrome 扩展实际闭环暂未包含 |

所有业务工具都从当前 DealPilot session 读取 Workspace。客户端不能传入任意绝对路径；文件先进入当前 Workspace 的 Artifact 存储，再由导入工具读取。没有绑定 Workspace 时，工具会返回“请先选择 DealPilot Workspace”。高影响操作必须使用一次性确认 token，系统不会自动发送外部消息。

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
POST /api/dealpilot/import/preview
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
