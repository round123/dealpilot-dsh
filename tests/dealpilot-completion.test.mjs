import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function runNode(code, env) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ['--input-type=module', '-e', code], { cwd: root, env }, (error, stdout, stderr) => {
      if (error) return reject(new Error(`${error.message}\n${stderr}`));
      resolve(stdout.trim());
    });
  });
}

test('DealPilot session survives a DSH process restart without exposing a path', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'dealpilot-persist-workspace-'));
  const dshHome = await mkdtemp(path.join(os.tmpdir(), 'dealpilot-persist-dsh-'));
  const workspaceId = 'persisted-workspace';
  const sessionId = 'persisted-dealpilot-session';
  const env = { ...process.env, DSH_HOME: dshHome };
  const manager = pathToFileURL(path.join(root, 'plugin', 'lib', 'workspace-manager.js')).href;
  const sessions = pathToFileURL(path.join(root, 'plugin', 'lib', 'dealpilot-session.js')).href;
  try {
    const create = await runNode(`
      const manager = await import(${JSON.stringify(manager)});
      await manager.ensureWorkspace(${JSON.stringify(workspace)});
      manager.registerWorkspacePath(${JSON.stringify(workspaceId)}, ${JSON.stringify(workspace)});
      const sessions = await import(${JSON.stringify(sessions)});
      const value = await sessions.createDealPilotSession(${JSON.stringify(workspaceId)}, ${JSON.stringify(sessionId)});
      console.log(JSON.stringify(sessions.publicDealPilotSession(value)));
    `, env);
    assert.equal(JSON.parse(create).sessionId, sessionId);

    const restored = await runNode(`
      const manager = await import(${JSON.stringify(manager)});
      manager.registerWorkspacePath(${JSON.stringify(workspaceId)}, ${JSON.stringify(workspace)});
      const sessions = await import(${JSON.stringify(sessions)});
      console.log(JSON.stringify(sessions.publicDealPilotSession(sessions.getDealPilotSession(${JSON.stringify(sessionId)}))));
    `, env);
    const value = JSON.parse(restored);
    assert.equal(value.workspaceId, workspaceId);
    assert.equal(value.agentPreset, 'dealpilot-sales');
    assert.equal('workspacePath' in value, false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(dshHome, { recursive: true, force: true });
  }
});

