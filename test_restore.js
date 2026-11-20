// Runs background.js against a fake chrome API to check that the tree survives
// browser restarts and window closes. Run with: node test_restore.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = f => fs.readFileSync(path.join(__dirname, f), 'utf8');
const clone = v => (v === undefined ? v : structuredClone(v));
const event = () => {
  const fns = [];
  return { addListener: fn => fns.push(fn), fire: (...a) => fns.forEach(fn => fn(...a)) };
};

// One browser run: its tabs, windows, storage and a fake clock.
// storage.local survives a restart (pass it to the next Browser); storage.session doesn't.
class Browser {
  constructor({ local = {}, session = {}, tabs = [] } = {}) {
    this.local = clone(local);
    this.session = clone(session);
    this.tabs = tabs.map((t, i) => ({ pinned: false, active: i === 0, index: i, ...t }));
    this.now = 1e12;
    this.timers = [];
    this.timerSeq = 0;
    const area = key => ({
      get: async keys => {
        const out = {};
        for (const k of [].concat(keys)) if (this[key][k] !== undefined) out[k] = clone(this[key][k]);
        return out;
      },
      set: async obj => { Object.assign(this[key], clone(obj)); },
    });
    const ev = {};
    for (const n of ['onCreated', 'onRemoved', 'onReplaced', 'onActivated', 'onUpdated', 'wOnRemoved', 'wOnCreated',
      'storageChanged', 'alarm', 'message', 'command']) ev[n] = event();
    this.ev = ev;
    const windowIds = () => [...new Set(this.tabs.map(t => t.windowId))];
    this.chrome = {
      storage: { local: area('local'), session: area('session'), onChanged: ev.storageChanged },
      tabs: {
        query: async (q = {}) => clone(this.tabs.filter(t => q.windowId == null || t.windowId === q.windowId)
          .sort((a, b) => a.windowId - b.windowId || a.index - b.index)),
        onCreated: ev.onCreated, onRemoved: ev.onRemoved, onReplaced: ev.onReplaced,
        onActivated: ev.onActivated, onUpdated: ev.onUpdated,
      },
      windows: {
        getAll: async () => windowIds().map(id => ({ id })),
        onRemoved: ev.wOnRemoved, onCreated: ev.wOnCreated,
      },
      sidePanel: { setPanelBehavior: async () => {} },
      alarms: { clear: () => {}, create: () => {}, onAlarm: ev.alarm },
      runtime: { onMessage: ev.message },
      commands: { onCommand: ev.command },
    };
  }

  start() {
    const ctx = vm.createContext({
      chrome: this.chrome,
      setTimeout: (fn, ms = 0) => { this.timers.push({ id: ++this.timerSeq, at: this.now + ms, fn }); return this.timerSeq; },
      clearTimeout: id => { this.timers = this.timers.filter(t => t.id !== id); },
      Date: { now: () => this.now },
      structuredClone, console,
    });
    ctx.importScripts = f => vm.runInContext(read(f), ctx);
    vm.runInContext(read('background.js'), ctx);
    return this.settle();
  }

  async settle() { for (let i = 0; i < 50; i++) await new Promise(r => setImmediate(r)); }

  async advance(ms) {
    const end = this.now + ms;
    for (;;) {
      await this.settle();
      this.timers.sort((a, b) => a.at - b.at);
      const t = this.timers[0];
      if (!t || t.at > end) break;
      this.timers.shift();
      this.now = t.at;
      t.fn();
    }
    this.now = end;
    await this.settle();
  }

  async closeWindow(windowId) {
    for (const t of this.tabs.filter(x => x.windowId === windowId)) {
      this.tabs = this.tabs.filter(x => x !== t);
      this.ev.onRemoved.fire(t.id, { windowId, isWindowClosing: true });
    }
    this.ev.wOnRemoved.fire(windowId);
    await this.settle();
  }

  async quit() {
    for (const w of [...new Set(this.tabs.map(t => t.windowId))]) await this.closeWindow(w);
    await this.advance(10000);
  }

