# DealPilot DSH 实现规范 V0.1

> 本文档是开发手册，面向实现者。每个阶段包含具体任务、输入输出、验收条件和关键代码片段。

> **验收状态（2026-08-26）**：S0-S6、S8-S9 及 Workspace/session、业务视图、导入、确认、Goal/Workflow、性能和安全增强均已落地；TypeScript 编译和 `node --test tests/*.test.mjs`（26/26）通过，A2A/浏览器契约和真实 `/dealpilot` 交互已验证。S7 的 WhatsApp Chrome 扩展闭环是本轮唯一未交付项。文中旧的 `[ ]` 复选框是阶段设计时的执行清单，不代表当前实现状态。

---

## S0：环境准备与项目初始化

### 目标
创建一个可安装、可运行的 DSH 插件包骨架。

### 任务

#### 0.1 初始化插件包

```powershell
cd D:\Ai Native\dealpilot-dsh\plugin
pnpm init
pnpm add js-yaml
pnpm add -D typescript @types/node @types/js-yaml
```

编辑 `plugin/package.json`：

```json
{
  "name": "dealpilot-dsh",
  "version": "0.1.0",
  "description": "DealPilot — AI-native sales workspace on DeepSeek Harness",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./client": "./client/client.js",
    "./cordis.patch.yml": "./cordis.patch.yml"
  },
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    },
    "client": {
      "inject": [
        "@deepseek-ai/dsh-client-runtime"
      ],
      "platform": "web"
    }
  },
  "dependencies": {
    "js-yaml": "^4.1.0"
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.1"
  }
}
```

#### 0.2 创建 cordis.patch.yml

```yaml
# plugin/cordis.patch.yml
- insert:
    - id: dealpilot
      name: 'dealpilot-dsh'
```

#### 0.3 创建 Agent Preset

`plugin/agent-preset/preset.yml`：

```yaml
name: DealPilot 销售工作台
description: AI-native 销售工作空间：客户管理、交易跟踪、行动安排、WhatsApp 闭环
```

`plugin/agent-preset/agent.cordis.yml`：

```yaml
# DealPilot Agent Preset
# 基于 standard preset，添加 DealPilot 6 个工具

# ── identity ──
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: |-
      You are a DealPilot sales assistant powered by the {{model}} model.
      Your working directory is {{cwd}}.
      
      You help manage customers, deals, and actions in an OKF Workspace.
      Use the dealpilot_* tools for business operations.
      Always distinguish facts, inferences, and unknowns.
      High-impact operations require user confirmation.

- id: agent-instructions
  name: '@deepseek-ai/dsh-agent-instructions'
  config:
    maxBytes: 65536

# ── shell ──
- id: tool-pwsh
  name: '@deepseek-ai/dsh-tool-pwsh'
  disabled: !!js process.platform !== 'win32'

# ── filesystem ──
- id: tool-fs
  name: '@deepseek-ai/dsh-tool-fs'

- id: tool-fs-search
  name: '@deepseek-ai/dsh-tool-fs-search'

# ── jobs ──
- id: tool-jobs
  name: '@deepseek-ai/dsh-tool-jobs'

# ── goals ──
- id: tool-goal
  name: '@deepseek-ai/dsh-tool-goal'

# ── plan mode ──
- id: planning
  name: cordis:group
  group: true
  isolate:
    planMode: true
  config:
    - id: plan-mode
      name: '@deepseek-ai/dsh-plan-mode'

# ── delegation ──
- id: delegation
  name: cordis:group
  group: true
  isolate:
    workflowEngine: true
  config:
    - id: tool-subagent
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: spawn
        toolName: subagent
        backgroundMode: continuable
    - id: tool-subagent-fork
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: fork
        toolName: subagent_fork
        backgroundMode: continuable
    - id: workflow-worker-thread
      name: '@deepseek-ai/dsh-workflow-worker-thread'
      config:
        provider: spawn
    - id: tool-workflow
      name: '@deepseek-ai/dsh-tool-workflow'

# ── other tools ──
- id: tool-ask-user
  name: '@deepseek-ai/dsh-tool-ask-user'

- id: tool-todo
  name: '@deepseek-ai/dsh-tool-todo'
  config:
    allowParallelInProgress: true

- id: tool-web
  name: '@deepseek-ai/dsh-tool-web'
  config:
    fetch: false
    searchTimeoutMs: 60000

# ── DealPilot 工具组 ──
- id: dealpilot-core
  name: cordis:group
  group: true
  isolate:
    dealpilot: true
  config:
    - id: dealpilot-snapshot
      name: './lib/snapshot.js'
      config:
        defaultWorkspace: 'D:/Ai Native/dealpilot-workspace'

    - id: dealpilot-write
      name: './lib/write-tool.js'
      config:
        defaultWorkspace: 'D:/Ai Native/dealpilot-workspace'

    - id: dealpilot-action
      name: './lib/action-tool.js'
      config:
        defaultWorkspace: 'D:/Ai Native/dealpilot-workspace'

    - id: dealpilot-import
      name: './lib/import-tool.js'
      config:
        defaultWorkspace: 'D:/Ai Native/dealpilot-workspace'

    - id: dealpilot-search
      name: './lib/search-tool.js'
      config:
        defaultWorkspace: 'D:/Ai Native/dealpilot-workspace'

    - id: dealpilot-whatsapp
      name: './lib/whatsapp-tool.js'
      config:
        defaultWorkspace: 'D:/Ai Native/dealpilot-workspace'
```

