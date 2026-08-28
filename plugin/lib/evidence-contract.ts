import { Buffer } from 'node:buffer';
import {
  ContractValidationError,
  canonicalizeJson,
  failContract,
  hashJson,
  isRecord,
  sha256Hex,
  stableStringify,
} from './contract-utils.js';

/** The lossless source observation contract. */
export const EVIDENCE_SCHEMA = 'dealpilot.evidence/v2' as const;
export const EVIDENCE_CURSOR_SCHEMA = 'dealpilot.evidence-cursor/v1' as const;

export type EvidenceValueType =
  | 'empty'
  | 'string'
  | 'number'
  | 'boolean'
  | 'date'
  | 'error'
  | 'formula'
  | 'object'
  | 'unknown';

export type EvidenceVisibility = 'visible' | 'hidden' | 'unknown';
export type EvidenceObservationStatus = 'preserved' | 'partial' | 'unreadable';

/**
 * One representation returned by a workbook adapter for a coordinate.
 *
 * `present` is deliberately separate from `value`: an explicit blank/null is
 * evidence, while a missing sparse coordinate means that the adapter did not
 * return a value.  The hash binds the adapter alias, presence bit, and the
 * JSON-safe value so a later consumer can detect tampering or accidental
 * reinterpretation.
 */
export interface EvidenceRepresentation {
  present: boolean;
  value?: unknown;
  hash: string;
}

export type EvidenceRepresentations = Record<string, EvidenceRepresentation>;

/** Input form accepted while constructing an observation. */
export interface EvidenceRepresentationInput {
  present: boolean;
  value?: unknown;
}

export type EvidenceRepresentationInputs = Record<string, EvidenceRepresentationInput>;

export interface EvidenceSource {
  source_id: string;
  name: string;
  media_type: string;
  sha256: string;
  session_id: string;
  archived_ref: string;
}

export interface EvidenceHeader {
  /** Stable observation id for the source header cell (row 1). */
  observation_id: string;
  column_id: string;
  address: string;
  raw: unknown;
  display: unknown;
  raw_present: boolean;
  display_present: boolean;
  observation_status: EvidenceObservationStatus;
  value_type: EvidenceValueType | string;
  formula: string | null;
  empty_reason: string | null;
  cell_hash: string;
  /** All adapter payload aliases observed for this coordinate, when any. */
  representations?: EvidenceRepresentations;
  cell_data?: unknown;
  comment?: unknown;
  hyperlink?: unknown;
  merged_range?: unknown;
  style?: unknown;
  [key: string]: unknown;
}

export interface EvidenceColumn {
  column_id: string;
  index: number;
  label: string;
  address: string;
  /** Every represented column carries a first-class header observation. */
  header: EvidenceHeader;
  hidden?: boolean;
  [key: string]: unknown;
}

export interface EvidenceCell {
  observation_id: string;
  column_id: string;
  address: string;
  raw: unknown;
  display: unknown;
  /** Whether the converter supplied an explicit raw/display payload. */
  raw_present: boolean;
  display_present: boolean;
  observation_status: EvidenceObservationStatus;
  value_type: EvidenceValueType | string;
  formula: string | null;
  empty_reason: string | null;
  cell_hash: string;
  /** All adapter payload aliases observed for this coordinate, when any. */
  representations?: EvidenceRepresentations;
  /** Original converter cell object, when the converter returned one. */
  cell_data?: unknown;
  comment?: unknown;
  hyperlink?: unknown;
  merged_range?: unknown;
  style?: unknown;
  [key: string]: unknown;
}

export interface EvidenceRow {
  row_id: string;
  row_number: number;
  cells: EvidenceCell[];
  row_hash: string;
  warnings: string[];
  [key: string]: unknown;
}

export interface EvidenceSheet {
  sheet_id: string;
  name: string;
  visibility: EvidenceVisibility;
  columns: EvidenceColumn[];
  rows: EvidenceRow[];
  warnings?: string[];
  [key: string]: unknown;
}

export interface EvidenceAccounting {
  sheet_count: number;
  row_count: number;
  cell_count: number;
  preserved_cell_count: number;
  /** Total first-class observations (headers + row-level cells). */
  observation_count: number;
  column_count: number;
  unreadable_cell_count: number;
  /** Number of structural header observations represented in columns[].header. */
  header_count: number;
  /** Number of row-level observations; cell_count = header_count + data_cell_count. */
  data_cell_count: number;
}

export interface EvidenceProvenance {
  converter: string;
  converter_version: string;
  converted_at: string;
  [key: string]: unknown;
}

export interface EvidenceDocument {
  schema: typeof EVIDENCE_SCHEMA;
  source: EvidenceSource;
  sheets: EvidenceSheet[];
  accounting: EvidenceAccounting;
  warnings: string[];
  provenance: EvidenceProvenance;
  evidence_digest: string;
  [key: string]: unknown;
}

export interface EvidenceCursor {
  schema: typeof EVIDENCE_CURSOR_SCHEMA;
  evidence_digest: string;
  sheet?: string;
  range?: string;
  offset: number;
}

export interface EvidencePageOptions {
  sheet?: string;
  range?: string;
  cursor?: string | null;
  max_items?: number;
  include_raw?: boolean;
}

export interface EvidenceObservation extends EvidenceCell {
  sheet_id: string;
  sheet_name: string;
  row_id: string;
  row_number: number;
  column_index: number;
  column_label: string;
  observation_kind: 'header' | 'cell';
}

export interface EvidencePage {
  schema: 'dealpilot.evidence-slice/v2';
  evidence_digest: string;
  observations: EvidenceObservation[];
  returned_observations: number;
  total_observations: number;
  next_cursor: string | null;
  cursor: string | null;
  citation: Array<{ observation_id: string; location: string; ref?: string }>;
}

export interface A1Range {
  sheet?: string;
  startRow: number;
  endRow: number;
  startColumn: number;
  endColumn: number;
}

function contractFailure(code: string, path: string, message: string, details?: Record<string, unknown>): never {
  return failContract(code, path, message, details);
}

