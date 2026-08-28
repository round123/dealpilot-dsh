# DealPilot Agent-Native Memory Architecture V1

状态：v2 协议与实施基线
适用范围：DSH 插件、当前销售 Workspace、导入与业务记忆写入

本文保留 V1 文件名以维持已有引用；当前唯一运行时协议、工具边界和验收
标准是 `evidence/v2`、`interpretation/v2`、`change-set/v2` 和
`approval/v2`。当前插件已经把这些协议接入 host；既有 Workspace 通过一次
性重建进入同一条 v2 链路，不保留旧写入协议。

## 1. 目标

DealPilot 面对的是开放世界。导入资料时，系统必须同时做到四件事：

1. 原始材料可以完整重读，任何单元格、行、列和来源都不会因为当前理解不足而消失。
2. LLM 可以解释、归纳、提出关系和假设，但每个解释都能回到证据并被重新修正。
3. 用户确认的是一组看得见的具体变更，而不是一段不可验证的自然语言授权。
4. Harness 只控制权限、完整性、幂等、事务和审计，不替 LLM 预先决定业务含义。

本设计不把导入过程固定成不可变的业务工作流。它定义的是稳定的能力边界和交换协议，Agent 可以根据观察到的状态决定下一步。

## 2. 当前基线与根因

本次 session 的最终快照显示 33 个客户，但中间发生了四个结构性问题：

| 位置 | 现象 | 根因 |
| --- | --- | --- |
| 事故快照中的旧 proposal/apply 实现 | `target` 是字符串时，创建路径变成 `knowledge/notes/...-untitled.md` | proposal 入口没有校验嵌套 target，创建逻辑对未知形状静默使用默认路径 |
| 事故快照中的旧写入实现 | 33 个 create 反复覆盖同一个文件 | apply 没有实体类型路由、目标唯一性检查和写后不变量 |
| 事故快照中的旧导入实现 | 联系人、跟进历史和未知列没有一等语义 | 导入器只固定复制少数字段，并把缺失状态制造成 `active/new/unknown` |
| 事故快照中的旧确认实现与 Agent 决策 | 一次 proposal 确认被扩大解释为多次独立写入授权 | token 没有绑定完整变更集、解释版本、Workspace 和持久批准记录 |

还有两个放大器：

- `canonical-import.ts` 用表头字符串生成 key，重复表头会碰撞；空行和部分空值也可能被过滤。
- 写入、业务事件和索引分三步完成，没有 durable journal、锁和恢复状态；普通文件能力仍能直接修改业务目录。

这不是某个模型偶然犯错，而是多套协议允许同一份自然语言意图走不同的副作用路径。优化目标是收敛协议和责任边界，而不是增加更多提示词或更多固定步骤。

## 3. 不可破坏的不变量

以下规则由 Harness 强制执行，LLM 不能通过改写字段名、换工具或重试绕过：

1. **证据不删除**：原始文件、canonical 观察和来源定位是 append-only 材料。
2. **解释可撤回**：LLM 产生的 claim 只能新增、修正或标记 superseded/retracted，不能覆盖原观察。
3. **未知不是空值**：没有证据的字段保持 absent 或显式 `unknown` claim，不自动生成业务状态。
4. **每个派生值有来源**：业务投影中的事实和推断必须引用一个或多个 observation/claim。
5. **类型路由严格**：`customer` 只能由 customer adapter 写入 customer 文档；不能降级为 note。
6. **确认对象不可漂移**：工具、Workspace、session、解释版本、字段、目标、数量或冲突解决改变时，原批准失效。
7. **一次操作一个稳定 ID**：重试只返回已有结果，不重复创建文件、事件或关系。
8. **先验证后副作用**：批次的全部目标、关系、版本和权限先通过校验，再进入写入阶段。
9. **失败可观察可恢复**：任何部分完成都记录已完成项、失败原因、可重试项和补偿依据。
10. **索引不是权威**：Storage index 和 snapshot 都可以从 OKF、claim ledger 和事件重建。
11. **普通文件能力不写业务对象**：业务目录只能经 typed mutation kernel 修改；通用 note 能力必须显式声明 note 目标。
12. **开放内容不被字段白名单截断**：无法映射到稳定字段的内容进入 claim/evidence 层，并带有处理状态和原因。