#### 0.4 安装到 DSH

```powershell
# 方式1：直接 link
cd D:\Ai Native\dealpilot-dsh\plugin
pnpm link --global
dsh plugin --profile web add dealpilot-dsh

# 方式2：本地路径引用
# 编辑 ~/.dsh/profiles/web/package.json，添加:
# "dependencies": { "dealpilot-dsh": "file:../../../../Ai Native/dealpilot-dsh/plugin" }
```

#### 0.5 验收标准

- [ ] `dsh web` 正常启动，无报错
- [ ] Agent Preset 列表中出现 "DealPilot 销售工作台"
- [ ] 切换到 DealPilot preset 后，Agent 对话正常

---

## S1：okf-utils.ts — OKF 公共函数库

### 目标
实现所有工具共享的 OKF 读写函数。

### 文件

`plugin/lib/okf-utils.ts`

### 函数清单

```typescript
// 1. 读取 YAML frontmatter
async function readYamlFrontmatter(filePath: string): Promise<{ meta: Record<string, any>; body: string }>

// 2. 写入 YAML frontmatter
async function writeYamlFrontmatter(filePath: string, meta: Record<string, any>, body: string): Promise<void>

// 3. 追加业务事件
async function appendBusinessEvent(workspace: string, event: {
  occurred_at: string;
  event_type: string;
  customer_ref?: string;
  deal_ref?: string;
  action_ref?: string;
  channel: string;
  summary?: string;
}): Promise<void>

// 4. 更新 Storage 索引
async function updateStorageIndex(workspace: string, entity: 'customer' | 'deal' | 'action', data: any): Promise<void>

// 5. 读取 Storage 索引
async function readStorageIndex(workspace: string, entity: 'customer' | 'deal' | 'action' | 'snapshot'): Promise<any>

// 6. 生成 ref
function generateRef(entity: string, title: string): string

// 7. 规范化引用路径
function normalizeRef(workspace: string, basePath: string, value: string): string

// 8. 验证 Workspace 结构
async function validateWorkspace(workspace: string): Promise<boolean>
```

### 关键实现

#### readYamlFrontmatter

```typescript
import * as fs from 'node:fs/promises';
import * as yaml from 'js-yaml';

export async function readYamlFrontmatter(filePath: string): Promise<{
  meta: Record<string, any>;
  body: string;
}> {
  const raw = await fs.readFile(filePath, 'utf-8');
  const normalized = raw.replace(/\r\n/g, '\n');

  // 检查是否以 --- 开头
  if (!normalized.startsWith('---\n')) {
    throw new Error(`Missing YAML frontmatter in ${filePath}`);
  }

  // 找到第二个 ---
  const endIndex = normalized.indexOf('\n---\n', 4);
  if (endIndex === -1) {
    throw new Error(`Unterminated YAML frontmatter in ${filePath}`);
  }

  const yamlStr = normalized.slice(4, endIndex);
  const body = normalized.slice(endIndex + 5);

  const meta = yaml.load(yamlStr) as Record<string, any>;
  if (typeof meta !== 'object' || meta === null) {
    throw new Error(`Invalid YAML frontmatter in ${filePath}`);
  }

  return { meta, body };
}
```

#### writeYamlFrontmatter

```typescript
export async function writeYamlFrontmatter(
  filePath: string,
  meta: Record<string, any>,
  body: string
): Promise<void> {
  const yamlStr = yaml.dump(meta, {
    lineWidth: -1,
    noRefs: true,
    sortKeys: false,
  });
  const content = `---\n${yamlStr}---\n\n${body.trimEnd()}\n`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf-8');
}
```

#### appendBusinessEvent

```typescript
export async function appendBusinessEvent(
  workspace: string,
  event: Record<string, any>
): Promise<void> {
  const eventsPath = path.join(workspace, 'knowledge', 'events', 'business-events.jsonl');
  await fs.mkdir(path.dirname(eventsPath), { recursive: true });

  const line = JSON.stringify(event) + '\n';
  await fs.appendFile(eventsPath, line, 'utf-8');
}
```

