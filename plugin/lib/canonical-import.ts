import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolutePathLike, resolveWorkspace } from './okf-utils.js';
import { stableStringify } from './contract-utils.js';
import { resolveArtifactForWrite, resolveRegularArtifact } from './artifact-store.js';
import {
  EVIDENCE_SCHEMA,
  computeEvidenceDigest,
  makeEvidenceCell,
  rowHash,
  sourceIdForSha256,
  sheetIdForIndex,
  columnIdForIndex,
  rowIdFor,
  cellAddress,
  columnName,
  columnIndex,
  evidenceAccountingFor,
  validateEvidenceDocument,
  type EvidenceCell,
  type EvidenceColumn,
  type EvidenceDocument,
  type EvidenceRepresentationInputs,
  type EvidenceRow,
  type EvidenceSheet,
  type EvidenceSource,
} from './evidence-contract.js';

export { EVIDENCE_SCHEMA };

export const IMPORT_JOB_SCHEMA = 'dealpilot.import-job/v2' as const;
export const IMPORT_MANIFEST_SCHEMA = 'dealpilot.import-manifest/v2' as const;

type JobStatus = 'received' | 'converted' | 'previewed' | 'committed' | 'failed';
export type IngestSource = { kind: 'session_attachment'; ref: string } | { kind: 'workspace_file'; path: string };
type UniverService = {
  newFile(request: any, signal?: AbortSignal): Promise<any>;
  worktree(request: any, signal?: AbortSignal): Promise<any>;
  importUnitContent(request: any, signal?: AbortSignal): Promise<any>;
  status(request: any, signal?: AbortSignal): Promise<any>;
  inspectUnitContent(request: any, signal?: AbortSignal): Promise<any>;
};

type SourceCellMetadata = {
  present: boolean;
  value: unknown;
  display: string;
  formula: string | null;
  valueType: string;
};

type SourceSheetMetadata = {
  hidden: boolean;
  cells: Map<string, SourceCellMetadata>;
};

/** Read source-side XLSX semantics that the Univer inspection adapter may flatten. */
async function readSourceWorkbookMetadata(bytes: Buffer, ext: string): Promise<Map<string, SourceSheetMetadata>> {
  const result = new Map<string, SourceSheetMetadata>();
  if (!['.xlsx', '.xlsm'].includes(ext)) return result;
  try {
    const module: any = await import('exceljs');
    const ExcelJS = module.default ?? module;
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes);
    for (const worksheet of workbook.worksheets || []) {
      const cells = new Map<string, SourceCellMetadata>();
      const maxRows = Number(worksheet.actualRowCount || worksheet.rowCount || 0);
      const maxColumns = Number(worksheet.actualColumnCount || worksheet.columnCount || 0);
      for (let rowNumber = 1; rowNumber <= maxRows; rowNumber++) {
        for (let columnNumber = 1; columnNumber <= maxColumns; columnNumber++) {
          const cell = worksheet.getCell(rowNumber, columnNumber);
          const address = cell.address;
          const formulaValue = cell.value && typeof cell.value === 'object' && 'formula' in cell.value
            ? cell.value : undefined;
          const formula = formulaValue?.formula ? String(formulaValue.formula) : null;
          const value = formulaValue ? formulaValue.result : cell.value;
          const valueType = formula ? 'formula'
            : typeof value === 'number' ? 'number'
              : typeof value === 'boolean' ? 'boolean'
                : value instanceof Date ? 'date'
                  : value === null || value === undefined || value === '' ? 'empty'
                    : typeof value === 'string' ? 'string' : 'object';
          cells.set(address, { present: true, value, display: String(cell.text ?? ''), formula, valueType });
        }
      }
      result.set(String(worksheet.name), { hidden: worksheet.state === 'hidden' || worksheet.state === 'veryHidden', cells });
    }
  } catch (error: any) {
    // Univer remains the primary adapter. A missing/invalid optional source
    // parser must degrade to its payload rather than discard the import.
    console.warn('[dealpilot] source workbook metadata unavailable:', String(error?.message || error));
  }
  return result;
}

function sourceAwareCell(rawCell: unknown, source: SourceCellMetadata | undefined): unknown {
  if (!source) return rawCell;
  const adapterPayload = rawCell === undefined ? undefined : rawCell;
  return {
    ...(rawCell && typeof rawCell === 'object' && !Array.isArray(rawCell) ? rawCell as Record<string, unknown> : {}),
    v: source.value,
    ...(source.formula ? { f: source.formula } : {}),
    value_type: source.valueType,
    source_display: source.display,
    ...(adapterPayload === undefined ? {} : { adapter_payload: adapterPayload }),
  };
}

export type CanonicalDocument = EvidenceDocument;

export interface ImportJob {
  schema: typeof IMPORT_JOB_SCHEMA;
  import_job_id: string;
  session_id: string;
  source_kind: IngestSource['kind'];
  source_ref: string;
  archived_source_ref: string;
  canonical_ref: string;
  manifest_ref: string;
  univer_ref: string;
  univer_worktree_id: string;
  source: EvidenceSource;
  source_id: string;
  evidence_digest: string;
  accounting: EvidenceDocument['accounting'];
  status: JobStatus;
  created_at: string;
  updated_at: string;
  preview_id?: string;
  error?: string;
}

export interface ImportManifest {
  schema: typeof IMPORT_MANIFEST_SCHEMA;
  import_job_id: string;
  source: EvidenceSource;
  source_ref: string;
  archived_source_ref: string;
  canonical_ref: string;
  manifest_ref: string;
  univer_ref: string;
  evidence_digest: string;
  accounting: EvidenceDocument['accounting'];
  warnings: string[];
  provenance: EvidenceDocument['provenance'];
}

/** Validate the sole canonical evidence contract. */
export function validateCanonicalDocument(value: any): asserts value is CanonicalDocument {
  if (value?.schema !== EVIDENCE_SCHEMA) throw new Error(`canonical JSON schema 无效：需要 ${EVIDENCE_SCHEMA}`);
  validateEvidenceDocument(value);
}

function emptyAccounting(): EvidenceDocument['accounting'] {
  return {
    sheet_count: 0,
    row_count: 0,
    cell_count: 0,
    preserved_cell_count: 0,
    observation_count: 0,
    column_count: 0,
    unreadable_cell_count: 0,
    header_count: 0,
    data_cell_count: 0,
  };
}

function importId(value: unknown): string {
  if (typeof value !== 'string' || !/^imp_[A-Za-z0-9_-]+$/u.test(value)) throw new Error('Import job 编号格式无效');
  return value;
}

function requiredString(value: unknown, field: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.trim() === '')) throw new Error(`Import job ${field} 无效`);
  return value;
}

function digestString(value: unknown, field: string, allowEmpty = false): string {
  const text = requiredString(value, field, allowEmpty).replace(/^sha256:/u, '').toLowerCase();
  if (allowEmpty && text === '') return '';
  if (!/^[a-f0-9]{64}$/u.test(text)) throw new Error(`Import job ${field} 必须是 SHA-256`);
  return text;
}

