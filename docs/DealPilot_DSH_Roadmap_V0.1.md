# DealPilot DSH 开发路线图 V0.1

## S0：环境准备（0.5 天）

**目标**：创建可安装的 DSH 插件包骨架。

- [ ] 初始化 `plugin/` npm 包
- [ ] 创建 `cordis.patch.yml`
- [ ] 创建 Agent Preset（`agent.cordis.yml` + `preset.yml`）
- [ ] 安装到 DSH web profile
- [ ] 验证：`dsh web` 正常启动，DealPilot preset 可选

## S1：okf-utils.ts（0.5 天）

**目标**：实现所有工具共享的 OKF 读写函数。

- [ ] `readYamlFrontmatter` — 读取 YAML frontmatter + Markdown body
- [ ] `writeYamlFrontmatter` — 写入 YAML frontmatter + Markdown body
- [ ] `appendBusinessEvent` — 追加 JSONL 事件行
- [ ] `updateStorageIndex` — 更新 JSON 索引
- [ ] `readStorageIndex` — 读取 JSON 索引
- [ ] `generateRef` — 生成合法 ref 路径
- [ ] `normalizeRef` — 规范化引用路径（拒绝 `../`）
- [ ] `validateWorkspace` — 验证 Workspace 结构

## S2：snapshot.ts（1 天）

**目标**：实现 `dealpilot_snapshot` 工具。

- [ ] 注册 `dealpilot_snapshot` 工具
- [ ] 实现 `buildSnapshot` 核心逻辑
- [ ] 实现 `readConceptDir` / `readConceptFile`
- [ ] 实现 `customerFromDocument` / `dealFromDocument`
- [ ] 实现 `buildToday`（确定性规则）
- [ ] 实现 `buildFunnel`
- [ ] 实现 `readBusinessEvents`
- [ ] 验证：对空 workspace 返回合法空 Snapshot
- [ ] 验证：对标准 workspace-template 返回完整 Snapshot

## S3：write-tool.ts（1 天）

**目标**：实现 `dealpilot_write` 工具。

- [ ] 注册 `dealpilot_write` 工具
- [ ] 实现 `createEntity`（customer/deal/action）
- [ ] 实现 `updateEntity`
- [ ] 实现 `archiveEntity`
- [ ] 实现写入后自动追加事件
- [ ] 实现写入后自动更新索引
- [ ] 验证：创建 customer 生成合法 .md 文件
- [ ] 验证：更新 deal 保留其他字段
- [ ] 验证：归档后 status 变为 archived

## S4：action-tool.ts（0.5 天）

**目标**：实现 `dealpilot_action_transition` 工具。

- [ ] 注册 `dealpilot_action_transition` 工具
- [ ] 实现状态转换逻辑（complete/cancel/block/reopen/schedule）
- [ ] 实现转换合法性校验
- [ ] 实现每 Deal 最多一个 active Action 规则
- [ ] 验证：active → complete 成功
- [ ] 验证：active → block 成功
- [ ] 验证：blocked → reopen 成功
- [ ] 验证：拒绝非法转换

## S5：import-tool.ts（0.5 天）

**目标**：实现 `dealpilot_import` 工具。

- [ ] 注册 `dealpilot_import` 工具
- [ ] 实现 CSV 解析
- [ ] 实现 Markdown 表格解析
- [ ] 实现自动去重
- [ ] 实现批量写入
- [ ] 验证：导入 15 个客户成功

## S6：search-tool.ts（0.5 天）

**目标**：实现 `dealpilot_search` 工具。

- [ ] 注册 `dealpilot_search` 工具
- [ ] 实现按名称模糊搜索
- [ ] 实现按字段筛选
- [ ] 优先从 Storage 索引搜索
- [ ] 验证：搜索返回正确结果

## S7：whatsapp-tool.ts + Chrome 扩展（1 天）

**目标**：实现 WhatsApp 集成。

- [ ] 注册 `dealpilot_whatsapp` 工具
- [ ] 创建 Chrome 扩展骨架（manifest.json + background.js）
- [ ] 实现 Side Panel（sidepanel.html + sidepanel.js）
- [ ] 实现 Content Script（content.js — DOM 观察）
- [ ] 实现 HTTP 通信（扩展 → DSH）
- [ ] 实现草稿插入
- [ ] 验证：扩展能拉取 WhatsApp 消息
- [ ] 验证：DSH 能分析消息并返回草稿
- [ ] 验证：草稿能插入 WhatsApp 输入框

## S8：Dashboard Client UI（2 天）

**目标**：在 DSH Web GUI 中注册 DealPilot 侧边栏和工作台。

- [ ] 实现 `client/client.ts` 入口
- [ ] 实现 `Sidebar.tsx`（Today 摘要）
- [ ] 实现 `TodayView.tsx`（完整 Today 列表）
- [ ] 实现 `CustomersView.tsx`（客户列表 + 搜索 + 筛选）
- [ ] 实现 `DealsView.tsx`（交易列表 + 搜索 + 筛选）
- [ ] 实现 `FunnelView.tsx`（漏斗图）
- [ ] 实现 `ActivityView.tsx`（活动时间线）
- [ ] 实现 Customer 详情抽屉
- [ ] 实现 Deal 详情抽屉
- [ ] 实现 Host-Client 通信（refresh-sidebar / refresh-dashboard）
- [ ] 验证：侧边栏在 DSH Web GUI 中可见
- [ ] 验证：刷新按钮更新侧边栏（不调用 LLM）
- [ ] 验证：完整工作台可切换 5 个标签页

## S9：端到端集成测试（1 天）

**目标**：验证完整流程。

- [ ] 场景 1：创建客户 → 看板可见
- [ ] 场景 2：创建交易 → 更新风险 → 看板反映
- [ ] 场景 3：创建行动 → 完成行动 → Today 清除
- [ ] 场景 4：WhatsApp 消息 → 分析 → 草稿 → 插入
- [ ] 场景 5：重启 DSH → OKF 数据完整保留
- [ ] 场景 6：错误处理（无效 YAML、非法转换、路径穿越）

---

## 时间线总览

```
Week 1:
  Day 1: S0 + S1（环境 + 公共函数）
  Day 2: S2（Snapshot 工具）
  Day 3: S3（Write 工具）
  Day 4: S4 + S5（Action + Import 工具）
  Day 5: S6 + S7 开始（Search + WhatsApp 开始）

Week 2:
  Day 6: S7 完成（WhatsApp 完成）
  Day 7-8: S8（Dashboard UI）
  Day 9: S9（端到端测试）
  Day 10: Buffer / 修 bug

总计：~8.5 天有效工作时间
```

---

## 后续版本规划

### V0.2（MVP 增强）

- WhatsApp 消息自动关联客户（基于电话号码）
- 跟进提醒（DSH Goal 到期通知）
- 客户详情页中的"交给 AI 处理"按钮
- 导入文件格式扩展（XLSX）

### V0.3（功能扩展）

- 邮件集成（Gmail API）
- 开发信模板
- 客户画像自动补全
- 转化率统计

### V1.0（完整产品）

- 多 Agent Runtime 支持
- 团队协作
- 云端同步
- 完整 BI 看板