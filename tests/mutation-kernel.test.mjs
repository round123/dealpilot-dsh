import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

test('durable approval binds the complete change set and is one-shot', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'dealpilot-approval-v2-'));
  try {
    const { createApproval, consumeApproval, listApprovals, canonicalHash } = await import('../plugin/lib/approval-store.js');
    const payload = { schema: 'dealpilot.change-set/v2', change_set_id: 'chg-1', operations: [{ op_id: 'op-1' }] };
    const created = createApproval({
      tool: 'dealpilot_apply', workspacePath: workspace, workspaceId: 'ws-1', sessionId: 'session-1',
      schemaVersion: 'dealpilot.change-set/v2', changeSetId: 'chg-1', changeSetHash: canonicalHash(payload),
      selectedOpIds: ['op-1'], payload,
    });
    assert.equal(listApprovals(workspace, 'pending').length, 1);
    const consumed = consumeApproval(created.token, {
      tool: 'dealpilot_apply', workspacePath: workspace, workspaceId: 'ws-1', sessionId: 'session-1',
      schemaVersion: 'dealpilot.change-set/v2', changeSetId: 'chg-1', changeSetHash: canonicalHash(payload),
      selectedOpIds: ['op-1'], payload,
    });
    assert.equal(consumed.status, 'consumed');
    assert.throws(() => consumeApproval(created.token, {
      tool: 'dealpilot_apply', workspacePath: workspace, workspaceId: 'ws-1', sessionId: 'session-1',
      schemaVersion: 'dealpilot.change-set/v2', changeSetId: 'chg-1', changeSetHash: canonicalHash(payload),
      selectedOpIds: ['op-1'], payload,
    }), /不能再次使用/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('typed mutation kernel applies atomically and returns the same result on retry', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'dealpilot-kernel-v2-'));
  try {
    const { ensureWorkspace } = await import('../plugin/lib/workspace-manager.js');
    const { computeWorkspaceRevision } = await import('../plugin/lib/workspace-revision.js');
    const { createApproval, listApprovals } = await import('../plugin/lib/approval-store.js');
    const { computeChangeSetHash } = await import('../plugin/lib/change-set-contract.js');
    const { applyChangeSet, listTransactions } = await import('../plugin/lib/mutation-kernel.js');
    await ensureWorkspace(workspace);
    const revision = await computeWorkspaceRevision(workspace);
    const changeSet = {
      schema: 'dealpilot.change-set/v2',
      change_set_id: 'chg-kernel-1',
      workspace_revision: revision,
      evidence_digest: 'a'.repeat(64),
      interpretation_id: 'int-kernel-1',
      operations: [{
        op_id: 'op-customer-1', entity_type: 'customer', operation: 'create', target: { identity: { title: 'Kernel customer' } },
        field_changes: [{ path: 'market', after: 'DE', value_status: 'observed', claim_ids: ['clm-1'], evidence_refs: ['obs-1'] }],
        preserve_claim_refs: [], conflicts: [], risk: 'low',
      }],
      accounting: { source_rows: 1, mapped_observations: 1, unresolved_observations: 0, ignored_observations: 0 },
    };
    changeSet.change_set_hash = computeChangeSetHash(changeSet);
    const approval = createApproval({
      tool: 'dealpilot_apply', workspacePath: workspace, workspaceId: 'ws-kernel', sessionId: 'session-kernel',
      schemaVersion: 'dealpilot.change-set/v2', baseRevision: revision, changeSetId: changeSet.change_set_id,
      changeSetHash: computeChangeSetHash(changeSet), interpretationId: changeSet.interpretation_id,
      selectedOpIds: ['op-customer-1'], payload: changeSet,
    });
    const first = await applyChangeSet(workspace, changeSet, {
      workspaceId: 'ws-kernel', sessionId: 'session-kernel', approvalToken: approval.token,
    });
    assert.equal(first.ok, true);
    assert.equal(first.status, 'completed');
    assert.equal(first.results.length, 1);
    const ref = first.results[0].ref;
    assert.match(await readFile(path.join(workspace, ref), 'utf8'), /market: DE/);
    const events = await readFile(path.join(workspace, 'knowledge/events/business-events.jsonl'), 'utf8');
    assert.match(events, /mutation_transaction_id/);
    assert.equal((await listTransactions(workspace)).length, 1);

    const retry = await applyChangeSet(workspace, changeSet, {
      workspaceId: 'ws-kernel', sessionId: 'session-kernel', approvalToken: 'dpa_not_needed_after_completion',
    });
    assert.deepEqual(retry, first);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('typed mutation kernel rejects untyped targets and cross-entity refs before writing', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'dealpilot-kernel-reject-'));
  try {
    const { ensureWorkspace } = await import('../plugin/lib/workspace-manager.js');
    const { applyChangeSet } = await import('../plugin/lib/mutation-kernel.js');
    await ensureWorkspace(workspace);
    const base = (operation) => ({
      schema: 'dealpilot.change-set/v2', change_set_id: `bad-${operation.op_id}`,
      workspace_revision: 'rev_test', evidence_digest: 'a'.repeat(64), interpretation_id: 'int-1',
      operations: [operation], accounting: { source_rows: 1, mapped_observations: 1, unresolved_observations: 0, ignored_observations: 0 },
    });
    await assert.rejects(() => applyChangeSet(workspace, base({
      op_id: 'bad-1', entity_type: 'customer', operation: 'create', target: 'knowledge/notes/untitled.md',
      field_changes: [], preserve_claim_refs: [], conflicts: [], risk: 'low',
    })), /target.*object|TARGET_MUST_BE_OBJECT/iu);
    await assert.rejects(() => applyChangeSet(workspace, base({
      op_id: 'bad-2', entity_type: 'customer', operation: 'update', target: { ref: 'knowledge/notes/n.md' },
      field_changes: [], preserve_claim_refs: [], conflicts: [], risk: 'low',
    })), /notes|entity.*mismatch|resolve under|TARGET_ENTITY_MISMATCH/iu);
    await assert.rejects(() => applyChangeSet(workspace, base({
      op_id: 'bad-3', entity_type: 'customer', operation: 'create', target: { identity: { title: 'No evidence' } },
      field_changes: [{ path: 'market', after: 'DE', value_status: 'observed', claim_ids: [], evidence_refs: [] }],
      preserve_claim_refs: [], conflicts: [], risk: 'low',
    })), /evidence|claim reference|cite a claim|FACT_CHANGE_WITHOUT/iu);
    assert.deepEqual((await readdir(path.join(workspace, 'knowledge/customers'))).filter(name => name.endsWith('.md')), []);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('typed kernel rejects legacy direct-write fields before creating a transaction', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'dealpilot-kernel-legacy-'));
  try {
    const { ensureWorkspace } = await import('../plugin/lib/workspace-manager.js');
    const { computeWorkspaceRevision } = await import('../plugin/lib/workspace-revision.js');
    const { computeChangeSetHash } = await import('../plugin/lib/change-set-contract.js');
    const { applyChangeSet, listTransactions } = await import('../plugin/lib/mutation-kernel.js');
    await ensureWorkspace(workspace);
    const changeSet = {
      schema: 'dealpilot.change-set/v2', change_set_id: 'chg-legacy-field',
      workspace_revision: await computeWorkspaceRevision(workspace), evidence_digest: 'b'.repeat(64), interpretation_id: 'int-legacy',
      operations: [{
        op_id: 'op-legacy', entity_type: 'customer', operation: 'create', target: { identity: { title: 'Legacy field' } },
        field_changes: [], preserve_claim_refs: [], conflicts: [], risk: 'low',
        metadata: { status: 'active' },
      }],
      accounting: { source_rows: 0, mapped_observations: 0, unresolved_observations: 0, ignored_observations: 0 },
    };
    assert.throws(() => computeChangeSetHash(changeSet), (error) => error?.code === 'UNKNOWN_PROTOCOL_FIELD' && error?.path === '$.operations[0].metadata');
    assert.equal((await listTransactions(workspace)).length, 0);
    assert.deepEqual((await readdir(path.join(workspace, 'knowledge/customers'))).filter(name => name.endsWith('.md')), []);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('workspace revision drift leaves approval pending and performs no write', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'dealpilot-kernel-revision-'));
  try {
    const { ensureWorkspace } = await import('../plugin/lib/workspace-manager.js');
    const { computeWorkspaceRevision } = await import('../plugin/lib/workspace-revision.js');
    const { createApproval, listApprovals } = await import('../plugin/lib/approval-store.js');
    const { computeChangeSetHash } = await import('../plugin/lib/change-set-contract.js');
    const { applyChangeSet, listTransactions } = await import('../plugin/lib/mutation-kernel.js');
    await ensureWorkspace(workspace);
    const revision = await computeWorkspaceRevision(workspace);
    const changeSet = {
      schema: 'dealpilot.change-set/v2', change_set_id: 'chg-revision-drift', workspace_revision: revision,
      evidence_digest: 'c'.repeat(64), interpretation_id: 'int-revision',
      operations: [{ op_id: 'op-revision', entity_type: 'customer', operation: 'create', target: { identity: { title: 'Drift' } }, field_changes: [{ path: 'market', after: 'DE', value_status: 'observed', claim_ids: ['clm-revision'], evidence_refs: ['obs-revision'] }], preserve_claim_refs: [], conflicts: [], risk: 'low' }],
      accounting: { source_rows: 0, mapped_observations: 0, unresolved_observations: 0, ignored_observations: 0 },
    };
    changeSet.change_set_hash = computeChangeSetHash(changeSet);
    const approval = createApproval({ tool: 'dealpilot_apply', workspacePath: workspace, workspaceId: 'ws-drift', sessionId: 'session-drift', schemaVersion: 'dealpilot.change-set/v2', baseRevision: revision, changeSetId: changeSet.change_set_id, changeSetHash: changeSet.change_set_hash, interpretationId: changeSet.interpretation_id, selectedOpIds: ['op-revision'], payload: changeSet });
    await writeFile(path.join(workspace, 'knowledge', 'customers', 'external.md'), 'external edit\n', 'utf8');
    await assert.rejects(() => applyChangeSet(workspace, changeSet, { workspaceId: 'ws-drift', sessionId: 'session-drift', approvalToken: approval.token }), /revision 已变化|重新读取/iu);
    assert.equal(listApprovals(workspace, 'pending').length, 1);
    assert.equal((await listTransactions(workspace)).length, 0);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('field before-image mismatch fails without overwriting the current document', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'dealpilot-kernel-before-'));
  try {
    const { ensureWorkspace } = await import('../plugin/lib/workspace-manager.js');
    const { computeWorkspaceRevision } = await import('../plugin/lib/workspace-revision.js');
    const { createApproval, listApprovals } = await import('../plugin/lib/approval-store.js');
    const { computeChangeSetHash } = await import('../plugin/lib/change-set-contract.js');
    const { applyChangeSet } = await import('../plugin/lib/mutation-kernel.js');
    await ensureWorkspace(workspace);
    const ref = 'knowledge/customers/before.md';
    const filePath = path.join(workspace, ref);
    await writeFile(filePath, '---\ntitle: Before\nmarket: changed\n---\n\nOriginal\n', 'utf8');
    const revision = await computeWorkspaceRevision(workspace);
    const changeSet = {
      schema: 'dealpilot.change-set/v2', change_set_id: 'chg-before-mismatch', workspace_revision: revision,
      evidence_digest: 'd'.repeat(64), interpretation_id: 'int-before',
      operations: [{ op_id: 'op-before', entity_type: 'customer', operation: 'update', target: { ref }, field_changes: [{ path: 'market', before: 'old', after: 'new', value_status: 'observed', claim_ids: ['clm-before'], evidence_refs: ['obs-before'] }], preserve_claim_refs: [], conflicts: [], risk: 'low' }],
      accounting: { source_rows: 0, mapped_observations: 0, unresolved_observations: 0, ignored_observations: 0 },
    };
    changeSet.change_set_hash = computeChangeSetHash(changeSet);
    const approval = createApproval({ tool: 'dealpilot_apply', workspacePath: workspace, workspaceId: 'ws-before', sessionId: 'session-before', schemaVersion: 'dealpilot.change-set/v2', baseRevision: revision, changeSetId: changeSet.change_set_id, changeSetHash: changeSet.change_set_hash, interpretationId: changeSet.interpretation_id, selectedOpIds: ['op-before'], payload: changeSet });
    const result = await applyChangeSet(workspace, changeSet, { workspaceId: 'ws-before', sessionId: 'session-before', approvalToken: approval.token });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'failed');
    assert.match(result.error || '', /before|变化/iu);
    assert.match(await readFile(filePath, 'utf8'), /market: changed/);
    assert.equal(listApprovals(workspace, 'pending').length, 1);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('transaction recovery finishes a Windows replace interrupted after the old image moved to backup', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'dealpilot-kernel-recovery-'));
  try {
    const { ensureWorkspace } = await import('../plugin/lib/workspace-manager.js');
    const { computeWorkspaceRevision } = await import('../plugin/lib/workspace-revision.js');
    const { createApproval } = await import('../plugin/lib/approval-store.js');
    const { computeChangeSetHash } = await import('../plugin/lib/change-set-contract.js');
    const { applyChangeSet, recoverTransactions, readTransaction } = await import('../plugin/lib/mutation-kernel.js');
    await ensureWorkspace(workspace);
    const ref = 'knowledge/customers/recovery.md';
    const filePath = path.join(workspace, ref);
    await writeFile(filePath, '---\ntitle: Recovery\nmarket: old\n---\n\nBody\n', 'utf8');
    const revision = await computeWorkspaceRevision(workspace);
    const changeSet = {
      schema: 'dealpilot.change-set/v2', change_set_id: 'chg-recovery', workspace_revision: revision,
      evidence_digest: 'e'.repeat(64), interpretation_id: 'int-recovery',
      operations: [{ op_id: 'op-recovery', entity_type: 'customer', operation: 'update', target: { ref }, field_changes: [{ path: 'market', before: 'old', after: 'new', value_status: 'observed', claim_ids: ['clm-recovery'], evidence_refs: ['obs-recovery'] }], preserve_claim_refs: [], conflicts: [], risk: 'low' }],
      accounting: { source_rows: 0, mapped_observations: 0, unresolved_observations: 0, ignored_observations: 0 },
    };
    changeSet.change_set_hash = computeChangeSetHash(changeSet);
    const approval = createApproval({ tool: 'dealpilot_apply', workspacePath: workspace, workspaceId: 'ws-recovery', sessionId: 'session-recovery', schemaVersion: 'dealpilot.change-set/v2', baseRevision: revision, changeSetId: changeSet.change_set_id, changeSetHash: changeSet.change_set_hash, interpretationId: changeSet.interpretation_id, selectedOpIds: ['op-recovery'], payload: changeSet });
    const applied = await applyChangeSet(workspace, changeSet, { workspaceId: 'ws-recovery', sessionId: 'session-recovery', approvalToken: approval.token });
    assert.equal(applied.status, 'completed');
    const journalPath = path.join(workspace, 'storage', 'transactions', `${applied.transaction_id}.json`);
    const journal = JSON.parse(await readFile(journalPath, 'utf8'));
    const item = journal.operations[0];
    assert.ok(item.backup_path);
    await mkdir(path.dirname(path.join(workspace, item.backup_path)), { recursive: true });
    await writeFile(path.join(workspace, item.backup_path), item.before.content, 'utf8');
    await unlink(filePath);
    journal.status = 'recoverable';
    journal.current_workspace_revision = await computeWorkspaceRevision(workspace);
    journal.operations[0].status = 'staged';
    delete journal.operations[0].result;
    delete journal.operations[0].completed_at;
    journal.completed_ops = [];
    journal.failed_ops = [];
    await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`, 'utf8');
    const recovered = await recoverTransactions(workspace, { workspaceId: 'ws-recovery', sessionId: 'session-recovery' });
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].status, 'completed');
    assert.match(await readFile(filePath, 'utf8'), /market: new/);
    const events = (await readFile(path.join(workspace, 'knowledge/events/business-events.jsonl'), 'utf8')).trim().split(/\r?\n/u);
    assert.equal(events.filter(line => JSON.parse(line).event_id === item.event_id).length, 1);
    await assert.rejects(() => readFile(path.join(workspace, item.backup_path), 'utf8'));
    assert.equal((await readTransaction(workspace, applied.transaction_id)).status, 'completed');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
