import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { importRecordEntities, previewImportRecords } from './import-tool.js';
import { resolveWorkspace } from './okf-utils.js';
import { createConfirmation, consumeConfirmation } from './confirmation.js';
export const IMPORT_SCHEMA = 'dealpilot.import/v1';
function validateCanonicalDocument(value) { if (!value || value.schema !== IMPORT_SCHEMA || !value.source || !Array.isArray(value.sheets))
    throw new Error('canonical JSON schema 无效'); for (const sheet of value.sheets)
    if (!sheet?.name || !Array.isArray(sheet.columns) || !Array.isArray(sheet.rows))
        throw new Error('canonical JSON 工作表结构无效'); }
const jobsDir = (workspace) => path.join(workspace, 'storage', 'import-jobs');
const jobPath = (workspace, id) => path.join(jobsDir(workspace), `${id}.json`);
const readJob = async (workspace, id) => { try {
    return JSON.parse(await fs.readFile(jobPath(workspace, id), 'utf8'));
}
catch {
    throw new Error(`Import job 不存在：${id}`);
} };
const writeJob = async (workspace, job) => { await fs.mkdir(jobsDir(workspace), { recursive: true }); await fs.writeFile(jobPath(workspace, job.import_job_id), JSON.stringify(job, null, 2) + '\n'); };
async function resolveSourceFile(workspace, source, sessionId) {
    const value = source.kind === 'session_attachment' ? source.ref : source.path;
    if (!value || path.isAbsolute(value))
        throw new Error('导入源必须使用当前 Workspace 内的相对路径');
    const root = await fs.realpath(path.resolve(workspace));
    const lexical = path.resolve(root, value);
    const lexicalRel = path.relative(root, lexical);
    if (!lexicalRel || lexicalRel.startsWith('..') || path.isAbsolute(lexicalRel))
        throw new Error('导入源必须位于当前 Workspace');
    const absolute = await fs.realpath(lexical);
    const realRel = path.relative(root, absolute);
    if (!realRel || realRel.startsWith('..') || path.isAbsolute(realRel))
        throw new Error('导入源解析后位于当前 Workspace 之外');
    const stat = await fs.stat(absolute);
    if (!stat.isFile())
        throw new Error('导入源必须是普通文件');
    if (stat.size > 25 * 1024 * 1024)
        throw new Error('导入源超过 25 MB 大小限制');
    const relative = realRel.replaceAll('\\', '/');
    if (source.kind === 'session_attachment' && (!sessionId || !relative.startsWith(`.dsh-uploads/${sessionId}/`)))
        throw new Error('导入附件不属于当前 session');
    return { absolute, relative };
}
function keyFor(label, index) { const value = String(label ?? '').trim(); return (value || `column_${index + 1}`).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '_'); }
function columnIndex(value) { let column = 0; for (const char of value.toUpperCase())
    column = column * 26 + char.charCodeAt(0) - 64; return column; }
