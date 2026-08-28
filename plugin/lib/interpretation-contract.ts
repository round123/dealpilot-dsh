import {
  ContractValidationError,
  expectArray,
  expectDigest,
  expectEnum,
  expectFiniteNumber,
  expectIsoDateTime,
  expectJsonValue,
  expectOptionalString,
  expectRecord,
  expectString,
  expectStringArray,
  failContract,
  hashJson,
  iterableToStringSet,
  type JsonValue,
} from './contract-utils.js';
import {
  computeEvidenceDigest,
  validateEvidenceDocument,
  type EvidenceDocument,
} from './evidence-contract.js';
import * as fs from 'node:fs/promises';
import { resolveArtifactForWrite, resolveRegularArtifact } from './artifact-store.js';

export { ContractValidationError } from './contract-utils.js';

export const INTERPRETATION_SCHEMA = 'dealpilot.interpretation/v2' as const;
export const CLAIM_STATUSES = [
  'observed',
  'inferred',
  'hypothesis',
  'unknown',
  'conflict',
  'retracted',
] as const;
export const COVERAGE_HANDLINGS = ['mapped', 'unresolved', 'ignored'] as const;

export type ClaimStatus = typeof CLAIM_STATUSES[number];
export type CoverageHandling = typeof COVERAGE_HANDLINGS[number];

export interface InterpretationModel {
  provider: string;
  name: string;
  prompt_version: string;
  extensions?: Record<string, JsonValue>;
}

export interface ClaimSubject {
  candidate_id: string;
  kind: string;
  label?: string;
  ref?: string;
  extensions?: Record<string, JsonValue>;
}

export interface ClaimEvidenceRef {
  observation_id: string;
  location?: string;
  source_id?: string;
  excerpt?: string;
  observation_hash?: string;
  extensions?: Record<string, JsonValue>;
}

export interface InterpretationClaim {
  claim_id: string;
  subject: ClaimSubject;
  predicate: string;
  value: JsonValue;
  value_type: string;
  status: ClaimStatus;
  confidence: number;
  evidence_refs: ClaimEvidenceRef[];
  rationale: string;
  supersedes_claim_ids?: string[];
  tags?: string[];
  extensions?: Record<string, JsonValue>;
}

export interface ObservationCoverage {
  observation_id: string;
  handling: CoverageHandling;
  claim_ids?: string[];
  reason?: string;
  extensions?: Record<string, JsonValue>;
}

export interface UnresolvedInterpretationItem {
  question: string;
  candidate_id?: string;
  observation_ids?: string[];
  extensions?: Record<string, JsonValue>;
}

export interface InterpretationConflict {
  conflict_id?: string;
  claim_ids?: string[];
  observation_ids?: string[];
  description?: string;
  reason?: string;
  status?: string;
  resolution?: JsonValue;
  extensions?: Record<string, JsonValue>;
}

export interface InterpretationDocument {
  schema: typeof INTERPRETATION_SCHEMA;
  interpretation_id: string;
  import_job_id: string;
  canonical_ref: string;
  evidence_digest: string;
  model: InterpretationModel;
  claims: InterpretationClaim[];
  coverage: ObservationCoverage[];
  unresolved: UnresolvedInterpretationItem[];
  conflicts: InterpretationConflict[];
  created_at: string;
  supersedes_interpretation_id?: string;
  extensions?: Record<string, JsonValue>;
}

export interface InterpretationValidationOptions {
  expectedEvidenceDigest?: string;
  /** JSON-style alias for callers that mirror the persisted field names. */
  expected_evidence_digest?: string;
  expectedObservationIds?: Iterable<string>;
  expected_observation_ids?: Iterable<string>;
  observationIds?: Iterable<string>;
  observation_ids?: Iterable<string>;
  evidence?: EvidenceDocument | unknown;
  allowCoverageOutsideEvidence?: boolean;
  allow_coverage_outside_evidence?: boolean;
}

/**
 * The validator keeps a small, read-only index of the evidence document.  An
 * observation id is not sufficient on its own: callers must not be able to
 * attach a real id to a fabricated cell location or hash.
 */
export interface EvidenceObservationInfo {
  observation_id: string;
  location: string;
  source_id: string;
  observation_hash: string;
  kind: 'header' | 'cell';
}