function jsonSafe(value: unknown, active = new WeakSet<object>()): any {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return Object.is(value, -0) ? 0 : value;
    return { $type: 'number', value: String(value) };
  }
  if (value === undefined) return null;
  if (typeof value === 'bigint') return { $type: 'bigint', value: String(value) };
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return { $type: 'bytes', base64: Buffer.from(value).toString('base64') };
  if (typeof value !== 'object') return String(value);
  if (active.has(value as object)) return { $type: 'circular' };
  active.add(value as object);
  try {
    if (Array.isArray(value)) return value.map((item) => jsonSafe(item, active));
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value as object)) result[key] = jsonSafe((value as Record<string, unknown>)[key], active);
    return result;
  } finally {
    active.delete(value as object);
  }
}

/** Convert a value returned by a workbook adapter into a JSON-preserving value. */
export function toEvidenceValue(value: unknown): unknown {
  return jsonSafe(value);
}

export function columnName(indexOrNumber: number): string {
  let value = Math.max(1, Math.floor(indexOrNumber));
  let result = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

export function columnIndex(address: string): number {
  let value = 0;
  for (const char of String(address).replace(/[^A-Za-z]/gu, '').toUpperCase()) value = value * 26 + char.charCodeAt(0) - 64;
  return value;
}

export function cellAddress(rowNumber: number, columnNumber: number): string {
  return `${columnName(columnNumber)}${rowNumber}`;
}

export function sourceIdForSha256(sha256: string): string {
  return `src_${String(sha256).toLowerCase().replace(/^sha256:/u, '').slice(0, 32)}`;
}

export function sheetIdForIndex(index: number): string {
  return `sheet_${Math.max(0, Math.floor(index)) + 1}`;
}

export function columnIdForIndex(index: number): string {
  return `c_${Math.max(0, Math.floor(index)) + 1}`;
}

export function rowIdFor(sheetId: string, rowNumber: number): string {
  return `${sheetId}:r_${Math.max(1, Math.floor(rowNumber))}`;
}

export function observationIdFor(sourceId: string, sheetId: string, rowNumber: number, columnId: string): string {
  return `obs_${sha256Hex(`${sourceId}|${sheetId}|${Math.floor(rowNumber)}|${columnId}`).slice(0, 32)}`;
}

function hasOwn(value: unknown, key: string): boolean {
  return isRecord(value) && Object.prototype.hasOwnProperty.call(value, key);
}

function pick(value: unknown, keys: string[]): unknown {
  if (!isRecord(value)) return undefined;
  for (const key of keys) if (hasOwn(value, key)) return value[key];
  return undefined;
}

function pickFormula(value: unknown): string | null {
  const formula = pick(value, ['formula', 'f', 'formulaText', 'formula_value']);
  if (formula === undefined || formula === null || formula === '') return null;
  return String(formula);
}

function explicitRaw(value: unknown): { present: boolean; value: unknown } {
  if (isRecord(value)) {
    for (const key of ['raw', 'v', 'value', 'userEnteredValue', 'user_entered_value']) {
      if (hasOwn(value, key)) return { present: true, value: value[key] };
    }
    // Adapter metadata (format, comment, merge information) is not a cell
    // value. Keep it in cell_data below, but do not mistake it for a readable
    // raw value. Unknown non-metadata objects remain raw so an adapter-specific
    // value is never silently discarded.
    const metadataKeys = new Set(['style', 's', 'format', 'comment', 'note', 'comments', 'hyperlink', 'link', 'url', 'merged_range', 'mergedRange', 'merge', 'value_type', 'valueType', 'type', 't', 'formula', 'f', 'formulaText', 'formula_value']);
    if (Object.keys(value).every((key) => metadataKeys.has(key))) return { present: false, value: undefined };
    return { present: true, value };
  }
  return { present: value !== undefined, value };
}

function explicitDisplay(value: unknown, display: unknown): { present: boolean; value: unknown } {
  if (display !== undefined) return { present: true, value: display };
  if (isRecord(value)) {
    for (const key of ['display', 'displayValue', 'w', 'formattedValue', 'formatted_value']) {
      if (hasOwn(value, key)) return { present: true, value: value[key] };
    }
    const metadataKeys = new Set(['style', 's', 'format', 'comment', 'note', 'comments', 'hyperlink', 'link', 'url', 'merged_range', 'mergedRange', 'merge', 'value_type', 'valueType', 'type', 't', 'formula', 'f', 'formulaText', 'formula_value']);
    if (Object.keys(value).every((key) => metadataKeys.has(key))) return { present: false, value: undefined };
  }
  return { present: value !== undefined, value: value === undefined ? null : value };
}

function inferValueType(raw: unknown, display: unknown, formula: string | null, sourceCell?: unknown): EvidenceValueType {
  const explicit = pick(sourceCell, ['value_type', 'valueType', 'type', 't']);
  if (typeof explicit === 'string' && explicit.trim()) {
    const normalized = explicit.toLowerCase();
    if (normalized.includes('formula')) return 'formula';
    if (normalized.includes('number') || normalized === 'n') return 'number';
    if (normalized.includes('bool')) return 'boolean';
    if (normalized.includes('date') || normalized.includes('time')) return 'date';
    if (normalized.includes('error')) return 'error';
    if (normalized.includes('string') || normalized === 's') return 'string';
    if (normalized.includes('empty') || normalized === 'blank') return 'empty';
  }
  if (formula) return 'formula';
  const value = raw !== null && raw !== undefined ? raw : display;
  if (value === null || value === undefined || value === '') return 'empty';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (value instanceof Date) return 'date';
  if (typeof value === 'string') return 'string';
  if (isRecord(value) && (typeof value.error === 'string' || typeof value.e === 'string')) return 'error';
  if (typeof value === 'object') return 'object';
  return 'unknown';
}

function isEmptyValue(value: unknown): boolean {
  return value === null || value === undefined || value === '';
}

export interface MakeEvidenceCellOptions {
  source_id: string;
  sheet_id: string;
  row_number: number;
  column_id: string;
  address: string;
  raw_cell?: unknown;
  display?: unknown;
  /** Additional adapter aliases for the same coordinate. */
  representations?: EvidenceRepresentationInputs;
  warning?: string;
  /** Mark a coordinate unreadable when the adapter returned no payload. */
  unreadable?: boolean;
}

function representationHash(name: string, present: boolean, value: unknown): string {
  return hashJson({ name, present, value: present ? value : null });
}

function normalizeRepresentations(input: EvidenceRepresentationInputs | undefined): EvidenceRepresentations | undefined {
  if (input === undefined) return undefined;
  if (!isRecord(input)) contractFailure('EXPECTED_OBJECT', '$.representations', 'representations must be an object');
  const names = Object.keys(input).sort();
  if (!names.length) return undefined;
  const result: Record<string, EvidenceRepresentation> = Object.create(null) as Record<string, EvidenceRepresentation>;
  for (const name of names) {
    if (!name.trim()) contractFailure('EXPECTED_STRING', '$.representations', 'representation name must not be empty');
    const item = input[name];
    if (!isRecord(item)) contractFailure('EXPECTED_OBJECT', `$.representations.${name}`, 'representation must be an object');
    if (typeof item.present !== 'boolean') contractFailure('EXPECTED_BOOLEAN', `$.representations.${name}.present`, 'representation present must be boolean');
    const present = item.present;
    const hasValue = Object.prototype.hasOwnProperty.call(item, 'value');
    if (present && !hasValue) contractFailure('MISSING_VALUE', `$.representations.${name}.value`, 'present representation must carry a value');
    if (!present && hasValue && item.value !== null) contractFailure('UNSUPPORTED_VALUE', `$.representations.${name}.value`, 'absent representation may only carry null');
    const value = present ? toEvidenceValue(item.value) : undefined;
    result[name] = {
      present,
      ...(present ? { value } : {}),
      hash: representationHash(name, present, value),
    };
  }
  return result;
}

function cellHashInput(cell: Pick<EvidenceCell, 'observation_id' | 'column_id' | 'address' | 'raw' | 'display' | 'value_type' | 'formula' | 'empty_reason'> & Partial<Pick<EvidenceCell, 'raw_present' | 'display_present' | 'observation_status' | 'representations' | 'cell_data' | 'comment' | 'hyperlink' | 'merged_range' | 'style'>>): Record<string, unknown> {
  return {
    observation_id: cell.observation_id,
    column_id: cell.column_id,
    address: cell.address,
    raw: cell.raw,
    display: cell.display,
    ...(cell.raw_present !== undefined ? { raw_present: cell.raw_present } : {}),
    ...(cell.display_present !== undefined ? { display_present: cell.display_present } : {}),
    ...(cell.observation_status !== undefined ? { observation_status: cell.observation_status } : {}),
    value_type: cell.value_type,
    formula: cell.formula ?? null,
    empty_reason: cell.empty_reason ?? null,
    ...(cell.representations !== undefined ? { representations: cell.representations } : {}),
    cell_data: cell.cell_data ?? null,
    comment: cell.comment ?? null,
    hyperlink: cell.hyperlink ?? null,
    merged_range: cell.merged_range ?? null,
    style: cell.style ?? null,
  };
}

/** Build one stable observation while retaining the adapter's original cell object. */
export function makeEvidenceCell(options: MakeEvidenceCellOptions): EvidenceCell {
  const sourceCell = options.raw_cell;
  const raw = explicitRaw(sourceCell);
  const shown = explicitDisplay(sourceCell, options.display);
  const rawValue = toEvidenceValue(raw.value);
  const displayValue = toEvidenceValue(shown.value);
  const representations = normalizeRepresentations(options.representations);
  const alternate = representations
    ? Object.values(representations).find((item) => item.present)
    : undefined;
  const formula = pickFormula(sourceCell);
  const valueType = inferValueType(raw.present ? raw.value : alternate?.value, shown.present ? shown.value : alternate?.value, formula, sourceCell);
  let emptyReason: string | null = null;
  // A coordinate is readable when any retained adapter representation carries
  // a value, even if the selected primary raw/display matrix has a sparse hole.
  const hasAlternateValue = alternate !== undefined;
  const unreadable = !hasAlternateValue && (options.unreadable === true || (!raw.present && !shown.present && sourceCell === undefined && options.display === undefined));
  if (unreadable) emptyReason = 'unreadable';
  else if (isEmptyValue(raw.value) && isEmptyValue(shown.value)) {
    if (formula) emptyReason = 'formula_empty';
    else if (raw.present || shown.present) emptyReason = 'blank';
    else if (hasAlternateValue) emptyReason = 'representation_only';
    else if (isRecord(sourceCell) && Object.keys(sourceCell).length > 0) emptyReason = 'format_only';
    else emptyReason = 'blank';
  }
  const observationStatus: EvidenceObservationStatus = unreadable ? 'unreadable' : raw.present && shown.present ? 'preserved' : 'partial';
  const base: EvidenceCell = {
    observation_id: observationIdFor(options.source_id, options.sheet_id, options.row_number, options.column_id),
    column_id: options.column_id,
    address: options.address,
    raw: rawValue,
    display: displayValue,
    raw_present: raw.present,
    display_present: shown.present,
    observation_status: observationStatus,
    value_type: valueType,
    formula,
    empty_reason: emptyReason,
    cell_hash: '',
  };
  if (representations) base.representations = representations;
  if (sourceCell !== undefined) base.cell_data = toEvidenceValue(sourceCell);
  if (options.warning) base.warning = options.warning;
  for (const [target, keys] of [
    ['comment', ['comment', 'note', 'comments']],
    ['hyperlink', ['hyperlink', 'link', 'url']],
    ['merged_range', ['merged_range', 'mergedRange', 'merge']],
    ['style', ['style', 's', 'format']],
  ] as Array<[string, string[]]>) {
    const picked = pick(sourceCell, keys);
    if (picked !== undefined) base[target] = toEvidenceValue(picked);
  }
  base.cell_hash = hashJson(cellHashInput(base));
  return base;
}

export function rowHash(row: Pick<EvidenceRow, 'row_id' | 'row_number' | 'cells'>): string {
  return hashJson({ row_id: row.row_id, row_number: row.row_number, cells: row.cells.map((cell) => cell.cell_hash) });
}

function withoutDigest(document: EvidenceDocument): Record<string, unknown> {
  const { evidence_digest: _digest, provenance, ...rest } = document;
  const stableProvenance = { ...(provenance || {}) } as Record<string, unknown>;
  // Conversion timestamps describe an execution, not the evidence itself.
  delete stableProvenance.converted_at;
  delete stableProvenance.convertedAt;
  return { ...rest, provenance: stableProvenance };
}

export function computeEvidenceDigest(document: Omit<EvidenceDocument, 'evidence_digest'> | EvidenceDocument): string {
  return hashJson(withoutDigest(document as EvidenceDocument));
}

export const evidenceDigest = computeEvidenceDigest;
export const hashEvidenceDocument = computeEvidenceDigest;
export { hashJson, sha256Hex, stableStringify, canonicalizeJson, ContractValidationError };
export const hashCell = hashJson;
export const hashObservation = hashJson;

function assertString(value: unknown, path: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.trim() === '')) contractFailure('EXPECTED_STRING', path, 'expected a non-empty string');
  return value;
}