#### generateRef

```typescript
export function generateRef(entity: string, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64);
  const date = new Date().toISOString().slice(0, 10);
  return `knowledge/${entity}s/${date}-${slug}.md`;
}
```

### 验收标准

- [ ] 能正确读取含 YAML frontmatter 的 .md 文件
- [ ] 能正确写入 YAML frontmatter（保留 body 内容）
- [ ] 能追加 JSONL 事件行
- [ ] 能读写 Storage 索引 JSON 文件
- [ ] 能生成合法 ref 路径
- [ ] 能拒绝 `../` 路径穿越

---

## S2：snapshot.ts — 确定性快照工具

### 目标
从 Go 版 `workspace_snapshot.go` 移植核心逻辑到 TypeScript，实现 `dealpilot_snapshot` 工具。

### 文件

`plugin/lib/snapshot.ts`

### 核心类型

```typescript
interface WorkspaceSnapshot {
  generated_at: string;
  latest_event_at?: string;
  workspace_name: string;
  summary: {
    customers: number;
    active_deals: number;
    today: number;
    overdue: number;
    risks: number;
    confirmation: number;
  };
  today: TodayItem[];
  customers: CustomerItem[];
  deals: DealItem[];
  funnel: FunnelBucket[];
  activity: ActivityItem[];
  warnings: WarningItem[];
}

interface TodayItem {
  bucket: 'overdue' | 'today' | 'risk' | 'confirmation';
  action_ref: string;
  customer_ref?: string;
  deal_ref?: string;
  customer_name: string;
  deal_title: string;
  title: string;
  due_at?: string;
  priority: string;
  reason?: string;
}

interface CustomerItem {
  ref: string;
  title: string;
  status: string;
  source_category: string;
  relationship_stage: string;
  market?: string;
  icp_fit: string;
  priority: string;
  updated_at?: string;
  profile?: string[];
  open_questions?: string[];
  contacts?: { ref: string; title: string; role?: string; email?: string; phone?: string }[];
}

interface DealItem {
  ref: string;
  title: string;
  customer_ref?: string;
  customer_name: string;
  status: string;
  funnel_stage: string;
  priority: string;
  risk_level: string;
  risk_summary?: string;
  current_action?: string;
  updated_at?: string;
  goal?: string;
  confirmed_facts?: string[];
  inferences?: string[];
  open_questions?: string[];
  risks?: string[];
  actions?: ActionItem[];
}

interface ActionItem {
  ref: string;
  title: string;
  status: string;
  due_at?: string;
  priority: string;
  reason?: string;
  updated_at?: string;
}

interface FunnelBucket {
  stage: string;
  count: number;
}

interface ActivityItem {
  occurred_at: string;
  event_type: string;
  customer_ref?: string;
  deal_ref?: string;
  source_ref?: string;
  channel?: string;
}

interface WarningItem {
  ref?: string;
  message: string;
}
```

### 核心逻辑

```typescript
export async function buildSnapshot(
  workspace: string,
  now: Date = new Date()
): Promise<WorkspaceSnapshot> {
  // 1. 验证 workspace
  if (!await validateWorkspace(workspace)) {
    throw new Error('DealPilot workspace is not ready');
  }

  // 2. 读取所有概念文件
  const customers = await readConceptDir(workspace, 'knowledge/customers');
  const deals = await readConceptDir(workspace, 'knowledge/deals');
  const actions = await readConceptDir(workspace, 'knowledge/actions');
  const contacts = await readConceptDir(workspace, 'knowledge/contacts');
  const products = await readConceptDir(workspace, 'knowledge/products');

  const warnings: WarningItem[] = [];

  // 3. 构建客户索引
  const contactsByCustomer = buildContactsByCustomer(workspace, contacts);
  const customerByRef = new Map<string, CustomerItem>();
  const customerList: CustomerItem[] = [];

  for (const doc of customers) {
    const customer = customerFromDocument(doc);
    if (customer.status === 'archived') continue;
    customer.contacts = contactsByCustomer.get(customer.ref) || [];
    customerByRef.set(customer.ref, customer);
    customerList.push(customer);
  }

  // 4. 构建交易索引
  const productByRef = buildProductIndex(products);
  const dealByRef = new Map<string, DealItem>();
  const dealList: DealItem[] = [];

  for (const doc of deals) {
    const deal = dealFromDocument(workspace, doc, customerByRef);
    if (deal.status === 'archived') continue;
    enrichDealDetails(workspace, deal, doc, productByRef, actions);
    dealByRef.set(deal.ref, deal);
    dealList.push(deal);
  }

  // 5. 计算优先级
  applyCustomerPriorities(customerList, dealList);

  // 6. 构建 Today
  const todayItems = buildToday(workspace, actions, dealByRef, customerByRef, now);

  // 7. 构建 Funnel
  const funnel = buildFunnel(dealList);

  // 8. 读取业务事件
  const { activity, eventWarnings } = await readBusinessEvents(workspace);
  warnings.push(...eventWarnings);

  // 如果无事件，从概念文件生成
  if (activity.length === 0) {
    activity.push(...conceptActivity([...customers, ...deals, ...actions]));
  }

  // 9. 排序
  sortCustomers(customerList);
  sortDeals(dealList);
  sortToday(todayItems);

  // 10. 汇总
  const summary = {
    customers: customerList.length,
    active_deals: dealList.filter(d => isActiveDeal(d)).length,
    today: todayItems.length,
    overdue: todayItems.filter(t => t.bucket === 'overdue').length,
    risks: dealList.filter(d => isRiskDeal(d)).length,
    confirmation: todayItems.filter(t => t.bucket === 'confirmation').length,
  };

  return {
    generated_at: now.toISOString(),
    latest_event_at: activity[0]?.occurred_at,
    workspace_name: path.basename(workspace),
    summary,
    today: todayItems.slice(0, 50),
    customers: customerList,
    deals: dealList,
    funnel,
    activity: activity.slice(0, 30),
    warnings,
  };
}
```

