importScripts('tree.js');

// meta: tabId -> { p: parentTabId|null, c: collapsed, panel }
// ap: windowId -> active panel id,  la: panelId -> last active tabId
let cfg = DEFAULTS, meta = {}, ap = {}, la = {};
let restoreSrc = [], restoreMap = new Map();

const ready = (async () => {
  const l = await chrome.storage.local.get(['cfg', 'tree']);
  cfg = { ...DEFAULTS, ...l.cfg };
  const s = await chrome.storage.session.get(['meta', 'ap', 'la']);
  if (s.meta) {
    ({ meta } = s); ap = s.ap || {}; la = s.la || {};
  } else {
    // Fresh browser start or extension reload: tab ids changed (or not), rebuild tree from last persisted state.
    // Brave may still be restoring tabs, so retry a couple of times for tabs that only have default meta.
    restoreSrc = l.tree || [];
    await restore();
    setTimeout(() => restore(), 3000);
    setTimeout(() => restore(), 10000);
  }
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  setupAlarm();
})();

async function restore() {
  const tabs = await chrome.tabs.query({});
  const fresh = t => (!meta[t.id] || meta[t.id].auto) && ![...restoreMap.values()].includes(t.id);
  const byId = new Map(tabs.map(t => [t.id, t]));
  for (const s of restoreSrc) {
    const t = byId.get(s.id);
    if (!restoreMap.has(s.id) && t && t.url === s.u && fresh(t)) restoreMap.set(s.id, t.id);
  }
  const queue = new Map();
  for (const t of tabs) if (fresh(t)) queue.set(t.url, [...(queue.get(t.url) || []), t.id]);
  for (const s of restoreSrc) {
    const q = queue.get(s.u);
    if (!restoreMap.has(s.id) && q && q.length) restoreMap.set(s.id, q.shift());
  }
  for (const s of restoreSrc) {
    const id = restoreMap.get(s.id);
    if (id != null) meta[id] = { p: restoreMap.get(s.p) ?? null, c: s.c, panel: s.panel };
  }
  save();
}

let saveT, treeT;
function save() {
  clearTimeout(saveT);
  saveT = setTimeout(() => chrome.storage.session.set({ meta, ap, la }), 20);
  clearTimeout(treeT);
  treeT = setTimeout(persistTree, 1000);
}

async function persistTree() {
  const tabs = await chrome.tabs.query({});
  const live = new Set(tabs.map(t => t.id));
  for (const id in meta) if (!live.has(+id)) delete meta[id];
  await chrome.storage.local.set({
    tree: tabs.filter(t => meta[t.id]).map(t => ({
      id: t.id, u: t.url, p: meta[t.id].p ?? null, c: !!meta[t.id].c, panel: meta[t.id].panel,
    })),
  });
}

const winTabs = windowId => chrome.tabs.query({ windowId });
const curPanel = windowId => panelOf({ panel: ap[windowId] }, cfg);

// ---------- tab events ----------
chrome.tabs.onCreated.addListener(async tab => {
  await ready;
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
  await ready;
  if (info.isWindowClosing) return; // keep tree intact across shutdown
  const m = meta[id];
  if (!m) return;
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
  save();
});

chrome.tabs.onReplaced.addListener(async (added, removed) => {
  await ready;
  if (meta[removed]) meta[added] = meta[removed];
  delete meta[removed];
  for (const k in meta) if (meta[k].p === removed) meta[k].p = added;
  save();
});

chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  await ready;
  const panel = panelOf(meta[tabId], cfg);
  la[panel] = tabId;
  if (cfg.switchPanelOnActivate && cfg.panels.find(p => p.id === ap[windowId])?.type !== 'bookmarks') ap[windowId] = panel;
  // reveal the active tab if it sits inside a collapsed branch
  const nodes = buildTree(await winTabs(windowId), meta, cfg, panel);
  let n = nodes.find(x => x.tab.id === tabId);
  while (n && n.parent != null) {
    if (meta[n.parent]) meta[n.parent].c = false;
    n = nodes.find(x => x.tab.id === n.parent);
  }
  save();
});

chrome.tabs.onUpdated.addListener((id, change) => { if (change.url) save(); });
chrome.windows.onRemoved.addListener(async w => { await ready; delete ap[w]; save(); });

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
  for (const id of moved) ensure(id).panel = panel;
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

async function closeTabs(ids) {
  ids.forEach(id => delete meta[id]);
  save();
  await chrome.tabs.remove(ids).catch(() => {});
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
  const nodes = buildTree(await winTabs(windowId), meta, cfg, panel);
  const pick = nodes.find(n => n.tab.id === la[panel]) || nodes.find(n => !n.hidden);
  if (pick && !pick.tab.active) await chrome.tabs.update(pick.tab.id, { active: true });
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
      return { u: t.url, t: t.title, pin: t.pinned || undefined, panel: panelOf(meta[t.id], cfg), p: p < 0 ? undefined : p, c: meta[t.id]?.c || undefined };
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
        meta[nt.id] = { panel: t.panel, c: !!t.c };
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
  move, toPanel, toWindow, newTab, setPanel, collapseAll, restoreSnapshot,
  collapse: ({ id, value }) => { const m = ensure(id); m.c = value ?? !m.c; save(); },
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