function safeArtifactRef(workspace: string, value: unknown, field: string, allowEmpty = false): string {
  const ref = requiredString(value, field, allowEmpty).replaceAll('\\', '/');
  if (!ref) return '';
  if (path.isAbsolute(ref) || /^[A-Za-z]:[\\/]/u.test(ref) || ref.split('/').some((part) => part === '..')) throw new Error(`Import job ${field} 必须是 Workspace 内相对路径`);
  const root = path.resolve(workspace);
  const resolved = path.resolve(root, ref);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Import job ${field} 必须位于当前 Workspace`);
  return relative.replaceAll('\\', '/');
}

function isoDate(value: unknown, field: string): string {
  const text = requiredString(value, field);
  if (!Number.isFinite(Date.parse(text))) throw new Error(`Import job ${field} 必须是 ISO 时间`);
  return text;
}

function sourceRecord(value: unknown, field = 'source'): EvidenceSource {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Import job ${field} 无效`);
  const source = value as Record<string, unknown>;
  const digest = digestString(source.sha256, `${field}.sha256`);
  const result = {
    ...source,
    source_id: requiredString(source.source_id, `${field}.source_id`),
    name: requiredString(source.name, `${field}.name`),
    media_type: requiredString(source.media_type, `${field}.media_type`),
    sha256: digest,
    session_id: requiredString(source.session_id, `${field}.session_id`, true),
    archived_ref: requiredString(source.archived_ref, `${field}.archived_ref`, true),
  } as EvidenceSource;
  return result;
}

