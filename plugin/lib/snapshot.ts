// DealPilot DSH — Snapshot Tool
// Reads the full OKF workspace and returns a deterministic snapshot.

import * as path from 'node:path';
import {
  readYamlFrontmatter,
  readConceptDir,
  validateWorkspace,
  resolveWorkspace,
  type OkfDocument,
  type IndexEntry,
} from './okf-utils.js';
import { reconcileGoalRuntime, type DealPilotRuntime } from './goal-runtime.js';
import { buildOperationalViews, type OperationalViews } from './operational-views.js';
import { snapshotPresentation } from './business-view.js';

// ── Types ────────────────────────────────────────────────────────────────────

interface CustomerSnapshot {
  ref: string;
  title: string;
  status: string;
  source_category: string;
  source_label?: string;
  relationship_stage: string;
  market?: string;
  icp_fit: string;
  priority: string;
  updated_at?: string;
  profile?: string[];
  qualification?: string[];
  open_questions?: string[];
  contacts: ContactEntry[];
  extra_metadata?: Record<string, any>;
  memory_excerpt?: string;
}

interface ContactEntry {
  ref: string;
  title: string;
  role?: string;
  email?: string;
  phone?: string;
}

interface DealSnapshot {
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
  correction_history?: string[];
  products: { ref: string; title: string }[];
  actions: ActionSnapshot[];
  extra_metadata?: Record<string, any>;
  memory_excerpt?: string;
}

interface ActionSnapshot {
  ref: string;
  title: string;
  deal_ref?: string;
  status: string;
  due_at?: string;
  priority: string;
  reason?: string;
  updated_at?: string;
  extra_metadata?: Record<string, any>;
  memory_excerpt?: string;
}

interface TodayItem {
  bucket: string;
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

interface FunnelStage {
  stage: string;
  count: number;
}

interface ActivityItem {
  occurred_at: string;
  event_type: string;
  customer_ref?: string;
  deal_ref?: string;
  source_ref?: string;
  channel: string;
  summary?: string;
  previous_stage?: string;
  next_stage?: string;
}

interface Snapshot {
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
  customers: CustomerSnapshot[];
  deals: DealSnapshot[];
  funnel: FunnelStage[];
  activity: ActivityItem[];
  operations: OperationalViews;
  runtime: DealPilotRuntime;
  warnings: { ref?: string; message: string }[];
}

// ── Registration ────────────────────────────────────────────────────────────

export function registerSnapshotTool(ctx: Record<string, any>, harness: any) {
  harness.registerTool(ctx, harness.defineTool({
    name: 'dealpilot_snapshot',
    description: `读取 DealPilot OKF Workspace 并返回确定性快照。

快照包含完整的 Today（今日/逾期/风险/待确认行动）、Customers（客户列表+详情）、
Deals（交易列表+详情）、Funnel（各阶段数量分布）、Activity（最近30条业务事件）。

快照是纯读取操作，不调用 LLM，不修改任何文件。
Workspace 由当前 DealPilot 会话绑定，不接受客户端路径参数。`,
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    output: {
      schema: { type: 'object' },
      render(_agent: any, value: string) {
        const s: Snapshot = JSON.parse(value);
        return [{ type: 'text', text: `${formatSnapshotSummary(s)}\nDATA_JSON: ${JSON.stringify(s)}` }];
      },
      presentationMeta(_args: any, value: Snapshot) {
        return snapshotPresentation(value);
      },
    },
    async execute(_args: Record<string, never>) {
      const workspace = resolveWorkspace(ctx.config);
      return JSON.stringify(await buildSnapshot(workspace));
    },
  }));
}

// ── Core: buildSnapshot ─────────────────────────────────────────────────────

export async function buildSnapshot(workspace: string, now = new Date()): Promise<Snapshot> {
  const warnings: { ref?: string; message: string }[] = [];

  if (!(await validateWorkspace(workspace))) {
    throw new Error('当前 DealPilot Workspace 尚未初始化或结构不完整');
  }

  const customers = await readConceptDir(workspace, 'knowledge/customers');
  const deals = await readConceptDir(workspace, 'knowledge/deals');
  const actions = await readConceptDir(workspace, 'knowledge/actions');
  const contacts = await readConceptDir(workspace, 'knowledge/contacts');
  const products = await readConceptDir(workspace, 'knowledge/products');

  const contactsByCustomer = buildContactsByCustomer(contacts);
  const productByRef = buildProductIndex(products);

  const customerByRef = new Map<string, CustomerSnapshot>();
  const customerList: CustomerSnapshot[] = [];

  for (const doc of customers) {
    try {
      const customer = customerFromDocument(doc);
      if (customer.status === 'archived') continue;
      customer.contacts = contactsByCustomer.get(customer.ref) || [];
      customerByRef.set(customer.ref, customer);
      customerList.push(customer);
    } catch (err: any) {
      warnings.push({ ref: doc.ref, message: '客户文件无法解析，已跳过' });
    }
  }

  const dealByRef = new Map<string, DealSnapshot>();
  const dealList: DealSnapshot[] = [];

  for (const doc of deals) {
    try {
      const deal = dealFromDocument(doc, customerByRef);
      if (deal.status === 'archived') continue;
      enrichDealDetails(deal, doc, productByRef, actions);
      dealByRef.set(deal.ref, deal);
      dealList.push(deal);
    } catch (err: any) {
      warnings.push({ ref: doc.ref, message: '交易文件无法解析，已跳过' });
    }
  }

  applyCustomerPriorities(customerList, dealList);
  const todayItems = buildToday(actions, dealByRef, customerByRef, now);
  const funnel = buildFunnel(dealList);
  const runtime = await reconcileGoalRuntime(workspace, actions, now, false);
  const { activity, eventWarnings } = await readBusinessEvents(workspace);
  warnings.push(...eventWarnings);

  if (activity.length === 0) {
    activity.push(...conceptActivity([...customers, ...deals, ...actions]));
  }

  sortCustomers(customerList);
  sortDeals(dealList);
  sortToday(todayItems);

  const summary = {
    customers: customerList.length,
    active_deals: dealList.filter(d => isActiveDeal(d)).length,
    today: todayItems.length,
    overdue: todayItems.filter(t => t.bucket === 'overdue').length,
    risks: dealList.filter(d => isRiskDeal(d)).length,
    confirmation: todayItems.filter(t => t.bucket === 'confirmation').length,
  };

  const operations = buildOperationalViews({ customers: customerList, deals: dealList, today: todayItems, activity }, now);

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
    operations,
    runtime,
    warnings,
  };
}

