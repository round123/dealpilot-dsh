import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { resolveWorkspace } from './okf-utils.js';

export const IMPORT_SCHEMA = 'dealpilot.import/v1';
type JobStatus = 'converted' | 'previewed' | 'committed' | 'failed';
type IngestSource = { kind: 'session_attachment'; ref: string } | { kind: 'workspace_file'; path: string };
type UniverService = { newFile(request: any, signal?: AbortSignal): Promise<any>; worktree(request: any, signal?: AbortSignal): Promise<any>; importUnitContent(request: any, signal?: AbortSignal): Promise<any>; status(request: any, signal?: AbortSignal): Promise<any>; inspectUnitContent(request: any, signal?: AbortSignal): Promise<any> };
export interface CanonicalRow { rowNumber: number; values: Record<string, string>; raw: Record<string, unknown>; warnings: string[]; }
export interface CanonicalDocument { schema: typeof IMPORT_SCHEMA; source: { sessionId: string; name: string; mediaType: string; sha256: string }; sheets: Array<{ name: string; columns: Array<{ key: string; label: string; index: number }>; rows: CanonicalRow[] }>; warnings: string[]; provenance: { converter: string; convertedAt: string }; }
export interface ImportJob { import_job_id: string; session_id: string; source_kind: IngestSource['kind']; source_ref: string; archived_source_ref: string; canonical_ref: string; univer_ref: string; univer_worktree_id: string; source: CanonicalDocument['source']; status: JobStatus; created_at: string; updated_at: string; preview_id?: string; }

export function validateCanonicalDocument(value: any): asserts value is CanonicalDocument {
  if (!value || value.schema !== IMPORT_SCHEMA || !value.source || typeof value.source !== 'object' || !Array.isArray(value.sheets) || !Array.isArray(value.warnings) || !value.provenance) throw new Error('canonical JSON schema 无效');
  for (const key of ['sessionId', 'name', 'mediaType', 'sha256']) if (typeof value.source[key] !== 'string') throw new Error('canonical JSON source 结构无效');
  if (typeof value.provenance.converter !== 'string' || typeof value.provenance.convertedAt !== 'string') throw new Error('canonical JSON provenance 结构无效');
  for (const sheet of value.sheets) {
    if (!sheet?.name || !Array.isArray(sheet.columns) || !Array.isArray(sheet.rows)) throw new Error('canonical JSON 工作表结构无效');
    for (const column of sheet.columns) if (typeof column?.key !== 'string' || typeof column?.label !== 'string' || !Number.isInteger(column.index) || column.index < 0) throw new Error('canonical JSON 列结构无效');
    for (const row of sheet.rows) if (!Number.isInteger(row?.rowNumber) || row.rowNumber < 1 || !row.values || typeof row.values !== 'object' || !row.raw || typeof row.raw !== 'object' || !Array.isArray(row.warnings)) throw new Error('canonical JSON 行结构无效');
  }
}
const jobsDir = (workspace: string) => path.join(workspace, 'storage', 'import-jobs');
const jobPath = (workspace: string, id: string) => path.join(jobsDir(workspace), `${id}.json`);
const readJob = async (workspace: string, id: string): Promise<ImportJob> => { try { return JSON.parse(await fs.readFile(jobPath(workspace, id), 'utf8')); } catch { throw new Error(`Import job 不存在：${id}`); } };
const writeJob = async (workspace: string, job: ImportJob) => { await fs.mkdir(jobsDir(workspace), { recursive: true }); await fs.writeFile(jobPath(workspace, job.import_job_id), JSON.stringify(job, null, 2) + '\n'); };

