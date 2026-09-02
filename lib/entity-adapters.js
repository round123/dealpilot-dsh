import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { isAbsolutePathLike } from './okf-utils.js';
// Only operations with a complete file/event/index implementation are
// advertised here. Graph merge/delete/restore semantics stay outside this
// kernel until their relation-wide transaction is implemented.
const businessOperations = ['create', 'update', 'append', 'archive', 'link'];
export const ENTITY_ADAPTERS = {
    customer: {
        entity: 'customer', directory: 'knowledge/customers', indexName: 'customer', fileExtension: '.md',
        operations: businessOperations, relationFields: [], requiresTitle: true,
    },
    contact: {
        entity: 'contact', directory: 'knowledge/contacts', indexName: 'contact', fileExtension: '.md',
        operations: businessOperations, relationFields: ['customer'], requiresTitle: true,
    },
    deal: {
        entity: 'deal', directory: 'knowledge/deals', indexName: 'deal', fileExtension: '.md',
        operations: businessOperations, relationFields: ['customer'], requiresTitle: true,
    },
    action: {
        entity: 'action', directory: 'knowledge/actions', indexName: 'action', fileExtension: '.md',
        operations: businessOperations, relationFields: ['deal'], requiresTitle: true,
    },
    relationship: {
        entity: 'relationship', directory: 'knowledge/relationships', indexName: 'relationship', fileExtension: '.md',
        operations: ['create', 'update', 'append', 'archive', 'link'], relationFields: ['from', 'to'], requiresTitle: false,
    },
    note: {
        entity: 'note', directory: 'knowledge/notes', fileExtension: '.md',
        operations: ['create', 'update', 'append', 'archive', 'link'], relationFields: [], requiresTitle: true,
    },
    evidence: {
        entity: 'evidence', directory: 'sources/evidence', fileExtension: '.json',
        operations: ['create', 'update', 'append', 'link'], relationFields: [], requiresTitle: false,
    },
};
function adapterFor(entity) {
    const adapter = ENTITY_ADAPTERS[entity];
    if (!adapter)
        throw new Error(`Unsupported mutation entity type: ${entity}`);
    return adapter;
}
function relativeInside(workspace, value) {
    if (!value || isAbsolutePathLike(value) || value.includes('..')) {
        throw new Error('引用必须是当前 Workspace 内的相对路径');
    }
    const normalized = value.replaceAll('\\', '/');
    if (normalized.startsWith('/') || normalized.split('/').some(part => !part || part === '.' || part === '..')) {
        throw new Error('引用路径格式无效');
    }
    const workspacePath = path.resolve(workspace);
    const resolved = path.resolve(workspacePath, normalized);
    const rel = path.relative(workspacePath, resolved);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel))
        throw new Error('引用必须位于当前 Workspace');
    return rel.replaceAll('\\', '/');
}
export function adapterForEntity(entity) {
    return adapterFor(entity);
}
export function entityDirectory(entity) {
    return adapterFor(entity).directory;
}
export function entityIndexName(entity) {
    return adapterFor(entity).indexName;
}
/** Normalize a ref and enforce the directory owned by the selected adapter. */
export function normalizeEntityRef(workspace, entity, value) {
    const adapter = adapterFor(entity);
    const relative = relativeInside(workspace, value);
    const expectedPrefix = `${adapter.directory}/`;
    if (!relative.startsWith(expectedPrefix)) {
        throw new Error(`实体类型 ${entity} 不能写入 ${relative}`);
    }
    if (!relative.endsWith(adapter.fileExtension)) {
        throw new Error(`实体 ${entity} 的引用必须使用 ${adapter.fileExtension} 文件`);
    }
    return relative;
}
/** Normalize a non-business evidence source ref without allowing path escape. */
export function normalizeEvidenceSourceRef(workspace, value) {
    const relative = relativeInside(workspace, value);
    if (relative.startsWith('knowledge/customers/') || relative.startsWith('knowledge/contacts/')
        || relative.startsWith('knowledge/deals/') || relative.startsWith('knowledge/actions/')) {
        throw new Error('证据来源不能指向业务对象目录');
    }
    return relative;
}
export function entityFromRef(ref) {
    const normalized = ref.replaceAll('\\', '/');
    for (const adapter of Object.values(ENTITY_ADAPTERS)) {
        if (normalized.startsWith(`${adapter.directory}/`) && normalized.endsWith(adapter.fileExtension))
            return adapter.entity;
    }
    return undefined;
}
export function isBusinessEntity(entity) {
    return Boolean(ENTITY_ADAPTERS[entity].indexName);
}
export function assertOperationAllowed(entity, operation) {
    const adapter = adapterFor(entity);
    if (!adapter.operations.includes(operation))
        throw new Error(`实体 ${entity} 不支持 ${operation} 操作`);
}
export function titleFromTarget(target) {
    const identity = target.identity;
    const identityTitle = identity && typeof identity === 'object'
        ? identity.title
        : undefined;
    const value = target.title ?? target.label ?? identityTitle;
    if (typeof value !== 'string' || !value.trim())
        return undefined;
    return value.trim();
}
function slug(value) {
    return value.toLowerCase()
        .replace(/[^a-z0-9\u4e00-\u9fff]+/gu, '-')
        .replace(/^-+|-+$/gu, '')
        .slice(0, 48) || 'record';
}
/** Derive a stable create ref from op_id; retries never generate a new file. */
export function deriveCreateRef(workspace, entity, target, opId, now = new Date()) {
    const adapter = adapterFor(entity);
    const title = titleFromTarget(target);
    if (adapter.requiresTitle && !title)
        throw new Error(`实体 ${entity} 创建需要明确 title/identity.title`);
    const seed = `${entity}:${opId}`;
    const suffix = createHash('sha256').update(seed).digest('hex').slice(0, 10);
    const filename = `${now.toISOString().slice(0, 10)}-${slug(title || opId)}-${suffix}${adapter.fileExtension}`;
    return normalizeEntityRef(workspace, entity, `${adapter.directory}/${filename}`);
}
/**
 * Lexical and realpath checks prevent both traversal and symlink escapes. For
 * create targets, the parent directory is checked because the file is absent.
 */
