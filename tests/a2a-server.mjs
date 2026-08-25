import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = await readFile(path.join(root, 'plugin', 'client', 'dashboard.html'), 'utf8');
const snapshot = {
  generated_at: new Date().toISOString(), workspace_name: 'A2A Browser Workspace',
  summary: { customers: 1, active_deals: 1, today: 1, overdue: 0, risks: 0, confirmation: 0 },
  today: [],
  customers: [{ ref: 'customer/acme', title: 'Acme Corp', source_category: 'import', relationship_stage: 'qualified', icp_fit: 'high', priority: 'P1', contacts: [] }],
  deals: [{ ref: 'deal/acme', title: 'Acme Renewal', customer_name: 'Acme Corp', status: 'active', funnel_stage: 'proposal', priority: 'P1', risk_level: 'unknown', products: [], actions: [] }],
  funnel: [{ stage: 'proposal', count: 1 }], activity: [], warnings: [],
};

const server = createServer((req, res) => {
  if (req.url === '/api/dealpilot/snapshot') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(snapshot));
  } else if (req.url === '/dealpilot' || req.url === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  } else {
    res.writeHead(404);
    res.end();
  }
});

const port = Number(process.env.A2A_PORT || 4173);
server.listen(port, '127.0.0.1', () => console.log(`A2A fixture: http://127.0.0.1:${port}/dealpilot`));
process.on('SIGINT', () => server.close(() => process.exit(0)));
