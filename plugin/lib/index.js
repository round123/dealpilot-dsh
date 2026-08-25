// DealPilot DSH — Host plugin entry point
// Registers all 6 DealPilot tools + standalone Dashboard page.
// This is a pure cordis plugin — no separate agent preset needed.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSnapshot } from './snapshot.js';
import { resolveWorkspace } from './okf-utils.js';
import { ensureWorkspace, listWorkspaces, inspectWorkspace, workspacePathFromId } from './workspace-manager.js';
import { registerSnapshotTool } from './snapshot.js';
import { registerWriteTool } from './write-tool.js';
import { registerActionTool } from './action-tool.js';
import { registerImportTool } from './import-tool.js';
import { registerSearchTool } from './search-tool.js';
import { registerWhatsappTool } from './whatsapp-tool.js';
import { createToolHarness } from './tool-compat.js';
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
        try { return await fs.readFile(candidate, 'utf-8'); }
        catch { }
    }
    throw new Error('DSH web frontend index.html was not found');
}
export function apply(ctx) {
    // ── Register 6 business tools ────────────────────────────────────────────
    // DSH's guarded Cordis context does not expose a generic `config` service.
    // The business tools resolve their workspace from process.cwd() by default.
    const toolCtx = { config: {} };
    const harness = createToolHarness(ctx, toolCtx);
    if (ctx.tools?.register) {
        registerSnapshotTool(toolCtx, harness);
        registerWriteTool(toolCtx, harness);
        registerActionTool(toolCtx, harness);
        registerImportTool(toolCtx, harness);
        registerSearchTool(toolCtx, harness);
        registerWhatsappTool(toolCtx, harness);
        console.log('[dealpilot] registered 6 business tools');
    }
    else {
        console.warn('[dealpilot] tools service not available — tools not registered');
    }
    // ── Register Dashboard HTTP routes ───────────────────────────────────────
    ctx.inject?.(['webServer'], (hostCtx) => {
        const { webServer } = hostCtx;
        const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
        const body = async (req) => { if (req.method !== 'POST') return {}; let raw = ''; for await (const chunk of req) raw += chunk; try { return raw ? JSON.parse(raw) : {}; } catch { throw new Error('Invalid JSON request body'); } };
        webServer.register({ kind: 'exact', path: '/api/dealpilot/workspaces', handler: async (_req, res) => { try { json(res, 200, { workspaces: await listWorkspaces() }); } catch (err) { json(res, 500, { error: err.message }); } } });
        webServer.register({ kind: 'exact', path: '/api/dealpilot/workspaces/inspect', handler: async (req, res) => { try { const input = await body(req); const result = await inspectWorkspace(String(input.workspaceId || '')); json(res, result.status === 'invalid' ? 400 : 200, result); } catch (err) { json(res, 400, { error: err.message }); } } });
        webServer.register({ kind: 'exact', path: '/api/dealpilot/workspaces/initialize', handler: async (req, res) => { try { const input = await body(req); const workspace = workspacePathFromId(String(input.workspaceId || '')); if (!workspace) return json(res, 400, { error: 'Invalid workspaceId' }); const state = await ensureWorkspace(workspace); json(res, 200, { metadata: state.metadata, created: state.created }); } catch (err) { json(res, 400, { error: err.message }); } } });
        webServer.register({
            kind: 'exact',
            path: '/api/dealpilot/snapshot',
            handler: async (req, res) => {
                try {
                const url = new URL(req.url || '/', 'http://dealpilot.local');
                const ws = workspacePathFromId(url.searchParams.get('workspaceId') || '') || resolveWorkspace(toolCtx.config);
                await ensureWorkspace(ws);
                const snapshot = await buildSnapshot(ws);
                    json(res, 200, snapshot);
                }
                catch (err) {
                    json(res, 500, { error: err.message });
                }
            },
        });
        webServer.register({
            kind: 'exact',
            path: '/api/dealpilot/bootstrap',
            handler: async (req, res) => {
                try {
                    const url = new URL(req.url || '/', 'http://dealpilot.local');
                    const state = await ensureWorkspace(workspacePathFromId(url.searchParams.get('workspaceId') || '') || resolveWorkspace(toolCtx.config));
                    const snapshot = await buildSnapshot(state.path);
                    json(res, 200, { workspace: state.metadata, created: state.created, snapshot });
                }
                catch (err) {
                    json(res, 500, { error: err.message });
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
