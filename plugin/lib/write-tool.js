// DealPilot DSH — Write Tool
// Create, update, and archive customers, deals, and actions.
import * as path from 'node:path';
import { readYamlFrontmatter, writeYamlFrontmatter, appendBusinessEvent, updateStorageIndex, generateRef, resolveWorkspace, readConceptDir, } from './okf-utils.js';
// ── Entity Field Definitions ─────────────────────────────────────────────────
const ENTITY_FIELDS = {
    customer: [
        'source_category', 'source_label', 'relationship_stage',
        'market', 'icp_fit', 'priority',
    ],
    deal: [
        'customer', 'funnel_stage', 'priority', 'risk_level',
        'risk_summary', 'last_activity_at', 'products', 'current_action',
    ],
    action: [
        'deal', 'due_at', 'priority', 'reason', 'requires_human',
    ],
};
const BODY_SECTIONS = {
    customer: ['Profile', 'Qualification', 'Open questions'],
    deal: ['Goal', 'Confirmed facts', 'Inferences', 'Open questions', 'Risks', 'Correction history'],
    action: ['Reason', 'Check condition', 'Evidence'],
};
// ── Tool Registration ───────────────────────────────────────────────────────
export function registerWriteTool(ctx, harness) {
    harness.registerTool(ctx, harness.defineTool({
        name: 'dealpilot_write',
        description: `在 DealPilot OKF Workspace 中创建或更新业务对象。

支持三种实体类型：
- customer: 客户公司。字段：title, source_category, source_label, relationship_stage, market, icp_fit, status, priority, profile, qualification, open_questions
- deal: 交易机会。字段：title, customer, funnel_stage, priority, risk_level, risk_summary, status, goal, products, confirmed_facts, inferences, open_questions, risks
- action: 行动任务。字段：title, deal, status, due_at, priority, reason, requires_human, check_condition

支持三种操作：
- create: 创建新对象（不需要 ref）
- update: 更新已有对象（需要 ref）
- archive: 归档对象（设置 status: archived）

规则：
- 每个 Deal 最多一个 active Action
- 创建/更新后自动追加 business-events.jsonl
- 归档操作是高影响操作`,
        parameters: {
            type: 'object',
            properties: {
                operation: { type: 'string', enum: ['create', 'update', 'archive'] },
                entity: { type: 'string', enum: ['customer', 'deal', 'action'] },
                ref: { type: 'string', description: '目标对象引用路径（update/archive 时必需）' },
                fields: {
                    type: 'object',
                    description: '要写入的字段。create 时必需 title；update 时只写提供的字段',
                },
            },
            required: ['operation', 'entity', 'fields'],
        },
        async execute(args) {
            const workspace = resolveWorkspace(ctx.config);
            if (!workspace) {
                throw new Error('No workspace configured. Set defaultWorkspace in agent preset.');
            }
            const { operation, entity, ref, fields } = args;
            const now = new Date().toISOString();
            if (operation === 'create') {
                return JSON.stringify(await createEntity(workspace, entity, fields, now));
            }
            else if (operation === 'update') {
                if (!ref)
                    throw new Error('update 操作需要 ref 参数');
                return JSON.stringify(await updateEntity(workspace, entity, ref, fields, now));
            }
            else if (operation === 'archive') {
                if (!ref)
                    throw new Error('archive 操作需要 ref 参数');
                return JSON.stringify(await archiveEntity(workspace, entity, ref, now));
            }
            throw new Error(`Unknown operation: ${operation}`);
        },
    }));
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
    // Build meta
    const meta = {
        title: fields.title,
        status: fields.status || 'active',
        generated: { by: 'dealpilot-dsh', at: now },
    };
    // Copy entity-specific fields
    const allowedFields = ENTITY_FIELDS[entity] || [];
    for (const key of allowedFields) {
        if (fields[key] !== undefined) {
            meta[key] = fields[key];
        }
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
        throw new Error(`无法读取 ${ref}: ${err.message}`);
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
    return { ok: true, ref, updatedFields: changedKeys };
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
        throw new Error(`无法读取 ${ref}: ${err.message}`);
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
    return { ok: true, ref, previousStatus, newStatus: 'archived' };
}
// ── Body Helpers ────────────────────────────────────────────────────────────
function buildBody(entity, fields) {
    const sections = BODY_SECTIONS[entity] || [];
    const lines = [];
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
