import { randomUUID } from 'node:crypto';
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

const sessions = new Map<string, DealPilotSessionContext>();

export async function createDealPilotSession(
  workspaceId: string,
  sessionId: string = randomUUID(),
): Promise<DealPilotSessionContext> {
  const workspacePath = workspacePathFromId(workspaceId);
  if (!workspacePath) throw new Error('Invalid workspaceId');
  const inspection = await inspectWorkspace(workspaceId, workspacePath);
  if (inspection.status === 'invalid') throw new Error('Invalid workspaceId');
  if (inspection.status === 'new') throw new Error('请先初始化 DealPilot Workspace');

  const context: DealPilotSessionContext = {
    sessionId,
    workspaceId,
    workspacePath,
    workspaceName: inspection.name,
    agentPreset: DEALPILOT_AGENT_PRESET,
    createdAt: new Date().toISOString(),
  };
  sessions.set(sessionId, context);
  return context;
}

export function getDealPilotSession(sessionId: unknown): DealPilotSessionContext | undefined {
  return typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;
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
}