  // Panel and parent URL for each tab, from what the extension stored for this session.
  tree() {
    const meta = this.session.meta || {};
    return Object.fromEntries(this.tabs.map(t => {
      const m = meta[t.id] || {};
      return [t.url, { panel: m.panel, parent: this.tabs.find(x => x.id === m.p)?.url ?? null }];
    }));
  }
}

const cfg = { panels: [
  { id: 'default', name: 'Tabs', color: '#7c8cff' },
  { id: 'work', name: 'Work', color: '#38b2ac' },
] };

const expected = {
  'https://a.test/': { panel: 'default', parent: null },
  'https://b.test/': { panel: 'work', parent: null },
  'https://c.test/': { panel: 'work', parent: 'https://b.test/' },
  'https://d.test/': { panel: 'work', parent: null },
};

// The first run: four tabs in two windows, three of them in the Work panel.
async function firstRun() {
  const b = new Browser({
    local: { cfg },
    session: { meta: {
      1: { p: null, panel: 'default' }, 2: { p: null, panel: 'work' },
      3: { p: 2, panel: 'work' }, 4: { p: null, panel: 'work' },
    } },
    tabs: [
      { id: 1, windowId: 1, url: 'https://a.test/' }, { id: 2, windowId: 1, url: 'https://b.test/', index: 1 },
      { id: 3, windowId: 1, url: 'https://c.test/', index: 2 }, { id: 4, windowId: 2, url: 'https://d.test/' },
    ],
  });
  await b.start();
  b.ev.onUpdated.fire(1, { url: 'https://a.test/' }); // any change saves the tree
  await b.advance(2000);
  assert.deepEqual(b.tree(), expected);
  return b;
}

// Brave reopens the session with new tab ids. Background tabs start out unloaded with no URL
// and only report it once loaded.
async function restart(local) {
  const b = new Browser({ local, tabs: [
    { id: 101, windowId: 9, url: '' }, { id: 102, windowId: 9, url: '', index: 1 },
    { id: 103, windowId: 9, url: '', index: 2 }, { id: 104, windowId: 10, url: '' },
  ] });
  const urls = { 101: 'https://a.test/', 102: 'https://b.test/', 103: 'https://c.test/', 104: 'https://d.test/' };
  b.tabs[0].url = urls[101]; // the active tab loads first
  await b.start();
  for (const t of b.tabs) b.ev.onCreated.fire(clone(t));
  await b.advance(3000);
  for (const t of b.tabs.slice(1)) {
    t.url = urls[t.id];
    b.ev.onUpdated.fire(t.id, { url: t.url });
    await b.advance(4000);
  }
  await b.advance(2000);
  return b;
}

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; } catch (e) { console.error(`FAIL ${name}\n`, e); process.exitCode = 1; }
}

(async () => {
  await test('quitting the browser keeps the saved tree', async () => {
    const b = await firstRun();
    await b.quit();
    assert.equal(b.local.tree.length, 4);
  });

  await test('panels and parents come back after a restart', async () => {
    const before = await firstRun();
    await before.quit();
    const after = await restart(before.local);
    assert.deepEqual(after.tree(), expected);
    assert.deepEqual(after.local.tree.map(e => e.u).sort(), Object.keys(expected));
  });

  await test('a restart in the middle of a restore keeps the tabs not matched yet', async () => {
    const before = await firstRun();
    await before.quit();
    const half = new Browser({ local: before.local, tabs: [{ id: 50, windowId: 3, url: 'https://a.test/' }] });
    await half.start();
    half.ev.onCreated.fire(clone(half.tabs[0]));
    await half.advance(5000);
    await half.quit();
    const after = await restart(half.local);
    assert.deepEqual(after.tree(), expected);
  });

  await test('closing one window while another stays open drops its tabs', async () => {
    const b = await firstRun();
    await b.closeWindow(2);
    await b.advance(10000);
    assert.deepEqual(b.local.tree.map(e => e.u).sort(), ['https://a.test/', 'https://b.test/', 'https://c.test/']);
  });

  await test('reloading the extension keeps the tree', async () => {
    const before = await firstRun();
    const after = new Browser({ local: before.local, tabs: before.tabs });
    await after.start();
    await after.advance(2000);
    assert.deepEqual(after.tree(), expected);
  });

  console.log(`${passed} passed${process.exitCode ? ', some failed' : ''}`);
})();
