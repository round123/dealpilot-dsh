import { resolveWorkspace } from './okf-utils.js';
import { artifactLimits, getArtifact, listArtifacts, readArtifactBytes, stageArtifact, deleteArtifact } from './artifact-store.js';
import { inferFormat, parseXlsx } from './import-parser.js';
import { previewImport, importEntities } from './import-tool.js';
import { createConfirmation, consumeConfirmation } from './confirmation.js';
export function registerArtifactTools(ctx, harness) {
    const common = { type: 'object', properties: {} };
    harness.registerTool(ctx, harness.defineTool({
        name: 'dealpilot_artifact_list', description: '列出当前 DealPilot Workspace 中已上传的导入资料。', parameters: common,
        output: { schema: { type: 'object' }, render(_a, value) { return [{ type: 'text', text: `资料文件：${value}` }]; } },
        async execute() { return JSON.stringify({ artifacts: await listArtifacts(resolveWorkspace(ctx.config)), limits: artifactLimits() }); },
    }));
    harness.registerTool(ctx, harness.defineTool({
        name: 'dealpilot_artifact_inspect', description: '检查导入资料的格式、大小和可用工作表。',
        parameters: { type: 'object', properties: { artifact_id: { type: 'string' }, sheet: { type: 'string' } }, required: ['artifact_id'] },
        output: { schema: { type: 'object' } },
        async execute(args) {
            const workspace = resolveWorkspace(ctx.config);
            const artifact = await getArtifact(workspace, args.artifact_id);
            if (!artifact)
                throw new Error('Artifact 不存在');
            const format = inferFormat(artifact.originalName);
            if (format === 'xlsx') {
                const parsed = await parseXlsx(await readArtifactBytes(workspace, artifact), { sheet: args.sheet });
                return JSON.stringify({ artifact, format, sheet: parsed.sheet, columns: parsed.columns, rows: parsed.rows.slice(0, 10), warnings: parsed.warnings });
            }
            return JSON.stringify({ artifact, format });
        },
    }));
    harness.registerTool(ctx, harness.defineTool({
        name: 'dealpilot_import_preview', description: '解析 Artifact 并生成客户/交易导入预览。',
        parameters: { type: 'object', properties: { artifact_id: { type: 'string' }, format: { type: 'string', enum: ['csv', 'markdown', 'text', 'xlsx'] }, target: { type: 'string', enum: ['customer', 'deal', 'mixed'] }, sheet: { type: 'string' }, header_row: { type: 'number' }, mapping: { type: 'object' }, auto_dedup: { type: 'boolean' } }, required: ['artifact_id'] }, output: { schema: { type: 'object' } },
        async execute(args) {
            const workspace = resolveWorkspace(ctx.config);
            const artifact = await getArtifact(workspace, args.artifact_id);
            if (!artifact)
                throw new Error('Artifact 不存在');
            const format = inferFormat(artifact.originalName, args.format);
            const bytes = await readArtifactBytes(workspace, artifact);
            let data;
            let normalized;
            if (format === 'xlsx') {
                normalized = await parseXlsx(bytes, { sheet: args.sheet, headerRow: args.header_row });
                data = rowsToCsv(normalized.rows, args.mapping || {});
            }
            else
                data = bytes.toString('utf8');
            const parsed = await previewImport(workspace, data, format === 'xlsx' ? 'csv' : format, args.auto_dedup !== false);
            const payload = { artifact_id: artifact.id, sha256: artifact.sha256, target: args.target || 'customer', sheet: args.sheet || null, header_row: args.header_row || 1, mapping: args.mapping || {}, auto_dedup: args.auto_dedup !== false };
            return createConfirmation('dealpilot_import_commit', payload, `已解析 ${parsed.total} 条记录，请确认导入。`, { ...parsed, artifact: { id: artifact.id, name: artifact.originalName }, import_payload: payload });
        },
    }));
    harness.registerTool(ctx, harness.defineTool({
        name: 'dealpilot_import_commit', description: '提交已经预览并确认的 Artifact 导入。',
        parameters: { type: 'object', properties: { artifact_id: { type: 'string' }, format: { type: 'string', enum: ['csv', 'markdown', 'text', 'xlsx'] }, target: { type: 'string', enum: ['customer', 'deal', 'mixed'] }, sheet: { type: 'string' }, header_row: { type: 'number' }, mapping: { type: 'object' }, auto_dedup: { type: 'boolean' }, confirmation_token: { type: 'string' } }, required: ['artifact_id', 'confirmation_token'] }, output: { schema: { type: 'object' } },
        async execute(args) {
            const workspace = resolveWorkspace(ctx.config);
            const artifact = await getArtifact(workspace, args.artifact_id);
            if (!artifact)
                throw new Error('Artifact 不存在');
            const payload = { artifact_id: artifact.id, sha256: artifact.sha256, target: args.target || 'customer', sheet: args.sheet || null, header_row: args.header_row || 1, mapping: args.mapping || {}, auto_dedup: args.auto_dedup !== false };
            consumeConfirmation(args.confirmation_token, 'dealpilot_import_commit', payload);
            const format = inferFormat(artifact.originalName, args.format);
            const bytes = await readArtifactBytes(workspace, artifact);
            let data = bytes.toString('utf8');
            if (format === 'xlsx') {
                const parsed = await parseXlsx(bytes, { sheet: args.sheet, headerRow: args.header_row });
                data = rowsToCsv(parsed.rows, args.mapping || {});
            }
            const result = await importEntities(workspace, data, format === 'xlsx' ? 'csv' : format, { sourceCategory: 'artifact-import', sourceLabel: artifact.originalName, autoDedup: args.auto_dedup !== false, now: new Date().toISOString() });
            await updateArtifactStatus(workspace, artifact.id, 'imported');
            return result;
        },
    }));
}
function rowsToCsv(rows, mapping) {
    if (!rows.length)
        return 'title\n';
    const source = Object.keys(rows[0]);
    const columns = source.map(key => mapping[key] || key);
    const esc = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
    return [columns.join(','), ...rows.map(row => source.map(key => esc(row[key])).join(','))].join('\n');
}
async function updateArtifactStatus(workspace, id, status) {
    const store = await import('./artifact-store.js');
    await store.updateArtifact(workspace, id, { status });
}
export async function stageUploadedArtifact(workspace, workspaceId, name, mediaType, bytes) {
    return stageArtifact(workspace, workspaceId, name, mediaType, bytes);
}
export { getArtifact, listArtifacts, deleteArtifact, readArtifactBytes };
