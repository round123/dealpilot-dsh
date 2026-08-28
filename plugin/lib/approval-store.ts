import { createHash, randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const APPROVAL_SCHEMA = 'dealpilot.approval/v2' as const;

export type ApprovalStatus = 'pending' | 'consumed' | 'expired' | 'revoked';

export interface ApprovalBinding {
  tool: string;
  workspacePath: string;
  sessionId: string;
  payload: unknown;
  workspaceId?: string;
  /** Schema of the approved payload (for example change-set/v2). */
  schemaVersion: string;
  baseRevision?: string;
  changeSetId?: string;
  changeSetHash?: string;
  interpretationId?: string;
  selectedOpIds?: string[];
  resolutions?: Record<string, unknown>;
}

export interface CreateApprovalInput extends ApprovalBinding {
  preview?: unknown;
  actor?: string;
  ttlMs?: number;
}

export interface ConsumeApprovalInput extends ApprovalBinding {
  actor?: string;
}

export interface ApprovalRecord {
  schema: typeof APPROVAL_SCHEMA;
  approval_id: string;
  status: ApprovalStatus;
  actor: string;
  tool: string;
  workspace_id: string;
  workspace_fingerprint: string;
  session_id: string;
  schema_version: string;
  base_revision?: string;
  change_set_id?: string;
  change_set_hash?: string;
  interpretation_id?: string;
  selected_op_ids: string[];
  resolutions: Record<string, unknown>;
  payload: unknown;
  payload_hash: string;
  preview?: unknown;
  preview_hash?: string;
  token_hash: string;
  created_at: string;
  expires_at: string;
  consumed_at?: string;
  consumed_by?: string;
  expired_at?: string;
  revoked_at?: string;
  revoked_by?: string;
  revoke_reason?: string;
}

export interface CreatedApproval {
  token: string;
  record: ApprovalRecord;
}

const DEFAULT_TTL_MS = 15 * 60 * 1000;
const MIN_TTL_MS = 30 * 1000;
const MAX_TTL_MS = 24 * 60 * 60 * 1000;
// Approval operations are synchronous because they guard a one-shot state
// transition. Keep stale reclamation conservative: an active owner process is
// never evicted merely because a long callback has not returned yet.
const LOCK_STALE_MS = 5 * 60 * 1000;
const LOCK_WAIT_MS = 5 * 1000;

function jsonValue(value: unknown, stack = new Set<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Approval payload must contain finite JSON numbers');
    return value;
  }
  if (value === undefined) return { $undefined: true };
  if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') {
    throw new Error(`Approval payload contains unsupported ${typeof value} value`);
  }
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return { $buffer_base64: value.toString('base64') };
  if (typeof value !== 'object') return value;
  if (stack.has(value)) throw new Error('Approval payload must not contain cycles');
  stack.add(value);
  try {
    if (Array.isArray(value)) return value.map(item => jsonValue(item, stack));
    const source = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(source).sort().map(key => [key, jsonValue(source[key], stack)]));
  } finally {
    stack.delete(value);
  }
}

