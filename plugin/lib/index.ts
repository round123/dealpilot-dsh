// DealPilot DSH — Host plugin entry point
// Registers all 6 DealPilot tools, the DealPilot session APIs, and the
// route-scoped native DSH workbench.

import * as fs from 'node:fs/promises';
import { copyFileSync, mkdirSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSnapshot } from './snapshot.js';
import { resolveWorkspace } from './okf-utils.js';
import { ensureWorkspace, listWorkspaces, inspectWorkspace, workspacePathFromId, registerWorkspacePath } from './workspace-manager.js';
import { registerSnapshotTool } from './snapshot.js';
import { registerWriteTool } from './write-tool.js';
import { registerActionTool } from './action-tool.js';
import { registerImportTool } from './import-tool.js';
import { registerSearchTool } from './search-tool.js';
import { registerWhatsappTool } from './whatsapp-tool.js';
import { createToolHarness } from './tool-compat.js';
import {
  createDealPilotSession,
  getDealPilotSession,
  publicDealPilotSession,
  switchDealPilotWorkspace,
} from './dealpilot-session.js';

export const inject = ['tools'];

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function readDshFrontendIndex(req?: any): Promise<string> {
  if (req?.headers?.host) {
    try {
      const response = await fetch(`http://${req.headers.host}/`);
      if (response.ok) return await response.text();
    } catch {}
  }
  const candidates = [
    path.resolve(path.dirname(process.argv[1] || ''), '..', 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'index.html'),
    path.resolve(path.dirname(process.argv[1] || ''), '..', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'index.html'),
  ];
  for (const candidate of candidates) { try { return await fs.readFile(candidate, 'utf-8'); } catch {} }
  throw new Error('DSH web frontend index.html was not found');
}

function installDealPilotPreset(): void {
  const dshHome = process.env.DSH_HOME || path.join(process.env.HOME || process.env.USERPROFILE || '.', '.dsh');
  const source = path.resolve(__dirname, '..', 'agent-preset', 'dealpilot-sales');
  const target = path.join(dshHome, '.agent-presets', 'dealpilot-sales');
  try {
    mkdirSync(target, { recursive: true });
    for (const file of ['preset.yml', 'agent.cordis.yml']) {
      const destination = path.join(target, file);
      try { copyFileSync(path.join(source, file), destination); } catch { /* source may be absent in a dev-only host */ }
    }
  } catch (err) { console.warn('[dealpilot] preset installation skipped:', err); }
}

async function syncDshWorkspaceRegistry(req: any): Promise<any[]> {
  const host = req?.headers?.host;
  if (!host) return [];
  try {
    const response = await fetch(`http://${host}/api/workspace.list`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: `dealpilot-${Date.now()}`, method: 'workspace.list', payload: {} }),
    });
    if (!response.ok) return [];
    const envelope: any = await response.json();
    const items = envelope?.result?.value?.items;
    if (!Array.isArray(items)) return [];
    for (const item of items) registerWorkspacePath(String(item.workspaceId || ''), String(item.path || ''));
    return items;
  } catch { return []; }
}