function columnName(value) { let column = value; let result = ''; while (column > 0) {
    const remainder = (column - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    column = Math.floor((column - 1) / 26);
} return result || 'A'; }
function rangeBounds(ranges) { const bounds = ranges.flatMap((value) => { const match = /(?:^|:)([A-Za-z]+)(\d+)$/u.exec(String(value)); return match ? [{ column: columnIndex(match[1]), row: Number(match[2]) }] : []; }); if (!bounds.length)
    return undefined; return bounds.reduce((max, item) => ({ column: Math.max(max.column, item.column), row: Math.max(max.row, item.row) }), { column: 1, row: 1 }); }
function quoteSheet(name) { return `'${name.replaceAll("'", "''")}'`; }
function cellValue(cell, display) { return display !== undefined && display !== null ? String(display) : String(cell?.v ?? cell?.value ?? ''); }
async function convertSource(workspace, sourceInput, sessionId, importId, univer) {
    const resolved = await resolveSourceFile(workspace, sourceInput, sessionId);
    const bytes = await fs.readFile(resolved.absolute);
    const name = path.basename(resolved.relative);
    const ext = path.extname(name).toLowerCase();
    if (!['.xlsx', '.xlsm', '.csv', '.tsv'].includes(ext))
        throw new Error(`暂不支持该导入文件类型：${ext || '未知'}`);
    const archived = `sources/imports/${importId}/source${ext}`;
    const univerRef = `sources/imports/${importId}/document.univer`;
    const absoluteUniver = path.join(workspace, univerRef);
    await fs.mkdir(path.dirname(absoluteUniver), { recursive: true });
    await fs.writeFile(path.join(workspace, archived), bytes);
    let worktreeId = '';
    try {
        await univer.newFile({ workspace, file: absoluteUniver });
        const created = await univer.worktree({ action: 'create', workspace, file: absoluteUniver, name: `Import ${name}` });
        worktreeId = String(created?.result?.worktreeId || created?.worktreeId || '');
        if (!worktreeId)
            throw new Error('Univer 未返回导入 worktree');
        await univer.importUnitContent({ workspace, file: absoluteUniver, sourceWorkspace: workspace, source: resolved.absolute, worktreeId, name: path.basename(name, ext) });
        const status = await univer.status({ workspace, file: absoluteUniver, worktreeId });
        const units = status?.result?.selectedWorktree?.units || [];
        const sheetUnit = units.find((unit) => unit.kind === 'sheet' || unit.type === 2);
        if (!sheetUnit?.unitId)
            throw new Error('Univer 导入结果没有 Sheet Unit');
        const workbookInspection = await univer.inspectUnitContent({ workspace, file: absoluteUniver, unitId: sheetUnit.unitId, worktreeId });
        const workbook = workbookInspection?.result;
        const worksheets = Array.isArray(workbook?.worksheets) ? workbook.worksheets : [];
        const sheets = [];
        for (const overview of worksheets) {
            const usedRanges = Array.isArray(overview.valueUsedRanges) ? overview.valueUsedRanges : [];
            const end = rangeBounds(usedRanges);
            if (!end) {
                sheets.push({ name: String(overview.name), columns: [], rows: [] });
                continue;
            }
            const sheetName = String(overview.name);
            const firstRange = `${quoteSheet(sheetName)}!A1:${columnName(end.column)}${end.row}`;
            const fallbackEnd = rangeBounds([`${columnName(Math.max(1, Number(overview.columnCount) || end.column))}${Math.max(end.row, Number(overview.rowCount) || end.row)}`]);
            const rangesToTry = [firstRange];
            if (fallbackEnd && (fallbackEnd.row > end.row || fallbackEnd.column > end.column))
                rangesToTry.push(`${quoteSheet(sheetName)}!A1:${columnName(fallbackEnd.column)}${fallbackEnd.row}`);
            let display = [];
            let rawCells = [];
            let lastRange = firstRange;
            for (const requestedRange of rangesToTry) {
                lastRange = requestedRange;
                const inspected = await univer.inspectUnitContent({ workspace, file: absoluteUniver, unitId: sheetUnit.unitId, worktreeId, range: requestedRange });
                const range = inspected?.result?.ranges?.[0];
                display = Array.isArray(range?.displayValues) ? range.displayValues : [];
                rawCells = Array.isArray(range?.cellData) ? range.cellData : [];
                if (display.slice(1).some((row) => Array.isArray(row) && row.some((value) => value !== undefined && value !== null && String(value) !== '')))
                    break;
            }
            if (display.length <= 1 && end.row > 1)
                throw new Error(`Univer Sheet ${sheetName} 数据读取为空（范围 ${lastRange}，usedRanges=${JSON.stringify(usedRanges)}）`);
            const header = Array.isArray(display[0]) ? display[0] : [];
            const columns = header.map((label, index) => ({ key: keyFor(label, index), label: String(label ?? `列 ${index + 1}`), index }));
            const rows = display.slice(1).map((row, rowIndex) => { const values = Object.fromEntries(columns.map((column) => [column.key, cellValue(rawCells[rowIndex + 1]?.[column.index], row?.[column.index])])); const raw = Object.fromEntries(columns.map((column) => [column.key, rawCells[rowIndex + 1]?.[column.index] ?? null])); return { rowNumber: rowIndex + 2, values, raw, warnings: [] }; }).filter((row) => Object.values(row.values).some(Boolean));
            sheets.push({ name: String(overview.name), columns, rows });
        }
        const canonicalSource = { sessionId, name, mediaType: ext === '.xlsx' || ext === '.xlsm' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : ext === '.csv' ? 'text/csv' : 'text/tab-separated-values', sha256: createHash('sha256').update(bytes).digest('hex') };
        return { doc: { schema: IMPORT_SCHEMA, source: canonicalSource, sheets, warnings: [], provenance: { converter: 'univer', convertedAt: new Date().toISOString() } }, original: resolved.relative, archived, univerRef, worktreeId };
    }
    finally {
        if (worktreeId)
            await univer.worktree({ action: 'discard', workspace, file: absoluteUniver, worktreeId }).catch(() => undefined);
    }
}
function selectedSheets(doc, sheet, sheets) { const names = sheets?.length ? new Set(sheets) : sheet ? new Set([sheet]) : undefined; const selected = names ? doc.sheets.filter((item) => names.has(item.name)) : doc.sheets; if (!selected.length)
    throw new Error('找不到指定工作表'); return selected; }
function mappedValue(row, sheet, target, mapping) { const requested = mapping[target]; if (typeof requested === 'number')
    return row.values[sheet.columns[requested]?.key] || ''; if (typeof requested === 'string') {
    const column = sheet.columns.find((item) => item.key === requested || item.label === requested);
    if (column)
        return row.values[column.key] || '';
    if (row.values[requested] !== undefined)
        return row.values[requested];
} const aliases = { title: ['title', 'name', 'company', 'company_name', '公司名称', '客户名称', '客户'], entity: ['entity', 'type', '类型'], customer: ['customer', 'customer_name', '客户', '客户名称'] }; for (const alias of aliases[target] || [target]) {
    const column = sheet.columns.find((item) => item.key === alias || item.label === alias);
    if (column && row.values[column.key])
        return row.values[column.key];
} return row.values[target] || ''; }
function canonicalRecords(doc, target, sheet, sheets, mapping) { return selectedSheets(doc, sheet, sheets).flatMap((current) => current.rows.map((row) => { const record = { title: mappedValue(row, current, 'title', mapping), entity: target === 'mixed' ? (mappedValue(row, current, 'entity', mapping) || 'customer') : (target || 'customer') }; for (const column of current.columns)
    record[column.key] = row.values[column.key] || ''; for (const [key] of Object.entries(mapping))
    record[key] = mappedValue(row, current, key, mapping); if (record.entity === 'deal')
    record.customer = mappedValue(row, current, 'customer', mapping); return record; })); }
async function readCanonical(workspace, job) { const doc = JSON.parse(await fs.readFile(path.join(workspace, job.canonical_ref), 'utf8')); validateCanonicalDocument(doc); return doc; }
export function registerCanonicalImportTools(ctx, harness, univer) {
    harness.registerTool(ctx, harness.defineTool({ name: 'dealpilot_ingest', description: '通过 Univer 将当前 session 附件或 Workspace 文件转换为 dealpilot.import/v1 标准 JSON。', parameters: { type: 'object', properties: { source: { type: 'object', description: 'session_attachment 使用 ref，workspace_file 使用 path。', properties: { kind: { type: 'string', enum: ['session_attachment', 'workspace_file'] }, ref: { type: 'string' }, path: { type: 'string' } }, required: ['kind'] } }, required: ['source'] }, async execute(args, exec) { if (!univer)
            throw new Error('Univer 转换服务不可用'); const workspace = resolveWorkspace(ctx.config); const sessionId = String(exec?.agent?.id || ''); const input = args.source; if (!input || !['session_attachment', 'workspace_file'].includes(input.kind) || (input.kind === 'session_attachment' ? !input.ref : !input.path))
            throw new Error('导入源参数无效'); const id = `imp_${randomUUID()}`; const { doc, original, archived, univerRef, worktreeId } = await convertSource(workspace, input, sessionId, id, univer); const canonicalRef = `sources/imports/${id}/canonical.json`; await fs.writeFile(path.join(workspace, canonicalRef), JSON.stringify(doc, null, 2) + '\n'); const now = new Date().toISOString(); await writeJob(workspace, { import_job_id: id, session_id: sessionId, source_kind: input.kind, source_ref: original, archived_source_ref: archived, canonical_ref: canonicalRef, univer_ref: univerRef, univer_worktree_id: worktreeId, source: doc.source, status: 'converted', created_at: now, updated_at: now }); return JSON.stringify({ import_job_id: id, status: 'converted', source: doc.source, canonical_ref: canonicalRef, sheets: doc.sheets.map(s => ({ name: s.name, columns: s.columns, rows: s.rows.length })), warnings: doc.warnings }); } }));
    harness.registerTool(ctx, harness.defineTool({ name: 'dealpilot_import_preview', description: '读取 canonical JSON，直接应用字段映射并生成客户或交易导入预览。', parameters: { type: 'object', properties: { import_job_id: { type: 'string' }, target: { type: 'string', enum: ['customer', 'deal', 'mixed'] }, sheet: { type: 'string' }, sheets: { type: 'array', items: { type: 'string' } }, mapping: { type: 'object', additionalProperties: true } }, required: ['import_job_id'] }, async execute(args) { const workspace = resolveWorkspace(ctx.config); const job = await readJob(workspace, String(args.import_job_id)); const doc = await readCanonical(workspace, job); const target = String(args.target || 'customer'); const mapping = args.mapping || {}; const records = canonicalRecords(doc, target, args.sheet, args.sheets, mapping); const rows = await previewImportRecords(workspace, records, true); job.status = 'previewed'; job.preview_id = randomUUID(); job.updated_at = new Date().toISOString(); await writeJob(workspace, job); const payload = { import_job_id: job.import_job_id, target, sheet: args.sheet, sheets: args.sheets, mapping, preview_id: job.preview_id }; return JSON.stringify(createConfirmation('dealpilot_import_commit', payload, `已生成 ${rows.total} 条记录的业务预览，请确认后写回。`, { ...payload, ...rows })); } }));
    harness.registerTool(ctx, harness.defineTool({ name: 'dealpilot_import_commit', description: '提交已审阅的 canonical JSON 导入预览，确认后写入 OKF。', parameters: { type: 'object', properties: { import_job_id: { type: 'string' }, confirmation_token: { type: 'string' }, target: { type: 'string', enum: ['customer', 'deal', 'mixed'] }, sheet: { type: 'string' }, sheets: { type: 'array', items: { type: 'string' } }, mapping: { type: 'object', additionalProperties: true } }, required: ['import_job_id', 'confirmation_token'] }, async execute(args) { const workspace = resolveWorkspace(ctx.config); const job = await readJob(workspace, String(args.import_job_id)); if (job.status === 'committed')
            throw new Error('Import job 已提交，不能重复提交'); const doc = await readCanonical(workspace, job); const target = String(args.target || 'customer'); const mapping = args.mapping || {}; const payload = { import_job_id: job.import_job_id, target, sheet: args.sheet, sheets: args.sheets, mapping, preview_id: job.preview_id }; consumeConfirmation(args.confirmation_token, 'dealpilot_import_commit', payload); const result = await importRecordEntities(workspace, canonicalRecords(doc, target, args.sheet, args.sheets, mapping), { sourceCategory: 'canonical-import', sourceLabel: doc.source.name, autoDedup: true, now: new Date().toISOString() }); job.status = 'committed'; job.updated_at = new Date().toISOString(); await writeJob(workspace, job); return JSON.stringify({ ...result, import_job_id: job.import_job_id, status: job.status }); } }));
}