function accountingRecord(value: unknown, field = 'accounting'): EvidenceDocument['accounting'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Import job ${field} 无效`);
  const source = value as Record<string, unknown>;
  const keys = ['sheet_count', 'row_count', 'cell_count', 'preserved_cell_count', 'observation_count', 'column_count', 'unreadable_cell_count', 'header_count', 'data_cell_count'] as const;
  const result = {} as EvidenceDocument['accounting'];
  for (const key of keys) {
    const item = source[key];
    if (!Number.isSafeInteger(item) || Number(item) < 0) throw new Error(`Import job ${field}.${key} 无效`);
    result[key] = Number(item);
  }
  if (result.cell_count !== result.observation_count || result.cell_count !== result.header_count + result.data_cell_count) throw new Error(`Import job ${field} observation accounting 不一致`);
  if (result.preserved_cell_count > result.cell_count || result.unreadable_cell_count > result.cell_count) throw new Error(`Import job ${field} preservation accounting 不一致`);
  return result;
}

function validateImportJobRecord(value: unknown, workspace: string, expectedId?: string): ImportJob {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Import job JSON 结构无效');
  const item = value as Record<string, unknown>;
  if (item.schema !== IMPORT_JOB_SCHEMA) throw new Error(`Import job schema 无效：需要 ${IMPORT_JOB_SCHEMA}`);
  const id = importId(item.import_job_id);
  if (expectedId && id !== expectedId) throw new Error('Import job 编号与文件名不一致');
  const status = item.status;
  if (!['received', 'converted', 'previewed', 'committed', 'failed'].includes(String(status))) throw new Error('Import job status 无效');
  const sourceKind = item.source_kind;
  if (sourceKind !== 'session_attachment' && sourceKind !== 'workspace_file') throw new Error('Import job source_kind 无效');
  const source = sourceRecord(item.source);
  const sourceId = requiredString(item.source_id, 'source_id');
  const evidenceDigest = digestString(item.evidence_digest, 'evidence_digest', status === 'failed');
  const accounting = accountingRecord(item.accounting);
  const sourceRef = safeArtifactRef(workspace, item.source_ref, 'source_ref', status === 'failed');
  const archivedRef = safeArtifactRef(workspace, item.archived_source_ref, 'archived_source_ref', true);
  const canonicalRef = safeArtifactRef(workspace, item.canonical_ref, 'canonical_ref', true);
  const manifestRef = safeArtifactRef(workspace, item.manifest_ref, 'manifest_ref', true);
  const univerRef = safeArtifactRef(workspace, item.univer_ref, 'univer_ref', true);
  requiredString(item.session_id, 'session_id', true);
  requiredString(item.univer_worktree_id, 'univer_worktree_id', true);
  isoDate(item.created_at, 'created_at');
  isoDate(item.updated_at, 'updated_at');
  if (item.preview_id !== undefined) requiredString(item.preview_id, 'preview_id');
  if (item.error !== undefined) requiredString(item.error, 'error');
  if (status !== 'failed') {
    const artifactPrefix = `sources/imports/${id}/`;
    if (!canonicalRef || !manifestRef || !archivedRef || !univerRef || !evidenceDigest) throw new Error('成功 Import job 缺少完整 artifact 引用');
    if (!canonicalRef.startsWith(artifactPrefix) || !manifestRef.startsWith(artifactPrefix) || !archivedRef.startsWith(artifactPrefix) || !univerRef.startsWith(artifactPrefix)) throw new Error('成功 Import job artifact 引用不属于自身目录');
    if (path.basename(canonicalRef) !== 'canonical.json' || path.basename(manifestRef) !== 'manifest.json') throw new Error('成功 Import job canonical/manifest 引用无效');
    if (sourceId !== source.source_id || source.sha256 === '0'.repeat(64) || source.source_id !== sourceIdForSha256(source.sha256) || source.archived_ref !== archivedRef) throw new Error('Import job source 身份不一致');
  }
  if (source.archived_ref && archivedRef && source.archived_ref !== archivedRef) throw new Error('Import job source.archived_ref 不一致');
  return {
    schema: IMPORT_JOB_SCHEMA,
    import_job_id: id,
    session_id: String(item.session_id),
    source_kind: sourceKind,
    source_ref: sourceRef,
    archived_source_ref: archivedRef,
    canonical_ref: canonicalRef,
    manifest_ref: manifestRef,
    univer_ref: univerRef,
    univer_worktree_id: String(item.univer_worktree_id),
    source,
    source_id: sourceId,
    evidence_digest: evidenceDigest,
    accounting,
    status: status as JobStatus,
    created_at: String(item.created_at),
    updated_at: String(item.updated_at),
    ...(item.preview_id !== undefined ? { preview_id: String(item.preview_id) } : {}),
    ...(item.error !== undefined ? { error: String(item.error) } : {}),
  };
}

function validateManifestRecord(value: unknown, workspace: string, expectedId?: string): ImportManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Import manifest JSON 结构无效');
  const item = value as Record<string, unknown>;
  if (item.schema !== IMPORT_MANIFEST_SCHEMA) throw new Error(`Import manifest schema 无效：需要 ${IMPORT_MANIFEST_SCHEMA}`);
  const id = importId(item.import_job_id);
  if (expectedId && id !== expectedId) throw new Error('Import manifest 编号不一致');
  const source = sourceRecord(item.source, 'manifest.source');
  const sourceRef = safeArtifactRef(workspace, item.source_ref, 'manifest.source_ref');
  const archivedRef = safeArtifactRef(workspace, item.archived_source_ref, 'manifest.archived_source_ref');
  const canonicalRef = safeArtifactRef(workspace, item.canonical_ref, 'manifest.canonical_ref');
  const manifestRef = safeArtifactRef(workspace, item.manifest_ref, 'manifest.manifest_ref');
  const univerRef = safeArtifactRef(workspace, item.univer_ref, 'manifest.univer_ref');
  const evidenceDigest = digestString(item.evidence_digest, 'manifest.evidence_digest');
  const accounting = accountingRecord(item.accounting, 'manifest.accounting');
  if (!Array.isArray(item.warnings) || item.warnings.some((warning) => typeof warning !== 'string')) throw new Error('Import manifest warnings 无效');
  if (!item.provenance || typeof item.provenance !== 'object' || Array.isArray(item.provenance)) throw new Error('Import manifest provenance 无效');
  const provenance = item.provenance as Record<string, unknown>;
  requiredString(provenance.converter, 'manifest.provenance.converter');
  requiredString(provenance.converter_version, 'manifest.provenance.converter_version');
  isoDate(provenance.converted_at, 'manifest.provenance.converted_at');
  return { schema: IMPORT_MANIFEST_SCHEMA, import_job_id: id, source, source_ref: sourceRef, archived_source_ref: archivedRef, canonical_ref: canonicalRef, manifest_ref: manifestRef, univer_ref: univerRef, evidence_digest: evidenceDigest, accounting, warnings: [...(item.warnings as string[])], provenance: provenance as EvidenceDocument['provenance'] };
}

function sameAccounting(left: EvidenceDocument['accounting'], right: EvidenceDocument['accounting']): boolean {
  const keys = ['sheet_count', 'row_count', 'cell_count', 'preserved_cell_count', 'observation_count', 'column_count', 'unreadable_cell_count', 'header_count', 'data_cell_count'] as const;
  return keys.every((key) => left[key] === right[key]);
}

function sameSource(left: EvidenceSource, right: EvidenceSource): boolean {
  return left.source_id === right.source_id
    && left.name === right.name
    && left.media_type === right.media_type
    && left.sha256 === right.sha256
    && left.session_id === right.session_id
    && left.archived_ref === right.archived_ref;
}

async function verifyImportArtifacts(workspace: string, job: ImportJob): Promise<void> {
  const canonicalPath = await resolveRegularArtifact(workspace, job.canonical_ref, 'Import job canonical artifact');
  const manifestPath = await resolveRegularArtifact(workspace, job.manifest_ref, 'Import job manifest artifact');
  const archivePath = await resolveRegularArtifact(workspace, job.archived_source_ref, 'Import job source archive');
  await resolveRegularArtifact(workspace, job.univer_ref, 'Import job Univer artifact');
  // The Univer snapshot is part of the immutable evidence graph. Verify the
  // referenced artifact itself before trusting the canonical/manifest pair;
  // a missing or directory-valued snapshot would otherwise leave the import
  // job impossible to reproduce.
  let canonicalValue: unknown;
  let manifestValue: unknown;
  try { canonicalValue = JSON.parse(await fs.readFile(canonicalPath, 'utf8')); } catch { throw new Error(`Import job canonical artifact 无效：${job.canonical_ref}`); }
  const archiveBytes = await fs.readFile(archivePath).catch(() => { throw new Error(`Import job source archive 不存在：${job.archived_source_ref}`); });
  validateEvidenceDocument(canonicalValue, { source_bytes: archiveBytes });
  const canonical = canonicalValue as EvidenceDocument;
  if (canonical.evidence_digest !== job.evidence_digest || !sameSource(canonical.source, job.source) || !sameAccounting(canonical.accounting, job.accounting)) throw new Error('Import job 与 canonical evidence 不一致');
  try { manifestValue = JSON.parse(await fs.readFile(manifestPath, 'utf8')); } catch { throw new Error(`Import job manifest artifact 无效：${job.manifest_ref}`); }
  const manifest = validateManifestRecord(manifestValue, workspace, job.import_job_id);
  const artifactPrefix = `sources/imports/${job.import_job_id}/`;
  if (!manifest.canonical_ref.startsWith(artifactPrefix) || !manifest.manifest_ref.startsWith(artifactPrefix) || !manifest.archived_source_ref.startsWith(artifactPrefix) || !manifest.univer_ref.startsWith(artifactPrefix)) throw new Error('Import manifest artifact 引用不属于自身目录');
  if (manifest.source_ref !== job.source_ref || manifest.archived_source_ref !== job.archived_source_ref || manifest.canonical_ref !== job.canonical_ref || manifest.manifest_ref !== job.manifest_ref || manifest.univer_ref !== job.univer_ref || manifest.evidence_digest !== job.evidence_digest || !sameAccounting(manifest.accounting, job.accounting) || !sameSource(manifest.source, job.source) || JSON.stringify(manifest.warnings) !== JSON.stringify(canonical.warnings) || manifest.provenance.converter !== canonical.provenance.converter || manifest.provenance.converter_version !== canonical.provenance.converter_version || manifest.provenance.converted_at !== canonical.provenance.converted_at) throw new Error('Import job 与 manifest 不一致');
}

async function writeImmutableFile(filePath: string, content: string | Uint8Array): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      // Linking the fully written temporary file gives an atomic, exclusive
      // publish operation on both POSIX and Windows filesystems.
      await fs.link(temporary, filePath);
    } catch (error: any) {
      if (error?.code === 'EEXIST') {
        const existingStat = await fs.lstat(filePath).catch(() => undefined);
        if (existingStat?.isSymbolicLink()) throw new Error(`不可使用符号链接作为导入 artifact：${path.basename(filePath)}`);
        const existing = await fs.readFile(filePath).catch(() => undefined);
        if (!existing || !Buffer.from(existing).equals(Buffer.from(content))) throw new Error(`不可覆盖既有导入 artifact：${path.basename(filePath)}`);
      } else if (error?.code === 'EPERM') {
        // Some mounted filesystems disallow hard links. Fall back to an
        // exclusive destination open; this remains immutable even though the
        // publication is no longer a rename-level atomic operation.
        let destination: fs.FileHandle | undefined;
        try {
          destination = await fs.open(filePath, 'wx', 0o600);
          await destination.writeFile(content);
          await destination.sync();
        } catch (fallbackError: any) {
          if (fallbackError?.code !== 'EEXIST') throw fallbackError;
          const existingStat = await fs.lstat(filePath).catch(() => undefined);
          if (existingStat?.isSymbolicLink()) throw new Error(`不可使用符号链接作为导入 artifact：${path.basename(filePath)}`);
          const existing = await fs.readFile(filePath).catch(() => undefined);
          if (!existing || !Buffer.from(existing).equals(Buffer.from(content))) throw new Error(`不可覆盖既有导入 artifact：${path.basename(filePath)}`);
        } finally {
          await destination?.close().catch(() => undefined);
        }
      } else throw error;
    }
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    await fs.unlink(temporary).catch(() => undefined);
  }
}

async function writeJsonImmutable(filePath: string, value: unknown): Promise<void> {
  await writeImmutableFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export const readImportJob = async (workspace: string, id: string): Promise<ImportJob> => {
  const expectedId = importId(id);
  let parsed: unknown;
  try {
    const source = await resolveRegularArtifact(workspace, `storage/import-jobs/${expectedId}.json`, 'Import job');
    parsed = JSON.parse(await fs.readFile(source, 'utf8'));
  }
  catch (error: any) {
    if (error?.code === 'ENOENT') throw new Error(`Import job 不存在：${expectedId}`);
    throw new Error(`Import job JSON 无效：${expectedId}`);
  }
  const job = validateImportJobRecord(parsed, workspace, expectedId);
  if (job.status !== 'failed') await verifyImportArtifacts(workspace, job);
  return job;
};

async function writeJob(workspace: string, job: ImportJob): Promise<void> {
  const validated = validateImportJobRecord(job, workspace, job.import_job_id);
  const destination = await resolveArtifactForWrite(
    workspace,
    `storage/import-jobs/${validated.import_job_id}.json`,
    'Import job',
  );
  await writeJsonImmutable(destination, validated);
}

async function existingRegularArtifact(workspace: string, reference: string, label: string): Promise<string | undefined> {
  try {
    return await resolveRegularArtifact(workspace, reference, label);
  } catch {
    // Failure publication is best-effort. Invalid or symlinked artifacts are
    // deliberately treated as absent so the error record never reads through
    // an untrusted alias while preserving the original conversion failure.
    return undefined;
  }
}

async function resolveSourceFile(workspace: string, source: IngestSource, sessionId: string): Promise<{ absolute: string; relative: string }> {
  const value = source.kind === 'session_attachment' ? source.ref : source.path;
  if (!value || isAbsolutePathLike(value)) throw new Error('导入源必须使用当前 Workspace 内的相对路径');
  const root = await fs.realpath(path.resolve(workspace));
  // Reject symlinked source entries as well as links that resolve outside the
  // Workspace. The archived bytes and their source_id must describe the
  // exact lexical attachment the Agent was shown, not a mutable alias.
  const absolute = await resolveRegularArtifact(workspace, value, '导入源');
  const realRel = path.relative(root, absolute);
  if (!realRel || realRel.startsWith('..') || isAbsolutePathLike(realRel)) throw new Error('导入源解析后位于当前 Workspace 之外');
  const stat = await fs.stat(absolute);
  if (!stat.isFile()) throw new Error('导入源必须是普通文件');
  if (stat.size > 25 * 1024 * 1024) throw new Error('导入源超过 25 MB 大小限制');
  const relative = realRel.replaceAll('\\', '/');
  if (source.kind === 'session_attachment' && (!sessionId || !relative.startsWith(`.dsh-uploads/${sessionId}/`))) throw new Error('导入附件不属于当前 session');
  return { absolute, relative };
}

type RangeCoordinates = { startRow: number; startColumn: number; endRow?: number; endColumn?: number };

function integerCoordinate(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/u.test(value.trim()) ? Number(value) : NaN;
  return Number.isSafeInteger(number) && number >= 0 ? number : undefined;
}

function a1RangeCoordinates(value: unknown): RangeCoordinates | undefined {
  if (typeof value !== 'string') return undefined;
  let text = value.trim();
  const separator = text.lastIndexOf('!');
  if (separator >= 0) text = text.slice(separator + 1);
  text = text.replaceAll('$', '');
  const match = /^([A-Za-z]+)(\d+)(?::([A-Za-z]+)(\d+))?$/u.exec(text);
  if (!match) return undefined;
  const startColumn = columnIndex(match[1]) - 1;
  const startRow = Number(match[2]) - 1;
  const endColumn = columnIndex(match[3] || match[1]) - 1;
  const endRow = Number(match[4] || match[2]) - 1;
  if (!Number.isSafeInteger(startRow) || !Number.isSafeInteger(endRow) || !Number.isSafeInteger(startColumn) || !Number.isSafeInteger(endColumn) || startRow < 0 || startColumn < 0 || endRow < startRow || endColumn < startColumn) return undefined;
  return { startRow, startColumn, endRow, endColumn };
}

/** Resolve the coordinate origin carried by a Univer range response. */
function rangeCoordinates(value: unknown, depth = 0): RangeCoordinates | undefined {
  if (depth > 3) return undefined;
  const fromA1 = a1RangeCoordinates(value);
  if (fromA1) return fromA1;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  // Prefer the resolved range: requestedRange can describe a larger query than
  // the concrete range represented by this response item.
  for (const key of ['resolvedRange', 'resolved_range', 'a1Range', 'a1_range', 'range', 'requestedRange', 'requested_range', 'address', 'notation']) {
    if (!Object.prototype.hasOwnProperty.call(item, key)) continue;
    const nested = rangeCoordinates(item[key], depth + 1);
    if (nested) return nested;
  }
  const startRow = integerCoordinate(item.startRow ?? item.start_row ?? item.row ?? item.topRow ?? item.top_row);
  const startColumn = integerCoordinate(item.startColumn ?? item.start_column ?? item.column ?? item.leftColumn ?? item.left_column);
  const endRow = integerCoordinate(item.endRow ?? item.end_row ?? item.bottomRow ?? item.bottom_row);
  const endColumn = integerCoordinate(item.endColumn ?? item.end_column ?? item.rightColumn ?? item.right_column);
  const rowCount = integerCoordinate(item.rowCount ?? item.row_count ?? item.height ?? item.numRows ?? item.num_rows);
  const columnCount = integerCoordinate(item.columnCount ?? item.column_count ?? item.width ?? item.numColumns ?? item.num_columns);
  if (startRow === undefined && startColumn === undefined && endRow === undefined && endColumn === undefined) return undefined;
  const resolvedStartRow = startRow ?? 0;
  const resolvedStartColumn = startColumn ?? 0;
  const resolvedEndRow = endRow ?? (rowCount === undefined ? undefined : resolvedStartRow + rowCount - 1);
  const resolvedEndColumn = endColumn ?? (columnCount === undefined ? undefined : resolvedStartColumn + columnCount - 1);
  return { startRow: resolvedStartRow, startColumn: resolvedStartColumn, ...(resolvedEndRow === undefined ? {} : { endRow: resolvedEndRow }), ...(resolvedEndColumn === undefined ? {} : { endColumn: resolvedEndColumn }) };
}

function rangeBounds(ranges: unknown[]): { column: number; row: number } | undefined {
  const bounds: Array<{ column: number; row: number }> = [];
  for (const value of ranges) {
    const coordinates = rangeCoordinates(value);
    if (coordinates?.endRow !== undefined && coordinates.endColumn !== undefined) {
      // Structured Univer ranges use zero-based inclusive coordinates.
      bounds.push({ row: coordinates.endRow + 1, column: coordinates.endColumn + 1 });
      continue;
    }
    // A malformed or adapter-specific range should not make the whole import
    // fail, but retain any unambiguous A1 endpoint as a conservative bound.
    for (const match of String(value).matchAll(/(?:^|!)([A-Za-z]+)(\d+)(?::([A-Za-z]+)(\d+))?$/gu)) {
      bounds.push({ column: columnIndex(match[3] || match[1]), row: Number(match[4] || match[2]) });
    }
  }
  if (!bounds.length) return undefined;
  return bounds.reduce((max, item) => ({ column: Math.max(max.column, item.column), row: Math.max(max.row, item.row) }), { column: 1, row: 1 });
}

function quoteSheet(name: string): string { return `'${name.replaceAll("'", "''")}'`; }

function matrix(value: unknown): unknown[][] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.map((row) => Array.isArray(row) ? [...row] : row === undefined ? [] : [row]);
  if (typeof value !== 'object') return [[value]];
  const objectValue = value as Record<string, unknown>;
  for (const key of ['rows', 'data', 'values', 'cells', 'matrix']) {
    if (Object.prototype.hasOwnProperty.call(objectValue, key) && objectValue[key] !== value) {
      const nested = matrix(objectValue[key]);
      if (nested.length) return nested;
    }
  }
  const rows: unknown[][] = [];
  const entries = Object.entries(objectValue);
  // Some adapters return numeric row/column keys instead of arrays. Keep the
  // indexes sparse so a source cell at row 3 never becomes a row 2 cell.
  if (entries.length && entries.every(([key]) => /^\d+$/u.test(key))) {
    for (const [rowKey, rowValue] of entries) {
      const rowIndex = Number(rowKey);
      if (!Number.isSafeInteger(rowIndex) || rowIndex < 0) continue;
      if (Array.isArray(rowValue)) {
        rows[rowIndex] = [...rowValue];
        continue;
      }
      if (rowValue === null || typeof rowValue !== 'object') {
        rows[rowIndex] = [rowValue];
        continue;
      }
      const columns: unknown[] = [];
      for (const [columnKey, cell] of Object.entries(rowValue as Record<string, unknown>)) {
        const columnIndexValue = Number(columnKey);
        if (Number.isSafeInteger(columnIndexValue) && columnIndexValue >= 0) columns[columnIndexValue] = cell;
      }
      rows[rowIndex] = columns;
    }
    return rows;
  }
  for (const [address, cell] of entries) {
    const match = /([A-Za-z]+)(\d+)$/u.exec(address);
    if (!match) continue;
    const row = Number(match[2]) - 1;
    const column = columnIndex(match[1]) - 1;
    if (!rows[row]) rows[row] = [];
    rows[row][column] = cell;
  }
  if (!rows.length && entries.length) return [[value]];
  return rows;
}

