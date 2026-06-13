// Pinned behavior for the ⌘K command palette's actions group
// (core/search resolveGlobalSearch). Actions are commands ("Nueva cotización",
// theme toggle) the View role-gates and passes in; they must:
//   • show in the blank-query "home" (commands first, then pages);
//   • match on label AND keyword synonyms when typing;
//   • stay OUT of the way of a name search (empty unless the query hits one);
//   • carry `to` (navigate) or `run` (host side-effect) through to the item.

import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveGlobalSearch } from '../src/core/search/index.js';

const ACTIONS = [
  { key: 'new-quote', label: 'Nueva cotización', to: '/quotes/new', keywords: ['nueva', 'crear', 'presupuesto'] },
  { key: 'toggle-theme', label: 'Cambiar a modo oscuro', run: 'theme', keywords: ['tema', 'oscuro', 'dark'] },
];
const PAGES = [{ to: '/quotes', label: 'Cotizaciones' }];

test('blank query shows commands first, then pages', () => {
  const r = resolveGlobalSearch({ query: '', actions: ACTIONS, pages: PAGES });
  assert.equal(r.isEmptyQuery, true);
  assert.deepEqual(r.groups.map((g) => g.key), ['commands', 'pages']);
  assert.equal(r.groups[0].items.length, 2);
  assert.equal(r.groups[0].items[0].type, 'action');
});

test('actions match on label and on keyword synonyms', () => {
  const byLabel = resolveGlobalSearch({ query: 'nueva cot', actions: ACTIONS });
  const cmds = byLabel.groups.find((g) => g.key === 'commands');
  assert.ok(cmds && cmds.items[0].primary === 'Nueva cotización');

  const bySynonym = resolveGlobalSearch({ query: 'crear', actions: ACTIONS });
  assert.equal(bySynonym.groups.find((g) => g.key === 'commands').items[0].key, 'action:new-quote');

  const themeWord = resolveGlobalSearch({ query: 'oscuro', actions: ACTIONS });
  const t = themeWord.groups.find((g) => g.key === 'commands').items[0];
  assert.equal(t.run, 'theme');
  assert.equal(t.to, null);
});

test('commands stay first but empty on an unrelated name query', () => {
  const quotes = [{ id: 'q1', number: 7, status: 'sent', updatedAt: 1 }];
  const r = resolveGlobalSearch({ query: 'ramirez', actions: ACTIONS, quotes });
  // no command keyword hit → commands group filtered out entirely
  assert.equal(r.groups.find((g) => g.key === 'commands'), undefined);
});

test('action item carries to/run/icon through unchanged', () => {
  const r = resolveGlobalSearch({ query: '', actions: ACTIONS });
  const [newQuote, theme] = r.groups[0].items;
  assert.equal(newQuote.to, '/quotes/new');
  assert.equal(newQuote.run, null);
  assert.equal(theme.run, 'theme');
  assert.equal(theme.secondary, 'Acción');
});
