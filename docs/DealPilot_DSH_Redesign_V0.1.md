# DealPilot on DSH — 功能重设计分析 V0.1

## 0. 核心问题

> 是否一定要 1:1 迁移 Codex 版的功能？还是应该针对 DSH 重新设计？
> 数据层是否一定是 OKF？

**答案：不应该 1:1 迁移。应该以 DSH 的原生能力重新设计。**

---

## 1. 为什么不能 1:1 迁移

Codex 版的 DealPilot 架构是被 Codex 的约束**塑造**出来的，不是被业务需求塑造的：

| Codex 的约束 | 塑造出的 DealPilot 设计 | 这个设计是"不得已"还是"最优"？ |
|---|---|---|
| Codex 是外部 CLI 进程，需要被管理 | Native Host 管理 App Server 生命周期 | **不得已**——DSH 本身就是 Agent Runtime |
| Codex 没有 Web GUI | Dashboard 做成 Chrome 扩展独立页面 | **不得已**——DSH 有 Web GUI + Slot 系统 |
| Codex 工具描述空间有限 | 需要 Skill 文件教 Agent 业务语义 | **不得已**——DSH Tool 的 description 足够 |
| 浏览器和 Agent 之间无法直接通信 | Native Messaging 协议 | **不得已**——DSH 可以暴露 HTTP endpoint |
| Codex 没有持久化会话概念 | OKF 必须承载全部状态 | **部分合理**——但 DSH 有 session 和 storage |
| Codex 没有子代理/工作流 | PRD 中"开放式 Agent 交互"是自己设计的 | **现在 DSH 内置支持** |

**1:1 迁移等于把脚手架也搬进新房子。**

---

## 2. DSH-native 重新设计的原则

### 原则 1：对话即产品

Codex 版有三个界面：Codex Chat（操作）、Dashboard（观察）、Side Panel（沟通现场）。用户要在三个界面之间切换。

DSH 版应该只有一个界面：**DSH Web GUI**。Dashboard 是侧边栏，WhatsApp 操作是工具调用结果卡片，对话是主区域。

```
┌──────────────────────────────────────────────────────┐
│  DSH Web GUI                                          │
│  ┌────────────────────────┬─────────────────────────┐│
│  │                        │  DealPilot Panel         ││
│  │  对话区                 │  ┌─────────────────────┐││
│  │                        │  │ 📊 Today  3 逾期 2   │││
│  │  User: 把 Acme 标记为   │  │ 🔴 Acme 认证报价     │││
│  │  高风险，认证延期了     │  │ 🟡 Beta 样品寄送     │││
│  │                        │  └─────────────────────┘││
│  │  Agent: 已更新 Acme     │  ┌─────────────────────┐││
│  │  ┌─────────────────┐   │  │ 📋 最近活动          │││
│  │  │ dealpilot_update │   │  │ 15:30 Acme 风险→高  │││
│  │  │ ✅ 风险: high    │   │  │ 15:28 Beta 新消息   │││
│  │  │ 📝 事件已追加    │   │  └─────────────────────┘││
│  │  └─────────────────┘   │                         ││
│  │                        │  [打开完整工作台]        ││
│  └────────────────────────┴─────────────────────────┘│
└──────────────────────────────────────────────────────┘
```

### 原则 2：用 DSH 原生能力替代自建机制

| DealPilot 需求 | Codex 版自建方案 | DSH 原生方案 |
|---|---|---|
| 长期任务追踪 | Action 生命周期（planned→active→done/blocked/cancelled） | **DSH Goal**（goal 就是 Action，goal 有状态、可暂停、可恢复） |
| 复杂多步操作 | "开放式 Agent 交互"（SKILL.md 中的循环描述） | **DSH Subagent + Workflow**（天然支持观察→规划→执行→确认→重规划） |
| 批量导入客户 | Agent 在对话中逐个处理 | **DSH Workflow**（fan-out 并行处理 50 个客户） |
| 跟进提醒 | Action 的 due_at + Today 确定性计算 | **DSH Goal 的 due_at + Today 计算**（逻辑相同，但 goal 有内置通知） |
| 用户确认 | "确认规则"（高影响操作需要确认） | **DSH ask_user_question**（内置确认机制） |
| 操作可追溯 | business-events.jsonl + user-commands.jsonl | **DSH Session 事件**（每次 tool/call 自动记录） |

