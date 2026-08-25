import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shellPath = path.join(root, 'plugin', 'client', 'dealpilot-shell.html');
const expectedTools = [
  'dealpilot_snapshot',
  'dealpilot_write',
  'dealpilot_action_transition',
  'dealpilot_import',
  'dealpilot_search',
  'dealpilot_whatsapp',
];

const snapshot = {
  generated_at: '2026-08-25T00:00:00.000Z',
  workspace_name: 'A2A Fixture Workspace',
  summary: { customers: 1, active_deals: 1, today: 1, overdue: 0, risks: 0, confirmation: 0 },
  today: [],
  customers: [{
    ref: 'knowledge/customers/acme.md', title: 'Acme Corp', status: 'active',
    source_category: 'import', relationship_stage: 'qualified', icp_fit: 'high',
    priority: 'P1', contacts: [],
  }],
  deals: [{
    ref: 'knowledge/deals/acme.md', title: 'Acme Renewal', customer_name: 'Acme Corp',
    status: 'active', funnel_stage: 'proposal', priority: 'P1', risk_level: 'unknown',
    products: [], actions: [],
  }],
  funnel: [{ stage: 'proposal', count: 1 }],
  activity: [],
  warnings: [],
};

test('A2A tool contract registers all DealPilot tools', async () => {
  const { apply } = await import('../plugin/lib/index.js');
  const registered = [];
  apply({ tools: { register: (tool) => registered.push(tool) }, config: {} });
  assert.deepEqual(registered.map((tool) => tool.name), expectedTools);
  for (const tool of registered) {
    assert.equal(typeof tool.execute, 'function', `${tool.name} must expose execute()`);
    assert.ok(tool.parameters, `${tool.name} must expose parameters`);
    assert.ok(tool.output?.schema, `${tool.name} must expose an output schema`);
  }
});

test('Harness client leaves the native DSH surface clean', async () => {
  const clientBundle = await readFile(path.join(root, 'plugin', 'client', 'client.js'), 'utf8');
  assert.match(clientBundle, /__ModuleLoader__\.load/);
  assert.doesNotMatch(clientBundle, /sidebar\.footer\.action/);
  assert.doesNotMatch(clientBundle, /DealPilot Workspace/);
});

test('DealPilot client exposes the business workbench interaction contract', async () => {
  const clientBundle = await readFile(path.join(root, 'plugin', 'client', 'client.js'), 'utf8');
  for (const marker of [
    'data-board-search',
    'data-board-filter',
    'data-board-detail',
    'data-ask-agent',
    'data-action-update',
    'restoreSession',
    'MutationObserver',
    'body:not(.dealpilot-ready)',
    'attachDealPilotSidebar',
    'sidebar.workspaces',
    'dealpilot-native-workspaces-hidden',
    'data-cancel-workspace',
    'inspectVersion',
  ]) {
    assert.ok(clientBundle.includes(marker), `${marker} must remain in the DealPilot workbench`);
  }
});

test('A2A DealPilot shell reuses DSH conversation and renders business views', async () => {
  const { chromium } = await import(pathToFileURL(path.join(root, 'plugin', 'node_modules', 'playwright', 'index.mjs')).href);
  const html = await readFile(shellPath, 'utf8');
  const server = createServer((req, res) => {
    if (req.url === '/api/dealpilot/workspaces') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ workspaces: [{ id: 'dealpilot/fixture', name: 'A2A Fixture Workspace', status: 'reusable' }] }));
      return;
    }
    if (req.url === '/api/dealpilot/workspaces/inspect') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'dealpilot/fixture', name: 'A2A Fixture Workspace', status: 'reusable', hasDealPilotFiles: true }));
      return;
    }
    if (req.url?.startsWith('/api/dealpilot/snapshot')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(snapshot));
      return;
    }
    if (req.url === '/dealpilot') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>DeepSeek Harness</title><main>DSH default conversation</main>');
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(`http://127.0.0.1:${port}/dealpilot`);
    await page.locator('#workspace').selectOption('dealpilot/fixture');
    await assert.doesNotReject(() => page.getByText(/已检测到 DealPilot 数据/).waitFor({ state: 'visible' }));
    assert.match(await page.locator('#business-content').textContent(), /Acme Renewal/);
    assert.match(await page.locator('#dsh-conversation').contentFrame().locator('main').textContent(), /DSH default conversation/);

    await page.getByRole('button', { name: '客户' }).click();
    await assert.doesNotReject(() => page.getByText('Acme Corp').waitFor({ state: 'visible' }));
    assert.match(await page.locator('#business-content').textContent(), /Acme Corp/);

    const artifactDir = path.join(root, 'tests', 'artifacts');
    await mkdir(artifactDir, { recursive: true });
    await page.screenshot({ path: path.join(artifactDir, 'a2a-dealpilot-shell.png'), fullPage: true });
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
