import { createHash } from 'node:crypto';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface ContractValidationIssue {
  code: string;
  path: string;
  message: string;
  details?: Record<string, unknown>;
}

export class ContractValidationError extends Error {
  readonly code: string;
  readonly path: string;
  readonly details?: Record<string, unknown>;

  constructor(code: string, path: string, message: string, details?: Record<string, unknown>) {
    super(`${path}: ${message}`);
    this.name = 'ContractValidationError';
    this.code = code;
    this.path = path;
    this.details = details;
  }

  toJSON(): ContractValidationIssue {
    return {
      code: this.code,
      path: this.path,
      message: this.message,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

export function failContract(
  code: string,
  path: string,
  message: string,
  details?: Record<string, unknown>,
): never {
  throw new ContractValidationError(code, path, message, details);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function expectRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) failContract('EXPECTED_OBJECT', path, 'expected a JSON object');
  return value;
}

export function expectArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) failContract('EXPECTED_ARRAY', path, 'expected an array');
  return value;
}

export function expectString(value: unknown, path: string, options: { allowEmpty?: boolean } = {}): string {
  if (typeof value !== 'string') failContract('EXPECTED_STRING', path, 'expected a string');
  if (!options.allowEmpty && value.trim().length === 0) failContract('EMPTY_STRING', path, 'must not be empty');
  return value;
}

export function expectOptionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  return expectString(value, path);
}

export function expectFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    failContract('EXPECTED_FINITE_NUMBER', path, 'expected a finite number');
  }
  return value;
}

export function expectNonNegativeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    failContract('EXPECTED_NON_NEGATIVE_INTEGER', path, 'expected a non-negative safe integer');
  }
  return value as number;
}

export function expectEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    failContract('UNSUPPORTED_VALUE', path, `expected one of: ${allowed.join(', ')}`, { value });
  }
  return value as T;
}

export function expectStringArray(
  value: unknown,
  path: string,
  options: { minItems?: number; unique?: boolean } = {},
): string[] {
  const items = expectArray(value, path).map((item, index) => expectString(item, `${path}[${index}]`));
  const minItems = options.minItems ?? 0;
  if (items.length < minItems) {
    failContract('TOO_FEW_ITEMS', path, `expected at least ${minItems} item(s)`, { actual: items.length });
  }
  if (options.unique !== false) {
    const seen = new Set<string>();
    for (let index = 0; index < items.length; index++) {
      if (seen.has(items[index])) {
        failContract('DUPLICATE_VALUE', `${path}[${index}]`, `duplicate value: ${items[index]}`);
      }
      seen.add(items[index]);
    }
  }
  return items;
}

export function isIsoDateTime(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) return false;
  return Number.isFinite(Date.parse(value));
}

export function expectIsoDateTime(value: unknown, path: string): string {
  const text = expectString(value, path);
  if (!isIsoDateTime(text)) failContract('INVALID_DATETIME', path, 'expected an ISO 8601 date-time with timezone');
  return text;
}

export function isSha256Digest(value: unknown): value is string {
  return typeof value === 'string' && /^(?:sha256:)?[a-f0-9]{64}$/iu.test(value);
}

export function expectDigest(value: unknown, path: string): string {
  const digest = expectString(value, path);
  if (!isSha256Digest(digest)) {
    failContract('INVALID_DIGEST', path, 'expected a SHA-256 digest (64 hexadecimal characters)');
  }
  return digest.toLowerCase().replace(/^sha256:/u, '');
}

export function isJsonValue(value: unknown): value is JsonValue {
  try {
    canonicalizeJson(value);
    return true;
  } catch {
    return false;
  }
}

export function expectJsonValue(value: unknown, path: string): JsonValue {
  try {
    return canonicalizeJson(value);
  } catch (error: any) {
    failContract('INVALID_JSON_VALUE', path, String(error?.message || error));
  }
}

export function canonicalizeJson(value: unknown): JsonValue {
  const active = new WeakSet<object>();

  const visit = (input: unknown, path: string): JsonValue => {
    if (input === null || typeof input === 'string' || typeof input === 'boolean') return input;
    if (typeof input === 'number') {
      if (!Number.isFinite(input)) throw new TypeError(`${path} contains a non-finite number`);
      return Object.is(input, -0) ? 0 : input;
    }
    if (typeof input !== 'object') throw new TypeError(`${path} contains a non-JSON ${typeof input} value`);
    if (active.has(input as object)) throw new TypeError(`${path} contains a circular reference`);
    active.add(input as object);
    try {
      if (Array.isArray(input)) return input.map((item, index) => visit(item, `${path}[${index}]`));
      if (!isRecord(input)) throw new TypeError(`${path} contains a non-plain object`);
      const output: Record<string, JsonValue> = {};
      for (const key of Object.keys(input).sort()) output[key] = visit(input[key], `${path}.${key}`);
      return output;
    } finally {
      active.delete(input as object);
    }
  };

  return visit(value, '$');
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalizeJson(value));
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function hashJson(value: unknown): string {
  return sha256Hex(stableStringify(value));
}

export function iterableToStringSet(value: Iterable<string>, path: string): Set<string> {
  const result = new Set<string>();
  let index = 0;
  for (const item of value) {
    const text = expectString(item, `${path}[${index}]`);
    if (result.has(text)) failContract('DUPLICATE_VALUE', `${path}[${index}]`, `duplicate value: ${text}`);
    result.add(text);
    index++;
  }
  return result;
}
