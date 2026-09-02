// DealPilot DSH — Search Tool
// Fuzzy search across customers, deals, and actions.
// Prefers storage index, falls back to scanning OKF files.
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { readStorageIndex, readConceptDir, readYamlFrontmatter, resolveWorkspace, } from './okf-utils.js';
import { searchPresentation } from './business-view.js';
// ── Registration ────────────────────────────────────────────────────────────
export function registerSearchTool(ctx, harness) {
    harness.registerTool(ctx, harness.defineTool({
        name: 'dealpilot_search',
        description: `搜索 DealPilot OKF Workspace 中的客户、交易、行动、证据和事件。

支持按名称、正文和扩展元数据搜索，并按字段筛选。

优先从 Storage 索引搜索（快），索引不存在时回退到解析 OKF 文件。`,
        parameters: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: '搜索关键词（匹配名称、正文和元数据）',
                },
                entity: {
                    type: 'string',
                    enum: ['customer', 'deal', 'action', 'evidence', 'event', 'all'],
                    description: '要搜索的实体类型（默认 all）',
                },
                filters: {
                    type: 'object',
                    description: '字段筛选条件。例如 {"status": "active", "funnel_stage": "quoted"}',
                },
                limit: {
                    type: 'number',
                    description: '返回结果数量上限（默认 20）',
                },
            },
            required: [],
        },
        output: {
            schema: { type: 'object' },
            render(_args, value) {
                const result = JSON.parse(value);
                return [{ type: 'text', text: `找到 ${result.count || 0} 条销售对象\nDATA_JSON: ${JSON.stringify(result)}` }];
            },
            presentationMeta(_args, value) {
                return searchPresentation(value);
            },
        },
        async execute(args) {
            const workspace = resolveWorkspace(ctx.config);
            if (!workspace) {
                throw new Error('No workspace configured. Set defaultWorkspace in agent preset.');
            }
            const { query, entity, filters, limit } = args;
            return JSON.stringify(await searchEntities(workspace, query || '', entity || 'all', filters || {}, limit || 20));
        },
    }));
}
// ── Core Logic ──────────────────────────────────────────────────────────────
export async function searchEntities(workspace, query, entity, filters, limit) {
    const queryLower = query.toLowerCase();
    const allResults = [];
    const entityTypes = entity === 'all'
        ? ['customer', 'deal', 'action']
        : [entity];
    for (const type of entityTypes) {
        if (type === 'evidence' || type === 'event')
            continue;
        // Try index first, fall back to file scan
        let items = await readStorageIndex(workspace, type);
        if (!Array.isArray(items) || items.length === 0) {
            items = await scanEntityFiles(workspace, type);
        }
        for (const item of items) {
            const match = queryLower ? await findQueryMatch(workspace, item, queryLower) : undefined;
            if (queryLower && !match)
                continue;
            // Filter match
            if (!matchesFilters(item, filters))
                continue;
            allResults.push({ ...item, ...(match ? { match_source: match.source, snippet: match.snippet } : {}), _entity: type });
        }
    }
    // Search source files and event history on demand. Empty queries keep the
    // compact business projection while content queries can discover any evidence.
    if (queryLower && (entity === 'all' || entity === 'evidence'))
        allResults.push(...await searchEvidence(workspace, queryLower, filters));
    if (queryLower && (entity === 'all' || entity === 'event'))
        allResults.push(...await searchEvents(workspace, queryLower, filters));
    // Sort: exact matches first, then starts-with, then alphabetical
    allResults.sort((a, b) => {
        const aExact = (a.title || '').toLowerCase() === queryLower;
        const bExact = (b.title || '').toLowerCase() === queryLower;
        if (aExact && !bExact)
            return -1;
        if (!aExact && bExact)
            return 1;
        const aStarts = (a.title || '').toLowerCase().startsWith(queryLower);
        const bStarts = (b.title || '').toLowerCase().startsWith(queryLower);
        if (aStarts && !bStarts)
            return -1;
        if (!aStarts && bStarts)
            return 1;
        return (a.title || '').localeCompare(b.title || '');
    });
    return {
        query,
        entity,
        filters,
        count: allResults.length,
        results: allResults.slice(0, limit).map((r) => {
            const { _entity, ...rest } = r;
            return { entity: _entity, ...rest };
        }),
    };
}
// ── Helpers ─────────────────────────────────────────────────────────────────
async function findQueryMatch(workspace, item, queryLower) {
    if (JSON.stringify(item).toLowerCase().includes(queryLower))
        return { source: 'metadata' };
    if (!item.ref)
        return undefined;
    try {
        const document = await readYamlFrontmatter(path.join(workspace, item.ref));
        const body = document.body.toLowerCase();
        const index = body.indexOf(queryLower);
        if (index < 0)
            return undefined;
        const start = Math.max(0, index - 80);
        return { source: 'body', snippet: document.body.slice(start, Math.min(document.body.length, index + queryLower.length + 160)).replace(/\s+/g, ' ').trim() };
    }
    catch {
        return undefined;
    }
}
function matchesFilters(item, filters) {
    for (const [key, value] of Object.entries(filters)) {
        if (value === undefined || value === null || value === '')
            continue;
        if (item[key] !== value)
            return false;
    }
    return true;
}
async function scanEntityFiles(workspace, entity) {
    const dirMap = {
        customer: 'knowledge/customers',
        deal: 'knowledge/deals',
        action: 'knowledge/actions',
    };
    const dirPath = dirMap[entity];
    if (!dirPath)
        return [];
    const docs = await readConceptDir(workspace, dirPath);
    return docs.map((doc) => ({
        ref: doc.ref,
        title: doc.meta.title || 'Untitled',
        status: doc.meta.status || 'active',
        ...doc.meta,
        updated_at: doc.meta.generated?.at,
    }));
}
async function searchEvidence(workspace, queryLower, filters) {
    const results = [];
    const root = path.join(workspace, 'sources');
    const visit = async (directory) => {
        let entries;
        try {
            entries = await fs.readdir(directory, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entries) {
            const filePath = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                await visit(filePath);
                continue;
            }
            if (!entry.isFile() || !entry.name.endsWith('.json'))
                continue;
            let content;
            try {
                content = await fs.readFile(filePath, 'utf8');
            }
            catch {
                continue;
            }
            const index = content.toLowerCase().indexOf(queryLower);
            if (index < 0)
                continue;
            const ref = path.relative(workspace, filePath).replaceAll('\\', '/');
            const item = { ref, title: entry.name, status: 'available', match_source: 'evidence', snippet: content.slice(Math.max(0, index - 80), index + queryLower.length + 160).replace(/\s+/g, ' ').trim(), _entity: 'evidence' };
            if (matchesFilters(item, filters))
                results.push(item);
        }
    };
    await visit(root);
    return results;
}
async function searchEvents(workspace, queryLower, filters) {
    const ref = 'knowledge/events/business-events.jsonl';
    let content;
    try {
        content = await fs.readFile(path.join(workspace, ref), 'utf8');
    }
    catch {
        return [];
    }
    const results = [];
    for (const line of content.split(/\r?\n/)) {
        if (!line.trim() || !line.toLowerCase().includes(queryLower))
            continue;
        let event = {};
        try {
            event = JSON.parse(line);
        }
        catch { /* preserve malformed lines as searchable evidence */ }
        const item = { ref, title: event.event_type || 'business event', status: 'recorded', occurred_at: event.occurred_at, match_source: 'event', snippet: line.slice(0, 320), _entity: 'event' };
        if (matchesFilters(item, filters))
            results.push(item);
    }
    return results;
}