// ── Document Parsers ────────────────────────────────────────────────────────

function customerFromDocument(doc: OkfDocument): CustomerSnapshot {
  const { meta } = doc;
  return {
    ref: doc.ref,
    title: meta.title || 'Untitled',
    status: meta.status || 'active',
    source_category: meta.source_category || 'unknown',
    source_label: meta.source_label,
    relationship_stage: meta.relationship_stage || 'new',
    market: meta.market,
    icp_fit: meta.icp_fit || 'unknown',
    priority: meta.priority || 'unknown',
    updated_at: meta.generated?.at,
    profile: extractSection(doc.body, 'Profile'),
    qualification: extractSection(doc.body, 'Qualification'),
    open_questions: extractSection(doc.body, 'Open questions'),
    contacts: [],
    extra_metadata: extraMetadata(meta, ['title', 'status', 'source_category', 'source_label', 'relationship_stage', 'market', 'icp_fit', 'priority', 'generated']),
    memory_excerpt: doc.body.trim().slice(0, 1200) || undefined,
  };
}

function dealFromDocument(doc: OkfDocument, customerByRef: Map<string, CustomerSnapshot>): DealSnapshot {
  const { meta } = doc;
  const customerRef = meta.customer || '';
  const customer = customerByRef.get(customerRef);
  return {
    ref: doc.ref,
    title: meta.title || 'Untitled',
    customer_ref: customerRef || undefined,
    customer_name: customer?.title || meta.customer || 'Unknown',
    status: meta.status || 'active',
    funnel_stage: meta.funnel_stage || 'unknown',
    priority: meta.priority || 'unknown',
    risk_level: meta.risk_level || 'unknown',
    risk_summary: meta.risk_summary,
    current_action: meta.current_action,
    updated_at: meta.generated?.at || meta.last_activity_at,
    goal: extractSectionText(doc.body, 'Goal'),
    confirmed_facts: extractSection(doc.body, 'Confirmed facts'),
    inferences: extractSection(doc.body, 'Inferences'),
    open_questions: extractSection(doc.body, 'Open questions'),
    risks: extractSection(doc.body, 'Risks'),
    correction_history: extractSection(doc.body, 'Correction history'),
    products: [],
    actions: [],
    extra_metadata: extraMetadata(meta, ['title', 'status', 'customer', 'funnel_stage', 'priority', 'risk_level', 'risk_summary', 'last_activity_at', 'current_action', 'products', 'generated']),
    memory_excerpt: doc.body.trim().slice(0, 1200) || undefined,
  };
}