### 工具注册

```typescript
export function apply(ctx: any) {
  const harness = ctx.get('harness');
  if (!harness) return;

  harness.registerTool(ctx, harness.defineTool({
    name: 'dealpilot_snapshot',
    description: `读取 DealPilot OKF Workspace 并返回确定性快照。

快照包含完整的 Today（今日/逾期/风险/待确认行动）、Customers（客户列表+详情）、
Deals（交易列表+详情）、Funnel（各阶段数量分布）、Activity（最近30条业务事件）。

快照是纯读取操作，不调用 LLM，不修改任何文件。
Workspace 路径默认为配置的路径。`,
    parameters: {
      type: 'object',
      properties: {
        workspacePath: {
          type: 'string',
          description: 'OKF Workspace 的绝对路径'
        }
      },
      required: []
    },
    output: {
      schema: { type: 'object' },
      render(_agent: any, value: string) {
        const s = JSON.parse(value);
        return [{ type: 'text', text: formatSnapshotSummary(s) }];
      }
    },
    async execute(args: any) {
      const workspace = args.workspacePath || ctx.config?.defaultWorkspace;
      return JSON.stringify(await buildSnapshot(workspace));
    }
  }));
}
```

### 验收标准

- [ ] 对标准 workspace-template 返回合法 Snapshot
- [ ] 空 workspace 返回 customers: 0, deals: 0, today: 0
- [ ] 单个无效 .md 文件进入 warnings，不阻止其他文件
- [ ] Today 的 overdue/today/risk/confirmation 分类正确
- [ ] Funnel 各阶段数量正确
- [ ] 20 个 Deal 的 Snapshot 在 1 秒内返回

---

## S3：write-tool.ts — 通用写入工具

### 目标
实现 `dealpilot_write` 工具，统一处理 Customer/Deal/Action 的创建和更新。

### 文件

`plugin/lib/write-tool.ts`

### 核心逻辑

```typescript
export function apply(ctx: any) {
  const harness = ctx.get('harness');
  if (!harness) return;

  harness.registerTool(ctx, harness.defineTool({
    name: 'dealpilot_write',
    description: `在 DealPilot OKF Workspace 中创建或更新业务对象。

支持三种实体类型：
- customer: 客户公司。字段：title, source_category, relationship_stage, market, icp_fit, status, profile, contacts
- deal: 交易机会。字段：title, customer, funnel_stage, priority, risk_level, risk_summary, status, goal, products
- action: 行动任务。字段：title, deal, status, due_at, priority, reason, check_condition

支持三种操作：
- create: 创建新对象（不需要 ref）
- update: 更新已有对象（需要 ref）
- archive: 归档对象（设置 status: archived）