## 4. 目标数据分层

```text
L0  Source archive
    原始文件、媒体类型、sha256、session/workspace 来源、导入清单
        |
L1  Observations
    无损的 sheet/row/cell 观察，含坐标、raw/display/formula/type 和定位
        |
L2  Interpretation ledger
    LLM 产生的事实、推断、假设、未知、冲突和关系；全部引用 L1
        |
L3  OKF projections
    customer/contact/deal/action/relationship 的人类可读业务投影
        |
L4  Derived projections
    Storage index、snapshot、Today、搜索缓存；随时可重建
```

DSH session 是对话和工具调用的运行时审计材料。它与 L0-L4 互相引用，但不替代业务证据和变更事件。

### 4.1 L0：来源归档

每个导入 job 使用独立目录：

```text
sources/imports/{import_job_id}/
├── manifest.json       # 来源、哈希、session、转换器、能力版本
├── source.xlsx         # 原始字节，只读归档
├── canonical.json      # L1 evidence/v2
└── document.univer     # 可重开工作簿快照

storage/
├── interpretations/{interpretation_id}.json  # L2 版本化解释
├── change-sets/{change_set_id}.json          # 不可变 typed 变更集
├── proposals/{proposal_id}.json              # session-bound proposal 状态
├── approvals/{approval_id}.json              # durable approval 状态
└── transactions/{transaction_id}.json        # WAL、逐项结果和恢复状态
```

原始文件即使已经生成业务投影也不能删除。需要归档时只改变 job 状态，并保留可读的 manifest。

### 4.2 L1：无损观察

契约名称：`dealpilot.evidence/v2`。

```json
{
  "schema": "dealpilot.evidence/v2",
  "source": {
    "source_id": "src_...",
    "name": "展会客户.xlsx",
    "media_type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "sha256": "...",
    "session_id": "...",
    "archived_ref": "sources/imports/imp_.../source.xlsx"
  },
  "sheets": [{
    "sheet_id": "sheet_1",
    "name": "venti",
    "visibility": "visible",
    "columns": [
      { "column_id": "c_1", "index": 0, "label": "客户联系信息", "address": "A" },
      { "column_id": "c_2", "index": 1, "label": "客户联系信息", "address": "B" }
    ],
    "rows": [{
      "row_id": "sheet_1:r_2",
      "row_number": 2,
      "cells": [{
        "observation_id": "obs_...",
        "column_id": "c_1",
        "address": "A2",
        "raw": "WhatsApp",
        "display": "WhatsApp",
        "value_type": "string",
        "formula": null,
        "empty_reason": null
      }],
      "row_hash": "...",
      "warnings": []
    }]
  }],
  "accounting": {
    "sheet_count": 1,
    "row_count": 1,
    "cell_count": 2,
    "preserved_cell_count": 2
  },
  "provenance": { "converter": "univer", "converter_version": "...", "converted_at": "..." }
}
```

实现要求：

