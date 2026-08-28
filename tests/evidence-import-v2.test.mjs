import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  computeEvidenceDigest,
  evidenceAccountingFor,
  makeEvidenceCell,
  paginateEvidence,
  rowHash,
  validateEvidenceDocument,
} from '../plugin/lib/evidence-contract.js';
import { convertSource, readImportJob, registerCanonicalImportTools } from '../plugin/lib/canonical-import.js';

function evidenceFixture() {
  const source = {
    source_id: `src_${'a'.repeat(32)}`,
    name: 'fixture.xlsx',
    media_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    sha256: 'a'.repeat(64),
    session_id: 'session-1',
    archived_ref: 'sources/imports/imp_1/source.xlsx',
  };
  const headers = ['Contact', 'Contact'].map((display, index) => makeEvidenceCell({
    source_id: source.source_id,
    sheet_id: 'sheet_1',
    row_number: 1,
    column_id: `c_${index + 1}`,
    address: `${String.fromCharCode(65 + index)}1`,
    raw_cell: { v: display, w: display },
    display,
  }));
  const cells = [
    makeEvidenceCell({ source_id: source.source_id, sheet_id: 'sheet_1', row_number: 2, column_id: 'c_1', address: 'A2', raw_cell: { v: 0, w: '0' }, display: '0' }),
    makeEvidenceCell({ source_id: source.source_id, sheet_id: 'sheet_1', row_number: 2, column_id: 'c_2', address: 'B2', raw_cell: { v: false, w: 'FALSE', f: '=1=2' }, display: 'FALSE' }),
  ];
  const row = { row_id: 'sheet_1:r_2', row_number: 2, cells, row_hash: '', warnings: [] };
  row.row_hash = rowHash(row);
  const sheet = {
    sheet_id: 'sheet_1',
    name: 'Customers',
    visibility: 'visible',
    columns: headers.map((header, index) => ({ column_id: `c_${index + 1}`, index, label: 'Contact', address: String.fromCharCode(65 + index), header })),
    rows: [row],
  };
  const document = {
    schema: 'dealpilot.evidence/v2',
    source,
    sheets: [sheet],
    accounting: evidenceAccountingFor([sheet]),
    warnings: [],
    provenance: { converter: 'fixture', converter_version: '1', converted_at: '2026-08-28T00:00:00Z' },
    evidence_digest: '',
  };
  document.evidence_digest = computeEvidenceDigest(document);
  return document;
}

test('evidence/v2 counts and paginates headers as observations without collapsing duplicate labels', () => {
  const evidence = evidenceFixture();
  validateEvidenceDocument(evidence);
  assert.equal(evidence.accounting.header_count, 2);
  assert.equal(evidence.accounting.data_cell_count, 2);
  assert.equal(evidence.accounting.observation_count, 4);
  assert.equal(evidence.sheets[0].columns[0].label, evidence.sheets[0].columns[1].label);
  assert.notEqual(evidence.sheets[0].columns[0].column_id, evidence.sheets[0].columns[1].column_id);

  const first = paginateEvidence(evidence, { max_items: 2 });
  assert.deepEqual(first.observations.map((item) => item.observation_kind), ['header', 'header']);
  assert.deepEqual(first.observations.map((item) => item.address), ['A1', 'B1']);
  const second = paginateEvidence(evidence, { max_items: 2, cursor: first.next_cursor });
  assert.deepEqual(second.observations.map((item) => item.raw), [0, false]);
  assert.equal(second.observations[1].formula, '=1=2');
  assert.equal(second.next_cursor, null);

  assert.throws(
    () => paginateEvidence(evidence, { max_items: 2, cursor: first.next_cursor, sheet: 'Customers' }),
    (error) => error.code === 'CURSOR_QUERY_MISMATCH',
  );
});

test('evidence/v2 rejects legacy accounting without complete observation counters', () => {
  const evidence = evidenceFixture();
  const legacy = structuredClone(evidence);
  legacy.accounting.cell_count = 4;
  legacy.accounting.preserved_cell_count = 4;
  delete legacy.accounting.observation_count;
  delete legacy.accounting.column_count;
  delete legacy.accounting.unreadable_cell_count;
  delete legacy.accounting.header_count;
  delete legacy.accounting.data_cell_count;
  assert.throws(
    () => validateEvidenceDocument(legacy),
    (error) => error.code === 'EXPECTED_INTEGER' && error.path === '$.accounting.observation_count',
  );
});

test('evidence/v2 requires a header observation for every represented column', () => {
  const evidence = evidenceFixture();
  const missingHeader = structuredClone(evidence);
  delete missingHeader.sheets[0].columns[1].header;
  assert.throws(
    () => validateEvidenceDocument(missingHeader),
    (error) => error.code === 'MISSING_VALUE' && error.path === '$.sheets[0].columns[1].header',
  );
});