function payloadScore(value: unknown): number {
  if (value === undefined || value === null) return -1;
  if (Array.isArray(value)) {
    let score = value.length;
    for (const row of value) if (Array.isArray(row)) score += row.reduce((sum, cell) => sum + (cell === undefined ? 0 : 1), 0);
    return score;
  }
  if (typeof value === 'object') return Object.keys(value as object).length;
  return 1;
}

/** Pick the most informative representation when an adapter returns several aliases. */
function choosePayload(container: unknown, keys: string[]): unknown {
  if (!container || typeof container !== 'object') return undefined;
  const source = container as Record<string, unknown>;
  let selected: unknown;
  let score = -1;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    const candidate = source[key];
    const candidateScore = payloadScore(candidate);
    if (candidateScore > score) { selected = candidate; score = candidateScore; }
  }
  return selected;
}

const DISPLAY_PAYLOAD_KEYS = [
  'displayValues',
  'display_values',
  'formattedValues',
  'formatted_values',
  'values',
] as const;

const RAW_PAYLOAD_KEYS = [
  'cellData',
  'cell_data',
  'rawValues',
  'raw_values',
  'cells',
  'values',
] as const;

const ALL_PAYLOAD_KEYS = [...new Set([...DISPLAY_PAYLOAD_KEYS, ...RAW_PAYLOAD_KEYS])];

