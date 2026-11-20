importScripts('tree.js');

// meta: tabId -> { p: parentTabId|null, c: collapsed, panel, u: last known url, g: pinned in every panel }
// ap: windowId -> active panel id,  la: panelId -> last active tabId
let cfg = DEFAULTS, meta = {}, ap = {}, la = {};

// Tab ids change when the browser restarts, so the tree saved in storage.local is matched back to the new tabs
// by URL. Brave restores tabs over several seconds and an unloaded tab may not report its URL yet, so matching
// runs again on every tab event until all saved tabs are found or RESTORE_MS runs out. Until then the saved
// tree is not overwritten, or the tabs that haven't been matched yet would lose their place.
// pending: { src: saved tree, map: [[savedId, newId]], until: timestamp } | null
let pending = null;
const RESTORE_MS = 2 * 60 * 1000;

// Windows closed in the last few seconds. Their tabs stay in the saved tree until we know the browser is still
// running: when it quits, it closes every window first, and saving then would empty the tree.
let closedWins = new Set();
const CLOSE_CONFIRM_MS = 5000;

const urlOf = t => t.url || t.pendingUrl || meta[t.id]?.u || '';

const ready = (async () => {
  const l = await chrome.storage.local.get(['cfg', 'tree']);
  cfg = { ...DEFAULTS, ...l.cfg };
  const s = await chrome.storage.session.get(['meta', 'ap', 'la', 'pending', 'closedWins', 'winCache']);
  Object.assign(winCache, s.winCache);
  if (s.meta) {
    // The service worker was stopped and started again; the browser kept running.
    ({ meta } = s); ap = s.ap || {}; la = s.la || {};
    pending = s.pending || null;
    closedWins = new Set(s.closedWins || []);
  } else {
    // Browser start or extension reload.
    startRestore(l.tree);
  }
  if (pending) await restore();
  for (const w of await chrome.windows.getAll()) refreshCache(w.id);
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  setupAlarm();
})();

function startRestore(tree) {
  pending = tree?.length ? { src: tree, map: [], until: Date.now() + RESTORE_MS } : null;
}

let restoreT;
function scheduleRestore() {
  if (!pending) return;
  clearTimeout(restoreT);
  restoreT = setTimeout(restore, 500);
}

async function restore() {
  if (!pending) return;
  const tabs = (await chrome.tabs.query({})).sort((a, b) => a.windowId - b.windowId || a.index - b.index);
  const map = new Map(pending.map), used = new Set(map.values()), added = new Set();
  const fresh = t => (!meta[t.id] || meta[t.id].auto) && !used.has(t.id);
  const pair = (s, t) => { map.set(s.id, t.id); used.add(t.id); added.add(t.id); };
  const todo = pending.src.filter(s => s.u && !map.has(s.id));

  // Same id and URL: the extension was reloaded and the ids survived.
  const byId = new Map(tabs.map(t => [t.id, t]));
  for (const s of todo) {
    const t = byId.get(s.id);
    if (t && urlOf(t) === s.u && fresh(t)) pair(s, t);
  }
  // Otherwise the first unmatched tab with the same URL, in tab order.
  const queue = new Map();
  for (const t of tabs) {
    const u = urlOf(t);
    if (u && fresh(t)) queue.set(u, [...(queue.get(u) || []), t]);
  }
  for (const s of todo) {
    const t = !map.has(s.id) && queue.get(s.u)?.shift();
    if (t) pair(s, t);
  }

  for (const s of pending.src) {
    const id = map.get(s.id);
    if (id == null) continue;
    const parent = map.get(s.p) ?? null;
    if (added.has(id)) meta[id] = { p: parent, c: !!s.c, panel: s.panel, u: s.u, g: s.g || undefined };
    else if (meta[id] && meta[id].p == null && parent != null) meta[id].p = parent; // parent found later
  }
  if (cfg.switchPanelOnActivate) {
    for (const t of tabs) if (t.active && added.has(t.id)) ap[t.windowId] = panelOf(meta[t.id], cfg);
  }

  const done = map.size >= pending.src.filter(s => s.u).length || Date.now() > pending.until;
  pending = done ? null : { ...pending, map: [...map] };
  if (!done) setTimeout(scheduleRestore, 5000); // the worker may sleep through RESTORE_MS; it rechecks on wake
  save();
}