export function collectEvidenceObservationIndex(value: EvidenceDocument | unknown): Map<string, EvidenceObservationInfo> {
  validateEvidenceDocument(value);
  const document = value as EvidenceDocument;
  const result = new Map<string, EvidenceObservationInfo>();
  for (const sheet of document.sheets) {
    for (const column of sheet.columns) {
      const header = column.header;
      if (!header) continue;
      const observationId = expectString(header.observation_id, '$options.evidence.header.observation_id');
      result.set(observationId, {
        observation_id: observationId,
        location: `${sheet.name}!${column.address}1`,
        source_id: document.source.source_id,
        observation_hash: normalizedDigest(header.cell_hash, '$options.evidence.header.cell_hash'),
        kind: 'header',
      });
    }
    for (const row of sheet.rows) {
      for (const cell of row.cells) {
        const observationId = expectString(cell.observation_id, '$options.evidence.cell.observation_id');
        result.set(observationId, {
          observation_id: observationId,
          location: `${sheet.name}!${cell.address}`,
          source_id: document.source.source_id,
          observation_hash: normalizedDigest(cell.cell_hash, '$options.evidence.cell.cell_hash'),
          kind: 'cell',
        });
      }
    }
  }
  return result;
}

const FACTUAL_CLAIM_STATUSES = new Set<ClaimStatus>(['observed', 'inferred', 'hypothesis', 'conflict', 'retracted']);

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      failContract(
        'UNKNOWN_PROTOCOL_FIELD',
        `${path}.${key}`,
        'field is not part of interpretation/v2; place non-standard data under extensions',
        { field: key },
      );
    }
  }
}

function validateExtensions(value: unknown, path: string): void {
  if (value === undefined) return;
  const extensions = expectRecord(value, path);
  expectJsonValue(extensions, path);
}

function normalizedDigest(value: unknown, path: string): string {
  return expectDigest(value, path).toLowerCase();
}

function canonicalEvidenceRef(value: unknown, path: string): string {
  const ref = expectString(value, path).replaceAll('\\', '/');
  if (/^(?:[A-Za-z]:|\/|\\\\)/u.test(ref)
    || ref.split('/').some((segment) => !segment || segment === '.' || segment === '..')
    || !/^sources\/imports\/imp_[A-Za-z0-9_-]+\/canonical\.json$/u.test(ref)) {
    failContract('INVALID_CANONICAL_REF', path, 'expected the immutable canonical evidence ref for the import job');
  }
  return ref;
}

function validateModel(value: unknown, path: string): void {
  const model = expectRecord(value, path);
  rejectUnknownKeys(model, ['provider', 'name', 'prompt_version', 'extensions'], path);
  expectString(model.provider, `${path}.provider`);
  expectString(model.name, `${path}.name`);
  expectString(model.prompt_version, `${path}.prompt_version`);
  validateExtensions(model.extensions, `${path}.extensions`);
}

function validateSubject(value: unknown, path: string): void {
  const subject = expectRecord(value, path);
  rejectUnknownKeys(subject, ['candidate_id', 'kind', 'label', 'ref', 'extensions'], path);
  expectString(subject.candidate_id, `${path}.candidate_id`);
  // Subject kinds are intentionally open-ended. Adapters constrain entity types later.
  expectString(subject.kind, `${path}.kind`);
  expectOptionalString(subject.label, `${path}.label`);
  expectOptionalString(subject.ref, `${path}.ref`);
  validateExtensions(subject.extensions, `${path}.extensions`);
}

