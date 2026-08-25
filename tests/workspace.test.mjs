import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureWorkspace, inspectWorkspace, workspacePathFromId } from '../plugin/lib/workspace-manager.js';

test('workspace bootstrap is idempotent and preserves metadata', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'dealpilot-workspace-'));
  try {
    const first = await ensureWorkspace(workspace);
    assert.equal(first.created, true);
    assert.equal(first.metadata.setup_status, 'ready');
    const second = await ensureWorkspace(workspace);
    assert.equal(second.created, false);
    assert.equal(second.metadata.created_at, first.metadata.created_at);
    const metadata = JSON.parse(await readFile(path.join(workspace, '.dsh', 'workspace.json'), 'utf8'));
    assert.equal(metadata.id, path.basename(workspace));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('workspace inspection distinguishes new and reusable workspaces', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'dealpilot-inspect-'));
  try {
    assert.equal((await inspectWorkspace('fixture/new', workspace)).status, 'new');
    await ensureWorkspace(workspace);
    assert.equal((await inspectWorkspace('fixture/reusable', workspace)).status, 'reusable');
    assert.equal((await inspectWorkspace('../invalid')).status, 'invalid');
    assert.equal(workspacePathFromId('../invalid'), undefined);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