let saveT, treeT;
function save() {
  clearTimeout(saveT);
  saveT = setTimeout(() => chrome.storage.session.set({ meta, ap, la, pending, closedWins: [...closedWins] }), 20);
  clearTimeout(treeT);
  treeT = setTimeout(persistTree, 1000);
}

async function persistTree() {
  if (pending && Date.now() > pending.until) pending = null;
  if (pending) return;
  const tabs = await chrome.tabs.query({});
  if (!tabs.length) return; // every window is closed: the browser is quitting
  const live = new Set(tabs.map(t => t.id));
  const { tree: prev = [] } = await chrome.storage.local.get('tree');
  const kept = prev.filter(e => closedWins.has(e.w) && !live.has(e.id));
  for (const id in meta) if (!live.has(+id)) delete meta[id];
  const entries = tabs.filter(t => meta[t.id]).map(t => {
    const m = meta[t.id];
    m.u = urlOf(t);
    return { id: t.id, u: m.u, w: t.windowId, p: m.p ?? null, c: !!m.c, panel: m.panel, g: m.g || undefined };
  });
  await chrome.storage.local.set({ tree: [...entries, ...kept] });
}

const winTabs = windowId => chrome.tabs.query({ windowId });
const curPanel = windowId => panelOf({ panel: ap[windowId] }, cfg);

// ---------- closing the active tab ----------
// Chromium activates the tab to the right of a closed one, or its opener, which can sit in another panel.
// Răboj activates the visible tab above it in the same panel instead, or the one below if it was the first.
// onRemoved arrives when the tab is already gone, so each window's tab order is kept as last seen
// (also in storage.session, for when the worker wakes up for that very event).
const winCache = {};
const cacheT = {}, act = {}, correcting = {};
const closingNow = new Set(); // closed by closeTabs, which picks the next tab itself

function refreshCache(windowId) {
  clearTimeout(cacheT[windowId]);
  cacheT[windowId] = setTimeout(async () => {
    const tabs = await winTabs(windowId).catch(() => []);
    if (tabs.length) winCache[windowId] = tabs.map(t => ({ id: t.id, index: t.index, pinned: t.pinned, active: t.active }));
    else delete winCache[windowId];
    for (const t of tabs) if (t.active) act[windowId] = t.id;
    chrome.storage.session.set({ winCache });
  }, 50);
}

// tabs: one window as it was before the close. gone: ids being closed.
function tabAfterClose(tabs, id, gone) {
  if (tabs.find(t => t.id === id)?.pinned) return null;
  const nodes = buildTree(tabs, meta, cfg, panelOf(meta[id], cfg));
  const closesBranch = n => cfg.onParentClose === 'close' || (n.collapsed && cfg.closeCollapsedBranch);
  const all = new Set(gone);
  nodes.forEach((n, k) => { if (gone.has(n.tab.id) && closesBranch(n)) subtree(nodes, k).forEach(x => all.add(x.tab.id)); });
  const i = nodes.findIndex(n => n.tab.id === id);
  if (i < 0) return null;
  for (let j = i - 1; j >= 0; j--) if (!all.has(nodes[j].tab.id) && !nodes[j].hidden) return nodes[j].tab.id;
  for (let j = i + 1; j < nodes.length; j++) if (!all.has(nodes[j].tab.id)) return nodes[j].tab.id;
  return null; // the panel is now empty: leave it to the browser
}

// While correcting[windowId] is set, onActivated ignores the tab Chromium picked, so it doesn't switch panels
// or expand a collapsed branch on the way.
function expectActivation(windowId, target) {
  if (target == null) return;
  correcting[windowId] = target;
  setTimeout(() => { if (correcting[windowId] === target) delete correcting[windowId]; }, 1000);
}
function activate(windowId, target) {
  if (target == null) return;
  chrome.tabs.update(target, { active: true }).catch(() => { delete correcting[windowId]; });
}