function assertInteger(value: unknown, path: string, min = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < min) contractFailure('EXPECTED_INTEGER', path, `expected an integer >= ${min}`);
  return value as number;
}

function assertDigest(value: unknown, path: string): string {
  const digest = assertString(value, path).replace(/^sha256:/u, '').toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(digest)) contractFailure('INVALID_DIGEST', path, 'expected a SHA-256 digest');
  return digest;
}

function assertUnique(seen: Set<string>, value: string, path: string): void {
  if (seen.has(value)) contractFailure('DUPLICATE_ID', path, `duplicate id: ${value}`);
  seen.add(value);
}

function validateRepresentations(value: unknown, path: string): void {
  if (value === undefined) return;
  if (!isRecord(value)) contractFailure('EXPECTED_OBJECT', path, 'representations must be an object');
  const names = Object.keys(value);
  if (!names.length) contractFailure('TOO_FEW_ITEMS', path, 'representations must contain at least one adapter alias');
  for (const name of names) {
    if (!name.trim()) contractFailure('EXPECTED_STRING', `${path}.${name}`, 'representation name must not be empty');
    const item = value[name];
    if (!isRecord(item)) contractFailure('EXPECTED_OBJECT', `${path}.${name}`, 'representation must be an object');
    if (typeof item.present !== 'boolean') contractFailure('EXPECTED_BOOLEAN', `${path}.${name}.present`, 'representation present must be boolean');
    const hasValue = Object.prototype.hasOwnProperty.call(item, 'value');
    if (item.present && !hasValue) contractFailure('MISSING_VALUE', `${path}.${name}.value`, 'present representation must carry a value');
    if (!item.present && hasValue && item.value !== null) contractFailure('UNSUPPORTED_VALUE', `${path}.${name}.value`, 'absent representation may only carry null');
    if (item.present) {
      try {
        canonicalizeJson(item.value);
      } catch (error: any) {
        contractFailure('INVALID_JSON_VALUE', `${path}.${name}.value`, String(error?.message || error));
      }
    }
    const hash = assertDigest(item.hash, `${path}.${name}.hash`);
    const expected = representationHash(name, item.present, item.present ? item.value : null);
    if (hash !== expected) contractFailure('HASH_MISMATCH', `${path}.${name}.hash`, 'representation hash does not match alias, presence, and value');
  }
}

