import { createHash, randomUUID } from 'node:crypto';
import { currentWorkspacePath, currentWorkspaceSessionId } from './workspace-context.js';
import { canonicalHash, createApproval, consumeApprovalRecord, readApproval, workspaceFingerprint } from './approval-store.js';
import { getDealPilotSession } from './dealpilot-session.js';

type FeedbackKind = 'bug' | 'feature';
type Feedback = { id: string; kind: FeedbackKind; title: string; body: string; fingerprint: string; status: string; createdAt: string; approvalId?: string };
const drafts = new Map<string, Feedback>();

function consumedApprovalMatchesFeedback(approval: any, payload: unknown, workspacePath: string, workspaceId: string, sessionId: string): boolean {
  return approval?.schema === 'dealpilot.approval/v2'
    && approval.status === 'consumed'
    && approval.tool === 'dealpilot_feedback_submit'
    && approval.workspace_id === workspaceId
    && approval.workspace_fingerprint === workspaceFingerprint(workspacePath)
    && approval.session_id === sessionId
    && approval.schema_version === 'dealpilot.feedback/v2'
    && approval.payload_hash === canonicalHash(payload);
}

function redact(value: string): string {
  return value.replace(/[A-Za-z]:\\[^\n ]+/g, '[workspace-path]')
    .replace(/(?:token|secret|cookie|authorization)\s*[:=]\s*[^\s,]+/gi, '$1=[redacted]')
    .replace(/(?:customer|deal|contact)\s*[:=]\s*[^\n]+/gi, '$1=[redacted]');
}

export function createFeedback(input: { kind?: FeedbackKind; title: string; body: string; reproduction?: string[]; expected?: string; actual?: string }): Feedback {
  const kind = input.kind === 'feature' ? 'feature' : 'bug';
  const body = redact([input.body, input.reproduction?.length ? `\nReproduction:\n${input.reproduction.join('\n')}` : '', input.expected ? `\nExpected: ${input.expected}` : '', input.actual ? `\nActual: ${input.actual}` : '', `\nPlugin: dealpilot-dsh ${process.env.npm_package_version || '0.1.1'}`, `\nRuntime: Node ${process.versions.node}`].join(''));
  const fingerprint = createHash('sha256').update(`${kind}:${input.title}:${body}`).digest('hex').slice(0, 16);
  const item: Feedback = { id: `feedback_${randomUUID()}`, kind, title: redact(input.title), body, fingerprint, status: 'draft', createdAt: new Date().toISOString() };
  drafts.set(item.id, item); return item;
}

