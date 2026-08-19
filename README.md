# DealPilot DSH

> AI 原生销售工作台 — 纯 DSH Cordis 插件。
> 对话管理客户与交易，独立 Dashboard 掌握全局。

## 架构

**纯插件，零侵入。** 不需要独立 Agent Preset，安装后标准 Agent 自动获得 6 个业务工具。

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
│   └── client/                 ← Dashboard UI
│       ├── client.ts           ← 客户端入口（待开发）
│       └── dashboard.html      ← 独立看板页面 ✅
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

### 方式 2：独立 Dashboard（方案 B）

安装后访问 **`http://127.0.0.1:3080/dealpilot`**

5 个标签页：Today · 客户 · 交易 · 漏斗 · 活动，纯前端渲染，不调 LLM。

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

### 3. 准备 Workspace

```powershell
Copy-Item -Recurse workspace-template D:\Ai Native\dealpilot-workspace
```

### 4. 启动

```powershell
dsh web
```

- 对话：直接在标准 Agent 中用 `dealpilot_*` 工具
- 看板：打开 `http://127.0.0.1:3080/dealpilot`

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
- [x] S8: Dashboard 独立页面
- [ ] S9: Chrome 扩展
- [ ] S10: 端到端测试