规则：
- 每个 Deal 最多一个 active Action
- 创建/更新后自动追加 business-events.jsonl
- 归档操作需要用户确认（高影响操作）`,
    parameters: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['create', 'update', 'archive', 'merge'] },
        entity: { type: 'string', enum: ['customer', 'deal', 'action'] },
        ref: { type: 'string', description: '目标对象引用路径（update/archive 时必需）' },
        fields: {
          type: 'object',
          description: '要写入的字段。create 时必需 title；update 时只写提供的字段；merge 使用 ref/source_ref'
        }
      },
      required: ['operation', 'entity', 'fields']
    },
    async execute(args: any) {
      const workspace = ctx.config?.defaultWorkspace;
      const { operation, entity, ref, fields } = args;
      const now = new Date().toISOString();

      if (operation === 'create') {
        return await createEntity(workspace, entity, fields, now);
      } else if (operation === 'update') {
        if (!ref) throw new Error('update 操作需要 ref 参数');
        return await updateEntity(workspace, entity, ref, fields, now);
      } else if (operation === 'archive') {
        if (!ref) throw new Error('archive 操作需要 ref 参数');
        return await archiveEntity(workspace, entity, ref, now);
      }
    }
  }));
}

async function createEntity(
  workspace: string,
  entity: string,
  fields: Record<string, any>,
  now: string
): Promise<string> {
  const ref = generateRef(entity, fields.title || 'untitled');
  const filePath = path.join(workspace, ref);

  const meta: Record<string, any> = {
    title: fields.title,
    status: fields.status || 'active',
    generated: { by: 'dealpilot-dsh', at: now }
  };

  // 复制实体特定字段
  const entityFields = getEntityFields(entity);
  for (const key of entityFields) {
    if (fields[key] !== undefined) meta[key] = fields[key];
  }

  const body = generateDefaultBody(entity, fields);

  await writeYamlFrontmatter(filePath, meta, body);
  await appendBusinessEvent(workspace, {
    occurred_at: now,
    event_type: `${entity}.created`,
    [`${entity}_ref`]: ref,
    channel: 'chat',
    generated_by: 'dealpilot-dsh'
  });
  await updateStorageIndex(workspace, entity, { ref, ...meta, updated_at: now });

  return JSON.stringify({ ok: true, ref, title: fields.title });
}

async function updateEntity(
  workspace: string,
  entity: string,
  ref: string,
  fields: Record<string, any>,
  now: string
): Promise<string> {
  const filePath = path.join(workspace, ref);
  const { meta, body } = await readYamlFrontmatter(filePath);

  // 合并字段
  const updated = { ...meta };
  for (const [key, value] of Object.entries(fields)) {
    if (key === 'title' || key === 'ref' || key === 'generated') continue;
    updated[key] = value;
  }
  updated.generated = { ...(meta.generated || {}), at: now };

  await writeYamlFrontmatter(filePath, updated, body);
  await appendBusinessEvent(workspace, {
    occurred_at: now,
    event_type: `${entity}.updated`,
    [`${entity}_ref`]: ref,
    channel: 'chat',
    generated_by: 'dealpilot-dsh',
    summary: Object.keys(fields).join(', ')
  });
  await updateStorageIndex(workspace, entity, { ref, ...updated, updated_at: now });

  return JSON.stringify({ ok: true, ref, updatedFields: Object.keys(fields) });
}
```

### 验收标准

- [ ] 能创建 customer，生成合法 .md 文件
- [ ] 能更新 deal 的 risk_level，保留其他字段不变
- [ ] 能归档 customer（status: archived）
- [ ] 创建/更新后 business-events.jsonl 有对应事件
- [ ] 创建/更新后 Storage 索引更新
- [ ] 写入 YAML frontmatter 格式正确（无缩进错误）

---

## S4：action-tool.ts — 行动状态转换工具

### 目标
实现 `dealpilot_action_transition` 工具。

### 文件

`plugin/lib/action-tool.ts`

### 核心逻辑

```typescript
const VALID_TRANSITIONS: Record<string, string[]> = {
  'active': ['complete', 'cancel', 'block'],
  'planned': ['active', 'cancel'],
  'blocked': ['reopen', 'cancel'],
  'done': ['reopen'],
  'cancelled': ['reopen'],
};

export async function transitionAction(
  workspace: string,
  ref: string,
  transition: string,
  options: { reason?: string; due_at?: string; evidence?: string },
  now: string
): Promise<string> {
  const filePath = path.join(workspace, ref);
  const { meta, body } = await readYamlFrontmatter(filePath);

  const currentStatus = meta.status || 'unknown';
  const allowed = VALID_TRANSITIONS[currentStatus] || [];

  if (!allowed.includes(transition)) {
    throw new Error(
      `Invalid transition: ${currentStatus} → ${transition}. ` +
      `Allowed: ${allowed.join(', ')}`
    );
  }

  // 特殊校验：每个 Deal 最多一个 active Action
  if (transition === 'active' || (transition === 'reopen' && currentStatus !== 'active')) {
    await validateActiveActionLimit(workspace, meta.deal, ref);
  }

  // 更新状态
  const updated = { ...meta };
  updated.status = transition === 'complete' ? 'done' :
                   transition === 'cancel' ? 'cancelled' :
                   transition === 'block' ? 'blocked' :
                   transition === 'reopen' ? 'active' : transition;

  if (options.reason) updated.reason = options.reason;
  if (options.due_at) updated.due_at = options.due_at;
  if (options.evidence) updated.completion_evidence = options.evidence;
  updated.generated = { ...(meta.generated || {}), at: now };

  await writeYamlFrontmatter(filePath, updated, body);
  await appendBusinessEvent(workspace, {
    occurred_at: now,
    event_type: `action.${transition === 'complete' ? 'completed' :
                        transition === 'cancel' ? 'cancelled' :
                        transition === 'block' ? 'blocked' :
                        transition === 'reopen' ? 'reopened' : transition}`,
    action_ref: ref,
    deal_ref: meta.deal,
    channel: 'chat',
    generated_by: 'dealpilot-dsh',
    summary: options.reason || ''
  });
  await updateStorageIndex(workspace, 'action', { ref, ...updated, updated_at: now });

  return JSON.stringify({
    ok: true,
    ref,
    previousStatus: currentStatus,
    newStatus: updated.status
  });
}
```

