import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('DealPilot preset metadata and agent principles are present', async () => {
  const metadata = await readFile(path.join(root, 'plugin', 'agent-preset', 'dealpilot-sales', 'preset.yml'), 'utf8');
  const composition = await readFile(path.join(root, 'plugin', 'agent-preset', 'dealpilot-sales', 'agent.cordis.yml'), 'utf8');
  assert.match(metadata, /id:\s*dealpilot-sales/);
  assert.match(metadata, /DealPilot 销售助理/);
  assert.match(composition, /dealpilot_ingest/);
  assert.match(composition, /dealpilot_record_interpretation/);
  assert.match(composition, /dealpilot_apply/);
  assert.doesNotMatch(composition, /\bdealpilot_(?:write|action_transition)\b/);
  assert.match(composition, /absolute filesystem path/);
  assert.match(composition, /reasoning, tool-call commentary/);
  assert.match(composition, /evidence-backed/);
  assert.match(composition, /approval/i);
  assert.match(composition, /allowed-once/i);
  assert.match(composition, /LLM/);
  assert.match(composition, /harness/i);
  assert.match(composition, /unknowns/);
  assert.match(composition, /sampleOverCapGlobResults:\s*false/);
});

test('business tools require a bound DealPilot session and use its workspace', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'dealpilot-session-'));
  const otherWorkspace = await mkdtemp(path.join(os.tmpdir(), 'dealpilot-session-other-'));
  try {
    const manager = await import('../plugin/lib/workspace-manager.js');
    await manager.ensureWorkspace(workspace);
    await manager.ensureWorkspace(otherWorkspace);
    const workspaceId = 'test-session-workspace';
    const otherWorkspaceId = 'test-session-workspace-other';
    manager.registerWorkspacePath(workspaceId, workspace);
    manager.registerWorkspacePath(otherWorkspaceId, otherWorkspace);
    const sessions = await import('../plugin/lib/dealpilot-session.js');
    const context = await sessions.createDealPilotSession(workspaceId, 'test-dealpilot-session');
    assert.equal(context.agentPreset, 'dealpilot-sales');
    assert.equal('workspacePath' in sessions.publicDealPilotSession(context), false);
    assert.equal((await sessions.createDealPilotSession(workspaceId, context.sessionId)).workspaceId, workspaceId);
    await assert.rejects(
      () => sessions.createDealPilotSession(otherWorkspaceId, context.sessionId),
      /已绑定另一个 Workspace/,
    );

    const { apply } = await import('../plugin/lib/index.js');
    const registered = [];
    const guards = [];
    apply({ tools: { register: (tool) => registered.push(tool), guard: (guard) => { guards.push(guard); return () => {}; } } });
    const snapshot = registered.find((tool) => tool.name === 'dealpilot_snapshot');
    await assert.rejects(() => snapshot.execute({}, { agent: { id: 'unbound-session' } }), /请先选择 DealPilot Workspace/);
    const value = await snapshot.execute({}, { agent: { id: context.sessionId } });
    assert.equal(value.workspace_name, path.basename(workspace));
    // The former generic write capability is intentionally absent. Business
    // mutations must enter through a typed, evidence-bound change set.
    assert.equal(registered.some((tool) => tool.name === 'dealpilot_write'), false);
    assert.equal(registered.some((tool) => tool.name === 'dealpilot_action_transition'), false);
    assert.equal(registered.some((tool) => tool.name === 'dealpilot_import'), false);
    assert.equal(guards.length, 1);
    for (const name of ['dealpilot_import', 'dealpilot_write', 'dealpilot_action_transition']) {
      assert.match(guards[0]({ name, agent: { id: context.sessionId } }), new RegExp(`cannot call ${name}`));
    }
    const propose = registered.find((tool) => tool.name === 'dealpilot_propose');
    await assert.rejects(
      () => propose.execute({ change_set: { schema: 'dealpilot.change-set/v1' } }, { agent: { id: context.sessionId } }),
      /只接受 .*change_set/,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(otherWorkspace, { recursive: true, force: true });
  }
});
