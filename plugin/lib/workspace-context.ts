import { AsyncLocalStorage } from 'node:async_hooks';

type WorkspaceBinding = { sessionId: string; workspacePath: string };
const storage = new AsyncLocalStorage<WorkspaceBinding>();

export function runWithWorkspace<T>(sessionId: string, workspacePath: string, fn: () => T): T {
  return storage.run({ sessionId, workspacePath }, fn);
}

export function currentWorkspacePath(): string | undefined {
  return storage.getStore()?.workspacePath;
}

export function currentWorkspaceSessionId(): string | undefined {
  return storage.getStore()?.sessionId;
}