// ---------- tab events ----------
chrome.tabs.onCreated.addListener(async tab => {
  refreshCache(tab.windowId);
  await ready;
  scheduleRestore();
  if (meta[tab.id]) return; // set explicitly by newTab / snapshot restore
  const op = tab.openerTabId;
  meta[tab.id] = {
    p: cfg.nest && op != null ? op : null,
    panel: op != null && meta[op] ? panelOf(meta[op], cfg) : curPanel(tab.windowId),
    auto: true,
  };
  save();
});

chrome.tabs.onRemoved.addListener(async (id, info) => {
  const w = info.windowId, known = act[w];
  await ready;
  if (info.isWindowClosing) { closedWins.add(w); return; } // keep tree intact across shutdown
  const before = winCache[w];
  refreshCache(w);
  const m = meta[id];
  if (!m) return;
  const picked = closingNow.delete(id); // closeTabs already chose the next tab
  const wasActive = known !== undefined ? known === id : !!before?.find(t => t.id === id)?.active;
  const target = !picked && wasActive && before ? tabAfterClose(before, id, new Set([id])) : null;
  expectActivation(w, target);
  delete meta[id];
  const kids = Object.keys(meta).filter(k => meta[k].p === id).map(Number);
  if (kids.length && (cfg.onParentClose === 'close' || (m.c && cfg.closeCollapsedBranch))) {
    const all = [], walk = ids => ids.forEach(k => {
      all.push(k);
      walk(Object.keys(meta).filter(x => meta[x].p === k).map(Number));
    });
    walk(kids);
    all.forEach(k => delete meta[k]);
    chrome.tabs.remove(all).catch(() => {});
  } else {
    kids.forEach(k => (meta[k].p = m.p ?? null));
  }
  activate(w, target);
  save();
});

chrome.tabs.onReplaced.addListener(async (added, removed) => {
  await ready;
  if (meta[removed]) meta[added] = meta[removed];
  delete meta[removed];
  for (const k in meta) if (meta[k].p === removed) meta[k].p = added;
  if (pending) pending.map = pending.map.map(([s, id]) => [s, id === removed ? added : id]);
  save();
});

chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  act[windowId] = tabId;
  refreshCache(windowId);
  await ready;
  if (correcting[windowId] != null) {
    if (correcting[windowId] !== tabId) return; // Chromium's pick after a close; ours follows
    delete correcting[windowId];
  }
  const tabs = await winTabs(windowId);
  if (tabs.find(t => t.id === tabId)?.pinned && meta[tabId]?.g) return; // shown in every panel: stay where we are
  const panel = panelOf(meta[tabId], cfg);
  la[panel] = tabId;
  if (cfg.switchPanelOnActivate && cfg.panels.find(p => p.id === ap[windowId])?.type !== 'bookmarks') ap[windowId] = panel;
  // reveal the active tab if it sits inside a collapsed branch
  const nodes = buildTree(tabs, meta, cfg, panel);
  let n = nodes.find(x => x.tab.id === tabId);
  while (n && n.parent != null) {
    if (meta[n.parent]) meta[n.parent].c = false;
    n = nodes.find(x => x.tab.id === n.parent);
  }
  save();
});

chrome.tabs.onUpdated.addListener(async (id, change, tab) => {
  if (change.pinned !== undefined) refreshCache(tab.windowId);
  await ready;
  if (change.pinned === false && meta[id]?.g) { delete meta[id].g; save(); }
  scheduleRestore();
  if (change.url) save();
});

chrome.tabs.onMoved.addListener((id, info) => refreshCache(info.windowId));
chrome.tabs.onAttached.addListener((id, info) => refreshCache(info.newWindowId));
chrome.tabs.onDetached.addListener((id, info) => refreshCache(info.oldWindowId));

