# DealPilot DSH 数据契约 V0.1

> 本文档定义所有数据接口的精确格式，是工具实现和测试的唯一参考。

---

## 1. OKF 文件格式

### 1.1 Customer

**文件路径**：`knowledge/customers/{slug}.md`

**YAML frontmatter**：

```yaml
title: string          # 客户名称（必需）
status: string         # active | inactive | archived（默认 active）
source_category: string # inbound | outbound | referral | exhibition | import | unknown
source_label: string   # 来源标签（可选，如 "2026 香港春季展"）
relationship_stage: string # new | contacted | replied | opportunity | customer | archived
market: string         # 市场/国家（可选）
icp_fit: string        # fit | partial | unknown | not_fit
priority: string       # P1 | P2 | P3 | hold | unknown（由关联 Deal 推导）
generated:
  by: string           # 创建者（dealpilot-dsh）
  at: string           # ISO 8601 时间戳
```

**Markdown body**：

```markdown
# Profile
客户概况描述...

# Qualification
- 筛选判断1
- 筛选判断2

# Open questions
- 待确认问题1
- 待确认问题2

# Contacts
- **联系人姓名** (角色) — email@example.com — +1234567890
```

### 1.2 Deal

**文件路径**：`knowledge/deals/{slug}.md`

**YAML frontmatter**：

```yaml
title: string          # 交易名称（必需）
customer: string       # 关联客户 ref（如 knowledge/customers/acme-corp.md）
status: string         # active | blocked | done | archived（默认 active）
funnel_stage: string   # new | qualified | contacted | replied | opportunity | quoted | sample | won | lost | unknown
priority: string       # P1 | P2 | P3 | hold | unknown
risk_level: string     # low | medium | high | critical | unknown
risk_summary: string   # 风险摘要（可选）
current_action: string # 当前活跃 Action ref（可选）
products:              # 关联产品 ref 列表（可选）
  - knowledge/products/xxx.md
last_activity_at: string # 最后活动时间（ISO 8601）
generated:
  by: string
  at: string
```

**Markdown body**：

```markdown
# Goal
交易目标描述...

# Confirmed facts
- 已确认事实1
- 已确认事实2

# Inferences
- 推断1
- 推断2

# Open questions
- 待确认问题1

# Risks
- 风险1
- 风险2

# Correction history
- 2026-08-05: 风险等级从 medium 改为 high（原因：认证延期）
```

### 1.3 Action

**文件路径**：`knowledge/actions/{slug}.md`

**YAML frontmatter**：

```yaml
title: string          # 行动名称（必需）
deal: string           # 关联 Deal ref（必需）
status: string         # planned | active | done | blocked | cancelled | archived（默认 planned）
due_at: string         # 到期日（ISO 8601 日期，可选）
priority: string       # P1 | P2 | P3 | hold | unknown
reason: string         # 行动原因（可选）
requires_human: boolean # 是否需要人工确认（默认 false）
generated:
  by: string
  at: string
```

**Markdown body**：

```markdown
# Reason
行动原因描述...

# Check condition
完成条件描述...

# Evidence
完成证据（done 状态时填写）...
```

### 1.4 Contact

**文件路径**：`knowledge/contacts/{slug}.md`

```yaml
title: string          # 联系人姓名
customer: string       # 关联客户 ref
role: string           # 角色（可选）
email: string          # 邮箱（可选）
phone: string          # 电话（可选）
status: string         # active | archived
generated:
  by: string
  at: string
```

### 1.5 Product

**文件路径**：`knowledge/products/{slug}.md`

```yaml
title: string          # 产品名称
status: string         # active | archived
generated:
  by: string
  at: string
```

---

## 2. 业务事件格式

### 2.1 business-events.jsonl

**文件路径**：`knowledge/events/business-events.jsonl`

**每行格式**（JSONL）：

```json
{
  "occurred_at": "2026-08-05T15:30:00Z",
  "event_type": "customer.created | customer.updated | customer.archived | deal.created | deal.updated | deal.stage_changed | deal.risk_changed | deal.archived | action.created | action.completed | action.cancelled | action.blocked | action.reopened | action.scheduled | evidence.appended",
  "customer_ref": "knowledge/customers/acme-corp.md",
  "deal_ref": "knowledge/deals/acme-corp.md",
  "action_ref": "knowledge/actions/xxx.md",
  "source_ref": "knowledge/events/evidence/xxx.md",
  "channel": "chat | whatsapp | import",
  "generated_by": "dealpilot-dsh",
  "summary": "变更摘要"
}
```

**事件类型与必填字段**：