test('missing adapter payload is explicit unreadable evidence', () => {
  const cell = makeEvidenceCell({
    source_id: `src_${'a'.repeat(32)}`,
    sheet_id: 'sheet_1',
    row_number: 2,
    column_id: 'c_1',
    address: 'A2',
    unreadable: true,
    warning: 'adapter returned no payload',
  });
  assert.equal(cell.raw_present, false);
  assert.equal(cell.display_present, false);
  assert.equal(cell.observation_status, 'unreadable');
  assert.equal(cell.empty_reason, 'unreadable');
});

test('canonical import emits only evidence/v2 and does not manufacture grid-capacity observations', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'dealpilot-evidence-v2-'));
  try {
    const sourceRef = 'sources/inbox/fixture.xlsx';
    await mkdir(path.dirname(path.join(workspace, sourceRef)), { recursive: true });
    await writeFile(path.join(workspace, sourceRef), 'fixture bytes');
    const univer = {
      version: 'test-1',
      newFile: async () => ({}),
      worktree: async (request) => request.action === 'create' ? { result: { worktreeId: 'wt-1' } } : {},
      importUnitContent: async () => ({}),
      status: async () => ({ result: { selectedWorktree: { units: [{ unitId: 'unit-1', kind: 'sheet' }] } } }),
      inspectUnitContent: async (request) => request.range
        ? { result: { ranges: [{ displayValues: [['Contact', 'Contact'], [0, false]], cellData: [[{ v: 'Contact' }, { v: 'Contact' }], [{ v: 0 }, { v: false }]] }] } }
        : { result: { worksheets: [
          { name: 'Customers', rowCount: 1000, columnCount: 50, valueUsedRanges: ['A1:B2'] },
          { name: 'Empty', rowCount: 1000, columnCount: 50, valueUsedRanges: [] },
        ] } },
    };
    const converted = await convertSource(workspace, { kind: 'workspace_file', path: sourceRef }, 'session-1', 'imp_1', univer);
    assert.equal(converted.doc.schema, 'dealpilot.evidence/v2');
    assert.equal(converted.doc.sheets[0].columns.length, 2);
    assert.equal(converted.doc.sheets[0].rows.length, 1);
    assert.equal(converted.doc.sheets[1].columns.length, 0);
    assert.equal(converted.doc.sheets[1].rows.length, 0);
    assert.equal(converted.doc.sheets[0].columns.some((column) => 'key' in column), false);
    assert.equal(converted.doc.sheets[0].rows.some((row) => 'values' in row || 'raw' in row), false);
    assert.equal(JSON.parse(await readFile(path.join(workspace, converted.manifest), 'utf8')).schema, 'dealpilot.import-manifest/v2');
    validateEvidenceDocument(converted.doc, { source_bytes: await readFile(path.join(workspace, sourceRef)) });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('canonical import keeps structured range bounds and sparse adapter coordinates', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'dealpilot-evidence-sparse-'));
  try {
    const sourceRef = 'sources/inbox/sparse.xlsx';
    await mkdir(path.dirname(path.join(workspace, sourceRef)), { recursive: true });
    await writeFile(path.join(workspace, sourceRef), 'sparse fixture bytes');
    const requestedRanges = [];
    const univer = {
      version: 'test-sparse',
      newFile: async () => ({}),
      worktree: async (request) => request.action === 'create' ? { result: { worktreeId: 'wt-sparse' } } : {},
      importUnitContent: async () => ({}),
      status: async () => ({ result: { selectedWorktree: { units: [{ unitId: 'unit-sparse', kind: 'sheet' }] } } }),
      inspectUnitContent: async (request) => {
        if (!request.range) {
          return { result: { worksheets: [{
            name: 'Sparse', rowCount: 1000, columnCount: 50,
            valueUsedRanges: [{ startRow: 0, endRow: 2, startColumn: 0, endColumn: 2 }],
          }] } };
        }
        requestedRanges.push(request.range);
        return { result: { ranges: [
          {
            resolvedRange: 'A1:C1',
            formatted_values: [['Header A', undefined, 'Header C']],
            cell_data: [[{ v: 'Header A' }, undefined, { v: 'Header C' }]],
          },
          {
            resolvedRange: 'A3:C3',
            formatted_values: [['Value A', undefined, 'Value C']],
            cell_data: [[{ v: 'Value A' }, undefined, { v: 'Value C', adapter_extra: { retained: true } }]],
          },
        ] } };
      },
    };
    const converted = await convertSource(workspace, { kind: 'workspace_file', path: sourceRef }, 'session-1', 'imp_sparse', univer);
    assert.deepEqual(requestedRanges, ["'Sparse'!A1:C3"]);
    assert.deepEqual(converted.doc.sheets[0].rows.map((row) => row.row_number), [2, 3]);
    assert.equal(converted.doc.sheets[0].rows[1].cells[2].address, 'C3');
    assert.equal(converted.doc.sheets[0].rows[1].cells[2].raw, 'Value C');
    assert.deepEqual(converted.doc.sheets[0].rows[1].cells[2].cell_data.adapter_extra, { retained: true });
    assert.equal(converted.doc.sheets[0].rows[0].cells[0].observation_status, 'unreadable');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('canonical import makes an empty workbook observable without inventing cells', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'dealpilot-evidence-empty-workbook-'));
  try {
    const sourceRef = 'sources/inbox/empty.xlsx';
    await mkdir(path.dirname(path.join(workspace, sourceRef)), { recursive: true });
    await writeFile(path.join(workspace, sourceRef), 'empty workbook bytes');
    const univer = {
      version: 'test-empty-workbook',
      newFile: async () => ({}),
      worktree: async (request) => request.action === 'create' ? { result: { worktreeId: 'wt-empty' } } : {},
      importUnitContent: async () => ({}),
      status: async () => ({ result: { selectedWorktree: { units: [{ unitId: 'unit-empty', kind: 'sheet' }] } } }),
      inspectUnitContent: async () => ({ result: { worksheets: [] } }),
    };
    const converted = await convertSource(workspace, { kind: 'workspace_file', path: sourceRef }, 'session-1', 'imp_empty', univer);
    assert.deepEqual(converted.doc.sheets, []);
    assert.equal(converted.doc.accounting.observation_count, 0);
    assert.match(converted.doc.warnings.join('\n'), /没有可读取的工作表/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('ingest publishes and validates an immutable artifact graph', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'dealpilot-import-artifacts-'));
  try {
    const sourceRef = 'in/artifact.xlsx';
    await mkdir(path.dirname(path.join(workspace, sourceRef)), { recursive: true });
    await writeFile(path.join(workspace, sourceRef), 'artifact bytes');
    const univer = {
      version: 'test-artifacts',
      newFile: async ({ file }) => { await writeFile(file, 'univer'); },
      worktree: async (request) => request.action === 'create' ? { result: { worktreeId: 'wt-artifacts' } } : {},
      importUnitContent: async () => ({}),
      status: async () => ({ result: { selectedWorktree: { units: [{ unitId: 'unit-artifacts', kind: 'sheet' }] } } }),
      inspectUnitContent: async (request) => request.range
        ? { result: { ranges: [{ displayValues: [['Name'], ['Acme']], cellData: [[{ v: 'Name' }], [{ v: 'Acme' }]] }] } }
        : { result: { worksheets: [{ name: 'Customers', valueUsedRanges: ['A1:A2'] }] } },
    };
    const registered = [];
    const harness = { registerTool: (_ctx, tool) => registered.push(tool), defineTool: (tool) => tool };
    registerCanonicalImportTools({ config: { defaultWorkspace: workspace } }, harness, univer);
    const result = JSON.parse(await registered[0].execute({ source: { kind: 'workspace_file', path: sourceRef } }, { agent: { id: 'artifact-session' } }));
    assert.equal(result.status, 'converted');
    assert.equal(result.accounting.observation_count, 2);
    assert.equal(result.sheets[0].header_count, 1);
    assert.equal(result.sheets[0].data_cell_count, 1);
    assert.equal(result.sheets[0].observations, 2);

    const job = await readImportJob(workspace, result.import_job_id);
    assert.equal(job.schema, 'dealpilot.import-job/v2');
    assert.equal(job.canonical_ref, result.canonical_ref);
    const manifest = JSON.parse(await readFile(path.join(workspace, job.manifest_ref), 'utf8'));
    assert.equal(manifest.schema, 'dealpilot.import-manifest/v2');
    assert.equal(manifest.canonical_ref, job.canonical_ref);
    assert.equal(manifest.evidence_digest, job.evidence_digest);

    const canonicalPath = path.join(workspace, job.canonical_ref);
    const canonicalBytes = await readFile(canonicalPath);
    const tampered = JSON.parse(canonicalBytes.toString('utf8'));
    tampered.sheets[0].rows[0].cells[0].display = 'Tampered';
    await writeFile(canonicalPath, JSON.stringify(tampered));
    await assert.rejects(() => readImportJob(workspace, job.import_job_id), /canonical evidence|JSON 无效|cell hash|HASH_MISMATCH/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('source archive publication is immutable when an import id collides', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'dealpilot-import-immutable-'));
  try {
    const sourceRef = 'in/collision.xlsx';
    await mkdir(path.dirname(path.join(workspace, sourceRef)), { recursive: true });
    await writeFile(path.join(workspace, sourceRef), 'new source');
    const archiveRef = 'sources/imports/imp_collision/source.xlsx';
    await mkdir(path.dirname(path.join(workspace, archiveRef)), { recursive: true });
    await writeFile(path.join(workspace, archiveRef), 'original archive');
    await assert.rejects(
      () => convertSource(workspace, { kind: 'workspace_file', path: sourceRef }, 'session-1', 'imp_collision', {}),
      /不可覆盖既有导入 artifact/,
    );
    assert.equal(await readFile(path.join(workspace, archiveRef), 'utf8'), 'original archive');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
