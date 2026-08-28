import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from '../plugin/node_modules/typescript/lib/typescript.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.join(repoRoot, 'plugin', 'client', 'client.ts');
const outputPath = path.join(repoRoot, 'plugin', 'client', 'client.js');
const source = await readFile(sourcePath, 'utf8');

// The DSH client loader expects a plain factory. Keep the source module's
// exports explicit, and fail loudly if a future client adds an unsupported one.
const exportNames = [...source.matchAll(/^export\s+(?:const|function)\s+([A-Za-z_$][\w$]*)/gm)].map((match) => match[1]);
if (exportNames.length !== 2 || !exportNames.includes('inject') || !exportNames.includes('apply')) {
  throw new Error(`client.ts must export exactly inject and apply; found ${exportNames.join(', ') || '(none)'}`);
}

const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ES2022,
    removeComments: false,
    sourceMap: false,
    newLine: ts.NewLineKind.LineFeed,
  },
  reportDiagnostics: true,
});
const diagnostics = (transpiled.diagnostics ?? []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
if (diagnostics.length) {
  const message = ts.flattenDiagnosticMessageText(diagnostics[0].messageText, '\n');
  throw new Error(`Unable to transpile client.ts: ${message}`);
}

const body = transpiled.outputText.replace(/^export\s+(?=(?:const|function)\s+(?:inject|apply)\b)/gm, '');
if (/^export\s+/m.test(body)) throw new Error('client.ts contains an unsupported export form');

const bundle = `window.__ModuleLoader__.load({ id: "dealpilot-dsh", factory: (require) => {\nvar module = { exports: {} }; var exports = module.exports;\n"use strict";\n\n${body.trimEnd()}\nreturn module.exports = { apply, inject }; } });\n`;
await writeFile(outputPath, bundle, 'utf8');
