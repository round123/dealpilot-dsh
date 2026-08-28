import * as fs from 'node:fs/promises';
import * as path from 'node:path';
function labelOf(options) {
    return options.label || 'artifact';
}
function absoluteLike(value) {
    return path.isAbsolute(value) || /^[A-Za-z]:[\\/]/u.test(value) || /^\\\\/u.test(value) || /^\/\//u.test(value);
}
function normalizeReference(value, label) {
    if (typeof value !== 'string' || !value.trim())
        throw new Error(`${label} 引用不能为空`);
    const normalized = value.replaceAll('\\', '/');
    if (absoluteLike(normalized))
        throw new Error(`${label} 必须是 Workspace 内相对路径`);
    const segments = normalized.split('/');
    if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
        throw new Error(`${label} 引用包含不安全路径段`);
    }
    return segments.join('/');
}
function inside(root, candidate, label) {
    const relative = path.relative(root, candidate);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`${label} 真实路径位于当前 Workspace 之外`);
    }
}
async function realWorkspace(workspace, label) {
    if (typeof workspace !== 'string' || !path.isAbsolute(workspace)) {
        throw new Error(`${label} Workspace 路径必须是绝对路径`);
    }
    try {
        const root = await fs.realpath(path.resolve(workspace));
        const stat = await fs.stat(root);
        if (!stat.isDirectory())
            throw new Error(`${label} Workspace 不是目录`);
        return root;
    }
    catch (error) {
        if (error?.code === 'ENOENT')
            throw new Error(`${label} Workspace 不存在`);
        throw error;
    }
}
/** Check every existing lexical component, including the parent directory. */
async function checkComponents(root, relative, label) {
    if (!relative)
        return;
    const segments = relative.split('/');
    let current = root;
    for (let index = 0; index < segments.length; index++) {
        current = path.join(current, segments[index]);
        let stat;
        try {
            stat = await fs.lstat(current);
        }
        catch (error) {
            if (error?.code === 'ENOENT')
                return;
            throw error;
        }
        if (stat.isSymbolicLink())
            throw new Error(`${label} 禁止通过符号链接访问：${relative}`);
        if (index < segments.length - 1 && !stat.isDirectory()) {
            throw new Error(`${label} 父路径不是目录：${relative}`);
        }
    }
    // The component walk rejects symlinks lexically.  The realpath check also
    // covers a mount/reparse-point substitution that is not reported as a
    // symbolic link by the host filesystem.
    const resolved = await fs.realpath(path.join(root, relative)).catch(() => undefined);
    if (resolved)
        inside(root, resolved, label);
}
/**
 * Return a safe absolute path for a Workspace-relative artifact.  Existing
 * targets must be regular files unless `allowMissing` is true; missing parent
 * directories may be created only after their existing ancestors pass the
 * same checks.
 */
export async function resolveArtifactPath(workspace, reference, options = {}) {
    const label = labelOf(options);
    const relative = normalizeReference(reference, label);
    const root = await realWorkspace(workspace, label);
    const candidate = path.resolve(root, relative);
    inside(root, candidate, label);
    const parent = path.dirname(candidate);
    await checkComponents(root, path.relative(root, parent).replaceAll('\\', '/'), label);
    if (options.createParent) {
        await fs.mkdir(parent, { recursive: true });
        await checkComponents(root, path.relative(root, parent).replaceAll('\\', '/'), label);
    }
    let stat;
    try {
        stat = await fs.lstat(candidate);
    }
    catch (error) {
        if (error?.code !== 'ENOENT')
            throw error;
        if (!options.allowMissing)
            throw new Error(`${label} 不存在：${relative}`);
    }
    if (stat) {
        if (stat.isSymbolicLink())
            throw new Error(`${label} 禁止使用符号链接：${relative}`);
        if (!stat.isFile())
            throw new Error(`${label} 必须是普通文件：${relative}`);
        const resolved = await fs.realpath(candidate);
        inside(root, resolved, label);
    }
    return candidate;
}
/** Ensure a destination is still a safe regular file immediately before read. */
export async function resolveRegularArtifact(workspace, reference, label = 'artifact') {
    return resolveArtifactPath(workspace, reference, { label });
}
/** Prepare an immutable destination; an existing file is left for the caller. */
export async function resolveArtifactForWrite(workspace, reference, label = 'artifact') {
    return resolveArtifactPath(workspace, reference, { allowMissing: true, createParent: true, label });
}