function validateCell(cell: unknown, path: string, sourceId: string, sheetId: string, columnById: Map<string, EvidenceColumn>, rowNumber: number, observationIds: Set<string>, verifyHashes: boolean): EvidenceCell {
  if (!isRecord(cell)) contractFailure('EXPECTED_OBJECT', path, 'cell must be an object');
  const observationId = assertString(cell.observation_id, `${path}.observation_id`);
  assertUnique(observationIds, observationId, `${path}.observation_id`);
  const columnId = assertString(cell.column_id, `${path}.column_id`);
  const column = columnById.get(columnId);
  if (!column) contractFailure('UNKNOWN_REFERENCE', `${path}.column_id`, `unknown column: ${columnId}`);
  const expectedObservationId = observationIdFor(sourceId, sheetId, rowNumber, columnId);
  if (observationId !== expectedObservationId) contractFailure('INVALID_REFERENCE', `${path}.observation_id`, `expected ${expectedObservationId}`);
  const address = assertString(cell.address, `${path}.address`);
  const expected = `${column.address}${rowNumber}`;
  if (address.toUpperCase() !== expected.toUpperCase()) contractFailure('INVALID_COORDINATE', `${path}.address`, `expected ${expected}`);
  if (!Object.prototype.hasOwnProperty.call(cell, 'raw') || !Object.prototype.hasOwnProperty.call(cell, 'display')) contractFailure('MISSING_VALUE', path, 'cell must preserve raw and display values');
  if (cell.raw_present !== undefined && typeof cell.raw_present !== 'boolean') contractFailure('EXPECTED_BOOLEAN', `${path}.raw_present`, 'raw_present must be boolean');
  if (cell.display_present !== undefined && typeof cell.display_present !== 'boolean') contractFailure('EXPECTED_BOOLEAN', `${path}.display_present`, 'display_present must be boolean');
  if (cell.observation_status !== undefined && !['preserved', 'partial', 'unreadable'].includes(String(cell.observation_status))) contractFailure('UNSUPPORTED_VALUE', `${path}.observation_status`, 'invalid observation status');
  assertString(cell.value_type, `${path}.value_type`);
  if (cell.formula !== null && cell.formula !== undefined && typeof cell.formula !== 'string') contractFailure('EXPECTED_STRING', `${path}.formula`, 'formula must be string or null');
  if (cell.empty_reason !== null && cell.empty_reason !== undefined && typeof cell.empty_reason !== 'string') contractFailure('EXPECTED_STRING', `${path}.empty_reason`, 'empty_reason must be string or null');
  validateRepresentations(cell.representations, `${path}.representations`);
  const cellHash = assertDigest(cell.cell_hash, `${path}.cell_hash`);
  if (verifyHashes) {
    const expectedHash = hashJson(cellHashInput(cell as unknown as EvidenceCell));
    if (cellHash !== expectedHash) contractFailure('HASH_MISMATCH', `${path}.cell_hash`, 'cell hash does not match preserved values');
  }
  return cell as unknown as EvidenceCell;
}