type PayloadMatrices = Record<string, unknown[][]>;

/** Normalize every known adapter alias once so none is silently discarded. */
function collectPayloads(container: unknown): PayloadMatrices {
  const result: PayloadMatrices = Object.create(null) as PayloadMatrices;
  if (!container || typeof container !== 'object') return result;
  const source = container as Record<string, unknown>;
  for (const key of ALL_PAYLOAD_KEYS) {
    if (Object.prototype.hasOwnProperty.call(source, key)) result[key] = matrix(source[key]);
  }
  return result;
}

type MatrixOrigin = { row: number; column: number; explicit: boolean };

function originFromA1(value: unknown): MatrixOrigin | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const text = value.trim();
  const address = text.slice(text.lastIndexOf('!') + 1);
  const match = /^\$?([A-Za-z]+)\$?(\d+)/u.exec(address);
  if (!match) return undefined;
  const row = Number(match[2]) - 1;
  const column = columnIndex(match[1]) - 1;
  if (!Number.isSafeInteger(row) || !Number.isSafeInteger(column) || row < 0 || column < 0) return undefined;
  return { row, column, explicit: true };
}

/** Resolve the coordinate origin carried by a range result. */
function rangeOrigin(value: unknown, fallback?: string): MatrixOrigin {
  if (value && typeof value === 'object') {
    const item = value as Record<string, unknown>;
    // Prefer an A1 notation because it unambiguously uses one-based rows and
    // columns. Univer's structured rectangle coordinates are zero-based.
    for (const key of ['resolvedRange', 'requestedRange', 'a1Range', 'address', 'range', 'notation']) {
      const parsed = originFromA1(item[key]);
      if (parsed) return parsed;
    }
    for (const [rowKey, columnKey] of [
      ['startRow', 'startColumn'],
      ['start_row', 'start_column'],
      ['startRowIndex', 'startColumnIndex'],
    ]) {
      const row = Number(item[rowKey]);
      const column = Number(item[columnKey]);
      if (Number.isSafeInteger(row) && Number.isSafeInteger(column) && row >= 0 && column >= 0) {
        return { row, column, explicit: true };
      }
    }
  }
  return originFromA1(fallback) || { row: 0, column: 0, explicit: false };
}

function payloadValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  try { return JSON.stringify(left) === JSON.stringify(right); } catch { return false; }
}

function setSparseMatrixCell(matrixValue: unknown[][], row: number, column: number, value: unknown): void {
  if (!matrixValue[row]) matrixValue[row] = [];
  matrixValue[row][column] = value;
}

/**
 * Merge every range returned by an adapter into absolute worksheet
 * coordinates. A response may contain disjoint ranges or return aliases with
 * different payload shapes; taking only ranges[0] silently loses the rest.
 * Overlapping, disagreeing aliases are retained under a range-qualified name
 * so the evidence layer can expose the conflict instead of choosing one.
 */