function validateEvidenceReference(
  value: unknown,
  path: string,
  evidenceIndex?: Map<string, EvidenceObservationInfo>,
  allowOutsideEvidence = false,
): string {
  const reference = expectRecord(value, path);
  rejectUnknownKeys(reference, ['observation_id', 'location', 'source_id', 'excerpt', 'observation_hash', 'extensions'], path);
  const observationId = expectString(reference.observation_id, `${path}.observation_id`);
  const location = expectOptionalString(reference.location, `${path}.location`);
  const sourceId = expectOptionalString(reference.source_id, `${path}.source_id`);
  const excerpt = expectOptionalString(reference.excerpt, `${path}.excerpt`);
  const observationHash = reference.observation_hash === undefined
    ? undefined
    : normalizedDigest(reference.observation_hash, `${path}.observation_hash`);

  const actual = evidenceIndex?.get(observationId);
  if (evidenceIndex && !actual && !allowOutsideEvidence) {
    failContract(
      'UNKNOWN_OBSERVATION_REFERENCE',
      `${path}.observation_id`,
      `observation ${observationId} does not exist in the supplied evidence`,
      { observation_id: observationId },
    );
  }
  // A persisted interpretation must remain readable before its evidence is
  // loaded (for example, to discover canonical_ref/import_job_id). Metadata is
  // verified whenever a source evidence index is supplied; without one it is
  // retained as authored material and the caller must perform the bound
  // validation before using the claim for a mutation.
  if (actual) {
    if (location !== undefined && location !== actual.location) {
      failContract(
        'EVIDENCE_LOCATION_MISMATCH',
        `${path}.location`,
        `location does not match observation ${observationId}`,
        { expected: actual.location, actual: location },
      );
    }
    if (sourceId !== undefined && sourceId !== actual.source_id) {
      failContract(
        'EVIDENCE_SOURCE_MISMATCH',
        `${path}.source_id`,
        `source_id does not match observation ${observationId}`,
        { expected: actual.source_id, actual: sourceId },
      );
    }
    if (observationHash !== undefined && observationHash !== actual.observation_hash) {
      failContract(
        'EVIDENCE_HASH_MISMATCH',
        `${path}.observation_hash`,
        `observation_hash does not match observation ${observationId}`,
        { expected: actual.observation_hash, actual: observationHash },
      );
    }
  }
  // Excerpts are deliberately not compared with raw/display values: a claim
  // may quote a normalized fragment.  The type/non-empty check above still
  // prevents an unstructured object from masquerading as a citation.
  void excerpt;
  validateExtensions(reference.extensions, `${path}.extensions`);
  return observationId;
}

function validateClaim(
  value: unknown,
  path: string,
  claimIds: Set<string>,
  referencedByObservation: Map<string, Set<string>>,
  evidenceIndex?: Map<string, EvidenceObservationInfo>,
  allowOutsideEvidence = false,
): void {
  const claim = expectRecord(value, path);
  rejectUnknownKeys(claim, [
    'claim_id', 'subject', 'predicate', 'value', 'value_type', 'status', 'confidence',
    'evidence_refs', 'rationale', 'supersedes_claim_ids', 'tags', 'extensions',
  ], path);
  const claimId = expectString(claim.claim_id, `${path}.claim_id`);
  if (claimIds.has(claimId)) failContract('DUPLICATE_CLAIM_ID', `${path}.claim_id`, `duplicate claim_id: ${claimId}`);
  claimIds.add(claimId);

  validateSubject(claim.subject, `${path}.subject`);
  expectString(claim.predicate, `${path}.predicate`);
  if (!hasOwn(claim, 'value')) failContract('MISSING_VALUE', `${path}.value`, 'claim value is required');
  expectJsonValue(claim.value, `${path}.value`);
  expectString(claim.value_type, `${path}.value_type`);
  const status = expectEnum(claim.status, CLAIM_STATUSES, `${path}.status`);
  const confidence = expectFiniteNumber(claim.confidence, `${path}.confidence`);
  if (confidence < 0 || confidence > 1) {
    failContract('CONFIDENCE_OUT_OF_RANGE', `${path}.confidence`, 'confidence must be between 0 and 1');
  }
  expectString(claim.rationale, `${path}.rationale`);

  const evidence = expectArray(claim.evidence_refs, `${path}.evidence_refs`);
  if (FACTUAL_CLAIM_STATUSES.has(status) && evidence.length === 0) {
    failContract(
      'FACTUAL_CLAIM_WITHOUT_EVIDENCE',
      `${path}.evidence_refs`,
      `${status} claims must cite at least one observation`,
    );
  }
  const seenEvidence = new Set<string>();
  for (let index = 0; index < evidence.length; index++) {
    const observationId = validateEvidenceReference(evidence[index], `${path}.evidence_refs[${index}]`, evidenceIndex, allowOutsideEvidence);
    if (seenEvidence.has(observationId)) {
      failContract(
        'DUPLICATE_EVIDENCE_REFERENCE',
        `${path}.evidence_refs[${index}].observation_id`,
        `claim ${claimId} cites observation ${observationId} more than once`,
      );
    }
    seenEvidence.add(observationId);
    const claims = referencedByObservation.get(observationId) ?? new Set<string>();
    claims.add(claimId);
    referencedByObservation.set(observationId, claims);
  }

  if (claim.supersedes_claim_ids !== undefined) {
    const superseded = expectStringArray(claim.supersedes_claim_ids, `${path}.supersedes_claim_ids`, { minItems: 1 });
    if (superseded.includes(claimId)) {
      failContract(
        'SELF_SUPERSEDING_CLAIM',
        `${path}.supersedes_claim_ids`,
        `claim ${claimId} cannot supersede itself`,
      );
    }
  }
  if (status === 'retracted' && (!Array.isArray(claim.supersedes_claim_ids) || claim.supersedes_claim_ids.length === 0)) {
    failContract(
      'RETRACTION_TARGET_REQUIRED',
      `${path}.supersedes_claim_ids`,
      'a retracted claim must identify the claim it replaces',
    );
  }
  if (claim.tags !== undefined) expectStringArray(claim.tags, `${path}.tags`);
  validateExtensions(claim.extensions, `${path}.extensions`);
}