test('DealPilot session selection is persisted separately from the default DSH page', async () => {
  const client = await readFile(path.join(root, 'plugin', 'client', 'client.ts'), 'utf8');
  assert.match(client, /installDealPilotSessionSelectionIsolation\(\)/);
  assert.match(client, /const scopedKey = `\$\{key\}\.dealpilot`/);
  assert.match(client, /subsequent selection writes are redirected/);
  assert.doesNotMatch(client, /localStorage\.setItem\(['"]dsh\.sessions\.current['"]/);
});

test('Action transitions project into persistent Goal and Workflow runtime', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'dealpilot-goal-runtime-'));
  try {
    const { ensureWorkspace } = await import('../plugin/lib/workspace-manager.js');
    const { writeYamlFrontmatter } = await import('../plugin/lib/okf-utils.js');
    const { reconcileGoalRuntime, readGoalRuntime } = await import('../plugin/lib/goal-runtime.js');
    await ensureWorkspace(workspace);
    const actionRef = 'knowledge/actions/follow-up.md';
    await writeYamlFrontmatter(path.join(workspace, actionRef), {
      title: 'Follow up on quotation', status: 'active', deal: 'knowledge/deals/acme.md', priority: 'P1',
      generated: { at: new Date().toISOString() },
    }, '# Reason\n\nConfirm quotation status');
    const { readConceptDir } = await import('../plugin/lib/okf-utils.js');
    const first = await reconcileGoalRuntime(workspace, await readConceptDir(workspace, 'knowledge/actions'));
    assert.equal(first.goals[0].status, 'active');
    assert.equal(first.workflows[0].status, 'active');
    const runtimePath = path.join(workspace, 'storage', 'indexes', 'dealpilot-runtime.json');
    assert.equal(JSON.parse(await readFile(runtimePath, 'utf8')).goals.length, 1);

    const { transitionAction } = await import('../plugin/lib/action-tool.js');
    await transitionAction(workspace, actionRef, 'complete', { evidence: 'Customer approved the quote' }, new Date().toISOString());
    const second = await reconcileGoalRuntime(workspace, await readConceptDir(workspace, 'knowledge/actions'));
    assert.equal(second.goals[0].status, 'completed');
    assert.equal(second.workflows[0].status, 'idle');
    const persisted = await readGoalRuntime(workspace);
    assert.equal(persisted.goals[0].status, second.goals[0].status);
    assert.equal(persisted.workflows[0].status, second.workflows[0].status);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('Snapshot handles 20 active deals quickly and rejects traversal refs', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'dealpilot-performance-'));
  try {
    const { ensureWorkspace } = await import('../plugin/lib/workspace-manager.js');
    const { writeYamlFrontmatter, normalizeRef } = await import('../plugin/lib/okf-utils.js');
    const { buildSnapshot } = await import('../plugin/lib/snapshot.js');
    await ensureWorkspace(workspace);
    for (let i = 0; i < 20; i++) {
      const customerRef = `knowledge/customers/customer-${i}.md`;
      const dealRef = `knowledge/deals/deal-${i}.md`;
      await writeYamlFrontmatter(path.join(workspace, customerRef), {
        title: `Customer ${i}`, status: 'active', source_category: 'import', relationship_stage: 'qualified', market: 'DE', icp_fit: 'high', priority: 'P2',
      }, '# Profile\n\nFixture customer');
      await writeYamlFrontmatter(path.join(workspace, dealRef), {
        title: `Deal ${i}`, customer: customerRef, status: 'active', funnel_stage: 'opportunity', priority: 'P2', risk_level: 'low',
      }, '# Goal\n\nFixture deal');
    }
    const started = performance.now();
    const snapshot = await buildSnapshot(workspace);
    const elapsed = performance.now() - started;
    assert.equal(snapshot.summary.active_deals, 20);
    assert.ok(elapsed < 1000, `snapshot took ${elapsed.toFixed(1)}ms`);
    assert.throws(() => normalizeRef(workspace, 'knowledge/deals/index.md', '../outside.md'), /Path traversal rejected/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('Storage indexes remain isolated per Workspace', async () => {
  const first = await mkdtemp(path.join(os.tmpdir(), 'dealpilot-index-a-'));
  const second = await mkdtemp(path.join(os.tmpdir(), 'dealpilot-index-b-'));
  try {
    const { ensureWorkspace } = await import('../plugin/lib/workspace-manager.js');
    const { updateStorageIndex, readStorageIndex } = await import('../plugin/lib/okf-utils.js');
    await ensureWorkspace(first);
    await ensureWorkspace(second);
    await updateStorageIndex(first, 'customer', { ref: 'knowledge/customers/only-a.md', title: 'Only A' });
    assert.equal((await readStorageIndex(first, 'customer')).length, 1);
    assert.deepEqual(await readStorageIndex(second, 'customer'), []);
  } finally {
    await rm(first, { recursive: true, force: true });
    await rm(second, { recursive: true, force: true });
  }
});

test('Today rules and operational views cover weekly review, risk, and stalled deals', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'dealpilot-operations-'));
  try {
    const { ensureWorkspace } = await import('../plugin/lib/workspace-manager.js');
    const { writeYamlFrontmatter } = await import('../plugin/lib/okf-utils.js');
    const { buildSnapshot } = await import('../plugin/lib/snapshot.js');
    await ensureWorkspace(workspace);
    const customer = 'knowledge/customers/acme.md';
    const urgentDeal = 'knowledge/deals/acme-urgent.md';
    const stalledDeal = 'knowledge/deals/acme-stalled.md';
    const normalDeal = 'knowledge/deals/acme-normal.md';
    await writeYamlFrontmatter(path.join(workspace, customer), { title: 'Acme', status: 'active', relationship_stage: 'qualified' }, '# Profile');
    await writeYamlFrontmatter(path.join(workspace, urgentDeal), { title: 'Urgent deal', customer, status: 'active', funnel_stage: 'proposal', priority: 'P1', risk_level: 'low', generated: { at: new Date().toISOString() } }, '# Goal');
    await writeYamlFrontmatter(path.join(workspace, stalledDeal), { title: 'Stalled deal', customer, status: 'active', funnel_stage: 'negotiation', priority: 'P2', risk_level: 'high', generated: { at: '2026-07-01T00:00:00.000Z' } }, '# Goal');
    await writeYamlFrontmatter(path.join(workspace, normalDeal), { title: 'Normal deal', customer, status: 'active', funnel_stage: 'qualified', priority: 'P3', risk_level: 'low', generated: { at: new Date().toISOString() } }, '# Goal');
    await writeYamlFrontmatter(path.join(workspace, 'knowledge/actions/p1.md'), { title: 'P1 follow-up', deal: urgentDeal, status: 'active', priority: 'P1', due_at: '2099-01-01' }, '# Reason');
    await writeYamlFrontmatter(path.join(workspace, 'knowledge/actions/normal.md'), { title: 'Undated normal', deal: normalDeal, status: 'active', priority: 'P3' }, '# Reason');
    const snapshot = await buildSnapshot(workspace, new Date('2026-08-26T12:00:00.000Z'));
    assert.ok(snapshot.today.some((item) => item.title === 'P1 follow-up' && item.bucket === 'risk'));
    assert.equal(snapshot.today.some((item) => item.title === 'Undated normal'), false);
    assert.ok(snapshot.operations.risk_deals.some((item) => item.title === 'Stalled deal'));
    assert.ok(snapshot.operations.stalled_deals.some((item) => item.title === 'Stalled deal'));
    assert.ok(snapshot.operations.deal_lifecycle.stages.some((item) => item.stage === 'negotiation' && item.count === 1));
    assert.ok(snapshot.operations.action_lifecycle.statuses.some((item) => item.status === 'active' && item.count === 2));
    assert.ok(snapshot.operations.weekly_review.period_start);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('Import preview is read-only and reports duplicate records', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'dealpilot-import-preview-'));
  try {
    const { ensureWorkspace } = await import('../plugin/lib/workspace-manager.js');
    const { writeYamlFrontmatter } = await import('../plugin/lib/okf-utils.js');
    const { previewImport } = await import('../plugin/lib/import-tool.js');
    await ensureWorkspace(workspace);
    await writeYamlFrontmatter(path.join(workspace, 'knowledge/customers/acme.md'), { title: 'Acme Corp', status: 'active' }, '# Profile');
    const preview = await previewImport(workspace, 'title,market\nAcme Corp,DE\nNew GmbH,DE', 'csv');
    assert.equal(preview.total, 2);
    assert.deepEqual(preview.duplicates.map((item) => item.title), ['Acme Corp']);
    assert.deepEqual(await readdir(path.join(workspace, 'knowledge/customers')), ['acme.md']);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('Snapshot validation is read-only for a partial workspace', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'dealpilot-readonly-snapshot-'));
  try {
    const { mkdir, readdir } = await import('node:fs/promises');
    await mkdir(path.join(workspace, 'knowledge'), { recursive: true });
    const before = await readdir(path.join(workspace, 'knowledge'));
    const { validateWorkspace } = await import('../plugin/lib/okf-utils.js');
    assert.equal(await validateWorkspace(workspace), false);
    assert.deepEqual(await readdir(path.join(workspace, 'knowledge')), before);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('Import resolves deal customer names and never overwrites same-title records', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'dealpilot-import-relations-'));
  try {
    const { ensureWorkspace } = await import('../plugin/lib/workspace-manager.js');
    const { writeYamlFrontmatter } = await import('../plugin/lib/okf-utils.js');
    const { importEntities } = await import('../plugin/lib/import-tool.js');
    await ensureWorkspace(workspace);
    await writeYamlFrontmatter(path.join(workspace, 'knowledge/customers/acme.md'), { title: 'Acme Corp', status: 'active' }, '# Profile');
    const result = await importEntities(workspace, 'title,entity,customer\nAcme Renewal,deal,Acme Corp', 'csv', {
      sourceCategory: 'import', autoDedup: false, now: new Date().toISOString(),
    });
    assert.equal(result.created, 1);
    const deal = await readFile(path.join(workspace, result.entities[0].ref), 'utf8');
    assert.match(deal, /customer: knowledge\/customers\/acme\.md/);
    const second = await importEntities(workspace, 'title,entity,customer\nAcme Renewal,deal,Acme Corp', 'csv', {
      sourceCategory: 'import', autoDedup: false, now: new Date().toISOString(),
    });
    assert.equal(second.created, 0);
    assert.ok(second.warnings.some((warning) => warning.includes('已存在同名交易')));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('Mutating tools require an explicit confirmation token before changing OKF', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'dealpilot-confirmation-'));
  const workspaceId = `confirmation-${Date.now()}`;
  const sessionId = `confirmation-session-${Date.now()}`;
  try {
    const manager = await import('../plugin/lib/workspace-manager.js');
    await manager.ensureWorkspace(workspace);
    manager.registerWorkspacePath(workspaceId, workspace);
    const sessions = await import('../plugin/lib/dealpilot-session.js');
    await sessions.createDealPilotSession(workspaceId, sessionId);
    const { apply } = await import('../plugin/lib/index.js');
    const registered = [];
    apply({ tools: { register: tool => registered.push(tool) } });
    const write = registered.find(tool => tool.name === 'dealpilot_write');
    const action = registered.find(tool => tool.name === 'dealpilot_action_transition');
    const execute = (tool, args) => tool.execute(args, { agent: { id: sessionId } });

    const customerArgs = { operation: 'create', entity: 'customer', fields: { title: 'Confirmed Customer', market: 'DE' } };
    const preview = await execute(write, customerArgs);
    assert.equal(preview.requires_confirmation, true);
    const created = await execute(write, { ...customerArgs, confirmation_token: preview.confirmation_token });
    assert.equal(created.ok, true);

    const dealArgs = { operation: 'create', entity: 'deal', fields: { title: 'Confirmed Deal', customer: created.ref, funnel_stage: 'qualified' } };
    const dealPreview = await execute(write, dealArgs);
    const deal = await execute(write, { ...dealArgs, confirmation_token: dealPreview.confirmation_token });
    const actionArgs = { operation: 'create', entity: 'action', fields: { title: 'Confirm next step', deal: deal.ref, status: 'active' } };
    const actionPreview = await execute(write, actionArgs);
    const actionCreated = await execute(write, { ...actionArgs, confirmation_token: actionPreview.confirmation_token });
    const scheduleArgs = { action_ref: actionCreated.ref, transition: 'schedule', due_at: '2026-08-30', reason: 'Customer requested a follow-up date' };
    const schedulePreview = await execute(action, scheduleArgs);
    const scheduled = await execute(action, { ...scheduleArgs, confirmation_token: schedulePreview.confirmation_token });
    assert.equal(scheduled.newStatus, 'planned');
    const activateArgs = { action_ref: actionCreated.ref, transition: 'active' };
    const activatePreview = await execute(action, activateArgs);
    await execute(action, { ...activateArgs, confirmation_token: activatePreview.confirmation_token });
    const transitionArgs = { action_ref: actionCreated.ref, transition: 'complete', evidence: 'Confirmed in test' };
    const transitionPreview = await execute(action, transitionArgs);
    assert.equal(transitionPreview.requires_confirmation, true);
    const transitioned = await execute(action, { ...transitionArgs, confirmation_token: transitionPreview.confirmation_token });
    assert.equal(transitioned.newStatus, 'done');

  } finally {
    const sessions = await import('../plugin/lib/dealpilot-session.js');
    sessions.removeDealPilotSession(sessionId);
    await rm(workspace, { recursive: true, force: true });
  }
});

test('Write tool resolves human relationship names to workspace refs', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'dealpilot-relationship-ref-'));
  const workspaceId = `relationship-${Date.now()}`;
  const sessionId = `relationship-session-${Date.now()}`;
  try {
    const manager = await import('../plugin/lib/workspace-manager.js');
    await manager.ensureWorkspace(workspace);
    manager.registerWorkspacePath(workspaceId, workspace);
    const sessions = await import('../plugin/lib/dealpilot-session.js');
    await sessions.createDealPilotSession(workspaceId, sessionId);
    const { apply } = await import('../plugin/lib/index.js');
    const registered = [];
    apply({ tools: { register: tool => registered.push(tool) } });
    const write = registered.find(tool => tool.name === 'dealpilot_write');
    const createCustomer = { operation: 'create', entity: 'customer', fields: { title: 'Name Resolved Customer' } };
    const customerPreview = await write.execute(createCustomer, { agent: { id: sessionId } });
    const customer = await write.execute({ ...createCustomer, confirmation_token: customerPreview.confirmation_token }, { agent: { id: sessionId } });
    const createDeal = { operation: 'create', entity: 'deal', fields: { title: 'Name Resolved Deal', customer: 'Name Resolved Customer' } };
    const dealPreview = await write.execute(createDeal, { agent: { id: sessionId } });
    assert.equal(dealPreview.preview.fields.customer, customer.ref);
    const deal = await write.execute({ ...createDeal, confirmation_token: dealPreview.confirmation_token }, { agent: { id: sessionId } });
    const createAction = { operation: 'create', entity: 'action', fields: { title: 'Name Resolved Action', deal: 'Name Resolved Deal', status: 'active' } };
    const actionPreview = await write.execute(createAction, { agent: { id: sessionId } });
    assert.equal(actionPreview.preview.fields.deal, deal.ref);
  } finally {
    const sessions = await import('../plugin/lib/dealpilot-session.js');
    sessions.removeDealPilotSession(sessionId);
    await rm(workspace, { recursive: true, force: true });
  }
});

