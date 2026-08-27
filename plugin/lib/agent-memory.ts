import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { appendBusinessEvent, readYamlFrontmatter, updateStorageIndex, writeYamlFrontmatter, type BusinessEvent } from './okf-utils.js';
import { createConfirmation, consumeConfirmation } from './confirmation.js';
import { resolveWorkspace } from './okf-utils.js';
import { IMPORT_SCHEMA, validateCanonicalDocument } from './canonical-import.js';

type Content = { format?: 'markdown' | 'text' | 'json'; value: unknown };
type Evidence = { sourceRef: string; location?: string; excerpt?: string; [key: string]: unknown };
type Operation = {
  operation: 'create' | 'update' | 'append' | 'link';
  target: { ref?: string; kind?: string; label?: string; [key: string]: unknown };
  content?: Content;
  metadata?: Record<string, unknown>;
  evidence?: Evidence[];
  rationale?: string;
  uncertainty?: string;
};
type Proposal = {
  proposal_id: string;
  session_id: string;
  workspace: string;
  operations: Operation[];
  status: 'proposed' | 'partially_applied' | 'applied';
  applied_operations: number[];
  created_at: string;
  updated_at: string;
};

const proposalDir = (workspace: string) => path.join(workspace, 'storage', 'proposals');
const proposalPath = (workspace: string, id: string) => path.join(proposalDir(workspace), `${id}.json`);

function safeRelative(workspace: string, value: string): string {
  if (!value || path.isAbsolute(value) || value.includes('..')) throw new Error('引用必须是当前 Workspace 内的相对路径');
  const normalized = value.replaceAll('\\', '/');
  const resolved = path.resolve(workspace, normalized);
  const rel = path.relative(workspace, resolved);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('引用必须位于当前 Workspace');
  return rel.replaceAll('\\', '/');
}

async function readReference(workspace: string, ref: string): Promise<{ ref: string; content: string; metadata?: Record<string, any> }> {
  const relative = safeRelative(workspace, ref);
  const filePath = path.join(workspace, relative);
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) throw new Error('引用必须指向文件');
  const content = await fs.readFile(filePath, 'utf8');
  if (relative.endsWith('.md')) {
    try {
      const parsed = await readYamlFrontmatter(filePath);
      return { ref: relative, content: parsed.body, metadata: parsed.meta };
    } catch { /* non-OKF text remains readable */ }
  }
  if (relative.endsWith('.json')) {
    try {
      const parsed = JSON.parse(content);
      if (parsed?.schema === IMPORT_SCHEMA) validateCanonicalDocument(parsed);
    } catch (error: any) {
      if (error?.message?.startsWith('canonical JSON')) throw error;
      if (error instanceof SyntaxError) throw new Error('JSON 内容无效');
    }
  }
  return { ref: relative, content };
}

function bodyFromContent(content?: Content): string {
  if (!content) return '';
  if (content.format === 'json' || typeof content.value === 'object') return JSON.stringify(content.value, null, 2);
  return String(content.value ?? '');
}

function provenanceText(operation: Operation): string {
  const evidence = Array.isArray(operation.evidence) && operation.evidence.length
    ? operation.evidence.map(item => `- ${JSON.stringify(item)}`).join('\n')
    : '';
  const lines = ['## Agent context'];
  if (operation.rationale) lines.push('', `Rationale: ${operation.rationale}`);
  if (operation.uncertainty) lines.push('', `Uncertainty: ${operation.uncertainty}`);
  if (evidence) lines.push('', 'Evidence:', evidence);
  return lines.length > 1 ? `${lines.join('\n')}\n` : '';
}

function entityFromRef(ref: string): string | undefined {
  const match = /^knowledge\/([^/]+)\//.exec(ref);
  return match ? match[1].replace(/s$/, '') : undefined;
}

async function saveProposal(workspace: string, proposal: Proposal): Promise<void> {
  await fs.mkdir(proposalDir(workspace), { recursive: true });
  await fs.writeFile(proposalPath(workspace, proposal.proposal_id), JSON.stringify({ ...proposal, workspace: undefined }, null, 2) + '\n', 'utf8');
}