export function registerFeedbackTools(ctx: Record<string, any>, harness: any, hostCtx?: any): void {
  harness.registerTool(ctx, harness.defineTool({
    name: 'dealpilot_feedback_create', description: '生成脱敏后的 GitHub bug 或 feature 反馈草稿，不会发送网络请求。',
    parameters: { type: 'object', properties: { kind: { type: 'string', enum: ['bug', 'feature'] }, title: { type: 'string' }, body: { type: 'string' }, reproduction: { type: 'array', items: { type: 'string' } }, expected: { type: 'string' }, actual: { type: 'string' } }, required: ['title', 'body'] }, output: { schema: { type: 'object' } },
    async execute(args: any) { return createFeedback(args); },
  }));
  harness.registerTool(ctx, harness.defineTool({
    name: 'dealpilot_feedback_submit', description: '经持久化用户批准后生成 GitHub New Issue 地址。',
    parameters: { type: 'object', properties: { feedback_id: { type: 'string' } }, required: ['feedback_id'] }, output: { schema: { type: 'object' } },
    async execute(args: { feedback_id: string }, exec: any = {}) {
      const item = drafts.get(args.feedback_id); if (!item) throw new Error('Feedback 草稿不存在');
      const workspacePath = currentWorkspacePath();
      const sessionId = currentWorkspaceSessionId();
      if (!workspacePath || !sessionId) throw new Error('请先选择 DealPilot Workspace');
      const session = getDealPilotSession(sessionId);
      if (!session) throw new Error('请先选择 DealPilot Workspace');
      const payload = { feedback_id: item.id, fingerprint: item.fingerprint, title: item.title, body: item.body };
      const preview = { title: item.title, body: item.body, fingerprint: item.fingerprint };
      if (item.status === 'submitted') {
        const url = `https://github.com/round123/dealpilot-dsh/issues/new?title=${encodeURIComponent(item.title)}&body=${encodeURIComponent(item.body)}`;
        return { ok: true, feedback_id: item.id, approval_id: item.approvalId, status: item.status, preview, url, message: '反馈已经提交；返回之前的草稿地址。' };
      }
      let approval = item.approvalId ? readApproval(workspacePath, item.approvalId) : undefined;
      if (approval && !['pending', 'consumed'].includes(approval.status)) approval = undefined;
      if (!approval) {
        let hostApproval: any;
        try { hostApproval = hostCtx?.get?.('approval') ?? hostCtx?.approval; } catch { hostApproval = hostCtx?.approval; }
        if (!hostApproval || typeof hostApproval.request !== 'function' || !exec?.agent) {
          return { ok: false, requires_approval: true, approval_status: 'unavailable', feedback_id: item.id, preview, message: '当前没有可用的用户审批通道；反馈未提交，也没有生成批准令牌。' };
        }
        let outcome: any = 'unavailable';
        try {
          outcome = await hostApproval.request({
            agent: exec.agent,
            toolName: 'dealpilot_feedback_submit',
            ...(exec.callId ? { callId: exec.callId } : {}),
            reason: [
              'DealPilot 需要用户批准打开一个 GitHub Issue 页面。',
              `feedback_id=${item.id}`,
              `preview=${JSON.stringify(preview)}`,
              '请核对脱敏后的标题和正文后再批准。',
            ].join('\n'),
            ...(exec.signal ? { signal: exec.signal } : {}),
          });
        } catch { outcome = 'unavailable'; }
        if (outcome !== 'allowed-once') {
          return { ok: false, requires_approval: true, approval_status: ['rejected', 'cancelled', 'unavailable'].includes(outcome) ? outcome : 'unavailable', feedback_id: item.id, preview, message: outcome === 'rejected' ? '用户未批准该反馈。' : outcome === 'cancelled' ? '审批已取消；反馈未提交。' : '当前没有可用的用户审批通道；反馈未提交，也没有生成批准令牌。' };
        }
        approval = createApproval({
          tool: 'dealpilot_feedback_submit', workspacePath, workspaceId: session.workspaceId, sessionId,
          payload, preview, actor: 'user', schemaVersion: 'dealpilot.feedback/v2',
        }).record;
        item.approvalId = approval.approval_id;
      }
      if (approval.status === 'consumed') {
        if (item.status !== 'submitted' && !consumedApprovalMatchesFeedback(approval, payload, workspacePath, session.workspaceId, sessionId)) {
          return { ok: false, requires_approval: false, approval_status: 'consumed', feedback_id: item.id, approval_id: approval.approval_id, preview, message: '批准已消费但反馈内容绑定不一致；请检查运行记录后再处理。' };
        }
      } else {
        try {
          consumeApprovalRecord(approval, {
            tool: 'dealpilot_feedback_submit', workspacePath, workspaceId: session.workspaceId, sessionId,
            payload, schemaVersion: 'dealpilot.feedback/v2', actor: 'user',
          });
        } catch (error: any) {
          const latest = item.approvalId ? readApproval(workspacePath, item.approvalId) : undefined;
          return { ok: false, requires_approval: latest?.status === 'pending', approval_status: latest?.status || 'unavailable', feedback_id: item.id, approval_id: item.approvalId, preview, error: error?.message || String(error), message: latest?.status === 'pending' ? '反馈未提交；批准记录仍 pending，可在确认依据后重试。' : '反馈未提交；请依据批准记录重新处理。' };
        }
      }
      item.status = 'submitted';
      const url = `https://github.com/round123/dealpilot-dsh/issues/new?title=${encodeURIComponent(item.title)}&body=${encodeURIComponent(item.body)}`;
      return { ok: true, feedback_id: item.id, approval_id: item.approvalId, status: item.status, preview, url };
    },
  }));
}
