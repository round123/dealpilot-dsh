import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('Artifact store stages and verifies immutable files', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'dealpilot-artifact-'));
  try {
    const { ensureWorkspace } = await import('../plugin/lib/workspace-manager.js');
    const store = await import('../plugin/lib/artifact-store.js');
    await ensureWorkspace(workspace);
    const item = await store.stageArtifact(workspace, 'ws', 'leads.csv', 'text/csv', Buffer.from('title\nAcme'));
    assert.equal(item.status, 'staged');
    assert.deepEqual(await store.readArtifactBytes(workspace, item), Buffer.from('title\nAcme'));
    assert.equal((await store.listArtifacts(workspace)).length, 1);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('Feedback draft is redacted and requires confirmation before GitHub URL', async () => {
  const feedback = await import('../plugin/lib/feedback-tool.js');
  const item = feedback.createFeedback({ title: 'Import failure', body: 'Path C:\\Users\\Alice\\workspace and token=secret', kind: 'bug' });
  assert.equal(item.body.includes('C:\\Users'), false);
  assert.equal(item.body.includes('secret'), false);
});
