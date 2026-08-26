# DealPilot DSH 产品需求文档（PRD）V0.1

> **DSH 路由约定（当前实现）**：`/` 保持原始 DSH 对话页面；`/dealpilot` 是 DealPilot 专属对话工作台，使用固定 `dealpilot-sales` preset、单 Workspace 和业务视图。下文涉及 DealPilot 侧栏、业务上下文和看板时，均指 `/dealpilot`，不表示向 `/` 注入 UI。WhatsApp Chrome 扩展及其实际闭环不在本轮落地范围，相关条目保留为后续能力。

> **一句话定位**：运行在 DeepSeek Harness 上的 AI 原生销售工作台。用户通过 DSH 对话完成客户与交易操作，通过 DSH 侧边栏面板掌握任务、风险和进度。数据以 OKF 文件（Markdown + YAML）保存在本地，一切可追溯。

---

## 0. 文档信息

| 项目 | 内容 |
|---|---|
| 产品名称 | DealPilot（DSH 版） |
| 版本 | V0.1 |
| 文档性质 | DSH-native 重设计版，不等同于 Codex 版的 1:1 迁移 |
| 运行平台 | DeepSeek Harness（`dsh web`） |
| 目标用户 | 独立工作的外贸销售或外贸经理，日常使用 WhatsApp Web，手上有 10-50 个客户 |
| 产品形态 | DSH 插件包（Agent Preset + Tools + Client UI）+ 轻量 Chrome 扩展（仅 WhatsApp） |
| 核心交互 | DSH 对话负责业务操作；DSH 侧边栏负责稳定概览 |
| 数据存储 | OKF（Markdown + YAML frontmatter + JSONL 事件）+ DSH Storage 索引 |
| AI Native 原则 | 用户表达业务目标，DSH Agent 理解并执行；系统自动形成结构化交易状态 |
| Local-first 原则 | 客户资料、交易状态、操作记录全部保存在本地 |

---

## 1. 与 Codex 版的关键差异

**本 PRD 不是 Codex 版（V0.3）的 1:1 迁移。** 以下设计决策是基于 DSH 原生能力重新做出的：

| 决策 | Codex 版 | DSH 版 | 原因 |
|---|---|---|---|
| Agent Runtime | Codex App Server（外部进程，需管理生命周期） | DSH 内置 Agent | DSH 本身就是 Agent Runtime |
| 操作入口 | Codex Chat（独立窗口） | DSH Web GUI 对话区 | 统一界面 |
| 观察入口 | Chrome 扩展独立 Dashboard 页面 | DSH Web GUI 侧边栏面板 | DSH 支持 Slot UI 注入 |
| 沟通现场 | Chrome 扩展 Side Panel + Native Messaging | 轻量 Chrome 扩展 + HTTP localhost | 去掉 Native Messaging 协议 |
| 业务语义 | Codex Skill（SKILL.md） | Tool description（无需单独 Skill） | DSH Tool description 足够承载业务语义 |
| Agent 桥接 | Go Native Host（835 行） | 不需要 | DSH 自带 |
| 行动管理 | 自建 Action 状态机 + JSONL 事件 | DSH Goal + OKF 文件 | 复用平台能力 |
| 复杂操作 | Agent 手工编排 | DSH Subagent + Workflow | 原生并行编排 |
| 工具数量 | 14 个细粒度工具 | 6 个通用工具 | 更少更清晰 |
| 用户命令证据 | 单独 user-commands.jsonl | DSH Session 自动记录 | 去重 |
| 看板性能 | 每次重新解析所有 .md | OKF + Storage 索引缓存 | 更快 |

---

## 2. 产品交互模型

### 2.1 唯一界面：DSH Web GUI

用户只需要打开 `http://127.0.0.1:3080`，一个界面完成所有操作：

