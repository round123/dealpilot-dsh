import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as path from 'node:path';

export interface WorkspaceMetadata {
  id: string;
  name: string;
  created_at: string;
  setup_status: 'ready';
  timezone: string;
}

export interface WorkspaceState {
  path: string;
  metadata: WorkspaceMetadata;
  created: boolean;
}

export type WorkspaceInspection = {
  id: string;
  name: string;
  status: 'new' | 'reusable' | 'invalid';
  hasDealPilotFiles: boolean;
};

const registeredWorkspacePaths = new Map<string, string>();

export function registerWorkspacePath(id: string, workspacePath: string): void {
  if (typeof id === 'string' && id.trim() && typeof workspacePath === 'string' && path.isAbsolute(workspacePath)) {
    registeredWorkspacePaths.set(id, path.resolve(workspacePath));
  }
}

export function clearRegisteredWorkspacePaths(): void {
  registeredWorkspacePaths.clear();
}

function dshHome(): string {
  return process.env.DSH_HOME || path.join(process.env.HOME || process.env.USERPROFILE || '.', '.dsh');
}

export function defaultWorkspacePath(): string {
  return path.join(dshHome(), 'storages', 'dealpilot', 'workspaces', 'default');
}

export function resolveWorkspacePath(config?: Record<string, any>): string {
  const configured = config?.defaultWorkspace;
  if (typeof configured === 'string' && configured.trim()) return path.resolve(configured);
  if (existsSync(path.join(process.cwd(), 'knowledge'))) return process.cwd();
  return defaultWorkspacePath();
}

function workspaceRoot(): string {
  return path.join(dshHome(), 'storages');
}

export async function listWorkspaces(): Promise<WorkspaceInspection[]> {
  const root = workspaceRoot();
  const result: WorkspaceInspection[] = [];
  let groups: any[] = [];
  try { groups = await fs.readdir(root, { withFileTypes: true }); } catch { groups = []; }
  for (const group of groups) {
    if (!group.isDirectory()) continue;
    const groupPath = path.join(root, group.name);
    let entries: any[] = [];
    try { entries = await fs.readdir(groupPath, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (group.name === 'dealpilot' && entry.name === 'workspaces') {
        let nested: any[] = [];
        try { nested = await fs.readdir(path.join(groupPath, entry.name), { withFileTypes: true }); } catch { nested = []; }
        for (const child of nested) if (child.isDirectory()) {
          const id = `${group.name}/${entry.name}/${child.name}`;
          result.push(await inspectWorkspace(id, path.join(groupPath, entry.name, child.name)));
        }
        continue;
      }
      const id = `${group.name}/${entry.name}`;
      const fullPath = path.join(groupPath, entry.name);
      result.push(await inspectWorkspace(id, fullPath));
    }
  }
  const fallback = defaultWorkspacePath();
  if (!result.some(item => path.join(workspaceRoot(), item.id) === fallback)) {
    result.push(await inspectWorkspace('dealpilot/workspaces/default', fallback));
  }
  return result;
}

export async function inspectWorkspace(id: string, explicitPath?: string): Promise<WorkspaceInspection> {
  const fullPath = explicitPath || workspacePathFromId(id);
  if (!fullPath) return { id, name: id, status: 'invalid', hasDealPilotFiles: false };
  let metadata: Partial<WorkspaceMetadata> = {};
  try { metadata = JSON.parse(await fs.readFile(path.join(fullPath, '.dsh', 'workspace.json'), 'utf8')); } catch {}
  const markers = ['knowledge/customers', 'knowledge/deals', 'knowledge/actions', 'sources/inbox'];
  let markerCount = 0;
  for (const marker of markers) { try { await fs.access(path.join(fullPath, marker)); markerCount++; } catch {} }
  const exists = markerCount > 0 || Boolean(metadata.setup_status);
  const rawName = metadata.name || path.basename(fullPath);
  const name = rawName === 'DealPilot Workspace' ? path.basename(fullPath) : rawName;
  return { id, name, status: exists ? 'reusable' : 'new', hasDealPilotFiles: exists };
}

export function workspacePathFromId(id: string): string | undefined {
  const registered = registeredWorkspacePaths.get(id);
  if (registered) return registered;
  if (!/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+){1,2}$/.test(id)) return undefined;
  if (id.split('/').some(part => part === '.' || part === '..')) return undefined;
  return path.resolve(workspaceRoot(), id);
}

const requiredDirs = [
  'knowledge/customers', 'knowledge/contacts', 'knowledge/deals',
  'knowledge/actions', 'knowledge/products', 'knowledge/events',
  'sources/inbox', 'storage/indexes',
];

export async function ensureWorkspace(workspace = defaultWorkspacePath()): Promise<WorkspaceState> {
  const resolved = path.resolve(workspace);
  await Promise.all(requiredDirs.map(dir => fs.mkdir(path.join(resolved, dir), { recursive: true })));
  const metadataPath = path.join(resolved, '.dsh', 'workspace.json');
  let metadata: WorkspaceMetadata;
  let created = false;
  try {
    metadata = JSON.parse(await fs.readFile(metadataPath, 'utf-8')) as WorkspaceMetadata;
  } catch (err: any) {
    if (err.code !== 'ENOENT') throw err;
    metadata = {
      id: path.basename(resolved) || 'default',
      name: path.basename(resolved) || 'Sales workspace',
      created_at: new Date().toISOString(),
      setup_status: 'ready',
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    };
    await fs.mkdir(path.dirname(metadataPath), { recursive: true });
    await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2) + '\n', 'utf-8');
    created = true;
  }
  for (const file of [
    ['knowledge/index.md', '# Sales workspace\n\nThis workspace is managed by DealPilot.\n'],
    ['knowledge/log.md', '# Activity Log\n\n'],
  ] as const) {
    try { await fs.access(path.join(resolved, file[0])); }
    catch { await fs.writeFile(path.join(resolved, file[0]), file[1], 'utf-8'); }
  }
  return { path: resolved, metadata, created };
}