- `column_id` 必须由位置稳定生成，不能由表头去重或覆盖；重复表头仍是不同列。
- 不过滤全空行、`0`、`false`、公式结果或只有格式的行。若转换器无法读取某种内容，保留占位观察并记录 warning。
- 保存 raw、display、formula、value type、坐标和 row/cell hash；支持的情况下保存批注、合并、隐藏状态和超链接。
- 转换器对同一坐标返回的多个载荷别名全部放入 `representations`，不能只选一个别名：
  
  ```json
  "representations": {
    "displayValues": { "present": true, "value": "WhatsApp", "hash": "..." },
    "cellData": { "present": true, "value": { "v": "WhatsApp" }, "hash": "..." },
    "rawValues": { "present": false, "hash": "..." }
  }
  ```
  
  别名保持转换器原名；`present=false` 表示稀疏载荷没有返回该坐标，显式空值仍是
  `present=true`。`value` 先转为 JSON-safe 值，`hash` 绑定别名、presence 和 value，
  并参与 `cell_hash` 与 `evidence_digest`。所有表示的坐标并集决定 sheet 尺寸，避免
  稀疏矩阵或重复表头造成覆盖。`include_raw=false` 只是读取投影：隐藏 `raw`、
  `cell_data` 以及 raw/value/cells 类表示的 value，但保留别名、presence 和 hash；
  该投影不能作为完整证据提交 claim，需回到原始 evidence 读取值。
- 任何截断必须返回 cursor 和覆盖统计，不能让 Agent 以为已经读完。
- `validateCanonicalDocument` 必须校验计数、唯一 ID、坐标范围和 source hash，而不只是校验几个顶层字段。

### 4.3 L2：解释与 claim ledger

契约名称：`dealpilot.interpretation/v2`。解释是可版本化、可追加的材料，不是覆盖原文的转换结果。

```json
{
  "schema": "dealpilot.interpretation/v2",
  "interpretation_id": "int_...",
  "import_job_id": "imp_...",
  "canonical_ref": "sources/imports/imp_.../canonical.json",
  "evidence_digest": "...",
  "model": { "provider": "...", "name": "...", "prompt_version": "..." },
  "claims": [{
    "claim_id": "clm_...",
    "subject": { "candidate_id": "cand_1", "kind": "customer", "label": "Acme" },
    "predicate": "contact.channel",
    "value": "WhatsApp",
    "value_type": "string",
    "status": "observed",
    "confidence": 1,
    "evidence_refs": [{ "observation_id": "obs_...", "location": "venti!H2" }],
    "rationale": "原始单元格直接写明渠道"
  }, {
    "claim_id": "clm_...",
    "subject": { "candidate_id": "cand_1", "kind": "customer", "label": "Acme" },
    "predicate": "relationship.parent_company",
    "value": "可能是 RVCC 的子公司",
    "value_type": "string",
    "status": "hypothesis",
    "confidence": 0.55,
    "evidence_refs": [{ "observation_id": "obs_...", "location": "venti!M12" }],
    "rationale": "备注使用了可能性措辞，未得到独立确认"
  }],
  "coverage": [{
    "observation_id": "obs_...",
    "handling": "mapped",
    "claim_ids": ["clm_..."]
  }, {
    "observation_id": "obs_...",
    "handling": "unresolved",
    "reason": "无法判断该列是采购角色还是行业描述"
  }],
  "unresolved": [{ "candidate_id": "cand_1", "question": "公司名称为空，是否以联系人作为暂定标题？" }],
  "conflicts": [],
  "created_at": "..."
}
```

`status` 至少支持：`observed`、`inferred`、`hypothesis`、`unknown`、`conflict`、`retracted`。`confidence` 不能替代证据；没有 `evidence_refs` 的事实性 claim 不得进入可确认变更。

每个 observation 必须有且只能有一种处理状态：`mapped`、`unresolved` 或 `ignored`。`ignored` 必须有原因，例如“纯格式信息，转换器没有业务内容”，不能默默丢弃。

### 4.4 L3：业务投影

OKF 仍是人类可读的权威业务投影，但它不再承担原始证据仓库的职责。

Customer 示例：

```yaml
entity_id: cus_...
title: Acme
status: active
source_category: exhibition
claim_refs:
  - clm_...
source_refs:
  - sources/imports/imp_.../canonical.json#venti!A2:M2
generated:
  by: dealpilot-dsh
  at: 2026-08-28T00:00:00Z
```

