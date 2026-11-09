import { expect, it } from 'vitest';
import { checkArchitecture, moduleImports } from '../../scripts/check-architecture.mjs';

it('reads real module edges and ignores comments and unrelated strings', () => {
  expect(moduleImports(`
    // import { bad } from '../ui/comment';
    const example = "import('../ui/string')";
    import type { Shape } from './types';
    export { parse } from './codec';
    const panel = import('../ui/panel');
  `)).toEqual(['./types', './codec', '../ui/panel']);
});

it('rejects UI dependencies hidden behind shared-module re-exports', () => {
  const sources = new Map([
    ['core/document.ts', "import { parse } from '../shared';"],
    ['shared.ts', "export { parse } from './ui/panel';"],
    ['ui/panel.ts', 'export const parse = () => {};'],
  ]);
  expect(checkArchitecture(sources)).toEqual(['core/document.ts -> shared.ts -> ui/panel.ts']);
});

it('allows UI to use core and handles cycles within core', () => {
  expect(checkArchitecture(new Map([
    ['ui/panel.ts', "import '../core/a';"],
    ['core/a.ts', "import './b';"],
    ['core/b.ts', "import './a';"],
  ]))).toEqual([]);
});