### 验收标准

- [ ] active → complete 成功
- [ ] active → block 成功
- [ ] active → cancel 成功
- [ ] blocked → reopen 成功（回到 active）
- [ ] done → reopen 成功（重新打开）
- [ ] 拒绝非法转换（如 done → active 直接跳）
- [ ] 同一 Deal 下创建第二个 active Action 时拒绝
- [ ] 每次转换追加 business-events.jsonl

---

## S5：import-tool.ts — 批量导入工具

### 目标
实现 `dealpilot_import` 工具。

### 文件

`plugin/lib/import-tool.ts`

### 核心逻辑

```typescript
export async function importFromInbox(
  workspace: string,
  options: {
    sourcePath?: string;
    sourceCategory?: string;
    autoDedup?: boolean;
  },
  now: string
): Promise<string> {
  const inboxPath = path.join(workspace, options.sourcePath || 'sources/inbox');
  const files = await fs.readdir(inboxPath).catch(() => []);

  const results = {
    total: files.length,
    created: 0,
    skipped: 0,
    merged: 0,
    customers: [] as string[],
    warnings: [] as string[]
  };

  for (const file of files) {
    const filePath = path.join(inboxPath, file);
    const stat = await fs.stat(filePath);
    if (stat.isDirectory()) continue;

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const extracted = extractCustomers(content);

      for (const customer of extracted) {
        if (options.autoDedup !== false) {
          const existing = await findDuplicateCustomer(workspace, customer.title);
          if (existing) {
            results.merged++;
            results.warnings.push(`${customer.title} 与现有客户 ${existing} 重复，已跳过`);
            continue;
          }
        }

        const ref = generateRef('customer', customer.title);
        const meta = {
          title: customer.title,
          status: 'active',
          source_category: options.sourceCategory || 'import',
          relationship_stage: 'new',
          market: customer.market || '',
          icp_fit: 'unknown',
          generated: { by: 'dealpilot-dsh', at: now }
        };

        const body = [
          '# Profile',
          customer.profile || '_待补充_',
          '# Qualification',
          '_待补充_',
          '# Open questions',
          '_待补充_'
        ].join('\n\n');

        await writeYamlFrontmatter(path.join(workspace, ref), meta, body);
        results.created++;
        results.customers.push(customer.title);
      }
    } catch (err: any) {
      results.warnings.push(`${file}: ${err.message}`);
    }
  }

  return JSON.stringify(results);
}
```

### 验收标准

- [ ] 能解析 CSV 文件
- [ ] 能解析 Markdown 表格
- [ ] 能解析纯文本列表
- [ ] 自动去重正常工作
- [ ] 每个客户创建独立的 .md 文件
- [ ] 导入后追加 business-events.jsonl

---

## S6：search-tool.ts — 搜索工具

### 目标
实现 `dealpilot_search` 工具。

### 文件

`plugin/lib/search-tool.ts`

### 核心逻辑

```typescript
export async function searchEntities(
  workspace: string,
  query: string,
  entity: string,
  filters?: Record<string, string>
): Promise<string> {
  // 优先从 Storage 索引搜索
  const index = await readStorageIndex(workspace, entity === 'all' ? 'customer' : entity);
  const items = Array.isArray(index) ? index : [];

  const queryLower = query.toLowerCase();
  const results = items.filter((item: any) => {
    // 关键词匹配
    if (query && !item.title?.toLowerCase().includes(queryLower)) return false;

    // 过滤器匹配
    if (filters) {
      for (const [key, value] of Object.entries(filters)) {
        if (value && item[key] !== value) return false;
      }
    }

    return true;
  });

  return JSON.stringify({
    query,
    entity,
    count: results.length,
    results: results.slice(0, 20)
  });
}
```

### 验收标准