```markdown
# Observed facts
- 联系渠道：WhatsApp（见 `clm_...`）

# Interpretations
- 可能与 RVCC 存在母子公司关系（假设，置信度 0.55）

# Open questions
- 公司名称为空，需确认客户主体

# Conflicts
_none_

# Correction history
- 由 interpretation `int_...` 生成；后续解释可追加修正
```

联系人是 `knowledge/contacts/*.md` 的独立对象，通过 `customer` ref 关联；联系人、跟进历史和关系不再只写进客户的自由文本。不能可靠建模的内容仍以 claim 保留，并出现在搜索和详情中。

稳定 frontmatter 只放已经验证、需要索引的值。原始列名和值通过 claim/evidence 引用保留；扩展内容必须放在有来源的 claim、evidence 或显式 note 中，不得成为无来源的语义垃圾桶。

## 5. LLM 与 Harness 的责任边界

### 5.1 LLM 负责

- 选择需要读取的 evidence slice，识别表头和上下文。
- 判断候选实体、字段含义、联系人和关系。
- 区分观察、推断、假设、未知和冲突。
- 为每个 claim 选择证据引用，解释判断依据。
- 发现同名、重复联系人、跨表关系和异常值，并提出候选而不是擅自合并。
- 根据用户目标形成可审阅 change set，并在反馈后创建新解释版本。

### 5.2 Harness 负责

- Workspace/session/source 边界和真实路径校验。
- evidence、interpretation、change-set 的 schema、引用存在性、哈希和覆盖率校验。
- entity adapter 路由、关系完整性、目标版本、权限、确认和幂等。
- 事务、写前日志、锁、崩溃恢复、补偿和业务事件。
- 从权威文件重建索引和 snapshot。

Harness 不负责把“备注”猜成“客户行业”，也不负责把“可能”提升为“已确认”。
## 6. 端到端能力闭环

### 6.1 Source intake 与 ingest

`dealpilot_ingest` 只做来源归档和 L1 转换，成功结果必须包含：

- `import_job_id`、`canonical_ref`、`source_id`、sha256；
- 每个 sheet 的行列和 observation 计数；
- 转换 warning、不可读取内容和分页 cursor；
- job 状态：`received → converted` 或 `failed`。

它不创建 customer、deal 或 action，也不决定来源类别和关系阶段。

### 6.2 Read 与理解

`dealpilot_read` 增加稳定 cursor：

```json
{ "ref": ".../canonical.json", "sheet": "venti", "range": "A1:M25", "cursor": null, "max_items": 200 }
```

返回 `next_cursor`、`returned_observations`、`total_observations` 和 citation。Agent 必须在解释提交前覆盖所有相关 slice；Harness 根据 coverage 阻止静默遗漏。

新增 `dealpilot_record_interpretation`（名称可在实现阶段确定）用于验证并持久化 L2。该能力不调用 LLM，只验证 Agent 已形成的解释：

- 所有 claim 的 evidence ref 可解析；
- subject、predicate、value 和 status 合法；
- coverage 覆盖了输入 observation；
- `ignored/unresolved` 有理由；
- interpretation 的 evidence digest 与当前 canonical 一致。

### 6.3 去重和实体候选

去重是候选生成能力，不是自动删除或自动合并：

- exact match、规范化名称、邮箱/电话、网站域名和模糊相似度分别给出证据；
- 每个候选显示 `new / update / possible_duplicate / conflict / unresolved`；
- LLM 可提出匹配理由，用户选择保留、合并、分开或暂缓；
- 只有用户选择了 merge，才调用 typed merge adapter；
- 同名不等于同一客户，不能仅按 title skip。

### 6.4 Change set 与预览

`dealpilot_propose` 是唯一的 typed change-set 入口；输入必须完整表达实体、操作、目标、字段、证据和 accounting，无法表达的内容停在诊断或 unresolved 状态。

契约名称：`dealpilot.change-set/v2`。