/** Canonical JSON used for approval and change-set binding. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(jsonValue(value));
}

export function canonicalHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function normalizeWorkspace(workspacePath: string): string {
  if (!path.isAbsolute(workspacePath)) throw new Error('Approval workspace must be an absolute path');
  const resolved = path.resolve(workspacePath);
  try { return fs.realpathSync.native(resolved); } catch { return resolved; }
}

export function workspaceFingerprint(workspacePath: string): string {
  // Bind approvals to the canonical workspace identity. Callers commonly
  // arrive through a symlink or with a path whose case differs on Windows;
  // hashing the raw spelling would make a valid approval unusable (or, worse,
  // make identity checks disagree between create and consume).
  const canonical = normalizeWorkspace(workspacePath);
  const normalized = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
  return createHash('sha256').update(normalized).digest('hex');
}

function workspaceIdentity(input: Pick<ApprovalBinding, 'workspacePath' | 'workspaceId'>): {
  workspacePath: string;
  workspaceId: string;
  fingerprint: string;
} {
  const workspacePath = normalizeWorkspace(input.workspacePath);
  const fingerprint = workspaceFingerprint(workspacePath);
  const workspaceId = input.workspaceId?.trim() || `ws_${fingerprint.slice(0, 24)}`;
  return { workspacePath, workspaceId, fingerprint };
}

function approvalRoot(workspacePath: string): string {
  return path.join(workspacePath, 'storage', 'approvals');
}

function approvalPath(root: string, approvalId: string): string {
  if (!/^apr_[a-f0-9-]{16,}$/iu.test(approvalId)) throw new Error('Invalid approval id');
  return path.join(root, `${approvalId}.json`);
}

function readRecord(filePath: string): ApprovalRecord | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (value?.schema !== APPROVAL_SCHEMA || typeof value?.approval_id !== 'string') return undefined;
    return value as ApprovalRecord;
  } catch {
    return undefined;
  }
}

/** Read a record left in either side of an interrupted Windows replacement. */
function readRecoverableRecord(filePath: string): ApprovalRecord | undefined {
  return readRecord(filePath) || readRecord(`${filePath}.before.bak`);
}

function atomicWriteJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const backup = `${filePath}.before.bak`;
  const descriptor = fs.openSync(temp, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  try {
    fs.renameSync(temp, filePath);
    // A previous interrupted replacement may have left an old image behind.
    // Once the new destination is durable that image is no longer needed.
    try { fs.unlinkSync(backup); } catch {}
  } catch (error: any) {
    if (!['EEXIST', 'EPERM'].includes(error?.code)) {
      try { fs.unlinkSync(temp); } catch {}
      throw error;
    }
    let moved = false;
    try {
      try { fs.unlinkSync(backup); } catch (backupError: any) { if (backupError?.code !== 'ENOENT') throw backupError; }
      try {
        const stat = fs.lstatSync(filePath);
        if (stat.isSymbolicLink()) throw new Error('批准文件不能是符号链接');
        fs.renameSync(filePath, backup);
        moved = true;
      } catch (moveError: any) {
        if (moveError?.code !== 'ENOENT') throw moveError;
      }
      try {
        fs.renameSync(temp, filePath);
      } catch (replaceError) {
        if (moved) {
          try { fs.renameSync(backup, filePath); } catch {}
        }
        throw replaceError;
      }
      try { fs.unlinkSync(backup); } catch {}
    } catch (replaceError) {
      try { fs.unlinkSync(temp); } catch {}
      throw replaceError;
    }
  }
}

function wait(milliseconds: number): void {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, milliseconds);
}

function withStoreLock<T>(root: string, callback: () => T): T {
  fs.mkdirSync(root, { recursive: true });
  const lockPath = path.join(root, '.approval.lock');
  const started = Date.now();
  let descriptor: number | undefined;
  const leaseToken = randomUUID();
  while (descriptor === undefined) {
    try {
      descriptor = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, lease_token: leaseToken, created_at: new Date().toISOString() }));
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          let ownerAlive = true;
          try {
            const current = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
            const pid = Number(current?.pid);
            if (!Number.isInteger(pid) || pid <= 0) ownerAlive = false;
            else {
              try { process.kill(pid, 0); } catch { ownerAlive = false; }
            }
          } catch { ownerAlive = false; }
          if (!ownerAlive) {
            fs.unlinkSync(lockPath);
            continue;
          }
        }
      } catch (statError: any) {
        if (statError?.code === 'ENOENT') continue;
      }
      if (Date.now() - started >= LOCK_WAIT_MS) throw new Error('Approval store is busy; retry the operation');
      wait(10);
    }
  }
  try {
    return callback();
  } finally {
    try { fs.closeSync(descriptor); } catch {}
    try {
      const current = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      if (current?.lease_token === leaseToken) fs.unlinkSync(lockPath);
    } catch { /* the lock was already reclaimed or removed */ }
  }
}