function collectPayloadsFromRanges(
  ranges: unknown[],
  requestedRange?: string,
): { payloads: PayloadMatrices; warnings: string[] } {
  const payloads: PayloadMatrices = Object.create(null) as PayloadMatrices;
  const warnings: string[] = [];
  ranges.forEach((value, rangeIndex) => {
    const origin = rangeOrigin(value, requestedRange);
    if (!origin.explicit && rangeIndex > 0) {
      warnings.push(`适配器返回的第 ${rangeIndex + 1} 个范围缺少坐标，按原点保留并标记范围信息`);
    }
    const current = collectPayloads(value);
    for (const [name, values] of Object.entries(current)) {
      const target = payloads[name] || (payloads[name] = []);
      for (let row = 0; row < values.length; row++) {
        const sourceRow = values[row];
        if (!Array.isArray(sourceRow)) continue;
        for (let column = 0; column < sourceRow.length; column++) {
          const cell = sourceRow[column];
          if (cell === undefined) continue;
          const targetRow = origin.row + row;
          const targetColumn = origin.column + column;
          const existing = matrixCellPresence(target, targetRow, targetColumn);
          if (!existing.present) {
            setSparseMatrixCell(target, targetRow, targetColumn, cell);
            continue;
          }
          if (payloadValuesEqual(existing.value, cell)) continue;
          const conflictName = `${name}@range_${rangeIndex + 1}`;
          const conflict = payloads[conflictName] || (payloads[conflictName] = []);
          setSparseMatrixCell(conflict, targetRow, targetColumn, cell);
          warnings.push(`适配器范围在 ${columnName(targetColumn + 1)}${targetRow + 1} 返回了冲突的 ${name} 载荷，两个表示均已保留`);
        }
      }
    }
  });
  return { payloads, warnings: [...new Set(warnings)] };
}

function matrixCellPresence(values: unknown[][], row: number, column: number): { present: boolean; value: unknown } {
  const rowValue = values[row];
  if (!Array.isArray(rowValue) || !Object.prototype.hasOwnProperty.call(rowValue, column)) return { present: false, value: undefined };
  const value = rowValue[column];
  // `undefined` is a sparse hole rather than an explicit JSON value. Null and
  // the empty string remain present observations and must not be collapsed.
  return value === undefined ? { present: false, value: undefined } : { present: true, value };
}

function representationsAt(payloads: PayloadMatrices, row: number, column: number): EvidenceRepresentationInputs | undefined {
  const names = Object.keys(payloads);
  if (!names.length) return undefined;
  const result: EvidenceRepresentationInputs = Object.create(null) as EvidenceRepresentationInputs;
  for (const name of names) {
    const item = matrixCellPresence(payloads[name], row, column);
    result[name] = item.present ? { present: true, value: item.value } : { present: false };
  }
  return result;
}

function matrixCell(values: unknown[][], row: number, column: number): unknown {
  return Array.isArray(values[row]) ? values[row][column] : undefined;
}

function displayText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') { try { return JSON.stringify(value); } catch { return String(value); } }
  return String(value);
}

function dimensions(display: unknown[][], raw: unknown[][], end: { column: number; row: number } | undefined, overview: any, additional: unknown[][][] = []): { columns: number; rows: number } {
  let columns = end?.column || 0;
  let rows = end?.row || 0;
  for (const values of [display, raw, ...additional]) {
    rows = Math.max(rows, values.length);
    for (const row of values) if (Array.isArray(row)) columns = Math.max(columns, row.length);
  }
  // rowCount/columnCount are often grid capacity, not used dimensions. Never
  // manufacture thousands of blank observations from those hints. A declared
  // used range or an actual payload is the only basis for coordinates.
  return { columns, rows };
}

function mediaTypeForExtension(ext: string): string {
  if (ext === '.xlsx' || ext === '.xlsm') return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if (ext === '.csv') return 'text/csv';
  return 'text/tab-separated-values';
}

function converterVersion(univer: UniverService): string {
  const value = (univer as any)?.version || (univer as any)?.converterVersion || (univer as any)?.constructor?.version;
  return typeof value === 'string' && value ? value : 'unknown';
}

export interface ConvertedSource {
  doc: EvidenceDocument;
  original: string;
  archived: string;
  canonical: string;
  manifest: string;
  univerRef: string;
  worktreeId: string;
}