| event_type | 必填字段 |
|---|---|
| customer.created | occurred_at, event_type, customer_ref, channel |
| customer.updated | occurred_at, event_type, customer_ref, channel |
| customer.archived | occurred_at, event_type, customer_ref, channel |
| deal.created | occurred_at, event_type, deal_ref, customer_ref, channel |
| deal.updated | occurred_at, event_type, deal_ref, channel |
| deal.stage_changed | occurred_at, event_type, deal_ref, channel, summary |
| deal.risk_changed | occurred_at, event_type, deal_ref, channel, summary |
| action.created | occurred_at, event_type, action_ref, deal_ref, channel |
| action.completed | occurred_at, event_type, action_ref, deal_ref, channel |
| action.cancelled | occurred_at, event_type, action_ref, deal_ref, channel |
| action.blocked | occurred_at, event_type, action_ref, deal_ref, channel |
| action.reopened | occurred_at, event_type, action_ref, deal_ref, channel |
| action.scheduled | occurred_at, event_type, action_ref, deal_ref, channel, summary |
| evidence.appended | occurred_at, event_type, source_ref, customer_ref, channel |

---

## 3. Workspace Snapshot API

### 3.1 请求

```
Tool: dealpilot_snapshot
参数: { workspacePath?: string }
```

### 3.2 响应

```json
{
  "generated_at": "2026-08-05T15:30:00.000Z",
  "latest_event_at": "2026-08-05T15:28:00.000Z",
  "workspace_name": "dealpilot-workspace",
  "summary": {
    "customers": 12,
    "active_deals": 5,
    "today": 7,
    "overdue": 2,
    "risks": 1,
    "confirmation": 1
  },
  "today": [
    {
      "bucket": "overdue",
      "action_ref": "knowledge/actions/xxx.md",
      "customer_ref": "knowledge/customers/acme-corp.md",
      "deal_ref": "knowledge/deals/acme-corp.md",
      "customer_name": "Acme Corp",
      "deal_title": "Acme Corp / 智能家居认证报价",
      "title": "确认认证进度",
      "due_at": "2026-08-03",
      "priority": "P1",
      "reason": "认证延期导致报价无法确认"
    }
  ],
  "customers": [
    {
      "ref": "knowledge/customers/acme-corp.md",
      "title": "Acme Corp",
      "status": "active",
      "source_category": "exhibition",
      "source_label": "2026 香港春季展",
      "relationship_stage": "opportunity",
      "market": "Germany",
      "icp_fit": "fit",
      "priority": "P1",
      "updated_at": "2026-08-05T15:30:00Z",
      "profile": ["德国消费电子渠道商，主营智能家居产品..."],
      "qualification": ["年采购量约 $2M", "已有 3 家中国供应商"],
      "open_questions": ["现有供应商合同到期时间？"],
      "contacts": [
        {
          "ref": "knowledge/contacts/lisa-chen.md",
          "title": "Lisa Chen",
          "role": "采购经理",
          "email": "lisa@acme.de",
          "phone": "+49 xxx"
        }
      ]
    }
  ],
  "deals": [
    {
      "ref": "knowledge/deals/acme-corp.md",
      "title": "Acme Corp / 智能家居认证报价",
      "customer_ref": "knowledge/customers/acme-corp.md",
      "customer_name": "Acme Corp",
      "status": "active",
      "funnel_stage": "quoted",
      "priority": "P1",
      "risk_level": "high",
      "risk_summary": "认证信息未确认",
      "current_action": "knowledge/actions/acme-certification.md",
      "updated_at": "2026-08-05T15:30:00Z",
      "goal": "完成 CE 认证报价，争取首批试单",
      "confirmed_facts": ["客户需要 CE 认证", "报价已发送"],
      "inferences": ["客户可能同时向多家供应商询价"],
      "open_questions": ["认证具体标准？"],
      "risks": ["认证延期", "多家竞争"],
      "correction_history": ["2026-08-05: 风险等级从 medium 改为 high"],
      "products": [
        { "ref": "knowledge/products/smart-plug.md", "title": "Smart Plug Pro" }
      ],
      "actions": [
        {
          "ref": "knowledge/actions/acme-certification.md",
          "title": "确认认证进度",
          "status": "active",
          "due_at": "2026-08-03",
          "priority": "P1",
          "reason": "认证延期导致报价无法确认",
          "updated_at": "2026-08-01T10:00:00Z"
        }
      ]
    }
  ],
  "funnel": [
    { "stage": "new", "count": 0 },
    { "stage": "qualified", "count": 2 },
    { "stage": "contacted", "count": 3 },
    { "stage": "replied", "count": 2 },
    { "stage": "opportunity", "count": 3 },
    { "stage": "quoted", "count": 1 },
    { "stage": "sample", "count": 1 },
    { "stage": "won", "count": 0 },
    { "stage": "lost", "count": 0 },
    { "stage": "unknown", "count": 0 }
  ],
  "activity": [
    {
      "occurred_at": "2026-08-05T15:30:00Z",
      "event_type": "deal.risk_changed",
      "customer_ref": "knowledge/customers/acme-corp.md",
      "deal_ref": "knowledge/deals/acme-corp.md",
      "channel": "chat"
    }
  ],
  "warnings": [
    {
      "ref": "knowledge/customers/broken-file.md",
      "message": "invalid YAML frontmatter"
    }
  ]
}
```

