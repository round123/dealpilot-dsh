// DealPilot DSH — OKF Utility Functions
// Shared read/write helpers for all DealPilot tools.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { randomUUID } from 'node:crypto';
import { resolveWorkspacePath } from './workspace-manager.js';
import { currentWorkspacePath } from './workspace-context.js';

/** Treat native and foreign-platform absolute paths as absolute references. */
export function isAbsolutePathLike(value: string): boolean {
  return path.isAbsolute(value) || /^[A-Za-z]:[\\/]/u.test(value) || /^\\\\/u.test(value) || /^\/\//u.test(value);
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface OkfDocument {
  ref: string;
  meta: Record<string, any>;
  body: string;
  filePath: string;
}

export interface BusinessEvent {
  occurred_at: string;
  event_type: string;
  channel: string;
  generated_by: string;
  customer_ref?: string;
  deal_ref?: string;
  action_ref?: string;
  summary?: string;
  [key: string]: any;
}

export interface IndexEntry {
  ref: string;
  title?: string;
  status?: string;
  updated_at?: string;
  [key: string]: any;
}

// ── YAML Frontmatter ────────────────────────────────────────────────────────

export async function readYamlFrontmatter(filePath: string): Promise<{ meta: Record<string, any>; body: string }> {
  const raw = await fs.readFile(filePath, 'utf-8');
  const normalized = raw.replace(/\r\n/g, '\n');

  if (!normalized.startsWith('---\n')) {
    throw new Error(`Missing YAML frontmatter in ${filePath}`);
  }

  const endIndex = normalized.indexOf('\n---\n', 4);
  if (endIndex === -1) {
    throw new Error(`Unterminated YAML frontmatter in ${filePath}`);
  }

  const yamlStr = normalized.slice(4, endIndex);
  const body = normalized.slice(endIndex + 5);

  const meta = yaml.load(yamlStr);
  if (typeof meta !== 'object' || meta === null) {
    throw new Error(`Invalid YAML frontmatter in ${filePath}: expected object, got ${typeof meta}`);
  }

  return { meta: meta as Record<string, any>, body };
}

export async function writeYamlFrontmatter(
  filePath: string,
  meta: Record<string, any>,
  body: string,
): Promise<void> {
  const yamlStr = yaml.dump(meta, { lineWidth: -1, noRefs: true, sortKeys: false });
  const content = `---\n${yamlStr}---\n\n${body.trimEnd()}\n`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf-8');
}

// ── Business Events ─────────────────────────────────────────────────────────

export async function appendBusinessEvent(workspace: string, event: BusinessEvent): Promise<void> {
  const eventsPath = path.join(workspace, 'knowledge', 'events', 'business-events.jsonl');
  await fs.mkdir(path.dirname(eventsPath), { recursive: true });
  const line = JSON.stringify(event) + '\n';
  const handle = await fs.open(eventsPath, 'a');
  try {
    await handle.writeFile(line, 'utf-8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// ── Storage Index ───────────────────────────────────────────────────────────

function storageRoot(workspace: string): string {
  return path.join(workspace, 'storage', 'indexes');
}

async function readIndexBytes(indexPath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(indexPath, 'utf-8');
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
    // A process can stop after the old index was moved aside on Windows. The
    // verified before-image is preferable to pretending the index is empty.
    try { return await fs.readFile(`${indexPath}.before.bak`, 'utf-8'); }
    catch (backupError: any) { if (backupError?.code !== 'ENOENT') throw backupError; return undefined; }
  }
}

/** Replace a derived index durably while retaining a recoverable before-image. */
async function atomicReplaceIndex(indexPath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(indexPath), { recursive: true });
  const temporary = `${indexPath}.${process.pid}.${randomUUID()}.tmp`;
  const backup = `${indexPath}.before.bak`;
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(content, 'utf-8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temporary, indexPath);
    try { await fs.rm(backup, { force: true }); } catch {}
    return;
  } catch (error: any) {
    if (!['EEXIST', 'EPERM', 'ENOTEMPTY'].includes(error?.code)) {
      try { await fs.rm(temporary, { force: true }); } catch {}
      throw error;
    }
  }
  let moved = false;
  try {
    try { await fs.rm(backup, { force: true }); } catch {}
    try {
      const stat = await fs.lstat(indexPath);
      if (stat.isSymbolicLink()) throw new Error('Storage index 不能是符号链接');
      await fs.rename(indexPath, backup);
      moved = true;
    } catch (moveError: any) {
      if (moveError?.code !== 'ENOENT') throw moveError;
    }
    try {
      await fs.rename(temporary, indexPath);
    } catch (replaceError) {
      if (moved) {
        try { await fs.rename(backup, indexPath); } catch {}
      }
      throw replaceError;
    }
    try { await fs.rm(backup, { force: true }); } catch {}
  } catch (error) {
    try { await fs.rm(temporary, { force: true }); } catch {}
    throw error;
  }
}

export async function readStorageIndex(
  workspace: string,
  entity: string,
): Promise<IndexEntry[] | null> {
  const indexDir = storageRoot(workspace);
  const indexPath = path.join(indexDir, `${entity}.json`);

  try {
    const raw = await readIndexBytes(indexPath);
    if (raw === undefined) return entity === 'snapshot' ? null : [];
    return JSON.parse(raw);
  } catch (err: any) {
    throw err;
  }
}

export async function updateStorageIndex(
  workspace: string,
  entity: string,
  data: IndexEntry,
): Promise<void> {
  if (!data.ref) {
    throw new Error('updateStorageIndex: entry must have a "ref" field');
  }

  const indexDir = storageRoot(workspace);
  const indexPath = path.join(indexDir, `${entity}.json`);

  let entries: IndexEntry[] = [];
  try {
    const raw = await readIndexBytes(indexPath);
    entries = raw === undefined ? [] : JSON.parse(raw);
    if (!Array.isArray(entries)) entries = [];
  } catch (err: any) {
    throw err;
  }

  const idx = entries.findIndex(e => e.ref === data.ref);
  if (idx >= 0) {
    entries[idx] = data;
  } else {
    entries.push(data);
  }

  await atomicReplaceIndex(indexPath, JSON.stringify(entries, null, 2) + '\n');
}

// ── Ref Generation ──────────────────────────────────────────────────────────

export function generateRef(entity: string, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64);
  const date = new Date().toISOString().slice(0, 10);
  return `knowledge/${entity}s/${date}-${slug}.md`;
}

export function normalizeRef(workspace: string, basePath: string, value: string): string {
  if (value.includes('..')) {
    throw new Error(`Path traversal rejected: ${value}`);
  }

  let resolved: string;
  if (value.startsWith('knowledge/')) {
    resolved = path.resolve(workspace, value);
  } else if (!value.includes('/')) {
    resolved = path.resolve(workspace, path.dirname(basePath), value);
  } else {
    resolved = path.resolve(workspace, path.dirname(basePath), value);
  }

  const rel = path.relative(workspace, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path outside workspace rejected: ${value} → ${rel}`);
  }

  return rel.replace(/\\/g, '/');
}

// ── Workspace Detection & Validation ────────────────────────────────────────

/**
 * Resolve the workspace path from the DealPilot session context first. The
 * strict mode is used by registered tools so they never write to an implicit
 * process working directory when a user has not selected a workspace.
 */
export function resolveWorkspace(config?: Record<string, any>): string {
  const bound = currentWorkspacePath();
  if (bound) return bound;
  if (config?.requireDealPilotSession) {
    throw new Error('请先选择 DealPilot Workspace');
  }
  return resolveWorkspacePath(config);
}

export async function validateWorkspace(workspace: string): Promise<boolean> {
  try {
    const stat = await fs.stat(workspace);
    if (!stat.isDirectory()) return false;
  } catch {
    return false;
  }

  const knowledgeDir = path.join(workspace, 'knowledge');
  try {
    const stat = await fs.stat(knowledgeDir);
    if (!stat.isDirectory()) return false;
  } catch {
    return false;
  }

  const requiredDirs = ['customers', 'deals', 'actions', 'events'];
  for (const dir of requiredDirs) {
    const dirPath = path.join(knowledgeDir, dir);
    try {
      const stat = await fs.stat(dirPath);
      if (!stat.isDirectory()) return false;
    } catch {
      // A read-only snapshot must not repair or mutate the workspace.
      return false;
    }
  }

  return true;
}

// ── Concept Dir Reader ──────────────────────────────────────────────────────

export async function readConceptDir(workspace: string, dirPath: string): Promise<OkfDocument[]> {
  const fullPath = path.join(workspace, dirPath);
  const results: OkfDocument[] = [];

  let entries: any[];
  try {
    entries = await fs.readdir(fullPath, { withFileTypes: true });
  } catch (err: any) {
    if (err.code === 'ENOENT') return results;
    throw err;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;

    const filePath = path.join(fullPath, entry.name);
    const ref = `${dirPath.replace(/\\/g, '/')}/${entry.name}`;

    try {
      const { meta, body } = await readYamlFrontmatter(filePath);
      results.push({ ref, meta, body, filePath });
    } catch (err: any) {
      console.warn(`[dealpilot] skipping ${ref}: ${err.message}`);
    }
  }

  return results;
}

// ── Date Helpers ────────────────────────────────────────────────────────────

export function todayString(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
