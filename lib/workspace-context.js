import { AsyncLocalStorage } from 'node:async_hooks';
const storage = new AsyncLocalStorage();
export function runWithWorkspace(sessionId, workspacePath, fn) {
    return storage.run({ sessionId, workspacePath }, fn);
}
export function currentWorkspacePath() {
    return storage.getStore()?.workspacePath;
}
export function currentWorkspaceSessionId() {
    return storage.getStore()?.sessionId;
}