async function resolveSourceFile(workspace: string, source: IngestSource, sessionId: string): Promise<{ absolute: string; relative: string }> {
  const value = source.kind === 'session_attachment' ? source.ref : source.path;
  if (!value || path.isAbsolute(value)) throw new Error('导入源必须使用当前 Workspace 内的相对路径');
  const root = await fs.realpath(path.resolve(workspace)); const lexical = path.resolve(root, value); const lexicalRel = path.relative(root, lexical);
  if (!lexicalRel || lexicalRel.startsWith('..') || path.isAbsolute(lexicalRel)) throw new Error('导入源必须位于当前 Workspace');
  const absolute = await fs.realpath(lexical); const realRel = path.relative(root, absolute);
  if (!realRel || realRel.startsWith('..') || path.isAbsolute(realRel)) throw new Error('导入源解析后位于当前 Workspace 之外');
  const stat = await fs.stat(absolute); if (!stat.isFile()) throw new Error('导入源必须是普通文件'); if (stat.size > 25 * 1024 * 1024) throw new Error('导入源超过 25 MB 大小限制');
  const relative = realRel.replaceAll('\\', '/'); if (source.kind === 'session_attachment' && (!sessionId || !relative.startsWith(`.dsh-uploads/${sessionId}/`))) throw new Error('导入附件不属于当前 session');
  return { absolute, relative };
}
function keyFor(label: unknown, index: number): string { const value = String(label ?? '').trim(); return (value || `column_${index + 1}`).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '_'); }
function columnIndex(value: string): number { let column = 0; for (const char of value.toUpperCase()) column = column * 26 + char.charCodeAt(0) - 64; return column; }
function columnName(value: number): string { let column = value; let result = ''; while (column > 0) { const remainder = (column - 1) % 26; result = String.fromCharCode(65 + remainder) + result; column = Math.floor((column - 1) / 26); } return result || 'A'; }
function rangeBounds(ranges: unknown[]): { column: number; row: number } | undefined { const bounds = ranges.flatMap((value) => { const match = /(?:^|:)([A-Za-z]+)(\d+)$/u.exec(String(value)); return match ? [{ column: columnIndex(match[1]), row: Number(match[2]) }] : []; }); if (!bounds.length) return undefined; return bounds.reduce((max, item) => ({ column: Math.max(max.column, item.column), row: Math.max(max.row, item.row) }), { column: 1, row: 1 }); }
function quoteSheet(name: string): string { return `'${name.replaceAll("'", "''")}'`; }
function cellValue(cell: any, display: unknown): string { return display !== undefined && display !== null ? String(display) : String(cell?.v ?? cell?.value ?? ''); }

async function convertSource(workspace: string, sourceInput: IngestSource, sessionId: string, importId: string, univer: UniverService): Promise<{ doc: CanonicalDocument; original: string; archived: string; univerRef: string; worktreeId: string }> {
  const resolved = await resolveSourceFile(workspace, sourceInput, sessionId); const bytes = await fs.readFile(resolved.absolute); const name = path.basename(resolved.relative); const ext = path.extname(name).toLowerCase();
  if (!['.xlsx', '.xlsm', '.csv', '.tsv'].includes(ext)) throw new Error(`暂不支持该导入文件类型：${ext || '未知'}`);
  const archived = `sources/imports/${importId}/source${ext}`; const univerRef = `sources/imports/${importId}/document.univer`; const absoluteUniver = path.join(workspace, univerRef);
  await fs.mkdir(path.dirname(absoluteUniver), { recursive: true }); await fs.writeFile(path.join(workspace, archived), bytes); let worktreeId = '';
  try {
    await univer.newFile({ workspace, file: absoluteUniver }); const created = await univer.worktree({ action: 'create', workspace, file: absoluteUniver, name: `Import ${name}` }); worktreeId = String(created?.result?.worktreeId || created?.worktreeId || ''); if (!worktreeId) throw new Error('Univer 未返回导入 worktree');
    await univer.importUnitContent({ workspace, file: absoluteUniver, sourceWorkspace: workspace, source: resolved.absolute, worktreeId, name: path.basename(name, ext) });
    const status = await univer.status({ workspace, file: absoluteUniver, worktreeId }); const units = status?.result?.selectedWorktree?.units || []; const sheetUnit = units.find((unit: any) => unit.kind === 'sheet' || unit.type === 2); if (!sheetUnit?.unitId) throw new Error('Univer 导入结果没有 Sheet Unit');
    const workbookInspection = await univer.inspectUnitContent({ workspace, file: absoluteUniver, unitId: sheetUnit.unitId, worktreeId }); const workbook = workbookInspection?.result; const worksheets = Array.isArray(workbook?.worksheets) ? workbook.worksheets : []; const sheets: CanonicalDocument['sheets'] = [];
    for (const overview of worksheets) {
      const usedRanges = Array.isArray(overview.valueUsedRanges) ? overview.valueUsedRanges : []; const end = rangeBounds(usedRanges);
      if (!end) { sheets.push({ name: String(overview.name), columns: [], rows: [] }); continue; }
      const sheetName = String(overview.name); const firstRange = `${quoteSheet(sheetName)}!A1:${columnName(end.column)}${end.row}`;
      const fallbackEnd = rangeBounds([`${columnName(Math.max(1, Number(overview.columnCount) || end.column))}${Math.max(end.row, Number(overview.rowCount) || end.row)}`]);
      const rangesToTry = [firstRange]; if (fallbackEnd && (fallbackEnd.row > end.row || fallbackEnd.column > end.column)) rangesToTry.push(`${quoteSheet(sheetName)}!A1:${columnName(fallbackEnd.column)}${fallbackEnd.row}`);
      let display: unknown[][] = []; let rawCells: unknown[][] = []; let lastRange = firstRange;
      for (const requestedRange of rangesToTry) { lastRange = requestedRange; const inspected = await univer.inspectUnitContent({ workspace, file: absoluteUniver, unitId: sheetUnit.unitId, worktreeId, range: requestedRange }); const range = inspected?.result?.ranges?.[0]; display = Array.isArray(range?.displayValues) ? range.displayValues : []; rawCells = Array.isArray(range?.cellData) ? range.cellData : []; if (display.slice(1).some((row: any) => Array.isArray(row) && row.some((value: unknown) => value !== undefined && value !== null && String(value) !== ''))) break; }
      if (display.length <= 1 && end.row > 1) throw new Error(`Univer Sheet ${sheetName} 数据读取为空（范围 ${lastRange}，usedRanges=${JSON.stringify(usedRanges)}）`);
      const header = Array.isArray(display[0]) ? display[0] : []; const columns = header.map((label: unknown, index: number) => ({ key: keyFor(label, index), label: String(label ?? `列 ${index + 1}`), index }));
      const rows = display.slice(1).map((row: unknown[], rowIndex: number) => { const values = Object.fromEntries(columns.map((column) => [column.key, cellValue(rawCells[rowIndex + 1]?.[column.index], row?.[column.index])])); const raw = Object.fromEntries(columns.map((column) => [column.key, rawCells[rowIndex + 1]?.[column.index] ?? null])); return { rowNumber: rowIndex + 2, values, raw, warnings: [] }; }).filter((row: CanonicalRow) => Object.values(row.values).some(Boolean));
      sheets.push({ name: String(overview.name), columns, rows });
    }
    const canonicalSource = { sessionId, name, mediaType: ext === '.xlsx' || ext === '.xlsm' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : ext === '.csv' ? 'text/csv' : 'text/tab-separated-values', sha256: createHash('sha256').update(bytes).digest('hex') };
    return { doc: { schema: IMPORT_SCHEMA, source: canonicalSource, sheets, warnings: [], provenance: { converter: 'univer', convertedAt: new Date().toISOString() } }, original: resolved.relative, archived, univerRef, worktreeId };
  } finally { if (worktreeId) await univer.worktree({ action: 'discard', workspace, file: absoluteUniver, worktreeId }).catch(() => undefined); }
}