export async function assertEntityPathSafe(workspace, entity, ref) {
    const relative = normalizeEntityRef(workspace, entity, ref);
    const workspaceReal = await fs.realpath(path.resolve(workspace));
    const candidate = path.resolve(workspaceReal, relative);
    let checkPath = candidate;
    try {
        const stat = await fs.lstat(candidate);
        if (stat.isSymbolicLink())
            throw new Error(`禁止通过符号链接写入实体：${relative}`);
    }
    catch (error) {
        if (error?.code !== 'ENOENT')
            throw error;
        checkPath = path.dirname(candidate);
    }
    const realParent = await fs.realpath(checkPath);
    const rel = path.relative(workspaceReal, realParent);
    if (rel.startsWith('..') || path.isAbsolute(rel))
        throw new Error(`实体引用逃逸 Workspace：${relative}`);
    return relative;
}
export async function assertSourcePathSafe(workspace, ref) {
    const relative = normalizeEvidenceSourceRef(workspace, ref);
    const workspaceReal = await fs.realpath(path.resolve(workspace));
    const candidate = path.resolve(workspaceReal, relative);
    let checkPath = candidate;
    try {
        const stat = await fs.lstat(candidate);
        if (stat.isSymbolicLink())
            throw new Error(`禁止通过符号链接读取来源：${relative}`);
    }
    catch (error) {
        if (error?.code !== 'ENOENT')
            throw error;
        checkPath = path.dirname(candidate);
    }
    const realParent = await fs.realpath(checkPath);
    const rel = path.relative(workspaceReal, realParent);
    if (rel.startsWith('..') || path.isAbsolute(rel))
        throw new Error(`来源引用逃逸 Workspace：${relative}`);
    return relative;
}
export function relationFieldsFor(entity) {
    return [...adapterFor(entity).relationFields];
}
