// Tests for tree.js. Run with: node test_tree.js
const assert = require('node:assert/strict');
const { DEFAULTS, panelOf, tabPanels, buildTree, subtree } = require('./tree.js');

const cfg = {
  ...DEFAULTS,
  panels: [...DEFAULTS.panels, { id: 'work', name: 'Work', color: '#38b2ac' }],
};
const tabs = ids => ids.map(id => (typeof id === 'object' ? id : { id }));
const shape = nodes => nodes.map(n => [n.tab.id, n.depth, n.parent]);

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error(`FAIL ${name}\n`, e); process.exitCode = 1; }
}

test('tabs nest under their parent', () => {
  const meta = { 2: { p: 1 }, 3: { p: 2 }, 4: { p: 1 } };
  const nodes = buildTree(tabs([1, 2, 3, 4, 5]), meta, cfg, 'default');
  assert.deepEqual(shape(nodes), [[1, 0, null], [2, 1, 1], [3, 2, 2], [4, 1, 1], [5, 0, null]]);
  assert.deepEqual(nodes.map(n => n.desc), [3, 1, 0, 0, 0]);
});

test('a parent that does not come before the tab makes it a root', () => {
  // tab 2 was dragged above its parent in the native tab strip
  assert.deepEqual(shape(buildTree(tabs([2, 1]), { 2: { p: 1 } }, cfg, 'default')), [[2, 0, null], [1, 0, null]]);
  // a root tab sits between parent and child, closing the branch
  assert.deepEqual(shape(buildTree(tabs([1, 5, 2]), { 2: { p: 1 } }, cfg, 'default')), [[1, 0, null], [5, 0, null], [2, 0, null]]);
  // the parent is gone
  assert.deepEqual(shape(buildTree(tabs([8]), { 8: { p: 99 } }, cfg, 'default')), [[8, 0, null]]);
});

test('collapsed branches hide every descendant', () => {
  const meta = { 1: { c: true }, 2: { p: 1 }, 3: { p: 2 }, 4: { p: 1 } };
  const nodes = buildTree(tabs([1, 2, 3, 4, 5]), meta, cfg, 'default');
  assert.deepEqual(nodes.map(n => n.hidden), [false, true, true, true, false]);
  assert.equal(nodes[0].collapsed, true);
});

test('pinned tabs and other panels are left out', () => {
  const meta = { 3: { panel: 'work' }, 4: { panel: 'work', p: 3 } };
  const list = tabs([{ id: 1, pinned: true }, 2, 3, 4, 5]);
  assert.deepEqual(shape(buildTree(list, meta, cfg, 'default')), [[2, 0, null], [5, 0, null]]);
  assert.deepEqual(shape(buildTree(list, meta, cfg, 'work')), [[3, 0, null], [4, 1, 3]]);
});

test('a child in another panel is not nested across panels', () => {
  const meta = { 2: { p: 1, panel: 'work' } };
  assert.deepEqual(shape(buildTree(tabs([1, 2]), meta, cfg, 'work')), [[2, 0, null]]);
});

test('subtree returns the node and its descendants', () => {
  const meta = { 2: { p: 1 }, 3: { p: 2 }, 4: { p: 1 } };
  const nodes = buildTree(tabs([1, 2, 3, 4, 5]), meta, cfg, 'default');
  assert.deepEqual(subtree(nodes, 0).map(n => n.tab.id), [1, 2, 3, 4]);
  assert.deepEqual(subtree(nodes, 1).map(n => n.tab.id), [2, 3]);
  assert.deepEqual(subtree(nodes, 4).map(n => n.tab.id), [5]);
});

test('panelOf falls back to the first tab panel', () => {
  assert.equal(panelOf(undefined, cfg), 'default');
  assert.equal(panelOf({ panel: 'deleted' }, cfg), 'default');
  assert.equal(panelOf({ panel: 'bookmarks' }, cfg), 'default');
  assert.equal(panelOf({ panel: 'work' }, cfg), 'work');
  assert.deepEqual(tabPanels(cfg).map(p => p.id), ['default', 'work']);
});

console.log(`${passed} passed${process.exitCode ? ', some failed' : ''}`);
