// DealPilot DSH — Host plugin entry point
// Registers DealPilot capabilities, the DealPilot session APIs, and the
// route-scoped native DSH workbench.
import * as fs from 'node:fs/promises';
import { copyFileSync, mkdirSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSnapshot } from './snapshot.js';
import { ensureWorkspace, listWorkspaces, inspectWorkspace, workspacePathFromId, registerWorkspacePath, defaultWorkspacePath } from './workspace-manager.js';
import { registerSnapshotTool } from './snapshot.js';
import { registerWriteTool } from './write-tool.js';
import { registerActionTool } from './action-tool.js';
import { registerCanonicalImportTools } from './canonical-import.js';
import { registerAgentMemoryTools } from './agent-memory.js';
import { registerSearchTool } from './search-tool.js';
import { registerWhatsappTool } from './whatsapp-tool.js';
import { registerFeedbackTools } from './feedback-tool.js';
import { createToolHarness } from './tool-compat.js';
import { readGoalRuntime } from './goal-runtime.js';
import { normalizeRef, readYamlFrontmatter } from './okf-utils.js';
import { createDealPilotSession, getDealPilotSession, listDealPilotSessions, publicDealPilotSession, switchDealPilotWorkspace, } from './dealpilot-session.js';
import { apply as applyUniverOffice } from 'dsh-univer-office';
// DealPilot owns the file-capability dependency in its distributable package.
// The host must not require a separately installed top-level Univer bundle.
export const inject = ['tools'];
const __dirname = path.dirname(fileURLToPath(import.meta.url));
async function readDshFrontendIndex(req) {
    if (req?.headers?.host) {
        try {
            const response = await fetch(`http://${req.headers.host}/`);
            if (response.ok)
                return await response.text();
        }
        catch { }
    }
    const candidates = [
        path.resolve(path.dirname(process.argv[1] || ''), '..', 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'index.html'),
        path.resolve(path.dirname(process.argv[1] || ''), '..', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'index.html'),
    ];
    for (const candidate of candidates) {
        try {
            return await fs.readFile(candidate, 'utf-8');
        }
        catch { }
    }
    throw new Error('DSH web frontend index.html was not found');
}
function installDealPilotPreset() {
    const dshHome = process.env.DSH_HOME || path.join(process.env.HOME || process.env.USERPROFILE || '.', '.dsh');
    const source = path.resolve(__dirname, '..', 'agent-preset', 'dealpilot-sales');
    const target = path.join(dshHome, '.agent-presets', 'dealpilot-sales');
    try {
        mkdirSync(target, { recursive: true });
        for (const file of ['preset.yml', 'agent.cordis.yml']) {
            const destination = path.join(target, file);
            try {
                copyFileSync(path.join(source, file), destination);
            }
            catch { /* source may be absent in a dev-only host */ }
        }
    }
    catch (err) {
        console.warn('[dealpilot] preset installation skipped:', err);
    }
}
async function syncDshWorkspaceRegistry(req) {
    const host = req?.headers?.host;
    if (!host)
        return [];
    try {
        const response = await fetch(`http://${host}/api/workspace.list`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ type: 'client-request', rpcId: `dealpilot-${Date.now()}`, method: 'workspace.list', payload: {} }),
        });
        if (!response.ok)
            return [];
        const envelope = await response.json();
        const items = envelope?.result?.value?.items;
        if (!Array.isArray(items))
            return [];
        for (const item of items)
            registerWorkspacePath(String(item.workspaceId || ''), String(item.path || ''));
        return items;
    }
    catch {
        return [];
    }
}
/** Create a native DSH session without registering a new global Workspace. */
async function createDshSession(req, workspacePath) {
    const host = req?.headers?.host;
    if (!host)
        throw new Error('DSH session service is unavailable');
    const response = await fetch(`http://${host}/api/session.create`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            type: 'client-request',
            rpcId: `dealpilot-session-create-${Date.now()}`,
            method: 'session.create',
            payload: { cwd: workspacePath, agentPreset: 'dealpilot-sales' },
        }),
    });
    if (!response.ok)
        throw new Error(`DSH session create failed (HTTP ${response.status})`);
    const envelope = await response.json();
    if (!envelope?.result?.ok)
        throw new Error(envelope?.result?.error?.message || 'DSH session create failed');
    const value = envelope.result.value;
    if (!value?.sessionId)
        throw new Error('DSH did not return a session id');
    return { sessionId: String(value.sessionId), agentPreset: value.agentPreset };
}
export function apply(ctx) {
    installDealPilotPreset();
    const existingUniver = ctx.reflect?.get?.('univer', false);
    if (!existingUniver && typeof ctx.plugin === 'function') {
        try {
            ctx.plugin(applyUniverOffice);
        }
        catch (error) {
            console.warn('[dealpilot] Univer provider activation deferred:', error);
        }
    }
    // ── Register business capabilities ───────────────────────────────────────
    // Tools must receive a workspace from their DealPilot session context.
    const toolCtx = { config: { requireDealPilotSession: true } };
    const harness = createToolHarness(ctx, toolCtx);
    if (ctx.tools?.register) {
        registerSnapshotTool(toolCtx, harness);
        registerWriteTool(toolCtx, harness);
        registerActionTool(toolCtx, harness);
        registerSearchTool(toolCtx, harness);
        registerWhatsappTool(toolCtx, harness);
        let canonicalRegistered = false;
        const registerCanonical = (serviceCtx) => {
            if (canonicalRegistered)
                return;
            canonicalRegistered = true;
            registerCanonicalImportTools(toolCtx, harness, serviceCtx?.univer || ctx.reflect?.get?.('univer', false));
        };
        if (ctx.reflect?.get?.('univer', false))
            registerCanonical(ctx);
        else if (typeof ctx.inject === 'function')
            ctx.inject(['univer'], registerCanonical);
        else
            registerCanonical(ctx);
        registerAgentMemoryTools(toolCtx, harness);
        registerFeedbackTools(toolCtx, harness);
        console.log('[dealpilot] registered DealPilot Agent-Native capabilities');
    }
    else {
        console.warn('[dealpilot] tools service not available — tools not registered');
    }
    // ── Register Dashboard HTTP routes ───────────────────────────────────────
    ctx.inject?.(['webServer'], (hostCtx) => {
        const rawWebServer = hostCtx.webServer;
        // Route registration is an external resource. Keep every disposer on the
        // plugin fiber so injector hot reloads cannot leave duplicate routes.
        const routeDisposers = [];
        const webServer = {
            register(route) {
                const dispose = rawWebServer.register(route);
                if (typeof dispose === 'function')
                    routeDisposers.push(dispose);
                return dispose;
            },
        };
        ctx.effect?.(() => () => {
            for (const dispose of routeDisposers.splice(0).reverse()) {
                try {
                    dispose();
                }
                catch { /* route may already be gone */ }
            }
        }, 'dealpilot dashboard routes');
        const json = (res, status, value) => {
            res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(value));
        };
        const body = async (req) => {
            if (req.method !== 'POST')
                return {};
            let raw = '';
            for await (const chunk of req)
                raw += chunk;
            try {
                return raw ? JSON.parse(raw) : {};
            }
            catch {
                throw new Error('Invalid JSON request body');
            }
        };
        const rawBody = async (req, max = 20 * 1024 * 1024) => {
            const chunks = [];
            let size = 0;
            for await (const chunk of req) {
                const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                size += part.length;
                if (size > max)
                    throw new Error('文件超过 20 MB 大小限制');
                chunks.push(part);
            }
            return Buffer.concat(chunks);
        };
        const multipart = (contentType, bytes) => {
            const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
            if (!match)
                throw new Error('multipart 请求缺少 boundary');
            const boundary = Buffer.from(`--${match[1] || match[2]}`);
            const start = bytes.indexOf(boundary);
            if (start < 0)
                throw new Error('multipart 文件字段不存在');
            const headerStart = start + boundary.length + 2;
            const headerEnd = bytes.indexOf(Buffer.from('\r\n\r\n'), headerStart);
            if (headerEnd < 0)
                throw new Error('multipart 头部无效');
            const headers = bytes.slice(headerStart, headerEnd).toString('utf8');
            const disposition = /name="([^"]+)"(?:;\s*filename="([^"]+)")?/i.exec(headers);
            if (!disposition?.[2])
                throw new Error('multipart 需要 filename');
            const dataStart = headerEnd + 4;
            const dataEnd = bytes.indexOf(Buffer.from('\r\n'), dataStart);
            const endBoundary = bytes.indexOf(boundary, dataStart);
            const end = endBoundary > 0 ? endBoundary - 2 : bytes.length;
            const type = /content-type:\s*([^\r\n]+)/i.exec(headers)?.[1] || 'application/octet-stream';
            return { name: disposition[2], mediaType: type.trim(), data: bytes.slice(dataStart, end) };
        };
        webServer.register({
            kind: 'exact', path: '/api/dealpilot/import/source',
            handler: async (req, res) => {
                try {
                    await syncDshWorkspaceRegistry(req);
                    const url = new URL(req.url || '/', 'http://dealpilot.local');
                    const workspace = workspacePathFromId(url.searchParams.get('workspaceId') || '');
                    if (!workspace)
                        return json(res, 400, { error: 'Invalid workspaceId' });
                    if (req.method !== 'POST')
                        return json(res, 405, { error: 'Method not allowed' });
                    const encodedName = String(req.headers?.['x-file-name'] || 'upload.bin');
                    let originalName = encodedName;
                    try {
                        originalName = decodeURIComponent(encodedName);
                    }
                    catch { /* retain the encoded fallback */ }
                    const name = originalName.replace(/[^a-zA-Z0-9._-]/g, '_');
                    const relative = `sources/imports/uploads/${Date.now()}-${name}`;
                    const target = path.join(workspace, relative);
                    await fs.mkdir(path.dirname(target), { recursive: true });
                    await fs.writeFile(target, await rawBody(req));
                    return json(res, 201, { source: { kind: 'workspace_file', path: relative }, originalName: name });
                }
                catch (err) {
                    json(res, 400, { error: err.message });
                }
            },
        });
        webServer.register({
            kind: 'exact', path: '/api/dealpilot/workspaces',
            handler: async (req, res) => {
                try {
                    const hostItems = await syncDshWorkspaceRegistry(req);
                    // DSH's registry is authoritative. The filesystem scan is only a
                    // compatibility fallback for hosts that do not expose that service.
                    const local = hostItems.length ? [] : await listWorkspaces();
                    const known = new Set(local.map(item => item.id));
                    const dsh = await Promise.all(hostItems.map(item => inspectWorkspace(String(item.workspaceId || ''), String(item.path || ''))));
                    for (const item of dsh)
                        if (!known.has(item.id))
                            local.push(item);
                    json(res, 200, { workspaces: local });
                }
                catch (err) {
                    json(res, 500, { error: err.message });
                }
            },
        });
        webServer.register({
            kind: 'exact', path: '/api/dealpilot/workspaces/inspect',
            handler: async (req, res) => { try {
                const input = await body(req);
                await syncDshWorkspaceRegistry(req);
                const result = await inspectWorkspace(String(input.workspaceId || ''));
                json(res, result.status === 'invalid' ? 400 : 200, result);
            }
            catch (err) {
                json(res, 400, { error: err.message });
            } },
        });
        webServer.register({
            kind: 'exact', path: '/api/dealpilot/memory',
            handler: async (req, res) => {
                try {
                    if (req.method !== 'GET')
                        return json(res, 405, { error: 'Method not allowed' });
                    await syncDshWorkspaceRegistry(req);
                    const url = new URL(req.url || '/', 'http://dealpilot.local');
                    const workspace = workspacePathFromId(url.searchParams.get('workspaceId') || '');
                    if (!workspace)
                        return json(res, 400, { error: 'Invalid workspaceId' });
                    const requested = String(url.searchParams.get('ref') || '');
                    if (!requested.startsWith('knowledge/') || !requested.endsWith('.md'))
                        return json(res, 400, { error: 'Invalid memory ref' });
                    const ref = normalizeRef(workspace, 'knowledge/index.md', requested);
                    const document = await readYamlFrontmatter(path.join(workspace, ref));
                    json(res, 200, { ref, metadata: document.meta, content: document.body });
                }
                catch (err) {
                    json(res, 400, { error: err.message });
                }
            },
        });
        webServer.register({
            kind: 'exact', path: '/api/dealpilot/workspaces/initialize',
            handler: async (req, res) => {
                try {
                    const input = await body(req);
                    await syncDshWorkspaceRegistry(req);
                    const workspace = workspacePathFromId(String(input.workspaceId || ''));
                    if (!workspace)
                        return json(res, 400, { error: 'Invalid workspaceId' });
                    const state = await ensureWorkspace(workspace);
                    json(res, 200, {
                        ...state,
                        path: undefined,
                        workspaceId: input.workspaceId,
                        workspaceName: state.metadata.name,
                    });
                }
                catch (err) {
                    json(res, 400, { error: err.message });
                }
            },
        });
        webServer.register({
            kind: 'exact', path: '/api/dealpilot/workspaces/archive',
            handler: async (req, res) => {
                try {
                    const input = await body(req);
                    await syncDshWorkspaceRegistry(req);
                    const workspace = workspacePathFromId(String(input.workspaceId || ''));
                    if (!workspace)
                        return json(res, 400, { error: 'Invalid workspaceId' });
                    const metadataPath = path.join(workspace, '.dsh', 'workspace.json');
                    const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
                    metadata.setup_status = 'archived';
                    metadata.archived_at = new Date().toISOString();
                    await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2) + '\n', 'utf8');
                    json(res, 200, { id: input.workspaceId, status: 'archived' });
                }
                catch (err) {
                    json(res, 400, { error: err.message });
                }
            },
        });
        webServer.register({
            kind: 'exact', path: '/api/dealpilot/session',
            handler: async (req, res) => {
                try {
                    const input = await body(req);
                    await syncDshWorkspaceRegistry(req);
                    const session = await createDealPilotSession(String(input.workspaceId || ''), input.dshSessionId ? String(input.dshSessionId) : undefined);
                    json(res, 200, publicDealPilotSession(session));
                }
                catch (err) {
                    json(res, 400, { error: err.message });
                }
            },
        });
        webServer.register({
            kind: 'exact', path: '/api/dealpilot/native-session',
            handler: async (req, res) => {
                try {
                    const input = await body(req);
                    await syncDshWorkspaceRegistry(req);
                    const workspaceId = String(input.workspaceId || '');
                    const workspace = workspacePathFromId(workspaceId);
                    if (!workspace)
                        return json(res, 400, { error: 'Invalid workspaceId' });
                    const inspection = await inspectWorkspace(workspaceId, workspace);
                    if (inspection.status === 'new')
                        return json(res, 409, { error: '请先初始化 DealPilot Workspace' });
                    if (inspection.status === 'archived')
                        return json(res, 409, { error: 'Workspace 已归档，不能创建 DealPilot 对话' });
                    const session = await createDshSession(req, workspace);
                    json(res, 200, { workspaceId, ...session });
                }
                catch (err) {
                    json(res, 400, { error: err.message });
                }
            },
        });
        webServer.register({
            kind: 'exact', path: '/api/dealpilot/sessions',
            handler: async (req, res) => {
                try {
                    const url = new URL(req.url || '/', 'http://dealpilot.local');
                    const workspaceId = url.searchParams.get('workspaceId') || undefined;
                    const sessions = listDealPilotSessions(workspaceId).map(publicDealPilotSession);
                    json(res, 200, { sessions });
                }
                catch (err) {
                    json(res, 400, { error: err.message });
                }
            },
        });
        webServer.register({
            kind: 'prefix', path: '/api/dealpilot/session',
            handler: async (req, res) => {
                const parts = new URL(req.url || '/', 'http://dealpilot.local').pathname.split('/').filter(Boolean);
                const id = parts[parts.length - (parts[parts.length - 1] === 'workspace' ? 2 : 1)] || '';
                if (req.method === 'GET' && parts[parts.length - 1] !== 'workspace') {
                    const session = getDealPilotSession(id);
                    if (!session)
                        return json(res, 404, { error: 'DealPilot session not found' });
                    return json(res, 200, publicDealPilotSession(session));
                }
                if (req.method === 'POST' && parts[parts.length - 1] === 'workspace') {
                    try {
                        const input = await body(req);
                        await syncDshWorkspaceRegistry(req);
                        const session = await switchDealPilotWorkspace(id, String(input.workspaceId || ''), input.dshSessionId ? String(input.dshSessionId) : undefined);
                        return json(res, 200, publicDealPilotSession(session));
                    }
                    catch (err) {
                        return json(res, 400, { error: err.message });
                    }
                }
                json(res, 405, { error: 'Method not allowed' });
            },
        });
        // API: snapshot data for the DealPilot shell.
        webServer.register({
            kind: 'exact',
            path: '/api/dealpilot/snapshot',
            handler: async (req, res) => {
                try {
                    const url = new URL(req.url || '/', 'http://dealpilot.local');
                    await syncDshWorkspaceRegistry(req);
                    const selected = workspacePathFromId(url.searchParams.get('workspaceId') || '');
                    const ws = selected || defaultWorkspacePath();
                    await ensureWorkspace(ws);
                    const snapshot = await buildSnapshot(ws);
                    json(res, 200, snapshot);
                }
                catch (err) {
                    json(res, 500, { error: err.message });
                }
            },
        });
        const readWorkspaceSnapshot = async (req) => {
            const url = new URL(req.url || '/', 'http://dealpilot.local');
            await syncDshWorkspaceRegistry(req);
            const workspaceId = url.searchParams.get('workspaceId') || '';
            const selected = workspacePathFromId(workspaceId);
            if (!selected)
                throw new Error('Invalid workspaceId');
            return buildSnapshot(selected);
        };
        const collectionRoutes = [
            ['/api/dealpilot/customers', (snapshot) => snapshot.customers],
            ['/api/dealpilot/deals', (snapshot) => snapshot.deals],
            ['/api/dealpilot/actions', (snapshot) => snapshot.deals.flatMap((deal) => (deal.actions || []).map((action) => ({ ...action, deal_title: deal.title, customer_name: deal.customer_name })))],
            ['/api/dealpilot/events', (snapshot) => snapshot.activity],
            ['/api/dealpilot/weekly-review', (snapshot) => snapshot.operations.weekly_review],
            ['/api/dealpilot/risk', (snapshot) => snapshot.operations.risk_deals],
            ['/api/dealpilot/stalled', (snapshot) => snapshot.operations.stalled_deals],
        ];
        for (const [route, project] of collectionRoutes) {
            webServer.register({
                kind: 'exact', path: route,
                handler: async (req, res) => {
                    try {
                        json(res, 200, { data: project(await readWorkspaceSnapshot(req)) });
                    }
                    catch (err) {
                        json(res, 400, { error: err.message });
                    }
                },
            });
        }
        webServer.register({
            kind: 'exact', path: '/api/dealpilot/export',
            handler: async (req, res) => {
                try {
                    const snapshot = await readWorkspaceSnapshot(req);
                    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="dealpilot-export.json"' });
                    res.end(JSON.stringify(snapshot, null, 2));
                }
                catch (err) {
                    json(res, 400, { error: err.message });
                }
            },
        });
        // API: idempotently create/load the DealPilot workspace and first snapshot.
        webServer.register({
            kind: 'exact',
            path: '/api/dealpilot/bootstrap',
            handler: async (req, res) => {
                try {
                    const url = new URL(req.url || '/', 'http://dealpilot.local');
                    const selected = workspacePathFromId(url.searchParams.get('workspaceId') || '');
                    const state = await ensureWorkspace(selected || defaultWorkspacePath());
                    const snapshot = await buildSnapshot(state.path);
                    json(res, 200, { workspace: state.metadata, created: state.created, snapshot });
                }
                catch (err) {
                    json(res, 500, { error: err.message });
                }
            },
        });
        webServer.register({
            kind: 'exact',
            path: '/api/dealpilot/runtime',
            handler: async (req, res) => {
                try {
                    const url = new URL(req.url || '/', 'http://dealpilot.local');
                    await syncDshWorkspaceRegistry(req);
                    const selected = workspacePathFromId(url.searchParams.get('workspaceId') || '');
                    if (!selected)
                        return json(res, 400, { error: 'Invalid workspaceId' });
                    return json(res, 200, await readGoalRuntime(selected));
                }
                catch (err) {
                    return json(res, 500, { error: err.message });
                }
            },
        });
        // Dashboard page
        webServer.register({
            kind: 'exact',
            path: '/dealpilot',
            handler: async (req, res) => {
                try {
                    const html = await readDshFrontendIndex(req);
                    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                    res.end(html);
                }
                catch {
                    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                    res.end('<!doctype html><title>DealPilot</title><p>DealPilot shell is unavailable.</p>');
                }
            },
        });
        console.log('[dealpilot] Product routes registered: /dealpilot and workspace/snapshot APIs');
    });
}
