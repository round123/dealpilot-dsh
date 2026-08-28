import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { appendBusinessEvent, readYamlFrontmatter, updateStorageIndex, writeYamlFrontmatter, } from './okf-utils.js';
import { adapterForEntity, assertEntityPathSafe, deriveCreateRef, entityFromRef, isBusinessEntity, titleFromTarget, } from './entity-adapters.js';
import { consumeApproval, consumeApprovalRecord, canonicalJson, readApproval, validateApproval, validateApprovalRecord, workspaceFingerprint, } from './approval-store.js';
import { CHANGE_SET_SCHEMA as CONTRACT_CHANGE_SET_SCHEMA, computeChangeSetHash, validateChangeSetDocument, } from './change-set-contract.js';
import { computeWorkspaceRevision } from './workspace-revision.js';
// Keep the kernel's public constant sourced from the single protocol module.
// Hashing and structural validation must never have a second implementation.
export const CHANGE_SET_SCHEMA = CONTRACT_CHANGE_SET_SCHEMA;
export const TRANSACTION_SCHEMA = 'dealpilot.transaction/v2';
// A transaction may legitimately spend minutes staging a large workbook or
// rebuilding an index.  The lease is refreshed while the async callback is
// alive; stale reclamation is reserved for locks whose owner process is gone.
const LOCK_STALE_MS = 5 * 60 * 1000;
const LOCK_RENEW_MS = 30 * 1000;
const LOCK_WAIT_MS = 15 * 1000;
function transactionRoot(workspace) {
    return path.join(workspace, 'storage', 'transactions');
}
function stagingRoot(workspace, transactionId) {
    return path.join(workspace, 'storage', 'staging', transactionId);
}
function journalPath(workspace, transactionId) {
    if (!/^tx_[a-f0-9-]{16,}$/iu.test(transactionId))
        throw new Error('Invalid transaction id');
    return path.join(transactionRoot(workspace), `${transactionId}.json`);
}
function hashText(value) {
    return createHash('sha256').update(value).digest('hex');
}
function referenceId(value, name) {
    if (typeof value === 'string')
        return requireString(value, name);
    const reference = requireObject(value, name);
    return requireString(reference.observation_id, `${name}.observation_id`);
}
function referenceIds(values, name) {
    if (values === undefined)
        return [];
    if (!Array.isArray(values))
        throw new Error(`${name} must be an array`);
    return values.map((value, index) => referenceId(value, `${name}[${index}]`));
}
function operationReferenceIds(operation) {
    const refs = [];
    refs.push(...referenceIds(operation.preserve_claim_refs, `operation ${operation.op_id}.preserve_claim_refs`));
    for (let index = 0; index < operation.field_changes.length; index++) {
        const field = requireObject(operation.field_changes[index], `operation ${operation.op_id}.field_changes[${index}]`);
        refs.push(...referenceIds(field.claim_ids, `operation ${operation.op_id}.field_changes[${index}].claim_ids`));
        refs.push(...referenceIds(field.evidence_refs, `operation ${operation.op_id}.field_changes[${index}].evidence_refs`));
    }
    if (Array.isArray(operation.conflicts)) {
        for (let index = 0; index < operation.conflicts.length; index++) {
            const conflict = requireObject(operation.conflicts[index], `operation ${operation.op_id}.conflicts[${index}]`);
            refs.push(...referenceIds(conflict.claim_ids, `operation ${operation.op_id}.conflicts[${index}].claim_ids`));
            refs.push(...referenceIds(conflict.observation_ids, `operation ${operation.op_id}.conflicts[${index}].observation_ids`));
        }
    }
    if (Array.isArray(operation.unmapped)) {
        for (let index = 0; index < operation.unmapped.length; index++) {
            const item = requireObject(operation.unmapped[index], `operation ${operation.op_id}.unmapped[${index}]`);
            refs.push(...referenceIds(item.observation_ids, `operation ${operation.op_id}.unmapped[${index}].observation_ids`));
        }
    }
    return refs;
}
async function hashFile(filePath) {
    try {
        const content = await fs.readFile(filePath, 'utf8');
        return { exists: true, hash: hashText(content), content };
    }
    catch (error) {
        if (error?.code === 'ENOENT')
            return { exists: false, hash: '' };
        throw error;
    }
}
async function atomicWrite(filePath, content, backupPath) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const temp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await fs.open(temp, 'wx', 0o600);
    try {
        await handle.writeFile(content, 'utf8');
        await handle.sync();
    }
    finally {
        await handle.close();
    }
    try {
        await fs.rename(temp, filePath);
    }
    catch (error) {
        if (!['EEXIST', 'EPERM', 'ENOTEMPTY'].includes(error?.code)) {
            try {
                await fs.unlink(temp);
            }
            catch { }
            throw error;
        }
        // Windows does not replace an existing file with rename. Keep a durable
        // before-image while swapping so a stop between the two renames can be
        // repaired from the transaction journal instead of losing the target.
        if (backupPath) {
            await fs.mkdir(path.dirname(backupPath), { recursive: true });
            await fs.rm(backupPath, { force: true });
            let moved = false;
            try {
                await fs.rename(filePath, backupPath);
                moved = true;
            }
            catch (moveError) {
                if (moveError?.code !== 'ENOENT')
                    throw moveError;
                // A missing destination is valid only when a previous interrupted
                // replacement already left the durable backup behind. Otherwise an
                // external deletion raced this mutation and must not be overwritten.
                try {
                    await fs.access(backupPath);
                }
                catch {
                    try {
                        await fs.unlink(temp);
                    }
                    catch { }
                    throw moveError;
                }
            }
            try {
                await fs.rename(temp, filePath);
            }
            catch (replaceError) {
                if (moved) {
                    try {
                        await fs.rename(backupPath, filePath);
                    }
                    catch { }
                }
                try {
                    await fs.unlink(temp);
                }
                catch { }
                throw replaceError;
            }
            // The caller removes backupPath after verifying the replacement and
            // recording any dependent side effects. Keeping it until then also
            // makes a crash between the two steps recoverable.
        }
        else {
            // Compatibility path for staging/journal files where no before-image is
            // needed. The transaction still records the intended after hash.
            await fs.rm(filePath, { force: true });
            await fs.rename(temp, filePath);
        }
    }
}
async function readJson(filePath) {
    try {
        return JSON.parse(await fs.readFile(filePath, 'utf8'));
    }
    catch (error) {
        if (error?.code === 'ENOENT')
            return undefined;
        throw error;
    }
}
async function currentWorkspaceRevision(workspace) {
    return computeWorkspaceRevision(workspace);
}
async function assertWorkspaceRevision(workspace, expected, context) {
    const expectedRevision = requireString(expected, 'workspace_revision');
    const actual = await currentWorkspaceRevision(workspace);
    if (actual !== expectedRevision) {
        throw new Error(`Workspace revision 已变化（${context}）：expected ${expectedRevision}，actual ${actual}；请重新读取并生成变更集`);
    }
    return actual;
}
async function writeJournal(workspace, journal) {
    const destination = journalPath(workspace, journal.transaction_id);
    // Keep the previous journal image while replacing it. On Windows a process
    // can stop after the destination has been moved aside but before the new
    // image is renamed into place; loadJournal restores this before-image.
    const backup = `${destination}.before.bak`;
    await atomicWrite(destination, `${JSON.stringify(journal, null, 2)}\n`, backup);
    try {
        await fs.rm(backup, { force: true });
    }
    catch { }
}
function normalizeTransaction(value) {
    if (!value || typeof value !== 'object' || value.schema !== TRANSACTION_SCHEMA)
        return undefined;
    const source = value;
    // Journals written before approval/v2 did not have this field. Treating a
    // missing flag as consumed would let recovery perform an unapproved write.
    return {
        ...source,
        approval_consumed: source.approval_consumed === true,
        requested_op_ids: Array.isArray(source.requested_op_ids) ? source.requested_op_ids : [],
        operations: Array.isArray(source.operations) ? source.operations : [],
        completed_ops: Array.isArray(source.completed_ops) ? source.completed_ops : [],
        skipped_ops: Array.isArray(source.skipped_ops) ? source.skipped_ops : [],
        failed_ops: Array.isArray(source.failed_ops) ? source.failed_ops : [],
        references_resolved: source.references_resolved !== false,
        recovery_attempts: typeof source.recovery_attempts === 'number' ? source.recovery_attempts : 0,
    };
}
async function loadJournal(workspace, transactionId) {
    const destination = journalPath(workspace, transactionId);
    const backup = `${destination}.before.bak`;
    let value;
    let destinationError;
    try {
        value = await readJson(destination);
    }
    catch (error) {
        destinationError = error;
    }
    if (value === undefined) {
        let previous;
        try {
            previous = await readJson(backup);
        }
        catch (error) {
            if (error?.code !== 'ENOENT')
                throw error;
        }
        if (previous !== undefined) {
            // Use the before-image as a read candidate, but do not rename it from a
            // read path. A concurrent writer may currently be between the two
            // replacement renames; the next workspace-locked write will restore the
            // destination and clean this backup without racing that writer.
            value = previous;
        }
    }
    else {
        // A completed replacement can leave a stale before-image if the process
        // stopped just before cleanup. It is safe to remove once the new journal
        // parses successfully.
        try {
            await fs.rm(backup, { force: true });
        }
        catch { }
    }
    if (value === undefined && destinationError)
        throw destinationError;
    return normalizeTransaction(value);
}
async function withWorkspaceLock(workspace, callback) {
    const root = path.join(workspace, 'storage');
    await fs.mkdir(root, { recursive: true });
    const lockPath = path.join(root, '.mutation.lock');
    const started = Date.now();
    while (true) {
        try {
            const handle = await fs.open(lockPath, 'wx', 0o600);
            const leaseToken = randomUUID();
            let renewal;
            try {
                await handle.writeFile(JSON.stringify({ pid: process.pid, lease_token: leaseToken, created_at: new Date().toISOString() }));
                renewal = setInterval(() => {
                    void (async () => {
                        try {
                            const current = JSON.parse(await fs.readFile(lockPath, 'utf8'));
                            if (current?.lease_token !== leaseToken)
                                return;
                            const now = new Date();
                            await fs.utimes(lockPath, now, now);
                        }
                        catch { /* a replaced lock is owned by another process */ }
                    })();
                }, LOCK_RENEW_MS);
                renewal.unref?.();
                return await callback();
            }
            finally {
                if (renewal)
                    clearInterval(renewal);
                await handle.close();
                try {
                    const current = JSON.parse(await fs.readFile(lockPath, 'utf8'));
                    if (current?.lease_token === leaseToken)
                        await fs.rm(lockPath, { force: true });
                }
                catch { /* the lock was already reclaimed or removed */ }
            }
        }
        catch (error) {
            if (error?.code !== 'EEXIST')
                throw error;
            try {
                const stat = await fs.stat(lockPath);
                if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
                    let ownerAlive = true;
                    try {
                        const current = JSON.parse(await fs.readFile(lockPath, 'utf8'));
                        const pid = Number(current?.pid);
                        if (!Number.isInteger(pid) || pid <= 0)
                            ownerAlive = false;
                        else {
                            try {
                                process.kill(pid, 0);
                            }
                            catch {
                                ownerAlive = false;
                            }
                        }
                    }
                    catch {
                        ownerAlive = false;
                    }
                    if (!ownerAlive) {
                        await fs.rm(lockPath, { force: true });
                        continue;
                    }
                }
            }
            catch (statError) {
                if (statError?.code === 'ENOENT')
                    continue;
            }
            if (Date.now() - started >= LOCK_WAIT_MS)
                throw new Error('Mutation workspace is busy; retry the operation');
            await new Promise(resolve => setTimeout(resolve, 25));
        }
    }
}
function requireObject(value, name) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error(`${name} must be an object`);
    return value;
}
function requireString(value, name) {
    if (typeof value !== 'string' || !value.trim())
        throw new Error(`${name} must be a non-empty string`);
    return value.trim();
}
function validateProtocolChangeSet(changeSet) {
    // The contract validator is intentionally the first gate. Local checks below
    // only deal with filesystem capabilities; they do not redefine v2 shape,
    // claim status, accounting, or evidence semantics.
    validateChangeSetDocument(changeSet, { verifyHash: true });
    const value = changeSet;
    if (typeof value.change_set_hash !== 'string' || !value.change_set_hash.trim()) {
        throw new Error('change_set/v2 变更集必须包含可验证的 change_set_hash');
    }
}
function fieldChanges(operation) {
    if (!Array.isArray(operation.field_changes))
        throw new Error(`operation ${operation.op_id}: field_changes must be an array`);
    return operation.field_changes.map((change, index) => {
        const value = requireObject(change, `operation ${operation.op_id} field_changes[${index}]`);
        const fieldPath = requireString(value.path, `operation ${operation.op_id} field_changes[${index}].path`);
        if (fieldPath.startsWith('/') || fieldPath.includes('..'))
            throw new Error(`operation ${operation.op_id}: invalid field path`);
        if (value.after === undefined && operation.operation !== 'archive') {
            throw new Error(`operation ${operation.op_id} field_changes[${index}] 缺少 after 值`);
        }
        return value;
    });
}
function validateRefs(refs, name) {
    refs.forEach((ref, index) => { referenceId(ref, `${name}[${index}]`); });
}
async function validateOperation(workspace, operation, seenRefs, seenOpIds, now, resolveReference) {
    const opId = requireString(operation.op_id, 'op_id');
    if (seenOpIds.has(opId))
        throw new Error(`重复 op_id：${opId}`);
    seenOpIds.add(opId);
    const entity = requireString(operation.entity_type, `operation ${opId}.entity_type`);
    const adapter = adapterForEntity(entity);
    const action = requireString(operation.operation, `operation ${opId}.operation`);
    if (!adapter.operations.includes(action))
        throw new Error(`实体 ${entity} 不支持 ${action} 操作`);
    const target = requireObject(operation.target, `operation ${opId}.target`);
    if (typeof operation.target === 'string')
        throw new Error(`operation ${opId}.target 不能是字符串`);
    const allowedKeys = new Set(['op_id', 'entity_type', 'operation', 'target', 'field_changes', 'preserve_claim_refs', 'conflicts', 'risk', 'base_revision', 'idempotency_key', 'rationale', 'unmapped', 'extensions']);
    for (const key of Object.keys(operation)) {
        if (!allowedKeys.has(key))
            throw new Error(`operation ${opId}: 不支持字段 ${key}；请通过 field_changes 和 evidence/interpretation 表达内容`);
    }
    fieldChanges(operation);
    if (operation.base_revision !== undefined)
        requireString(operation.base_revision, `operation ${opId}.base_revision`);
    if (target.base_revision !== undefined)
        requireString(target.base_revision, `operation ${opId}.target.base_revision`);
    if (target.expected_revision !== undefined)
        requireString(target.expected_revision, `operation ${opId}.target.expected_revision`);
    if (Array.isArray(operation.field_changes)) {
        for (const change of operation.field_changes) {
            validateRefs([...(change.claim_ids || []), ...(change.evidence_refs || [])], `operation ${opId} field evidence ref`);
            const status = change.value_status;
            if (status && !['observed', 'inferred', 'hypothesis', 'unknown', 'conflict'].includes(status)) {
                throw new Error(`operation ${opId}: unknown value_status ${status}`);
            }
            const fieldHasEvidence = (Array.isArray(change.claim_ids) && change.claim_ids.length > 0)
                || (Array.isArray(change.evidence_refs) && change.evidence_refs.length > 0);
            if (status !== 'unknown' && status !== undefined && !fieldHasEvidence) {
                throw new Error(`operation ${opId}: factual field change requires evidence or claim reference`);
            }
        }
    }
    if (action !== 'create' && !target.ref)
        throw new Error(`operation ${opId}: ${action} 需要 target.ref`);
    const ref = target.ref
        ? await assertEntityPathSafe(workspace, entity, requireString(target.ref, `operation ${opId}.target.ref`))
        : await assertEntityPathSafe(workspace, entity, deriveCreateRef(workspace, entity, target, opId, now));
    if (seenRefs.has(ref))
        throw new Error(`重复目标引用：${ref}`);
    seenRefs.add(ref);
    for (const candidate of operationReferenceIds(operation)) {
        if (resolveReference && !(await resolveReference(candidate)))
            throw new Error(`找不到证据或声明引用：${candidate}`);
    }
    return { ref };
}
/** Validate the complete set before any file or event side effect. */
export async function validateChangeSet(workspace, changeSet, options = {}) {
    validateProtocolChangeSet(changeSet);
    if (!changeSet || typeof changeSet !== 'object')
        throw new Error('change-set must be an object');
    if (changeSet.schema !== CHANGE_SET_SCHEMA)
        throw new Error(`只接受 ${CHANGE_SET_SCHEMA} 变更集`);
    const changeSetId = requireString(changeSet.change_set_id, 'change_set_id');
    if (!Array.isArray(changeSet.operations) || !changeSet.operations.length)
        throw new Error('变更集至少需要一个 operation');
    const seenRefs = new Set();
    const seenOpIds = new Set();
    const refs = [];
    const now = options.now || new Date();
    for (const operation of changeSet.operations) {
        const normalizedOperation = requireObject(operation, 'operation');
        const result = await validateOperation(workspace, normalizedOperation, seenRefs, seenOpIds, now, options.resolveReference);
        refs.push(result);
    }
    return {
        normalized: { ...changeSet, schema: CHANGE_SET_SCHEMA, change_set_id: changeSetId },
        refs,
    };
}
function setNestedValue(target, fieldPath, value) {
    const parts = fieldPath.split('.').filter(Boolean);
    if (!parts.length)
        throw new Error('field path cannot be empty');
    let cursor = target;
    for (let index = 0; index < parts.length - 1; index++) {
        const part = parts[index];
        if (!cursor[part] || typeof cursor[part] !== 'object' || Array.isArray(cursor[part]))
            cursor[part] = {};
        cursor = cursor[part];
    }
    cursor[parts[parts.length - 1]] = value;
}
function getNestedValue(target, fieldPath) {
    const parts = fieldPath.split('.').filter(Boolean);
    let cursor = target;
    for (const part of parts) {
        if (!cursor || typeof cursor !== 'object' || !Object.prototype.hasOwnProperty.call(cursor, part))
            return undefined;
        cursor = cursor[part];
    }
    return cursor;
}
function hasOwn(value, key) {
    return Object.prototype.hasOwnProperty.call(value, key);
}
function assertFieldBefore(operation, existing) {
    const changes = fieldChanges(operation);
    for (const change of changes) {
        const record = change;
        if (!hasOwn(record, 'before'))
            continue;
        if (!existing)
            throw new Error(`operation ${operation.op_id}: before 值要求目标已存在`);
        const actual = /^(?:body|content)$/iu.test(change.path)
            ? existing.body
            : getNestedValue(existing.meta, change.path);
        if (canonicalJson(actual) !== canonicalJson(change.before)) {
            throw new Error(`目标字段在批准后已变化：${operation.target.ref || operation.op_id}.${change.path}`);
        }
    }
}
function appendContext(operation) {
    const lines = [];
    if (operation.rationale)
        lines.push(`Rationale: ${operation.rationale}`);
    const refs = operationReferenceIds(operation);
    if (refs.length) {
        lines.push('Evidence and claim refs:', ...Array.from(new Set(refs)).map(ref => `- ${ref}`));
    }
    if (operation.unmapped?.length) {
        lines.push('Unmapped observations:', ...operation.unmapped.map(item => `- ${JSON.stringify(item)}`));
    }
    if (operation.conflicts?.length) {
        lines.push('Conflicts:', ...operation.conflicts.map(item => `- ${JSON.stringify(item)}`));
    }
    if (operation.extensions && Object.keys(operation.extensions).length) {
        lines.push(`Operation extensions: ${JSON.stringify(operation.extensions)}`);
    }
    if (!lines.length)
        return '';
    return `\n\n## Agent context\n\n${lines.join('\n')}\n`;
}
async function renderAfter(workspace, operation, ref, now) {
    const entity = operation.entity_type;
    const filePath = path.join(workspace, ref);
    if (entity === 'evidence') {
        let document = {};
        try {
            document = JSON.parse(await fs.readFile(filePath, 'utf8'));
            if (!document || typeof document !== 'object' || Array.isArray(document))
                throw new Error(`证据文件必须是 JSON object：${ref}`);
        }
        catch (error) {
            if (error?.code !== 'ENOENT' || operation.operation !== 'create')
                throw error;
        }
        for (const change of fieldChanges(operation)) {
            if (Object.prototype.hasOwnProperty.call(change, 'before')) {
                const actual = getNestedValue(document, change.path);
                if (canonicalJson(actual) !== canonicalJson(change.before)) {
                    throw new Error(`证据字段在批准后已变化：${ref}.${change.path}`);
                }
            }
            if (change.after !== undefined)
                setNestedValue(document, change.path, change.after);
        }
        return { content: `${JSON.stringify(document, null, 2)}\n`, metadata: {} };
    }
    let existing;
    try {
        existing = await readYamlFrontmatter(filePath);
    }
    catch (error) {
        // A missing create target is expected. Any other read/parse failure must
        // stop the mutation; treating malformed existing data as an empty record
        // would silently discard information.
        if (error?.code !== 'ENOENT' || operation.operation !== 'create')
            throw error;
    }
    assertFieldBefore(operation, existing);
    const metadata = { ...(existing?.meta || {}) };
    const changes = fieldChanges(operation);
    let body = existing?.body || '';
    for (const change of changes) {
        if (operation.entity_type === 'note' && /^(?:body|content)$/iu.test(change.path)) {
            if (change.after !== undefined)
                body = typeof change.after === 'string' ? change.after : JSON.stringify(change.after, null, 2);
            continue;
        }
        if (change.after !== undefined)
            setNestedValue(metadata, change.path, change.after);
    }
    const claimRefs = changes.flatMap(change => Array.isArray(change.claim_ids) ? change.claim_ids : []);
    const evidenceRefs = changes.flatMap(change => Array.isArray(change.evidence_refs)
        ? change.evidence_refs.map((ref, index) => referenceId(ref, `operation ${operation.op_id}.field_changes.evidence_refs[${index}]`))
        : []);
    if (claimRefs.length || operation.preserve_claim_refs?.length) {
        metadata.claim_refs = Array.from(new Set([...(Array.isArray(metadata.claim_refs) ? metadata.claim_refs : []), ...claimRefs, ...(operation.preserve_claim_refs || [])]));
    }
    if (evidenceRefs.length)
        metadata.evidence_refs = Array.from(new Set([...(Array.isArray(metadata.evidence_refs) ? metadata.evidence_refs : []), ...evidenceRefs]));
    if (operation.unmapped?.length)
        metadata.unmapped_observations = operation.unmapped;
    if (operation.conflicts?.length)
        metadata.conflicts = operation.conflicts;
    const fieldExtensions = changes
        .filter(change => change.extensions && Object.keys(change.extensions).length)
        .map(change => ({ path: change.path, extensions: change.extensions }));
    if (fieldExtensions.length)
        metadata.field_extensions = fieldExtensions;
    if (operation.operation === 'archive')
        metadata.status = 'archived';
    metadata.generated = { ...(metadata.generated || {}), by: 'dealpilot-mutation-kernel', at: now.toISOString() };
    const targetTitle = titleFromTarget(operation.target);
    if (operation.operation === 'create' && targetTitle && metadata.title === undefined)
        metadata.title = targetTitle;
    const bodyChanges = changes.filter(change => /^(?:body|content)$/iu.test(change.path));
    if (bodyChanges.length) {
        const value = bodyChanges[bodyChanges.length - 1].after;
        const addition = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
        if (operation.operation === 'append' || operation.operation === 'link')
            body = `${body.trimEnd()}\n\n${addition.trim()}\n`;
        else
            body = `${addition}${appendContext(operation)}`;
    }
    else if (operation.operation === 'create') {
        body = appendContext(operation);
    }
    else if (operation.rationale || operation.unmapped?.length || operation.conflicts?.length || operationReferenceIds(operation).length) {
        body = `${body.trimEnd()}${appendContext(operation)}`;
    }
    return { content: body, metadata };
}
async function stageOperation(workspace, journal, operation, refInfo, now) {
    const ref = refInfo.ref;
    const filePath = path.join(workspace, ref);
    const before = await hashFile(filePath);
    if (operation.operation === 'create' && before.exists)
        throw new Error(`创建目标已存在：${ref}`);
    if (operation.operation !== 'create' && !before.exists)
        throw new Error(`目标不存在：${ref}`);
    const rendered = await renderAfter(workspace, operation, ref, now);
    // op_id is a protocol identifier, not a filesystem path. Hash it before
    // constructing the staging name so a malformed identifier cannot escape the
    // transaction directory.
    const stageName = `${hashText(operation.op_id).slice(0, 32)}${entityFromRef(ref) === 'evidence' ? '.json' : '.md'}`;
    const stagedPath = path.join(stagingRoot(workspace, journal.transaction_id), stageName);
    // Stage the exact bytes that will be committed. This makes the interval
    // between file replacement and journal update recoverable by hash.
    if (entityFromRef(ref) === 'evidence') {
        await atomicWrite(stagedPath, rendered.content);
    }
    else {
        await writeYamlFrontmatter(stagedPath, rendered.metadata, rendered.content);
    }
    const stagedContent = await fs.readFile(stagedPath, 'utf8');
    const item = {
        op_id: operation.op_id,
        entity_type: operation.entity_type,
        operation: operation.operation,
        ref,
        status: 'staged',
        before,
        after_hash: hashText(stagedContent),
        staged_path: path.relative(workspace, stagedPath).replaceAll('\\', '/'),
        ...(before.exists ? { backup_path: path.relative(workspace, `${stagedPath}.before.bak`).replaceAll('\\', '/') } : {}),
        event_id: `evt_${journal.transaction_id}_${operation.op_id}`,
        event: eventFor(journal, operation, ref, now),
    };
    return item;
}
async function materializeStaged(workspace, operation) {
    if (!operation.staged_path)
        throw new Error(`operation ${operation.op_id} 缺少 staging 文件`);
    const staged = await fs.readFile(path.join(workspace, operation.staged_path), 'utf8');
    if (hashText(staged) !== operation.after_hash)
        throw new Error(`staging 文件校验失败：${operation.op_id}`);
    return staged;
}
function eventFor(journal, operation, ref, now) {
    const event = {
        event_id: `evt_${journal.transaction_id}_${operation.op_id}`,
        occurred_at: now.toISOString(),
        event_type: `${operation.entity_type}.${operation.operation}`,
        channel: 'agent',
        generated_by: 'dealpilot-mutation-kernel',
        mutation_transaction_id: journal.transaction_id,
        mutation_op_id: operation.op_id,
        change_set_id: journal.change_set_id,
        summary: operation.rationale || ref,
    };
    const refs = operationReferenceIds(operation);
    if (refs.length)
        event.reference_ids = Array.from(new Set(refs));
    if (operation.target && typeof operation.target === 'object') {
        // Keep the reviewed target available in the audit trail without exposing
        // a mutable object reference to later callers.
        event.target = JSON.parse(canonicalJson(operation.target));
    }
    if (operation.extensions && Object.keys(operation.extensions).length) {
        event.operation_extensions = JSON.parse(canonicalJson(operation.extensions));
    }
    if (operation.entity_type === 'customer')
        event.customer_ref = ref;
    if (operation.entity_type === 'deal')
        event.deal_ref = ref;
    if (operation.entity_type === 'action')
        event.action_ref = ref;
    return event;
}
async function appendEventOnce(workspace, event) {
    const eventPath = path.join(workspace, 'knowledge', 'events', 'business-events.jsonl');
    let existing = '';
    try {
        existing = await fs.readFile(eventPath, 'utf8');
    }
    catch (error) {
        if (error?.code !== 'ENOENT')
            throw error;
    }
    if (event.event_id && existing.split(/\r?\n/u).some(line => {
        if (!line.trim())
            return false;
        try {
            return JSON.parse(line).event_id === event.event_id;
        }
        catch {
            return false;
        }
    }))
        return;
    await appendBusinessEvent(workspace, event);
}
async function commitOperation(workspace, item) {
    const staged = await materializeStaged(workspace, item);
    await assertEntityPathSafe(workspace, item.entity_type, item.ref);
    const filePath = path.join(workspace, item.ref);
    const current = await hashFile(filePath);
    let currentHash = current.hash;
    if (currentHash !== item.before.hash && currentHash !== item.after_hash && currentHash !== '') {
        throw new Error(`提交前目标已变化：${item.ref}`);
    }
    if (currentHash !== item.after_hash) {
        // A Windows process stop can leave the old target under backup_path after
        // the destination was removed but before the staged rename. Verify that
        // backup is the recorded before-image, then finish the intended commit.
        if (currentHash === '' && item.backup_path) {
            const backup = await hashFile(path.join(workspace, item.backup_path));
            if (backup.exists && backup.hash !== item.before.hash) {
                throw new Error(`事务 before-image 校验失败：${item.op_id}`);
            }
            if (item.before.exists && !backup.exists) {
                throw new Error(`目标在提交前被删除：${item.ref}`);
            }
        }
        if (currentHash === '' && item.before.exists && !item.backup_path) {
            throw new Error(`目标在提交前被删除：${item.ref}`);
        }
        await atomicWrite(filePath, staged, item.backup_path ? path.join(workspace, item.backup_path) : undefined);
    }
    const after = await hashFile(filePath);
    if (!after.exists || after.hash !== item.after_hash)
        throw new Error(`提交后目标校验失败：${item.ref}`);
    if (item.backup_path) {
        try {
            await fs.rm(path.join(workspace, item.backup_path), { force: true });
        }
        catch { }
    }
    await appendEventOnce(workspace, item.event);
    if (isBusinessEntity(item.entity_type)) {
        const parsed = await readYamlFrontmatter(filePath);
        await updateStorageIndex(workspace, item.entity_type, { ref: item.ref, ...parsed.meta, updated_at: new Date().toISOString(), mutation_transaction_id: item.event?.mutation_transaction_id });
    }
    return { op_id: item.op_id, ref: item.ref, operation: item.operation, status: 'applied' };
}
/**
 * Rebuild derived side effects for an operation whose authoritative file was
 * already committed.  Completed transactions can be observed with a missing
 * event or index after a process stop; replaying the file mutation would be
 * unsafe, so only the durable derivatives are repaired here.
 */