### 原则 3：数据层重新评估

OKF 的原始动机：

> "Markdown + YAML + JSONL 能否在没有数据库的情况下承载 10-50 个客户和 10-20 个活跃 Deal？"

这是 Codex 时代的约束。在 DSH 上，我们重新评估：

| 数据需求 | OKF 方案 | 在 DSH 上是否仍然最优？ |
|---|---|---|
| 权威业务状态 | Markdown + YAML frontmatter | ✅ **仍然最优**——人类可读、Git 可追踪、LLM 可直接理解 |
| 业务事件 | JSONL（business-events.jsonl） | ⚠️ **可以简化**——DSH session 事件已自动记录 tool/call |
| 用户命令证据 | JSONL（user-commands.jsonl） | ⚠️ **可以去掉**——DSH session 中 user/message 事件就是原始证据 |
| 快照查询 | 每次重新解析所有 .md 文件 | ⚠️ **可以加缓存**——DSH 有 `storages/` 可以存结构化索引 |
| 全文搜索 | grep 遍历文件 | ✅ **DSH 的 grep 工具就是干这个的** |

---

## 3. 重新设计的功能架构

### 3.1 核心概念映射

```
Codex 版概念          →  DSH 版概念
─────────────────────────────────────────
Customer             →  Customer（不变，但元数据可以存 storage）
Deal                 →  Deal（不变，但可以关联 DSH Goal）
Action               →  DSH Goal（生命周期天然匹配）
Action.due_at        →  Goal 的 target date
Action.status        →  Goal 状态（active/blocked/done/cancelled）
Today View           →  Goal 列表 + 确定性筛选
Funnel               →  从 Deal 文件确定性计算
Activity Feed        →  DSH Session 事件 + business-events.jsonl
WhatsApp 证据         →  文件存储（不变）
```

### 3.2 工具重设计（6 个工具，而不是 14 个）

不是 1:1 迁移每个 `dealpilot_customer_create`、`dealpilot_customer_update`...，而是用**更少、更通用的工具**：

| 工具 | 功能 | 替代 Codex 版的哪些工具 |
|------|------|------------------------|
| `dealpilot_snapshot` | 确定性快照（Today/Customers/Deals/Funnel/Activity） | 不变，核心 |
| `dealpilot_write` | **通用写入**：创建/更新 Customer、Deal、Action | 替代 customer_create/update/archive, deal_create/update/set_stage/set_risk, action_create/update |
| `dealpilot_action_transition` | **Action 状态机**：complete/cancel/block/reopen/schedule | 替代 action_complete/cancel/block/schedule |
| `dealpilot_import` | **批量导入**：从 sources/inbox/ 解析客户资料 | 替代导入流程中 Agent 的手动操作 |
| `dealpilot_whatsapp` | **WhatsApp 集成**：拉取当前对话消息、生成草稿 | 替代 evidence.append + turn.start |
| `dealpilot_search` | **搜索**：按名称/来源/阶段/风险搜索客户和交易 | 替代 Agent 用 grep 手动搜索 |

**从 14 个工具减少到 6 个。** 每个工具的 description 更丰富，Agent 理解成本更低。

### 3.3 用 DSH Goal 替代 Action 生命周期

这是最大的设计变化。Codex 版的 Action 生命周期：

```
planned → active → done
                 → blocked → active
                 → cancelled
                 → archived
```

DSH 的 Goal 系统天然支持这个：

```
Goal 创建（planned）
  → Goal 激活（active）
    → Goal 完成（done）    —— 对应 action.complete
    → Goal 暂停（blocked） —— 对应 action.block
    → Goal 取消（cancelled）—— 对应 action.cancel
```

**好处**：
- 不需要自己实现 Action 状态机，DSH Goal 自带
- Goal 有 `due_at` → 对应 Action 的到期日
- Goal 可以关联到 Deal（goal 的 metadata）
- Goal 的完成/取消/阻塞会自动记录在 session 中
- Today 视图 = 查询当前活跃 Goal + 确定性筛选

**但有一个问题**：DSH Goal 是会话级别的，不能跨会话持久化。所以 Action 的核心状态（status, due_at, ref）仍然需要存在 OKF 文件中，Goal 是对它的**运行时投影**。

### 3.4 用 Subagent 处理复杂操作

