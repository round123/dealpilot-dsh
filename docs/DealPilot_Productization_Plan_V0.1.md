# DealPilot 产品化方案 V0.1

> **落地边界**：当前主入口为 `/dealpilot`，默认 `/` 保持原生 DSH。Workspace、`dealpilot-sales` preset、业务导航和业务视图均为 `/dealpilot` 页面级能力；WhatsApp Chrome 扩展明确排除在本轮交付之外。

> **当前实现状态（2026-08-26）**：除 WhatsApp Chrome 扩展实际闭环外，本文所列 Workspace、会话、业务工具、业务视图、导入、生命周期和确认流程均已实现并通过 TypeScript、Node 全量测试和浏览器交互验证。DSH 全局 session catalog 在历史 profile 中可能把 DealPilot 会话带回 `/`，该宿主限制按当前产品决策暂不处理。

## 1. 目标

将 DealPilot 从“DSH 业务工具 + 独立看板”产品化为一个销售工作台：

- 用户访问 `/dealpilot` 后先选择一个 DSH Workspace；不需要手动创建目录或编辑路径配置。
- 对话仍然使用 DeepSeek Harness 的原生会话、Agent、流式响应和工具调用能力。
- DealPilot 通过自己的 App Shell、页面和插件扩展点提供销售业务 UI。
- 客户、交易、行动和导入等操作都可以在同一条对话上下文中完成并回显。

## 2. 非侵入性约束

这是本方案的硬性边界：

> 不修改 DSH 的默认对话页面。

DealPilot 不得修改宿主默认对话页的以下内容：

- 默认路由和 URL 行为
- 默认导航结构和布局
- 默认消息列表、输入框和会话历史组件
- 默认模型选择、设置和权限流程
- 默认工具调用展示逻辑

DealPilot 只允许通过 DSH 公开的插件能力接入：

- 自己的 `/dealpilot` 路由
- 自己的 `/api/dealpilot/*` API
- client slot / page slot / sidebar slot
- tool result view 或等价的工具结果扩展点
- Harness 提供的会话和 Agent runtime

如果某个 slot 或 API 尚未稳定，不通过修改宿主代码来补齐，而是先使用独立的 DealPilot 路由和兼容适配层。

## 3. 产品形态

`/dealpilot` 是 DealPilot 自己的工作台入口，不是 DSH 默认对话页的替代品。

建议的工作台结构：

```text
DealPilot App Shell
├── DealPilot 导航
├── Harness Conversation（复用宿主对话能力）
└── DealPilot Context Panel（客户、交易、行动和快照）
```

首屏默认显示 Today 视图和对话入口。用户可以在 DealPilot 内完成浏览、筛选、确认和追问；复杂的理解和执行仍然交给 Harness Agent。

## 4. Workspace 选择与初始化

### 4.1 用户体验

用户第一次打开 `/dealpilot` 时：

1. 从 DSH Workspace Registry 加载当前用户可访问的 Workspace 列表。
2. 用户选择 Workspace，服务端只通过 `workspaceId` 解析真实路径。
3. `inspect` 判断该 Workspace 是 `new`、`reusable` 或 `invalid`，检查过程不写文件。
4. 对 `new` Workspace，用户明确点击初始化后才创建 DealPilot 元数据、目录和索引；已有业务文件不会覆盖。
5. 初始化或复用完成后创建绑定该 Workspace 的 DealPilot session，并显示对话入口。

用户不需要复制模板、设置绝对路径或编辑 profile 配置。

### 4.2 存储边界

Workspace 的真实路径由 DSH Registry 管理。仅在兼容 API 未提供 `workspaceId` 时，才使用 DealPilot 自有的默认存储根目录：

```text
~/.dsh/storages/dealpilot/workspaces/default/
```

建议保留 workspace metadata：

```json
{
  "id": "dealpilot/workspaces/default",
  "name": "Sales workspace",
  "created_at": "2026-08-25T00:00:00.000Z",
  "setup_status": "ready",
  "timezone": "Asia/Shanghai"
}
```

初始化必须幂等：重复访问不能覆盖已有业务数据，也不能重复创建同一实体。

### 4.3 Workspace 管理边界

一个 DealPilot 页面 session 同时只绑定一个 Workspace，同时支持：

- workspace 列表
- workspace 切换
- workspace 命名和时区设置（由 DSH Registry 提供）
- 导出和归档

所有业务工具统一从 workspace manager 获取路径，不再由每个工具自行推断目录。

## 5. 路由和 API

### 5.1 页面路由

```text
/dealpilot                 工作台首页：Today + 对话
/dealpilot/today           今日工作
/dealpilot/customers       客户列表
/dealpilot/customers/:id   客户详情
/dealpilot/deals           交易列表
/dealpilot/deals/:id       交易详情
/dealpilot/actions         行动列表
/dealpilot/import          导入中心
/dealpilot/settings        workspace 设置
```

现有 `/dealpilot` 和看板 API 保持兼容；新页面逐步替换独立 Dashboard 的入口，而不是一次性删除旧页面。

### 5.2 API

```text
/api/dealpilot/bootstrap
/api/dealpilot/snapshot
/api/dealpilot/customers
/api/dealpilot/deals
/api/dealpilot/actions
/api/dealpilot/events
```

`bootstrap` 负责创建或加载 workspace，并返回：

- workspace metadata
- 首屏 snapshot
- onboarding 状态
- 当前用户可用的功能标志

