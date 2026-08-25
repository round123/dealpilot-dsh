import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('DealPilot preset metadata and business rules are present', async () => {
  const metadata = await readFile(path.join('plugin', 'agent-preset', 'dealpilot-sales', 'preset.yml'), 'utf8');
  const composition = await readFile(path.join('plugin', 'agent-preset', 'dealpilot-sales', 'agent.cordis.yml'), 'utf8');
  assert.match(metadata, /id:\s*dealpilot-sales/);
  assert.match(metadata, /DealPilot 销售助理/);
  for (const tool of ['dealpilot_snapshot', 'dealpilot_search', 'dealpilot_write', 'dealpilot_action_transition', 'dealpilot_import', 'dealpilot_whatsapp']) {
    assert.match(composition, new RegExp(tool));
  }
  assert.match(composition, /absolute filesystem path/);
  assert.match(composition, /confirmation/i);
});

test('business tools require a bound DealPilot session and use its workspace', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'dealpilot-session-'));
  try {
    const manager = await import('../plugin/lib/workspace-manager.js');
    await manager.ensureWorkspace(workspace);
    const workspaceId = 'test-session-workspace';
    manager.registerWorkspacePath(workspaceId, workspace);
    const sessions = await import('../plugin/lib/dealpilot-session.js');
    const context = await sessions.createDealPilotSession(workspaceId, 'test-dealpilot-session');
    assert.equal(context.agentPreset, 'dealpilot-sales');
    assert.equal('workspacePath' in sessions.publicDealPilotSession(context), false);

    const { apply } = await import('../plugin/lib/index.js');
    const registered = [];
    apply({ tools: { register: (tool) => registered.push(tool) } });
    const snapshot = registered.find((tool) => tool.name === 'dealpilot_snapshot');
    const write = registered.find((tool) => tool.name === 'dealpilot_write');
    await assert.rejects(() => snapshot.execute({}, { agent: { id: 'unbound-session' } }), /请先选择 DealPilot Workspace/);
    const value = await snapshot.execute({}, { agent: { id: context.sessionId } });
    assert.equal(value.workspace_name, path.basename(workspace));
    const created = await write.execute({
      operation: 'create',
      entity: 'customer',
      fields: { title: '真实业务测试客户', market: 'DE', priority: 'high' },
    }, { agent: { id: context.sessionId } });
    assert.equal(created.ok, true);
    const afterWrite = await snapshot.execute({}, { agent: { id: context.sessionId } });
    assert.equal(afterWrite.summary.customers, 1);
    assert.equal(afterWrite.customers[0].title, '真实业务测试客户');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