function actionFromDocument(doc: OkfDocument): ActionSnapshot {
  const { meta } = doc;
  return {
    ref: doc.ref,
    title: meta.title || 'Untitled',
    deal_ref: meta.deal,
    status: meta.status || 'planned',
    due_at: meta.due_at,
    priority: meta.priority || 'unknown',
    reason: meta.reason || extractSectionText(doc.body, 'Reason'),
    updated_at: meta.generated?.at,
    extra_metadata: extraMetadata(meta, ['title', 'status', 'deal', 'due_at', 'priority', 'reason', 'requires_human', 'generated']),
    memory_excerpt: doc.body.trim().slice(0, 1200) || undefined,
  };
}

function extraMetadata(meta: Record<string, any>, known: string[]): Record<string, any> | undefined {
  const knownKeys = new Set(known);
  const extra = Object.fromEntries(Object.entries(meta).filter(([key, value]) => !knownKeys.has(key) && value !== undefined));
  return Object.keys(extra).length ? extra : undefined;
}

// ── Index Builders ──────────────────────────────────────────────────────────

function buildContactsByCustomer(contacts: OkfDocument[]): Map<string, ContactEntry[]> {
  const map = new Map<string, ContactEntry[]>();
  for (const doc of contacts) {
    try {
      const { meta } = doc;
      const customerRef = meta.customer;
      if (!customerRef) continue;
      const entry: ContactEntry = {
        ref: doc.ref,
        title: meta.title || 'Unknown',
        role: meta.role,
        email: meta.email,
        phone: meta.phone,
      };
      if (!map.has(customerRef)) map.set(customerRef, []);
      map.get(customerRef)!.push(entry);
    } catch { /* skip */ }
  }
  return map;
}

function buildProductIndex(products: OkfDocument[]): Map<string, { ref: string; title: string }> {
  const map = new Map<string, { ref: string; title: string }>();
  for (const doc of products) {
    try {
      map.set(doc.ref, { ref: doc.ref, title: doc.meta.title || 'Unknown' });
    } catch { /* skip */ }
  }
  return map;
}

// ── Deal Enrichment ─────────────────────────────────────────────────────────

function enrichDealDetails(
  deal: DealSnapshot,
  dealDoc: OkfDocument,
  productByRef: Map<string, { ref: string; title: string }>,
  allActions: OkfDocument[],
) {
  const productRefs: string[] = dealDoc.meta.products || [];
  for (const ref of productRefs) {
    const p = productByRef.get(ref);
    if (p) deal.products.push(p);
  }

  const dealActions: ActionSnapshot[] = [];
  for (const actionDoc of allActions) {
    try {
      if (actionDoc.meta.deal === deal.ref) {
        dealActions.push(actionFromDocument(actionDoc));
      }
    } catch { /* skip */ }
  }
  deal.actions = dealActions;
}

// ── Priority Derivation ─────────────────────────────────────────────────────

function applyCustomerPriorities(customerList: CustomerSnapshot[], dealList: DealSnapshot[]) {
  const priorityOrder: Record<string, number> = { P1: 4, P2: 3, P3: 2, hold: 1, unknown: 0 };
  const bestByCustomer = new Map<string, string>();

  for (const deal of dealList) {
    if (!deal.customer_ref || !isActiveDeal(deal)) continue;
    const current = bestByCustomer.get(deal.customer_ref);
    const score = priorityOrder[deal.priority] || 0;
    if (!current || score > (priorityOrder[current] || 0)) {
      bestByCustomer.set(deal.customer_ref, deal.priority);
    }
  }

  for (const customer of customerList) {
    const best = bestByCustomer.get(customer.ref);
    if (best && (priorityOrder[best] || 0) > (priorityOrder[customer.priority] || 0)) {
      customer.priority = best;
    }
  }
}

// ── Today Builder ───────────────────────────────────────────────────────────