## 6. 对话复用方案

### 6.1 复用范围

DealPilot 不重新实现以下能力：

- 聊天输入框和消息列表
- 流式输出
- 会话历史
- Agent 调度
- 模型选择
- 工具调用生命周期
- 权限、确认和错误处理

这些能力全部由 DeepSeek Harness 提供。

### 6.2 DealPilot 负责的部分

DealPilot 只提供业务上下文和业务视图：

- 当前 workspace
- 当前客户/交易/行动
- Today 和销售周期数据
- 工具结果的业务化渲染
- 写操作前的变更预览
- 写操作后的快照刷新

建议的上下文链路：

```text
Harness 会话
  ↓
DealPilot 当前页面上下文
  ↓
dealpilot_* 工具
  ↓
OKF Workspace
  ↓
业务事件和 UI 刷新
```

### 6.3 工具结果 UI

工具返回结构化结果后，DealPilot 使用自己的视图渲染器展示：

- `dealpilot_snapshot` → Today、客户、交易、漏斗和活动摘要
- `dealpilot_search` → 搜索结果列表和筛选条件
- `dealpilot_write` → 变更预览、确认状态和实体卡片
- `dealpilot_action_transition` → 行动状态变化和时间线事件
- `dealpilot_import` → 导入预览、去重结果和错误列表
- `dealpilot_whatsapp` → 消息摘要、证据和回复草稿

如果 Harness 当前版本不支持 tool result view，则先保留标准工具调用结果，并在 DealPilot 自己的 Context Panel 展示同步后的业务状态。

## 7. 销售周期设计

### 7.1 每日周期：Today

- 今日行动
- 逾期行动
- 高风险交易
- 最近发生的客户事件
- Agent 生成的今日工作建议

### 7.2 每周周期：Weekly Review

- 本周新增客户和交易
- 交易阶段变化
- 长时间未推进的交易
- 下周重点跟进
- Agent 生成周报和行动建议

### 7.3 交易生命周期

```text
Discovery → Qualification → Proposal → Negotiation → Won / Lost
```

### 7.4 行动生命周期

```text
Planned → In Progress → Blocked → Completed / Cancelled
```

首页优先回答“今天要做什么”，而不是只展示统计数字。

## 8. 分阶段实施计划

### Phase 1：产品入口和显式初始化

- 新增 workspace manager
- 新增 `/api/dealpilot/bootstrap`
- `/dealpilot` 首次访问加载 DSH Workspace Registry
- 空 workspace inspect 和显式初始化 onboarding
- Today 首屏
- 保持六个业务工具兼容

验收标准：新用户无需手动复制模板即可进入 DealPilot，并能通过对话创建第一条客户或交易。

### Phase 2：DealPilot 工作台

- 建立 DealPilot App Shell
- 左侧导航、Today、客户、交易、行动页面
- 接入 Harness 的 conversation slot 或等价扩展点
- 当前实体上下文面板
- 工具结果业务化渲染
- 写操作变更预览和确认

验收标准：用户在 `/dealpilot` 内完成“查询 → 修改 → 确认 → 刷新”，无需跳转默认对话页面。

当前已完成的宿主接入：

- 默认页面不注册 DealPilot sidebar 或 toolview slot
- `/dealpilot` 使用独立页面 Shell 承载原生 DSH 对话和业务视图
- 两个 slot 均为 additive contribution，不注册或替换 `root`

### Phase 3：销售周期和运营视图

- Deal lifecycle 页面
- Action lifecycle 页面
- 每日计划
- 每周复盘
- 高风险交易和停滞交易视图

验收标准：用户可以按日、周和交易生命周期管理工作，而不是只看静态看板。

### Phase 4：导入和外部渠道

- CSV/Markdown 导入向导
- 自动去重和导入预览
- WhatsApp 消息同步
- 证据和回复草稿
- workspace 切换、导出和归档

## 9. 技术拆分建议

```text
plugin/lib/workspace-manager.ts   创建、加载、校验 workspace
plugin/lib/bootstrap-route.ts     bootstrap API
plugin/client/app-shell/          DealPilot 页面壳层
plugin/client/components/         实体卡片、预览、时间线
plugin/client/views/              Today、客户、交易、行动
plugin/client/client.ts           仅注册 DealPilot 自己的 slots
```

业务工具不直接依赖 UI；UI 不直接读写 OKF 文件，统一通过 API 和工具层访问业务数据。

## 10. 质量和兼容性要求

- 默认 DSH 对话页面回归测试必须通过。
- DealPilot 路由、API 和工具需要独立测试。
- workspace 初始化必须幂等并覆盖空目录、已有数据和损坏 metadata 场景。
- 任何 Harness slot 能力都要做版本兼容检查。
- 不通过修改宿主源码解决 DealPilot 的 UI 需求。
- 旧 `/dealpilot` Dashboard API 保持至少一个兼容周期。

## 11. 结论

DealPilot 的产品化路线是“复用 Harness 对话能力 + 自己提供销售工作台”，而不是复制一个新的聊天应用，也不是改造 DSH 默认对话页。

第一步已落地 Workspace Registry 选择、显式初始化和 `/dealpilot` App Shell；第二步已接入 Harness 原生对话、会话和工具结果视图。这样可以在不修改默认对话页面的前提下，把 DealPilot 做成完整、可直接使用的产品。