Codex 版 PRD 3.5 描述的"开放式 Agent 交互"：

> 1. 观察 Workspace 和输入资料
> 2. 将目标拆成当前可执行的工具调用
> 3. 在需要用户选择或确认时暂停
> 4. 对部分成功、失败进行重新规划
> 5. 返回事实、推断、已执行变更、待确认事项

这在 DSH 中直接用 **Subagent + Workflow** 实现：

```javascript
// 用户说："把这批展会客户导入，去重后找出德国渠道商，给高潜客户安排下一步"
// → DSH 自动创建一个 workflow：

phase("读取客户资料");
const files = await agent("读取 sources/inbox/ 中的所有文件");

phase("解析客户信息");
const customers = await agent("从文件中提取客户信息，返回结构化列表", {
  schema: { type: "array", items: { type: "object" } }
});

phase("去重和匹配");
const deduped = await agent("将新客户与现有 OKF 客户去重，标记重复", {
  schema: { type: "object" }
});

phase("筛选德国渠道商");
const germanPartners = await agent("筛选出德国市场的渠道商客户", {
  schema: { type: "array" }
});

phase("安排下一步行动");
for (const customer of germanPartners.filter(c => c.priority === 'high')) {
  await agent(`为 ${customer.name} 创建下一步行动，理由是展会接触`);
}
```

不需要在 Skill 文件中用自然语言描述这个流程——DSH 的 workflow 引擎直接编排。

### 3.5 Dashboard 重新设计

DSH 的 Slot 系统支持多种 UI 注入方式。Dashboard 可以是：

1. **侧边栏面板**（`sidebar.section`）：始终可见的 Today 摘要
2. **独立页面**（`page.content`）：完整的 Customers/Deals/Funnel 视图
3. **工具调用卡片**（`tool.call.toolview`）：`dealpilot_snapshot` 调用后直接展示

```
侧边栏（始终可见）：
┌──────────────────┐
│ 🔴 逾期 2         │
│ 🟡 今日 3         │
│ 🟠 风险 1         │
│ [打开完整工作台]   │
└──────────────────┘

点击后 → 全屏工作台页面：
┌────────────────────────────────────────┐
│ [Today] [Customers] [Deals] [Funnel]   │
│                                        │
│  Acme Corp / 认证报价                   │
│  逾期 2天 · P1 · 高风险                 │
│  行动：发送更新报价                     │
│  ...                                   │
└────────────────────────────────────────┘
```

---

## 4. 数据层重新设计

### 4.1 三层数据架构

```
┌─────────────────────────────────────────┐
│  Layer 1: OKF（权威业务状态）             │
│  knowledge/                             │
│  ├ customers/*.md    ← 客户主数据        │
│  ├ deals/*.md        ← 交易主数据        │
│  ├ actions/*.md      ← 行动主数据        │
│  ├ contacts/*.md     ← 联系人            │
│  └ products/*.md     ← 产品              │
│                                          │
│  格式：Markdown + YAML frontmatter       │
│  特点：人类可读、Git 可追踪、LLM 可理解    │
│  不变：这是唯一权威数据源                  │
├─────────────────────────────────────────┤
│  Layer 2: DSH Storage（结构化索引）       │
│  ~/.dsh/storages/dealpilot/             │
│  ├ customers.json    ← 客户索引          │
│  ├ deals.json        ← 交易索引          │
│  ├ actions.json      ← 行动索引          │
│  └ snapshot-cache.json ← 快照缓存       │
│                                          │
│  格式：JSON                               │
│  特点：快速查询、无需解析 Markdown         │
│  生成：每次 OKF 写入后自动更新             │
│  用途：Dashboard 渲染、Today 计算         │
├─────────────────────────────────────────┤
│  Layer 3: DSH Session（对话历史）         │
│  ~/.dsh/sessions/.../session.jsonl      │
│                                          │
│  格式：JSONL                              │
│  特点：自动记录每次 tool/call             │
│  用途：操作审计、上下文恢复               │
│  不再需要单独的 user-commands.jsonl       │
└─────────────────────────────────────────┘
```

### 4.2 为什么保留 OKF？

