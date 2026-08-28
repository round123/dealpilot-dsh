import { createHash } from 'node:crypto';
export class ContractValidationError extends Error {
    code;
    path;
    details;
    constructor(code, path, message, details) {
        super(`${path}: ${message}`);
        this.name = 'ContractValidationError';
        this.code = code;
        this.path = path;
        this.details = details;
    }
    toJSON() {
        return {
            code: this.code,
            path: this.path,
            message: this.message,
            ...(this.details ? { details: this.details } : {}),
        };
    }
}
export function failContract(code, path, message, details) {
    throw new ContractValidationError(code, path, message, details);
}
export function isRecord(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
export function expectRecord(value, path) {
    if (!isRecord(value))
        failContract('EXPECTED_OBJECT', path, 'expected a JSON object');
    return value;
}
export function expectArray(value, path) {
    if (!Array.isArray(value))
        failContract('EXPECTED_ARRAY', path, 'expected an array');
    return value;
}
export function expectString(value, path, options = {}) {
    if (typeof value !== 'string')
        failContract('EXPECTED_STRING', path, 'expected a string');
    if (!options.allowEmpty && value.trim().length === 0)
        failContract('EMPTY_STRING', path, 'must not be empty');
    return value;
}
export function expectOptionalString(value, path) {
    if (value === undefined)
        return undefined;
    return expectString(value, path);
}
export function expectFiniteNumber(value, path) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        failContract('EXPECTED_FINITE_NUMBER', path, 'expected a finite number');
    }
    return value;
}
export function expectNonNegativeInteger(value, path) {
    if (!Number.isSafeInteger(value) || value < 0) {
        failContract('EXPECTED_NON_NEGATIVE_INTEGER', path, 'expected a non-negative safe integer');
    }
    return value;
}
export function expectEnum(value, allowed, path) {
    if (typeof value !== 'string' || !allowed.includes(value)) {
        failContract('UNSUPPORTED_VALUE', path, `expected one of: ${allowed.join(', ')}`, { value });
    }
    return value;
}
export function expectStringArray(value, path, options = {}) {
    const items = expectArray(value, path).map((item, index) => expectString(item, `${path}[${index}]`));
    const minItems = options.minItems ?? 0;
    if (items.length < minItems) {
        failContract('TOO_FEW_ITEMS', path, `expected at least ${minItems} item(s)`, { actual: items.length });
    }
    if (options.unique !== false) {
        const seen = new Set();
        for (let index = 0; index < items.length; index++) {
            if (seen.has(items[index])) {
                failContract('DUPLICATE_VALUE', `${path}[${index}]`, `duplicate value: ${items[index]}`);
            }
            seen.add(items[index]);
        }
    }
    return items;
}
export function isIsoDateTime(value) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value))
        return false;
    return Number.isFinite(Date.parse(value));
}
export function expectIsoDateTime(value, path) {
    const text = expectString(value, path);
    if (!isIsoDateTime(text))
        failContract('INVALID_DATETIME', path, 'expected an ISO 8601 date-time with timezone');
    return text;
}
export function isSha256Digest(value) {
    return typeof value === 'string' && /^(?:sha256:)?[a-f0-9]{64}$/iu.test(value);
}
export function expectDigest(value, path) {
    const digest = expectString(value, path);
    if (!isSha256Digest(digest)) {
        failContract('INVALID_DIGEST', path, 'expected a SHA-256 digest (64 hexadecimal characters)');
    }
    return digest.toLowerCase().replace(/^sha256:/u, '');
}
export function isJsonValue(value) {
    try {
        canonicalizeJson(value);
        return true;
    }
    catch {
        return false;
    }
}
export function expectJsonValue(value, path) {
    try {
        return canonicalizeJson(value);
    }
    catch (error) {
        failContract('INVALID_JSON_VALUE', path, String(error?.message || error));
    }
}
export function canonicalizeJson(value) {
    const active = new WeakSet();
    const visit = (input, path) => {
        if (input === null || typeof input === 'string' || typeof input === 'boolean')
            return input;
        if (typeof input === 'number') {
            if (!Number.isFinite(input))
                throw new TypeError(`${path} contains a non-finite number`);
            return Object.is(input, -0) ? 0 : input;
        }
        if (typeof input !== 'object')
            throw new TypeError(`${path} contains a non-JSON ${typeof input} value`);
        if (active.has(input))
            throw new TypeError(`${path} contains a circular reference`);
        active.add(input);
        try {
            if (Array.isArray(input))
                return input.map((item, index) => visit(item, `${path}[${index}]`));
            if (!isRecord(input))
                throw new TypeError(`${path} contains a non-plain object`);
            const output = {};
            for (const key of Object.keys(input).sort())
                output[key] = visit(input[key], `${path}.${key}`);
            return output;
        }
        finally {
            active.delete(input);
        }
    };
    return visit(value, '$');
}
export function stableStringify(value) {
    return JSON.stringify(canonicalizeJson(value));
}
export function sha256Hex(value) {
    return createHash('sha256').update(value).digest('hex');
}
export function hashJson(value) {
    return sha256Hex(stableStringify(value));
}
export function iterableToStringSet(value, path) {
    const result = new Set();
    let index = 0;
    for (const item of value) {
        const text = expectString(item, `${path}[${index}]`);
        if (result.has(text))
            failContract('DUPLICATE_VALUE', `${path}[${index}]`, `duplicate value: ${text}`);
        result.add(text);
        index++;
    }
    return result;
}
