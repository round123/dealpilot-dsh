# DealPilot Import Integrity Review

状态：实施基线
日期：2026-08-28
范围：`session-b9c409e8-9e02-4542-ad4d-a6e43e9c0094`

## 结论

这次结果不是单个模型字段判断失误，而是导入、理解、批准和写入之间没有共享同一份可验证协议。系统把“资料已读”“模型已解释”和“业务已确认”混成了“文件写成功”，因此产生了可见数量，却没有可靠的语义和证据闭环。

该行为确实偏离 DealPilot 的项目哲学：LLM 应负责解释开放世界信息，Harness 应负责边界、完整性、可观察副作用和恢复；本次链路反过来让文件格式和宽松默认值替代了理解，让一次自然语言确认替代了逐项可见批准。

## 可复核证据

从附件 `session.jsonl` 解析出的运行记录：

| 项目 | 观测值 |
| --- | ---: |
| 工具调用总数 | 164 |
| `dealpilot_ingest` | 2 |
| `dealpilot_propose` | 3（33、1、33 个 operation） |
| `dealpilot_apply` | 2 |
| `dealpilot_write` | 110，全部是 `customer/create` |
| 最终业务客户数 | 33（`venti` 24 行，`runzhi` 10 行中实际写入 9 条） |
| 批量提案产生的业务文件 | 同一 `knowledge/notes/2026-08-28-untitled.md` 被重复覆盖 |

原始工作簿的导入结果显示：`venti` 有 13 列，其中“客户联系信息”出现两次；`runzhi` 有 17 列；另有空的 `Sheet3`。v1 canonical 用表头字符串作为对象 key，两个同名列不能同时表达。读取结果还把 raw 单元格和显示值分成了两个不完整层次，无法证明每个坐标是否被处理。

模型随后把行内容手工拼成 `fields`，而不是提交带 observation 引用的解释记录。未建模的联系人、互动历史、关系和未知列被放入自由字段；缺少证据的状态被写成 `active`、`new` 或 `unknown`。第一次提案中的 `target` 是字符串，入口没有拒绝，创建逻辑把它降级为 `notes/untitled`。应用阶段没有实体类型、目标唯一性和写后不变量，仍返回 `applied`。

确认令牌只在进程内绑定工具和部分参数，没有持久批准记录，也没有绑定完整变更集、解释版本、Workspace、基线版本和选中的 operation。因此“已审阅，请执行写入”被扩大成多次独立写入授权。

## 处理原则

1. 原始字节和坐标观察先归档，任何当前无法理解的内容仍可重读。
2. LLM 解释以版本化 claim ledger 保存，区分 observed、inferred、hypothesis、unknown 和 conflict；每条事实引用 observation。
3. 变更使用带 `entity_type`、`op_id`、基线版本、claim/evidence 引用的 typed change-set；摘要不能替代明细。
4. 用户批准持久化为绑定完整 hash 的 artifact；目标、字段、解释版本或 Workspace 变化即失效。
5. 所有业务副作用经过同一个 mutation kernel，具备锁、预写日志、幂等、逐项状态、恢复和补偿。
6. 索引和 snapshot 是可重建投影，不是证据或业务事实的唯一来源。

## 当前实现基线

- `dealpilot.evidence/v2`：稳定 sheet/row/cell ID、坐标、raw/display/formula/type、全部 adapter representations（alias/present/value/hash）、hash、计数和 cursor。
- `dealpilot.interpretation/v2`：claim、evidence 引用、coverage、未决项和冲突的严格校验。
- `dealpilot.change-set/v2`：typed operation、目标版本、操作 accounting 和确定性 hash。
- `dealpilot.approval/v2`：Workspace/session/tool/change-set/hash 绑定、持久状态和一次性消费。
- mutation kernel：统一 typed 路由、WAL、staging、幂等和恢复接口。

运行时以 `evidence/v2`、`interpretation/v2`、`change-set/v2` 和统一 mutation
kernel 作为唯一业务协议。历史来源、旧 canonical、业务文件和运行记录作为审计材料
保留；需要重建时从原始来源重新 ingest，生成新的证据和解释版本，不把历史结构直接
当作当前业务事实。

证据表示规则：同一坐标的 `displayValues`、`formattedValues`、`values`、`cellData`、
`rawValues`、`cells` 等 adapter 别名按原名全部保留；`present` 区分显式空值与稀疏缺失，
`hash` 绑定别名、presence 和 JSON-safe value，并纳入 cell/document digest。稀疏别名的
坐标并集决定读取范围。`include_raw=false` 只返回 alias、presence 和 hash，隐藏 raw/value
类表示的值，因此只能用于发现与校验，不能替代完整 evidence 作为 claim 依据。

## 33 条记录的修复闭环

1. 保留原始 xlsx、旧 canonical、客户文件、note、proposal、事件和 session 引用，先生成 manifest 和哈希快照。
2. 从原始 xlsx 重新生成 evidence/v2，不使用已发生表头碰撞的 v1 结果。
3. 由 Agent 分片读取所有 observations，生成 interpretation/v2；每个 observation 必须是 mapped、unresolved 或 ignored（有理由）。
4. 联系人、跟进历史和组织关系分别形成一等对象或带证据的 claim；同名只生成 duplicate candidate，不自动合并。
5. 生成 repair change-set，在 UI 中逐项审阅并选择操作，再由 kernel 小批量提交。
6. 对错误 note 使用审计归档或补偿操作，不直接抹除；重建 index/snapshot，并验证引用和计数。

## 验收门槛

导入只有在以下条件全部满足时才算完成：

```text
原始材料可重读
+ 每个 observation 有处理状态
+ 每个事实 claim 有证据引用
+ 每个业务变更有可见 before/after 和批准记录
+ 每个副作用有事务状态、事件和恢复依据
+ 新证据可以产生新的解释版本而不抹掉旧判断
```

证据验收还必须证明：重复或稀疏载荷别名没有被覆盖；representation hash 被篡改时读取
失败；脱敏读取不含 raw/value 表示的值但仍可按 alias、presence 和 hash 对账。

出现静默丢失、实体类型错写、批准漂移、重复 op 或索引不一致时，批量提交自动停在影子预览和诊断状态。