- **LLM 友好**：Agent 可以直接 `read` 文件理解业务状态，不需要学习查询语言
- **人类可读**：用户可以直接打开 `.md` 文件查看和修正
- **版本控制**：`git diff` 可以看到每次业务变更
- **零依赖**：不需要安装数据库、不需要迁移脚本
- **移植性**：如果将来换 Agent Runtime，OKF 文件不受影响

### 4.3 为什么加 Storage 索引？

- **性能**：10 个客户时解析 10 个 .md 文件没问题；100 个客户时就需要索引
- **Dashboard 体验**：侧边栏每次刷新都重新解析所有文件太慢
- **写时更新**：每次 OKF 写入后自动更新索引（类似缓存失效策略）

### 4.4 为什么去掉 user-commands.jsonl？

DSH 的 session 文件已经记录了：
- 每次 `user/message`（用户原话）
- 每次 `tool/call`（Agent 调用了哪个工具）
- 每次 `tool/result`（工具返回了什么）

所以不需要单独维护一个"用户命令证据账本"——DSH session 本身就是证据账本。

---

## 5. 新旧对比总结

| 维度 | Codex 版 | DSH 重设计版 | 变化 |
|------|---------|-------------|------|
| **工具数量** | 14 个细粒度工具 | 6 个通用工具 | **减少 57%** |
| **Skill** | 必需（教 Agent 业务语义） | 可选（Tool description 够用） | **简化** |
| **Action 机制** | 自建状态机 + JSONL 事件 | DSH Goal + OKF 主数据 | **用平台能力** |
| **批量操作** | Agent 手动逐个处理 | DSH Workflow 并行编排 | **更快更可靠** |
| **Dashboard** | 独立 Chrome 扩展页面 | DSH Web GUI 侧边栏 + 页面 | **统一界面** |
| **数据层** | OKF 唯一 | OKF + Storage 索引 + Session | **分层优化** |
| **用户命令证据** | 单独 JSONL 文件 | DSH Session 自动记录 | **去重** |
| **WhatsApp 通信** | Native Messaging | HTTP localhost | **更简单** |
| **App Server 管理** | Go Native Host 管理生命周期 | 不需要 | **删除整个组件** |
| **代码量** | ~835行 Go + Skill + 扩展 | ~300行 TS + 轻量扩展 | **减少 60%+** |

---

## 6. 建议的实施路线

### Step 1：验证核心假设（1 天）

在 DSH 中手动测试：
- 用 `read` 工具读取一个 OKF 客户文件，看 Agent 能否理解 YAML frontmatter
- 用 `write` 工具创建一个客户文件，看格式是否正确
- 用 `glob` 工具列出所有客户文件

**如果 Agent 能自然地理解 OKF 格式，说明不需要 Skill。**

### Step 2：实现 Snapshot Tool（1 天）

这是整个系统的核心。移植 Go 版逻辑到 TypeScript，验证：
- 解析 YAML frontmatter
- 确定性计算 Today
- 返回结构化 JSON

### Step 3：实现 Write Tool（1 天）

一个通用写入工具，处理所有 OKF 修改：
- 生成正确的 YAML frontmatter
- 追加 business-events.jsonl
- 更新 Storage 索引

### Step 4：Dashboard 原型（1 天）

在 DSH Web GUI 侧边栏注册一个简单的 Today 面板：
- 调用 `dealpilot_snapshot`
- 渲染 Today 列表
- 提供刷新按钮

### Step 5：对话操作验证（1 天）

端到端测试：
- "把 Acme 标记为高风险" → Agent 调用 `dealpilot_write` → 刷新 Dashboard → 看到变化

**如果这 5 步走通，整个方案就验证通过了。** 然后再做 WhatsApp 集成和批量导入。

---

## 7. 一个关键问题需要你决定

**OKF 文件格式是否保留 YAML frontmatter？**

YAML frontmatter 的优点是结构化，缺点是：
- Agent 写 YAML 时偶尔会格式错误（缩进、引号）
- 需要额外的解析步骤

替代方案：
- **纯 Markdown + 约定标题**：`# title: Acme Corp` `# status: active`，更宽松但更模糊
- **JSON sidecar**：每个 `.md` 旁边放一个 `.json`，结构清晰但文件数翻倍
- **保持 YAML**：现有格式，DSH 的 Agent 写 YAML 的能力需要验证

我的建议：**先保持 YAML**，Step 1 中验证 Agent 写 YAML 的可靠性。如果错误率 > 5%，再考虑替代方案。