---

## 4. 工具输入输出契约

### 4.1 dealpilot_write

**输入**：

```json
{
  "operation": "create",
  "entity": "customer",
  "fields": {
    "title": "Acme Corp",
    "source_category": "exhibition",
    "market": "Germany",
    "profile": "德国消费电子渠道商..."
  }
}
```

**输出**：

```json
{
  "ok": true,
  "ref": "knowledge/customers/2026-08-17-acme-corp.md",
  "title": "Acme Corp"
}
```

**错误**：

```json
{
  "ok": false,
  "error": "update 操作需要 ref 参数"
}
```

### 4.2 dealpilot_action_transition

**输入**：

```json
{
  "ref": "knowledge/actions/acme-certification.md",
  "transition": "complete",
  "evidence": "客户已确认认证完成"
}
```

**输出**：

```json
{
  "ok": true,
  "ref": "knowledge/actions/acme-certification.md",
  "previousStatus": "active",
  "newStatus": "done"
}
```

**错误**：

```json
{
  "ok": false,
  "error": "Invalid transition: done → active. Allowed: reopen"
}
```

### 4.3 dealpilot_import

**输入**：

```json
{
  "sourcePath": "sources/inbox/exhibition-list.csv",
  "sourceCategory": "exhibition",
  "autoDedup": true
}
```

**输出**：

```json
{
  "total": 15,
  "created": 12,
  "skipped": 1,
  "merged": 2,
  "customers": ["Acme Corp", "Beta Ltd", "Gamma GmbH", "..."],
  "warnings": ["Delta Inc 与现有客户 knowledge/customers/delta-inc.md 重复，已跳过"]
}
```

### 4.4 dealpilot_search

**输入**：

```json
{
  "query": "acme",
  "entity": "all",
  "filters": { "market": "Germany" }
}
```

**输出**：

```json
{
  "query": "acme",
  "entity": "all",
  "count": 1,
  "results": [
    {
      "ref": "knowledge/customers/acme-corp.md",
      "title": "Acme Corp",
      "status": "active",
      "market": "Germany",
      "source_category": "exhibition"
    }
  ]
}
```

### 4.5 dealpilot_whatsapp

**输入**：

```json
{
  "action": "analyze",
  "conversationKey": "491234567890@c.us",
  "messages": [
    {
      "from": "customer",
      "body": "Hi, when can you send the updated quote?",
      "timestamp": "2026-08-05T15:28:00Z"
    }
  ]
}
```

**输出**：

```json
{
  "ok": true,
  "customer": {
    "ref": "knowledge/customers/acme-corp.md",
    "title": "Acme Corp"
  },
  "deal": {
    "ref": "knowledge/deals/acme-corp.md",
    "title": "Acme Corp / 智能家居认证报价",
    "funnel_stage": "quoted"
  },
  "analysis": "客户在询问更新报价的进度。当前状态：认证信息未确认，风险等级高。",
  "draft": "Hi Lisa, we are still waiting for the certification details. I will send the updated quote as soon as we have confirmation. Expected by early next week.",
  "suggestedAction": {
    "title": "确认认证进度并更新报价",
    "priority": "P1",
    "due_at": "2026-08-08"
  }
}
```

---

## 5. Storage 索引格式

### 5.1 客户索引

**文件路径**：`~/.dsh/storages/dealpilot/customers.json`