function validateHeader(header: unknown, path: string, sourceId: string, sheetId: string, column: EvidenceColumn, observationIds: Set<string>, verifyHashes: boolean): void {
  if (!isRecord(header)) contractFailure('EXPECTED_OBJECT', path, 'header must be an object');
  const observationId = assertString(header.observation_id, `${path}.observation_id`);
  assertUnique(observationIds, observationId, `${path}.observation_id`);
  const expectedObservationId = observationIdFor(sourceId, sheetId, 1, column.column_id);
  if (observationId !== expectedObservationId) contractFailure('INVALID_REFERENCE', `${path}.observation_id`, `expected ${expectedObservationId}`);
  const headerColumnId = assertString(header.column_id, `${path}.column_id`);
  if (headerColumnId !== column.column_id) contractFailure('INVALID_REFERENCE', `${path}.column_id`, `expected ${column.column_id}`);
  const headerAddress = assertString(header.address, `${path}.address`);
  if (headerAddress.toUpperCase() !== `${column.address}1`.toUpperCase()) contractFailure('INVALID_COORDINATE', `${path}.address`, `expected ${column.address}1`);
  if (!Object.prototype.hasOwnProperty.call(header, 'raw') || !Object.prototype.hasOwnProperty.call(header, 'display')) contractFailure('MISSING_VALUE', path, 'header must preserve raw and display values');
  if (typeof header.raw_present !== 'boolean') contractFailure('EXPECTED_BOOLEAN', `${path}.raw_present`, 'raw_present must be boolean');
  if (typeof header.display_present !== 'boolean') contractFailure('EXPECTED_BOOLEAN', `${path}.display_present`, 'display_present must be boolean');
  if (!['preserved', 'partial', 'unreadable'].includes(String(header.observation_status))) contractFailure('UNSUPPORTED_VALUE', `${path}.observation_status`, 'invalid observation status');
  assertString(header.value_type, `${path}.value_type`);
  if (header.formula !== null && header.formula !== undefined && typeof header.formula !== 'string') contractFailure('EXPECTED_STRING', `${path}.formula`, 'formula must be string or null');
  if (typeof header.empty_reason !== 'string' && header.empty_reason !== null) contractFailure('EXPECTED_STRING', `${path}.empty_reason`, 'empty_reason must be string or null');
  validateRepresentations(header.representations, `${path}.representations`);
  const cellHash = assertDigest(header.cell_hash, `${path}.cell_hash`);
  if (verifyHashes) {
    const expectedHash = hashJson(cellHashInput({
      observation_id: header.observation_id,
      column_id: column.column_id,
      address: `${column.address}1`,
      raw: header.raw,
      display: header.display,
      raw_present: header.raw_present,
      display_present: header.display_present,
      observation_status: header.observation_status,
      value_type: header.value_type,
      formula: header.formula ?? null,
      empty_reason: header.empty_reason ?? null,
      representations: header.representations,
      cell_data: header.cell_data,
      comment: header.comment,
      hyperlink: header.hyperlink,
      merged_range: header.merged_range,
      style: header.style,
    } as EvidenceCell));
    if (cellHash !== expectedHash) contractFailure('HASH_MISMATCH', `${path}.cell_hash`, 'header hash does not match preserved values');
  }
}

export interface EvidenceValidationOptions {
  source_bytes?: Uint8Array;
  expected_source_sha256?: string;
  verify_hashes?: boolean;
  verify_digest?: boolean;
}