chrome.windows.onRemoved.addListener(async w => {
  await ready;
  delete ap[w];
  delete winCache[w];
  closedWins.add(w);
  save();
  setTimeout(async () => {
    // Other windows are still open, so the user closed this one: drop its tabs from the saved tree.
    if (!(await chrome.windows.getAll()).length) return;
    closedWins.delete(w);
    save();
  }, CLOSE_CONFIRM_MS);
});

chrome.windows.onCreated.addListener(async () => {
  await ready;
  if (!closedWins.size || pending || (await chrome.windows.getAll()).length > 1) return;
  // Every window was closed but the browser kept running in the background; it is now reopening the last
  // session with new tab ids, just like after a restart.
  startRestore((await chrome.storage.local.get('tree')).tree);
  closedWins.clear();
  scheduleRestore();
});

chrome.storage.onChanged.addListener((ch, area) => {
  if (area === 'local' && ch.cfg) { cfg = { ...DEFAULTS, ...ch.cfg.newValue }; setupAlarm(); }
});

// ---------- tree operations ----------
// Expand ids into whole branches. Returns moved (ordered, unique) and roots (top-most selected).
async function branches(ids) {
  const tabs = (await chrome.tabs.query({})).sort((a, b) => a.windowId - b.windowId || a.index - b.index);
  const want = new Set(ids), moved = [], roots = [], seen = new Set(), cache = {};
  for (const t of tabs) {
    if (!want.has(t.id) || seen.has(t.id)) continue;
    if (t.pinned) { moved.push(t.id); roots.push(t.id); seen.add(t.id); continue; }
    const key = t.windowId + ':' + panelOf(meta[t.id], cfg);
    const nodes = cache[key] ||= buildTree(tabs.filter(x => x.windowId === t.windowId), meta, cfg, panelOf(meta[t.id], cfg));
    roots.push(t.id);
    for (const n of subtree(nodes, nodes.findIndex(n => n.tab.id === t.id))) {
      if (!seen.has(n.tab.id)) { seen.add(n.tab.id); moved.push(n.tab.id); }
    }
  }
  return { moved, roots };
}

const ensure = id => (meta[id] ||= { p: null, panel: panelOf(null, cfg) });

async function move({ ids, target, pos, windowId, panel }) {
  const { moved, roots } = await branches(ids);
  if (!moved.length || moved.includes(target)) return;
  const tabs = await winTabs(windowId);
  const nodes = buildTree(tabs, meta, cfg, panel);
  const remaining = tabs.map(t => t.id).filter(id => !moved.includes(id));
  let index = -1, parent = null;
  const ti = nodes.findIndex(n => n.tab.id === target);
  if (ti >= 0) {
    if (pos === 'before') {
      index = remaining.indexOf(target);
      parent = nodes[ti].parent;
    } else {
      const last = subtree(nodes, ti).map(n => n.tab.id).filter(id => !moved.includes(id)).pop();
      index = remaining.indexOf(last) + 1;
      parent = pos === 'child' ? target : nodes[ti].parent;
    }
  }
  const pinnedCount = tabs.filter(t => t.pinned && !moved.includes(t.id)).length;
  for (const id of moved) ensure(id).panel = panel;
  for (const id of roots) ensure(id).p = parent;
  await chrome.tabs.move(moved, { windowId, index: index < 0 ? -1 : Math.max(index, pinnedCount) });
  save();
}

async function toPanel({ ids, panel }) {
  const { moved, roots } = await branches(ids);
  for (const id of moved) { ensure(id).panel = panel; delete meta[id].g; }
  for (const id of roots) ensure(id).p = null;
  await chrome.tabs.move(moved, { index: -1 }).catch(() => {});
  save();
}

async function toWindow({ ids }) {
  const { moved, roots } = await branches(ids);
  if (!moved.length) return;
  const w = await chrome.windows.create({ tabId: moved[0] });
  if (moved.length > 1) await chrome.tabs.move(moved.slice(1), { windowId: w.id, index: -1 });
  for (const id of roots) ensure(id).p = null;
  ap[w.id] = panelOf(meta[moved[0]], cfg);
  save();
}

