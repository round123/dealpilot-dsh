import { createHash, randomUUID } from 'node:crypto';
import { createConfirmation, consumeConfirmation } from './confirmation.js';

type FeedbackKind = 'bug' | 'feature';
type Feedback = { id: string; kind: FeedbackKind; title: string; body: string; fingerprint: string; status: string; createdAt: string };
const drafts = new Map<string, Feedback>();

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

export function registerFeedbackTools(ctx: Record<string, any>, harness: any): void {
  harness.registerTool(ctx, harness.defineTool({
    name: 'dealpilot_feedback_create', description: '生成脱敏后的 GitHub bug 或 feature 反馈草稿，不会发送网络请求。',
    parameters: { type: 'object', properties: { kind: { type: 'string', enum: ['bug', 'feature'] }, title: { type: 'string' }, body: { type: 'string' }, reproduction: { type: 'array', items: { type: 'string' } }, expected: { type: 'string' }, actual: { type: 'string' } }, required: ['title', 'body'] }, output: { schema: { type: 'object' } },
    async execute(args: any) { return createFeedback(args); },
  }));
  harness.registerTool(ctx, harness.defineTool({
    name: 'dealpilot_feedback_submit', description: '经用户确认后生成 GitHub New Issue 地址。',
    parameters: { type: 'object', properties: { feedback_id: { type: 'string' }, confirmation_token: { type: 'string' } }, required: ['feedback_id'] }, output: { schema: { type: 'object' } },
    async execute(args: { feedback_id: string; confirmation_token?: string }, exec: any = {}) {
      const item = drafts.get(args.feedback_id); if (!item) throw new Error('Feedback 草稿不存在');
      const payload = { feedback_id: item.id, fingerprint: item.fingerprint };
      const policy = exec?.config?.externalFeedback || exec?.agent?.externalFeedback || process.env.DEALPILOT_EXTERNAL_FEEDBACK || 'ask';
      const approval = exec?.approvalPolicy || exec?.approval_policy || exec?.agent?.approvalPolicy || exec?.agent?.approval_policy;
      const autoAllowed = policy === 'auto' && approval === 'never';
      if (!args.confirmation_token && !autoAllowed) return createConfirmation('dealpilot_feedback_submit', payload, '请确认后打开 GitHub Issue 草稿页面。', { title: item.title, body: item.body, fingerprint: item.fingerprint });
      if (!args.confirmation_token && autoAllowed) { item.status = 'submitted'; return { ok: true, feedback_id: item.id, status: item.status, auto_approved: true, url: `https://github.com/round123/dealpilot-dsh/issues/new?title=${encodeURIComponent(item.title)}&body=${encodeURIComponent(item.body)}` }; }
      consumeConfirmation(args.confirmation_token, 'dealpilot_feedback_submit', payload); item.status = 'submitted';
      const url = `https://github.com/round123/dealpilot-dsh/issues/new?title=${encodeURIComponent(item.title)}&body=${encodeURIComponent(item.body)}`;
      return { ok: true, feedback_id: item.id, status: item.status, url };
    },
  }));
}
