import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from '../plugin/node_modules/exceljs/lib/exceljs.nodejs.js';

test('agent-native import preserves evidence and applies open-ended content', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'dealpilot-real-import-'));
  try {
    const manager = await import('../plugin/lib/workspace-manager.js'); const sessions = await import('../plugin/lib/dealpilot-session.js');
    await manager.ensureWorkspace(workspace); const workspaceId = `dealpilot/${path.basename(workspace)}`; manager.registerWorkspacePath(workspaceId, workspace);
    const session = await sessions.createDealPilotSession(workspaceId, 'real-import-session');
    const workbook = new ExcelJS.Workbook(); const sheet = workbook.addWorksheet('Customers');
    sheet.addRow(['Company Name', 'Country', 'Entity', 'Profile', 'Customer']); sheet.addRow(['Acme GmbH', 'DE', 'customer', 'Industrial automation buyer', '']); sheet.addRow(['Acme Corp', 'US', 'customer', 'Existing customer should deduplicate', '']); sheet.addRow(['Acme GmbH Renewal', 'DE', 'deal', 'Expansion opportunity', 'Acme GmbH']);
    const sourceRef = `sources/imports/uploads/simulated-${Date.now()}.xlsx`; const sourcePath = path.join(workspace, sourceRef); await mkdir(path.dirname(sourcePath), { recursive: true }); await writeFile(sourcePath, Buffer.from(await workbook.xlsx.writeBuffer()));
    const univer = { newFile: async () => ({}), worktree: async (request) => request.action === 'create' ? { result: { worktreeId: 'wt-import' } } : {}, importUnitContent: async () => ({}), status: async () => ({ result: { selectedWorktree: { units: [{ unitId: 'unit-customers', kind: 'sheet' }] } } }), inspectUnitContent: async (request) => request.range ? { result: { ranges: [{ displayValues: [['Company Name', 'Country', 'Entity', 'Profile', 'Customer'], ['Acme GmbH', 'DE', 'customer', 'Industrial automation buyer', ''], ['Acme Corp', 'US', 'customer', 'Existing customer should deduplicate', ''], ['Acme GmbH Renewal', 'DE', 'deal', 'Expansion opportunity', 'Acme GmbH']], cellData: [] }] } } : { result: { worksheets: [{ name: 'Customers', rowCount: 1000, columnCount: 20, valueUsedRanges: ['A1:E1', 'A2:E4'] }] } } };
    const registered = []; const { apply } = await import('../plugin/lib/index.js'); apply({ tools: { register: (tool) => registered.push(tool) }, univer, config: {} }); const tool = (name) => registered.find((item) => item.name === name); const exec = { agent: { id: session.sessionId } };
    const ingested = await tool('dealpilot_ingest').execute({ source: { kind: 'workspace_file', path: sourceRef } }, exec); assert.equal(ingested.status, 'converted'); assert.equal(ingested.sheets[0].rows, 3);
    const job = JSON.parse(await readFile(path.join(workspace, 'storage', 'import-jobs', `${ingested.import_job_id}.json`), 'utf8'));
    assert.equal(job.source_kind, 'workspace_file'); assert.equal(job.source_ref, sourceRef); assert.match(job.archived_source_ref, /^sources\/imports\/imp_.+\/source\.xlsx$/);
    assert.deepEqual(await readFile(path.join(workspace, job.archived_source_ref)), await readFile(sourcePath));
    const evidence = await tool('dealpilot_read').execute({ ref: job.canonical_ref }, exec); assert.equal(evidence.ref, job.canonical_ref); assert.match(evidence.content, /Industrial automation buyer/); assert.match(evidence.content, /Company Name/);
    const partialEvidence = await tool('dealpilot_read').execute({ ref: job.canonical_ref, sheet: 'Customers', range: 'A2:C3', include_raw: false }, exec);
    assert.equal(partialEvidence.location, 'Customers!A2:C3');
    assert.match(partialEvidence.content, /Acme GmbH/);
    assert.doesNotMatch(partialEvidence.content, /Industrial automation buyer/);
    const malformedRef = 'sources/imports/malformed-canonical.json'; await writeFile(path.join(workspace, malformedRef), JSON.stringify({ schema: 'dealpilot.import/v1', source: {}, sheets: [], warnings: [], provenance: {} }));
    await assert.rejects(() => tool('dealpilot_read').execute({ ref: malformedRef }, exec), /canonical JSON source 结构无效/);
    await assert.rejects(() => tool('dealpilot_propose').execute({ operations: [{ operation: 'append', target: { ref: 'knowledge/customers/acme.md' }, content: { format: 'text', value: 'external evidence' }, evidence: [{ sourceRef: 'C:/outside/source.xlsx' }] }] }, exec), /当前 Workspace 内的相对路径/);
    const proposal = await tool('dealpilot_propose').execute({ operations: [{ operation: 'create', target: { kind: 'customer', label: 'Acme GmbH' }, metadata: { preferred_channel: 'email', source_language: 'es' }, content: { format: 'markdown', value: '# Profile\n\nIndustrial automation buyer. Prefers asynchronous email and does not schedule morning meetings.' }, evidence: [{ sourceRef: job.canonical_ref, location: 'Customers!A2:E2', excerpt: 'Acme GmbH' }], rationale: 'Capture the customer context from the imported material.' }] }, exec); assert.ok(proposal.proposal_id);
    const pending = await tool('dealpilot_apply').execute({ proposal_id: proposal.proposal_id }, exec); assert.equal(pending.requires_confirmation, true); assert.ok(pending.confirmation_token);
    const otherSession = await sessions.createDealPilotSession(workspaceId, 'other-import-session');
    await assert.rejects(() => tool('dealpilot_apply').execute({ proposal_id: proposal.proposal_id }, { agent: { id: otherSession.sessionId } }), /不属于当前 session/);
    sessions.removeDealPilotSession(otherSession.sessionId);
    const applied = await tool('dealpilot_apply').execute({ proposal_id: proposal.proposal_id, confirmation_token: pending.confirmation_token }, exec); assert.equal(applied.status, 'applied');
    const customerFiles = (await readdir(path.join(workspace, 'knowledge', 'customers'))).filter((name) => name.endsWith('.md')); const acme = customerFiles.find((name) => name.includes('-acme-gmbh.')); assert.ok(acme); const saved = await readFile(path.join(workspace, 'knowledge', 'customers', acme), 'utf8'); assert.match(saved, /Prefers asynchronous email/); assert.match(saved, /Evidence:/); assert.match(saved, /preferred_channel/);
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
    const failedJobs = (await Promise.all((await readdir(path.join(workspace, 'storage', 'import-jobs'))).map(async (name) => JSON.parse(await readFile(path.join(workspace, 'storage', 'import-jobs', name), 'utf8'))))).filter((job) => job.status === 'failed');
    assert.ok(failedJobs.some((job) => /相对路径/.test(job.error)));
    assert.ok(failedJobs.every((job) => !path.isAbsolute(job.source_ref)));
  } finally { await rm(workspace, { recursive: true, force: true }); await rm(external, { force: true }); }
});