```json
{
  "schema": "dealpilot.change-set/v2",
  "change_set_id": "chg_...",
  "workspace_revision": "rev_...",
  "evidence_digest": "...",
  "interpretation_id": "int_...",
  "operations": [{
    "op_id": "op_1",
    "entity_type": "customer",
    "operation": "create",
    "target": { "candidate_id": "cand_1", "identity": { "title": "Acme" } },
    "field_changes": [{
      "path": "profile.channel",
      "after": "WhatsApp",
      "value_status": "observed",
      "claim_ids": ["clm_..."],
      "evidence_refs": ["obs_..."]
    }],
    "preserve_claim_refs": ["clm_..."],
    "conflicts": [],
    "risk": "low"
  }],
  "accounting": {
    "source_rows": 24,
    "mapped_observations": 180,
    "unresolved_observations": 3,
    "ignored_observations": 2
  }
}
```

入口必须拒绝：

- `target` 为字符串；
- 缺少 `entity_type`、`operation` 或 `op_id`；
- `entity_type=customer` 但目标路径指向 notes；
- 没有 evidence 的事实变更；
- 重复 op_id、重复目标或目标版本已变化；
- 将未知字段丢弃却没有 claim 或处理理由。

预览至少显示：总变更数、创建/更新/关系/未决数、逐条 before/after、来源定位、事实/推断标识、冲突、重复候选、未映射内容和失败影响。摘要不能替代明细，明细不能隐藏在模型上下文里。

### 6.5 用户批准

用户批准记录是独立的持久化对象，由 UI 或宿主确认事件创建，而不是由模型自行生成：

```json
{
  "approval_id": "apr_...",
  "actor": "user",
  "workspace_id": "...",
  "session_id": "...",
  "change_set_id": "chg_...",
  "change_set_hash": "...",
  "selected_op_ids": ["op_1"],
  "resolutions": {},
  "status": "pending",
  "created_at": "...",
  "expires_at": "..."
}
```

`dealpilot_apply` 将完整预览交给宿主。宿主返回 `allowed-once` 后，Harness
在同一次工具执行内创建 durable approval，消费该授权并调用 mutation kernel；
模型不会接收或携带秘密 token。`approval_id` 绑定 Workspace、session、schema
版本、base revision、解释版本、完整 change-set hash 和选定操作，用于审计、
崩溃恢复和内部重试。拒绝、取消、过期、版本变化或重复消费都保持可审计状态，
不会转化为业务副作用。

### 6.6 Typed mutation kernel

所有 customer/contact/deal/action/relationship/evidence 写入经过同一个 kernel：

1. 读取并锁定 Workspace revision。
2. 验证整个 change set：实体类型、目标、关系、字段、claim 引用、权限、冲突解决和幂等键。
3. 生成 `storage/transactions/{tx_id}.json`，包含 before-image hash、after hash、op 状态和补偿信息。
4. 在 staging 目录生成完整新文件和事件。
5. 原子提交文件、业务事件和索引更新；提交过程中任何异常都由 journal 恢复。
6. 运行写后不变量，更新 transaction 状态并返回逐项结果。

事务状态：

```text
proposed
  → awaiting_approval
  → applying
  → completed
  → partially_applied → recoverable
  → failed
```

每个 `op_id` 使用稳定幂等键。重试时，已完成项返回原结果；未完成项按
journal 继续，不重新推断、不覆盖新版本。需要人工补偿时，应生成新的
typed change-set，并保留原事务作为审计依据。

写后不变量：

```text
requested_ops = completed_ops + skipped_ops + failed_ops
all_refs_are_unique = true
all_entity_types_match = true
all_claim_refs_resolve = true
business_events >= completed_ops
index_matches_authoritative_files = true
```

任何不变量不成立，事务结果只能是 `failed` 或 `partially_applied`，不能报告“导入完成”。

## 7. 工具收敛

当前 host 对 Agent 注册的业务能力如下：

