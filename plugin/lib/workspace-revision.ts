import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

/**
 * Directories whose bytes constitute the mutable DealPilot business authority.
 * Evidence and proposal artifacts are immutable inputs and are bound by their
 * own digests, so they deliberately do not participate in this revision.
 */
export const AUTHORITATIVE_DIRECTORIES = [
  'knowledge/customers',
  'knowledge/contacts',
  'knowledge/deals',
  'knowledge/actions',
  'knowledge/relationships',
  'knowledge/notes',
  'knowledge/products',
  'knowledge/events',
] as const;

async function collectFiles(root: string, directory: string, output: string[]): Promise<void> {
  const absolute = path.join(root, directory);
  let entries: any[];
  try {
    entries = await fs.readdir(absolute, { withFileTypes: true });
  } catch (error: any) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    const relative = path.posix.join(directory.replaceAll('\\', '/'), entry.name);
    const candidate = path.join(root, relative);
    if (entry.isDirectory()) {
      await collectFiles(root, relative, output);
    } else if (entry.isFile()) {
      output.push(relative);
    } else if (entry.isSymbolicLink()) {
      throw new Error(`权威目录不允许符号链接：${relative}`);
    }
  }
}

/** Compute a deterministic revision over authoritative paths and exact bytes. */
export async function computeWorkspaceRevision(workspace: string): Promise<string> {
  const root = path.resolve(workspace);
  const files: string[] = [];
  for (const directory of AUTHORITATIVE_DIRECTORIES) await collectFiles(root, directory, files);
  files.sort();
  const hash = createHash('sha256');
  for (const relative of files) {
    hash.update(relative).update('\0');
    hash.update(await fs.readFile(path.join(root, relative))).update('\0');
  }
  return `rev_${hash.digest('hex')}`;
}

