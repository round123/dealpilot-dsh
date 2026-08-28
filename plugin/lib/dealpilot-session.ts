import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { inspectWorkspace, workspacePathFromId } from './workspace-manager.js';

export const DEALPILOT_AGENT_PRESET = 'dealpilot-sales' as const;

export type DealPilotSessionContext = {
  sessionId: string;
  workspaceId: string;
  workspaceName: string;
  workspacePath: string;
  agentPreset: typeof DEALPILOT_AGENT_PRESET;
  createdAt: string;
};

type PersistedSession = Omit<DealPilotSessionContext, 'workspacePath'>;

const sessions = new Map<string, DealPilotSessionContext>();

function sessionStorePath(): string {
  const dshHome = process.env.DSH_HOME || path.join(
    process.env.HOME || process.env.USERPROFILE || '.', '.dsh',
  );
  return path.join(dshHome, 'storages', 'dealpilot', 'sessions.json');
}

function loadPersistedSessions(): Map<string, PersistedSession> {
  try {
    const parsed = JSON.parse(fs.readFileSync(sessionStorePath(), 'utf8'));
    if (!Array.isArray(parsed)) return new Map();
    return new Map(parsed.filter((item: any) => item?.sessionId && item?.workspaceId)
      .map((item: PersistedSession) => [item.sessionId, item]));
  } catch { return new Map(); }
}

const persistedSessions = loadPersistedSessions();

function persistSessions(): void {
  const entries: PersistedSession[] = Array.from(sessions.values()).map(({ workspacePath: _path, ...rest }) => rest);
  const known = new Map(persistedSessions);
  for (const entry of entries) known.set(entry.sessionId, entry);
  try {
    const target = sessionStorePath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(Array.from(known.values()).slice(-500), null, 2) + '\n', 'utf8');
    fs.renameSync(temp, target);
  } catch (err) {
    console.warn('[dealpilot] session persistence skipped:', err);
  }
}

export async function createDealPilotSession(
  workspaceId: string,
  sessionId: string = randomUUID(),
): Promise<DealPilotSessionContext> {
  if (typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('Invalid DealPilot session id');
  const workspacePath = workspacePathFromId(workspaceId);
  if (!workspacePath) throw new Error('Invalid workspaceId');
  const inspection = await inspectWorkspace(workspaceId, workspacePath);
  if (inspection.status === 'invalid' || inspection.status === 'archived') throw new Error('Workspace 已归档，不能创建 DealPilot 对话');
  if (inspection.status === 'new') throw new Error('请先初始化 DealPilot Workspace');

  // A native DSH session id is also used as the DealPilot binding id. Treat a
  // repeated request as idempotent only for the same Workspace; never let a
  // caller overwrite an existing binding by presenting its id with a new
  // Workspace.
  const existing = getDealPilotSession(sessionId);
  if (existing) {
    if (existing.workspaceId !== workspaceId) throw new Error('该 session 已绑定另一个 Workspace');
    return existing;
  }

  const context: DealPilotSessionContext = {
    sessionId,
    workspaceId,
    workspacePath,
    workspaceName: inspection.name,
    agentPreset: DEALPILOT_AGENT_PRESET,
    createdAt: new Date().toISOString(),
  };
  sessions.set(sessionId, context);
  persistedSessions.set(sessionId, (({ workspacePath: _path, ...rest }) => rest)(context));
  persistSessions();
  return context;
}

export function getDealPilotSession(sessionId: unknown): DealPilotSessionContext | undefined {
  if (typeof sessionId !== 'string' || !sessionId) return undefined;
  const live = sessions.get(sessionId);
  if (live) return live;
  const saved = persistedSessions.get(sessionId);
  if (!saved) return undefined;
  const workspacePath = workspacePathFromId(saved.workspaceId);
  if (!workspacePath) return undefined;
  const restored: DealPilotSessionContext = { ...saved, workspacePath };
  sessions.set(sessionId, restored);
  return restored;
}

export function listDealPilotSessions(workspaceId?: string): Array<DealPilotSessionContext> {
  const values = Array.from(new Set([...persistedSessions.keys(), ...sessions.keys()]))
    .map((id) => getDealPilotSession(id))
    .filter((value): value is DealPilotSessionContext => Boolean(value));
  return values
    .filter((value) => !workspaceId || value.workspaceId === workspaceId)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export async function switchDealPilotWorkspace(
  previousSessionId: string,
  workspaceId: string,
  sessionId: string = randomUUID(),
): Promise<DealPilotSessionContext> {
  // Keeping the old context in the registry intentionally preserves its history
  // while ensuring the new conversation cannot inherit the old workspace.
  if (!getDealPilotSession(previousSessionId)) throw new Error('DealPilot session not found');
  return createDealPilotSession(workspaceId, sessionId);
}

export function publicDealPilotSession(context: DealPilotSessionContext) {
  const { workspacePath: _workspacePath, ...publicContext } = context;
  return publicContext;
}

export function clearDealPilotSessions() {
  sessions.clear();
  persistedSessions.clear();
  try { fs.rmSync(sessionStorePath(), { force: true }); } catch {}
}

export function removeDealPilotSession(sessionId: string): void {
  sessions.delete(sessionId);
  persistedSessions.delete(sessionId);
  persistSessions();
}