/** Strictly validate an evidence/v2 document, including accounting and references. */
export function validateEvidenceDocument(value: unknown, options: EvidenceValidationOptions = {}): asserts value is EvidenceDocument {
  if (!isRecord(value) || value.schema !== EVIDENCE_SCHEMA) contractFailure('INVALID_SCHEMA', '$.schema', `expected ${EVIDENCE_SCHEMA}`);
  const source = value.source;
  if (!isRecord(source)) contractFailure('EXPECTED_OBJECT', '$.source', 'source must be an object');
  assertString(source.source_id, '$.source.source_id');
  assertString(source.name, '$.source.name');
  assertString(source.media_type, '$.source.media_type');
  const sourceDigest = assertDigest(source.sha256, '$.source.sha256');
  if (source.source_id !== sourceIdForSha256(sourceDigest)) contractFailure('INVALID_REFERENCE', '$.source.source_id', `expected ${sourceIdForSha256(sourceDigest)}`);
  assertString(source.session_id, '$.source.session_id', true);
  assertString(source.archived_ref, '$.source.archived_ref');
  if (options.source_bytes && sha256Hex(options.source_bytes) !== sourceDigest) contractFailure('SOURCE_HASH_MISMATCH', '$.source.sha256', 'source bytes do not match source hash');
  if (options.expected_source_sha256 && sourceDigest !== assertDigest(options.expected_source_sha256, '$.expected_source_sha256')) contractFailure('SOURCE_HASH_MISMATCH', '$.source.sha256', 'source hash does not match expected hash');
  const sheets = value.sheets;
  if (!Array.isArray(sheets)) contractFailure('EXPECTED_ARRAY', '$.sheets', 'sheets must be an array');
  const warnings = value.warnings;
  if (!Array.isArray(warnings) || warnings.some((warning) => typeof warning !== 'string')) contractFailure('EXPECTED_STRING_ARRAY', '$.warnings', 'warnings must be an array of strings');
  const provenance = value.provenance;
  if (!isRecord(provenance)) contractFailure('EXPECTED_OBJECT', '$.provenance', 'provenance must be an object');
  assertString(provenance.converter, '$.provenance.converter');
  assertString(provenance.converter_version, '$.provenance.converter_version');
  assertString(provenance.converted_at, '$.provenance.converted_at');
  const sheetIds = new Set<string>();
  const observationIds = new Set<string>();
  let rowCount = 0;
  let dataCellCount = 0;
  let headerCount = 0;
  let columnCount = 0;
  let unreadableCount = 0;
  const verifyHashes = options.verify_hashes !== false;
  sheets.forEach((sheetValue, sheetIndex) => {
    const path = `$.sheets[${sheetIndex}]`;
    if (!isRecord(sheetValue)) contractFailure('EXPECTED_OBJECT', path, 'sheet must be an object');
    const sheetId = assertString(sheetValue.sheet_id, `${path}.sheet_id`);
    if (sheetId !== sheetIdForIndex(sheetIndex)) contractFailure('INVALID_REFERENCE', `${path}.sheet_id`, `expected ${sheetIdForIndex(sheetIndex)}`);
    assertUnique(sheetIds, sheetId, `${path}.sheet_id`);
    assertString(sheetValue.name, `${path}.name`);
    if (!['visible', 'hidden', 'unknown'].includes(String(sheetValue.visibility))) contractFailure('UNSUPPORTED_VALUE', `${path}.visibility`, 'invalid visibility');
    if (!Array.isArray(sheetValue.columns)) contractFailure('EXPECTED_ARRAY', `${path}.columns`, 'columns must be an array');
    const columns = sheetValue.columns as unknown[];
    const columnIds = new Set<string>();
    const columnIndexes = new Set<number>();
    const rowIds = new Set<string>();
    const columnById = new Map<string, EvidenceColumn>();
    columns.forEach((columnValue, columnIndex) => {
      const columnPath = `${path}.columns[${columnIndex}]`;
      if (!isRecord(columnValue)) contractFailure('EXPECTED_OBJECT', columnPath, 'column must be an object');
      const columnId = assertString(columnValue.column_id, `${columnPath}.column_id`);
      assertUnique(columnIds, columnId, `${columnPath}.column_id`);
      const index = assertInteger(columnValue.index, `${columnPath}.index`, 0);
      if (columnId !== columnIdForIndex(index)) contractFailure('INVALID_REFERENCE', `${columnPath}.column_id`, `expected ${columnIdForIndex(index)}`);
      if (columnIndexes.has(index)) contractFailure('DUPLICATE_COORDINATE', `${columnPath}.index`, `duplicate column index: ${index}`);
      columnIndexes.add(index);
      assertString(columnValue.label, `${columnPath}.label`, true);
      const address = assertString(columnValue.address, `${columnPath}.address`);
      if (address.toUpperCase() !== columnName(index + 1)) contractFailure('INVALID_COORDINATE', `${columnPath}.address`, `expected ${columnName(index + 1)}`);
      columnById.set(columnId, columnValue as unknown as EvidenceColumn);
      columnCount++;
      if (columnValue.header === undefined) contractFailure('MISSING_VALUE', `${columnPath}.header`, 'every column must carry a header observation');
      validateHeader(columnValue.header, `${columnPath}.header`, source.source_id as string, sheetId, columnValue as unknown as EvidenceColumn, observationIds, verifyHashes);
      headerCount++;
      const header = columnValue.header as Record<string, unknown>;
      if (header.observation_status === 'unreadable' || header.empty_reason === 'unreadable') unreadableCount++;
    });
    if (!Array.isArray(sheetValue.rows)) contractFailure('EXPECTED_ARRAY', `${path}.rows`, 'rows must be an array');
    const rowNumbers = new Set<number>();
    (sheetValue.rows as unknown[]).forEach((rowValue, rowIndex) => {
      const rowPath = `${path}.rows[${rowIndex}]`;
      if (!isRecord(rowValue)) contractFailure('EXPECTED_OBJECT', rowPath, 'row must be an object');
      const rowId = assertString(rowValue.row_id, `${rowPath}.row_id`);
      assertUnique(rowIds, rowId, `${rowPath}.row_id`);
      const rowNumber = assertInteger(rowValue.row_number, `${rowPath}.row_number`, 1);
      if (rowId !== rowIdFor(sheetId, rowNumber)) contractFailure('INVALID_REFERENCE', `${rowPath}.row_id`, `expected ${rowIdFor(sheetId, rowNumber)}`);
      if (rowNumbers.has(rowNumber)) contractFailure('DUPLICATE_COORDINATE', `${rowPath}.row_number`, `duplicate row number: ${rowNumber}`);
      rowNumbers.add(rowNumber);
      if (!Array.isArray(rowValue.cells)) contractFailure('EXPECTED_ARRAY', `${rowPath}.cells`, 'cells must be an array');
      if ((rowValue.cells as unknown[]).length !== columns.length) contractFailure('INCOMPLETE_ROW', `${rowPath}.cells`, `expected ${columns.length} cells, got ${(rowValue.cells as unknown[]).length}`);
      const rowColumns = new Set<string>();
      (rowValue.cells as unknown[]).forEach((cellValue, cellIndex) => {
        const cellPath = `${rowPath}.cells[${cellIndex}]`;
        const cell = validateCell(cellValue, cellPath, source.source_id as string, sheetId, columnById, rowNumber, observationIds, verifyHashes);
        if (rowColumns.has(cell.column_id)) contractFailure('DUPLICATE_REFERENCE', `${cellPath}.column_id`, `duplicate column: ${cell.column_id}`);
        rowColumns.add(cell.column_id);
        if (cell.observation_status === 'unreadable' || cell.empty_reason === 'unreadable') {
          unreadableCount++;
        }
        dataCellCount++;
      });
      if (!Array.isArray(rowValue.warnings) || rowValue.warnings.some((warning) => typeof warning !== 'string')) contractFailure('EXPECTED_STRING_ARRAY', `${rowPath}.warnings`, 'warnings must be an array of strings');
      const rowHash = assertDigest(rowValue.row_hash, `${rowPath}.row_hash`);
      if (verifyHashes && rowHash !== rowHashForValue(rowValue)) contractFailure('HASH_MISMATCH', `${rowPath}.row_hash`, 'row hash does not match cells');
      rowCount++;
    });
  });
  const accounting = value.accounting;
  if (!isRecord(accounting)) contractFailure('EXPECTED_OBJECT', '$.accounting', 'accounting must be an object');
  // Headers are first-class observations even though they remain attached to
  // column metadata for structural context. `data_cell_count` keeps the
  // row-level count explicit while `cell_count`/`observation_count` cover all
  // observations exposed to the Agent.
  const totalObservationCount = dataCellCount + headerCount;
  const expectedCounts: Array<[string, number]> = [
    ['sheet_count', sheets.length],
    ['row_count', rowCount],
    ['cell_count', totalObservationCount],
    ['preserved_cell_count', totalObservationCount - unreadableCount],
  ];
  for (const [key, expected] of expectedCounts) {
    const actual = assertInteger(accounting[key], `$.accounting.${key}`, 0);
    if (actual !== expected) contractFailure('ACCOUNTING_MISMATCH', `$.accounting.${key}`, `expected ${expected}, got ${actual}`);
  }
  const accountingFields: Array<[keyof EvidenceAccounting, number]> = [
    ['observation_count', totalObservationCount],
    ['column_count', columnCount],
    ['unreadable_cell_count', unreadableCount],
    ['header_count', headerCount],
    ['data_cell_count', dataCellCount],
  ];
  for (const [key, expected] of accountingFields) {
    const actual = assertInteger(accounting[key], `$.accounting.${key}`, 0);
    if (actual !== expected) contractFailure('ACCOUNTING_MISMATCH', `$.accounting.${key}`, `expected ${expected}, got ${actual}`);
  }
  const digest = assertDigest(value.evidence_digest, '$.evidence_digest');
  if (options.verify_digest !== false && digest !== computeEvidenceDigest(value as unknown as EvidenceDocument)) contractFailure('HASH_MISMATCH', '$.evidence_digest', 'evidence digest does not match document');
}

