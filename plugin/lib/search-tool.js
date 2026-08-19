// DealPilot DSH — Search Tool
// Fuzzy search across customers, deals, and actions.
// Prefers storage index, falls back to scanning OKF files.
import { readStorageIndex, readConceptDir, resolveWorkspace, } from './okf-utils.js';
// ── Registration ────────────────────────────────────────────────────────────
export function registerSearchTool(ctx, harness) {
    harness.registerTool(ctx, harness.defineTool({
        name: 'dealpilot_search',
        description: `搜索 DealPilot OKF Workspace 中的客户、交易和行动。

支持按名称模糊搜索和按字段筛选。

优先从 Storage 索引搜索（快），索引不存在时回退到解析 OKF 文件。`,
        parameters: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: '搜索关键词（匹配 title 字段）',
                },
                entity: {
                    type: 'string',
                    enum: ['customer', 'deal', 'action', 'all'],
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
        // Try index first, fall back to file scan
        let items = await readStorageIndex(workspace, type);
        if (!Array.isArray(items) || items.length === 0) {
            items = await scanEntityFiles(workspace, type);
        }
        for (const item of items) {
            // Name match
            if (queryLower && !matchesQuery(item, queryLower))
                continue;
            // Filter match
            if (!matchesFilters(item, filters))
                continue;
            allResults.push({ ...item, _entity: type });
        }
    }
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
function matchesQuery(item, queryLower) {
    const title = (item.title || '').toLowerCase();
    return title.includes(queryLower);
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