function validateSupersessionGraph(claims: unknown[], claimIds: Set<string>): void {
  const edges = new Map<string, string[]>();
  for (let index = 0; index < claims.length; index++) {
    const claim = expectRecord(claims[index], `$.claims[${index}]`);
    const claimId = expectString(claim.claim_id, `$.claims[${index}].claim_id`);
    const superseded = claim.supersedes_claim_ids === undefined
      ? []
      : expectStringArray(claim.supersedes_claim_ids, `$.claims[${index}].supersedes_claim_ids`);
    // References to an earlier interpretation are legitimate.  Detect only
    // cycles wholly contained in this interpretation, where they indicate a
    // malformed rewrite history.
    edges.set(claimId, superseded.filter((id) => claimIds.has(id)));
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (claimId: string): void => {
    if (visiting.has(claimId)) {
      failContract('SUPERSESSION_CYCLE', '$.claims', `claim supersession cycle includes ${claimId}`);
    }
    if (visited.has(claimId)) return;
    visiting.add(claimId);
    for (const superseded of edges.get(claimId) ?? []) visit(superseded);
    visiting.delete(claimId);
    visited.add(claimId);
  };
  for (const claimId of claimIds) visit(claimId);
}

function validateCoverage(
  value: unknown,
  path: string,
  claimIds: Set<string>,
  referencedByObservation: Map<string, Set<string>>,
  expectedIds?: Set<string>,
  allowCoverageOutsideEvidence = false,
): { coverageIds: Set<string>; mappedClaims: Map<string, Set<string>>; handlingByObservation: Map<string, CoverageHandling> } {
  const coverage = expectArray(value, path);
  const coverageIds = new Set<string>();
  const mappedClaims = new Map<string, Set<string>>();
  const handlingByObservation = new Map<string, CoverageHandling>();

  for (let index = 0; index < coverage.length; index++) {
    const entryPath = `${path}[${index}]`;
    const entry = expectRecord(coverage[index], entryPath);
    rejectUnknownKeys(entry, ['observation_id', 'handling', 'claim_ids', 'reason', 'extensions'], entryPath);
    const observationId = expectString(entry.observation_id, `${entryPath}.observation_id`);
    if (coverageIds.has(observationId)) {
      failContract(
        'DUPLICATE_COVERAGE',
        `${entryPath}.observation_id`,
        `observation ${observationId} has more than one coverage decision`,
      );
    }
    coverageIds.add(observationId);
    if (expectedIds && !allowCoverageOutsideEvidence && !expectedIds.has(observationId)) {
      failContract(
        'UNKNOWN_OBSERVATION_REFERENCE',
        `${entryPath}.observation_id`,
        `observation ${observationId} does not exist in the supplied evidence`,
        { observation_id: observationId },
      );
    }
    const handling = expectEnum(entry.handling, COVERAGE_HANDLINGS, `${entryPath}.handling`);
    handlingByObservation.set(observationId, handling);

    if (handling === 'mapped') {
      const mapped = expectStringArray(entry.claim_ids, `${entryPath}.claim_ids`, { minItems: 1 });
      for (let claimIndex = 0; claimIndex < mapped.length; claimIndex++) {
        if (!claimIds.has(mapped[claimIndex])) {
          failContract(
            'UNKNOWN_CLAIM_REFERENCE',
            `${entryPath}.claim_ids[${claimIndex}]`,
            `claim ${mapped[claimIndex]} does not exist in this interpretation`,
          );
        }
      }
      for (let claimIndex = 0; claimIndex < mapped.length; claimIndex++) {
        if (!referencedByObservation.get(observationId)?.has(mapped[claimIndex])) {
          failContract(
            'COVERAGE_CLAIM_MISMATCH',
            `${entryPath}.claim_ids[${claimIndex}]`,
            `claim ${mapped[claimIndex]} does not cite observation ${observationId}`,
          );
        }
      }
      mappedClaims.set(observationId, new Set(mapped));
      if (entry.reason !== undefined) expectString(entry.reason, `${entryPath}.reason`);
    } else {
      expectString(entry.reason, `${entryPath}.reason`);
      if (entry.claim_ids !== undefined && expectArray(entry.claim_ids, `${entryPath}.claim_ids`).length > 0) {
        failContract(
          'NON_MAPPED_CLAIM_REFERENCE',
          `${entryPath}.claim_ids`,
          `${handling} coverage cannot map claims`,
        );
      }
    }
    validateExtensions(entry.extensions, `${entryPath}.extensions`);
  }
  return { coverageIds, mappedClaims, handlingByObservation };
}

function validateUnresolved(
  value: unknown,
  path: string,
  handlingByObservation: Map<string, CoverageHandling>,
): void {
  const unresolved = expectArray(value, path);
  for (let index = 0; index < unresolved.length; index++) {
    const itemPath = `${path}[${index}]`;
    const item = expectRecord(unresolved[index], itemPath);
    rejectUnknownKeys(item, ['question', 'candidate_id', 'observation_ids', 'extensions'], itemPath);
    expectString(item.question, `${itemPath}.question`);
    expectOptionalString(item.candidate_id, `${itemPath}.candidate_id`);
    if (item.observation_ids !== undefined) {
      const ids = expectStringArray(item.observation_ids, `${itemPath}.observation_ids`, { minItems: 1 });
      for (let observationIndex = 0; observationIndex < ids.length; observationIndex++) {
        const handling = handlingByObservation.get(ids[observationIndex]);
        if (handling !== 'unresolved') {
          failContract(
            'UNRESOLVED_COVERAGE_MISMATCH',
            `${itemPath}.observation_ids[${observationIndex}]`,
            `observation ${ids[observationIndex]} is not marked unresolved`,
          );
        }
      }
    }
    validateExtensions(item.extensions, `${itemPath}.extensions`);
  }
}

function validateConflicts(
  value: unknown,
  path: string,
  claimIds: Set<string>,
  handlingByObservation: Map<string, CoverageHandling>,
  referencedByObservation: Map<string, Set<string>>,
): void {
  const conflicts = expectArray(value, path);
  const conflictIds = new Set<string>();
  for (let index = 0; index < conflicts.length; index++) {
    const itemPath = `${path}[${index}]`;
    const conflict = expectRecord(conflicts[index], itemPath);
    rejectUnknownKeys(conflict, ['conflict_id', 'claim_ids', 'observation_ids', 'description', 'reason', 'status', 'resolution', 'extensions'], itemPath);
    if (conflict.conflict_id !== undefined) {
      const conflictId = expectString(conflict.conflict_id, `${itemPath}.conflict_id`);
      if (conflictIds.has(conflictId)) {
        failContract('DUPLICATE_CONFLICT_ID', `${itemPath}.conflict_id`, `duplicate conflict_id: ${conflictId}`);
      }
      conflictIds.add(conflictId);
    }
    const references = conflict.claim_ids === undefined
      ? []
      : expectStringArray(conflict.claim_ids, `${itemPath}.claim_ids`);
    for (let claimIndex = 0; claimIndex < references.length; claimIndex++) {
      if (!claimIds.has(references[claimIndex])) {
        failContract(
          'UNKNOWN_CLAIM_REFERENCE',
          `${itemPath}.claim_ids[${claimIndex}]`,
          `claim ${references[claimIndex]} does not exist in this interpretation`,
        );
      }
    }
    const observationReferences = conflict.observation_ids === undefined
      ? []
      : expectStringArray(conflict.observation_ids, `${itemPath}.observation_ids`);
    for (let observationIndex = 0; observationIndex < observationReferences.length; observationIndex++) {
      if (!handlingByObservation.has(observationReferences[observationIndex])) {
        failContract(
          'UNKNOWN_OBSERVATION_REFERENCE',
          `${itemPath}.observation_ids[${observationIndex}]`,
          `observation ${observationReferences[observationIndex]} has no coverage decision`,
        );
      }
    }
    // When a conflict names both claims and observations, retain the link
    // between the two sides.  Otherwise a fabricated conflict can mention a
    // valid claim and an unrelated valid observation while looking grounded.
    if (references.length > 0 && observationReferences.length > 0) {
      for (const observationId of observationReferences) {
        const citingClaims = referencedByObservation.get(observationId) ?? new Set<string>();
        if (!references.some((claimId) => citingClaims.has(claimId))) {
          failContract(
            'CONFLICT_REFERENCE_MISMATCH',
            `${itemPath}.observation_ids`,
            `conflict observations do not support any cited claim for ${observationId}`,
            { observation_id: observationId },
          );
        }
      }
    }
    if (references.length === 0 && observationReferences.length === 0) {
      failContract('CONFLICT_REFERENCE_REQUIRED', itemPath, 'a conflict must cite a claim or observation');
    }
    const description = conflict.description ?? conflict.reason;
    expectString(description, `${itemPath}.description`);
    expectOptionalString(conflict.status, `${itemPath}.status`);
    if (conflict.resolution !== undefined) expectJsonValue(conflict.resolution, `${itemPath}.resolution`);
    validateExtensions(conflict.extensions, `${itemPath}.extensions`);
  }
}

function observationIdsFromEvidence(value: unknown): Set<string> {
  const index = collectEvidenceObservationIndex(value);
  return new Set(index.keys());
}

function expectedObservationIds(options: InterpretationValidationOptions): Set<string> | undefined {
  const expected = options.expectedObservationIds ?? options.expected_observation_ids;
  const observed = options.observationIds ?? options.observation_ids;
  if ((options.expectedObservationIds !== undefined && options.expected_observation_ids !== undefined)
    || (options.observationIds !== undefined && options.observation_ids !== undefined)) {
    failContract('AMBIGUOUS_VALIDATION_OPTIONS', '$options', 'duplicate camelCase and snake_case observation options');
  }
  if (expected !== undefined && observed !== undefined) {
    failContract(
      'AMBIGUOUS_VALIDATION_OPTIONS',
      '$options',
      'provide expectedObservationIds or observationIds, not both',
    );
  }
  if (options.evidence !== undefined) {
    if (expected !== undefined || observed !== undefined) {
      failContract(
        'AMBIGUOUS_VALIDATION_OPTIONS',
        '$options',
        'provide evidence or an observation id iterable, not both',
      );
    }
    return observationIdsFromEvidence(options.evidence);
  }
  const source = expected ?? observed;
  return source === undefined ? undefined : iterableToStringSet(source, '$options.expectedObservationIds');
}

function inspectInterpretation(value: unknown, options: InterpretationValidationOptions): InterpretationDocument {
  expectJsonValue(value, '$');
  const document = expectRecord(value, '$');
  if (document.schema !== INTERPRETATION_SCHEMA) {
    failContract(
      'INVALID_INTERPRETATION_SCHEMA',
      '$.schema',
      `expected ${INTERPRETATION_SCHEMA}`,
      { actual: document.schema },
    );
  }
  rejectUnknownKeys(document, [
    'schema', 'interpretation_id', 'import_job_id', 'canonical_ref', 'evidence_digest', 'model', 'claims',
    'coverage', 'unresolved', 'conflicts', 'created_at', 'supersedes_interpretation_id', 'extensions',
  ], '$');
  validateExtensions(document.extensions, '$.extensions');
  expectString(document.interpretation_id, '$.interpretation_id');
  const importJobId = expectString(document.import_job_id, '$.import_job_id');
  const canonicalRef = canonicalEvidenceRef(document.canonical_ref, '$.canonical_ref');
  if (canonicalRef !== `sources/imports/${importJobId}/canonical.json`) {
    failContract('IMPORT_JOB_CANONICAL_MISMATCH', '$.canonical_ref', 'canonical_ref does not belong to import_job_id');
  }
  const evidenceDigest = normalizedDigest(document.evidence_digest, '$.evidence_digest');
  validateModel(document.model, '$.model');
  const evidenceIndex = options.evidence === undefined ? undefined : collectEvidenceObservationIndex(options.evidence);
  const expectedIds = expectedObservationIds(options);
  const allowCoverageOutsideEvidence = options.allowCoverageOutsideEvidence ?? options.allow_coverage_outside_evidence ?? false;

  const claims = expectArray(document.claims, '$.claims');
  const claimIds = new Set<string>();
  const referencedByObservation = new Map<string, Set<string>>();
  for (let index = 0; index < claims.length; index++) {
    validateClaim(claims[index], `$.claims[${index}]`, claimIds, referencedByObservation, evidenceIndex, allowCoverageOutsideEvidence);
  }
  validateSupersessionGraph(claims, claimIds);

  const { coverageIds, mappedClaims, handlingByObservation } = validateCoverage(
    document.coverage,
    '$.coverage',
    claimIds,
    referencedByObservation,
    expectedIds,
    allowCoverageOutsideEvidence,
  );
  validateUnresolved(document.unresolved, '$.unresolved', handlingByObservation);
  validateConflicts(document.conflicts, '$.conflicts', claimIds, handlingByObservation, referencedByObservation);
  expectIsoDateTime(document.created_at, '$.created_at');
  expectOptionalString(document.supersedes_interpretation_id, '$.supersedes_interpretation_id');
  if (document.supersedes_interpretation_id === document.interpretation_id) {
    failContract(
      'SELF_SUPERSEDING_INTERPRETATION',
      '$.supersedes_interpretation_id',
      'an interpretation cannot supersede itself',
    );
  }

  for (const [observationId, references] of referencedByObservation) {
    if (expectedIds && !expectedIds.has(observationId) && !allowCoverageOutsideEvidence) {
      failContract(
        'UNKNOWN_OBSERVATION_REFERENCE',
        '$.claims',
        `observation ${observationId} does not exist in the supplied evidence`,
        { observation_id: observationId },
      );
    }
    const handling = handlingByObservation.get(observationId);
    if (handling !== 'mapped') {
      failContract(
        handling === undefined ? 'MISSING_OBSERVATION_COVERAGE' : 'EVIDENCE_COVERAGE_MISMATCH',
        '$.coverage',
        handling === undefined
          ? `cited observation ${observationId} has no coverage decision`
          : `cited observation ${observationId} must have mapped coverage`,
        { observation_id: observationId, handling: handling ?? null },
      );
    }
    const mapped = mappedClaims.get(observationId)!;
    for (const claimId of references) {
      if (!mapped.has(claimId)) {
        failContract(
          'EVIDENCE_CLAIM_MAPPING_MISMATCH',
          '$.coverage',
          `coverage for observation ${observationId} does not include citing claim ${claimId}`,
        );
      }
    }
  }

  if (expectedIds) {
    for (const observationId of expectedIds) {
      if (!coverageIds.has(observationId)) {
        failContract(
          'MISSING_OBSERVATION_COVERAGE',
          '$.coverage',
          `observation ${observationId} has no coverage decision`,
          { observation_id: observationId },
        );
      }
    }
    if (!allowCoverageOutsideEvidence) {
      for (const observationId of coverageIds) {
        if (!expectedIds.has(observationId)) {
          failContract(
            'UNKNOWN_OBSERVATION_REFERENCE',
            '$.coverage',
            `observation ${observationId} does not exist in the supplied evidence`,
            { observation_id: observationId },
          );
        }
      }
    }
  }

  if (options.expectedEvidenceDigest !== undefined && options.expected_evidence_digest !== undefined) {
    failContract('AMBIGUOUS_VALIDATION_OPTIONS', '$options', 'duplicate camelCase and snake_case evidence digest options');
  }
  let expectedDigestValue = options.expectedEvidenceDigest ?? options.expected_evidence_digest;
  if (options.evidence !== undefined) {
    validateEvidenceDocument(options.evidence);
    const evidenceHash = computeEvidenceDigest(options.evidence);
    if (expectedDigestValue !== undefined && normalizedDigest(expectedDigestValue, '$options.expectedEvidenceDigest') !== evidenceHash) {
      failContract(
        'EVIDENCE_VALIDATION_OPTION_MISMATCH',
        '$options.expectedEvidenceDigest',
        'expectedEvidenceDigest does not match the supplied evidence document',
      );
    }
    expectedDigestValue = evidenceHash;
  }
  if (expectedDigestValue !== undefined) {
    const expectedDigest = normalizedDigest(expectedDigestValue, '$options.expectedEvidenceDigest');
    if (evidenceDigest !== expectedDigest) {
      failContract(
        'EVIDENCE_DIGEST_MISMATCH',
        '$.evidence_digest',
        'interpretation evidence_digest does not match the current evidence',
        { expected: expectedDigest, actual: evidenceDigest },
      );
    }
  }

  return value as InterpretationDocument;
}

export function validateInterpretationDocument(
  value: unknown,
  options: InterpretationValidationOptions = {},
): asserts value is InterpretationDocument {
  inspectInterpretation(value, options);
}

export function validateInterpretation(
  value: unknown,
  options: InterpretationValidationOptions = {},
): asserts value is InterpretationDocument {
  inspectInterpretation(value, options);
}

export function parseInterpretationDocument(
  value: unknown,
  options: InterpretationValidationOptions = {},
): InterpretationDocument {
  return inspectInterpretation(value, options);
}

export function computeInterpretationHash(value: unknown): string {
  inspectInterpretation(value, {});
  return hashJson(value);
}

export const hashInterpretation = computeInterpretationHash;
export const computeInterpretationDigest = computeInterpretationHash;
export const interpretationDigest = computeInterpretationHash;

export function verifyInterpretationHash(value: unknown, expectedHash: string): void {
  const expected = normalizedDigest(expectedHash, '$expectedHash');
  const actual = computeInterpretationHash(value);
  if (actual !== expected) {
    failContract('INTERPRETATION_HASH_MISMATCH', '$', 'interpretation hash does not match', { expected, actual });
  }
}

export function collectInterpretationObservationIds(value: unknown): Set<string> {
  const document = inspectInterpretation(value, {});
  return new Set(document.coverage.map((entry) => entry.observation_id));
}

export function interpretationCoverageAccounting(value: unknown): {
  total: number;
  mapped: number;
  unresolved: number;
  ignored: number;
} {
  const document = inspectInterpretation(value, {});
  const result = { total: document.coverage.length, mapped: 0, unresolved: 0, ignored: 0 };
  for (const entry of document.coverage) result[entry.handling]++;
  return result;
}

function interpretationRef(interpretationId: string): string {
  if (!/^int_[A-Za-z0-9_-]+$/u.test(interpretationId)) {
    failContract('INVALID_INTERPRETATION_ID', '$interpretation_id', 'interpretation id has an unsafe format');
  }
  return `storage/interpretations/${interpretationId}.json`;
}

/** Persist an interpretation after validating its complete evidence/coverage contract. */
export async function saveInterpretation(
  workspace: string,
  value: InterpretationDocument | unknown,
  options: InterpretationValidationOptions = {},
): Promise<InterpretationDocument> {
  const document = parseInterpretationDocument(value, options);
  const destination = await resolveArtifactForWrite(
    workspace,
    interpretationRef(document.interpretation_id),
    'Interpretation artifact',
  );
  const serialized = `${JSON.stringify(document, null, 2)}\n`;
  try {
    await fs.writeFile(destination, serialized, { encoding: 'utf8', flag: 'wx' });
  } catch (error: any) {
    if (error?.code !== 'EEXIST') throw error;
    const existing = await loadInterpretation(workspace, document.interpretation_id, options);
    if (computeInterpretationHash(existing) !== computeInterpretationHash(document)) {
      failContract(
        'IMMUTABLE_ARTIFACT',
        '$.interpretation_id',
        `interpretation ${document.interpretation_id} already exists with different content`,
      );
    }
    return existing;
  }
  return document;
}

export const saveInterpretationDocument = saveInterpretation;

export async function loadInterpretation(
  workspace: string,
  interpretationId: string,
  options: InterpretationValidationOptions = {},
): Promise<InterpretationDocument> {
  const source = await resolveRegularArtifact(
    workspace,
    interpretationRef(interpretationId),
    'Interpretation artifact',
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(source, 'utf8'));
  } catch (error: any) {
    if (error?.code === 'ENOENT') throw new Error(`Interpretation 不存在：${interpretationId}`);
    throw error;
  }
  const document = parseInterpretationDocument(parsed, options);
  if (document.interpretation_id !== interpretationId) {
    failContract('INTERPRETATION_ID_MISMATCH', '$.interpretation_id', 'stored interpretation id does not match requested id');
  }
  return document;
}

export const loadInterpretationDocument = loadInterpretation;

export function isInterpretationDocument(value: unknown): value is InterpretationDocument {
  try {
    inspectInterpretation(value, {});
    return true;
  } catch {
    return false;
  }
}

/** Validate an interpretation against the exact evidence revision it cites. */
export function validateInterpretationAgainstEvidence(
  value: unknown,
  evidence: EvidenceDocument | unknown,
): asserts value is InterpretationDocument {
  validateEvidenceDocument(evidence);
  validateInterpretationDocument(value, {
    evidence,
    expectedEvidenceDigest: computeEvidenceDigest(evidence),
  });
}