// keepMeta: let onRemoved handle the children (promote or close them, per settings), as for a normal close.
// Without it, the ids are whole branches and their meta goes away with them.
async function closeTabs(ids, { keepMeta = false } = {}) {
  const tabs = await chrome.tabs.query({});
  const gone = new Set(ids), targets = [];
  for (const t of tabs) {
    if (!t.active || !gone.has(t.id)) continue;
    const target = tabAfterClose(tabs.filter(x => x.windowId === t.windowId), t.id, gone);
    expectActivation(t.windowId, target);
    targets.push([t.windowId, target]);
  }
  for (const id of ids) closingNow.add(id);
  setTimeout(() => ids.forEach(id => closingNow.delete(id)), 2000);
  if (!keepMeta) { ids.forEach(id => delete meta[id]); save(); }
  await chrome.tabs.remove(ids).catch(() => {});
  for (const [w, target] of targets) activate(w, target);
}

async function newTab({ windowId, panel, parent, url, active = true }) {
  panel = panelOf(parent != null && meta[parent] ? meta[parent] : { panel }, cfg);
  let index;
  if (parent != null) {
    const nodes = buildTree(await winTabs(windowId), meta, cfg, panel);
    const i = nodes.findIndex(n => n.tab.id === parent);
    if (i >= 0) index = nodes[i + nodes[i].desc].tab.index + 1;
    if (meta[parent]) meta[parent].c = false;
  }
  const t = await chrome.tabs.create({ windowId, url, active, index, openerTabId: parent ?? undefined });
  meta[t.id] = { p: parent ?? null, panel };
  save();
}

async function setPanel({ windowId, panel }) {
  ap[windowId] = panel;
  save();
  const p = cfg.panels.find(x => x.id === panel);
  if (!p || p.type === 'bookmarks' || !cfg.activateLastOnPanelSwitch) return;
  const tabs = await winTabs(windowId);
  const nodes = buildTree(tabs, meta, cfg, panel);
  const pick = pinnedFor(tabs, meta, cfg, panel).panel.find(t => t.id === la[panel])
    || nodes.find(n => n.tab.id === la[panel])?.tab || nodes.find(n => !n.hidden)?.tab;
  if (pick && !pick.active) await chrome.tabs.update(pick.id, { active: true });
}

// Pin to one panel, or to all of them (global). index: where to put them among the pinned tabs.
async function pin({ ids, global, panel, index }) {
  for (const id of ids) {
    const m = ensure(id);
    if (global) m.g = true;
    else { delete m.g; if (panel) m.panel = panelOf({ panel }, cfg); }
  }
  save();
  for (const id of ids) await chrome.tabs.update(id, { pinned: true }).catch(() => {});
  if (index != null) await chrome.tabs.move(ids, { index }).catch(() => {});
}

async function collapseAll({ windowId, panel, value }) {
  for (const n of buildTree(await winTabs(windowId), meta, cfg, panel)) if (n.desc) ensure(n.tab.id).c = value;
  save();
}

// ---------- snapshots ----------
async function snapshot(label = 'Auto') {
  const wins = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
  const windows = wins.map(w => ({
    tabs: w.tabs.map(t => {
      const p = w.tabs.findIndex(x => x.id === meta[t.id]?.p);
      return { u: urlOf(t), t: t.title, pin: t.pinned || undefined, g: meta[t.id]?.g, panel: panelOf(meta[t.id], cfg), p: p < 0 ? undefined : p, c: meta[t.id]?.c || undefined };
    }),
  }));
  const { snaps = [] } = await chrome.storage.local.get('snaps');
  if (label === 'Auto' && snaps[0] && JSON.stringify(snaps[0].windows) === JSON.stringify(windows)) return;
  snaps.unshift({ time: Date.now(), label, panels: cfg.panels, windows });
  await chrome.storage.local.set({ snaps: snaps.slice(0, Math.max(1, cfg.snapKeep)) });
}

