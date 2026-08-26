import { randomUUID } from 'node:crypto';
import { currentWorkspaceSessionId } from './workspace-context.js';

type PendingConfirmation = {
  sessionId: string;
  operation: string;
  payload: Record<string, any>;
  createdAt: number;
};

const pending = new Map<string, PendingConfirmation>();
const TTL_MS = 15 * 60 * 1000;

function sessionId(): string {
  return currentWorkspaceSessionId() || 'unknown-session';
}

function prune(): void {
  const cutoff = Date.now() - TTL_MS;
  for (const [token, item] of pending) if (item.createdAt < cutoff) pending.delete(token);
}

export function createConfirmation(
  operation: string,
  payload: Record<string, any>,
  message: string,
  preview: Record<string, any> = payload,
): Record<string, any> {
  prune();
  const token = randomUUID();
  pending.set(token, { sessionId: sessionId(), operation, payload, createdAt: Date.now() });
  return {
    ok: false,
    requires_confirmation: true,
    confirmation_token: token,
    operation,
    preview,
    message,
    expires_in_seconds: Math.floor(TTL_MS / 1000),
  };
}

export function consumeConfirmation(
  token: string | undefined,
  operation: string,
  payload: Record<string, any>,
): void {
  prune();
  if (!token) throw new Error('此操作需要用户确认。请先向用户展示预览，获得确认后再使用 confirmation_token 重试。');
  const item = pending.get(token);
  if (!item || item.sessionId !== sessionId() || item.operation !== operation) {
    throw new Error('confirmation_token 无效、已过期或不属于当前 DealPilot 会话');
  }
  const expected = JSON.stringify(item.payload);
  if (expected !== JSON.stringify(payload)) {
    throw new Error('确认内容与待执行操作不一致，请重新确认');
  }
  pending.delete(token);
}

export function clearPendingConfirmations(): void {
  pending.clear();
}
