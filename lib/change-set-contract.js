import { expectArray, expectDigest, expectEnum, expectIsoDateTime, expectJsonValue, expectNonNegativeInteger, expectOptionalString, expectRecord, expectString, expectStringArray, failContract, hashJson, isRecord, isSha256Digest, stableStringify, } from './contract-utils.js';
import * as fs from 'node:fs/promises';
import { resolveArtifactForWrite, resolveRegularArtifact } from './artifact-store.js';
import { CLAIM_STATUSES, collectEvidenceObservationIndex, validateInterpretationDocument, } from './interpretation-contract.js';
import { validateEvidenceDocument, } from './evidence-contract.js';
import { ENTITY_ADAPTERS } from './entity-adapters.js';
export { ContractValidationError } from './contract-utils.js';
export const CHANGE_SET_SCHEMA = 'dealpilot.change-set/v2';
export const CHANGE_SET_ENTITY_TYPES = [
    'customer',
    'contact',
    'deal',
    'action',
    'relationship',
    'note',
    'evidence',
];
/** Operations implemented by the typed mutation adapters. */
export const CHANGE_SET_OPERATIONS = [
    'create',
    'update',
    'append',
    'archive',
    'link',
];
export const ENTITY_OPERATION_MATRIX = Object.freeze(Object.fromEntries(Object.entries(ENTITY_ADAPTERS).map(([entity, adapter]) => [entity, Object.freeze([...adapter.operations])])));
export const CHANGE_SET_RISKS = ['low', 'medium', 'high', 'critical', 'unknown'];
export const CHANGE_VALUE_STATUSES = CLAIM_STATUSES;
function hasOwn(value, key) {
    return Object.prototype.hasOwnProperty.call(value, key);
}
function rejectUnknownKeys(value, allowed, path) {
    const allowedSet = new Set(allowed);
    for (const key of Object.keys(value)) {
        if (!allowedSet.has(key)) {
            failContract('UNKNOWN_PROTOCOL_FIELD', `${path}.${key}`, `field is not part of change-set/v2; represent it as a typed field_change or explicit note`, { field: key });
        }
    }
}
function validateExtensions(value, path) {
    if (value === undefined)
        return;
    const extensions = expectRecord(value, path);
    // Extensions are intentionally opaque to the protocol, but still must be
    // finite JSON so they cannot smuggle executable values or circular objects.
    expectJsonValue(extensions, path);
}
function digest(value, path) {
    return expectDigest(value, path).toLowerCase();
}
function normalizeRef(ref) {
    return ref.replaceAll('\\', '/');
}
function validateRef(ref, path) {
    const text = normalizeRef(expectString(ref, path));
    if (/^(?:[A-Za-z]:|\/|\\\\)/u.test(text))
        failContract('ABSOLUTE_TARGET_REF', path, 'target ref must be workspace-relative');
    const segments = text.split('/');
    if (segments.some((segment) => segment === '..' || segment.length === 0)) {
        failContract('UNSAFE_TARGET_REF', path, 'target ref contains an unsafe path segment');
    }
    return text;
}
function pluralEntity(entity) {
    if (entity === 'evidence')
        return 'evidence';
    if (entity === 'relationship')
        return 'relationships';
    return `${entity}s`;
}
function targetTitle(target) {
    const identityTitle = target.identity && typeof target.identity === 'object'
        ? target.identity.title
        : undefined;
    const value = target.title ?? target.label ?? identityTitle;
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
function validateTarget(value, path, entityType, operation) {
    if (!isRecord(value))
        failContract('TARGET_MUST_BE_OBJECT', path, 'target must be an object; string targets are not accepted');
    const target = value;
    rejectUnknownKeys(target, ['ref', 'entity_id', 'candidate_id', 'identity', 'base_revision', 'expected_revision', 'title', 'label', 'extensions'], path);
    for (const legacyKey of ['path', 'file', 'body', 'content', 'notes', 'metadata']) {
        if (hasOwn(target, legacyKey)) {
            failContract('UNKNOWN_PROTOCOL_FIELD', `${path}.${legacyKey}`, `${legacyKey} is not a typed target field`);
        }
    }
    const identityKeys = ['ref', 'entity_id', 'candidate_id', 'identity'].filter((key) => hasOwn(target, key));
    if (identityKeys.length === 0)
        failContract('TARGET_IDENTITY_REQUIRED', path, 'target needs ref, entity_id, candidate_id, or identity');
    if (target.ref !== undefined) {
        const ref = validateRef(target.ref, `${path}.ref`);
        const expectedDirectory = entityType === 'evidence' ? 'sources/evidence/' : `knowledge/${pluralEntity(entityType)}/`;
        if (!ref.startsWith(expectedDirectory)) {
            failContract('TARGET_ENTITY_MISMATCH', `${path}.ref`, `${entityType} target must resolve under ${expectedDirectory}`, { ref, entity_type: entityType });
        }
        if (!['note', 'evidence'].includes(entityType) && /(?:^|\/)notes(?:\/|$)/iu.test(ref)) {
            failContract('BUSINESS_NOTES_TARGET', `${path}.ref`, 'business entities cannot target the notes namespace');
        }
    }
    for (const key of ['entity_id', 'candidate_id', 'base_revision', 'expected_revision']) {
        if (target[key] !== undefined)
            expectString(target[key], `${path}.${key}`);
    }
    if (target.identity !== undefined) {
        const identity = expectRecord(target.identity, `${path}.identity`);
        if (Object.keys(identity).length === 0)
            failContract('EMPTY_TARGET_IDENTITY', `${path}.identity`, 'identity must contain at least one field');
        expectJsonValue(identity, `${path}.identity`);
    }
    validateExtensions(target.extensions, `${path}.extensions`);
    if (operation === 'create' && target.ref === undefined && ['customer', 'contact', 'deal', 'action', 'note'].includes(entityType) && !targetTitle(target)) {
        failContract('TARGET_TITLE_REQUIRED', path, `${entityType} create requires title, label, or identity.title when ref is omitted`);
    }
    return target;
}
function targetKey(entityType, target) {
    if (target.ref)
        return `${entityType}:ref:${normalizeRef(String(target.ref))}`;
    if (target.entity_id)
        return `${entityType}:entity:${target.entity_id}`;
    if (target.candidate_id)
        return `${entityType}:candidate:${target.candidate_id}`;
    return `${entityType}:identity:${stableStringify(target.identity ?? target)}`;
}
function normalizedLocation(value) {
    return value.trim();
}
function validateEvidenceRef(value, path, evidenceIds, evidenceIndex) {
    if (typeof value === 'string') {
        const observationId = expectString(value, path);
        if (evidenceIds && !evidenceIds.has(observationId)) {
            failContract('UNKNOWN_OBSERVATION_REFERENCE', path, `unknown observation: ${observationId}`);
        }
        return observationId;
    }
    const reference = expectRecord(value, path);
    rejectUnknownKeys(reference, ['observation_id', 'location', 'source_id', 'observation_hash', 'extensions'], path);
    const observationId = expectString(reference.observation_id, `${path}.observation_id`);
    const location = expectOptionalString(reference.location, `${path}.location`);
    const sourceId = expectOptionalString(reference.source_id, `${path}.source_id`);
    const observationHash = reference.observation_hash === undefined
        ? undefined
        : digest(reference.observation_hash, `${path}.observation_hash`);
    validateExtensions(reference.extensions, `${path}.extensions`);
    if (evidenceIds && !evidenceIds.has(observationId)) {
        failContract('UNKNOWN_OBSERVATION_REFERENCE', `${path}.observation_id`, `unknown observation: ${observationId}`);
    }
    const actual = evidenceIndex?.get(observationId);
    if (evidenceIndex && !actual && !evidenceIds) {
        failContract('UNKNOWN_OBSERVATION_REFERENCE', `${path}.observation_id`, `unknown observation: ${observationId}`);
    }
    if (!actual && (location !== undefined || sourceId !== undefined || observationHash !== undefined)) {
        failContract('UNVERIFIED_EVIDENCE_REFERENCE', path, `metadata for observation ${observationId} cannot be verified without the source evidence document`);
    }
    if (actual) {
        if (location !== undefined && actual.location !== undefined && normalizedLocation(location) !== actual.location) {
            failContract('EVIDENCE_LOCATION_MISMATCH', `${path}.location`, `location does not match observation ${observationId}`, { expected: actual.location, actual: location });
        }
        if (sourceId !== undefined && actual.source_id !== undefined && sourceId !== actual.source_id) {
            failContract('EVIDENCE_SOURCE_MISMATCH', `${path}.source_id`, `source_id does not match observation ${observationId}`, { expected: actual.source_id, actual: sourceId });
        }
        if (observationHash !== undefined && actual.observation_hash !== undefined && observationHash !== actual.observation_hash) {
            failContract('EVIDENCE_HASH_MISMATCH', `${path}.observation_hash`, `observation_hash does not match observation ${observationId}`, { expected: actual.observation_hash, actual: observationHash });
        }
    }
    return observationId;
}
function validateConflict(value, path) {
    const conflict = expectRecord(value, path);
    rejectUnknownKeys(conflict, ['claim_ids', 'observation_ids', 'description', 'resolution', 'extensions'], path);
    const claimIds = conflict.claim_ids === undefined ? [] : expectStringArray(conflict.claim_ids, `${path}.claim_ids`);
    const observationIds = conflict.observation_ids === undefined ? [] : expectStringArray(conflict.observation_ids, `${path}.observation_ids`);
    expectString(conflict.description, `${path}.description`);
    if (conflict.resolution !== undefined)
        expectJsonValue(conflict.resolution, `${path}.resolution`);
    validateExtensions(conflict.extensions, `${path}.extensions`);
    if (claimIds.length === 0 && observationIds.length === 0) {
        failContract('CONFLICT_REFERENCE_REQUIRED', path, 'a conflict must cite a claim or observation');
    }
    return { claimIds, observationIds };
}
function validateUnmapped(value, path, evidenceIds, coverageHandling) {
    const item = expectRecord(value, path);
    rejectUnknownKeys(item, ['path', 'observation_ids', 'reason', 'extensions'], path);
    if (item.path !== undefined)
        expectString(item.path, `${path}.path`);
    const observationIds = item.observation_ids === undefined ? [] : expectStringArray(item.observation_ids, `${path}.observation_ids`);
    expectString(item.reason, `${path}.reason`);
    validateExtensions(item.extensions, `${path}.extensions`);
    if (evidenceIds) {
        for (let index = 0; index < observationIds.length; index++) {
            if (!evidenceIds.has(observationIds[index])) {
                failContract('UNKNOWN_OBSERVATION_REFERENCE', `${path}.observation_ids[${index}]`, `unknown observation: ${observationIds[index]}`);
            }
        }
    }
    for (let index = 0; index < observationIds.length; index++) {
        if (coverageHandling?.get(observationIds[index]) === 'mapped') {
            failContract('UNMAPPED_COVERAGE_MISMATCH', `${path}.observation_ids[${index}]`, `observation ${observationIds[index]} is mapped in the interpretation`);
        }
    }
}
function claimIndex(interpretation) {
    validateInterpretationDocument(interpretation);
    const result = new Map();
    for (const claim of interpretation.claims)
        result.set(claim.claim_id, claim);
    return result;
}
function interpretationCitationIndex(interpretation) {
    const result = new Map();
    for (const claim of interpretation.claims) {
        for (const reference of claim.evidence_refs) {
            const existing = result.get(reference.observation_id);
            const next = {
                observation_id: reference.observation_id,
                ...(reference.location !== undefined ? { location: reference.location } : {}),
                ...(reference.source_id !== undefined ? { source_id: reference.source_id } : {}),
                ...(reference.observation_hash !== undefined ? { observation_hash: reference.observation_hash.toLowerCase().replace(/^sha256:/u, '') } : {}),
            };
            if (existing) {
                for (const key of ['location', 'source_id', 'observation_hash']) {
                    const before = existing[key];
                    const after = next[key];
                    if (before !== undefined && after !== undefined && before !== after) {
                        failContract('CONFLICTING_EVIDENCE_METADATA', `$.interpretation.claims`, `observation ${reference.observation_id} has conflicting ${key} metadata`);
                    }
                }
                result.set(reference.observation_id, { ...existing, ...next });
            }
            else {
                result.set(reference.observation_id, next);
            }
        }
    }
    return result;
}
function validateFieldChange(value, path, entityType, operation, claims, evidenceIds, evidenceIndex, coverageHandling) {
    const field = expectRecord(value, path);
    rejectUnknownKeys(field, ['path', 'before', 'after', 'value_status', 'claim_ids', 'evidence_refs', 'rationale', 'extensions'], path);
    validateExtensions(field.extensions, `${path}.extensions`);
    const fieldPath = expectString(field.path, `${path}.path`);
    if (fieldPath.split('.').some((segment) => segment === '..' || segment.length === 0)) {
        failContract('UNSAFE_FIELD_PATH', `${path}.path`, 'field path contains an unsafe segment');
    }
    if (!['evidence', 'note'].includes(entityType) && /^(?:notes?|body|content)(?:\.|$)/iu.test(fieldPath)) {
        failContract('BUSINESS_NOTES_FIELD', `${path}.path`, 'business entity fields cannot write the notes/body/content namespace');
    }
    const status = expectEnum(field.value_status, CHANGE_VALUE_STATUSES, `${path}.value_status`);
    if (!hasOwn(field, 'after') && operation !== 'archive') {
        failContract('MISSING_AFTER_VALUE', `${path}.after`, `field change for ${operation} requires an after value`);
    }
    if (field.before !== undefined)
        expectJsonValue(field.before, `${path}.before`);
    if (field.after !== undefined)
        expectJsonValue(field.after, `${path}.after`);
    const claimIds = expectStringArray(field.claim_ids, `${path}.claim_ids`);
    const evidenceRefs = expectArray(field.evidence_refs, `${path}.evidence_refs`);
    const referencedEvidenceIds = [];
    const seenEvidence = new Set();
    for (let index = 0; index < evidenceRefs.length; index++) {
        const observationId = validateEvidenceRef(evidenceRefs[index], `${path}.evidence_refs[${index}]`, evidenceIds, evidenceIndex);
        if (seenEvidence.has(observationId))
            failContract('DUPLICATE_EVIDENCE_REFERENCE', `${path}.evidence_refs[${index}]`, `duplicate observation: ${observationId}`);
        seenEvidence.add(observationId);
        referencedEvidenceIds.push(observationId);
        if (evidenceIds && !evidenceIds.has(observationId)) {
            failContract('UNKNOWN_OBSERVATION_REFERENCE', `${path}.evidence_refs[${index}]`, `unknown observation: ${observationId}`);
        }
        const handling = coverageHandling?.get(observationId);
        if (handling && handling !== 'mapped' && !['note', 'evidence'].includes(entityType)) {
            failContract('OBSERVATION_NOT_MAPPED', `${path}.evidence_refs[${index}]`, `business field cannot be sourced from ${handling} observation ${observationId}`, { observation_id: observationId, handling });
        }
    }
    if (['observed', 'inferred', 'hypothesis', 'conflict', 'retracted'].includes(status)) {
        if (claimIds.length === 0)
            failContract('FACT_CHANGE_WITHOUT_CLAIM', `${path}.claim_ids`, `${status} changes must cite a claim`);
        if (referencedEvidenceIds.length === 0)
            failContract('FACT_CHANGE_WITHOUT_EVIDENCE', `${path}.evidence_refs`, `${status} changes must cite an observation`);
    }
    else if (claimIds.length === 0 && referencedEvidenceIds.length === 0) {
        expectString(field.rationale, `${path}.rationale`);
        if (!['note', 'evidence'].includes(entityType)) {
            failContract('BUSINESS_CHANGE_WITHOUT_EVIDENCE', path, 'business field changes must cite a claim or observation; use an explicit note for unmapped material');
        }
    }
    if (status === 'unknown' && !['note', 'evidence'].includes(entityType) && field.after !== undefined && field.after !== null) {
        failContract('UNKNOWN_BUSINESS_VALUE', `${path}.after`, 'unknown business values must remain absent/null; retain the uncertainty as a claim or note');
    }
    if (field.rationale !== undefined)
        expectString(field.rationale, `${path}.rationale`);
    if (claims) {
        const interpretationEvidence = new Map();
        for (const claimId of claimIds) {
            const claim = claims.get(claimId);
            if (!claim)
                failContract('UNKNOWN_CLAIM_REFERENCE', `${path}.claim_ids`, `unknown claim: ${claimId}`);
            if (claim.status !== status && status !== 'retracted') {
                failContract('CLAIM_STATUS_MISMATCH', `${path}.value_status`, `field status ${status} does not match claim ${claimId} status ${claim.status}`);
            }
            const refs = new Set(claim.evidence_refs.map((reference) => reference.observation_id));
            interpretationEvidence.set(claimId, refs);
        }
        for (const observationId of referencedEvidenceIds) {
            if (claimIds.length > 0 && !claimIds.some((claimId) => interpretationEvidence.get(claimId)?.has(observationId))) {
                failContract('EVIDENCE_CLAIM_MISMATCH', `${path}.evidence_refs`, `observation ${observationId} is not cited by the selected claims`);
            }
        }
    }
    return { claimIds, evidenceIds: referencedEvidenceIds, status };
}
function validateOperation(value, path, operationIds, targetKeys, options, claims, evidenceIds, evidenceIndex, coverageHandling) {
    const operation = expectRecord(value, path);
    rejectUnknownKeys(operation, [
        'op_id', 'entity_type', 'operation', 'target', 'field_changes', 'preserve_claim_refs',
        'conflicts', 'risk', 'base_revision', 'idempotency_key', 'rationale', 'unmapped', 'extensions',
    ], path);
    validateExtensions(operation.extensions, `${path}.extensions`);
    const opId = expectString(operation.op_id, `${path}.op_id`);
    if (operationIds.has(opId))
        failContract('DUPLICATE_OPERATION_ID', `${path}.op_id`, `duplicate op_id: ${opId}`);
    operationIds.add(opId);
    const entityType = expectEnum(operation.entity_type, CHANGE_SET_ENTITY_TYPES, `${path}.entity_type`);
    const kind = expectEnum(operation.operation, CHANGE_SET_OPERATIONS, `${path}.operation`);
    if (!ENTITY_OPERATION_MATRIX[entityType].includes(kind)) {
        failContract('UNSUPPORTED_OPERATION_FOR_ENTITY', `${path}.operation`, `${entityType} does not support ${kind}`, { entity_type: entityType, operation: kind });
    }
    const target = validateTarget(operation.target, `${path}.target`, entityType, kind);
    const key = targetKey(entityType, target);
    if (targetKeys.has(key))
        failContract('DUPLICATE_OPERATION_TARGET', `${path}.target`, `target appears more than once: ${key}`);
    targetKeys.add(key);
    const operationRevision = operation.base_revision ?? target.base_revision ?? target.expected_revision;
    if (operationRevision !== undefined)
        expectString(operationRevision, `${path}.base_revision`);
    if (options.targetRevisions !== undefined && options.target_revisions !== undefined) {
        failContract('AMBIGUOUS_VALIDATION_OPTIONS', '$options', 'duplicate camelCase and snake_case target revision options');
    }
    const targetRevisions = options.targetRevisions ?? options.target_revisions;
    if (targetRevisions) {
        const lookupKeys = [target.ref, target.entity_id, target.candidate_id].filter((item) => typeof item === 'string');
        for (const lookup of lookupKeys) {
            const actual = targetRevisions[lookup];
            if (actual !== undefined && operationRevision !== undefined && actual !== operationRevision) {
                failContract('TARGET_REVISION_MISMATCH', `${path}.base_revision`, `target revision changed for ${lookup}`, { expected: operationRevision, actual });
            }
        }
    }
    const fieldChanges = expectArray(operation.field_changes, `${path}.field_changes`);
    const fieldPaths = new Set();
    for (let index = 0; index < fieldChanges.length; index++) {
        const field = expectRecord(fieldChanges[index], `${path}.field_changes[${index}]`);
        const fieldPath = expectString(field.path, `${path}.field_changes[${index}].path`);
        if (fieldPaths.has(fieldPath))
            failContract('DUPLICATE_FIELD_PATH', `${path}.field_changes[${index}].path`, `duplicate field path: ${fieldPath}`);
        fieldPaths.add(fieldPath);
        validateFieldChange(field, `${path}.field_changes[${index}]`, entityType, kind, claims, evidenceIds, evidenceIndex, coverageHandling);
    }
    const preserve = expectStringArray(operation.preserve_claim_refs, `${path}.preserve_claim_refs`);
    if (claims) {
        for (let index = 0; index < preserve.length; index++) {
            if (!claims.has(preserve[index]))
                failContract('UNKNOWN_CLAIM_REFERENCE', `${path}.preserve_claim_refs[${index}]`, `unknown claim: ${preserve[index]}`);
        }
    }
    const conflicts = expectArray(operation.conflicts, `${path}.conflicts`);
    for (let index = 0; index < conflicts.length; index++) {
        const refs = validateConflict(conflicts[index], `${path}.conflicts[${index}]`);
        if (claims) {
            for (let claimIndex = 0; claimIndex < refs.claimIds.length; claimIndex++) {
                if (!claims.has(refs.claimIds[claimIndex]))
                    failContract('UNKNOWN_CLAIM_REFERENCE', `${path}.conflicts[${index}].claim_ids[${claimIndex}]`, `unknown claim: ${refs.claimIds[claimIndex]}`);
            }
        }
        if (evidenceIds) {
            for (let observationIndex = 0; observationIndex < refs.observationIds.length; observationIndex++) {
                if (!evidenceIds.has(refs.observationIds[observationIndex]))
                    failContract('UNKNOWN_OBSERVATION_REFERENCE', `${path}.conflicts[${index}].observation_ids[${observationIndex}]`, `unknown observation: ${refs.observationIds[observationIndex]}`);
            }
        }
        for (let observationIndex = 0; observationIndex < refs.observationIds.length; observationIndex++) {
            if (coverageHandling?.get(refs.observationIds[observationIndex]) === 'ignored') {
                failContract('CONFLICT_COVERAGE_MISMATCH', `${path}.conflicts[${index}].observation_ids[${observationIndex}]`, `ignored observation cannot ground a conflict`);
            }
        }
    }
    const risk = expectEnum(operation.risk, CHANGE_SET_RISKS, `${path}.risk`);
    expectOptionalString(operation.rationale, `${path}.rationale`);
    if (operation.idempotency_key !== undefined)
        expectString(operation.idempotency_key, `${path}.idempotency_key`);
    if (operation.unmapped !== undefined) {
        const unmapped = expectArray(operation.unmapped, `${path}.unmapped`);
        for (let index = 0; index < unmapped.length; index++)
            validateUnmapped(unmapped[index], `${path}.unmapped[${index}]`, evidenceIds, coverageHandling);
    }
    if (kind === 'create' && !['note', 'evidence'].includes(entityType) && fieldChanges.length === 0) {
        failContract('EMPTY_CREATE_OPERATION', `${path}.field_changes`, `${entityType} create must describe at least one field change`);
    }
    if (kind === 'create' && !['note', 'evidence'].includes(entityType)
        && fieldChanges.every((field) => expectStringArray(field.claim_ids, 'field.claim_ids').length === 0
            && expectArray(field.evidence_refs, 'field.evidence_refs').length === 0)) {
        failContract('BUSINESS_CREATE_WITHOUT_EVIDENCE', path, `${entityType} create must cite a claim or observation`);
    }
    return operation;
}
function inspectChangeSet(value, options) {
    expectJsonValue(value, '$');
    const document = expectRecord(value, '$');
    if (document.schema !== CHANGE_SET_SCHEMA) {
        failContract('INVALID_CHANGE_SET_SCHEMA', '$.schema', `expected ${CHANGE_SET_SCHEMA}`, { actual: document.schema });
    }
    rejectUnknownKeys(document, [
        'schema', 'change_set_id', 'workspace_revision', 'evidence_digest', 'interpretation_id',
        'operations', 'accounting', 'change_set_hash', 'plan_hash', 'created_at', 'extensions',
    ], '$');
    validateExtensions(document.extensions, '$.extensions');
    expectString(document.change_set_id, '$.change_set_id');
    const workspaceRevision = expectString(document.workspace_revision, '$.workspace_revision');
    const evidenceDigest = digest(document.evidence_digest, '$.evidence_digest');
    const interpretationId = expectString(document.interpretation_id, '$.interpretation_id');
    if (options.currentWorkspaceRevision !== undefined && options.current_workspace_revision !== undefined) {
        failContract('AMBIGUOUS_VALIDATION_OPTIONS', '$options', 'duplicate camelCase and snake_case workspace revision options');
    }
    const currentWorkspaceRevision = options.currentWorkspaceRevision ?? options.current_workspace_revision;
    if (currentWorkspaceRevision !== undefined && workspaceRevision !== currentWorkspaceRevision) {
        failContract('WORKSPACE_REVISION_MISMATCH', '$.workspace_revision', 'workspace revision changed since proposal creation', { expected: currentWorkspaceRevision, actual: workspaceRevision });
    }
    let claims;
    let evidenceIds;
    let evidenceIndex;
    let coverageHandling;
    const configuredEvidence = options.evidence ?? options.evidence_document;
    if (options.evidence !== undefined && options.evidence_document !== undefined) {
        failContract('AMBIGUOUS_VALIDATION_OPTIONS', '$options', 'provide evidence or evidence_document, not both');
    }
    if (configuredEvidence !== undefined) {
        validateEvidenceDocument(configuredEvidence);
        evidenceIndex = collectEvidenceObservationIndex(configuredEvidence);
        evidenceIds = new Set(evidenceIndex.keys());
        const suppliedEvidenceDigest = digest(configuredEvidence.evidence_digest, '$options.evidence.evidence_digest');
        if (suppliedEvidenceDigest !== evidenceDigest) {
            failContract('EVIDENCE_DIGEST_MISMATCH', '$.evidence_digest', 'change set evidence_digest does not match supplied evidence');
        }
    }
    if (options.evidenceObservationIds !== undefined && options.evidence_observation_ids !== undefined) {
        failContract('AMBIGUOUS_VALIDATION_OPTIONS', '$options', 'duplicate camelCase and snake_case observation options');
    }
    const evidenceObservationIds = options.evidenceObservationIds ?? options.evidence_observation_ids;
    if (evidenceObservationIds !== undefined) {
        if (configuredEvidence !== undefined)
            failContract('AMBIGUOUS_VALIDATION_OPTIONS', '$options', 'provide evidence or evidenceObservationIds, not both');
        evidenceIds = new Set();
        let index = 0;
        for (const item of evidenceObservationIds) {
            const id = expectString(item, `$options.evidenceObservationIds[${index}]`);
            if (evidenceIds.has(id))
                failContract('DUPLICATE_OBSERVATION_ID', `$options.evidenceObservationIds[${index}]`, `duplicate observation: ${id}`);
            evidenceIds.add(id);
            index++;
        }
    }
    if (options.interpretation !== undefined) {
        validateInterpretationDocument(options.interpretation, configuredEvidence !== undefined ? { evidence: configuredEvidence } : {});
        const interpretation = options.interpretation;
        if (interpretation.interpretation_id !== interpretationId)
            failContract('INTERPRETATION_ID_MISMATCH', '$.interpretation_id', 'change set references a different interpretation');
        if (interpretation.evidence_digest.toLowerCase() !== evidenceDigest)
            failContract('EVIDENCE_DIGEST_MISMATCH', '$.evidence_digest', 'change set evidence digest differs from interpretation');
        claims = claimIndex(interpretation);
        coverageHandling = new Map(interpretation.coverage.map((entry) => [entry.observation_id, entry.handling]));
        if (!evidenceIndex)
            evidenceIndex = interpretationCitationIndex(interpretation);
        if (!evidenceIds) {
            // Without the full evidence document, the interpretation still defines
            // the set of observations it processed.  This is a conservative
            // fallback for callers that only have persisted L2 artifacts.
            evidenceIds = new Set(interpretation.coverage.map((entry) => entry.observation_id));
        }
        else if (evidenceObservationIds !== undefined) {
            const coverageIds = new Set(interpretation.coverage.map((entry) => entry.observation_id));
            for (const observationId of evidenceIds) {
                if (!coverageIds.has(observationId)) {
                    failContract('MISSING_OBSERVATION_COVERAGE', '$options.evidenceObservationIds', `interpretation has no coverage for ${observationId}`);
                }
            }
            for (const observationId of coverageIds) {
                if (!evidenceIds.has(observationId)) {
                    failContract('UNKNOWN_OBSERVATION_REFERENCE', '$.interpretation.coverage', `interpretation coverage references unknown observation ${observationId}`);
                }
            }
        }
    }
    const operations = expectArray(document.operations, '$.operations');
    if (operations.length === 0)
        failContract('EMPTY_CHANGE_SET', '$.operations', 'change set must contain at least one operation');
    const operationIds = new Set();
    const targetKeys = new Set();
    for (let index = 0; index < operations.length; index++) {
        validateOperation(operations[index], `$.operations[${index}]`, operationIds, targetKeys, options, claims, evidenceIds, evidenceIndex, coverageHandling);
    }
    const accounting = expectRecord(document.accounting, '$.accounting');
    rejectUnknownKeys(accounting, ['source_rows', 'mapped_observations', 'unresolved_observations', 'ignored_observations'], '$.accounting');
    for (const key of ['source_rows', 'mapped_observations', 'unresolved_observations', 'ignored_observations']) {
        expectNonNegativeInteger(accounting[key], `$.accounting.${key}`);
    }
    if (configuredEvidence !== undefined) {
        const expectedRows = configuredEvidence.sheets.reduce((total, sheet) => total + sheet.rows.length, 0);
        if (accounting.source_rows !== expectedRows) {
            failContract('ACCOUNTING_MISMATCH', '$.accounting.source_rows', `expected ${expectedRows} source rows from evidence, got ${accounting.source_rows}`);
        }
    }
    if (claims) {
        const coverageAccounting = options.interpretation.coverage.reduce((result, entry) => {
            result[entry.handling]++;
            return result;
        }, { mapped: 0, unresolved: 0, ignored: 0 });
        for (const [field, expected] of [
            ['mapped_observations', coverageAccounting.mapped],
            ['unresolved_observations', coverageAccounting.unresolved],
            ['ignored_observations', coverageAccounting.ignored],
        ]) {
            const actual = accounting[field];
            if (actual !== expected) {
                failContract('ACCOUNTING_MISMATCH', `$.accounting.${field}`, `expected ${expected} from interpretation coverage, got ${actual}`);
            }
        }
    }
    if (evidenceIds) {
        const accountedObservations = Number(accounting.mapped_observations)
            + Number(accounting.unresolved_observations)
            + Number(accounting.ignored_observations);
        if (accountedObservations !== evidenceIds.size) {
            failContract('ACCOUNTING_MISMATCH', '$.accounting', `expected ${evidenceIds.size} observations, got ${accountedObservations}`);
        }
    }
    if (document.change_set_hash !== undefined) {
        const provided = digest(document.change_set_hash, '$.change_set_hash');
        if (options.verifyHash ?? options.verify_hash) {
            const actual = computeChangeSetHash(document);
            if (provided !== actual)
                failContract('CHANGE_SET_HASH_MISMATCH', '$.change_set_hash', 'change set hash does not match document', { expected: actual, actual: provided });
        }
    }
    if (document.plan_hash !== undefined && !isSha256Digest(document.plan_hash)) {
        failContract('INVALID_DIGEST', '$.plan_hash', 'plan_hash must be a SHA-256 digest');
    }
    if (document.created_at !== undefined)
        expectIsoDateTime(document.created_at, '$.created_at');
    return document;
}
export function validateChangeSetDocument(value, options = {}) {
    inspectChangeSet(value, options);
}
export function validateChangeSet(value, options = {}) {
    inspectChangeSet(value, options);
}
export function parseChangeSetDocument(value, options = {}) {
    return inspectChangeSet(value, options);
}
function hashableChangeSet(value) {
    if (!isRecord(value))
        return value;
    const copy = { ...value };
    delete copy.change_set_hash;
    return copy;
}
export function computeChangeSetHash(value) {
    inspectChangeSet(value, {});
    return hashJson(hashableChangeSet(value));
}
export const hashChangeSet = computeChangeSetHash;
export const computeChangeSetDigest = computeChangeSetHash;
export const changeSetDigest = computeChangeSetHash;
export function verifyChangeSetHash(value, expectedHash) {
    const expected = digest(expectedHash, '$expectedHash');
    const actual = computeChangeSetHash(value);
    if (actual !== expected)
        failContract('CHANGE_SET_HASH_MISMATCH', '$', 'change set hash does not match', { expected, actual });
}
export function operationIdempotencyKey(changeSet, operation) {
    const document = inspectChangeSet(changeSet, {});
    const item = expectRecord(operation, '$operation');
    expectString(item.op_id, '$operation.op_id');
    return hashJson({ change_set_id: document.change_set_id, op_id: item.op_id, operation: item });
}
export const computeOperationIdempotencyKey = operationIdempotencyKey;
export function getChangeSetTargetKey(operation) {
    const item = expectRecord(operation, '$operation');
    const entityType = expectEnum(item.entity_type, CHANGE_SET_ENTITY_TYPES, '$operation.entity_type');
    const target = validateTarget(item.target, '$operation.target', entityType, expectEnum(item.operation, CHANGE_SET_OPERATIONS, '$operation.operation'));
    return targetKey(entityType, target);
}
export function buildChangeSetPreview(value, options = {}) {
    const document = inspectChangeSet(value, options);
    const totals = {
        operations: document.operations.length,
        field_changes: 0,
        create: 0,
        update: 0,
        append: 0,
        archive: 0,
        link: 0,
        conflicts: 0,
        unresolved_fields: 0,
    };
    for (const operation of document.operations) {
        totals[operation.operation]++;
        totals.field_changes += operation.field_changes.length;
        totals.conflicts += operation.conflicts.length;
        totals.unresolved_fields += operation.field_changes.filter((field) => field.value_status === 'unknown').length;
    }
    return {
        schema: CHANGE_SET_SCHEMA,
        change_set_id: document.change_set_id,
        workspace_revision: document.workspace_revision,
        interpretation_id: document.interpretation_id,
        evidence_digest: document.evidence_digest,
        totals,
        operations: document.operations.map((operation) => ({
            op_id: operation.op_id,
            entity_type: operation.entity_type,
            operation: operation.operation,
            target: operation.target,
            field_changes: operation.field_changes,
            conflicts: operation.conflicts,
            risk: operation.risk,
        })),
        accounting: document.accounting,
    };
}
export const previewChangeSet = buildChangeSetPreview;
function changeSetRef(changeSetId) {
    if (!/^chg_[A-Za-z0-9_-]+$/u.test(changeSetId)) {
        failContract('INVALID_CHANGE_SET_ID', '$change_set_id', 'change set id has an unsafe format');
    }
    return `storage/change-sets/${changeSetId}.json`;
}
/** Persist a typed change set only after all structural and reference checks pass. */
export async function saveChangeSet(workspace, value, options = {}) {
    const document = parseChangeSetDocument(value, options);
    const destination = await resolveArtifactForWrite(workspace, changeSetRef(document.change_set_id), 'Change-set artifact');
    const serialized = `${JSON.stringify(document, null, 2)}\n`;
    try {
        await fs.writeFile(destination, serialized, { encoding: 'utf8', flag: 'wx' });
    }
    catch (error) {
        if (error?.code !== 'EEXIST')
            throw error;
        const existing = await loadChangeSet(workspace, document.change_set_id, options);
        if (computeChangeSetHash(existing) !== computeChangeSetHash(document)) {
            failContract('IMMUTABLE_ARTIFACT', '$.change_set_id', `change set ${document.change_set_id} already exists with different content`);
        }
        return existing;
    }
    return document;
}
export const saveChangeSetDocument = saveChangeSet;
export async function loadChangeSet(workspace, changeSetId, options = {}) {
    const source = await resolveRegularArtifact(workspace, changeSetRef(changeSetId), 'Change-set artifact');
    let parsed;
    try {
        parsed = JSON.parse(await fs.readFile(source, 'utf8'));
    }
    catch (error) {
        if (error?.code === 'ENOENT')
            throw new Error(`Change set 不存在：${changeSetId}`);
        throw error;
    }
    const document = parseChangeSetDocument(parsed, options);
    if (document.change_set_id !== changeSetId) {
        failContract('CHANGE_SET_ID_MISMATCH', '$.change_set_id', 'stored change set id does not match requested id');
    }
    return document;
}
export const loadChangeSetDocument = loadChangeSet;
export function isChangeSetDocument(value) {
    try {
        inspectChangeSet(value, {});
        return true;
    }
    catch {
        return false;
    }
}
/** Validate a change set against its exact interpretation and optional observation universe. */
export function validateChangeSetAgainstInterpretation(value, interpretation, options = {}) {
    validateChangeSetDocument(value, { ...options, interpretation });
}