- [ ] 按名称模糊搜索客户
- [ ] 按阶段筛选交易
- [ ] 按风险等级筛选交易
- [ ] 按来源筛选客户
- [ ] 空查询返回所有

---

## S7：whatsapp-tool.ts — WhatsApp 集成工具

### 目标
实现 `dealpilot_whatsapp` 工具，与 Chrome 扩展通信。

### 文件

`plugin/lib/whatsapp-tool.ts`

### 核心逻辑

```typescript
// 注册 HTTP endpoint 接收 Chrome 扩展的消息
export function apply(ctx: any) {
  const harness = ctx.get('harness');
  if (!harness) return;

  // 注册工具
  harness.registerTool(ctx, harness.defineTool({
    name: 'dealpilot_whatsapp',
    description: `与 WhatsApp Chrome 扩展通信，拉取当前对话消息、分析内容、生成回复草稿。

action 参数：
- fetch: 拉取当前 WhatsApp 对话的最新消息
- analyze: 分析消息内容，更新关联的 Deal 状态
- draft: 基于分析结果生成回复草稿`,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['fetch', 'analyze', 'draft'] },
        conversationKey: { type: 'string' },
        messages: { type: 'array', items: { type: 'object' } }
      },
      required: ['action']
    },
    async execute(args: any) {
      // 处理逻辑
      if (args.action === 'analyze' && args.messages) {
        // 分析消息，更新 Deal
        const analysis = analyzeWhatsAppMessages(args.messages);
        return JSON.stringify(analysis);
      }
      return JSON.stringify({ ok: true, action: args.action });
    }
  }));
}
```

### Chrome 扩展通信

```javascript
// extension/sidepanel.js
async function sendToDSH(messages) {
  const response = await fetch('http://127.0.0.1:3080/api/dealpilot/whatsapp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'new_message',
      conversationKey: getCurrentConversationKey(),
      messages
    })
  });
  const result = await response.json();
  renderActionPackage(result);
}
```

### 验收标准

- [ ] Chrome 扩展能成功 POST 消息到 DSH
- [ ] DSH Agent 能分析消息并更新 Deal
- [ ] 扩展能展示 Action Package（交易快照 + 草稿）
- [ ] 用户能批准草稿插入 WhatsApp 输入框

---

## S8：Dashboard Client UI

### 目标
在 DSH Web GUI 中注册 DealPilot 侧边栏和工作台。

### 文件

`plugin/client/client.ts` 和 `plugin/client/dashboard/*.tsx`

### 侧边栏

```typescript
// client/dashboard/Sidebar.tsx
function Sidebar(props: any) {
  const [today, setToday] = React.useState(null);
  const [loading, setLoading] = React.useState(true);

  const refresh = React.useCallback(async () => {
    setLoading(true);
    try {
      const result = await props.host.call('dealpilot:refresh-sidebar', {});
      setToday(result);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => { refresh(); }, []);

  if (loading) return React.createElement('div', null, 'Loading...');

  return React.createElement('div', { className: 'dealpilot-sidebar' },
    React.createElement('h3', null, '📊 DealPilot'),
    React.createElement('div', { className: 'dp-summary' },
      React.createElement('span', { className: 'dp-badge overdue' }, `🔴 逾期 ${today.summary.overdue}`),
      React.createElement('span', { className: 'dp-badge today' }, `🟡 今日 ${today.summary.today}`),
      React.createElement('span', { className: 'dp-badge risk' }, `🟠 风险 ${today.summary.risks}`),
      React.createElement('span', { className: 'dp-badge confirm' }, `🔵 待确认 ${today.summary.confirmation}`),
    ),
    React.createElement('div', { className: 'dp-today-list' },
      today.today.slice(0, 5).map((item: any) =>
        React.createElement('div', { key: item.action_ref, className: `dp-today-item ${item.bucket}` },
          React.createElement('span', null, item.title),
          React.createElement('span', { className: 'dp-meta' }, `${item.customer_name} · ${item.priority}`)
        )
      )
    ),
    // The full workbench is an in-page view on /dealpilot; it does not create a
    // separate dashboard route or replace the default DSH conversation at /.
    React.createElement('button', { onClick: () => window.dispatchEvent(new CustomEvent('dealpilot:open-view', { detail: { view: 'deals' } })) }, '📋 完整工作台'),
    React.createElement('button', { onClick: refresh }, '🔄 刷新')
  );
}
```

### 完整工作台

