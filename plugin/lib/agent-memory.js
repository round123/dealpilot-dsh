import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveWorkspace } from './okf-utils.js';
import { getDealPilotSession } from './dealpilot-session.js';
import { computeWorkspaceRevision } from './workspace-revision.js';
import { EVIDENCE_SCHEMA, readImportJob, validateCanonicalDocument, } from './canonical-import.js';
import { paginateEvidence, validateEvidenceDocument } from './evidence-contract.js';
import { INTERPRETATION_SCHEMA, collectInterpretationObservationIds, interpretationCoverageAccounting, loadInterpretation, saveInterpretation, validateInterpretationAgainstEvidence, validateInterpretationDocument, } from './interpretation-contract.js';
import { CHANGE_SET_SCHEMA, buildChangeSetPreview, computeChangeSetHash, loadChangeSet, saveChangeSet, validateChangeSetAgainstInterpretation, validateChangeSetDocument, } from './change-set-contract.js';
import { applyChangeSet, listTransactions } from './mutation-kernel.js';
import { createApproval, readApproval, revokeApproval } from './approval-store.js';
import { resolveArtifactForWrite, resolveRegularArtifact } from './artifact-store.js';
const PROPOSAL_SCHEMA = 'dealpilot.proposal/v2';
function proposalReference(id) {
    if (!/^prop_[A-Za-z0-9_-]+$/u.test(id))
        throw new Error('提案编号格式无效');
    return `storage/proposals/${id}.json`;
}
function sessionInfo(exec) {
    const sessionId = String(exec?.agent?.id || '');
    const context = getDealPilotSession(sessionId);
    if (!context)
        throw new Error('请先选择 DealPilot Workspace');
    return { sessionId, workspaceId: context.workspaceId };
}
function safeRelative(workspace, value) {
    if (typeof value !== 'string' || !value.trim() || path.isAbsolute(value) || /^[A-Za-z]:[\\/]/u.test(value) || value.includes('..')) {
        throw new Error('引用必须是当前 Workspace 内的相对路径');
    }
    const normalized = value.replaceAll('\\', '/');
    const root = path.resolve(workspace);
    const resolved = path.resolve(root, normalized);
    const relative = path.relative(root, resolved);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
        throw new Error('引用必须位于当前 Workspace');
    return relative.replaceAll('\\', '/');
}
/** Resolve a workspace reference through real paths before opening it.
 * Lexical path checks alone allow an in-workspace symlink to expose files
 * outside the workspace. Keep the user-facing reference lexical, but read
 * from the verified real path.
 */
