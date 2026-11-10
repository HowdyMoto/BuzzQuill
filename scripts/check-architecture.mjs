import ts from 'typescript';
import { readdirSync, readFileSync } from 'node:fs';
import { posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Parse module edges, including type imports, re-exports and literal dynamic imports. */
export function moduleImports(code, file = 'module.ts') {
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true);
  const imports = [];
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      imports.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
      imports.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return imports;
}

/** Core may use browser APIs and shared libraries, but must not depend on presentation or tools. */
export function checkArchitecture(sources) {
  const edges = new Map([...sources].map(([file, code]) => [file, moduleImports(code, file)
    .filter(specifier => specifier.startsWith('.'))
    .map(specifier => posix.normalize(posix.join(posix.dirname(file), specifier.split('?')[0])))
    .map(target => [target, `${target}.ts`, `${target}/index.ts`].find(candidate => sources.has(candidate)))
    .filter(Boolean)]));
  const forbidden = file => /^(ui|tools|app)\//.test(file) || /^(main|entry|commands)\.ts$/.test(file);
  const violations = [];
  for (const start of sources.keys()) {
    if (!start.startsWith('core/')) continue;
    const visited = new Set();
    function walk(file, path) {
      if (visited.has(file)) return;
      visited.add(file);
      if (forbidden(file)) { violations.push([...path, file].join(' -> ')); return; }
      for (const target of edges.get(file) ?? []) walk(target, [...path, file]);
    }
    walk(start, []);
  }
  return violations;
}

function readSources(root, directory = '') {
  const sources = new Map();
  for (const entry of readdirSync(resolve(root, directory), { withFileTypes: true })) {
    const file = posix.join(directory, entry.name);
    if (entry.isDirectory()) for (const [key, value] of readSources(root, file)) sources.set(key, value);
    else if (entry.name.endsWith('.ts')) sources.set(file, readFileSync(resolve(root, file), 'utf8'));
  }
  return sources;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const violations = checkArchitecture(readSources(fileURLToPath(new URL('../src', import.meta.url))));
  if (violations.length) {
    console.error(`Architecture boundary violations:\n${violations.join('\n')}`);
    process.exitCode = 1;
  } else console.log('Architecture check passed: core has no dependency path to UI, tools, or application wiring.');
}