export async function convertSource(workspace: string, sourceInput: IngestSource, sessionId: string, importId: string, univer: UniverService): Promise<ConvertedSource> {
  const resolved = await resolveSourceFile(workspace, sourceInput, sessionId);
  const bytes = await fs.readFile(resolved.absolute);
  const name = path.basename(resolved.relative);
  const ext = path.extname(name).toLowerCase();
  if (!['.xlsx', '.xlsm', '.csv', '.tsv'].includes(ext)) throw new Error(`暂不支持该导入文件类型：${ext || '未知'}`);
  const sourceWorkbook = await readSourceWorkbookMetadata(bytes, ext);
  const sourceSha256 = createHash('sha256').update(bytes).digest('hex');
  const archived = `sources/imports/${importId}/source${ext}`;
  const canonical = `sources/imports/${importId}/canonical.json`;
  const manifest = `sources/imports/${importId}/manifest.json`;
  const univerRef = `sources/imports/${importId}/document.univer`;
  const absoluteArchived = await resolveArtifactForWrite(workspace, archived, 'Import source archive');
  const absoluteCanonical = await resolveArtifactForWrite(workspace, canonical, 'Import canonical');
  const absoluteManifest = await resolveArtifactForWrite(workspace, manifest, 'Import manifest');
  const absoluteUniver = await resolveArtifactForWrite(workspace, univerRef, 'Import Univer snapshot');
  // A generated import id should always name a fresh artifact. Refuse a
  // pre-existing target before invoking the adapter so it cannot overwrite a
  // previous evidence graph during a collision or retry.
  for (const [filePath, label] of [
    [absoluteArchived, 'Import source archive'],
    [absoluteCanonical, 'Import canonical'],
    [absoluteManifest, 'Import manifest'],
    [absoluteUniver, 'Import Univer snapshot'],
  ] as const) {
    const exists = await fs.lstat(filePath).then(() => true).catch((error: any) => {
      if (error?.code === 'ENOENT') return false;
      throw error;
    });
    if (exists) throw new Error(`不可覆盖既有导入 artifact：${label}`);
  }
  await writeImmutableFile(absoluteArchived, bytes);
  // Verify the immutable archive before any converter work starts. A later
  // read must always be able to reproduce the source digest recorded below.
  const archivedBytes = await fs.readFile(absoluteArchived);
  if (createHash('sha256').update(archivedBytes).digest('hex') !== sourceSha256) throw new Error('来源归档校验失败');
  const source: EvidenceSource = { source_id: sourceIdForSha256(sourceSha256), name, media_type: mediaTypeForExtension(ext), sha256: sourceSha256, session_id: sessionId, archived_ref: archived };
  let worktreeId = '';
  try {
    await univer.newFile({ workspace, file: absoluteUniver });
    const created = await univer.worktree({ action: 'create', workspace, file: absoluteUniver, name: `Import ${name}` });
    worktreeId = String(created?.result?.worktreeId || created?.worktreeId || '');
    if (!worktreeId) throw new Error('Univer 未返回导入 worktree');
    // Convert the immutable archive, not the caller's mutable source path.
    // This keeps the Univer snapshot and evidence digest reproducible even if
    // the original workspace file changes while conversion is in progress.
    await univer.importUnitContent({ workspace, file: absoluteUniver, sourceWorkspace: workspace, source: absoluteArchived, worktreeId, name: path.basename(name, ext) });
    const status = await univer.status({ workspace, file: absoluteUniver, worktreeId });
    const units = status?.result?.selectedWorktree?.units || [];
    const sheetUnit = units.find((unit: any) => unit.kind === 'sheet' || unit.type === 2);
    if (!sheetUnit?.unitId) throw new Error('Univer 导入结果没有 Sheet Unit');
    const workbookInspection = await univer.inspectUnitContent({ workspace, file: absoluteUniver, unitId: sheetUnit.unitId, worktreeId });
    const workbook = workbookInspection?.result;
    const worksheets = Array.isArray(workbook?.worksheets) ? workbook.worksheets : [];
    const sheets: EvidenceSheet[] = [];
    const conversionWarnings: string[] = worksheets.length ? [] : ['Univer 导入结果没有可读取的工作表'];

    for (let sheetIndex = 0; sheetIndex < worksheets.length; sheetIndex++) {
      const overview = worksheets[sheetIndex] || {};
      const sheetName = String(overview.name ?? `Sheet${sheetIndex + 1}`);
      const sheetId = sheetIdForIndex(sheetIndex);
      const sourceSheet = sourceWorkbook.get(sheetName);
      const usedRanges = Array.isArray(overview.valueUsedRanges) ? overview.valueUsedRanges : [];
      const end = rangeBounds(usedRanges);
      // Query a declared used range. When the adapter has no used-range
      // metadata, ask for its native inspection default instead of turning
      // grid-capacity hints into fabricated observations.
      const requestedRange = end ? `${quoteSheet(sheetName)}!A1:${columnName(end.column)}${end.row}` : undefined;
      let display: unknown[][] = [];
      let rawCells: unknown[][] = [];
      let payloads: PayloadMatrices = Object.create(null) as PayloadMatrices;
      try {
        const inspected = await univer.inspectUnitContent({ workspace, file: absoluteUniver, unitId: sheetUnit.unitId, worktreeId, ...(requestedRange ? { range: requestedRange } : {}) });
        const ranges = Array.isArray(inspected?.result?.ranges)
          ? inspected.result.ranges
          : inspected?.result && typeof inspected.result === 'object' ? [inspected.result] : [];
        const merged = collectPayloadsFromRanges(ranges, requestedRange);
        payloads = merged.payloads;
        conversionWarnings.push(...merged.warnings.map((warning) => `${sheetName}: ${warning}`));
        // Keep the established primary views for downstream compatibility;
        // every alias is also retained in `representations` below.
        display = matrix(choosePayload(payloads, [...DISPLAY_PAYLOAD_KEYS]));
        rawCells = matrix(choosePayload(payloads, [...RAW_PAYLOAD_KEYS]));
      } catch (error: any) {
        conversionWarnings.push(`${sheetName}: 无法读取${requestedRange ? `范围 ${requestedRange}` : '单元格载荷'}: ${String(error?.message || error)}`);
      }
      const size = dimensions(display, rawCells, end, overview, Object.values(payloads));
      if (!display.length && !rawCells.length && size.rows > 0 && size.columns > 0) conversionWarnings.push(`${sheetName}: 转换器未返回单元格载荷，已保留不可读观察`);
      if (!display.length && !rawCells.length && size.rows === 0 && size.columns === 0) conversionWarnings.push(`${sheetName}: 未提供 used range 或单元格载荷，未臆造空观察`);
      const columns: EvidenceColumn[] = [];
      for (let columnIndexValue = 0; columnIndexValue < size.columns; columnIndexValue++) {
        const columnId = columnIdForIndex(columnIndexValue);
        const headerRawCell = matrixCell(rawCells, 0, columnIndexValue);
        const headerDisplay = matrixCell(display, 0, columnIndexValue);
        const headerAddress = cellAddress(1, columnIndexValue + 1);
        const sourceHeader = sourceSheet?.cells.get(headerAddress);
        const header = makeEvidenceCell({ source_id: source.source_id, sheet_id: sheetId, row_number: 1, column_id: columnId, address: headerAddress, raw_cell: sourceAwareCell(headerRawCell, sourceHeader), display: headerDisplay, representations: { ...(representationsAt(payloads, 0, columnIndexValue) || {}), ...(sourceHeader ? { sourceWorkbook: { present: sourceHeader.present, value: sourceHeader.value } } : {}) }, ...(headerRawCell === undefined && headerDisplay === undefined && !sourceHeader ? { unreadable: true, warning: `未返回 ${headerAddress} 的显式载荷` } : {}) });
        const label = displayText(headerDisplay !== undefined && headerDisplay !== null ? headerDisplay : header.raw) || `列 ${columnIndexValue + 1}`;
        columns.push({ column_id: columnId, index: columnIndexValue, label, address: columnName(columnIndexValue + 1), header: { ...header }, ...(overview.hidden === true || overview.visibility === 'hidden' ? { hidden: true } : {}) });
      }
      const rows: EvidenceRow[] = [];
      // Row 1 is represented by the column header observations. Keep every
      // subsequent source row, including rows whose cells are all empty.
      for (let rowIndex = 1; rowIndex < size.rows; rowIndex++) {
        const rowNumber = rowIndex + 1;
        const cells: EvidenceCell[] = [];
        const rowWarnings: string[] = [];
        for (const column of columns) {
          const rawCell = matrixCell(rawCells, rowIndex, column.index);
          const shown = matrixCell(display, rowIndex, column.index);
          const address = `${column.address}${rowNumber}`;
          const sourceCell = sourceSheet?.cells.get(address);
          const cell = makeEvidenceCell({ source_id: source.source_id, sheet_id: sheetId, row_number: rowNumber, column_id: column.column_id, address, raw_cell: sourceAwareCell(rawCell, sourceCell), display: shown, representations: { ...(representationsAt(payloads, rowIndex, column.index) || {}), ...(sourceCell ? { sourceWorkbook: { present: sourceCell.present, value: sourceCell.value } } : {}) }, ...(rawCell === undefined && shown === undefined && !sourceCell ? { unreadable: true, warning: `未返回 ${address} 的显式载荷` } : {}) });
          cells.push(cell);
          if (cell.observation_status === 'unreadable') rowWarnings.push(`未返回 ${cell.address} 的显式载荷，按不可读观察保留`);
        }
        const row: EvidenceRow = { row_id: rowIdFor(sheetId, rowNumber), row_number: rowNumber, cells, row_hash: '', warnings: [...new Set(rowWarnings)] };
        row.row_hash = rowHash(row);
        rows.push(row);
      }
      const sheetWarnings = [
        ...(Array.isArray(overview.warnings) ? overview.warnings.filter((item: unknown): item is string => typeof item === 'string') : []),
        ...(size.rows === 0 || size.columns === 0 ? [`${sheetName}: 工作表没有可读取的单元格`] : []),
      ];
      const hidden = sourceSheet?.hidden === true || overview.hidden === true || overview.visibility === 'hidden';
      sheets.push({ sheet_id: sheetId, name: sheetName, visibility: hidden ? 'hidden' : overview.visibility === 'unknown' ? 'unknown' : 'visible', columns, rows, ...(hidden ? { source_visibility: 'hidden' } : {}), ...(sheetWarnings.length ? { warnings: [...new Set(sheetWarnings)] } : {}) });
    }

    const doc: EvidenceDocument = { schema: EVIDENCE_SCHEMA, source, sheets, accounting: evidenceAccountingFor(sheets), warnings: [...new Set(conversionWarnings)], provenance: { converter: 'univer', converter_version: converterVersion(univer), converted_at: new Date().toISOString() }, evidence_digest: '' };
    doc.evidence_digest = computeEvidenceDigest(doc);
    validateEvidenceDocument(doc, { source_bytes: bytes });
    const manifestValue: ImportManifest = { schema: IMPORT_MANIFEST_SCHEMA, import_job_id: importId, source, source_ref: resolved.relative, archived_source_ref: archived, canonical_ref: canonical, manifest_ref: manifest, univer_ref: univerRef, evidence_digest: doc.evidence_digest, accounting: doc.accounting, warnings: doc.warnings, provenance: doc.provenance };
    // Publish the immutable evidence before its manifest. A manifest therefore
    // never points at a canonical file that has not been durably written.
    await writeJsonImmutable(absoluteCanonical, doc);
    await writeJsonImmutable(absoluteManifest, manifestValue);
    return { doc, original: resolved.relative, archived, canonical, manifest, univerRef, worktreeId };
  } finally {
    if (worktreeId) await univer.worktree({ action: 'discard', workspace, file: absoluteUniver, worktreeId }).catch(() => undefined);
  }
}