/** Recompute document accounting from the represented sheets. */
export function evidenceAccountingFor(sheets: EvidenceSheet[]): EvidenceAccounting {
  let rowCount = 0;
  let dataCellCount = 0;
  let headerCount = 0;
  let unreadableCount = 0;
  let columnCount = 0;
  for (const sheet of sheets) {
    columnCount += sheet.columns.length;
    for (const column of sheet.columns) {
      headerCount++;
      if (column.header.observation_status === 'unreadable' || column.header.empty_reason === 'unreadable') unreadableCount++;
    }
    rowCount += sheet.rows.length;
    for (const row of sheet.rows) {
      dataCellCount += row.cells.length;
      for (const cell of row.cells) if (cell.observation_status === 'unreadable' || cell.empty_reason === 'unreadable') unreadableCount++;
    }
  }
  const cellCount = dataCellCount + headerCount;
  return {
    sheet_count: sheets.length,
    row_count: rowCount,
    cell_count: cellCount,
    preserved_cell_count: cellCount - unreadableCount,
    observation_count: cellCount,
    column_count: columnCount,
    unreadable_cell_count: unreadableCount,
    header_count: headerCount,
    data_cell_count: dataCellCount,
  };
}

function rowHashForValue(row: Record<string, unknown>): string {
  return hashJson({ row_id: row.row_id, row_number: row.row_number, cells: (row.cells as Array<Record<string, unknown>>).map((cell) => cell.cell_hash) });
}

export function parseA1Range(value: string, defaultSheet?: string): A1Range {
  let raw = String(value || '').trim();
  let sheet = defaultSheet;
  const sheetMatch = /^'?(.+?)'?!(.+)$/u.exec(raw);
  if (sheetMatch) {
    sheet = sheetMatch[1].replaceAll("''", "'");
    raw = sheetMatch[2];
  }
  const match = /^([A-Za-z]+)(\d+)(?::([A-Za-z]+)(\d+))?$/u.exec(raw);
  if (!match) throw new Error(`范围格式无效：${value}`);
  const startColumn = columnIndex(match[1]);
  const startRow = Number(match[2]);
  const endColumn = match[3] ? columnIndex(match[3]) : startColumn;
  const endRow = match[4] ? Number(match[4]) : startRow;
  if (startRow < 1 || endRow < startRow || startColumn < 1 || endColumn < startColumn) throw new Error(`范围格式无效：${value}`);
  return { sheet, startRow, endRow, startColumn, endColumn };
}

function matchesRange(sheet: EvidenceSheet, row: EvidenceRow, cell: EvidenceCell, range?: A1Range): boolean {
  if (!range) return true;
  if (range.sheet && range.sheet !== sheet.name && range.sheet !== sheet.sheet_id) return false;
  const column = sheet.columns.find((item) => item.column_id === cell.column_id);
  if (!column) return false;
  return row.row_number >= range.startRow && row.row_number <= range.endRow && column.index + 1 >= range.startColumn && column.index + 1 <= range.endColumn;
}

function headerObservation(sheet: EvidenceSheet, column: EvidenceColumn): EvidenceObservation | undefined {
  const header = column.header;
  if (!header) return undefined;
  return {
    ...(header as EvidenceCell),
    sheet_id: sheet.sheet_id,
    sheet_name: sheet.name,
    row_id: rowIdFor(sheet.sheet_id, 1),
    row_number: 1,
    column_index: column.index,
    column_label: column.label,
    observation_kind: 'header',
  };
}

// Generic `values` payloads are ambiguous (adapters commonly expose them as
// either raw or display data), so treat them as sensitive in a raw-excluded
// projection. Named display/formatted aliases remain available for reading.
const RAW_REPRESENTATION_NAMES = new Set([
  'raw',
  'value',
  'values',
  'celldata',
  'rawvalues',
  'cells',
]);

function isRawRepresentationName(name: string): boolean {
  return RAW_REPRESENTATION_NAMES.has(name.replaceAll('_', '').replaceAll('-', '').toLowerCase());
}

function withoutRawObservation<T extends Record<string, unknown>>(observation: T): T {
  const result: Record<string, unknown> = { ...observation };
  delete result.raw;
  delete result.cell_data;
  if (isRecord(result.representations)) {
    const representations: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [name, value] of Object.entries(result.representations)) {
      if (isRecord(value) && isRawRepresentationName(name)) {
        const redacted = { ...value };
        delete redacted.value;
        representations[name] = redacted;
      } else {
        representations[name] = value;
      }
    }
    result.representations = representations;
  }
  return result as T;
}

function resolveRange(options: EvidencePageOptions): A1Range | undefined {
  if (!options.range) return undefined;
  return parseA1Range(options.range, options.sheet);
}

function flattenObservations(document: EvidenceDocument, options: EvidencePageOptions): EvidenceObservation[] {
  const range = resolveRange(options);
  const observations: EvidenceObservation[] = [];
  for (const sheet of document.sheets) {
    if (options.sheet && options.sheet !== sheet.name && options.sheet !== sheet.sheet_id) continue;
    if (range?.sheet && range.sheet !== sheet.name && range.sheet !== sheet.sheet_id) continue;
    // Headers are observations too. They are emitted before row-level cells so
    // the first page gives the Agent the vocabulary needed to interpret data.
    if (!range || range.startRow <= 1) {
      for (const column of sheet.columns) {
        if (range && (column.index + 1 < range.startColumn || column.index + 1 > range.endColumn)) continue;
        const observation = headerObservation(sheet, column);
        if (!observation) continue;
        observations.push(options.include_raw === false ? withoutRawObservation(observation) : observation);
      }
    }
    for (const row of sheet.rows) {
      for (const cell of row.cells) {
        if (!matchesRange(sheet, row, cell, range)) continue;
        const column = sheet.columns.find((item) => item.column_id === cell.column_id)!;
        const result: EvidenceObservation = {
          ...cell,
          sheet_id: sheet.sheet_id,
          sheet_name: sheet.name,
          row_id: row.row_id,
          row_number: row.row_number,
          column_index: column.index,
          column_label: column.label,
          observation_kind: 'cell',
        };
        observations.push(options.include_raw === false ? withoutRawObservation(result) : result);
      }
    }
  }
  return observations;
}