| 能力 | 责任 | 是否产生业务副作用 |
| --- | --- | --- |
| `dealpilot_snapshot` | 读取 Today、客户、交易、行动和运行时投影 | 否 |
| `dealpilot_search` | 搜索业务投影、事件和 evidence | 否 |
| `dealpilot_whatsapp` | 分析消息并生成待审阅草稿 | 否，不发送外部消息 |
| `dealpilot_ingest` | L0/L1 来源归档与无损转换 | 否，写入只读 import artifact |
| `dealpilot_read` | 分页读取 evidence、interpretation、change-set 和 OKF 引用 | 否 |
| `dealpilot_record_interpretation` | 校验并保存 L2 解释版本 | 只追加解释材料，不改业务投影 |
| `dealpilot_propose` | 校验、保存并预览 typed change-set | 否 |
| `dealpilot_apply` | 请求宿主批准并通过 mutation kernel 提交已批准 change-set | 是 |
| `dealpilot_feedback_create` | 生成脱敏反馈草稿 | 否，不发网络请求 |
| `dealpilot_feedback_submit` | 在独立 approval 后生成 GitHub Issue 地址 | 只生成外部页面地址；用户仍需在 GitHub 提交 |

`dealpilot_apply` 是业务副作用的唯一入口。所有业务对象都必须由
`dealpilot.change-set/v2` 描述，并经过同一个 typed adapter、事务 journal、
事件 writer 和索引重建路径；工具注册表中不存在绕过这些边界的通用业务写入
能力。无法保留来源或语义的输入必须停在诊断状态。

## 8. 业务投影规则

### 8.1 Customer

- 只在有明确主体标识时创建；联系人姓名不能静默替代公司名称。
- `status`、`relationship_stage`、`source_category`、`icp_fit` 和 `priority` 没有证据时保持 absent 或 `unknown` claim，不写入合成的业务事实。
- 个人、公司、品牌和母子公司可以作为不同 candidate，关系以 claim 表达，直到证据或用户判断收敛。
- 联系人单独建档并关联 customer；无法确定归属则保留 candidate contact 和 unresolved。

### 8.2 Deal

- 只有原始资料或 LLM 明确提出、且带证据的商机才创建；兴趣描述不自动变成 deal。
- funnel stage、risk 和 amount 的变更必须带 claim/evidence；未知不等于 new 或 low。
- 每个 deal 的 action 关系由 kernel 校验，不能留下指向归档客户的悬挂引用。

### 8.3 Action

- Action 记录可验证的下一步和完成条件；“尚未联系”是观察，不自动产生具体任务，除非 Agent 根据用户目标提出并获得确认。
- 状态转换只由 action state adapter 执行，事件和 Goal runtime 同步更新。

### 8.4 任意开放内容

- 不属于稳定字段的内容进入 claim ledger、evidence note 或显式 note 文档。
- 保留原始 key、原始 value、来源和解释状态；UI 显示“尚未映射/待确认”，而不是隐藏或伪装成结构化字段。

## 9. 访问控制与文件边界

1. `knowledge/` 下业务对象禁止由通用 DSH `write/edit` 直接修改。
2. Agent preset 中的 filesystem 能力改为只读业务目录；需要创建临时脚本或工作簿时使用 `imports/`、`storage/staging/` 等技术目录。
3. kernel 对所有 ref 做 lexical + realpath 校验，拒绝路径穿越、符号链接逃逸和类型不匹配。
4. 事件文件只能由事件 writer append；普通文件编辑不能伪造 `customer.created`。
5. 用户可直接修改 OKF 文件的产品决策需要单独设计“外部编辑检测与重建索引”能力；在该能力完成前，UI 明确把 OKF 作为可读导出而不是无审计编辑入口。
6. 首次 Workspace 初始化属于受控 bootstrap：native DSH session 必须先由 host 建立并证明其 `cwd` 与目标 Workspace 一致，初始化请求仅允许来自 loopback host；后续 HTTP 写入必须携带同一 DealPilot session 绑定。

## 10. 迁移方案

### M0：冻结与基线