```typescript
// client/dashboard/Dashboard.tsx (通过 page.content slot 注册)
function Dashboard(props: any) {
  const [tab, setTab] = React.useState('today');
  const [snapshot, setSnapshot] = React.useState(null);

  React.useEffect(() => {
    props.host.call('dealpilot:refresh-dashboard', {}).then(setSnapshot);
  }, []);

  const tabs = ['Today', 'Customers', 'Deals', 'Funnel', 'Activity'];

  return React.createElement('div', { className: 'dealpilot-dashboard' },
    // Tab 导航
    React.createElement('div', { className: 'dp-tabs' },
      tabs.map(t => React.createElement('button', {
        key: t,
        className: `dp-tab ${tab === t.toLowerCase() ? 'active' : ''}`,
        onClick: () => setTab(t.toLowerCase())
      }, t))
    ),
    // Tab 内容
    tab === 'today' && React.createElement(TodayView, { data: snapshot?.today }),
    tab === 'customers' && React.createElement(CustomersView, { data: snapshot?.customers }),
    tab === 'deals' && React.createElement(DealsView, { data: snapshot?.deals }),
    tab === 'funnel' && React.createElement(FunnelView, { data: snapshot?.funnel }),
    tab === 'activity' && React.createElement(ActivityView, { data: snapshot?.activity }),
  );
}
```

### 验收标准

- [ ] 侧边栏在 DSH Web GUI 中可见
- [ ] 侧边栏显示 Today 摘要数量
- [ ] 点击刷新时侧边栏更新（不调用 LLM）
- [ ] 完整工作台页面可切换 5 个标签页
- [ ] 客户列表可搜索和筛选
- [ ] 点击客户名称打开详情抽屉
- [ ] 点击交易名称打开详情抽屉

---

## S9：端到端集成测试

### 目标
验证完整流程：对话操作 → OKF 写入 → Dashboard 刷新。

### 测试场景

#### 场景 1：创建客户 → 看板可见

```
1. 用户在 DSH 对话中说："创建一个客户，叫 Acme Corp，来源是展会，市场德国"
2. Agent 调用 dealpilot_write(operation: create, entity: customer, fields: {...})
3. 验证：knowledge/customers/2026-08-17-acme-corp.md 已创建
4. 验证：business-events.jsonl 有 customer.created 事件
5. 用户点击侧边栏 [刷新]
6. 验证：侧边栏显示 customers: 1
7. 用户打开完整工作台 → Customers 标签
8. 验证：Acme Corp 出现在列表中
```

#### 场景 2：更新交易 → Today 变化

```
1. 用户说："给 Acme 创建一个交易，叫智能家居认证报价"
2. Agent 调用 dealpilot_write(operation: create, entity: deal, fields: {...})
3. 用户说："把 Acme 的报价标记为高风险，认证延期了"
4. Agent 调用 dealpilot_write(operation: update, entity: deal, ref: ..., fields: {risk_level: high, risk_summary: ...})
5. 用户说："安排明天跟进，提醒我问认证进度"
6. Agent 调用 dealpilot_write(operation: create, entity: action, fields: {title: ..., deal: ..., due_at: ..., priority: P1})
7. 刷新 Dashboard
8. 验证：Today 中出现 Acme 的行动（逾期或今日，取决于到期日）
9. 验证：Deals 中 Acme 显示 risk_level: high
```

#### 场景 3：行动完成 → Today 清除

```
1. 用户说："认证报价已经确认了，完成这个行动"
2. Agent 调用 dealpilot_action_transition(ref: ..., transition: complete)
3. 刷新 Dashboard
4. 验证：Acme 的行动不再出现在 Today 中
5. 验证：Activity 中出现 action.completed 事件
```

### 验收标准

- [ ] 场景 1 全部通过
- [ ] 场景 2 全部通过
- [ ] 场景 3 全部通过
- [ ] 重启 DSH 后，OKF 数据完整保留
- [ ] 切换回 DealPilot preset 后，Dashboard 正常显示
- [ ] 0 次自动发送消息
- [ ] 0 次数据丢失

---

## 附录：开发顺序总览

```
S0: 环境准备 (0.5 天)
 │
 ├── S1: okf-utils.ts (0.5 天)
 │    公共函数库
 │
 ├── S2: snapshot.ts (1 天)
 │    核心工具，验证数据流
 │
 ├── S3: write-tool.ts (1 天)
 │    通用写入，验证 OKF 写入
 │
 ├── S4: action-tool.ts (0.5 天)
 │    状态转换，验证业务规则
 │
 ├── S5: import-tool.ts (0.5 天)
 │    批量导入
 │
 ├── S6: search-tool.ts (0.5 天)
 │    搜索
 │
 ├── S7: whatsapp-tool.ts (1 天)
 │    WhatsApp 集成 + Chrome 扩展
 │
 ├── S8: Dashboard UI (2 天)
 │    侧边栏 + 工作台
 │
 └── S9: 端到端测试 (1 天)
     验证完整流程

总计：~8.5 天
```
