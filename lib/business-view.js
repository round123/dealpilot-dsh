// Provider-neutral presentation data for DealPilot tool results.
// The canonical tool output remains the source for the model; this projection
// is only the compact, replay-safe payload consumed by the DealPilot toolview.
function compact(value, depth = 0) {
    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
        return value;
    if (depth > 2)
        return '[详情已折叠]';
    if (Array.isArray(value))
        return value.slice(0, 20).map((item) => compact(item, depth + 1));
    if (typeof value === 'object') {
        const result = {};
        for (const [key, item] of Object.entries(value)) {
            // Absolute paths must never reach a browser presentation payload.
            if (key === 'workspacePath' || key === 'workspace_path' || key === 'path')
                continue;
            result[key] = compact(item, depth + 1);
        }
        return result;
    }
    return String(value);
}
function entityItem(item) {
    const result = {};
    for (const key of [
        'entity', 'ref', 'title', 'status', 'customer_name', 'customer_ref', 'deal_title',
        'deal_ref', 'funnel_stage', 'risk_level', 'risk_summary', 'priority', 'due_at',
        'reason', 'relationship_stage', 'market', 'source_category', 'requires_human',
    ])
        if (item?.[key] !== undefined)
            result[key] = compact(item[key]);
    return result;
}
function resultMeta(value) {
    return value && typeof value === 'object' ? value : {};
}
export function snapshotPresentation(value) {
    const snapshot = resultMeta(value);
    const deals = Array.isArray(snapshot.deals) ? snapshot.deals.map(entityItem).slice(0, 20) : [];
    return {
        product: 'dealpilot',
        view: 'deal-list',
        title: '销售工作区快照',
        count: deals.length,
        summary: compact(snapshot.summary || {}),
        items: deals,
    };
}
export function searchPresentation(value) {
    const result = resultMeta(value);
    const items = Array.isArray(result.results) ? result.results.map(entityItem).slice(0, 20) : [];
    const entity = items.length === 1 ? items[0].entity : result.entity;
    const view = entity === 'customer' && items.length === 1
        ? 'customer-card'
        : entity === 'action' ? 'action-list' : 'deal-list';
    return {
        product: 'dealpilot',
        view,
        title: result.query ? `搜索：${result.query}` : '销售对象搜索',
        count: Number(result.count || items.length),
        summary: { entity: result.entity || 'all', filters: compact(result.filters || {}) },
        items,
        ...(items.length === 1 ? { item: items[0] } : {}),
    };
}
export function approvalPresentation(value) {
    const result = resultMeta(value);
    return {
        product: 'dealpilot', view: 'approval', title: '等待用户批准',
        preview: compact(result.preview || {}),
    };
}
export function importPresentation(_args, value) {
    const result = resultMeta(value);
    const items = Array.isArray(result.entities) ? result.entities.map(entityItem).slice(0, 20) : [];
    return {
        product: 'dealpilot', view: 'import-result', title: '导入结果', count: Number(result.created || items.length),
        summary: compact({ total: result.total, created: result.created, skipped: result.skipped, warnings: result.warnings }),
        items,
    };
}