- 保存当前 Workspace 快照、所有 OKF、import job、session 引用和事件文件。
- 建立包含重复表头、空行、0/false、公式、跨语言值和未知列的 golden fixture。
- 冻结旧数据快照；运行时只启用 v2 能力。

### M1：v2 证据与解释

- 实现 evidence/v2、interpretation/v2、change-set/v2 validators。
- 从原始归档重建 evidence/v2；来源不明的值保留为 unknown provenance。
- 为每个 observation 生成完整 coverage，并由 LLM 形成可修正 interpretation/v2。

### M2：重建当前数据

- 对现有 33 个客户保留原文件和原始导入材料。
- 从可解析来源生成联系人和 claim；不能可靠判断的内容进入 unresolved queue。
- 将错误的通用 note 作为历史 artifact 归档或通过 typed compensation 处理，不直接删除或覆盖。
- 从权威文件和 claims 重建 indexes/snapshot，检查数量和引用。

### M3：预览与抽样

- 新流程只生成 L1/L2/change-set，不提交 L3。
- 对 change-set 预览做人工抽样，统计字段覆盖、未决、冲突和语义损失。
- 由人工抽样审阅，修正 prompt/schema/adapter，而不是手工修补结果文件。

### M4：切换

- 在临时 Workspace 对代表性记录运行一次真实确认、提交、重启和恢复验证。
- 通过验收后切换到 v2；所有新副作用都经过 typed change-set 和 mutation kernel。
- 任何失败都回到 change-set/transaction 状态，使用补偿或重试，不回退到直接文件写入。

### 回滚

- 运行时可重建 OKF/index/snapshot 投影，不删除 v2 evidence/claims。
- 数据回滚只能使用 transaction before-image 的审计补偿；禁止整目录覆盖或按名称删除。

## 11. 实施分期与代码落点

下面的代码落点对应当前 v2 实现；每一阶段都保留可回归的协议测试。

### S0：协议和评测基线（已落地）

核心模块和测试：

- `plugin/lib/evidence-contract.ts`、`plugin/lib/interpretation-contract.ts`
- `plugin/lib/change-set-contract.ts`、`plugin/lib/contract-utils.ts`
- `tests/evidence-import-v2.test.mjs`、`tests/contracts-v2.test.mjs`

完成 schema、hash、引用、覆盖率和错误码；协议层先于业务副作用生效。

### S1：无损 ingest/read（已落地）

`plugin/lib/canonical-import.ts`、`plugin/lib/artifact-store.ts` 和
`plugin/lib/agent-memory.ts` 负责：

- 唯一 column/row/cell ID、空值和重复表头保留；
- cursor 分页、source manifest 和 accounting；
- source hash、artifact realpath 和证据存在性检查。

### S2：解释层（已落地）

`dealpilot_record_interpretation` 通过 `interpretation-contract.ts` 保存版本化 claim ledger。Agent preset 要求事实/推断/未知/冲突/证据覆盖，但不规定客户业务分类的固定流程。

### S3：typed planner 与 approval（已落地）

`plugin/lib/agent-memory.ts`、`plugin/lib/approval-store.ts` 和
`plugin/lib/workspace-revision.ts` 负责：

- 严格拒绝字符串 target 和未知 entity；
- proposal hash、base revision、op_id、accounting；
- host `allowed-once` 结果、durable approval 和一次性消费；
- 解释、证据、Workspace 或目标版本变化时失效。

### S4：mutation kernel（已落地）

`plugin/lib/mutation-kernel.ts` 与 `plugin/lib/entity-adapters.ts` 让所有业务副作用共用：

- lock/WAL/staging/atomic commit；
- idempotency；
- typed path routing；
- event/index consistency；
- crash recovery 和逐项结果。

### S5：projection 与 UI（持续验收）

`snapshot.ts`、`search-tool.ts`、`client/client.ts` 和工作台负责：

