import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('Feedback draft is redacted and requires confirmation before GitHub URL', async () => {
  const feedback = await import('../plugin/lib/feedback-tool.js');
  const item = feedback.createFeedback({ title: 'Import failure', body: 'Path C:\\Users\\Alice\\workspace and token=secret', kind: 'bug' });
  assert.equal(item.body.includes('C:\\Users'), false);
  assert.equal(item.body.includes('secret'), false);
});