```json
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

### 5.2 交易索引

**文件路径**：`~/.dsh/storages/dealpilot/deals.json`

```json
[
  {
    "ref": "knowledge/deals/acme-corp.md",
    "title": "Acme Corp / 智能家居认证报价",
    "customer_ref": "knowledge/customers/acme-corp.md",
    "customer_name": "Acme Corp",
    "status": "active",
    "funnel_stage": "quoted",
    "priority": "P1",
    "risk_level": "high",
    "risk_summary": "认证信息未确认",
    "current_action": "knowledge/actions/acme-certification.md",
    "updated_at": "2026-08-05T15:30:00Z"
  }
]
```

### 5.3 行动索引

**文件路径**：`~/.dsh/storages/dealpilot/actions.json`

```json
[
  {
    "ref": "knowledge/actions/acme-certification.md",
    "title": "确认认证进度",
    "deal_ref": "knowledge/deals/acme-corp.md",
    "customer_ref": "knowledge/customers/acme-corp.md",
    "customer_name": "Acme Corp",
    "deal_title": "Acme Corp / 智能家居认证报价",
    "status": "active",
    "due_at": "2026-08-03",
    "priority": "P1",
    "requires_human": false,
    "updated_at": "2026-08-01T10:00:00Z"
  }
]
```

---

## 6. Host-Client 通信契约

### 6.1 refresh-sidebar

**Client → Host**：

```json
{
  "method": "dealpilot:refresh-sidebar",
  "args": {}
}
```

**Host → Client**：

```json
{
  "summary": {
    "customers": 12,
    "active_deals": 5,
    "today": 7,
    "overdue": 2,
    "risks": 1,
    "confirmation": 1
  },
  "today": [ /* TodayItem[]，最多 10 条 */ ],
  "recentActivity": [ /* ActivityItem[]，最多 5 条 */ ],
  "generated_at": "2026-08-05T15:30:00Z",
  "latest_event_at": "2026-08-05T15:28:00Z"
}
```

### 6.2 refresh-dashboard

**Client → Host**：

```json
{
  "method": "dealpilot:refresh-dashboard",
  "args": {}
}
```

**Host → Client**：

```json
{
  /* 完整的 WorkspaceSnapshot，见 §3.2 */
}
```

### 6.3 WhatsApp HTTP API

**Chrome Extension → DSH**：

```
POST http://127.0.0.1:3080/api/dealpilot/whatsapp
Content-Type: application/json

{
  "action": "new_message",
  "conversationKey": "491234567890@c.us",
  "contactName": "Lisa Chen",
  "messages": [
    {
      "id": "msg_001",
      "from": "customer",
      "body": "Hi, when can you send the updated quote?",
      "timestamp": "2026-08-05T15:28:00Z"
    }
  ]
}
```

**DSH → Chrome Extension**：

```json
{
  "ok": true,
  "customer": { "ref": "...", "title": "Acme Corp" },
  "deal": { "ref": "...", "title": "...", "funnel_stage": "quoted" },
  "analysis": "客户在询问更新报价的进度...",
  "draft": "Hi Lisa, we are still waiting...",
  "suggestedAction": {
    "title": "确认认证进度并更新报价",
    "priority": "P1",
    "due_at": "2026-08-08"
  }
}
```

---

## 7. Today 确定性规则

### 7.1 分类规则

从 OKF 读取所有非 archived Action，按以下优先级分类：

```
1. status === "active" && due_at < today
   → bucket: "overdue"

2. status === "active" && due_at === today
   → bucket: "today"

3. status === "active" && requires_human === true
   → bucket: "confirmation"

4. status === "blocked" || (关联 Deal 的 risk_level === "high" || "critical" || Deal.priority === "P1")
   → bucket: "risk"

5. 其他
   → 不进入 Today
```

### 7.2 排序规则

```
bucket 优先级: overdue > today > risk > confirmation
同 bucket 内: due_at 升序（早的在前）
同 due_at 内: priority 优先级 P1 > P2 > P3 > hold > unknown
```

### 7.3 Funnel 阶段定义

```
new → qualified → contacted → replied → opportunity → quoted → sample → won/lost
```

- `won` 和 `lost` 不进入 active_deals 计数
- `archived` 不进入任何统计

---

## 8. 错误码

| 错误 | 含义 |
|---|---|
| `WORKSPACE_NOT_READY` | Workspace 缺少必需文件 |
| `INVALID_YAML` | YAML frontmatter 格式错误 |
| `REF_NOT_FOUND` | 引用路径不存在 |
| `PATH_TRAVERSAL` | 检测到 `../` 路径穿越 |
| `INVALID_TRANSITION` | Action 状态转换非法 |
| `DUPLICATE_ACTIVE_ACTION` | 同一 Deal 已有 active Action |
| `FILE_TOO_LARGE` | 概念文件超过 2MB |
| `EVENT_LINE_TOO_LARGE` | JSONL 行超过 4MB |
| `IMPORT_PARSE_ERROR` | 导入文件无法解析 |
| `WHATSAPP_NOT_CONNECTED` | Chrome 扩展未连接 |