```
┌──────────────────────────────────────────────────────────┐
│  DSH Web GUI                               DealPilot 工作台 │
│  ┌─────────────────────────────┬──────────────────────────┐│
│  │                             │  📊 DealPilot             ││
│  │  对话区                      │  ┌──────────────────────┐││
│  │                             │  │ 🔴 逾期 2  🟡 今日 3  │││
│  │  👤 把 Acme 标记为高风险，   │  │ 🟠 风险 1  🔵 待确认 1│││
│  │  认证信息还没确认           │  └──────────────────────┘││
│  │                             │  ┌──────────────────────┐││
│  │  🤖 已更新 Acme Corp：      │  │ 📋 Today              │││
│  │  ┌──────────────────────┐  │  │ 🔴 Acme / 认证报价    │││
│  │  │ dealpilot_write       │  │  │    逾期 2天 · P1     │││
│  │  │ ✅ risk_level: high   │  │  │ 🟡 Beta / 样品寄送   │││
│  │  │ 📝 risk_summary:      │  │  │    今天到期 · P2     │││
│  │  │   认证信息未确认      │  │  │ 🟠 Gamma / 价格谈判  │││
│  │  │ 📋 事件已追加         │  │  │    客户压价 · P1     │││
│  │  └──────────────────────┘  │  └──────────────────────┘││
│  │                             │                          ││
│  │  ───────────────────────   │  [📋 完整工作台]          ││
│  │  👤 WhatsApp 有新消息      │  [🔄 刷新] 15:32          ││
│  │  来自 Beta Ltd...          │                          ││
│  └─────────────────────────────┴──────────────────────────┘│
└──────────────────────────────────────────────────────────┘
```

**三个区域，一个界面**：

| 区域 | 位置 | 功能 | 是否调用 LLM |
|---|---|---|---|
| **对话区** | 左侧主区域 | 自然语言业务操作、复杂查询 | 是 |
| **侧边栏** | 右侧面板 | Today 摘要、最近活动 | 否（确定性读取） |
| **完整工作台** | 点击后展开 | Customers/Deals/Funnel/Activity 全视图 | 否（确定性读取） |

### 2.2 对话区：操作面

用户在 DSH 对话中直接用自然语言完成业务操作，示例：

> "把 Acme 标记为高风险，认证信息还没确认"

DSH Agent 理解意图后：
1. 调用 `dealpilot_snapshot` 确认当前 Acme 状态
2. 调用 `dealpilot_write` 更新 `deals/acme-corp.md` 的 `risk_level` 和 `risk_summary`
3. 自动追加 `business-events.jsonl` 事件
4. 返回操作结果摘要

> "把这份展会客户表导入 DealPilot，去重后找出德国渠道商"

DSH Agent：
1. 调用 `dealpilot_import` 解析 `sources/inbox/` 中的文件
2. 自动去重（对比现有 OKF 客户）
3. 筛选德国市场渠道商
4. 为高潜客户标记优先级
5. 返回处理数量和重点客户

> "今天该做什么？"

DSH Agent：
1. 调用 `dealpilot_snapshot`
2. 返回 Today 视图：逾期、今日、风险、待确认
3. 附带建议优先级

> "Beta 那边有新消息，帮我看看"

DSH Agent：
1. 调用 `dealpilot_whatsapp` 拉取当前 WhatsApp 对话
2. 调用 `dealpilot_snapshot` 获取 Beta 的交易状态
3. 分析新消息，更新 Deal 状态
4. 生成回复草稿

### 2.3 侧边栏：观察面

侧边栏**始终可见**，不调用 LLM，直接从 OKF 文件确定性读取：

```
┌──────────────────────────┐
│  📊 DealPilot             │
│  ┌──────────────────────┐│
│  │ 🔴 逾期 2             ││
│  │ 🟡 今日 3             ││
│  │ 🟠 风险 1             ││
│  │ 🔵 待确认 1           ││
│  └──────────────────────┘│
│  ┌──────────────────────┐│
│  │ 📋 最近               ││
│  │ 15:30 Acme 风险→高   ││
│  │ 15:28 Beta 新消息    ││
│  │ 15:25 Gamma 新建     ││
│  └──────────────────────┘│
│                           │
│  [📋 完整工作台]          │
│  [🔄 刷新] 最后: 15:32   │
│  [⚙ 设置]                │
└──────────────────────────┘
```

### 2.4 完整工作台：详细视图

点击"完整工作台"展开全屏视图，包含五个标签页：