async function loadProposal(workspace: string, id: string): Promise<Proposal> {
  try {
    const value = JSON.parse(await fs.readFile(proposalPath(workspace, id), 'utf8'));
    if (!value || value.proposal_id !== id || !Array.isArray(value.operations)) throw new Error('invalid');
    return { ...value, workspace };
  } catch { throw new Error(`提案不存在：${id}`); }
}

function validateEvidence(workspace: string, operations: Operation[]): void {
  for (const operation of operations) {
    for (const evidence of Array.isArray(operation.evidence) ? operation.evidence : []) {
      if (!evidence || typeof evidence.sourceRef !== 'string') throw new Error('证据必须包含 sourceRef');
      safeRelative(workspace, evidence.sourceRef);
    }
  }
}

async function createRef(workspace: string, target: Operation['target']): Promise<string> {
  const kind = String(target.kind || 'notes').toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  const label = String(target.label || 'untitled').trim();
  const slug = label.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-|-$/g, '').slice(0, 64) || randomUUID();
  const dir = kind.endsWith('s') ? kind : `${kind}s`;
  const ref = `knowledge/${dir}/${new Date().toISOString().slice(0, 10)}-${slug}.md`;
  if (path.resolve(workspace, ref).startsWith(path.resolve(workspace))) return ref;
  throw new Error('无法生成安全引用');
}

async function applyOperation(workspace: string, proposal: Proposal, operation: Operation, index: number): Promise<{ ref: string; operation: string }> {
  let ref = operation.target.ref ? safeRelative(workspace, String(operation.target.ref)) : '';
  if (operation.operation === 'create') {
    if (!ref) ref = await createRef(workspace, operation.target);
    const metadata = { ...(operation.metadata || {}), ...(operation.target.label ? { title: operation.target.label } : {}), status: operation.metadata?.status || 'active', generated: { by: 'dealpilot-agent', at: new Date().toISOString(), proposal_id: proposal.proposal_id } };
    const body = `${bodyFromContent(operation.content)}${provenanceText(operation)}`;
    await writeYamlFrontmatter(path.join(workspace, ref), metadata, body);
  } else {
    if (!ref) throw new Error(`${operation.operation} 需要 target.ref`);
    const filePath = path.join(workspace, ref);
    const current = await readYamlFrontmatter(filePath);
    let body = current.body;
    if (operation.operation === 'append' || operation.operation === 'link') {
      const addition = bodyFromContent(operation.content);
      const provenance = provenanceText(operation);
      body = addition || provenance ? `${body.trimEnd()}\n\n${addition.trim()}${addition && provenance ? '\n\n' : ''}${provenance.trim()}\n` : body;
    } else if (operation.content) {
      body = `${bodyFromContent(operation.content)}${provenanceText(operation)}`;
    }
    const metadata = { ...current.meta, ...(operation.metadata || {}), generated: { ...(current.meta.generated || {}), by: 'dealpilot-agent', at: new Date().toISOString(), proposal_id: proposal.proposal_id } };
    await writeYamlFrontmatter(filePath, metadata, body);
  }
  const event: BusinessEvent = { occurred_at: new Date().toISOString(), event_type: `agent.${operation.operation}`, channel: 'conversation', generated_by: 'dealpilot-agent', proposal_id: proposal.proposal_id, operation_index: index, summary: operation.rationale || operation.target.label || ref };
  const entity = entityFromRef(ref);
  if (entity === 'customer') event.customer_ref = ref;
  if (entity === 'deal') event.deal_ref = ref;
  if (entity === 'action') event.action_ref = ref;
  await appendBusinessEvent(workspace, event);
  if (entity) {
    const current = await readYamlFrontmatter(path.join(workspace, ref));
    await updateStorageIndex(workspace, entity, { ref, ...current.meta, updated_at: new Date().toISOString() });
  }
  return { ref, operation: operation.operation };
}

