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
  summary: { customers: 1, active_deals: 1, today: 1, overdue: 1, risks: 0, confirmation: 0 },
  today: [{
    title: 'Send revised proposal', customer_name: 'Acme Corp', deal_title: 'Acme Renewal',
    bucket: 'overdue', due_at: '2026-08-24', priority: 'P1', reason: 'Proposal needs revision',
  }],
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
  activity: [{ occurred_at: '2026-08-25T09:30:00.000Z', event_type: 'deal.updated', channel: 'conversation', deal_ref: 'knowledge/deals/acme.md' }],
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
  // The bundle declares the injected services as a multiline `const inject`
  // array before registering with the DSH loader.
  assert.match(clientBundle, /const inject = \[\s*['"]slots['"],[\s\S]*['"]sessions['"],[\s\S]*['"]workspaces['"],[\s\S]*['"]connection['"],?\s*\]/);
  assert.match(clientBundle, /agentPresets\?\.select/);
  assert.doesNotMatch(clientBundle, /sidebar\.footer\.action/);
  assert.doesNotMatch(clientBundle, /DealPilot Workspace/);
  assert.doesNotMatch(clientBundle, /getSessions\(\)\?\.clear/);
});

test('DealPilot compatibility APIs use the owned default workspace only', async () => {
  const hostBundle = await readFile(path.join(root, 'plugin', 'lib', 'index.js'), 'utf8');
  assert.match(hostBundle, /defaultWorkspacePath\(\)/);
  assert.doesNotMatch(hostBundle, /resolveWorkspace\(toolCtx\.config\)/);
});

test('DealPilot client exposes the business workbench interaction contract', async () => {
  const clientBundle = await readFile(path.join(root, 'plugin', 'client', 'client.js'), 'utf8');
  for (const marker of [
    'data-board-search',
    'data-board-filter',
    'data-board-sort',
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
    'dealpilot-context',
    'dealpilot-workbench',
    '打开完整工作台',
    '周复盘',
    '高风险交易',
    '停滞交易',
    '交易生命周期',
    '行动生命周期',
    '导入中心',
    '工作区设置',
    'refreshSessionHistory',
    '/api/dealpilot/import/preview',
  ]) {
    assert.ok(clientBundle.includes(marker), `${marker} must remain in the DealPilot workbench`);
  }
});

test('route client mounts the persistent business context and full workbench in native DSH', async () => {
  const { chromium } = await import(pathToFileURL(path.join(root, 'plugin', 'node_modules', 'playwright', 'index.mjs')).href);
  const clientBundle = await readFile(path.join(root, 'plugin', 'client', 'client.js'), 'utf8');
  const pageHtml = `<!doctype html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box}html,body{height:100%;margin:0}.host{height:100%;display:grid;grid-template-columns:220px 1fr}
    [data-pane="sidebar"]{position:relative;border-right:1px solid #ddd;background:#f8f9fa;padding:10px;overflow:hidden}
    [data-slot="sidebar.workspaces"]{height:80px}.sidebar-region{height:calc(100% - 40px)}
    [data-pane="conversation"]{position:relative;min-width:0;background:#fff}.conversation-main{height:100%;display:grid;place-items:center}
    textarea{width:460px;height:90px}.native-newSession{height:30px}.native-workspace{height:30px}
  </style></head><body><div class="host">
    <aside data-pane="sidebar"><button class="native-newSession">New session</button><div class="sidebar-region"><div data-slot="sidebar.workspaces"><button class="native-workspace">Workspace</button></div></div></aside>
    <main data-pane="conversation"><div class="conversation-main"><textarea placeholder="描述你想要构建的内容"></textarea></div></main>
  </div><script>
    const nativeSessions={async create({workspaceId}){window.__nativeCreateWorkspaceId=workspaceId;return {ok:true,value:{sessionId:'native-fixture-session',agentPreset:'dealpilot-sales'}}},async refresh(){},open(id){window.__nativeSessionId=id},list:{getSnapshot(){return {byId:{'native-fixture-session':{sessionId:'native-fixture-session'}}}}}};
    const connection={api:{agentPresets:{async select({sessionId,agentPreset}){window.__nativePresetRequest={sessionId,agentPreset};return {result:{ok:true,value:{agentPreset}}}}}}};
    window.__ModuleLoader__={load(value){const plugin=value.factory(()=>{});window.__clientApply=plugin.apply;window.__clientInject=plugin.inject}};
  </script>
  <script>${clientBundle.replaceAll('</script>', '<\\/script>')}</script><script>window.__clientApply({sessions:nativeSessions,connection,get(name){return name==='sessions'?nativeSessions:name==='connection'?connection:undefined}})</script></body></html>`;
  const server = createServer((req, res) => {
    if (req.url === '/dealpilot') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(pageHtml); return;
    }
    if (req.url === '/api/dealpilot/workspaces') {
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ workspaces: [{ id: 'dealpilot/fixture', name: 'A2A Fixture Workspace' }] })); return;
    }
    if (req.url === '/api/dealpilot/workspaces/inspect') {
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: 'dealpilot/fixture', name: 'A2A Fixture Workspace', status: 'reusable' })); return;
    }
    if (req.url === '/api/dealpilot/session') {
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ sessionId: 'fixture-session', workspaceId: 'dealpilot/fixture', workspaceName: 'A2A Fixture Workspace', agentPreset: 'dealpilot-sales' })); return;
    }
    if (req.url?.startsWith('/api/dealpilot/snapshot')) {
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(snapshot)); return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(`http://127.0.0.1:${port}/dealpilot`);
    await page.locator('#dealpilot-workspace-select').selectOption('dealpilot/fixture');
    await page.getByText('优先处理').waitFor({ state: 'visible' });
    assert.deepEqual(await page.evaluate(() => window.__clientInject), ['slots', 'sessions', 'workspaces', 'connection']);
    assert.equal(await page.evaluate(() => window.__nativeCreateWorkspaceId), 'dealpilot/fixture');
    assert.equal(await page.evaluate(() => window.__nativeSessionId), 'native-fixture-session');
    assert.equal(await page.locator('.dealpilot-nav').isVisible(), true, 'DealPilot navigation should be visible in its product sidebar');
    assert.match(await page.locator('.dealpilot-context').textContent(), /逾期/);
    assert.match(await page.locator('.dealpilot-context').textContent(), /Send revised proposal/);

    await page.getByRole('button', { name: /打开完整工作台/ }).click();
    await page.getByLabel('销售工作台导航').getByRole('button', { name: '客户', exact: true }).click();
    await page.getByRole('button', { name: /Acme Corp/ }).click();
    assert.match(await page.locator('.dealpilot-board-detail').textContent(), /关系阶段/);
    assert.equal(await page.getByLabel('排序当前视图').isVisible(), true);
    await page.getByRole('button', { name: '关闭完整工作台' }).click();
    await page.getByRole('button', { name: '收起业务上下文' }).click();
    assert.equal(await page.getByRole('button', { name: '打开业务上下文' }).isVisible(), true);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Legacy DealPilot shell is a redirect and never embeds the DSH page', async () => {
  const html = await readFile(shellPath, 'utf8');
  assert.doesNotMatch(html, /<iframe\b/i);
  assert.match(html, /url=\/dealpilot/);
  assert.match(html, /href="\/dealpilot"/);
});