async function repairAppliedOperationDerivatives(workspace, item) {
    const filePath = path.join(workspace, item.ref);
    const image = await hashFile(filePath);
    if (!image.exists || image.hash !== item.after_hash) {
        throw new Error(`已应用操作的权威文件不匹配，拒绝重放：${item.ref}`);
    }
    if (!item.event?.event_id)
        throw new Error(`已应用操作缺少审计事件：${item.op_id}`);
    await appendEventOnce(workspace, item.event);
    if (isBusinessEntity(item.entity_type)) {
        const parsed = await readYamlFrontmatter(filePath);
        const indexPath = path.join(workspace, 'storage', 'indexes', `${item.entity_type}.json`);
        const index = await readJson(indexPath);
        const matches = Array.isArray(index) ? index.filter((entry) => entry?.ref === item.ref) : [];
        const indexIsCurrent = matches.length === 1
            && Object.entries(parsed.meta).every(([key, value]) => canonicalJson(matches[0][key]) === canonicalJson(value))
            && matches[0].mutation_transaction_id === item.event.mutation_transaction_id;
        if (!indexIsCurrent) {
            await updateStorageIndex(workspace, item.entity_type, {
                ref: item.ref,
                ...parsed.meta,
                updated_at: new Date().toISOString(),
                mutation_transaction_id: item.event.mutation_transaction_id,
            });
        }
    }
}
function invariants(journal) {
    const requestedIds = journal.requested_op_ids || journal.operations.map(item => item.op_id);
    const accountedIds = new Set([...journal.completed_ops, ...journal.skipped_ops, ...journal.failed_ops]);
    const refs = journal.operations.map(item => item.ref);
    const requestedSet = new Set(requestedIds);
    const completedSet = new Set(journal.completed_ops);
    const skippedSet = new Set(journal.skipped_ops);
    const failedSet = new Set(journal.failed_ops);
    const operationIds = journal.operations.map(item => item.op_id);
    const operationIdSet = new Set(operationIds);
    const statusMemberships = (opId) => Number(completedSet.has(opId)) + Number(skippedSet.has(opId)) + Number(failedSet.has(opId));
    const operationStatusesConsistent = requestedIds.length === requestedSet.size
        && operationIds.length === operationIdSet.size
        && operationIds.every(opId => requestedSet.has(opId))
        && [...accountedIds].every(opId => requestedSet.has(opId) && operationIdSet.has(opId) && statusMemberships(opId) === 1)
        && journal.operations.every(item => {
            const membership = statusMemberships(item.op_id);
            if (item.status === 'applied')
                return completedSet.has(item.op_id) && !skippedSet.has(item.op_id) && !failedSet.has(item.op_id);
            if (item.status === 'skipped')
                return skippedSet.has(item.op_id) && !completedSet.has(item.op_id) && !failedSet.has(item.op_id);
            if (item.status === 'failed')
                return failedSet.has(item.op_id) && !completedSet.has(item.op_id) && !skippedSet.has(item.op_id);
            return membership === 0;
        });
    return {
        requested_ops_accounted: requestedIds.length === accountedIds.size && requestedIds.every(opId => accountedIds.has(opId)),
        operation_statuses_consistent: operationStatusesConsistent,
        all_refs_are_unique: new Set(refs).size === refs.length,
        all_entity_types_match: journal.operations.every(item => entityFromRef(item.ref) === item.entity_type),
        all_claim_refs_resolve: journal.references_resolved !== false,
        business_events_recorded: journal.operations.filter(item => item.status === 'applied').every(item => Boolean(item.event?.event_id)),
    };
}
function resultFromJournal(journal) {
    // Recompute journal-local invariants on every read; cached write-side checks
    // include filesystem facts, but must not be trusted for mutable operation
    // membership/status fields.
    const checks = { ...(journal.invariant_results || {}), ...invariants(journal) };
    return {
        ok: journal.status === 'completed' && Object.values(checks).every(Boolean),
        transaction_id: journal.transaction_id,
        change_set_id: journal.change_set_id,
        status: journal.status,
        results: journal.operations.filter(item => item.result).map(item => item.result),
        completed_ops: [...journal.completed_ops],
        skipped_ops: [...journal.skipped_ops],
        failed_ops: [...journal.failed_ops],
        invariants: checks,
        ...(journal.failure ? { error: journal.failure } : {}),
    };
}
async function eventIdsInWorkspace(workspace) {
    const result = new Set();
    const eventPath = path.join(workspace, 'knowledge', 'events', 'business-events.jsonl');
    let content = '';
    try {
        content = await fs.readFile(eventPath, 'utf8');
    }
    catch (error) {
        if (error?.code !== 'ENOENT')
            throw error;
    }
    for (const line of content.split(/\r?\n/u)) {
        if (!line.trim())
            continue;
        let value;
        try {
            value = JSON.parse(line);
        }
        catch {
            continue;
        }
        if (typeof value?.event_id === 'string')
            result.add(value.event_id);
    }
    return result;
}
async function verifyWriteInvariants(workspace, journal) {
    const checks = invariants(journal);
    const eventIds = await eventIdsInWorkspace(workspace);
    const seenRefs = new Set();
    let authoritativeFilesMatch = true;
    let indexMatchesAuthoritativeFiles = true;
    let businessEventsRecorded = true;
    for (const item of journal.operations.filter(operation => operation.status === 'applied')) {
        if (seenRefs.has(item.ref))
            checks.all_refs_are_unique = false;
        seenRefs.add(item.ref);
        const image = await hashFile(path.join(workspace, item.ref));
        if (!image.exists || image.hash !== item.after_hash)
            authoritativeFilesMatch = false;
        if (!eventIds.has(item.event_id))
            businessEventsRecorded = false;
        if (isBusinessEntity(item.entity_type)) {
            const index = await readJson(path.join(workspace, 'storage', 'indexes', `${item.entity_type}.json`));
            const matches = Array.isArray(index) ? index.filter((entry) => entry?.ref === item.ref) : [];
            if (matches.length !== 1) {
                indexMatchesAuthoritativeFiles = false;
            }
            else {
                try {
                    const parsed = await readYamlFrontmatter(path.join(workspace, item.ref));
                    const entry = matches[0];
                    for (const key of ['title', 'status']) {
                        if (entry[key] !== undefined && canonicalJson(entry[key]) !== canonicalJson(parsed.meta[key])) {
                            indexMatchesAuthoritativeFiles = false;
                        }
                    }
                }
                catch {
                    indexMatchesAuthoritativeFiles = false;
                }
            }
        }
    }
    return {
        ...checks,
        authoritative_files_match: authoritativeFilesMatch,
        business_events_recorded: businessEventsRecorded,
        index_matches_authoritative_files: indexMatchesAuthoritativeFiles,
    };
}
async function findExistingTransaction(workspace, changeSetId, changeSetHash) {
    let names = [];
    try {
        names = await fs.readdir(transactionRoot(workspace));
    }
    catch (error) {
        if (error?.code !== 'ENOENT')
            throw error;
    }
    const candidates = new Set(names.filter(item => item.endsWith('.json')));
    // Include a journal whose destination was moved to its before-image during
    // an interrupted Windows replacement.
    for (const name of names.filter(item => item.endsWith('.json.before.bak'))) {
        candidates.add(name.slice(0, -'.before.bak'.length));
    }
    for (const name of candidates) {
        const journal = await loadJournal(workspace, name.slice(0, -5));
        if (journal?.change_set_id === changeSetId) {
            if (journal.change_set_hash !== changeSetHash)
                throw new Error(`change_set_id 已对应不同内容：${changeSetId}`);
            return journal;
        }
    }
    return undefined;
}
async function assertResumeContext(workspace, journal, options) {
    if (workspaceFingerprint(workspace) !== workspaceFingerprint(journal.workspace))
        throw new Error('事务不属于当前 Workspace');
    if (journal.workspace_id && journal.workspace_id !== options.workspaceId) {
        throw new Error('事务不属于当前 Workspace');
    }
    if (journal.session_id && journal.session_id !== options.sessionId) {
        throw new Error('事务不属于当前 session');
    }
    // A completed transaction is revalidated against its actual files, events,
    // and indexes by the caller.  Its original revision is expected to differ
    // after any legitimate later mutation, so it must not be treated as a
    // resume candidate here.
    if (journal.status === 'completed')
        return;
    if (!journal.workspace_revision)
        return;
    const expected = journal.current_workspace_revision || journal.workspace_revision;
    const actual = await currentWorkspaceRevision(workspace);
    if (actual === expected)
        return;
    // A completed transaction may be downgraded to recoverable when only its
    // derived event/index material is missing. Those repairs can legitimately
    // change the workspace revision, but they must never mask an edit to an
    // authoritative business file. Verify every applied target before allowing
    // this derivative-only retry to proceed.
    const allOperationsFinalized = journal.operations.length > 0
        && journal.operations.every(item => item.status === 'applied' || item.status === 'skipped');
    const derivativeOnlyRecovery = journal.status === 'recoverable'
        && allOperationsFinalized
        && (journal.invariant_results?.business_events_recorded === false
            || journal.invariant_results?.index_matches_authoritative_files === false)
        && journal.invariant_results?.authoritative_files_match !== false;
    if (derivativeOnlyRecovery) {
        for (const item of journal.operations.filter(operation => operation.status === 'applied')) {
            const current = await hashFile(path.join(workspace, item.ref));
            if (!current.exists || current.hash !== item.after_hash) {
                throw new Error(`事务恢复时目标已被外部修改：${item.ref}`);
            }
        }
        return;
    }
    // A crash can occur after the target rename but before the journal status is
    // persisted. Permit that one recoverable state only when the current target
    // already equals the staged after-image, or when Windows has moved the
    // verified before-image to the operation backup. Any other revision drift is
    // an external edit and must be surfaced instead of being overwritten.
    let hasUnjournaledAfterImage = false;
    let hasInterruptedReplacement = false;
    for (const item of journal.operations) {
        if (item.status === 'applied' || item.status === 'skipped')
            continue;
        const current = await hashFile(path.join(workspace, item.ref));
        if (current.hash === item.after_hash)
            hasUnjournaledAfterImage = true;
        else if (!current.exists && item.before.exists && item.backup_path) {
            const backup = await hashFile(path.join(workspace, item.backup_path));
            if (!backup.exists || backup.hash !== item.before.hash) {
                throw new Error(`事务恢复时 before-image 不可验证：${item.ref}`);
            }
            hasInterruptedReplacement = true;
        }
        else if (current.hash !== item.before.hash) {
            throw new Error(`事务恢复时目标已被外部修改：${item.ref}`);
        }
    }
    if (!hasUnjournaledAfterImage && !hasInterruptedReplacement) {
        throw new Error(`事务绑定的 Workspace revision 已变化：expected ${expected}，actual ${actual}`);
    }
}
async function revalidateCompletedTransaction(workspace, journal) {
    try {
        const checks = await verifyWriteInvariants(workspace, journal);
        journal.invariant_results = checks;
        if (!Object.values(checks).every(Boolean)) {
            journal.status = 'recoverable';
            const failed = Object.entries(checks).filter(([, value]) => !value).map(([key]) => key);
            journal.failure = `已完成事务的持久化完整性校验失败：${failed.join(', ') || 'unknown'}`;
        }
    }
    catch (error) {
        journal.status = 'recoverable';
        journal.invariant_results = {
            ...(journal.invariant_results || {}),
            authoritative_files_match: false,
            business_events_recorded: false,
            index_matches_authoritative_files: false,
        };
        journal.failure = `已完成事务的持久化完整性校验失败：${error?.message || String(error)}`;
    }
    journal.updated_at = new Date().toISOString();
    await writeJournal(workspace, journal);
    return resultFromJournal(journal);
}
function approvalBinding(workspace, changeSet, options) {
    const expectedHash = computeChangeSetHash(changeSet);
    const selectedOpIds = changeSet.operations.map(operation => operation.op_id).sort();
    if (!options.sessionId)
        throw new Error('应用变更集需要 sessionId');
    return {
        tool: options.approvalTool || 'dealpilot_apply',
        workspacePath: workspace,
        workspaceId: options.workspaceId,
        sessionId: options.sessionId,
        payload: changeSet,
        schemaVersion: CHANGE_SET_SCHEMA,
        baseRevision: changeSet.workspace_revision,
        changeSetId: changeSet.change_set_id,
        changeSetHash: expectedHash,
        interpretationId: changeSet.interpretation_id,
        selectedOpIds,
        actor: options.actor,
    };
}
async function verifyApproval(workspace, changeSet, options) {
    const binding = approvalBinding(workspace, changeSet, options);
    if (options.approval) {
        const approval = options.approval;
        if (approval.status !== 'pending')
            throw new Error('批准记录已失效，请重新审阅');
        return validateApprovalRecord(approval, binding);
    }
    if (!options.approvalToken)
        throw new Error('缺少持久化用户批准记录');
    return validateApproval(options.approvalToken, binding);
}
function consumeVerifiedApproval(workspace, changeSet, options) {
    const binding = approvalBinding(workspace, changeSet, options);
    if (options.approval)
        return consumeApprovalRecord(options.approval, binding);
    if (!options.approvalToken)
        throw new Error('缺少持久化用户批准记录');
    return consumeApproval(options.approvalToken, binding);
}
function sortedIds(values) {
    if (!Array.isArray(values) || values.some(value => typeof value !== 'string' || !value.trim()))
        return undefined;
    return values.slice().sort();
}
/**
 * Verify the durable approval against every binding retained by a journal.
 * Recovery has no caller-supplied change-set, so the approved payload itself
 * is parsed and hashed before it can authorize another side effect.
 */
