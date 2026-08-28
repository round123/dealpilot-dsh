import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  computeEvidenceDigest,
  evidenceAccountingFor,
  makeEvidenceCell,
  rowHash,
  validateEvidenceDocument,
} from '../plugin/lib/evidence-contract.js';
import {
  validateInterpretationAgainstEvidence,
  validateInterpretationDocument,
  saveInterpretation,
  loadInterpretation,
} from '../plugin/lib/interpretation-contract.js';
import {
  buildChangeSetPreview,
  validateChangeSetAgainstInterpretation,
  validateChangeSetDocument,
} from '../plugin/lib/change-set-contract.js';

function fixture() {
  const source = {
    source_id: `src_${'a'.repeat(32)}`,
    name: 'fixture.csv',
    media_type: 'text/csv',
    sha256: 'a'.repeat(64),
    session_id: 'session-1',
    archived_ref: 'sources/imports/imp_1/source.csv',
  };
  const cell = makeEvidenceCell({
    source_id: source.source_id,
    sheet_id: 'sheet_1',
    row_number: 2,
    column_id: 'c_1',
    address: 'A2',
    raw_cell: { v: 'Acme', w: 'Acme' },
    display: 'Acme',
  });
  const headerCell = makeEvidenceCell({
    source_id: source.source_id,
    sheet_id: 'sheet_1',
    row_number: 1,
    column_id: 'c_1',
    address: 'A1',
    raw_cell: { v: 'Company', w: 'Company' },
    display: 'Company',
  });
  const row = { row_id: 'sheet_1:r_2', row_number: 2, cells: [cell], row_hash: '', warnings: [] };
  row.row_hash = rowHash(row);
  const evidence = {
    schema: 'dealpilot.evidence/v2',
    source,
    sheets: [{
      sheet_id: 'sheet_1', name: 'Customers', visibility: 'visible',
      columns: [{ column_id: 'c_1', index: 0, label: 'Company', address: 'A', header: headerCell }],
      rows: [row],
    }],
    accounting: evidenceAccountingFor([{
      sheet_id: 'sheet_1', name: 'Customers', visibility: 'visible',
      columns: [{ column_id: 'c_1', index: 0, label: 'Company', address: 'A', header: headerCell }],
      rows: [row],
    }]),
    warnings: [],
    provenance: { converter: 'fixture', converter_version: '1', converted_at: '2026-08-28T00:00:00Z' },
    evidence_digest: '',
  };
  evidence.evidence_digest = computeEvidenceDigest(evidence);
  const interpretation = {
    schema: 'dealpilot.interpretation/v2',
    interpretation_id: 'int_1',
    import_job_id: 'imp_1',
    canonical_ref: 'sources/imports/imp_1/canonical.json',
    evidence_digest: evidence.evidence_digest,
    model: { provider: 'test', name: 'fixture', prompt_version: '1' },
    claims: [{
      claim_id: 'clm_1', subject: { candidate_id: 'cand_1', kind: 'customer', label: 'Acme' },
      predicate: 'identity.title', value: 'Acme', value_type: 'string', status: 'observed', confidence: 1,
      evidence_refs: [{ observation_id: cell.observation_id, location: 'Customers!A2' }], rationale: 'Cell states the company name.',
    }],
    coverage: [
      { observation_id: headerCell.observation_id, handling: 'ignored', reason: 'Column label is retained as structural context; it is not a standalone business claim.' },
      { observation_id: cell.observation_id, handling: 'mapped', claim_ids: ['clm_1'] },
    ],
    unresolved: [], conflicts: [], created_at: '2026-08-28T00:00:00Z',
  };
  return { evidence, interpretation, observationId: cell.observation_id };
}

test('interpretation validates evidence-bound claims and complete coverage', () => {
  const { evidence, interpretation, observationId } = fixture();
  validateEvidenceDocument(evidence);
  validateInterpretationAgainstEvidence(interpretation, evidence);

  const missingCoverage = structuredClone(interpretation);
  missingCoverage.coverage = [];
  assert.throws(
    () => validateInterpretationDocument(missingCoverage, { evidence }),
    (error) => error.code === 'MISSING_OBSERVATION_COVERAGE' && error.path === '$.coverage',
  );

  const mismatched = structuredClone(interpretation);
  mismatched.coverage[1].claim_ids = [];
  assert.throws(
    () => validateInterpretationDocument(mismatched, { evidence }),
    (error) => error.code === 'TOO_FEW_ITEMS',
  );

  const unknown = structuredClone(interpretation);
  unknown.coverage[1].observation_id = `${observationId}-unknown`;
  assert.throws(
    () => validateInterpretationDocument(unknown, { evidence }),
    (error) => ['UNKNOWN_OBSERVATION_REFERENCE', 'MISSING_OBSERVATION_COVERAGE'].includes(error.code),
  );
});