export function registerAgentMemoryTools(ctx: Record<string, any>, harness: any): void {
  harness.registerTool(ctx, harness.defineTool({
    name: 'dealpilot_read',
    description: '读取当前 Workspace 内的证据、OKF 文档或转换结果。返回原文、元数据和可追溯引用，不做业务解释。',
    parameters: { type: 'object', properties: { ref: { type: 'string', description: 'Workspace 内相对引用' }, offset: { type: 'number' }, max_chars: { type: 'number' } }, required: ['ref'] },
    async execute(args: any) {
      const workspace = resolveWorkspace(ctx.config); const result = await readReference(workspace, String(args.ref));
      const requestedOffset = Number(args.offset ?? 0); const requestedMax = Number(args.max_chars ?? 50000);
      const offset = Number.isFinite(requestedOffset) ? Math.max(0, Math.floor(requestedOffset)) : 0;
      const max = Number.isFinite(requestedMax) ? Math.min(200000, Math.max(1, Math.floor(requestedMax))) : 50000;
      return JSON.stringify({ ...result, content: result.content.slice(offset, offset + max), truncated: offset + max < result.content.length, offset, total_chars: result.content.length });
    },
  }));
  harness.registerTool(ctx, harness.defineTool({
    name: 'dealpilot_propose',
    description: '保存 Agent 对当前 Workspace 的开放式变更提案。内容、元数据和语义由 Agent 根据证据决定；Harness 只保存来源和副作用边界。',
    parameters: { type: 'object', properties: { operations: { type: 'array', items: { type: 'object', additionalProperties: true } } }, required: ['operations'] },
    async execute(args: any, exec?: any) {
      const operations = Array.isArray(args.operations) ? args.operations : []; if (!operations.length) throw new Error('提案至少需要一个 operation');
      for (const operation of operations) if (!['create', 'update', 'append', 'link'].includes(operation?.operation) || !operation?.target) throw new Error('提案 operation 或 target 无效');
      const workspace = resolveWorkspace(ctx.config); validateEvidence(workspace, operations); const now = new Date().toISOString(); const proposal: Proposal = { proposal_id: `prop_${randomUUID()}`, session_id: String(exec?.agent?.id || ''), workspace, operations, status: 'proposed', applied_operations: [], created_at: now, updated_at: now };
      await saveProposal(workspace, proposal); return JSON.stringify({ proposal_id: proposal.proposal_id, status: proposal.status, operations: proposal.operations, message: '提案已保存，等待用户审阅和授权。' });
    },
  }));
  harness.registerTool(ctx, harness.defineTool({
    name: 'dealpilot_apply',
    description: '在用户确认后应用 Agent 提案，将开放式内容可靠写入 OKF，并记录来源、版本和业务事件。',
    parameters: { type: 'object', properties: { proposal_id: { type: 'string' }, confirmation_token: { type: 'string' } }, required: ['proposal_id'] },
    async execute(args: any, exec?: any) {
      const workspace = resolveWorkspace(ctx.config); const proposal = await loadProposal(workspace, String(args.proposal_id));
      const sessionId = String(exec?.agent?.id || '');
      if (!sessionId || proposal.session_id !== sessionId) throw new Error('提案不属于当前 session');
      if (proposal.status === 'applied') throw new Error('提案已应用，不能重复执行');
      const payload = { proposal_id: proposal.proposal_id, operations: proposal.operations, version: proposal.updated_at };
      if (!args.confirmation_token) return JSON.stringify(createConfirmation('dealpilot_apply', payload, '提案已准备完成，请审阅变更和来源后确认应用。', { proposal_id: proposal.proposal_id, operations: proposal.operations }));
      consumeConfirmation(args.confirmation_token, 'dealpilot_apply', payload);
      const results = []; for (let i = 0; i < proposal.operations.length; i++) { if (proposal.applied_operations.includes(i)) continue; try { results.push(await applyOperation(workspace, proposal, proposal.operations[i], i)); proposal.applied_operations.push(i); } catch (error: any) { proposal.status = 'partially_applied'; proposal.updated_at = new Date().toISOString(); await saveProposal(workspace, proposal); return JSON.stringify({ proposal_id: proposal.proposal_id, status: proposal.status, results, failed_operation: i, error: error.message, retryable: true }); } }
      proposal.status = 'applied'; proposal.updated_at = new Date().toISOString(); await saveProposal(workspace, proposal); return JSON.stringify({ proposal_id: proposal.proposal_id, status: proposal.status, results });
    },
  }));
}