function approvalMatchesJournal(workspace, journal, stored) {
    try {
        if (!stored || stored.status !== 'consumed')
            return false;
        // These fields are deliberately required. A pre-v2 journal that does not
        // retain the complete binding is recoverable only after an explicit retry
        // supplies a fresh, still-pending approval.
        if (!journal.approval_id
            || !journal.approval_token_hash
            || !journal.approval_payload_hash
            || !journal.approval_tool
            || !journal.approval_schema_version
            || !journal.approval_resolutions_hash
            || !journal.workspace_id
            || !journal.session_id
            || !journal.workspace_revision
            || !journal.interpretation_id
            || !journal.change_set_id
            || !journal.change_set_hash
            || !journal.requested_op_ids?.length)
            return false;
        const selectedIds = sortedIds(stored.selected_op_ids);
        const requestedIds = sortedIds(journal.requested_op_ids);
        if (!selectedIds || !requestedIds)
            return false;
        if (stored.approval_id !== journal.approval_id
            || stored.token_hash !== journal.approval_token_hash
            || stored.payload_hash !== journal.approval_payload_hash
            || stored.tool !== journal.approval_tool
            || stored.schema_version !== journal.approval_schema_version
            || stored.workspace_id !== journal.workspace_id
            || stored.session_id !== journal.session_id
            || stored.workspace_fingerprint !== workspaceFingerprint(workspace)
            || stored.change_set_id !== journal.change_set_id
            || stored.change_set_hash !== journal.change_set_hash
            || stored.base_revision !== journal.workspace_revision
            || stored.interpretation_id !== journal.interpretation_id
            || canonicalJson(selectedIds) !== canonicalJson(requestedIds)
            || journal.approval_resolutions_hash !== hashText(canonicalJson(stored.resolutions || {})))
            return false;
        const payload = stored.payload;
        validateChangeSetDocument(payload, { verifyHash: true });
        const document = payload;
        if (hashText(canonicalJson(payload)) !== stored.payload_hash
            || document.change_set_id !== journal.change_set_id
            || document.change_set_hash !== journal.change_set_hash
            || document.workspace_revision !== journal.workspace_revision
            || document.interpretation_id !== journal.interpretation_id
            || canonicalJson(sortedIds(document.operations.map(operation => operation.op_id)) || [])
                !== canonicalJson(requestedIds))
            return false;
        return true;
    }
    catch {
        return false;
    }
}
function copyApprovalBindingToJournal(journal, approval) {
    journal.approval_id = approval.approval_id;
    journal.approval_token_hash = approval.token_hash;
    journal.approval_payload_hash = approval.payload_hash;
    journal.approval_tool = approval.tool;
    journal.approval_schema_version = approval.schema_version;
    journal.approval_resolutions_hash = hashText(canonicalJson(approval.resolutions || {}));
    journal.approval_consumed = true;
}
async function ensureTransactionApproval(workspace, changeSet, journal, options) {
    const stored = journal.approval_id ? readApproval(workspace, journal.approval_id) : undefined;
    // A true flag is not sufficient by itself: validate the durable record too,
    // so a tampered/deleted approval cannot silently authorize a retry.
    if (journal.approval_consumed === true) {
        if (!approvalMatchesJournal(workspace, journal, stored))
            throw new Error('事务批准绑定无法验证，请重新审阅');
        return;
    }
    // If the process stopped after consuming the token but before persisting the
    // journal flag, recognize that durable state and continue idempotently.
    if (approvalMatchesJournal(workspace, journal, stored)) {
        copyApprovalBindingToJournal(journal, stored);
        journal.updated_at = new Date().toISOString();
        await writeJournal(workspace, journal);
        return;
    }
    // Full change-set context is required to validate a newly supplied token;
    // validation happens before consumption and the journal flag is persisted
    // immediately after the atomic consume.
    await verifyApproval(workspace, changeSet, options);
    const consumed = consumeVerifiedApproval(workspace, changeSet, options);
    if (journal.approval_id && consumed.approval_id !== journal.approval_id)
        throw new Error('批准记录与事务不一致');
    if (journal.approval_token_hash && consumed.token_hash !== journal.approval_token_hash)
        throw new Error('批准令牌与事务不一致');
    copyApprovalBindingToJournal(journal, consumed);
    journal.updated_at = new Date().toISOString();
    await writeJournal(workspace, journal);
}
async function recoverApprovalFlag(workspace, journal) {
    const stored = journal.approval_id ? readApproval(workspace, journal.approval_id) : undefined;
    if (!approvalMatchesJournal(workspace, journal, stored))
        return false;
    if (journal.approval_consumed !== true) {
        copyApprovalBindingToJournal(journal, stored);
        journal.updated_at = new Date().toISOString();
        await writeJournal(workspace, journal);
    }
    return true;
}
/** Apply a typed change set using a durable journal and operation idempotency. */
export async function applyChangeSet(workspace, changeSet, options = {}) {
    const now = options.now || new Date();
    validateProtocolChangeSet(changeSet);
    const { normalized, refs } = await validateChangeSet(workspace, changeSet, options);
    const changeSetHash = computeChangeSetHash(normalized);
    return withWorkspaceLock(workspace, async () => {
        const existing = await findExistingTransaction(workspace, normalized.change_set_id, changeSetHash);
        if (existing?.status === 'completed') {
            await assertResumeContext(workspace, existing, options);
            return revalidateCompletedTransaction(workspace, existing);
        }
        if (existing)
            await assertResumeContext(workspace, existing, options);
        if (existing && ['applying', 'recoverable', 'partially_applied'].includes(existing.status)) {
            try {
                // Validate the durable approval even when the journal flag is already
                // true. This keeps retries idempotent without trusting mutable journal
                // state as authorization.
                await ensureTransactionApproval(workspace, normalized, existing, options);
            }
            catch (error) {
                existing.status = 'recoverable';
                existing.failure = error?.message || String(error);
                existing.updated_at = new Date().toISOString();
                existing.invariant_results = invariants(existing);
                await writeJournal(workspace, existing);
                return resultFromJournal(existing);
            }
            return resumeTransaction(workspace, existing, options);
        }
        if (existing) {
            throw new Error(`变更集已有终止事务 ${existing.transaction_id}（${existing.status}）；请依据事务证据生成新的 change_set_id`);
        }
        // A proposal is valid only against the exact authoritative workspace it
        // was formed from. This check happens before consuming approval and before
        // any staging side effect.
        await assertWorkspaceRevision(workspace, normalized.workspace_revision, 'apply preflight');
        const approval = await verifyApproval(workspace, normalized, options);
        const transactionId = `tx_${randomUUID()}`;
        const journal = {
            schema: TRANSACTION_SCHEMA,
            transaction_id: transactionId,
            change_set_id: normalized.change_set_id,
            change_set_hash: changeSetHash,
            workspace: path.resolve(workspace),
            // Persist the binding returned by the durable approval, including the
            // derived workspace id when the caller omitted one.
            workspace_id: approval.workspace_id,
            session_id: approval.session_id,
            ...(options.actor ? { actor: options.actor } : {}),
            ...(normalized.workspace_revision ? { workspace_revision: normalized.workspace_revision } : {}),
            ...(normalized.workspace_revision ? { current_workspace_revision: normalized.workspace_revision } : {}),
            interpretation_id: normalized.interpretation_id,
            approval_id: approval.approval_id,
            approval_token_hash: approval.token_hash,
            approval_payload_hash: approval.payload_hash,
            approval_tool: approval.tool,
            approval_schema_version: approval.schema_version,
            approval_resolutions_hash: hashText(canonicalJson(approval.resolutions || {})),
            approval_consumed: false,
            status: 'applying',
            created_at: now.toISOString(),
            updated_at: now.toISOString(),
            requested_op_ids: normalized.operations.map(operation => operation.op_id),
            operations: [],
            completed_ops: [],
            skipped_ops: [],
            failed_ops: [],
            references_resolved: true,
            recovery_attempts: 0,
        };
        let journalPersisted = false;
        try {
            for (let index = 0; index < normalized.operations.length; index++) {
                const item = await stageOperation(workspace, journal, normalized.operations[index], refs[index], now);
                journal.operations.push(item);
            }
            // No business side effect occurs during staging. Persist the complete
            // journal only after every operation has an exact staged image, so a
            // crash cannot leave a journal that silently forgets later operations.
            await writeJournal(workspace, journal);
            journalPersisted = true;
            await assertWorkspaceRevision(workspace, journal.workspace_revision, 'before commit');
            const consumed = consumeVerifiedApproval(workspace, normalized, options);
            copyApprovalBindingToJournal(journal, consumed);
            journal.updated_at = new Date().toISOString();
            await writeJournal(workspace, journal);
            journalPersisted = true;
            return resumeTransaction(workspace, journal, options);
        }
        catch (error) {
            journal.failure = error?.message || String(error);
            if (journalPersisted) {
                // All staged images are still available. Keep the transaction
                // recoverable and leave the approval pending when commit-time checks
                // fail, so a corrected retry does not require a phantom new write.
                journal.status = journal.completed_ops.length ? 'partially_applied' : 'recoverable';
                journal.failed_ops = journal.operations.filter(item => item.status === 'failed').map(item => item.op_id);
            }
            else {
                journal.status = 'failed';
                journal.failed_ops = [...journal.requested_op_ids];
                for (const item of journal.operations) {
                    item.status = 'failed';
                    item.error ||= journal.failure;
                }
            }
            journal.updated_at = new Date().toISOString();
            journal.invariant_results = invariants(journal);
            await writeJournal(workspace, journal);
            return resultFromJournal(journal);
        }
    });
}
async function resumeTransaction(workspace, journal, options) {
    await assertResumeContext(workspace, journal, options);
    journal.status = 'applying';
    journal.recovery_attempts = (journal.recovery_attempts || 0) + 1;
    await writeJournal(workspace, journal);
    for (const item of journal.operations) {
        if (item.status === 'skipped')
            continue;
        if (item.status === 'applied') {
            try {
                await repairAppliedOperationDerivatives(workspace, item);
            }
            catch (error) {
                // Keep the operation applied: its authoritative file is intact, and a
                // later retry can safely repair the missing derivative. Never mark a
                // derivative-only failure as a business mutation failure.
                journal.status = 'recoverable';
                journal.failure = error?.message || String(error);
                journal.updated_at = new Date().toISOString();
                journal.invariant_results = await verifyWriteInvariants(workspace, journal);
                await writeJournal(workspace, journal);
                return resultFromJournal(journal);
            }
            journal.current_workspace_revision = await currentWorkspaceRevision(workspace);
            journal.updated_at = new Date().toISOString();
            await writeJournal(workspace, journal);
            continue;
        }
        try {
            const result = await commitOperation(workspace, item);
            item.status = 'applied';
            item.result = result;
            item.completed_at = new Date().toISOString();
            journal.completed_ops = Array.from(new Set([...journal.completed_ops, item.op_id]));
            journal.failed_ops = journal.failed_ops.filter(opId => opId !== item.op_id);
            journal.current_workspace_revision = await currentWorkspaceRevision(workspace);
        }
        catch (error) {
            item.status = 'failed';
            item.error = error?.message || String(error);
            journal.failed_ops = Array.from(new Set([...journal.failed_ops, item.op_id]));
            journal.status = journal.completed_ops.length ? 'partially_applied' : 'recoverable';
            journal.failure = item.error;
            journal.updated_at = new Date().toISOString();
            journal.invariant_results = await verifyWriteInvariants(workspace, journal);
            await writeJournal(workspace, journal);
            return resultFromJournal(journal);
        }
        journal.updated_at = new Date().toISOString();
        await writeJournal(workspace, journal);
    }
    journal.failed_ops = journal.operations.filter(item => item.status === 'failed').map(item => item.op_id);
    journal.status = journal.failed_ops.length ? 'partially_applied' : 'completed';
    journal.invariant_results = await verifyWriteInvariants(workspace, journal);
    if (!Object.values(journal.invariant_results).every(Boolean)) {
        journal.status = journal.completed_ops.length ? 'partially_applied' : 'failed';
        journal.failure = '写后不变量未满足';
    }
    journal.updated_at = new Date().toISOString();
    journal.current_workspace_revision = await currentWorkspaceRevision(workspace);
    await writeJournal(workspace, journal);
    return resultFromJournal(journal);
}
/** Recover journals left in applying/recoverable state after a process stop. */
export async function recoverTransactions(workspace, options = {}) {
    const root = transactionRoot(workspace);
    let names = [];
    try {
        names = await fs.readdir(root);
    }
    catch (error) {
        if (error?.code !== 'ENOENT')
            throw error;
    }
    const results = [];
    await withWorkspaceLock(workspace, async () => {
        const candidates = new Set(names.filter(item => item.endsWith('.json')));
        for (const name of names.filter(item => item.endsWith('.json.before.bak'))) {
            candidates.add(name.slice(0, -'.before.bak'.length));
        }
        for (const name of candidates) {
            const journal = await loadJournal(workspace, name.slice(0, -5));
            if (!journal || !['applying', 'recoverable', 'partially_applied'].includes(journal.status))
                continue;
            try {
                // Recovery is an operation on the already persisted transaction. When
                // invoked by the host without session metadata, inherit the journal's
                // binding rather than treating an omitted context as a new caller;
                // explicit mismatching values still fail in assertResumeContext.
                const recoveryOptions = {
                    ...options,
                    ...(options.workspaceId || !journal.workspace_id ? {} : { workspaceId: journal.workspace_id }),
                    ...(options.sessionId || !journal.session_id ? {} : { sessionId: journal.session_id }),
                };
                if (!(await recoverApprovalFlag(workspace, journal))) {
                    journal.status = 'recoverable';
                    journal.failure = '事务尚未记录已消费的批准；请通过 dealpilot_apply 重新提交完整 change-set，并让宿主批准当前预览';
                    journal.updated_at = new Date().toISOString();
                    journal.invariant_results = invariants(journal);
                    await writeJournal(workspace, journal);
                    results.push(resultFromJournal(journal));
                    continue;
                }
                results.push(await resumeTransaction(workspace, journal, recoveryOptions));
            }
            catch (error) {
                // Recovery must never guess a missing session/workspace binding. Keep
                // the journal auditable and return a recoverable result for the caller
                // to retry with the correct context.
                journal.status = 'recoverable';
                journal.failure = error?.message || String(error);
                journal.updated_at = new Date().toISOString();
                journal.invariant_results = invariants(journal);
                await writeJournal(workspace, journal);
                results.push(resultFromJournal(journal));
            }
        }
    });
    return results;
}
export async function readTransaction(workspace, transactionId) {
    return loadJournal(workspace, transactionId);
}
export async function listTransactions(workspace) {
    let names = [];
    try {
        names = await fs.readdir(transactionRoot(workspace));
    }
    catch (error) {
        if (error?.code !== 'ENOENT')
            throw error;
    }
    const records = [];
    const candidates = new Set(names.filter(item => item.endsWith('.json')));
    for (const name of names.filter(item => item.endsWith('.json.before.bak'))) {
        candidates.add(name.slice(0, -'.before.bak'.length));
    }
    for (const name of candidates) {
        const record = await loadJournal(workspace, name.slice(0, -5));
        if (record)
            records.push(record);
    }
    return records.sort((a, b) => b.created_at.localeCompare(a.created_at));
}