test('Write tool supports confirmed customer update, archive, and merge without losing source history', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'dealpilot-write-lifecycle-'));
  const workspaceId = `write-lifecycle-${Date.now()}`;
  const sessionId = `write-lifecycle-session-${Date.now()}`;
  try {
    const manager = await import('../plugin/lib/workspace-manager.js');
    await manager.ensureWorkspace(workspace);
    manager.registerWorkspacePath(workspaceId, workspace);
    const { writeYamlFrontmatter, readYamlFrontmatter } = await import('../plugin/lib/okf-utils.js');
    const targetRef = 'knowledge/customers/acme.md';
    const sourceRef = 'knowledge/customers/acme-duplicate.md';
    const archiveRef = 'knowledge/customers/to-archive.md';
    const dealRef = 'knowledge/deals/acme-deal.md';
    await writeYamlFrontmatter(path.join(workspace, targetRef), {
      title: 'Acme Corp', status: 'active', market: 'DE', priority: 'P2',
    }, '# Profile\n\nPrimary account');
    await writeYamlFrontmatter(path.join(workspace, sourceRef), {
      title: 'Acme GmbH', status: 'active', market: 'AT', priority: 'P3',
    }, '# Profile\n\nDuplicate account notes');
    await writeYamlFrontmatter(path.join(workspace, archiveRef), {
      title: 'Old Account', status: 'active',
    }, '# Profile\n\nLegacy');
    await writeYamlFrontmatter(path.join(workspace, dealRef), {
      title: 'Acme Renewal', customer: sourceRef, status: 'active', funnel_stage: 'proposal',
    }, '# Goal\n\nRenew account');
    const sessions = await import('../plugin/lib/dealpilot-session.js');
    await sessions.createDealPilotSession(workspaceId, sessionId);
    const { apply } = await import('../plugin/lib/index.js');
    const registered = [];
    apply({ tools: { register: tool => registered.push(tool) } });
    const write = registered.find(tool => tool.name === 'dealpilot_write');
    const execute = (args) => write.execute(args, { agent: { id: sessionId } });

    const updateArgs = { operation: 'update', entity: 'customer', ref: targetRef, fields: { market: 'DE', priority: 'P1', profile: ['Verified by sales'] } };
    const updatePreview = await execute(updateArgs);
    assert.equal(updatePreview.requires_confirmation, true);
    assert.ok(updatePreview.preview.changes.some((change) => change.field === 'priority' && change.before === 'P2' && change.after === 'P1'));
    const updated = await execute({ ...updateArgs, confirmation_token: updatePreview.confirmation_token });
    assert.equal(updated.ok, true);
    assert.match((await readFile(path.join(workspace, targetRef), 'utf8')), /priority: P1/);

    await writeYamlFrontmatter(path.join(workspace, dealRef), {
      title: 'Acme Renewal', customer: sourceRef, status: 'active', funnel_stage: 'proposal', amount: 100,
    }, '# Goal\n\nRenew account');
    const sensitiveUpdate = { operation: 'update', entity: 'deal', ref: dealRef, fields: { amount: 200 } };
    const sensitivePreview = await execute(sensitiveUpdate);
    assert.equal(sensitivePreview.preview.changes.find((change) => change.field === 'amount').conflict, true);
    await execute({ ...sensitiveUpdate, confirmation_token: sensitivePreview.confirmation_token });

    const archiveArgs = { operation: 'archive', entity: 'customer', ref: archiveRef, fields: {} };
    const archivePreview = await execute(archiveArgs);
    assert.equal(archivePreview.requires_confirmation, true);
    const archived = await execute({ ...archiveArgs, confirmation_token: archivePreview.confirmation_token });
    assert.equal(archived.newStatus, 'archived');

    const mergeArgs = { operation: 'merge', entity: 'customer', ref: targetRef, source_ref: sourceRef, fields: {} };
    const mergePreview = await execute(mergeArgs);
    assert.equal(mergePreview.requires_confirmation, true);
    assert.ok(mergePreview.preview.conflicts.some((item) => item.field === 'priority'));
    const merged = await execute({ ...mergeArgs, confirmation_token: mergePreview.confirmation_token });
    assert.equal(merged.ok, true);
    assert.equal(merged.mergedRef, sourceRef);
    const target = await readYamlFrontmatter(path.join(workspace, targetRef));
    const source = await readYamlFrontmatter(path.join(workspace, sourceRef));
    assert.match(target.body, /Duplicate account notes/);
    assert.equal(source.meta.status, 'archived');
    assert.equal(source.meta.merged_into, targetRef);
    assert.ok(target.meta.merged_from.includes(sourceRef));
    assert.match(await readFile(path.join(workspace, dealRef), 'utf8'), /customer: knowledge\/customers\/acme\.md/);
  } finally {
    const sessions = await import('../plugin/lib/dealpilot-session.js');
    sessions.removeDealPilotSession(sessionId);
    await rm(workspace, { recursive: true, force: true });
  }
});