- 展示 contacts、claims、evidence citations、unresolved/conflicts；
- 导入预览按 source row、candidate 和 op 展开；
- approval 由宿主确认通道产生并显示已选操作；
- transaction 状态可查询和恢复。

### S6：重建、真实验收和发布（下一阶段）

补齐既有 Workspace 的重建命令、指标和日志；在 injector reload 后分别验证
host/client 版本；每次源码变更执行 `pnpm run build`，正式包只装配构建后的 JS。

## 12. 验收与质量门槛

提交前的最小核心回归命令：

```powershell
cd plugin
pnpm install
pnpm run build
pnpm run test:core
```

真实 DSH/Univer/浏览器端到端验收在目标宿主中执行；本地提交前只需再检查
`node --check plugin/lib/index.js`、`node --check plugin/client/client.js` 和
`git diff --check`。构建必须先于核心测试，以保证 TypeScript 与正式装配的
JavaScript 来自同一份源码。

### 12.1 证据完整性

- golden workbook 的原始文件 sha256 可回算。
- 每个 sheet、row、column、cell 的数量和 ID 可核对。
- 重复表头不会覆盖；空行、0、false、公式和未知列均有记录。
- 同一坐标的所有 adapter 表示、presence 和 hash 均保留；稀疏表示的坐标并集与 accounting 可核对。
- `include_raw=false` 不泄露 raw/value 表示的值，且脱敏页仍保留可校验的 alias/presence/hash。
- 每个 observation 是 mapped、unresolved 或 ignored 之一，覆盖率 100%。

### 12.2 语义质量

- 每个事实 claim 有可解析 evidence ref。
- observed 与 inferred/hypothesis 在预览和投影中可区分。
- 未知字段不生成 active/new/import 等合成事实。
- 联系人、关系、跟进历史要么进入一等对象/claim，要么明确列入 unresolved。
- 用户可从 customer/deal 回到原始 sheet/range/cell。

### 12.3 Harness 安全

- malformed target、customer→notes、未知 entity、重复 op_id、目标版本冲突全部拒绝。
- 不同工具、session、Workspace、字段或解释版本不能复用批准。
- 没有 UI/宿主批准记录时，模型不能提交；模型不接触批准秘密。
- 重试、并发、进程崩溃和重启不会重复文件或事件。
- 部分失败返回逐项状态并可恢复/补偿。
- 任意普通文件编辑都不能改变业务索引或伪造业务事件。

### 12.4 产品验收

- 33 条 golden import 在临时 Workspace 完成“读取→解释→预览→用户选择→提交→快照”闭环。
- 快照能查询联系人、来源、claim 状态、冲突和未决项。
- 重新解释同一 evidence 会产生新 interpretation 版本，不抹掉旧判断。
- DSH 重启、injector reload、索引重建后结果一致。
- 零自动外发消息，零静默数据丢失。

## 13. 运行指标与停机条件

持续记录以下指标，并按 import job、模型版本和 Workspace 分组：

- `evidence_preservation_rate`
- `observation_coverage_rate`
- `claim_citation_rate`
- `unresolved_rate`
- `conflict_rate`
- `semantic_loss_count`
- `duplicate_decision_rate`
- `approval_mismatch_rate`
- `transaction_partial_rate`
- `retry_idempotency_rate`
- `index_rebuild_mismatch_count`

出现任何静默丢失、实体类型错写、批准漂移或索引与权威文件不一致时，停止批量提交，只允许生成影子预览和诊断材料。

## 14. 最终判断标准

一个导入是否完成，不由“创建了多少个客户文件”判断，而由下面的链条判断：

```text
原始材料仍可读取
  + 每个观察都有处理结果
  + 每个解释都有证据和状态
  + 每个业务变更都有可见预览和用户批准
  + 每个副作用都有事务、事件和可恢复结果
  + Agent 可以基于新证据重新解释
```

只有这六项同时成立，系统才是在扩大 Agent 的理解和修正空间；否则只是把数据从一个文件搬到另一个文件。