async function resolveRealReference(workspace, ref) {
    const relative = safeRelative(workspace, ref);
    const root = await fs.realpath(path.resolve(workspace));
    const lexical = path.resolve(root, relative);
    const lexicalRelative = path.relative(root, lexical);
    if (!lexicalRelative || lexicalRelative.startsWith('..') || path.isAbsolute(lexicalRelative)) {
        throw new Error('引用必须位于当前 Workspace');
    }
    let filePath;
    try {
        filePath = await fs.realpath(lexical);
    }
    catch (error) {
        if (error?.code === 'ENOENT')
            throw new Error(`找不到引用：${relative}`);
        throw error;
    }
    const realRelative = path.relative(root, filePath);
    if (!realRelative || realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
        throw new Error('引用真实路径位于当前 Workspace 之外');
    }
    return { relative, filePath };
}
async function readJsonFile(workspace, ref) {
    const { relative, filePath } = await resolveRealReference(workspace, ref);
    try {
        return JSON.parse(await fs.readFile(filePath, 'utf8'));
    }
    catch (error) {
        if (error?.code === 'ENOENT')
            throw new Error(`找不到引用：${relative}`);
        if (error instanceof SyntaxError)
            throw new Error(`JSON 内容无效：${relative}`);
        throw error;
    }
}
async function readReference(workspace, ref) {
    const { relative, filePath } = await resolveRealReference(workspace, ref);
    let stat;
    try {
        stat = await fs.stat(filePath);
    }
    catch (error) {
        if (error?.code === 'ENOENT')
            throw new Error(`找不到引用：${relative}`);
        throw error;
    }
    if (!stat.isFile())
        throw new Error('引用必须指向文件');
    const content = await fs.readFile(filePath, 'utf8');
    if (relative.endsWith('.json')) {
        let parsed;
        try {
            parsed = JSON.parse(content);
        }
        catch {
            throw new Error(`JSON 内容无效：${relative}`);
        }
        if (parsed?.schema === EVIDENCE_SCHEMA)
            validateCanonicalDocument(parsed);
        if (parsed?.schema === EVIDENCE_SCHEMA) {
            // Canonical evidence is immutable only when its archived source bytes
            // and import manifest are checked together.  A self-consistent JSON
            // digest alone cannot prove that the source was not replaced.
            const importMatch = /^sources\/imports\/(imp_[A-Za-z0-9_-]+)\/canonical\.json$/u.exec(relative);
            if (importMatch) {
                const job = await readImportJob(workspace, importMatch[1]);
                if (job.canonical_ref !== relative || job.evidence_digest !== parsed.evidence_digest) {
                    throw new Error('Evidence artifact 与 Import job 的来源或 digest 不一致');
                }
            }
        }
        if (parsed?.schema === INTERPRETATION_SCHEMA)
            validateInterpretationDocument(parsed);
        if (parsed?.schema === CHANGE_SET_SCHEMA)
            validateChangeSetDocument(parsed);
    }
    return { ref: relative, content };
}
function parsedSchema(content) {
    try {
        return JSON.parse(content)?.schema;
    }
    catch {
        return undefined;
    }
}
async function readEvidenceForInterpretation(workspace, interpretation, explicitRef) {
    const job = await readImportJob(workspace, interpretation.import_job_id);
    if (job.canonical_ref !== interpretation.canonical_ref)
        throw new Error('解释的 canonical_ref 与 Import job 不一致');
    if (job.evidence_digest !== interpretation.evidence_digest)
        throw new Error('解释的 evidence_digest 与 Import job 不一致');
    const ref = explicitRef ? safeRelative(workspace, explicitRef) : interpretation.canonical_ref;
    if (ref !== job.canonical_ref)
        throw new Error('显式 evidence_ref 与解释绑定的 canonical_ref 不一致');
    const value = await readJsonFile(workspace, ref);
    if (value?.schema !== EVIDENCE_SCHEMA)
        throw new Error(`解释必须绑定 ${EVIDENCE_SCHEMA} 证据`);
    validateEvidenceDocument(value);
    if (value.evidence_digest !== job.evidence_digest)
        throw new Error('Canonical evidence digest 与 Import job 不一致');
    return value;
}
function allObservationIds(evidence) {
    const result = new Set();
    for (const sheet of evidence.sheets) {
        for (const column of sheet.columns)
            result.add(column.header.observation_id);
        for (const row of sheet.rows)
            for (const cell of row.cells)
                result.add(cell.observation_id);
    }
    return result;
}
async function resolveInterpretationAndEvidence(workspace, interpretation, evidenceRef) {
    const evidence = await readEvidenceForInterpretation(workspace, interpretation, evidenceRef);
    validateInterpretationAgainstEvidence(interpretation, evidence);
    return evidence;
}
async function writeExclusiveJson(filePath, value) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    try {
        await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    }
    catch (error) {
        if (error?.code === 'EEXIST')
            throw new Error('提案编号冲突，请重试');
        throw error;
    }
}
async function saveProposal(workspace, proposal) {
    const destination = await resolveArtifactForWrite(workspace, proposalReference(proposal.proposal_id), 'Proposal');
    await writeExclusiveJson(destination, proposal);
}
async function updateProposal(workspace, proposal) {
    const destination = await resolveArtifactForWrite(workspace, proposalReference(proposal.proposal_id), 'Proposal');
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    let handle;
    try {
        handle = await fs.open(temporary, 'wx', 0o600);
        await handle.writeFile(`${JSON.stringify(proposal, null, 2)}\n`, 'utf8');
        await handle.sync();
        await handle.close();
        handle = undefined;
        try {
            await fs.rename(temporary, destination);
        }
        catch (error) {
            if (!['EEXIST', 'EPERM', 'ENOTEMPTY'].includes(error?.code))
                throw error;
            const backup = `${destination}.${process.pid}.${randomUUID()}.bak`;
            await fs.rename(destination, backup);
            try {
                await fs.rename(temporary, destination);
            }
            catch (replaceError) {
                await fs.rename(backup, destination).catch(() => undefined);
                throw replaceError;
            }
            await fs.rm(backup, { force: true });
        }
    }
    finally {
        await handle?.close().catch(() => undefined);
        await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
}
async function loadProposal(workspace, id) {
    const destination = await resolveRegularArtifact(workspace, proposalReference(id), 'Proposal');
    try {
        const value = JSON.parse(await fs.readFile(destination, 'utf8'));
        if (value?.schema !== PROPOSAL_SCHEMA || value.proposal_id !== id)
            throw new Error('invalid');
        return value;
    }
    catch {
        throw new Error(`提案不存在：${id}`);
    }
}
async function referenceResolver(workspace, interpretation, evidence) {
    const observations = allObservationIds(evidence);
    const claims = new Set(interpretation.claims.map((claim) => claim.claim_id));
    return async (ref) => {
        if (observations.has(ref) || claims.has(ref))
            return true;
        try {
            const resolved = await resolveRealReference(workspace, ref);
            await fs.stat(resolved.filePath);
            return true;
        }
        catch {
            return false;
        }
    };
}
function typedChangeSet(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error(`只接受 ${CHANGE_SET_SCHEMA} 对象`);
    const candidate = value;
    if (candidate.schema !== CHANGE_SET_SCHEMA)
        throw new Error(`只接受 ${CHANGE_SET_SCHEMA} 的 change_set 字段；请先记录 interpretation 并提供完整 typed 变更集`);
    return candidate;
}
function selectedOperationIds(changeSet) { return changeSet.operations.map((operation) => operation.op_id); }
function resultFromTransaction(record) {
    const results = record.operations.filter((item) => item.result).map((item) => item.result);
    const invariants = record.invariant_results || {};
    return {
        ok: record.status === 'completed' && Object.values(invariants).every(Boolean),
        transaction_id: record.transaction_id,
        change_set_id: record.change_set_id,
        status: record.status,
        results,
        completed_ops: [...record.completed_ops],
        skipped_ops: [...record.skipped_ops],
        failed_ops: [...record.failed_ops],
        invariants,
        ...(record.failure ? { error: record.failure } : {}),
    };
}
async function findPersistedTransaction(workspace, changeSet) {
    try {
        const hash = computeChangeSetHash(changeSet);
        return (await listTransactions(workspace)).find((record) => record.change_set_id === changeSet.change_set_id && record.change_set_hash === hash);
    }
    catch {
        return undefined;
    }
}
/**
 * Ask the host's user-approval seam before minting a durable DealPilot token.
 *
 * The durable approval store is deliberately not the interaction channel: a
 * model-facing tool call may create a preview, but it must not be able to turn
 * that preview into its own authorization. The host owns the answerer and the
 * `allowed-once` decision; all other outcomes remain fail-closed.
 */
async function requestHostApproval(hostCtx, exec, proposal, changeSet, preview) {
    let approval;
    try {
        approval = hostCtx?.get?.('approval') ?? hostCtx?.approval;
    }
    catch {
        approval = hostCtx?.approval;
    }
    if (!approval || typeof approval.request !== 'function' || !exec?.agent)
        return 'unavailable';
    const reason = [
        'DealPilot 需要用户批准一组完整、可追溯的业务变更。',
        `proposal_id=${proposal.proposal_id}`,
        `change_set_id=${changeSet.change_set_id}`,
        `change_set_hash=${computeChangeSetHash(changeSet)}`,
        `preview=${JSON.stringify(preview)}`,
        '请逐项核对 before/after、证据引用、冲突和未决项；仅批准当前完整变更集。',
    ].join('\n');
    try {
        const outcome = await approval.request({
            agent: exec.agent,
            toolName: 'dealpilot_apply',
            ...(exec.callId ? { callId: exec.callId } : {}),
            reason,
            ...(exec.signal ? { signal: exec.signal } : {}),
        });
        return outcome === 'allowed-once' || outcome === 'rejected' || outcome === 'cancelled' || outcome === 'unavailable'
            ? outcome
            : 'unavailable';
    }
    catch {
        return 'unavailable';
    }
}
export function registerAgentMemoryTools(ctx, harness, hostCtx) {
    harness.registerTool(ctx, harness.defineTool({
        name: 'dealpilot_read',
        description: '读取证据、解释和 OKF 原文。evidence/v2 支持稳定 observation、分页 cursor 和来源定位；读取本身不做业务解释。',
        parameters: { type: 'object', properties: {
                ref: { type: 'string', description: 'Workspace 内相对引用' }, sheet: { type: 'string', description: '工作表名称或 sheet_id' }, range: { type: 'string', description: 'A1 范围' }, include_raw: { type: 'boolean' }, cursor: { type: 'string' }, max_items: { type: 'number' }, offset: { type: 'number' }, max_chars: { type: 'number' },
            }, required: ['ref'] },
        async execute(args) {
            const workspace = resolveWorkspace(ctx.config);
            const result = await readReference(workspace, String(args.ref));
            const schema = parsedSchema(result.content);
            if (schema === EVIDENCE_SCHEMA) {
                const evidence = JSON.parse(result.content);
                const page = paginateEvidence(evidence, { ...(args.sheet ? { sheet: String(args.sheet) } : {}), ...(args.range ? { range: String(args.range) } : {}), ...(args.cursor ? { cursor: String(args.cursor) } : {}), ...(args.max_items !== undefined ? { max_items: Number(args.max_items) } : {}), include_raw: args.include_raw !== false });
                return JSON.stringify({ ...page, ref: result.ref, citation: page.citation.map((item) => ({ ...item, ref: result.ref })), truncated: Boolean(page.next_cursor) });
            }
            const readable = result.content;
            const requestedOffset = Number(args.offset ?? 0);
            const requestedMax = Number(args.max_chars ?? 50000);
            const offset = Number.isFinite(requestedOffset) ? Math.max(0, Math.floor(requestedOffset)) : 0;
            const max = Number.isFinite(requestedMax) ? Math.min(200000, Math.max(1, Math.floor(requestedMax))) : 50000;
            return JSON.stringify({ ...result, content: readable.slice(offset, offset + max), truncated: offset + max < readable.length, offset, total_chars: readable.length });
        },
    }));
    harness.registerTool(ctx, harness.defineTool({
        name: 'dealpilot_record_interpretation',
        description: '保存 LLM 对 evidence/v2 的可修正解释。每个 claim 必须引用 observation，每个 observation 必须标记 mapped、unresolved 或 ignored。',
        parameters: { type: 'object', properties: { interpretation: { type: 'object', additionalProperties: true }, evidence_ref: { type: 'string' } }, required: ['interpretation'] },
        async execute(args, exec) {
            const workspace = resolveWorkspace(ctx.config);
            const { sessionId } = sessionInfo(exec);
            const value = args.interpretation;
            if (!value || typeof value !== 'object' || value.schema !== INTERPRETATION_SCHEMA)
                throw new Error(`只接受 ${INTERPRETATION_SCHEMA} 解释文档`);
            if (typeof value.interpretation_id !== 'string' || !value.interpretation_id)
                throw new Error('interpretation.interpretation_id 必须是非空字符串');
            if (typeof value.import_job_id !== 'string' || !value.import_job_id)
                throw new Error('interpretation.import_job_id 必须是非空字符串');
            if (typeof value.canonical_ref !== 'string' || !value.canonical_ref)
                throw new Error('interpretation.canonical_ref 必须是非空字符串');
            const evidence = await resolveInterpretationAndEvidence(workspace, value, args.evidence_ref ? String(args.evidence_ref) : undefined);
            validateInterpretationAgainstEvidence(value, evidence);
            const saved = await saveInterpretation(workspace, value, { evidence });
            const coverage = interpretationCoverageAccounting(saved);
            return JSON.stringify({ ok: true, interpretation_id: saved.interpretation_id, ref: `storage/interpretations/${saved.interpretation_id}.json`, import_job_id: saved.import_job_id, session_id: sessionId, evidence_digest: saved.evidence_digest, claims: saved.claims.length, coverage, observation_count: collectInterpretationObservationIds(saved).size, message: `解释已保存：${coverage.mapped} mapped，${coverage.unresolved} unresolved，${coverage.ignored} ignored` });
        },
    }));
    harness.registerTool(ctx, harness.defineTool({
        name: 'dealpilot_propose',
        description: '保存严格的 change-set/v2 变更集。Harness 校验实体路由、证据引用、目标版本和完整 accounting，不直接写入业务文件。',
        parameters: { type: 'object', properties: { change_set: { type: 'object', additionalProperties: true }, evidence_ref: { type: 'string' } }, required: ['change_set'] },
        async execute(args, exec) {
            const workspace = resolveWorkspace(ctx.config);
            const { sessionId, workspaceId } = sessionInfo(exec);
            if (args.operations !== undefined)
                throw new Error(`请先记录 interpretation，再提供完整 ${CHANGE_SET_SCHEMA} 的 change_set 字段`);
            const candidate = typedChangeSet(args.change_set);
            if (typeof candidate.interpretation_id !== 'string' || !candidate.interpretation_id)
                throw new Error('change_set.interpretation_id 必须是非空字符串');
            const interpretation = await loadInterpretation(workspace, candidate.interpretation_id);
            const evidence = await resolveInterpretationAndEvidence(workspace, interpretation, args.evidence_ref ? String(args.evidence_ref) : undefined);
            const ids = allObservationIds(evidence);
            validateInterpretationAgainstEvidence(interpretation, evidence);
            validateChangeSetAgainstInterpretation(candidate, interpretation, { evidence });
            const currentRevision = await computeWorkspaceRevision(workspace);
            if (candidate.workspace_revision !== currentRevision)
                throw new Error('Workspace 在形成变更集后发生变化；请重新读取并生成带当前 workspace_revision 的变更集');
            const prepared = { ...candidate, created_at: candidate.created_at || new Date().toISOString() };
            const changeSet = { ...prepared, change_set_hash: computeChangeSetHash(prepared) };
            const saved = await saveChangeSet(workspace, changeSet, { interpretation, evidence, verifyHash: true });
            const preview = buildChangeSetPreview(saved, { interpretation, evidence });
            const proposal = { schema: PROPOSAL_SCHEMA, proposal_id: `prop_${randomUUID()}`, session_id: sessionId, workspace_id: workspaceId, change_set_id: saved.change_set_id, change_set_hash: computeChangeSetHash(saved), interpretation_id: saved.interpretation_id, change_set_ref: `storage/change-sets/${saved.change_set_id}.json`, status: 'proposed', created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
            await saveProposal(workspace, proposal);
            return JSON.stringify({ ok: true, proposal_id: proposal.proposal_id, status: proposal.status, change_set_id: saved.change_set_id, change_set_hash: proposal.change_set_hash, interpretation_id: saved.interpretation_id, preview, accounting: saved.accounting, message: '变更集已保存，等待用户审阅具体 before/after、来源和未决项。' });
        },
    }));
    harness.registerTool(ctx, harness.defineTool({
        name: 'dealpilot_apply',
        description: '消费绑定当前 Workspace、session、解释版本、目标版本和完整 change-set hash 的用户批准，并通过 mutation kernel 事务化应用。',
        parameters: { type: 'object', properties: { proposal_id: { type: 'string' } }, required: ['proposal_id'] },
        async execute(args, exec) {
            const workspace = resolveWorkspace(ctx.config);
            const { sessionId, workspaceId } = sessionInfo(exec);
            const proposal = await loadProposal(workspace, String(args.proposal_id));
            if (proposal.session_id !== sessionId || proposal.workspace_id !== workspaceId)
                throw new Error('提案不属于当前 session 或 Workspace');
            if (proposal.status === 'completed')
                return JSON.stringify({ ok: true, proposal_id: proposal.proposal_id, approval_id: proposal.approval_id, status: proposal.status, transaction_id: proposal.transaction_id, result: proposal.last_result, message: '变更集已经应用；返回之前的事务结果。' });
            if (proposal.status === 'failed')
                throw new Error('提案已终止，不能重新授权同一变更集；请依据事务记录生成新的 change-set');
            const interpretation = await loadInterpretation(workspace, proposal.interpretation_id);
            const evidence = await readEvidenceForInterpretation(workspace, interpretation);
            const ids = allObservationIds(evidence);
            const changeSet = await loadChangeSet(workspace, proposal.change_set_id, { interpretation, evidence, verifyHash: true });
            if (computeChangeSetHash(changeSet) !== proposal.change_set_hash)
                throw new Error('提案记录与持久化变更集不一致，请重新生成提案');
            validateInterpretationAgainstEvidence(interpretation, evidence);
            validateChangeSetAgainstInterpretation(changeSet, interpretation, { evidence });
            const preview = buildChangeSetPreview(changeSet, { interpretation, evidence });
            const binding = {
                tool: 'dealpilot_apply', workspacePath: workspace, workspaceId, sessionId,
                payload: changeSet, schemaVersion: CHANGE_SET_SCHEMA,
                baseRevision: changeSet.workspace_revision, changeSetId: changeSet.change_set_id,
                changeSetHash: computeChangeSetHash(changeSet), interpretationId: changeSet.interpretation_id,
                selectedOpIds: selectedOperationIds(changeSet), actor: 'user',
            };
            // A pending durable record is an internal retry handle. It is never
            // returned to the model as a bearer token and remains bound to the
            // exact proposal/change-set by the mutation kernel.
            let approval = proposal.approval_id ? readApproval(workspace, proposal.approval_id) : undefined;
            if (approval && !['pending', 'consumed'].includes(approval.status))
                approval = undefined;
            if (!approval && !['proposed', 'awaiting_approval'].includes(proposal.status)) {
                return JSON.stringify({ ok: false, requires_approval: false, approval_status: 'unavailable', proposal_id: proposal.proposal_id, change_set_id: changeSet.change_set_id, change_set_hash: computeChangeSetHash(changeSet), preview, message: '提案已进入终止状态，不能重新授权同一变更集；请依据事务记录生成新的 change-set。' });
            }
            if (!approval) {
                const currentRevision = await computeWorkspaceRevision(workspace);
                if (currentRevision !== changeSet.workspace_revision)
                    throw new Error('Workspace 已变化，原提案失效；请重新读取并生成变更集');
                // A model call can request approval, but cannot self-issue a durable
                // authorization. The host/UI owns the one-shot user decision.
                const approvalOutcome = await requestHostApproval(hostCtx, exec, proposal, changeSet, preview);
                if (approvalOutcome !== 'allowed-once') {
                    return JSON.stringify({
                        ok: false,
                        requires_approval: true,
                        approval_status: approvalOutcome,
                        proposal_id: proposal.proposal_id,
                        change_set_id: changeSet.change_set_id,
                        change_set_hash: computeChangeSetHash(changeSet),
                        preview,
                        message: approvalOutcome === 'rejected'
                            ? '用户未批准这组变更；请依据反馈修订 interpretation 或 change-set。'
                            : approvalOutcome === 'cancelled'
                                ? '审批已取消；变更集仍未执行。'
                                : '当前没有可用的用户审批通道；变更集未执行，也没有生成批准令牌。',
                    });
                }
                approval = createApproval({ ...binding, preview }).record;
                proposal.status = 'awaiting_approval';
                proposal.approval_id = approval.approval_id;
                proposal.updated_at = new Date().toISOString();
                // Persist the durable handle before any mutation so a crash cannot
                // leave a successful write without an auditable proposal link.
                await updateProposal(workspace, proposal);
            }
            const resolver = await referenceResolver(workspace, interpretation, evidence);
            let result;
            try {
                // Pass the durable record directly; its plaintext token never enters
                // the model transcript or tool result.
                result = await applyChangeSet(workspace, changeSet, { approval, approvalTool: 'dealpilot_apply', sessionId, workspaceId, resolveReference: resolver });
            }
            catch (error) {
                const latest = proposal.approval_id ? readApproval(workspace, proposal.approval_id) : undefined;
                const persisted = await findPersistedTransaction(workspace, changeSet);
                const persistedResult = persisted ? resultFromTransaction(persisted) : undefined;
                if (persistedResult) {
                    proposal.status = persistedResult.status === 'recoverable' ? 'recoverable' : persistedResult.status === 'partially_applied' ? 'partially_applied' : 'failed';
                    proposal.transaction_id = persistedResult.transaction_id;
                    proposal.last_result = persistedResult;
                }
                else {
                    proposal.status = latest?.status === 'pending' ? 'awaiting_approval' : 'failed';
                }
                proposal.updated_at = new Date().toISOString();
                await updateProposal(workspace, proposal);
                const status = persistedResult?.status || proposal.status;
                const message = status === 'recoverable'
                    ? '事务已记录为可恢复；请依据 transaction_id 和失败原因修复后重试。'
                    : status === 'partially_applied'
                        ? '事务已部分完成；请依据逐项状态和 transaction_id 继续恢复。'
                        : latest?.status === 'pending'
                            ? '变更尚未提交；批准记录仍 pending，可在确认依据后重试。'
                            : '变更未完成；请依据错误和事务记录重新规划。';
                return JSON.stringify({ ok: persistedResult?.ok || false, requires_approval: !persistedResult && latest?.status === 'pending', approval_status: latest?.status || 'unavailable', proposal_id: proposal.proposal_id, approval_id: proposal.approval_id, change_set_id: changeSet.change_set_id, change_set_hash: computeChangeSetHash(changeSet), ...(persistedResult ? { status: persistedResult.status, transaction_id: persistedResult.transaction_id, completed_ops: persistedResult.completed_ops, skipped_ops: persistedResult.skipped_ops, failed_ops: persistedResult.failed_ops, invariants: persistedResult.invariants } : {}), preview, error: persistedResult?.error || error?.message || String(error), message });
            }
            if (result.status === 'failed' && proposal.approval_id) {
                const latest = readApproval(workspace, proposal.approval_id);
                // A terminal pre-commit failure must not leave a reusable pending
                // approval attached to a proposal that can no longer be retried.
                if (latest?.status === 'pending') {
                    try {
                        revokeApproval(workspace, proposal.approval_id, 'system', 'transaction failed before commit');
                    }
                    catch { /* keep the transaction result authoritative */ }
                }
            }
            proposal.status = result.status === 'completed' ? 'completed' : result.status === 'recoverable' ? 'recoverable' : result.status === 'partially_applied' ? 'partially_applied' : 'failed';
            proposal.transaction_id = result.transaction_id;
            proposal.last_result = result;
            proposal.updated_at = new Date().toISOString();
            await updateProposal(workspace, proposal);
            return JSON.stringify({ ok: result.ok, proposal_id: proposal.proposal_id, approval_id: proposal.approval_id, status: proposal.status, transaction_id: result.transaction_id, results: result.results, completed_ops: result.completed_ops, skipped_ops: result.skipped_ops, failed_ops: result.failed_ops, invariants: result.invariants, preview, ...(result.error ? { error: result.error } : {}), message: result.ok ? '变更集已通过事务校验并应用。' : '变更集未完全完成；请依据逐项状态恢复或重新规划。' });
        },
    }));
}
