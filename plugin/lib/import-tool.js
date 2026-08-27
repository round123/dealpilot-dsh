// DealPilot DSH — Import Tool
// Bulk import customers and deals from CSV, Markdown tables, or plain text.
// S5 → TS migration.
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { writeYamlFrontmatter, appendBusinessEvent, updateStorageIndex, generateRef, readConceptDir, resolveWorkspace, normalizeRef, } from './okf-utils.js';
import { createConfirmation, consumeConfirmation } from './confirmation.js';
import { importPresentation } from './business-view.js';
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
                    description: '要导入的数据内容（可选；不提供时读取 sources/inbox）',
                },
                format: {
                    type: 'string',
                    enum: ['csv', 'markdown', 'text'],
                    description: '数据格式（可选；从 source_path 扩展名推断）',
                },
                source_path: {
                    type: 'string',
                    description: 'Workspace 内 sources/inbox 下的文件或目录（可选）',
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
                confirmation_token: {
                    type: 'string',
                    description: '用户确认导入预览后返回的一次性确认令牌',
                },
            },
            required: [],
        },
        output: {
            schema: { type: 'object' },
            render(_args, value) {
                const result = JSON.parse(value);
                if (result.requires_confirmation) {
                    return [{ type: 'text', text: `${result.message}\nconfirmation_token: ${result.confirmation_token}\npreview: ${JSON.stringify(result.preview || {})}` }];
                }
                return [{ type: 'text', text: `导入完成：新增 ${result.created || 0} 条，跳过 ${result.skipped || 0} 条\nDATA_JSON: ${JSON.stringify(result)}` }];
            },
            presentationMeta(args, value) {
                return importPresentation(args, value);
            },
        },
        async execute(args) {
            const workspace = resolveWorkspace(ctx.config);
            if (!workspace) {
                throw new Error('No workspace configured. Set defaultWorkspace in agent preset.');
            }
            const { data: providedData, format: providedFormat, source_path, source_category, source_label, auto_dedup, confirmation_token } = args;
            const loaded = await loadImportSource(workspace, providedData, providedFormat, source_path);
            const data = loaded.data;
            const format = loaded.format;
            const confirmationPayload = {
                data_sha256: createHash('sha256').update(data).digest('hex'),
                format,
                source_category: source_category || 'import',
                source_label: source_label || null,
                auto_dedup: auto_dedup !== false,
                source_path: loaded.sourcePath,
            };
            if (!confirmation_token) {
                const parsedPreview = await previewImport(workspace, data, format, auto_dedup !== false);
                const duplicateCount = parsedPreview.duplicates.length;
                return JSON.stringify(createConfirmation('dealpilot_import', confirmationPayload, `已解析 ${parsedPreview.total} 条记录，预计新增 ${Math.max(0, parsedPreview.total - duplicateCount)} 条、跳过 ${duplicateCount} 条重复记录。请向用户展示预览，获得明确确认后再重试。`, {
                    format,
                    source_category: source_category || 'import',
                    source_label: source_label || null,
                    source_path: loaded.sourcePath,
                    total: parsedPreview.total,
                    estimated_create: Math.max(0, parsedPreview.total - duplicateCount),
                    duplicate_count: duplicateCount,
                    duplicates: parsedPreview.duplicates,
                    records: parsedPreview.records,
                    warnings: parsedPreview.warnings,
                    auto_dedup: auto_dedup !== false,
                }));
            }
            consumeConfirmation(confirmation_token, 'dealpilot_import', confirmationPayload);
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
async function loadImportSource(workspace, data, format, sourcePath) {
    if (data !== undefined && data.trim() !== '') {
        if (!format)
            throw new Error('提供 data 时必须指定 format');
        return { data, format, sourcePath: 'inline' };
    }
    const requested = sourcePath || 'sources/inbox';
    if (requested !== 'sources/inbox' && !requested.startsWith('sources/inbox/')) {
        throw new Error('导入源必须位于 Workspace 的 sources/inbox 目录内');
    }
    const normalized = normalizeRef(workspace, 'index.md', requested);
    const absolute = path.join(workspace, normalized);
    let stat;
    try {
        stat = await fs.stat(absolute);
    }
    catch {
        throw new Error(`找不到导入源：${requested}`);
    }
    const files = stat.isDirectory()
        ? (await fs.readdir(absolute, { withFileTypes: true })).filter(entry => entry.isFile()).map(entry => path.join(absolute, entry.name))
        : [absolute];
    if (!files.length)
        throw new Error(`导入目录为空：${requested}`);
    const contents = await Promise.all(files.map(file => fs.readFile(file, 'utf8')));
    const extension = path.extname(files[0]).toLowerCase();
    const inferred = format || (extension === '.csv' ? 'csv' : extension === '.md' || extension === '.markdown' ? 'markdown' : 'text');
    return { data: contents.join('\n'), format: inferred, sourcePath: normalized };
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
    return importRecordEntities(workspace, records, options);
}
export async function importRecordEntities(workspace, records, options) {
    const { sourceCategory, sourceLabel, autoDedup, now } = options;
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
                const customerRef = await resolveImportedCustomer(workspace, record.customer);
                if (!customerRef) {
                    results.warnings.push(`${title}: 找不到关联客户 ${record.customer}`);
                    results.skipped++;
                    continue;
                }
                const ref = await createDealFromImport(workspace, title, { ...record, customer: customerRef }, { now });
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
export async function previewImport(workspace, data, format, autoDedup = true) {
    const records = format === 'csv' ? parseCSV(data) : format === 'markdown' ? parseMarkdownTable(data) : parseTextList(data);
    const existing = autoDedup ? await loadExistingCustomers(workspace) : new Map();
    const duplicates = [];
    const warnings = [];
    for (const record of records) {
        if (!record.title?.trim())
            warnings.push('存在缺少客户名称的记录');
        const ref = record.title ? findDuplicate(record.title.trim(), existing) : null;
        if (ref)
            duplicates.push({ title: record.title.trim(), ref });
    }
    return { format, total: records.length, records, duplicates, warnings };
}
export async function previewImportRecords(workspace, records, autoDedup = true) {
    const existing = autoDedup ? await loadExistingCustomers(workspace) : new Map();
    const duplicates = [];
    const warnings = [];
    for (const record of records) {
        if (!record.title?.trim())
            warnings.push('存在缺少客户名称的记录');
        const ref = record.title ? findDuplicate(record.title.trim(), existing) : null;
        if (ref)
            duplicates.push({ title: record.title.trim(), ref });
    }
    return { format: 'canonical', total: records.length, records, duplicates, warnings };
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
async function resolveImportedCustomer(workspace, value) {
    const normalized = value.trim();
    const docs = await readConceptDir(workspace, 'knowledge/customers');
    if (normalized.startsWith('knowledge/')) {
        const safe = normalizeRef(workspace, 'knowledge/customers/index.md', normalized);
        return docs.some(doc => doc.ref === safe) ? safe : undefined;
    }
    const matches = docs.filter(doc => String(doc.meta.title || '').trim().toLowerCase() === normalized.toLowerCase());
    return matches.length === 1 ? matches[0].ref : undefined;
}
function findDuplicate(title, existingMap) {
    return existingMap.get(title.toLowerCase()) || null;
}
async function createCustomerFromImport(workspace, title, record, options) {
    const { sourceCategory, sourceLabel, now } = options;
    const ref = generateRef('customer', title);
    const filePath = path.join(workspace, ref);
    try {
        await fs.access(filePath);
        throw new Error(`已存在同名客户：${ref}`);
    }
    catch (err) {
        if (err?.code !== 'ENOENT')
            throw err;
    }
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
    try {
        await fs.access(filePath);
        throw new Error(`已存在同名交易：${ref}`);
    }
    catch (err) {
        if (err?.code !== 'ENOENT')
            throw err;
    }
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