test('change-set rejects untyped or semantically unsafe writes and exposes preview detail', () => {
  const { evidence, interpretation, observationId } = fixture();
  const changeSet = {
    schema: 'dealpilot.change-set/v2', change_set_id: 'chg_1', workspace_revision: 'rev_1',
    evidence_digest: evidence.evidence_digest, interpretation_id: interpretation.interpretation_id,
    operations: [{
      op_id: 'op_1', entity_type: 'customer', operation: 'create',
      target: { candidate_id: 'cand_1', identity: { title: 'Acme' } },
      field_changes: [{ path: 'profile.title', after: 'Acme', value_status: 'observed', claim_ids: ['clm_1'], evidence_refs: [observationId] }],
      preserve_claim_refs: [], conflicts: [], risk: 'low',
    }],
    accounting: { source_rows: 1, mapped_observations: 1, unresolved_observations: 0, ignored_observations: 1 },
  };
  validateChangeSetAgainstInterpretation(changeSet, interpretation, { evidence });
  const preview = buildChangeSetPreview(changeSet, { interpretation, evidence });
  assert.equal(preview.totals.operations, 1);
  assert.equal(preview.totals.create, 1);
  assert.equal(preview.operations[0].field_changes[0].evidence_refs[0], observationId);

  const stringTarget = structuredClone(changeSet);
  stringTarget.operations[0].target = 'knowledge/customers/acme.md';
  assert.throws(() => validateChangeSetDocument(stringTarget), (error) => error.code === 'TARGET_MUST_BE_OBJECT');

  const notesTarget = structuredClone(changeSet);
  notesTarget.operations[0].field_changes[0].path = 'notes.summary';
  assert.throws(() => validateChangeSetDocument(notesTarget), (error) => error.code === 'BUSINESS_NOTES_FIELD');

  const noEvidence = structuredClone(changeSet);
  noEvidence.operations[0].field_changes[0].evidence_refs = [];
  assert.throws(() => validateChangeSetDocument(noEvidence), (error) => error.code === 'FACT_CHANGE_WITHOUT_EVIDENCE');
});

test('note is an explicit open-world entity while business namespaces stay typed', () => {
  const { evidence, interpretation, observationId } = fixture();
  const noteChangeSet = {
    schema: 'dealpilot.change-set/v2', change_set_id: 'chg_note_1', workspace_revision: 'rev_1',
    evidence_digest: evidence.evidence_digest, interpretation_id: interpretation.interpretation_id,
    operations: [{
      op_id: 'op_note_1', entity_type: 'note', operation: 'create',
      target: { candidate_id: 'cand_note_1', identity: { title: 'Unmapped context' } },
      field_changes: [{ path: 'body', after: 'A detail retained for later interpretation.', value_status: 'unknown', claim_ids: [], evidence_refs: [], rationale: 'The source does not map to a stable business field yet.' }],
      preserve_claim_refs: [], conflicts: [], risk: 'unknown',
    }],
    accounting: { source_rows: 1, mapped_observations: 1, unresolved_observations: 0, ignored_observations: 1 },
  };
  validateChangeSetAgainstInterpretation(noteChangeSet, interpretation, { evidence });
  assert.equal(buildChangeSetPreview(noteChangeSet, { interpretation, evidence }).operations[0].entity_type, 'note');

  const unsupported = structuredClone(noteChangeSet);
  unsupported.operations[0].operation = 'delete';
  assert.throws(() => validateChangeSetDocument(unsupported), (error) => error.code === 'UNSUPPORTED_VALUE');

  const misplaced = structuredClone(noteChangeSet);
  misplaced.operations[0].target.ref = 'knowledge/customers/context.md';
  assert.throws(() => validateChangeSetDocument(misplaced), (error) => error.code === 'TARGET_ENTITY_MISMATCH');
});

test('interpretations persist as validated append-only artifacts', async () => {
  const { evidence, interpretation } = fixture();
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'dealpilot-contracts-'));
  try {
    await saveInterpretation(workspace, interpretation, { evidence });
    const loaded = await loadInterpretation(workspace, interpretation.interpretation_id, { evidence });
    assert.equal(loaded.interpretation_id, interpretation.interpretation_id);
    assert.equal(JSON.parse(await readFile(path.join(workspace, 'storage', 'interpretations', 'int_1.json'), 'utf8')).evidence_digest, evidence.evidence_digest);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