async function restoreSnapshot({ i }) {
  const { snaps = [] } = await chrome.storage.local.get('snaps');
  const s = snaps[i];
  if (!s) return;
  const missing = s.panels.filter(p => !cfg.panels.some(x => x.id === p.id));
  if (missing.length) {
    cfg = { ...cfg, panels: [...cfg.panels, ...missing] };
    await chrome.storage.local.set({ cfg });
  }
  for (const w of s.windows) {
    const win = await chrome.windows.create({ url: 'about:blank' });
    const ids = [];
    for (const [j, t] of w.tabs.entries()) {
      try {
        const active = !ids.some(x => x != null); // first restored tab loads, the rest stay unloaded
        const nt = await chrome.tabs.create({ windowId: win.id, url: t.u, active, pinned: !!t.pin });
        ids[j] = nt.id;
        meta[nt.id] = { panel: t.panel, c: !!t.c, g: t.g || undefined };
        // only web pages: discarding a just-created extension/internal page crashes Chromium
        if (!active && cfg.restoreUnloaded && /^https?:/.test(t.u)) chrome.tabs.discard(nt.id).catch(() => {});
      } catch { /* url not openable by extensions */ }
    }
    w.tabs.forEach((t, j) => { if (ids[j] != null) meta[ids[j]].p = ids[t.p] ?? null; });
    await chrome.tabs.remove(win.tabs[0].id).catch(() => {});
  }
  save();
}

function setupAlarm() {
  chrome.alarms.clear('snap');
  if (cfg.snapInterval > 0) chrome.alarms.create('snap', { periodInMinutes: Math.max(1, cfg.snapInterval) });
}
chrome.alarms.onAlarm.addListener(async a => { await ready; if (a.name === 'snap') snapshot(); });

// ---------- messages & commands ----------
const handlers = {
  move, toPanel, toWindow, newTab, setPanel, collapseAll, restoreSnapshot, pin,
  collapse: ({ id, value }) => { const m = ensure(id); m.c = value ?? !m.c; save(); },
  close: ({ ids }) => closeTabs(ids, { keepMeta: true }),
  closeBranch: async ({ ids }) => closeTabs((await branches(ids)).moved),
  closeBelow: async ({ id, windowId, panel }) => {
    const nodes = buildTree(await winTabs(windowId), meta, cfg, panel);
    closeTabs(nodes.slice(nodes.findIndex(n => n.tab.id === id) + 1).map(n => n.tab.id));
  },
  closeOthers: async ({ ids, windowId, panel }) => {
    const keep = new Set((await branches(ids)).moved);
    closeTabs(buildTree(await winTabs(windowId), meta, cfg, panel).map(n => n.tab.id).filter(id => !keep.has(id)));
  },
  snapshot: ({ label }) => snapshot(label || 'Manual'),
};

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  ready.then(() => handlers[msg.type](msg)).then(() => reply({ ok: true }), e => reply({ error: String(e) }));
  return true;
});

chrome.commands.onCommand.addListener(async (cmd, tab) => {
  await ready;
  tab ||= (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
  if (!tab) return;
  const w = tab.windowId;
  if (cmd === 'next-panel' || cmd === 'prev-panel') {
    const ids = cfg.panels.map(p => p.id);
    const i = Math.max(0, ids.indexOf(ap[w] ?? curPanel(w)));
    return setPanel({ windowId: w, panel: ids[(i + (cmd === 'next-panel' ? 1 : -1) + ids.length) % ids.length] });
  }
  if (cmd === 'new-child-tab') return newTab({ windowId: w, panel: panelOf(meta[tab.id], cfg), parent: tab.id });
  if (cmd === 'toggle-branch') return handlers.collapse({ id: tab.id });
  if (cmd === 'close-branch') return handlers.closeBranch({ ids: [tab.id] });
  if (cmd === 'snapshot') return snapshot('Manual');
});
