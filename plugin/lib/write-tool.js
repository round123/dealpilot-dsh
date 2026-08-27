// DealPilot DSH — Write Tool
// Apply open-ended Agent-authored memory changes with stable workspace indexes.
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { readYamlFrontmatter, writeYamlFrontmatter, appendBusinessEvent, updateStorageIndex, generateRef, resolveWorkspace, readConceptDir, normalizeRef, } from './okf-utils.js';
import { syncGoalRuntime } from './goal-runtime.js';
import { createConfirmation, consumeConfirmation } from './confirmation.js';
import { writePresentation } from './business-view.js';
const BODY_SECTIONS = {
    customer: ['Profile', 'Qualification', 'Open questions'],
    deal: ['Goal', 'Confirmed facts', 'Inferences', 'Open questions', 'Risks', 'Correction history'],
    action: ['Reason', 'Check condition', 'Evidence'],
};
// ── Tool Registration ───────────────────────────────────────────────────────
export function registerWriteTool(ctx, harness) {
    harness.registerTool(ctx, harness.defineTool({
        name: 'dealpilot_write',
        description: `在 DealPilot OKF Workspace 中应用 Agent 形成的记忆变更。

支持文档创建、更新、正文追加、归档和关系维护。稳定元数据只用于索引和安全校验，fields 中的开放式内容会被保留并写入文档。

支持以下操作：
- create: 创建新对象（不需要 ref）
- update: 更新已有对象（需要 ref）
- append: 追加正文到已有文档（需要 ref）
- archive: 归档对象（设置 status: archived）
- merge: 合并两个同类对象（当前支持 customer；需要 ref 作为保留对象、source_ref 作为来源对象）

规则：
- 每个 Deal 最多一个 active Action
- 创建/更新后自动追加 business-events.jsonl
- 归档操作是高影响操作`,
        parameters: {
            type: 'object',
            properties: {
                operation: { type: 'string', enum: ['create', 'update', 'append', 'archive', 'merge'] },
                entity: { type: 'string', enum: ['customer', 'deal', 'action'] },
                kind: { type: 'string', description: '开放式文档类型；未提供 entity 时使用，例如 note、account 或任意工作记忆分类' },
                ref: { type: 'string', description: '目标对象引用路径（update/archive 时必需）' },
                source_ref: { type: 'string', description: '合并来源对象引用路径（merge 时必需；必须与 ref 同为 customer）' },
                fields: {
                    type: 'object',
                    description: 'Agent 根据当前证据形成的开放式内容；可包含正文区、扩展元数据和关系信息',
                },
                body: { type: 'string', description: '通用文档正文；可与 content 互换使用' },
                content: { type: 'object', additionalProperties: true, description: '通用文档内容；可以是结构化对象或带 format/value 的内容包装' },
                metadata: { type: 'object', description: '开放式元数据，不限业务字段' },
                evidence: { type: 'array', items: { type: 'object', additionalProperties: true }, description: '来源证据引用' },
                rationale: { type: 'string', description: '本次写入的原因' },
                uncertainty: { type: 'string', description: '尚未确定的部分' },
                confirmation_token: { type: 'string', description: '用户确认预览后返回的一次性确认令牌' },
            },
            required: ['operation'],
        },
        output: {
            schema: { type: 'object' },
            render(_args, value) {
                const result = JSON.parse(value);
                if (result.requires_confirmation) {
                    return [{ type: 'text', text: `${result.message}\nconfirmation_token: ${result.confirmation_token}\npreview: ${JSON.stringify(result.preview || {})}` }];
                }
                return [{ type: 'text', text: `${result.message || '销售对象已更新'}\nDATA_JSON: ${JSON.stringify(result)}` }];
            },
            presentationMeta(args, value) {
                return writePresentation(args, value);
            },
        },
        async execute(args) {
            const workspace = resolveWorkspace(ctx.config);
            if (!workspace) {
                throw new Error('No workspace configured. Set defaultWorkspace in agent preset.');
            }
            if (!args.entity)
                return JSON.stringify(await executeGenericWrite(workspace, args));
            const { operation, entity, ref, source_ref, fields, confirmation_token } = args;
            const normalizedFields = await normalizeRelationshipFields(workspace, entity, fields || {});
            const safeRef = ref ? normalizeRef(workspace, `knowledge/${entity}s/index.md`, ref) : undefined;
            const safeSourceRef = source_ref ? normalizeRef(workspace, `knowledge/${entity}s/index.md`, source_ref) : undefined;
            if (operation === 'merge') {
                if (entity !== 'customer')
                    throw new Error('目前仅支持合并 customer；请先分别确认其他对象的更新或归档');
                if (!safeRef || !safeSourceRef)
                    throw new Error('merge 操作需要 ref 和 source_ref 参数');
                if (safeRef === safeSourceRef)
                    throw new Error('merge 的目标和来源不能是同一个对象');
            }
            const confirmationPayload = { operation, entity, ref: safeRef || null, source_ref: safeSourceRef || null, fields: normalizedFields };
            if (!confirmation_token) {
                const preview = operation === 'merge'
                    ? await buildMergePreview(workspace, safeRef, safeSourceRef)
                    : operation === 'update' && safeRef
                        ? await buildUpdatePreview(workspace, entity, safeRef, normalizedFields)
                        : undefined;
                const hasConflict = Boolean(preview && Array.isArray(preview.changes) && preview.changes.some((change) => change.conflict));
                return JSON.stringify(createConfirmation('dealpilot_write', confirmationPayload, operation === 'merge'
                    ? '这是一个会合并并归档来源客户的高影响操作。请向用户展示目标、来源、字段冲突和影响，获得明确确认后再重试。'
                    : hasConflict
                        ? '检测到可能覆盖已有业务事实的字段。请核对变更前后值和来源，获得明确确认后再重试。'
                        : '这是一个会修改销售工作区的操作。请向用户展示目标、字段和影响，获得明确确认后再重试。', preview || confirmationPayload));
            }
            consumeConfirmation(confirmation_token, 'dealpilot_write', confirmationPayload);
            const now = new Date().toISOString();
            if (operation === 'create') {
                return JSON.stringify(await createEntity(workspace, entity, normalizedFields, now));
            }
            else if (operation === 'update') {
                if (!ref)
                    throw new Error('update 操作需要 ref 参数');
                return JSON.stringify(await updateEntity(workspace, entity, safeRef, normalizedFields, now));
            }
            else if (operation === 'append') {
                if (!ref)
                    throw new Error('append 操作需要 ref 参数');
                return JSON.stringify(await appendEntityBody(workspace, entity, safeRef, fields || {}, now));
            }
            else if (operation === 'archive') {
                if (!ref)
                    throw new Error('archive 操作需要 ref 参数');
                return JSON.stringify(await archiveEntity(workspace, entity, safeRef, now));
            }
            else if (operation === 'merge') {
                return JSON.stringify(await mergeEntity(workspace, entity, safeRef, safeSourceRef, now));
            }
            throw new Error(`Unknown operation: ${operation}`);
        },
    }));
}
async function buildMergePreview(workspace, targetRef, sourceRef) {
    let target;
    let source;
    try {
        target = await readYamlFrontmatter(path.join(workspace, targetRef));
        source = await readYamlFrontmatter(path.join(workspace, sourceRef));
    }
    catch {
        throw new Error(`无法读取待合并客户：${targetRef} / ${sourceRef}`);
    }
    const keys = ['title', 'market', 'relationship_stage', 'icp_fit', 'priority', 'source_category', 'source_label', 'status'];
    const conflicts = keys
        .filter((key) => target.meta[key] !== undefined && source.meta[key] !== undefined && JSON.stringify(target.meta[key]) !== JSON.stringify(source.meta[key]))
        .map((key) => ({ field: key, target: target.meta[key], source: source.meta[key], resolution: '保留目标值' }));
    return {
        target: { ref: targetRef, title: target.meta.title || '未命名客户', status: target.meta.status || 'active' },
        source: { ref: sourceRef, title: source.meta.title || '未命名客户', status: source.meta.status || 'active' },
        conflicts,
        effects: ['目标客户保留', '来源客户标记为 archived 并记录 merged_into', '双方正文和来源历史保留在目标客户中'],
    };
}
async function buildUpdatePreview(workspace, entity, ref, fields) {
    let existing;
    try {
        existing = await readYamlFrontmatter(path.join(workspace, ref));
    }
    catch {
        throw new Error(`无法读取业务对象：${ref}`);
    }
    const sensitiveFields = new Set([
        'amount', 'currency', 'delivery_date', 'delivery', 'customer', 'contact',
        'identity', 'email', 'phone', 'funnel_stage', 'status',
    ]);
    const changes = Object.entries(fields).map(([field, after]) => ({
        field,
        before: existing.meta[field],
        after,
        conflict: sensitiveFields.has(field)
            && existing.meta[field] !== undefined
            && JSON.stringify(existing.meta[field]) !== JSON.stringify(after),
    }));
    return {
        target: { entity, ref, title: existing.meta.title || '未命名对象' },
        changes,
        effects: ['写入前后值会记录在业务事件中', '只有用户确认后才会修改 OKF'],
    };
}
async function mergeEntity(workspace, entity, targetRef, sourceRef, now) {
    if (entity !== 'customer')
        throw new Error('目前仅支持合并 customer');
    const targetPath = path.join(workspace, targetRef);
    const sourcePath = path.join(workspace, sourceRef);
    let target;
    let source;
    try {
        target = await readYamlFrontmatter(targetPath);
        source = await readYamlFrontmatter(sourcePath);
    }
    catch (err) {
        throw new Error(`无法读取待合并客户：${targetRef} / ${sourceRef}`);
    }
    if (target.meta.status === 'archived')
        throw new Error('合并目标客户已归档');
    if (source.meta.status === 'archived')
        throw new Error('合并来源客户已归档');
    const conflictKeys = ['market', 'relationship_stage', 'icp_fit', 'priority', 'source_category', 'source_label']
        .filter((key) => target.meta[key] !== undefined && source.meta[key] !== undefined && JSON.stringify(target.meta[key]) !== JSON.stringify(source.meta[key]));
    const mergedMeta = { ...source.meta, ...target.meta };
    mergedMeta.title = target.meta.title || source.meta.title;
    mergedMeta.generated = { ...(target.meta.generated || {}), at: now, by: 'dealpilot-dsh' };
    mergedMeta.merged_from = Array.from(new Set([
        ...(Array.isArray(target.meta.merged_from) ? target.meta.merged_from : []),
        sourceRef,
        ...(Array.isArray(source.meta.merged_from) ? source.meta.merged_from : []),
    ]));
    const mergedBody = mergeBodies(target.body, source.body, sourceRef);
    await writeYamlFrontmatter(targetPath, mergedMeta, mergedBody);
    // Repoint dependent records before archiving the source so deals and
    // contacts never remain attached to an archived customer reference.
    const rewired = await rewireCustomerReferences(workspace, sourceRef, targetRef, now);
    const archivedSourceMeta = {
        ...source.meta,
        status: 'archived',
        merged_into: targetRef,
        generated: { ...(source.meta.generated || {}), at: now, by: 'dealpilot-dsh' },
    };
    await writeYamlFrontmatter(sourcePath, archivedSourceMeta, source.body);
    await appendBusinessEvent(workspace, {
        occurred_at: now,
        event_type: 'customer.merged',
        channel: 'chat',
        generated_by: 'dealpilot-dsh',
        customer_ref: targetRef,
        merged_ref: sourceRef,
        summary: `Merged ${sourceRef} into ${targetRef}; rewired ${rewired} dependent records`,
    });
    await updateStorageIndex(workspace, 'customer', { ref: targetRef, ...mergedMeta, updated_at: now });
    await updateStorageIndex(workspace, 'customer', { ref: sourceRef, ...archivedSourceMeta, updated_at: now });
    return { ok: true, ref: targetRef, mergedRef: sourceRef, title: mergedMeta.title, conflicts: conflictKeys, updatedFields: [`rewired:${rewired}`] };
}
async function rewireCustomerReferences(workspace, sourceRef, targetRef, now) {
    let count = 0;
    const deals = await readConceptDir(workspace, 'knowledge/deals');
    for (const doc of deals) {
        if (doc.meta.customer !== sourceRef)
            continue;
        const updated = { ...doc.meta, customer: targetRef, generated: { ...(doc.meta.generated || {}), at: now, by: 'dealpilot-dsh' } };
        await writeYamlFrontmatter(doc.filePath, updated, doc.body);
        await updateStorageIndex(workspace, 'deal', {
            ref: doc.ref,
            ...updated,
            customer_ref: targetRef,
            customer_name: path.basename(targetRef, '.md'),
            updated_at: now,
        });
        count++;
    }
    const contacts = await readConceptDir(workspace, 'knowledge/contacts');
    for (const doc of contacts) {
        if (doc.meta.customer !== sourceRef)
            continue;
        const updated = { ...doc.meta, customer: targetRef, generated: { ...(doc.meta.generated || {}), at: now, by: 'dealpilot-dsh' } };
        await writeYamlFrontmatter(doc.filePath, updated, doc.body);
        count++;
    }
    return count;
}
function mergeBodies(targetBody, sourceBody, sourceRef) {
    const target = targetBody.trim();
    const source = sourceBody.trim();
    if (!source)
        return target;
    if (!target)
        return `# Merged source\n\nSource: ${sourceRef}\n\n${source}`;
    return `${target}\n\n## Merged source (${sourceRef})\n\n${source}\n`;
}
/** Convert human-entered relationship names to verified workspace refs. */
async function normalizeRelationshipFields(workspace, entity, fields) {
    const normalized = { ...fields };
    const relation = entity === 'deal' ? 'customer' : entity === 'action' ? 'deal' : undefined;
    if (!relation || typeof normalized[relation] !== 'string' || !normalized[relation].trim())
        return normalized;
    const value = normalized[relation].trim();
    const concept = relation === 'customer' ? 'customers' : 'deals';
    const docs = await readConceptDir(workspace, `knowledge/${concept}`);
    if (value.startsWith('knowledge/')) {
        const safe = normalizeRef(workspace, `knowledge/${concept}/index.md`, value);
        if (!docs.some(doc => doc.ref === safe))
            throw new Error(`找不到关联对象：${value}`);
        normalized[relation] = safe;
        return normalized;
    }
    const matches = docs.filter(doc => String(doc.meta.title || '').trim().toLowerCase() === value.toLowerCase());
    if (matches.length === 1) {
        normalized[relation] = matches[0].ref;
        return normalized;
    }
    if (matches.length > 1)
        throw new Error(`关联对象名称不唯一：${value}。请使用对象 ref。`);
    throw new Error(`找不到关联对象：${value}`);
}
// ── Create ──────────────────────────────────────────────────────────────────
async function createEntity(workspace, entity, fields, now) {
    if (!fields.title) {
        throw new Error(`${entity} 创建需要 title 字段`);
    }
    // Validate active action limit for deals
    if (entity === 'action' && fields.deal) {
        await validateActiveActionLimit(workspace, fields.deal, null);
    }
    const ref = generateRef(entity, fields.title);
    const filePath = path.join(workspace, ref);
    try {
        await fs.access(filePath);
        throw new Error(`已存在同名 ${entity}：${ref}。请使用 update 操作修改已有对象。`);
    }
    catch (err) {
        if (err?.code !== 'ENOENT')
            throw err;
    }
    // Build meta
    const meta = {
        title: fields.title,
        status: fields.status || 'active',
        generated: { by: 'dealpilot-dsh', at: now },
    };
    // Preserve Agent-authored metadata. Stable relationship/status fields remain
    // useful for indexes, but open-world content must not be filtered here.
    const bodyKeys = new Set((BODY_SECTIONS[entity] || []).map(section => section.toLowerCase().replace(/\s+/g, '_')));
    for (const [key, value] of Object.entries(fields)) {
        if (['title', 'status', 'body', 'content', 'generated', 'ref', ...bodyKeys].includes(key))
            continue;
        if (value !== undefined)
            meta[key] = value;
    }
    // Build body from sections
    const body = buildBody(entity, fields);
    await writeYamlFrontmatter(filePath, meta, body);
    // Append event
    const event = {
        occurred_at: now,
        event_type: `${entity}.created`,
        channel: 'chat',
        generated_by: 'dealpilot-dsh',
    };
    if (entity === 'customer')
        event.customer_ref = ref;
    if (entity === 'deal') {
        event.deal_ref = ref;
        if (fields.customer)
            event.customer_ref = fields.customer;
    }
    if (entity === 'action') {
        event.action_ref = ref;
        if (fields.deal)
            event.deal_ref = fields.deal;
    }
    await appendBusinessEvent(workspace, event);
    // Update index
    const indexEntry = { ref, ...meta, updated_at: now };
    if (entity === 'deal') {
        indexEntry.customer_ref = fields.customer;
        indexEntry.customer_name = fields.customer ? path.basename(fields.customer, '.md') : '';
    }
    if (entity === 'action') {
        indexEntry.deal_ref = fields.deal;
    }
    await updateStorageIndex(workspace, entity, indexEntry);
    if (entity === 'action')
        await syncGoalRuntime(workspace, new Date(now));
    return { ok: true, ref, title: fields.title };
}
// ── Update ──────────────────────────────────────────────────────────────────
async function updateEntity(workspace, entity, ref, fields, now) {
    const filePath = path.join(workspace, ref);
    let meta;
    let body;
    try {
        const doc = await readYamlFrontmatter(filePath);
        meta = doc.meta;
        body = doc.body;
    }
    catch (err) {
        throw new Error(`无法读取业务对象：${ref}`);
    }
    // Merge fields
    const updated = { ...meta };
    const changedKeys = [];
    for (const [key, value] of Object.entries(fields)) {
        // Skip reserved keys
        if (key === 'title' || key === 'ref' || key === 'generated')
            continue;
        // Handle body sections
        if (isBodySection(entity, key)) {
            body = updateBodySection(body, key, value);
            changedKeys.push(key);
            continue;
        }
        updated[key] = value;
        changedKeys.push(key);
    }
    updated.generated = { ...(meta.generated || {}), at: now };
    // Detect stage/risk changes for event type
    const eventType = detectChangeEventType(entity, meta, updated);
    await writeYamlFrontmatter(filePath, updated, body);
    // Append event
    const event = {
        occurred_at: now,
        event_type: eventType || `${entity}.updated`,
        channel: 'chat',
        generated_by: 'dealpilot-dsh',
        summary: changedKeys.join(', '),
    };
    if (entity === 'customer')
        event.customer_ref = ref;
    if (entity === 'deal')
        event.deal_ref = ref;
    if (entity === 'deal' && eventType === 'deal.stage_changed') {
        event.previous_stage = meta.funnel_stage;
        event.next_stage = updated.funnel_stage;
    }
    if (entity === 'action') {
        event.action_ref = ref;
        event.deal_ref = updated.deal || meta.deal;
    }
    await appendBusinessEvent(workspace, event);
    // Update index
    const indexEntry = { ref, ...updated, updated_at: now };
    if (entity === 'deal') {
        indexEntry.customer_ref = updated.customer;
        indexEntry.customer_name = updated.customer ? path.basename(updated.customer, '.md') : '';
    }
    if (entity === 'action') {
        indexEntry.deal_ref = updated.deal || meta.deal;
    }
    await updateStorageIndex(workspace, entity, indexEntry);
    if (entity === 'action')
        await syncGoalRuntime(workspace, new Date(now));
    return { ok: true, ref, updatedFields: changedKeys };
}
async function appendEntityBody(workspace, entity, ref, fields, now) {
    const filePath = path.join(workspace, ref);
    const current = await readYamlFrontmatter(filePath).catch(() => { throw new Error(`无法读取业务对象：${ref}`); });
    const addition = fields.body ?? fields.content ?? '';
    if (!String(addition).trim())
        throw new Error('append 操作需要 body 或 content');
    const body = `${current.body.trimEnd()}\n\n${String(addition).trim()}\n`;
    const updated = { ...current.meta, generated: { ...(current.meta.generated || {}), at: now } };
    await writeYamlFrontmatter(filePath, updated, body);
    const event = { occurred_at: now, event_type: `${entity}.updated`, channel: 'chat', generated_by: 'dealpilot-dsh', summary: 'body appended' };
    if (entity === 'customer')
        event.customer_ref = ref;
    if (entity === 'deal')
        event.deal_ref = ref;
    if (entity === 'action') {
        event.action_ref = ref;
        event.deal_ref = updated.deal;
    }
    await appendBusinessEvent(workspace, event);
    await updateStorageIndex(workspace, entity, { ref, ...updated, updated_at: now });
    return { ok: true, ref, updatedFields: ['body'] };
}
function genericKind(value) {
    const normalized = String(value || 'note').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-|-$/g, '');
    return normalized || 'note';
}
function safeWorkspaceRef(workspace, value) {
    if (!value || path.isAbsolute(value) || value.includes('..'))
        throw new Error('引用必须位于当前 Workspace');
    const resolved = path.resolve(workspace, value);
    const relative = path.relative(workspace, resolved);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
        throw new Error('引用必须位于当前 Workspace');
    return relative.replaceAll('\\', '/');
}
function genericContext(args) {
    const lines = [];
    if (args.rationale)
        lines.push(`Rationale: ${args.rationale}`);
    if (args.uncertainty)
        lines.push(`Uncertainty: ${args.uncertainty}`);
    if (Array.isArray(args.evidence) && args.evidence.length)
        lines.push('Evidence:', ...args.evidence.map(item => `- ${JSON.stringify(item)}`));
    return lines.length ? `\n\n## Agent context\n\n${lines.join('\n')}\n` : '';
}
function genericContent(value) {
    if (value === undefined || value === null)
        return '';
    if (typeof value === 'object') {
        const wrapped = value;
        return JSON.stringify(wrapped.format && 'value' in wrapped ? wrapped.value : wrapped, null, 2);
    }
    return String(value);
}
async function executeGenericWrite(workspace, args) {
    const operation = args.operation;
    if (!['create', 'update', 'append'].includes(operation))
        throw new Error('通用写入仅支持 create、update 和 append；归档或合并请提供 entity');
    for (const evidence of Array.isArray(args.evidence) ? args.evidence : []) {
        const sourceRef = evidence?.sourceRef || evidence?.source_ref;
        if (typeof sourceRef !== 'string')
            throw new Error('证据必须包含 sourceRef');
        safeWorkspaceRef(workspace, sourceRef);
    }
    const kind = genericKind(args.kind);
    const fields = { ...(args.fields || {}) };
    const title = String(fields.title || args.title || kind).trim();
    const ref = args.ref ? normalizeRef(workspace, `knowledge/${kind}s/index.md`, args.ref) : operation === 'create' ? generateRef(kind, title) : undefined;
    if (!ref)
        throw new Error(`${operation} 操作需要 ref 参数`);
    const explicitTitle = Boolean(fields.title || args.title);
    const metadata = { ...(args.metadata || {}), ...Object.fromEntries(Object.entries(fields).filter(([key]) => !['title', 'body', 'content'].includes(key))), ...((operation !== 'append' && (operation === 'create' || explicitTitle)) ? { title } : {}), ...(operation === 'create' ? { status: (args.metadata || {}).status || 'active' } : {}) };
    const bodyValue = args.body ?? args.content ?? fields.body ?? fields.content ?? '';
    const body = `${genericContent(bodyValue)}${genericContext(args)}`;
    const payload = { operation, kind, ref, metadata, body };
    if (!args.confirmation_token)
        return createConfirmation('dealpilot_write', payload, '这是一个会修改工作区记忆的操作。请审阅文档、正文、元数据和来源后确认。', payload);
    consumeConfirmation(args.confirmation_token, 'dealpilot_write', payload);
    const filePath = path.join(workspace, ref);
    if (operation === 'create') {
        try {
            await fs.access(filePath);
            throw new Error(`文档已存在：${ref}。请使用 update 或 append。`);
        }
        catch (error) {
            if (error?.code !== 'ENOENT')
                throw error;
        }
        await writeYamlFrontmatter(filePath, { ...metadata, generated: { by: 'dealpilot-agent', at: new Date().toISOString() } }, body);
    }
    else {
        const current = await readYamlFrontmatter(filePath).catch(() => { throw new Error(`无法读取文档：${ref}`); });
        const nextBody = operation === 'append' ? `${current.body.trimEnd()}\n\n${body.trim()}\n` : body;
        await writeYamlFrontmatter(filePath, { ...current.meta, ...metadata, generated: { ...(current.meta.generated || {}), by: 'dealpilot-agent', at: new Date().toISOString() } }, nextBody);
    }
    const now = new Date().toISOString();
    await appendBusinessEvent(workspace, { occurred_at: now, event_type: `memory.${operation}`, channel: 'conversation', generated_by: 'dealpilot-agent', source_ref: ref, summary: args.rationale || `${operation} ${ref}` });
    if (['customer', 'deal', 'action'].includes(kind)) {
        const current = await readYamlFrontmatter(filePath);
        await updateStorageIndex(workspace, kind, { ref, ...current.meta, updated_at: now });
    }
    return { ok: true, ref, kind, operation };
}
// ── Archive ─────────────────────────────────────────────────────────────────
async function archiveEntity(workspace, entity, ref, now) {
    const filePath = path.join(workspace, ref);
    let meta;
    let body;
    try {
        const doc = await readYamlFrontmatter(filePath);
        meta = doc.meta;
        body = doc.body;
    }
    catch (err) {
        throw new Error(`无法读取业务对象：${ref}`);
    }
    if (meta.status === 'archived') {
        return { ok: true, ref, message: 'Already archived' };
    }
    const previousStatus = meta.status;
    meta.status = 'archived';
    meta.generated = { ...(meta.generated || {}), at: now };
    await writeYamlFrontmatter(filePath, meta, body);
    // Append event
    const event = {
        occurred_at: now,
        event_type: `${entity}.archived`,
        channel: 'chat',
        generated_by: 'dealpilot-dsh',
        summary: `Archived from ${previousStatus}`,
    };
    if (entity === 'customer')
        event.customer_ref = ref;
    if (entity === 'deal')
        event.deal_ref = ref;
    if (entity === 'action') {
        event.action_ref = ref;
        event.deal_ref = meta.deal;
    }
    await appendBusinessEvent(workspace, event);
    // Update index
    await updateStorageIndex(workspace, entity, { ref, ...meta, updated_at: now });
    if (entity === 'action')
        await syncGoalRuntime(workspace, new Date(now));
    return { ok: true, ref, previousStatus, newStatus: 'archived' };
}
// ── Body Helpers ────────────────────────────────────────────────────────────
function buildBody(entity, fields) {
    const sections = BODY_SECTIONS[entity] || [];
    const lines = [];
    if (fields.body !== undefined || fields.content !== undefined) {
        lines.push(String(fields.body ?? fields.content));
        lines.push('');
    }
    for (const section of sections) {
        const key = section.toLowerCase().replace(/\s+/g, '_');
        const value = fields[key] || fields[section];
        if (value !== undefined) {
            lines.push(`# ${section}`);
            lines.push('');
            if (Array.isArray(value)) {
                for (const item of value) {
                    lines.push(`- ${item}`);
                }
            }
            else {
                lines.push(String(value));
            }
            lines.push('');
        }
    }
    return lines.join('\n') || '';
}
function isBodySection(entity, key) {
    const sections = BODY_SECTIONS[entity] || [];
    return sections.some(s => s.toLowerCase().replace(/\s+/g, '_') === key);
}
function updateBodySection(body, key, value) {
    const sectionName = key.replace(/_/g, ' ');
    const sectionNameCapitalized = sectionName.replace(/\b\w/g, c => c.toUpperCase());
    const lines = body.split('\n');
    const result = [];
    let replaced = false;
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        const headerMatch = line.match(/^#{1,3}\s+(.+)/);
        if (headerMatch) {
            const headerName = headerMatch[1].trim().toLowerCase();
            const targetLower = sectionName.toLowerCase();
            if (headerName === targetLower) {
                // Replace this section
                replaced = true;
                result.push(`# ${sectionNameCapitalized}`);
                result.push('');
                if (Array.isArray(value)) {
                    for (const item of value) {
                        result.push(`- ${item}`);
                    }
                }
                else {
                    result.push(String(value));
                }
                result.push('');
                // Skip lines until next section
                i++;
                while (i < lines.length) {
                    if (lines[i].match(/^#{1,3}\s+/))
                        break;
                    i++;
                }
                continue;
            }
        }
        result.push(line);
        i++;
    }
    // If section not found, append it
    if (!replaced) {
        if (result.length > 0 && result[result.length - 1] !== '') {
            result.push('');
        }
        result.push(`# ${sectionNameCapitalized}`);
        result.push('');
        if (Array.isArray(value)) {
            for (const item of value) {
                result.push(`- ${item}`);
            }
        }
        else {
            result.push(String(value));
        }
        result.push('');
    }
    return result.join('\n');
}
// ── Change Detection ────────────────────────────────────────────────────────
function detectChangeEventType(entity, oldMeta, newMeta) {
    if (entity === 'deal') {
        if (newMeta.funnel_stage && newMeta.funnel_stage !== oldMeta.funnel_stage) {
            return 'deal.stage_changed';
        }
        if (newMeta.risk_level && newMeta.risk_level !== oldMeta.risk_level) {
            return 'deal.risk_changed';
        }
    }
    return null;
}
// ── Active Action Limit ─────────────────────────────────────────────────────
async function validateActiveActionLimit(workspace, dealRef, excludeRef) {
    const actions = await readConceptDir(workspace, 'knowledge/actions');
    for (const doc of actions) {
        if (doc.meta.deal !== dealRef)
            continue;
        if (excludeRef && doc.ref === excludeRef)
            continue;
        if (doc.meta.status === 'active') {
            throw new Error(`每个 Deal 最多一个 active Action。Deal ${dealRef} 已有 active Action: ${doc.ref}`);
        }
    }
}
