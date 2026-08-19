// DealPilot DSH — Import Tool
// Bulk import customers and deals from CSV, Markdown tables, or plain text.
// S5 → TS migration.
import * as path from 'node:path';
import { writeYamlFrontmatter, appendBusinessEvent, updateStorageIndex, generateRef, readConceptDir, resolveWorkspace, } from './okf-utils.js';
// ── Registration ────────────────────────────────────────────────────────────
export function registerImportTool(ctx, harness) {
    harness.registerTool(ctx, harness.defineTool({
        name: 'dealpilot_import',
        description: `批量导入客户和交易数据。

支持三种格式：
- csv: CSV 格式（逗号分隔，首行为列名）
- markdown: Markdown 表格格式
- text: 纯文本列表（每行一个客户名）

自动去重：导入前检查是否已存在同名客户，存在则跳过。

导入的客户默认 source_category 为 import，relationship_stage 为 new。`,
        parameters: {
            type: 'object',
            properties: {
                data: {
                    type: 'string',
                    description: '要导入的数据内容（CSV 文本、Markdown 表格或纯文本列表）',
                },
                format: {
                    type: 'string',
                    enum: ['csv', 'markdown', 'text'],
                    description: '数据格式',
                },
                source_category: {
                    type: 'string',
                    description: '来源分类（默认 import）',
                },
                source_label: {
                    type: 'string',
                    description: '来源标签（如 "2026 香港春季展"）',
                },
                auto_dedup: {
                    type: 'boolean',
                    description: '是否自动去重（默认 true）',
                },
            },
            required: ['data', 'format'],
        },
        async execute(args) {
            const workspace = resolveWorkspace(ctx.config);
            if (!workspace) {
                throw new Error('No workspace configured. Set defaultWorkspace in agent preset.');
            }
            const { data, format, source_category, source_label, auto_dedup } = args;
            const now = new Date().toISOString();
            return JSON.stringify(await importEntities(workspace, data, format, {
                sourceCategory: source_category || 'import',
                sourceLabel: source_label,
                autoDedup: auto_dedup !== false,
                now,
            }));
        },
    }));
}
// ── Core Logic ──────────────────────────────────────────────────────────────
export async function importEntities(workspace, data, format, options) {
    const { sourceCategory, sourceLabel, autoDedup, now } = options;
    let records;
    if (format === 'csv') {
        records = parseCSV(data);
    }
    else if (format === 'markdown') {
        records = parseMarkdownTable(data);
    }
    else if (format === 'text') {
        records = parseTextList(data);
    }
    else {
        throw new Error(`Unsupported format: ${format}. Use csv, markdown, or text.`);
    }
    const results = {
        total: records.length,
        created: 0,
        skipped: 0,
        entities: [],
        warnings: [],
    };
    // Pre-load existing customers for dedup
    const existingCustomers = autoDedup ? await loadExistingCustomers(workspace) : new Map();
    for (const record of records) {
        try {
            if (!record.title || record.title.trim() === '') {
                results.warnings.push('Skipped record with empty title');
                results.skipped++;
                continue;
            }
            const title = record.title.trim();
            // Dedup
            if (autoDedup) {
                const existing = findDuplicate(title, existingCustomers);
                if (existing) {
                    results.warnings.push(`${title} 与现有客户 ${existing} 重名，已跳过`);
                    results.skipped++;
                    continue;
                }
            }
            const entity = record.entity || 'customer';
            if (entity === 'customer') {
                const ref = await createCustomerFromImport(workspace, title, record, {
                    sourceCategory,
                    sourceLabel,
                    now,
                });
                results.created++;
                results.entities.push({ ref, title, entity: 'customer' });
                // Add to dedup map
                existingCustomers.set(title.toLowerCase(), ref);
            }
            else if (entity === 'deal') {
                if (!record.customer) {
                    results.warnings.push(`${title}: deal 需要 customer 字段`);
                    results.skipped++;
                    continue;
                }
                const ref = await createDealFromImport(workspace, title, record, { now });
                results.created++;
                results.entities.push({ ref, title, entity: 'deal' });
            }
        }
        catch (err) {
            results.warnings.push(`${record.title || 'unknown'}: ${err.message}`);
            results.skipped++;
        }
    }
    return results;
}
// ── Parsers ─────────────────────────────────────────────────────────────────
function parseCSV(text) {
    const lines = text.trim().split('\n');
    if (lines.length < 2)
        return [];
    const headers = parseCSVLine(lines[0]);
    const records = [];
    for (let i = 1; i < lines.length; i++) {
        const values = parseCSVLine(lines[i]);
        if (values.length === 0)
            continue;
        const record = { title: '', entity: 'customer' };
        for (let j = 0; j < headers.length; j++) {
            const key = headers[j].trim().toLowerCase().replace(/\s+/g, '_');
            record[key] = values[j] ? values[j].trim() : '';
        }
        // Map common column names
        record.title = record.title || record.name || record.company || record.customer || '';
        record.entity = record.entity || record.type || 'customer';
        records.push(record);
    }
    return records;
}
function parseCSVLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
            inQuotes = !inQuotes;
        }
        else if (ch === ',' && !inQuotes) {
            result.push(current);
            current = '';
        }
        else {
            current += ch;
        }
    }
    result.push(current);
    return result;
}
function parseMarkdownTable(text) {
    const lines = text.trim().split('\n');
    if (lines.length < 2)
        return [];
    // Find header and separator rows
    let headerIdx = -1;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.startsWith('|') && line.endsWith('|')) {
            if (i + 1 < lines.length && lines[i + 1].trim().match(/^\|[\s\-:|]+\|$/)) {
                headerIdx = i;
                break;
            }
        }
    }
    if (headerIdx === -1)
        return [];
    const headers = lines[headerIdx]
        .split('|')
        .map(h => h.trim().toLowerCase().replace(/\s+/g, '_'))
        .filter(h => h !== '');
    const records = [];
    for (let i = headerIdx + 2; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line.startsWith('|') || !line.endsWith('|'))
            continue;
        const values = line
            .split('|')
            .map(v => v.trim())
            .filter((_v, idx, arr) => idx > 0 && idx < arr.length - 1);
        const record = { title: '', entity: 'customer' };
        for (let j = 0; j < headers.length && j < values.length; j++) {
            record[headers[j]] = values[j];
        }
        record.title = record.title || record.name || record.company || record.customer || '';
        record.entity = record.entity || record.type || 'customer';
        records.push(record);
    }
    return records;
}
function parseTextList(text) {
    const lines = text.trim().split('\n');
    const records = [];
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed)
            continue;
        // Strip leading bullet markers
        const name = trimmed.replace(/^[\-\*\d+\.]\s*/, '').trim();
        if (name) {
            records.push({ title: name, entity: 'customer' });
        }
    }
    return records;
}
// ── Duplicate Detection ─────────────────────────────────────────────────────
async function loadExistingCustomers(workspace) {
    const map = new Map();
    const docs = await readConceptDir(workspace, 'knowledge/customers');
    for (const doc of docs) {
        const title = (doc.meta.title || '').toLowerCase();
        if (title)
            map.set(title, doc.ref);
    }
    return map;
}
function findDuplicate(title, existingMap) {
    return existingMap.get(title.toLowerCase()) || null;
}
async function createCustomerFromImport(workspace, title, record, options) {
    const { sourceCategory, sourceLabel, now } = options;
    const ref = generateRef('customer', title);
    const filePath = path.join(workspace, ref);
    const meta = {
        title,
        status: 'active',
        source_category: record.source_category || sourceCategory,
        source_label: record.source_label || sourceLabel || undefined,
        relationship_stage: record.relationship_stage || 'new',
        market: record.market || record.country || '',
        icp_fit: record.icp_fit || 'unknown',
        priority: record.priority || 'unknown',
        generated: { by: 'dealpilot-dsh', at: now },
    };
    // Clean up empty optional fields
    for (const key of ['market', 'source_label']) {
        if (meta[key] === '' || meta[key] === undefined)
            delete meta[key];
    }
    const body = [
        '# Profile',
        record.profile || record.description || record.notes || '_待补充_',
        '',
        '# Qualification',
        '_待补充_',
        '',
        '# Open questions',
        '_待补充_',
    ].join('\n');
    await writeYamlFrontmatter(filePath, meta, body);
    await appendBusinessEvent(workspace, {
        occurred_at: now,
        event_type: 'customer.created',
        customer_ref: ref,
        channel: 'import',
        generated_by: 'dealpilot-dsh',
        summary: `Imported: ${title}`,
    });
    await updateStorageIndex(workspace, 'customer', { ref, ...meta, updated_at: now });
    return ref;
}
async function createDealFromImport(workspace, title, record, options) {
    const { now } = options;
    const ref = generateRef('deal', title);
    const filePath = path.join(workspace, ref);
    const meta = {
        title,
        customer: record.customer,
        status: 'active',
        funnel_stage: record.funnel_stage || record.stage || 'new',
        priority: record.priority || 'unknown',
        risk_level: record.risk_level || 'unknown',
        risk_summary: record.risk_summary || undefined,
        generated: { by: 'dealpilot-dsh', at: now },
    };
    const body = [
        '# Goal',
        record.goal || record.description || '_待补充_',
        '',
        '# Confirmed facts',
        '_待补充_',
        '',
        '# Open questions',
        '_待补充_',
    ].join('\n');
    await writeYamlFrontmatter(filePath, meta, body);
    await appendBusinessEvent(workspace, {
        occurred_at: now,
        event_type: 'deal.created',
        deal_ref: ref,
        customer_ref: record.customer,
        channel: 'import',
        generated_by: 'dealpilot-dsh',
        summary: `Imported: ${title}`,
    });
    await updateStorageIndex(workspace, 'deal', {
        ref,
        ...meta,
        customer_ref: record.customer,
        customer_name: path.basename(record.customer, '.md'),
        updated_at: now,
    });
    return ref;
}