| 标签 | 内容 | 数据来源 |
|---|---|---|
| **Today** | 今日/逾期/风险/待确认行动，含客户名、交易名、到期日、优先级、原因 | OKF actions/*.md 确定性筛选 |
| **Customers** | 客户列表，含来源、关系阶段、市场、ICP、状态、更新时间 | OKF customers/*.md |
| **Deals** | 交易列表，含客户、漏斗阶段、优先级、风险、当前行动 | OKF deals/*.md |
| **Funnel** | 各阶段数量分布（new→won/lost） | OKF deals/*.md 确定性计算 |
| **Activity** | 最近 30 条业务事件 | business-events.jsonl |

每个视图支持搜索、筛选、排序。点击客户或交易名称打开**只读详情抽屉**，不调用 LLM。

### 2.5 读写边界

| 用户行为 | 是否调用 LLM | 状态变化 |
|---|---|---|
| 打开或刷新侧边栏 | 否 | 无 |
| 搜索、筛选、切换视图 | 否 | 无 |
| 在对话中新增或修改业务对象 | 是 | 更新 OKF + 事件 |
| 在对话中批量导入 | 是 | 批量写入 OKF + 事件 |
| 在对话中询问复杂问题 | 是 | 只在用户明确请求时推理 |
| 处理 WhatsApp 新消息 | 是 | 更新 Deal、Action、事件 |
| 设置跟进日期 | 是 | 更新 Action 的 due_at |

---

## 3. 产品组成

DSH 版的 DealPilot 由四个组件构成：

### 3.1 DSH 插件包（`dealpilot-dsh`）

核心组件，安装在 DSH web profile 中：

```
dealpilot-dsh/
├── package.json              # NPM 包 + dsh.bundle + dsh.client
├── cordis.patch.yml          # 插入到 DSH composition
├── lib/                      # Host 端 = 6 个 DealPilot Tools
│   ├── index.ts              # 插件入口
│   ├── snapshot.ts           # dealpilot_snapshot
│   ├── write-tool.ts         # dealpilot_write
│   ├── action-tool.ts        # dealpilot_action_transition
│   ├── import-tool.ts        # dealpilot_import
│   ├── search-tool.ts        # dealpilot_search
│   ├── whatsapp-tool.ts      # dealpilot_whatsapp
│   └── okf-utils.ts          # OKF 读写公共函数
├── client/                   # Client 端 = Dashboard UI
│   ├── client.ts             # 客户端入口，注册 Slot
│   └── dashboard/
│       ├── Sidebar.tsx        # 侧边栏 Today 摘要
│       ├── TodayView.tsx      # 完整 Today 视图
│       ├── CustomersView.tsx  # 客户列表
│       ├── DealsView.tsx      # 交易列表
│       ├── FunnelView.tsx     # 漏斗图
│       └── ActivityView.tsx   # 活动时间线
└── agent-preset/             # Agent Preset 配置
    ├── agent.cordis.yml      # 工具注册 + persona
    └── preset.yml            # 预设名称/描述
```

### 3.2 OKF Workspace 模板

保持不变，从 Codex 版复用：

```
workspace-template/
├── AGENTS.md
├── README.md
├── knowledge/
│   ├── index.md
│   ├── log.md
│   ├── customers/        ← 客户主数据（.md + YAML frontmatter）
│   ├── deals/            ← 交易主数据
│   ├── actions/          ← 行动主数据
│   ├── contacts/         ← 联系人
│   ├── products/         ← 产品
│   └── events/
│       └── business-events.jsonl  ← 业务事件账本
└── sources/
    └── inbox/            ← 待导入资料
```

### 3.3 Chrome 扩展（仅 WhatsApp Side Panel）

大幅简化，只做两件事：
- **DOM 观察**：读取当前 WhatsApp 单聊消息
- **草稿插入**：把 DSH 返回的回复草稿插入 WhatsApp 输入框

通信方式：HTTP POST → DSH localhost（不再使用 Native Messaging）

### 3.4 DSH Session（对话历史）

DSH 自动管理的会话记录，替代 Codex 版的 `user-commands.jsonl`：
- 每次 `user/message`：用户原话自动记录
- 每次 `tool/call`：Agent 调用的工具和参数自动记录
- 每次 `tool/result`：工具返回结果自动记录

---

## 4. 六个核心工具

### 4.1 `dealpilot_snapshot` — 确定性快照

**描述**：读取 OKF Workspace 并返回确定性快照。包含 Today、Customers、Deals、Funnel、Activity 和 Warnings。纯读取，不调用 LLM，不修改任何文件。

**参数**：`workspacePath?`（可选，默认使用配置的路径）

**返回**：结构化 JSON（Snapshot 对象）

### 4.2 `dealpilot_write` — 通用写入

**描述**：创建或更新 Customer、Deal、Action。自动处理 YAML frontmatter 格式、追加 business-events.jsonl 事件、更新 Storage 索引。支持的操作类型由 `operation` 参数指定。

**参数**：
- `operation`：`create` | `update` | `archive` | `merge`（当前仅支持 customer 合并）
- `entity`：`customer` | `deal` | `action`
- `ref?`：更新/归档时的目标引用
- `source_ref?`：合并时的来源客户引用；目标 `ref` 保留，来源记录会归档并记录 `merged_into`
- `fields`：要写入的字段（JSON 对象）

**返回**：操作结果 + 新 ref

### 4.3 `dealpilot_action_transition` — 行动状态转换

**描述**：对 Action 执行状态转换：complete（完成）、cancel（取消）、block（阻塞）、reopen（重新打开）、schedule（安排跟进）。自动校验转换合法性（如每个 Deal 最多一个 active Action），追加事件。

**参数**：
- `ref`：Action 引用
- `transition`：`complete` | `cancel` | `block` | `reopen` | `schedule`
- `reason?`：原因
- `due_at?`：安排跟进时的到期日
- `evidence?`：完成证据

**返回**：操作结果

### 4.4 `dealpilot_import` — 批量导入

**描述**：从 `sources/inbox/` 读取文件，解析客户/联系人/交易信息，自动去重，批量写入 OKF。支持 CSV、Markdown 和纯文本格式。

**参数**：
- `sourcePath?`：导入文件路径（默认 `sources/inbox/`）
- `sourceCategory`：来源类别（`exhibition` | `referral` | `import` | `outbound`）
- `autoDedup`：是否自动去重（默认 true）

**返回**：处理数量、创建的客户列表、重复项、警告

### 4.5 `dealpilot_search` — 搜索

**描述**：按名称、来源、市场、阶段、风险等级搜索客户和交易。支持模糊匹配。

**参数**：
- `query`：搜索关键词
- `entity`：`customer` | `deal` | `all`
- `filters?`：`{ source_category?, market?, funnel_stage?, risk_level?, status? }`

**返回**：匹配的客户/交易列表

### 4.6 `dealpilot_whatsapp` — WhatsApp 集成

**描述**：与 Chrome 扩展通信，拉取当前 WhatsApp 对话消息，分析内容，更新关联的 Deal 状态，生成回复草稿。

**参数**：
- `action`：`fetch`（拉取消息）| `analyze`（分析并更新）| `draft`（生成草稿）
- `conversationKey?`：对话标识

**返回**：消息内容、关联的 Deal/Action、回复草稿

---

## 5. 数据层

### 5.1 三层架构

| 层 | 位置 | 格式 | 用途 | 读写 |
|---|---|---|---|---|
| **OKF** | `workspace/knowledge/` | Markdown + YAML + JSONL | 权威业务状态 | DSH Tool 读写 |
| **Storage 索引** | `~/.dsh/storages/dealpilot/` | JSON | 快速查询缓存 | 写时更新，读时优先 |
| **DSH Session** | `~/.dsh/sessions/` | JSONL（zstd 压缩） | 对话历史 = 操作证据 | DSH 自动管理 |

### 5.2 OKF 仍然是唯一权威

- DSH Agent 用 `read` 工具直接读取 `.md` 文件理解业务状态
- DSH Agent 用 `dealpilot_write` 工具写入 `.md` 文件
- 用户可以直接打开 `.md` 文件查看和手动修正
- `git init && git add . && git commit` 即可版本控制

### 5.3 Storage 索引是性能缓存

```json
// ~/.dsh/storages/dealpilot/customers.json
[
  {
    "ref": "knowledge/customers/acme-corp.md",
    "title": "Acme Corp",
    "status": "active",
    "source_category": "exhibition",
    "relationship_stage": "opportunity",
    "market": "Germany",
    "icp_fit": "fit",
    "priority": "P1",
    "updated_at": "2026-08-05T15:30:00Z"
  }
]
```

索引在每次 `dealpilot_write` 成功后自动更新。侧边栏和 Dashboard 优先读索引（快速），仅在索引缺失时回退到解析 OKF 文件。

---

## 6. Action 生命周期

### 6.1 用 DSH Goal 管理 Action 运行时状态

DSH Goal 是 Action 的**运行时投影**：

```
Action 文件（OKF）          DSH Goal（运行时）
─────────────────────      ─────────────────────
status: active        ←→   Goal 激活
status: done          ←→   Goal 完成
status: blocked       ←→   Goal 暂停
status: cancelled     ←→   Goal 取消
due_at: 2026-08-05    ←→   Goal 到期日
```

Goal 提供会话内的通知和追踪，OKF 文件提供跨会话的持久化。

### 6.2 Action 写入规则

- 每个 Deal 最多一个 `active` Action
- `dealpilot_action_transition` 自动校验此规则
- 完成 Action 前检查全部完成条件
- 部分完成时保留或迁移剩余条件到新 Action
- 所有状态转换追加 `business-events.jsonl`

---

## 7. Agent 工作契约

### 7.1 DSH Agent 的可用能力

DSH Agent 拥有以下能力来完成 DealPilot 业务操作：

| 能力 | 来源 | 用途 |
|---|---|---|
| 文件读取 | DSH `read` 工具 | 读取 OKF 文件、sources/inbox/ |
| 文件搜索 | DSH `glob`/`grep` 工具 | 搜索客户文件、查找引用 |
| 确定性快照 | `dealpilot_snapshot` | 获取全局业务状态 |
| 通用写入 | `dealpilot_write` | 创建/更新/归档业务对象 |
| 行动转换 | `dealpilot_action_transition` | 完成/取消/阻塞/重开/安排 |
| 批量导入 | `dealpilot_import` | 解析和导入客户资料 |
| 搜索 | `dealpilot_search` | 按条件搜索客户和交易 |
| WhatsApp | `dealpilot_whatsapp` | 拉取消息、生成草稿 |
| 用户确认 | DSH `ask_user_question` | 高影响操作确认 |
| 目标追踪 | DSH `goal` | 长期行动追踪 |
| 批量编排 | DSH `workflow` | 复杂多步操作并行处理 |

### 7.2 Agent 行为约束

Agent 必须遵守：
1. **事实与推断分离**：已确认事实、推断、未知必须明确标记
2. **证据可追溯**：每项修改记录来源和原因
3. **写入幂等**：同一操作不重复写入
4. **部分完成不丢失**：未完成的条件迁移到新 Action
5. **高影响确认**：归档、合并、成交、失单、金额确认需要用户确认
6. **对外不发送**：回复草稿只插入 WhatsApp 输入框，不自动发送

---

## 8. 用户场景

### 场景 A：建立客户池

```
用户把展会名单放入 sources/inbox/，在 DSH 对话中说：
"把这些展会客户导入 DealPilot"

Agent：
1. 调用 dealpilot_import 解析文件
2. 识别客户名称、联系人、来源
3. 去重（对比现有 OKF）
4. 批量写入 customers/*.md
5. 返回："已导入 12 个客户，其中 2 个与现有客户重复已合并，
   德国渠道商 3 个已标记为高潜。建议优先联系 Acme Corp 和 Beta Ltd。"
```

### 场景 B：打开侧边栏

```
用户打开 DSH Web GUI → 侧边栏自动显示 Today 摘要
侧边栏不调用 LLM，直接从 Storage 索引读取：
- 逾期 2 个（Acme 认证报价、Gamma 价格谈判）
- 今日 3 个（Beta 样品寄送、...）
- 风险 1 个（Delta 交期未确认）
- 待确认 1 个（Epsilon 报价确认）

点击 [完整工作台] → 展开全屏视图，可切换标签页
点击 [刷新] → 重新读取索引，不调用 LLM
```

### 场景 C：对话修改后看板更新

```
用户在 DSH 对话中说：
"把 Acme 项目标记为高风险，认证信息还没确认"

Agent：
1. 调用 dealpilot_write(operation: update, entity: deal, ref: "knowledge/deals/acme-corp.md", fields: {risk_level: "high", risk_summary: "认证信息未确认"})
2. 自动追加 business-events.jsonl
3. 更新 Storage 索引

用户点击侧边栏 [刷新] → 立即看到 Acme 出现在风险列表中
```

### 场景 D：WhatsApp 推动交易

```
用户打开 WhatsApp Web，启用 DealPilot Chrome 扩展

扩展：
1. 读取当前 WhatsApp 单聊消息
2. HTTP POST → DSH localhost:3080/api/dealpilot/whatsapp

DSH Agent：
1. 调用 dealpilot_whatsapp(action: fetch)
2. 调用 dealpilot_snapshot 获取关联客户状态
3. 分析新消息内容
4. 调用 dealpilot_write 更新 Deal 状态
5. 调用 dealpilot_whatsapp(action: draft) 生成回复草稿

扩展展示：
- 交易快照（客户、阶段、风险）
- 新消息分析
- 回复草稿（用户可修改）
- [批准插入] → 草稿进入 WhatsApp 输入框
- [设置跟进] → 用户选择 1/3/7 天或自定义日期
```

### 场景 E：第二天继续工作

```
用户打开 DSH Web GUI → 侧边栏自动显示 Today：
- 逾期：Gamma 价格谈判（到期 8月4日）
- 今日：Epsilon 报价确认（到期 8月5日）
- 风险：Acme 认证延期

用户在对话中说：
"Gamma 那边客户回复了，接受报价，把 Gamma 标记为成交"

Agent：
1. 调用 dealpilot_write(operation: update, entity: deal, ref: "knowledge/deals/gamma.md", fields: {funnel_stage: "won"})
2. 调用 dealpilot_action_transition(ref: "knowledge/actions/gamma-follow-up.md", transition: "complete", evidence: "客户已接受报价")

刷新侧边栏 → Gamma 不再出现在 Today 中
```

---

## 9. MVP 验收标准

### 9.1 功能门槛

- [x] 用户能把真实业务文件放入 `sources/inbox/`，通过对话导入并生成 OKF
- [x] 用户无需连接 WhatsApp，即可从 10-50 个客户生成客户池
- [x] 用户无需直接编辑 Markdown，能通过对话纠正客户和 Deal
- [x] 用户能通过对话新增、修改、归档和合并 Customer，以及新增、修改、归档 Deal
- [x] 用户能通过对话完成、取消、阻塞和安排 Action
- [x] 侧边栏能不调用 LLM 显示 Today 摘要
- [x] 完整工作台能显示 Customers、Deals、Funnel、Activity
- [x] 工作台刷新后反映最近一次对话写入
- [x] Today 结果在相同 OKF 状态下可重复计算
- [ ] 当前 WhatsApp 对话可关联到 OKF 中的客户和 Deal
- [ ] 新消息可更新 Deal 状态
- [ ] 用户能查看证据、批准草稿并插入 WhatsApp 输入框
- [x] 重启 DSH 后业务状态仍可从 OKF 恢复

### 9.2 性能门槛

- [x] 20 个活跃 Deal 的 Snapshot 在普通设备上 < 1 秒
- [x] 侧边栏打开后不启动 LLM Turn
- [x] 单个无效概念文件不导致整个 Snapshot 失败
- [x] DSH 不可用时，历史 OKF 仍可直接读取

### 9.3 安全门槛

- [x] 对外消息默认由用户最终发送（0 次自动发送）
- [x] 归档、合并、成交、失单需要用户确认
- [x] 金额、交期、身份冲突不能静默确认
- [x] Workspace 由用户在 DSH Workspace Registry 中显式选择

---

## 10. MVP 不包含

- 自动拉取或爬取新客户
- 邮件、Telegram、LinkedIn 等第二沟通平台
- 团队协作和多设备同步
- SQLite 或其他数据库
- 完整销售预测和 BI
- 自动发送消息
- 云端后台和账号体系
- 多个 Agent Runtime 支持

---

## 11. 成功指标

| 指标 | 通过信号 | 失败信号 |
|---|---|---|
| 知识初始化 | 4/5 用户在 30 分钟内形成可用客户池 | 多数用户因文件或知识结构卡住 |
| 对话写入 | 80% 常见修改无需用户直接编辑文件 | 用户频繁打开 Markdown 修正 |
| 侧边栏价值 | 4/5 用户能在 30 秒内说清今天和高风险事项 | 仍需向 Agent 询问全局状态 |
| 行动采用率 | 60% 以上被批准或轻度修改后采用 | 多数行动被拒绝或重写 |
| Today 处理率 | 40% 以上 Today 项被完成、延期或取消 | Today 长期积压且状态失真 |
| 未授权外发 | 0 次 | 出现任何自动发送即停止 |

---

## 12. 版本关系

- V0.1 是 DSH-native 重设计版，不等同于 Codex 版 V0.3 的迁移
- 从 Codex 版继承的核心设计：OKF 数据格式、业务对象语义、确认规则、MVP 边界
- 相比 Codex 版的新设计：统一界面、DSH Goal 替代 Action 状态机、6 工具替代 14 工具、Storage 索引、去掉 Native Host
- 如果 DSH 平台发生重大变化，本 PRD 需要重新评估
