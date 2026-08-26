// DealPilot DSH — Host plugin entry point
// Registers all 6 DealPilot tools, the DealPilot session APIs, and the
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
import { registerImportTool } from './import-tool.js';
import { previewImport } from './import-tool.js';
import { registerSearchTool } from './search-tool.js';
import { registerWhatsappTool } from './whatsapp-tool.js';
import { createToolHarness } from './tool-compat.js';
import { readGoalRuntime } from './goal-runtime.js';
import {
  createDealPilotSession,
  getDealPilotSession,
  listDealPilotSessions,
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

/** Create a native DSH session without registering a new global Workspace. */
async function createDshSession(req: any, workspacePath: string): Promise<{ sessionId: string; agentPreset?: string }> {
  const host = req?.headers?.host;
  if (!host) throw new Error('DSH session service is unavailable');
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
  if (!response.ok) throw new Error(`DSH session create failed (HTTP ${response.status})`);
  const envelope: any = await response.json();
  if (!envelope?.result?.ok) throw new Error(envelope?.result?.error?.message || 'DSH session create failed');
  const value = envelope.result.value;
  if (!value?.sessionId) throw new Error('DSH did not return a session id');
  return { sessionId: String(value.sessionId), agentPreset: value.agentPreset };
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
      handler: async (req: any, res: any) => { try {
        const input = await body(req);
        await syncDshWorkspaceRegistry(req);
        const workspace = workspacePathFromId(String(input.workspaceId || ''));
        if (!workspace) return json(res, 400, { error: 'Invalid workspaceId' });
        const state = await ensureWorkspace(workspace);
        json(res, 200, {
          ...state,
          path: undefined,
          workspaceId: input.workspaceId,
          workspaceName: state.metadata.name,
        });
      } catch (err: any) { json(res, 400, { error: err.message }); } },
    });
    webServer.register({
      kind: 'exact', path: '/api/dealpilot/workspaces/archive',
      handler: async (req: any, res: any) => {
        try {
          const input = await body(req);
          await syncDshWorkspaceRegistry(req);
          const workspace = workspacePathFromId(String(input.workspaceId || ''));
          if (!workspace) return json(res, 400, { error: 'Invalid workspaceId' });
          const metadataPath = path.join(workspace, '.dsh', 'workspace.json');
          const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
          metadata.setup_status = 'archived';
          metadata.archived_at = new Date().toISOString();
          await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2) + '\n', 'utf8');
          json(res, 200, { id: input.workspaceId, status: 'archived' });
        } catch (err: any) { json(res, 400, { error: err.message }); }
      },
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
      kind: 'exact', path: '/api/dealpilot/native-session',
      handler: async (req: any, res: any) => {
        try {
          const input = await body(req);
          await syncDshWorkspaceRegistry(req);
          const workspaceId = String(input.workspaceId || '');
          const workspace = workspacePathFromId(workspaceId);
          if (!workspace) return json(res, 400, { error: 'Invalid workspaceId' });
          const inspection = await inspectWorkspace(workspaceId, workspace);
          if (inspection.status === 'new') return json(res, 409, { error: '请先初始化 DealPilot Workspace' });
          if (inspection.status === 'archived') return json(res, 409, { error: 'Workspace 已归档，不能创建 DealPilot 对话' });
          const session = await createDshSession(req, workspace);
          json(res, 200, { workspaceId, ...session });
        } catch (err: any) { json(res, 400, { error: err.message }); }
      },
    });
    webServer.register({
      kind: 'exact', path: '/api/dealpilot/sessions',
      handler: async (req: any, res: any) => {
        try {
          const url = new URL(req.url || '/', 'http://dealpilot.local');
          const workspaceId = url.searchParams.get('workspaceId') || undefined;
          const sessions = listDealPilotSessions(workspaceId).map(publicDealPilotSession);
          json(res, 200, { sessions });
        } catch (err: any) { json(res, 400, { error: err.message }); }
      },
    });
    webServer.register({
      kind: 'exact', path: '/api/dealpilot/import/preview',
      handler: async (req: any, res: any) => {
        try {
          const input = await body(req);
          await syncDshWorkspaceRegistry(req);
          const workspace = workspacePathFromId(String(input.workspaceId || ''));
          if (!workspace) return json(res, 400, { error: 'Invalid workspaceId' });
          const data = typeof input.data === 'string' ? input.data : '';
          const format = ['csv', 'markdown', 'text'].includes(input.format) ? input.format : 'text';
          json(res, 200, await previewImport(workspace, data, format, input.autoDedup !== false));
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
          await syncDshWorkspaceRegistry(req);
          const selected = workspacePathFromId(url.searchParams.get('workspaceId') || '');
          const ws = selected || defaultWorkspacePath();
          await ensureWorkspace(ws);
          const snapshot = await buildSnapshot(ws);
          json(res, 200, snapshot);
        } catch (err: any) {
          json(res, 500, { error: err.message });
        }
      },
    });

    const readWorkspaceSnapshot = async (req: any) => {
      const url = new URL(req.url || '/', 'http://dealpilot.local');
      await syncDshWorkspaceRegistry(req);
      const workspaceId = url.searchParams.get('workspaceId') || '';
      const selected = workspacePathFromId(workspaceId);
      if (!selected) throw new Error('Invalid workspaceId');
      return buildSnapshot(selected);
    };
    const collectionRoutes: Array<[string, (snapshot: any) => any]> = [
      ['/api/dealpilot/customers', (snapshot) => snapshot.customers],
      ['/api/dealpilot/deals', (snapshot) => snapshot.deals],
      ['/api/dealpilot/actions', (snapshot) => snapshot.deals.flatMap((deal: any) => (deal.actions || []).map((action: any) => ({ ...action, deal_title: deal.title, customer_name: deal.customer_name })))],
      ['/api/dealpilot/events', (snapshot) => snapshot.activity],
      ['/api/dealpilot/weekly-review', (snapshot) => snapshot.operations.weekly_review],
      ['/api/dealpilot/risk', (snapshot) => snapshot.operations.risk_deals],
      ['/api/dealpilot/stalled', (snapshot) => snapshot.operations.stalled_deals],
    ];
    for (const [route, project] of collectionRoutes) {
      webServer.register({
        kind: 'exact', path: route,
        handler: async (req: any, res: any) => {
          try { json(res, 200, { data: project(await readWorkspaceSnapshot(req)) }); }
          catch (err: any) { json(res, 400, { error: err.message }); }
        },
      });
    }
    webServer.register({
      kind: 'exact', path: '/api/dealpilot/export',
      handler: async (req: any, res: any) => {
        try {
          const snapshot = await readWorkspaceSnapshot(req);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="dealpilot-export.json"' });
          res.end(JSON.stringify(snapshot, null, 2));
        } catch (err: any) { json(res, 400, { error: err.message }); }
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
          const state = await ensureWorkspace(selected || defaultWorkspacePath());
          const snapshot = await buildSnapshot(state.path);
          json(res, 200, { workspace: state.metadata, created: state.created, snapshot });
        } catch (err: any) {
          json(res, 500, { error: err.message });
        }
      },
    });

    webServer.register({
      kind: 'exact',
      path: '/api/dealpilot/runtime',
      handler: async (req: any, res: any) => {
        try {
          const url = new URL(req.url || '/', 'http://dealpilot.local');
          await syncDshWorkspaceRegistry(req);
          const selected = workspacePathFromId(url.searchParams.get('workspaceId') || '');
          if (!selected) return json(res, 400, { error: 'Invalid workspaceId' });
          return json(res, 200, await readGoalRuntime(selected));
        } catch (err: any) {
          return json(res, 500, { error: err.message });
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