function selectionKey(options: EvidencePageOptions): { sheet?: string; range?: string } {
  const range = options.range ? parseA1Range(options.range, options.sheet) : undefined;
  return { sheet: options.sheet, range: range ? `${range.startColumn}:${range.startRow}:${range.endColumn}:${range.endRow}:${range.sheet || ''}` : undefined };
}

function assertKnownSelection(document: EvidenceDocument, options: EvidencePageOptions, range?: A1Range): void {
  const requested = options.sheet || range?.sheet;
  if (!requested) return;
  if (!document.sheets.some((sheet) => sheet.name === requested || sheet.sheet_id === requested)) {
    contractFailure('UNKNOWN_SHEET', '$.sheet', `unknown sheet: ${requested}`);
  }
}

export function encodeEvidenceCursor(value: Omit<EvidenceCursor, 'schema'> | EvidenceCursor): string {
  const payload: EvidenceCursor = {
    schema: EVIDENCE_CURSOR_SCHEMA,
    evidence_digest: assertDigest(value.evidence_digest, '$.evidence_digest'),
    ...(value.sheet ? { sheet: String(value.sheet) } : {}),
    ...(value.range ? { range: String(value.range) } : {}),
    offset: assertInteger(value.offset, '$.offset', 0),
  };
  return Buffer.from(stableStringify(payload), 'utf8').toString('base64url');
}

export function decodeEvidenceCursor(value: string): EvidenceCursor {
  if (typeof value !== 'string' || !value) contractFailure('INVALID_CURSOR', '$.cursor', 'cursor must be a non-empty string');
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); } catch { contractFailure('INVALID_CURSOR', '$.cursor', 'cursor is not valid base64url JSON'); }
  if (!isRecord(parsed) || parsed.schema !== EVIDENCE_CURSOR_SCHEMA) contractFailure('INVALID_CURSOR', '$.cursor', 'unsupported cursor schema');
  return {
    schema: EVIDENCE_CURSOR_SCHEMA,
    evidence_digest: assertDigest(parsed.evidence_digest, '$.cursor.evidence_digest'),
    ...(parsed.sheet !== undefined ? { sheet: assertString(parsed.sheet, '$.cursor.sheet') } : {}),
    ...(parsed.range !== undefined ? { range: assertString(parsed.range, '$.cursor.range') } : {}),
    offset: assertInteger(parsed.offset, '$.cursor.offset', 0),
  };
}

/** Return a deterministic observation page bound to the exact evidence digest and query. */
export function paginateEvidence(document: EvidenceDocument, options: EvidencePageOptions = {}): EvidencePage {
  validateEvidenceDocument(document);
  const requestedMax = options.max_items === undefined ? 200 : Number(options.max_items);
  if (!Number.isFinite(requestedMax) || requestedMax < 1) contractFailure('INVALID_LIMIT', '$.max_items', 'max_items must be a positive finite number');
  const max = Math.min(10000, Math.floor(requestedMax));
  const resolvedRange = resolveRange(options);
  assertKnownSelection(document, options, resolvedRange);
  const key = selectionKey(options);
  const all = flattenObservations(document, options);
  let offset = 0;
  if (options.cursor) {
    const cursor = decodeEvidenceCursor(options.cursor);
    if (cursor.evidence_digest !== document.evidence_digest) contractFailure('CURSOR_STALE', '$.cursor', 'cursor belongs to a different evidence revision');
    if (cursor.sheet !== key.sheet || cursor.range !== key.range) contractFailure('CURSOR_QUERY_MISMATCH', '$.cursor', 'cursor query does not match requested selection');
    offset = cursor.offset;
  }
  if (offset > all.length) contractFailure('CURSOR_OUT_OF_RANGE', '$.cursor.offset', 'cursor is beyond the available observations');
  const observations = all.slice(offset, offset + max);
  const nextOffset = offset + observations.length;
  const nextCursor = nextOffset < all.length ? encodeEvidenceCursor({ evidence_digest: document.evidence_digest, ...key, offset: nextOffset }) : null;
  return {
    schema: 'dealpilot.evidence-slice/v2',
    evidence_digest: document.evidence_digest,
    observations,
    returned_observations: observations.length,
    total_observations: all.length,
    next_cursor: nextCursor,
    cursor: options.cursor || null,
    citation: observations.map((observation) => ({ observation_id: observation.observation_id, location: `${observation.sheet_name}!${observation.address}` })),
  };
}

export const pageEvidenceObservations = paginateEvidence;

/** Build a range-selected evidence view for previews and focused reads. */
export function selectEvidenceRange(document: EvidenceDocument, options: Omit<EvidencePageOptions, 'cursor' | 'max_items'> = {}): EvidenceDocument {
  validateEvidenceDocument(document);
  const range = resolveRange(options);
  assertKnownSelection(document, options, range);
  const selectedSheets = document.sheets
    .filter((sheet) => {
      const requestedSheet = options.sheet || range?.sheet;
      return !requestedSheet || requestedSheet === sheet.name || requestedSheet === sheet.sheet_id;
    })
    .map((sheet) => {
      const columns = sheet.columns.filter((column) => !range || (column.index + 1 >= range.startColumn && column.index + 1 <= range.endColumn));
      const allowed = new Set(columns.map((column) => column.column_id));
      const rows = sheet.rows
        .filter((row) => !range || (row.row_number >= range.startRow && row.row_number <= range.endRow))
        .map((row) => {
          const cells = row.cells.filter((cell) => allowed.has(cell.column_id));
          const next = {
            ...row,
            cells,
            row_hash: rowHash({ row_id: row.row_id, row_number: row.row_number, cells }),
        };
          return next;
        });
      return { ...sheet, columns, rows };
    });
  const selected: EvidenceDocument = {
    ...document,
    sheets: selectedSheets,
    accounting: evidenceAccountingFor(selectedSheets),
  };
  selected.source_evidence_digest = document.evidence_digest;
  selected.evidence_digest = computeEvidenceDigest(selected);
  return selected;
}

export function isEvidenceDocument(value: unknown): value is EvidenceDocument {
  return isRecord(value) && value.schema === EVIDENCE_SCHEMA;
}