function summaryForSheet(sheet: EvidenceSheet): Record<string, unknown> {
  const headerCount = sheet.columns.length;
  const dataCellCount = sheet.rows.reduce((sum, row) => sum + row.cells.length, 0);
  const observations = headerCount + dataCellCount;
  const unreadableCellCount = sheet.columns.reduce((sum, column) => sum + (column.header.observation_status === 'unreadable' || column.header.empty_reason === 'unreadable' ? 1 : 0), 0)
    + sheet.rows.reduce((sum, row) => sum + row.cells.filter((cell) => cell.observation_status === 'unreadable' || cell.empty_reason === 'unreadable').length, 0);
  return { name: sheet.name, sheet_id: sheet.sheet_id, columns: sheet.columns, rows: sheet.rows.length, observed_rows: sheet.rows.length, header_count: headerCount, data_cell_count: dataCellCount, observations, total_observations: observations, unreadable_cell_count: unreadableCellCount };
}

export function registerCanonicalImportTools(ctx: Record<string, any>, harness: any, univer?: UniverService): void {
  harness.registerTool(ctx, harness.defineTool({
    name: 'dealpilot_ingest',
    description: '通过 Univer 将当前 session 附件或 Workspace 文件无损转换为 dealpilot.evidence/v2 观察。只归档和读取来源，不创建业务实体。',
    parameters: { type: 'object', properties: { source: { type: 'object', description: 'session_attachment 使用 ref，workspace_file 使用 path。', properties: { kind: { type: 'string', enum: ['session_attachment', 'workspace_file'] }, ref: { type: 'string' }, path: { type: 'string' } }, required: ['kind'] } }, required: ['source'] },
    async execute(args: any, exec?: any) {
      if (!univer) throw new Error('Univer 转换服务不可用');
      const workspace = resolveWorkspace(ctx.config);
      const sessionId = String(exec?.agent?.id || '');
      const input = args.source as IngestSource;
      if (!input || !['session_attachment', 'workspace_file'].includes(input.kind) || (input.kind === 'session_attachment' ? !input.ref : !input.path)) throw new Error('导入源参数无效');
      const id = `imp_${randomUUID()}`;
      const now = new Date().toISOString();
      try {
        const converted = await convertSource(workspace, input, sessionId, id, univer);
        const { doc, original, archived, canonical, manifest, univerRef, worktreeId } = converted;
        const job: ImportJob = { schema: IMPORT_JOB_SCHEMA, import_job_id: id, session_id: sessionId, source_kind: input.kind, source_ref: original, archived_source_ref: archived, canonical_ref: canonical, manifest_ref: manifest, univer_ref: univerRef, univer_worktree_id: worktreeId, source: doc.source, source_id: doc.source.source_id, evidence_digest: doc.evidence_digest, accounting: doc.accounting, status: 'converted', created_at: now, updated_at: new Date().toISOString() };
        await writeJob(workspace, job);
        // Re-open the published record to verify every cross-artifact digest and
        // reference before reporting success to the Agent.
        const persisted = await readImportJob(workspace, id);
        return JSON.stringify({ import_job_id: id, status: persisted.status, schema: doc.schema, source: doc.source, evidence_digest: doc.evidence_digest, canonical_ref: canonical, manifest_ref: manifest, accounting: doc.accounting, sheets: doc.sheets.map(summaryForSheet), warnings: doc.warnings });
      } catch (error: any) {
        const failedSourceRef = input.kind === 'session_attachment' ? String(input.ref) : (path.isAbsolute(String(input.path)) ? '<external path rejected>' : String(input.path));
        const ext = path.extname(failedSourceRef).toLowerCase();
        const failedArchived = ['.xlsx', '.xlsm', '.csv', '.tsv'].includes(ext) ? `sources/imports/${id}/source${ext}` : '';
        const archivedPath = failedArchived ? await existingRegularArtifact(workspace, failedArchived, 'Import source archive') : undefined;
        const archivedExists = Boolean(archivedPath);
        const failedCanonical = `sources/imports/${id}/canonical.json`;
        const failedManifest = `sources/imports/${id}/manifest.json`;
        const canonicalPath = await existingRegularArtifact(workspace, failedCanonical, 'Import canonical');
        const manifestPath = await existingRegularArtifact(workspace, failedManifest, 'Import manifest');
        const canonicalExists = Boolean(canonicalPath);
        const manifestExists = Boolean(manifestPath);
        let failedSource: EvidenceSource = { source_id: 'src_unresolved', name: 'unresolved', media_type: 'application/octet-stream', sha256: '0'.repeat(64), session_id: sessionId, archived_ref: archivedExists ? failedArchived : '' };
        if (archivedExists) {
          const archivedBytes = await fs.readFile(archivedPath!);
          const digest = createHash('sha256').update(archivedBytes).digest('hex');
          failedSource = { source_id: sourceIdForSha256(digest), name: path.basename(failedSourceRef), media_type: mediaTypeForExtension(ext), sha256: digest, session_id: sessionId, archived_ref: failedArchived };
        }
        const failedJob: ImportJob = { schema: IMPORT_JOB_SCHEMA, import_job_id: id, session_id: sessionId, source_kind: input.kind, source_ref: failedSourceRef, archived_source_ref: archivedExists ? failedArchived : '', canonical_ref: canonicalExists ? failedCanonical : '', manifest_ref: manifestExists ? failedManifest : '', univer_ref: '', univer_worktree_id: '', source: failedSource, source_id: failedSource.source_id, evidence_digest: '', accounting: emptyAccounting(), status: 'failed', created_at: now, updated_at: new Date().toISOString(), error: String(error?.message || error) };
        try { await writeJob(workspace, failedJob); } catch { /* Preserve the original conversion error and any existing job artifact. */ }
        throw error;
      }
    },
  }));
}
