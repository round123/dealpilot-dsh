import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export type ArtifactStatus = 'staged' | 'parsed' | 'imported' | 'failed' | 'expired';
export interface Artifact {
  id: string;
  workspaceId: string;
  originalName: string;
  mediaType: string;
  size: number;
  sha256: string;
  storageRef: string;
  status: ArtifactStatus;
  createdAt: string;
}

const MAX_BYTES = 20 * 1024 * 1024;
const root = (workspace: string) => path.join(workspace, 'storage', 'indexes');
const indexPath = (workspace: string) => path.join(root(workspace), 'dealpilot-artifacts.json');
const artifactDir = (workspace: string) => path.join(workspace, 'sources', 'inbox', '.artifacts');

async function readAll(workspace: string): Promise<Artifact[]> {
  try {
    const value = JSON.parse(await fs.readFile(indexPath(workspace), 'utf8'));
    return Array.isArray(value) ? value : [];
  } catch (err: any) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}
async function writeAll(workspace: string, items: Artifact[]): Promise<void> {
  await fs.mkdir(root(workspace), { recursive: true });
  await fs.writeFile(indexPath(workspace), JSON.stringify(items, null, 2) + '\n', 'utf8');
}

export function artifactLimits() { return { maxBytes: MAX_BYTES, maxFiles: 10 }; }

export async function listArtifacts(workspace: string): Promise<Artifact[]> {
  return readAll(workspace);
}

export async function getArtifact(workspace: string, id: string): Promise<Artifact | undefined> {
  return (await readAll(workspace)).find(item => item.id === id);
}

export async function stageArtifact(
  workspace: string,
  workspaceId: string,
  originalName: string,
  mediaType: string,
  bytes: Buffer,
): Promise<Artifact> {
  if (bytes.length > MAX_BYTES) throw new Error('文件超过 20 MB 大小限制');
  const safeName = path.basename(originalName || 'upload.bin').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120) || 'upload.bin';
  const id = `art_${randomUUID()}`;
  const storageName = `${id}-${safeName}`;
  await fs.mkdir(artifactDir(workspace), { recursive: true });
  await fs.writeFile(path.join(artifactDir(workspace), storageName), bytes, { flag: 'wx' });
  const artifact: Artifact = {
    id, workspaceId, originalName: safeName, mediaType: mediaType || 'application/octet-stream',
    size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
    storageRef: `sources/inbox/.artifacts/${storageName}`, status: 'staged', createdAt: new Date().toISOString(),
  };
  const items = await readAll(workspace);
  items.push(artifact);
  await writeAll(workspace, items);
  return artifact;
}

export async function readArtifactBytes(workspace: string, artifact: Artifact): Promise<Buffer> {
  const file = path.resolve(workspace, artifact.storageRef);
  const rel = path.relative(path.resolve(workspace, 'sources', 'inbox'), file);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Artifact storage path is invalid');
  const bytes = await fs.readFile(file);
  if (bytes.length > MAX_BYTES) throw new Error('Artifact exceeds size limit');
  if (createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) throw new Error('Artifact integrity check failed');
  return bytes;
}

export async function updateArtifact(workspace: string, id: string, patch: Partial<Artifact>): Promise<Artifact> {
  const items = await readAll(workspace);
  const index = items.findIndex(item => item.id === id);
  if (index < 0) throw new Error('Artifact not found');
  items[index] = { ...items[index], ...patch, id: items[index].id, workspaceId: items[index].workspaceId };
  await writeAll(workspace, items);
  return items[index];
}

export async function deleteArtifact(workspace: string, id: string): Promise<void> {
  const items = await readAll(workspace);
  const item = items.find(value => value.id === id);
  if (!item) return;
  await fs.rm(path.resolve(workspace, item.storageRef), { force: true });
  await writeAll(workspace, items.filter(value => value.id !== id));
}
