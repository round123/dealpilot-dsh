# DealPilot DSH

> AI 原生销售工作台 — 纯 DSH Cordis 插件。
> `/` 保持原始 DeepSeek Harness 对话体验；`/dealpilot` 提供固定销售 Agent、单 Workspace 和业务看板的原生 DSH 对话工作台。

## 架构

**纯插件，零侵入。** DealPilot 使用独立的 `dealpilot-sales` Agent preset；默认 DSH 会话和页面不被修改。

```
dealpilot-dsh/
├── plugin/                     ← DSH Cordis 插件
│   ├── package.json
│   ├── cordis.patch.yml
│   ├── tsconfig.json
│   ├── lib/                    ← 6 个工具 (TypeScript)
│   │   ├── index.ts            ← 入口：注册工具 + HTTP 路由
│   │   ├── okf-utils.ts        ← OKF 读写 + 工作区自动检测
│   │   ├── snapshot.ts
│   │   ├── write-tool.ts
│   │   ├── action-tool.ts
│   │   ├── import-tool.ts
│   │   ├── search-tool.ts
│   │   └── whatsapp-tool.ts
│   ├── agent-preset/           ← dealpilot-sales Agent preset
│   └── client/                 ← /dealpilot 路由级 UI
│       ├── client.ts           ← 仅在 /dealpilot 增强原生 DSH 页面
│       ├── dealpilot-shell.html ← /dealpilot 页面 Shell
│       └── dashboard.html      ← 旧版兼容页面
├── docs/                       ← 设计文档
├── extension/                  ← Chrome 扩展（待开发）
└── workspace-template/         ← OKF Workspace 模板
```

## 两种使用方式

### 方式 1：对话查询（方案 C）

在 DSH 对话中直接用自然语言操作：

> "帮我看看今天的任务"
> "搜索德国市场的客户"
> "把 Acme 标记为高风险"

Agent 调用 `dealpilot_*` 工具，返回格式化结果。

### 方式 2：DealPilot 工作台

安装后访问 **`http://127.0.0.1:3080/dealpilot`**。首次进入必须选择一个 DSH Workspace；已有 DealPilot 文件会自动复用，空 Workspace 可在页面中显式初始化。进入后新建对话自动绑定 `dealpilot-sales`，默认 `/` 不受影响。

DealPilot 页面复用原生 DSH 对话作为主区域，并在右侧提供客户、交易和任务业务视图。默认对话页本身不被插件修改。

## 快速开始

### 1. 编译

```powershell
cd plugin
pnpm install
pnpm exec tsc
```

### 2. 安装插件

```powershell
dsh plugin --profile web add dealpilot-dsh
```

或在 web profile 的 `package.json` 中添加：

```json
"dependencies": { "dealpilot-dsh": "file:../dealpilot-link" },
"dsh": { "profile": { "bundles": [..., "dealpilot-dsh"] } }
```

### 3. 启动

```powershell
dsh web
```

- 对话：直接在标准 Agent 中用 `dealpilot_*` 工具
- 默认对话：`http://127.0.0.1:3080/`（不注入 DealPilot UI）
- DealPilot 对话工作台：`http://127.0.0.1:3080/dealpilot`

## 六个核心工具

| 工具 | 功能 |
|------|------|
| `dealpilot_snapshot` | 确定性快照（Today/Customers/Deals/Funnel/Activity） |
| `dealpilot_write` | 通用写入（创建/更新/归档 Customer/Deal/Action） |
| `dealpilot_action_transition` | Action 状态转换（complete/cancel/block/reopen/schedule） |
| `dealpilot_import` | 批量导入客户资料（CSV/Markdown/Text） |
| `dealpilot_search` | 搜索客户和交易 |
| `dealpilot_whatsapp` | WhatsApp 集成（拉取消息、分析、生成草稿） |

## 开发状态

- [x] S1: okf-utils.ts
- [x] S2: snapshot.ts
- [x] S3: write-tool.ts
- [x] S4: action-tool.ts
- [x] S5: import-tool.ts
- [x] S6: search-tool.ts
- [x] S7: whatsapp-tool.ts
- [x] S8: `/dealpilot` 原生 DSH 对话工作台
- [ ] S9: Chrome 扩展
- [x] S10: A2A 与真实 Web 端到端测试
- [x] S11: workspace 自动初始化与 bootstrap API
- [x] S12: 路由级业务导航和工具结果视图

## 产品化方案

DealPilot 的产品化路线、workspace 自动初始化、Harness 对话复用和非侵入性约束见：

[产品化方案 V0.1](docs/DealPilot_Productization_Plan_V0.1.md)
