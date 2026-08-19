// DealPilot DSH — Host plugin entry point
// Registers all 6 DealPilot tools + standalone Dashboard page.
// This is a pure cordis plugin — no separate agent preset needed.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSnapshot } from './snapshot.js';
import { resolveWorkspace } from './okf-utils.js';
import { registerSnapshotTool } from './snapshot.js';
import { registerWriteTool } from './write-tool.js';
import { registerActionTool } from './action-tool.js';
import { registerImportTool } from './import-tool.js';
import { registerSearchTool } from './search-tool.js';
import { registerWhatsappTool } from './whatsapp-tool.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function apply(ctx: Record<string, any>) {
  // ── Register 6 business tools ────────────────────────────────────────────
  const harness = ctx.get?.('harness');
  if (harness) {
    registerSnapshotTool(ctx, harness);
    registerWriteTool(ctx, harness);
    registerActionTool(ctx, harness);
    registerImportTool(ctx, harness);
    registerSearchTool(ctx, harness);
    registerWhatsappTool(ctx, harness);
    console.log('[dealpilot] registered 6 business tools');
  } else {
    console.warn('[dealpilot] harness not available — tools not registered');
  }

  // ── Register Dashboard HTTP routes ───────────────────────────────────────
  ctx.inject?.(['webServer'], (hostCtx: any) => {
    const { webServer } = hostCtx;

    // API: snapshot data for Dashboard
    webServer.register({
      kind: 'exact',
      path: '/api/dealpilot/snapshot',
      handler: async (_req: any, res: any) => {
        try {
          const ws = resolveWorkspace(ctx.config);
          const snapshot = await buildSnapshot(ws);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(snapshot));
        } catch (err: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      },
    });

    // Dashboard page
    webServer.register({
      kind: 'exact',
      path: '/dealpilot',
      handler: async (_req: any, res: any) => {
        try {
          const htmlPath = path.join(__dirname, '..', 'client', 'dashboard.html');
          const html = await fs.readFile(htmlPath, 'utf-8');
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(html);
        } catch {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>DealPilot</title></head>
<body><h1>DealPilot Dashboard</h1><p>Dashboard HTML not found. Run <code>pnpm exec tsc</code> and ensure <code>client/dashboard.html</code> exists.</p></body></html>`);
        }
      },
    });

    console.log('[dealpilot] Dashboard routes registered: /dealpilot, /api/dealpilot/snapshot');
  });
}