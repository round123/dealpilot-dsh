import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from '../plugin/node_modules/exceljs/lib/exceljs.nodejs.js';

test('canonical import flows through JSON, preview, commit, and dedup', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'dealpilot-real-import-'));
  try {
    const manager = await import('../plugin/lib/workspace-manager.js'); const sessions = await import('../plugin/lib/dealpilot-session.js');
    await manager.ensureWorkspace(workspace); const workspaceId = `dealpilot/${path.basename(workspace)}`; manager.registerWorkspacePath(workspaceId, workspace);
    const session = await sessions.createDealPilotSession(workspaceId, 'real-import-session'); const legacy = await import('../plugin/lib/import-tool.js');
    await legacy.importEntities(workspace, 'title,market\nAcme Corp,US', 'csv', { sourceCategory: 'fixture', autoDedup: true, now: new Date().toISOString() });
    const workbook = new ExcelJS.Workbook(); const sheet = workbook.addWorksheet('Customers');
    sheet.addRow(['Company Name', 'Country', 'Entity', 'Profile', 'Customer']); sheet.addRow(['Acme GmbH', 'DE', 'customer', 'Industrial automation buyer', '']); sheet.addRow(['Acme Corp', 'US', 'customer', 'Existing customer should deduplicate', '']); sheet.addRow(['Acme GmbH Renewal', 'DE', 'deal', 'Expansion opportunity', 'Acme GmbH']);
    const sourceRef = `sources/imports/uploads/simulated-${Date.now()}.xlsx`; const sourcePath = path.join(workspace, sourceRef); await mkdir(path.dirname(sourcePath), { recursive: true }); await writeFile(sourcePath, Buffer.from(await workbook.xlsx.writeBuffer()));
    const univer = { newFile: async () => ({}), worktree: async (request) => request.action === 'create' ? { result: { worktreeId: 'wt-import' } } : {}, importUnitContent: async () => ({}), status: async () => ({ result: { selectedWorktree: { units: [{ unitId: 'unit-customers', kind: 'sheet' }] } } }), inspectUnitContent: async (request) => request.range ? { result: { ranges: [{ displayValues: [['Company Name', 'Country', 'Entity', 'Profile', 'Customer'], ['Acme GmbH', 'DE', 'customer', 'Industrial automation buyer', ''], ['Acme Corp', 'US', 'customer', 'Existing customer should deduplicate', ''], ['Acme GmbH Renewal', 'DE', 'deal', 'Expansion opportunity', 'Acme GmbH']], cellData: [] }] } } : { result: { worksheets: [{ name: 'Customers', rowCount: 1000, columnCount: 20, valueUsedRanges: ['A1:E1', 'A2:E4'] }] } } };
    const registered = []; const { apply } = await import('../plugin/lib/index.js'); apply({ tools: { register: (tool) => registered.push(tool) }, univer, config: {} }); const tool = (name) => registered.find((item) => item.name === name); const exec = { agent: { id: session.sessionId } };
    const ingested = await tool('dealpilot_ingest').execute({ source: { kind: 'workspace_file', path: sourceRef } }, exec); assert.equal(ingested.status, 'converted'); assert.equal(ingested.sheets[0].rows, 3);
    const job = JSON.parse(await readFile(path.join(workspace, 'storage', 'import-jobs', `${ingested.import_job_id}.json`), 'utf8'));
    assert.equal(job.source_kind, 'workspace_file'); assert.equal(job.source_ref, sourceRef); assert.match(job.archived_source_ref, /^sources\/imports\/imp_.+\/source\.xlsx$/);
    assert.deepEqual(await readFile(path.join(workspace, job.archived_source_ref)), await readFile(sourcePath));
    const preview = await tool('dealpilot_import_preview').execute({ import_job_id: ingested.import_job_id, target: 'mixed', sheet: 'Customers' }, exec); assert.equal(preview.requires_confirmation, true); assert.equal(preview.preview.total, 3); assert.ok(preview.confirmation_token);
    const committed = await tool('dealpilot_import_commit').execute({ import_job_id: ingested.import_job_id, target: 'mixed', sheet: 'Customers', confirmation_token: preview.confirmation_token }, exec); assert.equal(committed.created, 2);
    assert.equal((await readdir(path.join(workspace, 'knowledge', 'customers'))).filter((name) => name.endsWith('.md')).length, 2); assert.equal((await readdir(path.join(workspace, 'knowledge', 'deals'))).filter((name) => name.endsWith('.md')).length, 1);
    const customerFiles = (await readdir(path.join(workspace, 'knowledge', 'customers'))).filter((name) => name.endsWith('.md')); const acme = customerFiles.find((name) => name.includes('-acme-gmbh.')); assert.ok(acme); assert.match(await readFile(path.join(workspace, 'knowledge', 'customers', acme), 'utf8'), /Industrial automation buyer/);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('canonical import enforces workspace and session source boundaries', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'dealpilot-source-boundary-'));
  const external = path.join(os.tmpdir(), `dealpilot-external-${Date.now()}.csv`);
  try {
    const manager = await import('../plugin/lib/workspace-manager.js'); const sessions = await import('../plugin/lib/dealpilot-session.js');
    await manager.ensureWorkspace(workspace); const workspaceId = `dealpilot/${path.basename(workspace)}`; manager.registerWorkspacePath(workspaceId, workspace);
    const session = await sessions.createDealPilotSession(workspaceId, 'source-owner-session');
    const ownRef = `.dsh-uploads/${session.sessionId}/customers.csv`; const foreignRef = '.dsh-uploads/another-session/customers.csv';
    await mkdir(path.dirname(path.join(workspace, ownRef)), { recursive: true }); await mkdir(path.dirname(path.join(workspace, foreignRef)), { recursive: true });
    await writeFile(path.join(workspace, ownRef), 'title,market\nOwn Customer,ES\n'); await writeFile(path.join(workspace, foreignRef), 'title,market\nForeign Customer,ES\n'); await writeFile(external, 'title,market\nExternal Customer,ES\n');
    const univer = { newFile: async () => ({}), worktree: async (request) => request.action === 'create' ? { result: { worktreeId: 'wt-boundary' } } : {}, importUnitContent: async () => ({}), status: async () => ({ result: { selectedWorktree: { units: [{ unitId: 'unit-customers', kind: 'sheet' }] } } }), inspectUnitContent: async (request) => request.range ? { result: { ranges: [{ displayValues: [['title', 'market'], ['Own Customer', 'ES']], cellData: [] }] } } : { result: { worksheets: [{ name: 'Customers', valueUsedRanges: ['A1:B2'] }] } } };
    const registered = []; const { apply } = await import('../plugin/lib/index.js'); apply({ tools: { register: (tool) => registered.push(tool) }, univer, config: {} }); const ingest = registered.find((item) => item.name === 'dealpilot_ingest'); const exec = { agent: { id: session.sessionId } };
    const own = await ingest.execute({ source: { kind: 'session_attachment', ref: ownRef } }, exec); assert.equal(own.status, 'converted');
    await assert.rejects(() => ingest.execute({ source: { kind: 'session_attachment', ref: foreignRef } }, exec), /不属于当前 session/);
    await assert.rejects(() => ingest.execute({ source: { kind: 'workspace_file', path: external } }, exec), /相对路径/);
  } finally { await rm(workspace, { recursive: true, force: true }); await rm(external, { force: true }); }
});