export function apply(ctx: Record<string, any>) {
  installDealPilotPreset();
  // ── Register 6 business tools ────────────────────────────────────────────
  // Tools must receive a workspace from their DealPilot session context.
  const toolCtx = { config: { requireDealPilotSession: true } };
  const harness = createToolHarness(ctx, toolCtx);
  if (ctx.tools?.register) {
    registerSnapshotTool(toolCtx, harness);
    registerWriteTool(toolCtx, harness);
    registerActionTool(toolCtx, harness);
    registerImportTool(toolCtx, harness);
    registerSearchTool(toolCtx, harness);
    registerWhatsappTool(toolCtx, harness);
    console.log('[dealpilot] registered 6 business tools');
  } else {
    console.warn('[dealpilot] tools service not available — tools not registered');
  }

  // ── Register Dashboard HTTP routes ───────────────────────────────────────
  ctx.inject?.(['webServer'], (hostCtx: any) => {
    const { webServer } = hostCtx;

    const json = (res: any, status: number, value: any) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(value));
    };
    const body = async (req: any): Promise<any> => {
      if (req.method !== 'POST') return {};
      let raw = ''; for await (const chunk of req) raw += chunk;
      try { return raw ? JSON.parse(raw) : {}; } catch { throw new Error('Invalid JSON request body'); }
    };

    webServer.register({
      kind: 'exact', path: '/api/dealpilot/workspaces',
      handler: async (req: any, res: any) => { try {
        const hostItems = await syncDshWorkspaceRegistry(req);
        // DSH's registry is authoritative. The filesystem scan is only a
        // compatibility fallback for hosts that do not expose that service.
        const local = hostItems.length ? [] : await listWorkspaces();
        const known = new Set(local.map(item => item.id));
        const dsh = await Promise.all(hostItems.map(item => inspectWorkspace(String(item.workspaceId || ''), String(item.path || ''))));
        for (const item of dsh) if (!known.has(item.id)) local.push(item);
        json(res, 200, { workspaces: local });
      } catch (err: any) { json(res, 500, { error: err.message }); } },
    });
    webServer.register({
      kind: 'exact', path: '/api/dealpilot/workspaces/inspect',
      handler: async (req: any, res: any) => { try { const input = await body(req); await syncDshWorkspaceRegistry(req); const result = await inspectWorkspace(String(input.workspaceId || '')); json(res, result.status === 'invalid' ? 400 : 200, result); } catch (err: any) { json(res, 400, { error: err.message }); } },
    });
    webServer.register({
      kind: 'exact', path: '/api/dealpilot/workspaces/initialize',
      handler: async (req: any, res: any) => { try { const input = await body(req); await syncDshWorkspaceRegistry(req); const workspace = workspacePathFromId(String(input.workspaceId || '')); if (!workspace) return json(res, 400, { error: 'Invalid workspaceId' }); const state = await ensureWorkspace(workspace); json(res, 200, { ...state, path: undefined }); } catch (err: any) { json(res, 400, { error: err.message }); } },
    });

    webServer.register({
      kind: 'exact', path: '/api/dealpilot/session',
      handler: async (req: any, res: any) => {
        try {
          const input = await body(req);
          await syncDshWorkspaceRegistry(req);
          const session = await createDealPilotSession(String(input.workspaceId || ''), input.dshSessionId ? String(input.dshSessionId) : undefined);
          json(res, 200, publicDealPilotSession(session));
        } catch (err: any) { json(res, 400, { error: err.message }); }
      },
    });
    webServer.register({
      kind: 'prefix', path: '/api/dealpilot/session',
      handler: async (req: any, res: any) => {
        const parts = new URL(req.url || '/', 'http://dealpilot.local').pathname.split('/').filter(Boolean);
        const id = parts[parts.length - (parts[parts.length - 1] === 'workspace' ? 2 : 1)] || '';
        if (req.method === 'GET' && parts[parts.length - 1] !== 'workspace') {
          const session = getDealPilotSession(id);
          if (!session) return json(res, 404, { error: 'DealPilot session not found' });
          return json(res, 200, publicDealPilotSession(session));
        }
        if (req.method === 'POST' && parts[parts.length - 1] === 'workspace') {
          try {
            const input = await body(req);
            await syncDshWorkspaceRegistry(req);
            const session = await switchDealPilotWorkspace(id, String(input.workspaceId || ''), input.dshSessionId ? String(input.dshSessionId) : undefined);
            return json(res, 200, publicDealPilotSession(session));
          } catch (err: any) { return json(res, 400, { error: err.message }); }
        }
        json(res, 405, { error: 'Method not allowed' });
      },
    });

    // API: snapshot data for the DealPilot shell.
    webServer.register({
      kind: 'exact',
      path: '/api/dealpilot/snapshot',
      handler: async (req: any, res: any) => {
        try {
          const url = new URL(req.url || '/', 'http://dealpilot.local');
          const selected = workspacePathFromId(url.searchParams.get('workspaceId') || '');
          const ws = selected || resolveWorkspace(toolCtx.config);
          await ensureWorkspace(ws);
          const snapshot = await buildSnapshot(ws);
          json(res, 200, snapshot);
        } catch (err: any) {
          json(res, 500, { error: err.message });
        }
      },
    });

    // API: idempotently create/load the DealPilot workspace and first snapshot.
    webServer.register({
      kind: 'exact',
      path: '/api/dealpilot/bootstrap',
      handler: async (req: any, res: any) => {
        try {
          const url = new URL(req.url || '/', 'http://dealpilot.local');
          const selected = workspacePathFromId(url.searchParams.get('workspaceId') || '');
          const state = await ensureWorkspace(selected || resolveWorkspace(toolCtx.config));
          const snapshot = await buildSnapshot(state.path);
          json(res, 200, { workspace: state.metadata, created: state.created, snapshot });
        } catch (err: any) {
          json(res, 500, { error: err.message });
        }
      },
    });

    // Dashboard page
    webServer.register({
      kind: 'exact',
      path: '/dealpilot',
      handler: async (req: any, res: any) => {
        try {
          const html = await readDshFrontendIndex(req);
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(html);
        } catch {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<!doctype html><title>DealPilot</title><p>DealPilot shell is unavailable.</p>');
        }
      },
    });

    console.log('[dealpilot] Product routes registered: /dealpilot and workspace/snapshot APIs');
  });
}