function recordsIn(root: string): Array<{ path: string; record: ApprovalRecord }> {
  let names: string[] = [];
  try { names = fs.readdirSync(root); } catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
  const ids = new Set<string>();
  for (const name of names) {
    if (/^apr_[a-f0-9-]+\.json$/iu.test(name)) ids.add(name);
    else if (/^apr_[a-f0-9-]+\.json\.before\.bak$/iu.test(name)) ids.add(name.slice(0, -'.before.bak'.length));
  }
  return Array.from(ids).flatMap(name => {
    const filePath = path.join(root, name);
    const record = readRecoverableRecord(filePath);
    return record ? [{ path: filePath, record }] : [];
  });
}

function expirePending(root: string, now = Date.now()): void {
  for (const item of recordsIn(root)) {
    if (item.record.status !== 'pending' || Date.parse(item.record.expires_at) > now) continue;
    item.record.status = 'expired';
    item.record.expired_at = new Date(now).toISOString();
    atomicWriteJson(item.path, item.record);
  }
}

function validateBinding(record: ApprovalRecord, input: ApprovalBinding, identity: ReturnType<typeof workspaceIdentity>): void {
  if (typeof input.schemaVersion !== 'string' || !input.schemaVersion.trim()) {
    throw new Error('Approval schema version is required');
  }
  const expectedPayloadHash = canonicalHash(input.payload);
  const expectedSelected = Array.from(new Set(input.selectedOpIds || [])).sort();
  const actualSelected = Array.from(new Set(record.selected_op_ids || [])).sort();
  if (record.tool !== input.tool
    || record.workspace_id !== identity.workspaceId
    || record.workspace_fingerprint !== identity.fingerprint
    || record.session_id !== input.sessionId
    || record.payload_hash !== expectedPayloadHash
    || record.schema_version !== input.schemaVersion
    || (record.base_revision || '') !== (input.baseRevision || '')
    || (record.change_set_id || '') !== (input.changeSetId || '')
    || (record.change_set_hash || '') !== (input.changeSetHash || '')
    || (record.interpretation_id || '') !== (input.interpretationId || '')
    || canonicalJson(actualSelected) !== canonicalJson(expectedSelected)
    || canonicalHash(record.resolutions || {}) !== canonicalHash(input.resolutions || {})) {
    throw new Error('批准记录与当前工具、Workspace、session 或变更集不一致，请重新审阅');
  }
}

/** Validate a token without consuming it. The caller may safely perform
 * read-only staging after this check and consume the token at commit time. */
export function validateApproval(token: string, input: ConsumeApprovalInput): ApprovalRecord {
  if (!token?.startsWith('dpa_')) throw new Error('批准令牌无效');
  const identity = workspaceIdentity(input);
  const root = approvalRoot(identity.workspacePath);
  const tokenHash = createHash('sha256').update(token).digest('hex');
  return withStoreLock(root, () => {
    const now = Date.now();
    expirePending(root, now);
    const item = recordsIn(root).find(candidate => candidate.record.token_hash === tokenHash);
    if (!item) throw new Error('批准令牌不存在或不属于当前 Workspace');
    if (item.record.status !== 'pending') throw new Error(`批准记录当前状态为 ${item.record.status}，不能使用`);
    if (Date.parse(item.record.expires_at) <= now) throw new Error('批准记录已过期，请重新审阅');
    validateBinding(item.record, input, identity);
    return item.record;
  });
}

/** Validate an in-memory approval record against its durable copy without
 * changing its status. */
export function validateApprovalRecord(record: ApprovalRecord, input: ConsumeApprovalInput): ApprovalRecord {
  if (!record || record.schema !== APPROVAL_SCHEMA || !record.approval_id) throw new Error('批准记录无效');
  const identity = workspaceIdentity(input);
  const root = approvalRoot(identity.workspacePath);
  return withStoreLock(root, () => {
    const filePath = approvalPath(root, record.approval_id);
    const current = readRecoverableRecord(filePath);
    if (!current || current.token_hash !== record.token_hash) throw new Error('批准记录不存在或已被替换');
    const now = Date.now();
    expirePending(root, now);
    const fresh = readRecoverableRecord(filePath);
    if (!fresh) throw new Error('批准记录不存在或已被替换');
    if (fresh.status !== 'pending') throw new Error(`批准记录当前状态为 ${fresh.status}，不能使用`);
    if (Date.parse(fresh.expires_at) <= now) throw new Error('批准记录已过期，请重新审阅');
    validateBinding(fresh, input, identity);
    return fresh;
  });
}

