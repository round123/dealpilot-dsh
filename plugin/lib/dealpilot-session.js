import { randomUUID } from 'node:crypto';
import { inspectWorkspace, workspacePathFromId } from './workspace-manager.js';
export const DEALPILOT_AGENT_PRESET = 'dealpilot-sales';
const sessions = new Map();
export async function createDealPilotSession(workspaceId, sessionId = randomUUID()) {
    const workspacePath = workspacePathFromId(workspaceId);
    if (!workspacePath)
        throw new Error('Invalid workspaceId');
    const inspection = await inspectWorkspace(workspaceId, workspacePath);
    if (inspection.status === 'invalid')
        throw new Error('Invalid workspaceId');
    if (inspection.status === 'new')
        throw new Error('请先初始化 DealPilot Workspace');
    const context = {
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
export function getDealPilotSession(sessionId) {
    return typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;
}
export async function switchDealPilotWorkspace(previousSessionId, workspaceId, sessionId = randomUUID()) {
    // Keeping the old context in the registry intentionally preserves its history
    // while ensuring the new conversation cannot inherit the old workspace.
    if (!getDealPilotSession(previousSessionId))
        throw new Error('DealPilot session not found');
    return createDealPilotSession(workspaceId, sessionId);
}
export function publicDealPilotSession(context) {
    const { workspacePath: _workspacePath, ...publicContext } = context;
    return publicContext;
}
export function clearDealPilotSessions() {
    sessions.clear();
}