test('Search supports fuzzy queries and field filters when indexes are absent', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'dealpilot-search-filters-'));
  try {
    const { ensureWorkspace } = await import('../plugin/lib/workspace-manager.js');
    const { writeYamlFrontmatter } = await import('../plugin/lib/okf-utils.js');
    const { searchEntities } = await import('../plugin/lib/search-tool.js');
    await ensureWorkspace(workspace);
    await writeYamlFrontmatter(path.join(workspace, 'knowledge/customers/berlin.md'), { title: 'Berlin Maschinen', status: 'active', market: 'DE', priority: 'P1' }, '# Profile');
    await writeYamlFrontmatter(path.join(workspace, 'knowledge/customers/tokyo.md'), { title: 'Tokyo Trading', status: 'active', market: 'JP', priority: 'P2' }, '# Profile');
    await writeYamlFrontmatter(path.join(workspace, 'knowledge/deals/berlin.md'), { title: 'Berlin Renewal', customer: 'knowledge/customers/berlin.md', status: 'active', funnel_stage: 'proposal', risk_level: 'high' }, '# Goal');
    const customers = await searchEntities(workspace, 'berlin', 'customer', { market: 'DE' }, 20);
    assert.equal(customers.count, 1);
    assert.equal(customers.results[0].title, 'Berlin Maschinen');
    const deals = await searchEntities(workspace, '', 'deal', { risk_level: 'high', funnel_stage: 'proposal' }, 20);
    assert.equal(deals.count, 1);
    assert.equal(deals.results[0].title, 'Berlin Renewal');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('Snapshot remains readable offline and skips a malformed concept file', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'dealpilot-offline-snapshot-'));
  try {
    const { ensureWorkspace } = await import('../plugin/lib/workspace-manager.js');
    const { writeYamlFrontmatter } = await import('../plugin/lib/okf-utils.js');
    const { buildSnapshot } = await import('../plugin/lib/snapshot.js');
    await ensureWorkspace(workspace);
    await writeYamlFrontmatter(path.join(workspace, 'knowledge/customers/valid.md'), { title: 'Offline Customer', status: 'active' }, '# Profile');
    await (await import('node:fs/promises')).writeFile(path.join(workspace, 'knowledge/customers/broken.md'), 'not frontmatter', 'utf8');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('DSH unavailable'); };
    try {
      const first = await buildSnapshot(workspace, new Date('2026-08-26T12:00:00.000Z'));
      const second = await buildSnapshot(workspace, new Date('2026-08-26T12:00:00.000Z'));
      assert.equal(first.summary.customers, 1);
      assert.deepEqual(second, first);
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('User-visible errors never disclose the absolute Workspace path', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'dealpilot-path-redaction-'));
  try {
    const { buildSnapshot } = await import('../plugin/lib/snapshot.js');
    await assert.rejects(() => buildSnapshot(workspace), (error) => {
      assert.match(error.message, /尚未初始化/);
      assert.equal(error.message.includes(workspace), false);
      return true;
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