export function createApproval(input: CreateApprovalInput): CreatedApproval {
  if (!input.tool?.trim()) throw new Error('Approval tool is required');
  if (!input.sessionId?.trim()) throw new Error('Approval session is required');
  if (!input.schemaVersion?.trim()) throw new Error('Approval schema version is required');
  if (input.changeSetHash !== undefined && !/^[a-f0-9]{64}$/iu.test(input.changeSetHash)) throw new Error('Approval change-set hash must be a SHA-256 digest');
  if (input.changeSetId !== undefined && !input.changeSetId.trim()) throw new Error('Approval change-set id cannot be empty');
  if (input.interpretationId !== undefined && !input.interpretationId.trim()) throw new Error('Approval interpretation id cannot be empty');
  if (input.selectedOpIds !== undefined && (!Array.isArray(input.selectedOpIds)
    || input.selectedOpIds.some(opId => typeof opId !== 'string' || !opId.trim()))) {
    throw new Error('Approval selected operation ids must be non-empty strings');
  }
  const identity = workspaceIdentity(input);
  const root = approvalRoot(identity.workspacePath);
  const now = Date.now();
  const ttlMs = Math.max(MIN_TTL_MS, Math.min(MAX_TTL_MS, input.ttlMs ?? DEFAULT_TTL_MS));
  const token = `dpa_${randomBytes(32).toString('base64url')}`;
  const approvalId = `apr_${randomUUID()}`;
  const payload = jsonValue(input.payload);
  const preview = input.preview === undefined ? undefined : jsonValue(input.preview);
  const selectedOpIds = Array.from(new Set(input.selectedOpIds || [])).sort();
  const record: ApprovalRecord = {
    schema: APPROVAL_SCHEMA,
    approval_id: approvalId,
    status: 'pending',
    actor: input.actor || 'user',
    tool: input.tool,
    workspace_id: identity.workspaceId,
    workspace_fingerprint: identity.fingerprint,
    session_id: input.sessionId,
    schema_version: input.schemaVersion,
    ...(input.baseRevision ? { base_revision: input.baseRevision } : {}),
    ...(input.changeSetId ? { change_set_id: input.changeSetId } : {}),
    ...(input.changeSetHash ? { change_set_hash: input.changeSetHash } : {}),
    ...(input.interpretationId ? { interpretation_id: input.interpretationId } : {}),
    selected_op_ids: selectedOpIds,
    resolutions: (jsonValue(input.resolutions || {}) || {}) as Record<string, unknown>,
    payload,
    payload_hash: canonicalHash(input.payload),
    ...(preview === undefined ? {} : { preview, preview_hash: canonicalHash(input.preview) }),
    token_hash: createHash('sha256').update(token).digest('hex'),
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + ttlMs).toISOString(),
  };
  withStoreLock(root, () => {
    expirePending(root, now);
    atomicWriteJson(approvalPath(root, approvalId), record);
  });
  return { token, record };
}

export function consumeApproval(token: string, input: ConsumeApprovalInput): ApprovalRecord {
  if (!token?.startsWith('dpa_')) throw new Error('批准令牌无效');
  const identity = workspaceIdentity(input);
  const root = approvalRoot(identity.workspacePath);
  const tokenHash = createHash('sha256').update(token).digest('hex');
  return withStoreLock(root, () => {
    const now = Date.now();
    expirePending(root, now);
    const item = recordsIn(root).find(candidate => candidate.record.token_hash === tokenHash);
    if (!item) throw new Error('批准令牌不存在或不属于当前 Workspace');
    if (item.record.status !== 'pending') throw new Error(`批准记录当前状态为 ${item.record.status}，不能再次使用`);
    if (Date.parse(item.record.expires_at) <= now) throw new Error('批准记录已过期，请重新审阅');
    validateBinding(item.record, input, identity);
    item.record.status = 'consumed';
    item.record.consumed_at = new Date(now).toISOString();
    item.record.consumed_by = input.actor || 'dealpilot-mutation-kernel';
    atomicWriteJson(item.path, item.record);
    return item.record;
  });
}