export function registerCanonicalImportTools(ctx: Record<string, any>, harness: any, univer?: UniverService): void {
  harness.registerTool(ctx, harness.defineTool({ name: 'dealpilot_ingest', description: '通过 Univer 将当前 session 附件或 Workspace 文件转换为 dealpilot.import/v1 标准 JSON。', parameters: { type: 'object', properties: { source: { type: 'object', description: 'session_attachment 使用 ref，workspace_file 使用 path。', properties: { kind: { type: 'string', enum: ['session_attachment', 'workspace_file'] }, ref: { type: 'string' }, path: { type: 'string' } }, required: ['kind'] } }, required: ['source'] }, async execute(args: any, exec?: any) { if (!univer) throw new Error('Univer 转换服务不可用'); const workspace = resolveWorkspace(ctx.config); const sessionId = String(exec?.agent?.id || ''); const input = args.source as IngestSource; if (!input || !['session_attachment', 'workspace_file'].includes(input.kind) || (input.kind === 'session_attachment' ? !input.ref : !input.path)) throw new Error('导入源参数无效'); const id = `imp_${randomUUID()}`; const { doc, original, archived, univerRef, worktreeId } = await convertSource(workspace, input, sessionId, id, univer); const canonicalRef = `sources/imports/${id}/canonical.json`; await fs.writeFile(path.join(workspace, canonicalRef), JSON.stringify(doc, null, 2) + '\n'); const now = new Date().toISOString(); await writeJob(workspace, { import_job_id: id, session_id: sessionId, source_kind: input.kind, source_ref: original, archived_source_ref: archived, canonical_ref: canonicalRef, univer_ref: univerRef, univer_worktree_id: worktreeId, source: doc.source, status: 'converted', created_at: now, updated_at: now }); return JSON.stringify({ import_job_id: id, status: 'converted', source: doc.source, canonical_ref: canonicalRef, sheets: doc.sheets.map(s => ({ name: s.name, columns: s.columns, rows: s.rows.length })), warnings: doc.warnings }); } }));
}
