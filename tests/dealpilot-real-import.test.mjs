import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from '../plugin/node_modules/exceljs/lib/exceljs.nodejs.js';

test('real simulated customer XLSX flows through inspect, preview, commit, and dedup', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'dealpilot-real-import-'));
  const workspaceId = `dealpilot/${path.basename(workspace)}`;
  try {
    const manager = await import('../plugin/lib/workspace-manager.js');
    const sessions = await import('../plugin/lib/dealpilot-session.js');
    const store = await import('../plugin/lib/artifact-store.js');
    await manager.ensureWorkspace(workspace);
    manager.registerWorkspacePath(workspaceId, workspace);
    const session = await sessions.createDealPilotSession(workspaceId, 'real-import-session');
    const importer = await import('../plugin/lib/import-tool.js');
    await importer.importEntities(workspace, 'title,market\nAcme Corp,US', 'csv', {
      sourceCategory: 'fixture', autoDedup: true, now: new Date().toISOString(),
    });

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Customers');
    sheet.addRow(['Company Name', 'Country', 'Entity', 'Profile', 'Customer']);
    sheet.addRow(['Acme GmbH', 'DE', 'customer', 'Industrial automation buyer', '']);
    sheet.addRow(['Acme Corp', 'US', 'customer', 'Existing customer should deduplicate', '']);
    sheet.addRow(['Acme GmbH Renewal', 'DE', 'deal', 'Expansion opportunity', 'Acme GmbH']);
    const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
    const artifact = await store.stageArtifact(workspace, workspaceId, 'simulated-customers.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', bytes);

    const registered = [];
    const { apply } = await import('../plugin/lib/index.js');
    apply({ config: {}, tools: { register: (tool) => registered.push(tool) } });
    const tool = (name) => registered.find((item) => item.name === name);
    const exec = { agent: { id: session.sessionId } };
    const inspected = await tool('dealpilot_artifact_inspect').execute({ artifact_id: artifact.id }, exec);
    assert.equal(inspected.format, 'xlsx');
    assert.equal(inspected.sheet, 'Customers');
    assert.deepEqual(inspected.columns, ['Company Name', 'Country', 'Entity', 'Profile', 'Customer']);
    assert.equal(inspected.rows.length, 3);

    const preview = await tool('dealpilot_import_preview').execute({
      artifact_id: artifact.id, target: 'mixed', sheet: 'Customers', header_row: 1,
      mapping: { 'Company Name': 'title', Country: 'market', Entity: 'entity', Profile: 'profile', Customer: 'customer' }, auto_dedup: true,
    }, exec);
    assert.equal(preview.requires_confirmation, true);
    assert.equal(preview.preview.total, 3);
    assert.equal(preview.preview.duplicates.length, 1);
    assert.ok(preview.confirmation_token);

    const committed = await tool('dealpilot_import_commit').execute({
      artifact_id: artifact.id, target: 'mixed', sheet: 'Customers', header_row: 1,
      mapping: { 'Company Name': 'title', Country: 'market', Entity: 'entity', Profile: 'profile', Customer: 'customer' }, auto_dedup: true,
      confirmation_token: preview.confirmation_token,
    }, exec);
    assert.equal(committed.created, 2);
    assert.equal((await readdir(path.join(workspace, 'knowledge', 'customers'))).filter((name) => name.endsWith('.md')).length, 2);
    assert.equal((await readdir(path.join(workspace, 'knowledge', 'deals'))).filter((name) => name.endsWith('.md')).length, 1);
    const customerFiles = (await readdir(path.join(workspace, 'knowledge', 'customers'))).filter((name) => name.endsWith('.md'));
    const acmeGmbhFile = customerFiles.find((name) => name.includes('-acme-gmbh.'));
    assert.ok(acmeGmbhFile);
    assert.match(await readFile(path.join(workspace, 'knowledge', 'customers', acmeGmbhFile), 'utf8'), /Industrial automation buyer/);
    assert.equal((await store.getArtifact(workspace, artifact.id)).status, 'imported');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