function buildToday(
  actions: OkfDocument[],
  dealByRef: Map<string, DealSnapshot>,
  customerByRef: Map<string, CustomerSnapshot>,
  _now: Date,
): TodayItem[] {
  const today = _now.toISOString().slice(0, 10);
  const items: TodayItem[] = [];

  for (const actionDoc of actions) {
    let action: ActionSnapshot;
    try {
      action = actionFromDocument(actionDoc);
    } catch { continue; }

    if (action.status !== 'active' && action.status !== 'blocked') continue;

    const deal = dealByRef.get(action.deal_ref || '');
    const customer = deal ? customerByRef.get(deal.customer_ref || '') : null;

    let bucket: string | undefined;
    let reason: string | undefined;

    if (action.status === 'active' && action.due_at && action.due_at < today) {
      bucket = 'overdue';
    } else if (action.status === 'active' && action.due_at === today) {
      bucket = 'today';
    } else if (action.status === 'active' && actionDoc.meta.requires_human === true) {
      bucket = 'confirmation';
      reason = action.reason || '需要人工确认';
    } else if (action.status === 'blocked') {
      bucket = 'risk';
      reason = action.reason || 'Blocked';
    } else if (deal && (isRiskDeal(deal) || deal.priority === 'P1')) {
      bucket = 'risk';
      reason = deal.risk_summary || (deal.priority === 'P1' ? 'P1 交易需要推进' : 'High risk deal');
    }

    if (!bucket) continue;

    items.push({
      bucket,
      action_ref: action.ref,
      customer_ref: customer?.ref,
      deal_ref: deal?.ref,
      customer_name: customer?.title || deal?.customer_name || 'Unknown',
      deal_title: deal?.title || 'Unknown',
      title: action.title,
      due_at: action.due_at,
      priority: action.priority,
      reason,
    });
  }

  return items;
}

// ── Funnel Builder ──────────────────────────────────────────────────────────

const FUNNEL_STAGES = [
  'new', 'qualified', 'contacted', 'replied',
  'opportunity', 'quoted', 'sample', 'won', 'lost', 'unknown',
];

function buildFunnel(dealList: DealSnapshot[]): FunnelStage[] {
  const counts = new Map<string, number>();
  for (const stage of FUNNEL_STAGES) counts.set(stage, 0);
  for (const deal of dealList) {
    if (!isActiveDeal(deal)) continue;
    const stage = deal.funnel_stage || 'unknown';
    counts.set(stage, (counts.get(stage) || 0) + 1);
  }
  return FUNNEL_STAGES.map(stage => ({ stage, count: counts.get(stage) || 0 }));
}

// ── Business Events ─────────────────────────────────────────────────────────

async function readBusinessEvents(workspace: string): Promise<{
  activity: ActivityItem[];
  eventWarnings: { message: string }[];
}> {
  const activity: ActivityItem[] = [];
  const warnings: { message: string }[] = [];
  const fs = await import('node:fs/promises');
  const eventsPath = path.join(workspace, 'knowledge', 'events', 'business-events.jsonl');

  try {
    const raw = await fs.readFile(eventsPath, 'utf-8');
    const lines = raw.trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const event = JSON.parse(line);
        activity.push({
          occurred_at: event.occurred_at,
          event_type: event.event_type,
          customer_ref: event.customer_ref,
          deal_ref: event.deal_ref,
          source_ref: event.source_ref,
          channel: event.channel,
          summary: event.summary,
          previous_stage: event.previous_stage,
          next_stage: event.next_stage,
        });
      } catch {
        warnings.push({ message: `Invalid JSONL line ${i + 1} in business-events.jsonl` });
      }
    }
  } catch (err: any) {
    if (err.code !== 'ENOENT') {
      warnings.push({ message: '业务事件文件无法读取，已跳过' });
    }
  }

  return { activity, eventWarnings: warnings };
}

function conceptActivity(docs: OkfDocument[]): ActivityItem[] {
  return docs
    .filter(d => d.meta?.generated?.at)
    .map(d => ({
      occurred_at: d.meta.generated.at,
      event_type: d.ref.includes('/customers/') ? 'customer.created' :
                  d.ref.includes('/deals/') ? 'deal.created' : 'action.created',
      customer_ref: d.meta.customer,
      deal_ref: d.meta.deal || (d.ref.includes('/deals/') ? d.ref : undefined),
      channel: 'import',
      summary: d.meta.title,
    }))
    .sort((a, b) => String(b.occurred_at || '').localeCompare(String(a.occurred_at || '')));
}

// ── Sorting ─────────────────────────────────────────────────────────────────

function sortCustomers(list: CustomerSnapshot[]) {
  const priOrder: Record<string, number> = { P1: 0, P2: 1, P3: 2, hold: 3, unknown: 4 };
  list.sort((a, b) => {
    const pa = priOrder[a.priority] ?? 4;
    const pb = priOrder[b.priority] ?? 4;
    if (pa !== pb) return pa - pb;
    return (a.title || '').localeCompare(b.title || '');
  });
}