/** Consume a previously loaded approval record with the same atomic checks as
 * token consumption. This keeps internal callers from bypassing one-shot
 * semantics by passing a stale in-memory record back to the mutation kernel. */
export function consumeApprovalRecord(record: ApprovalRecord, input: ConsumeApprovalInput): ApprovalRecord {
  if (!record || record.schema !== APPROVAL_SCHEMA || !record.approval_id) throw new Error('批准记录无效');
  const identity = workspaceIdentity(input);
  const root = approvalRoot(identity.workspacePath);
  return withStoreLock(root, () => {
    const filePath = approvalPath(root, record.approval_id);
    const current = readRecoverableRecord(filePath);
    if (!current || current.token_hash !== record.token_hash) throw new Error('批准记录不存在或已被替换');
    const now = Date.now();
    expirePending(root, now);
    const fresh = readRecoverableRecord(filePath);
    if (!fresh) throw new Error('批准记录不存在或已被替换');
    if (fresh.status !== 'pending') throw new Error(`批准记录当前状态为 ${fresh.status}，不能再次使用`);
    if (Date.parse(fresh.expires_at) <= now) throw new Error('批准记录已过期，请重新审阅');
    validateBinding(fresh, input, identity);
    fresh.status = 'consumed';
    fresh.consumed_at = new Date(now).toISOString();
    fresh.consumed_by = input.actor || 'dealpilot-mutation-kernel';
    atomicWriteJson(filePath, fresh);
    return fresh;
  });
}

export function readApproval(workspacePath: string, approvalId: string): ApprovalRecord | undefined {
  const identity = workspaceIdentity({ workspacePath });
  return readRecoverableRecord(approvalPath(approvalRoot(identity.workspacePath), approvalId));
}

export function listApprovals(workspacePath: string, status?: ApprovalStatus): ApprovalRecord[] {
  const identity = workspaceIdentity({ workspacePath });
  const root = approvalRoot(identity.workspacePath);
  return withStoreLock(root, () => {
    expirePending(root);
    return recordsIn(root).map(item => item.record)
      .filter(record => !status || record.status === status)
      .sort((left, right) => right.created_at.localeCompare(left.created_at));
  });
}

export function revokeApproval(
  workspacePath: string,
  approvalId: string,
  actor = 'user',
  reason = 'revoked',
): ApprovalRecord {
  const identity = workspaceIdentity({ workspacePath });
  const root = approvalRoot(identity.workspacePath);
  return withStoreLock(root, () => {
    const filePath = approvalPath(root, approvalId);
    const record = readRecoverableRecord(filePath);
    if (!record) throw new Error(`批准记录不存在：${approvalId}`);
    if (record.status !== 'pending') return record;
    record.status = 'revoked';
    record.revoked_at = new Date().toISOString();
    record.revoked_by = actor;
    record.revoke_reason = reason;
    atomicWriteJson(filePath, record);
    return record;
  });
}

/** Preserve audit records while invalidating every outstanding approval. */
export function revokePendingApprovals(workspacePath: string, actor = 'system', reason = 'session cleared'): number {
  const identity = workspaceIdentity({ workspacePath });
  const root = approvalRoot(identity.workspacePath);
  return withStoreLock(root, () => {
    let count = 0;
    for (const item of recordsIn(root)) {
      if (item.record.status !== 'pending') continue;
      item.record.status = 'revoked';
      item.record.revoked_at = new Date().toISOString();
      item.record.revoked_by = actor;
      item.record.revoke_reason = reason;
      atomicWriteJson(item.path, item.record);
      count++;
    }
    return count;
  });
}