function sortDeals(list: DealSnapshot[]) {
  const priOrder: Record<string, number> = { P1: 0, P2: 1, P3: 2, hold: 3, unknown: 4 };
  list.sort((a, b) => {
    const pa = priOrder[a.priority] ?? 4;
    const pb = priOrder[b.priority] ?? 4;
    if (pa !== pb) return pa - pb;
    return (a.title || '').localeCompare(b.title || '');
  });
}

function sortToday(items: TodayItem[]) {
  const bucketOrder: Record<string, number> = { overdue: 0, risk: 1, confirmation: 2, today: 3 };
  items.sort((a, b) => {
    const ba = bucketOrder[a.bucket] ?? 4;
    const bb = bucketOrder[b.bucket] ?? 4;
    if (ba !== bb) return ba - bb;
    if (a.due_at && b.due_at) return String(a.due_at).localeCompare(String(b.due_at));
    if (a.due_at) return -1;
    if (b.due_at) return 1;
    return (a.title || '').localeCompare(b.title || '');
  });
}

// ── Filters ─────────────────────────────────────────────────────────────────

function isActiveDeal(deal: DealSnapshot): boolean {
  return deal.status === 'active' || deal.status === 'blocked';
}

function isRiskDeal(deal: DealSnapshot): boolean {
  return (deal.risk_level === 'high' || deal.risk_level === 'critical') && isActiveDeal(deal);
}

// ── Section Parsers ─────────────────────────────────────────────────────────

function extractSection(body: string | undefined, sectionName: string): string[] | undefined {
  if (!body) return undefined;
  const lines = body.split('\n');
  const results: string[] = [];
  let inSection = false;

  for (const line of lines) {
    const headerMatch = line.match(/^#{1,3}\s+(.+)/);
    if (headerMatch) {
      if (headerMatch[1].trim().toLowerCase() === sectionName.toLowerCase()) {
        inSection = true;
        continue;
      } else if (inSection) {
        break;
      }
    }
    if (inSection && line.startsWith('- ')) {
      results.push(line.slice(2).trim());
    }
  }
  return results.length > 0 ? results : undefined;
}

function extractSectionText(body: string | undefined, sectionName: string): string | undefined {
  if (!body) return undefined;
  const lines = body.split('\n');
  let inSection = false;
  const paragraphs: string[] = [];

  for (const line of lines) {
    const headerMatch = line.match(/^#{1,3}\s+(.+)/);
    if (headerMatch) {
      if (headerMatch[1].trim().toLowerCase() === sectionName.toLowerCase()) {
        inSection = true;
        continue;
      } else if (inSection) {
        break;
      }
    }
    if (inSection) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('- ')) {
        paragraphs.push(trimmed);
      }
    }
  }
  return paragraphs.length > 0 ? paragraphs.join(' ') : undefined;
}

// ── Output Formatting ───────────────────────────────────────────────────────

function formatSnapshotSummary(snapshot: Snapshot): string {
  const s = snapshot.summary;
  const lines = [
    `## DealPilot Snapshot — ${snapshot.workspace_name}`,
    `Generated: ${snapshot.generated_at}`,
    '',
    `| Metric | Count |`,
    `|--------|------|`,
    `| Customers | ${s.customers} |`,
    `| Active Deals | ${s.active_deals} |`,
    `| Today Items | ${s.today} |`,
    `| Overdue | ${s.overdue} |`,
    `| At Risk | ${s.risks} |`,
    `| Needs Confirmation | ${s.confirmation} |`,
    `| Active Goals | ${(snapshot.runtime?.goals || []).filter(goal => goal.status === 'active' || goal.status === 'planned').length} |`,
    '',
  ];

  if (snapshot.today.length > 0) {
    lines.push('### Today');
    lines.push('');
    for (const item of snapshot.today.slice(0, 10)) {
      const icon = item.bucket === 'overdue' ? '🔴' :
                   item.bucket === 'risk' ? '🟡' :
                   item.bucket === 'confirmation' ? '🔵' : '🟢';
      lines.push(`- ${icon} **${item.title}** — ${item.customer_name} / ${item.deal_title} ${item.due_at ? `(due: ${item.due_at})` : ''}`);
    }
    if (snapshot.today.length > 10) {
      lines.push(`- ... and ${snapshot.today.length - 10} more`);
    }
    lines.push('');
  }

  if (snapshot.warnings.length > 0) {
    lines.push('### Warnings');
    for (const w of snapshot.warnings) {
      lines.push(`- ⚠ ${w.ref ? `${w.ref}: ` : ''}${w.message}`);
    }
  }

  return lines.join('\n');
}
