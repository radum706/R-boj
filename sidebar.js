const $ = s => document.querySelector(s);
const send = msg => chrome.runtime.sendMessage(msg);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const store = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

let winId, cfg = DEFAULTS, meta = {}, ap = {}, tabs = [], nodes = [], visible = [];
let sel = new Set(), anchor = null, query = '', lastActive = null;
let lastTabPanel = store.get('lastTabPanel', null);
const bmOpen = new Set(store.get('bmOpen', ['1']));

const curPanel = () => cfg.panels.find(p => p.id === ap[winId]) || cfg.panels[0];
const tabPanel = () => panelOf({ panel: curPanel().type === 'bookmarks' ? lastTabPanel : curPanel().id }, cfg);
const tabById = id => tabs.find(t => t.id === id);
const nodeById = id => nodes.find(n => n.tab.id === id);
const favicon = (url, fav) => fav && /^(https?|data):/.test(fav) ? fav
  : chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(url || '')}&size=32`);

// ---------- render ----------
let rt;
const schedule = () => { clearTimeout(rt); rt = setTimeout(render, 16); };

async function render() {
  const [l, s, t] = await Promise.all([
    chrome.storage.local.get('cfg'), chrome.storage.session.get(['meta', 'ap']), chrome.tabs.query({ windowId: winId }),
  ]);
  cfg = { ...DEFAULTS, ...l.cfg }; meta = s.meta || {}; ap = s.ap || {}; tabs = t;
  document.documentElement.dataset.density = cfg.density;
  document.documentElement.style.setProperty('--indent', cfg.indent + 'px');
  document.documentElement.style.setProperty('--accent', curPanel().color);
  $('#user-css').textContent = cfg.css;
  const live = new Set(tabs.map(x => x.id));
  sel = new Set([...sel].filter(id => live.has(id)));
  if (curPanel().type !== 'bookmarks' && lastTabPanel !== curPanel().id) store.set('lastTabPanel', lastTabPanel = curPanel().id);

  renderPanels();
  renderPinned();
  if (curPanel().type === 'bookmarks') return renderBookmarks();
  nodes = buildTree(tabs, meta, cfg, curPanel().id);
  renderTabs();
}

function renderPanels() {
  const counts = {};
  for (const t of tabs) if (!t.pinned) { const p = panelOf(meta[t.id], cfg); counts[p] = (counts[p] || 0) + 1; }
  $('#panels').replaceChildren(...cfg.panels.map(p => {
    const b = el('button', 'panel' + (p.id === curPanel().id ? ' on' : ''));
    b.style.setProperty('--pc', p.color);
    b.dataset.panel = p.id;
    b.title = p.name;
    b.append(el('span', 'dot'), el('span', '', p.name));
    if (p.type !== 'bookmarks') b.append(el('span', 'n', counts[p.id] || 0));
    return b;
  }), Object.assign(el('button', 'panel add', '+'), { title: 'Add panel' }));
}

function renderPinned() {
  $('#pinned').replaceChildren(...tabs.filter(t => t.pinned).map(t => {
    const b = el('button', 'pin' + (t.active ? ' active' : ''));
    b.dataset.id = t.id;
    b.title = t.title;
    b.draggable = true;
    b.append(Object.assign(el('img', 'fav'), { src: favicon(t.url, t.favIconUrl) }));
    return b;
  }));
}

function row(n, flat) {
  const t = n.tab;
  const d = el('div', 'row');
  d.classList.toggle('active', t.active);
  d.classList.toggle('sel', sel.has(t.id));
  d.classList.toggle('discarded', !!t.discarded);
  d.classList.toggle('loading', t.status === 'loading');
  d.dataset.id = t.id;
  d.draggable = true;
  d.title = `${t.title}\n${t.url}`;
  d.style.setProperty('--d', flat ? 0 : n.depth);
  d.append(el('span', 'tw', n.desc && !flat ? (n.collapsed ? '▶' : '▼') : ''));
  d.append(Object.assign(el('img', 'fav'), { src: favicon(t.url, t.favIconUrl) }));
  d.append(el('span', 'title', t.title || t.url));
  if (t.audible || t.mutedInfo?.muted) d.append(el('button', 'audio', t.mutedInfo?.muted ? '🔇' : '🔊'));
  if (n.collapsed && n.desc && cfg.showCount) d.append(el('span', 'count', n.desc));
  d.append(Object.assign(el('button', 'x', '×'), { title: 'Close' }));
  return d;
}

function renderTabs() {
  const q = query.toLowerCase();
  visible = q ? nodes.filter(n => `${n.tab.title} ${n.tab.url}`.toLowerCase().includes(q)) : nodes.filter(n => !n.hidden);
  const list = $('#list');
  list.replaceChildren(...visible.map(n => row(n, !!q)));
  if (!visible.length) list.append(el('div', 'empty', q ? 'No matches' : 'No tabs in this panel'));
  const act = tabs.find(t => t.active)?.id;
  if (act !== lastActive) {
    lastActive = act;
    list.querySelector('.row.active')?.scrollIntoView({ block: 'nearest' });
  }
}

async function renderBookmarks() {
  const list = $('#list');
  const out = [];
  const q = query.trim();
  if (q) {
    for (const b of (await chrome.bookmarks.search(q)).filter(b => b.url)) out.push(bmRow(b, 0));
  } else {
    const [root] = await chrome.bookmarks.getTree();
    const walk = (node, depth) => {
      for (const c of node.children || []) {
        out.push(bmRow(c, depth));
        if (c.children && bmOpen.has(c.id)) walk(c, depth + 1);
      }
    };
    walk(root, 0);
  }
  list.replaceChildren(...out);
  if (!out.length) list.append(el('div', 'empty', 'No bookmarks'));
}

function bmRow(b, depth) {
  const d = el('div', 'row bm' + (b.children ? ' folder' : ''));
  d.dataset.bm = b.id;
  if (b.url) d.dataset.url = b.url;
  d.title = b.url || b.title;
  d.style.setProperty('--d', depth);
  d.append(el('span', 'tw', b.children ? (bmOpen.has(b.id) ? '▼' : '▶') : ''));
  d.append(b.children ? el('span', 'fav', '📁') : Object.assign(el('img', 'fav'), { src: favicon(b.url) }));
  d.append(el('span', 'title', b.title || b.url));
  return d;
}

// ---------- context menu ----------
function menu(x, y, items) {
  const box = $('#ctx');
  box.replaceChildren();
  for (const it of items.filter(Boolean)) {
    if (it === '-') box.append(el('hr'));
    else if (it.header) box.append(el('div', 'hd', it.header));
    else if (it.input) {
      const i = Object.assign(el('input'), { type: it.input, value: it.value });
      i.addEventListener('change', () => it.fn(i.value));
      i.addEventListener('keydown', e => { if (e.key === 'Enter') { it.fn(i.value); hideMenu(); } });
      box.append(i);
    } else {
      const b = el('button', 'it' + (it.sub ? ' sub' : ''), it.label);
      b.addEventListener('click', () => { hideMenu(); it.fn(); });
      box.append(b);
    }
  }
  box.hidden = false;
  const r = box.getBoundingClientRect();
  box.style.left = Math.max(0, Math.min(x, innerWidth - r.width - 4)) + 'px';
  box.style.top = Math.max(0, Math.min(y, innerHeight - r.height - 4)) + 'px';
}
const hideMenu = () => { $('#ctx').hidden = true; };

function tabMenu(e, id) {
  if (!sel.has(id)) { sel = new Set([id]); renderTabs(); }
  const ids = [...sel], t = tabById(id), n = nodeById(id), panel = curPanel().id;
  const each = fn => () => ids.forEach(fn);
  const others = tabPanels(cfg).filter(p => p.id !== panel);
  menu(e.clientX, e.clientY, [
    ids.length === 1 && !t.pinned && { label: 'New child tab', fn: () => send({ type: 'newTab', windowId: winId, panel, parent: id }) },
    { label: 'Reload', fn: each(i => chrome.tabs.reload(i)) },
    { label: 'Duplicate', fn: each(i => chrome.tabs.duplicate(i)) },
    { label: t.pinned ? 'Unpin' : 'Pin', fn: each(i => chrome.tabs.update(i, { pinned: !t.pinned })) },
    { label: t.mutedInfo?.muted ? 'Unmute' : 'Mute', fn: each(i => chrome.tabs.update(i, { muted: !t.mutedInfo?.muted })) },
    { label: 'Unload', fn: each(i => chrome.tabs.discard(i).catch(() => {})) },
    { label: 'Copy URL', fn: () => navigator.clipboard.writeText(ids.map(i => tabById(i).url).join('\n')) },
    { label: 'Bookmark', fn: each(i => chrome.bookmarks.create({ title: tabById(i).title, url: tabById(i).url })) },
    '-',
    others.length && { header: 'Move to panel' },
    ...others.map(p => ({ label: p.name, sub: true, fn: () => send({ type: 'toPanel', ids, panel: p.id }) })),
    { label: 'Move to new window', fn: () => send({ type: 'toWindow', ids }) },
    '-',
    n?.desc && { label: n.collapsed ? 'Expand branch' : 'Collapse branch', fn: () => send({ type: 'collapse', id }) },
    { label: 'Collapse all', fn: () => send({ type: 'collapseAll', windowId: winId, panel, value: true }) },
    { label: 'Expand all', fn: () => send({ type: 'collapseAll', windowId: winId, panel, value: false }) },
    '-',
    n?.desc && { label: 'Close branch', fn: () => send({ type: 'closeBranch', ids }) },
    ids.length === 1 && n && { label: 'Close tabs below', fn: () => send({ type: 'closeBelow', id, windowId: winId, panel }) },
    n && { label: 'Close other tabs', fn: () => send({ type: 'closeOthers', ids, windowId: winId, panel }) },
    { label: ids.length > 1 ? `Close ${ids.length} tabs` : 'Close', fn: () => chrome.tabs.remove(ids) },
  ]);
}

async function saveCfg(next) {
  cfg = next;
  await chrome.storage.local.set({ cfg });
}

function panelMenu(e, id) {
  const p = cfg.panels.find(x => x.id === id);
  const upd = patch => saveCfg({ ...cfg, panels: cfg.panels.map(x => x.id === id ? { ...x, ...patch } : x) });
  const isTabs = p.type !== 'bookmarks';
  menu(e.clientX, e.clientY, [
    { header: 'Name' }, { input: 'text', value: p.name, fn: v => v.trim() && upd({ name: v.trim() }) },
    { header: 'Color' }, { input: 'color', value: p.color, fn: v => upd({ color: v }) },
    '-',
    isTabs && { label: 'Collapse all', fn: () => send({ type: 'collapseAll', windowId: winId, panel: id, value: true }) },
    isTabs && { label: 'Expand all', fn: () => send({ type: 'collapseAll', windowId: winId, panel: id, value: false }) },
    isTabs && { label: 'Close all tabs in panel', fn: () => chrome.tabs.remove(buildTree(tabs, meta, cfg, id).map(n => n.tab.id)) },
    (!isTabs || tabPanels(cfg).length > 1) && { label: 'Delete panel (tabs move to first panel)', fn: () => saveCfg({ ...cfg, panels: cfg.panels.filter(x => x.id !== id) }) },
  ]);
}

const PALETTE = ['#7c8cff', '#38b2ac', '#e0a030', '#e5534b', '#9f7aea', '#48bb78', '#ed64a6', '#4299e1'];
async function addPanel() {
  const id = 'p' + Date.now().toString(36);
  await saveCfg({ ...cfg, panels: [...cfg.panels, { id, name: `Panel ${tabPanels(cfg).length + 1}`, color: PALETTE.find(c => !cfg.panels.some(p => p.color === c)) || PALETTE[0] }] });
  send({ type: 'setPanel', windowId: winId, panel: id });
}

// ---------- events ----------
const rowOf = e => e.target.closest('.row');
const idOf = r => r && +r.dataset.id;

$('#list').addEventListener('mousedown', e => { if (e.button === 1) e.preventDefault(); });
$('#list').addEventListener('click', e => {
  const r = rowOf(e);
  if (!r) return;
  if (r.dataset.bm) return bmClick(e, r);
  const id = idOf(r), t = tabById(id);
  if (e.target.closest('.tw')) return send({ type: 'collapse', id });
  if (e.target.closest('.x')) return closeIds(id);
  if (e.target.closest('.audio')) return chrome.tabs.update(id, { muted: !t.mutedInfo?.muted });
  if (e.ctrlKey || e.metaKey) {
    sel.has(id) ? sel.delete(id) : sel.add(id);
    anchor = id;
    return renderTabs();
  }
  if (e.shiftKey && anchor != null) {
    const ids = visible.map(n => n.tab.id), a = ids.indexOf(anchor), b = ids.indexOf(id);
    sel = new Set(ids.slice(Math.min(a, b), Math.max(a, b) + 1));
    return renderTabs();
  }
  sel.clear();
  anchor = id;
  if (query) { query = $('#search').value = ''; }
  chrome.tabs.update(id, { active: true });
  schedule();
});
$('#list').addEventListener('auxclick', e => {
  const r = rowOf(e);
  if (e.button !== 1 || !r) return;
  if (r.dataset.url) return send({ type: 'newTab', windowId: winId, panel: tabPanel(), url: r.dataset.url, active: false });
  if (!r.dataset.bm) closeIds(idOf(r));
});
$('#list').addEventListener('dblclick', e => {
  const r = rowOf(e);
  if (!r) return send({ type: 'newTab', windowId: winId, panel: tabPanel() });
  if (!r.dataset.bm && nodeById(idOf(r))?.desc) send({ type: 'collapse', id: idOf(r) });
});
$('#list').addEventListener('contextmenu', e => {
  e.preventDefault();
  const r = rowOf(e);
  if (r && !r.dataset.bm) return tabMenu(e, idOf(r));
  if (r?.dataset.bm && !r.dataset.url) return menu(e.clientX, e.clientY, [{ label: 'Open all in new tabs', fn: () => openFolder(r.dataset.bm) }]);
  if (!r) moreMenu(e);
});

function closeIds(id) {
  chrome.tabs.remove(sel.has(id) && sel.size > 1 ? [...sel] : [id]);
}

function bmClick(e, r) {
  if (!r.dataset.url) {
    const id = r.dataset.bm;
    bmOpen.has(id) ? bmOpen.delete(id) : bmOpen.add(id);
    store.set('bmOpen', [...bmOpen]);
    return renderBookmarks();
  }
  send({ type: 'newTab', windowId: winId, panel: tabPanel(), url: r.dataset.url, active: !(e.ctrlKey || e.metaKey) });
}

async function openFolder(id) {
  for (const b of (await chrome.bookmarks.getChildren(id)).filter(b => b.url)) {
    await send({ type: 'newTab', windowId: winId, panel: tabPanel(), url: b.url, active: false });
  }
}

// panels bar
$('#panels').addEventListener('click', e => {
  const b = e.target.closest('.panel');
  if (!b) return;
  if (b.classList.contains('add')) return addPanel();
  sel.clear();
  send({ type: 'setPanel', windowId: winId, panel: b.dataset.panel });
});
$('#panels').addEventListener('contextmenu', e => {
  e.preventDefault();
  const b = e.target.closest('.panel[data-panel]');
  if (b) panelMenu(e, b.dataset.panel);
});
$('#panels').addEventListener('wheel', e => { $('#panels').scrollLeft += e.deltaY; }, { passive: true });

// pinned
$('#pinned').addEventListener('click', e => { const b = e.target.closest('.pin'); if (b) chrome.tabs.update(+b.dataset.id, { active: true }); });
$('#pinned').addEventListener('auxclick', e => { const b = e.target.closest('.pin'); if (b && e.button === 1) chrome.tabs.remove(+b.dataset.id); });
$('#pinned').addEventListener('contextmenu', e => { e.preventDefault(); const b = e.target.closest('.pin'); if (b) tabMenu(e, +b.dataset.id); });

// header
$('#new').addEventListener('click', () => send({ type: 'newTab', windowId: winId, panel: tabPanel() }));
$('#more').addEventListener('click', e => moreMenu(e));
function moreMenu(e) {
  const panel = curPanel().id;
  menu(e.clientX, e.clientY, [
    { label: 'New tab', fn: () => send({ type: 'newTab', windowId: winId, panel: tabPanel() }) },
    { label: 'Collapse all', fn: () => send({ type: 'collapseAll', windowId: winId, panel, value: true }) },
    { label: 'Expand all', fn: () => send({ type: 'collapseAll', windowId: winId, panel, value: false }) },
    '-',
    { label: 'Snapshot now', fn: () => send({ type: 'snapshot', label: 'Manual' }) },
    { label: 'Settings & snapshots', fn: () => chrome.runtime.openOptionsPage() },
  ]);
}
$('#search').addEventListener('input', e => { query = e.target.value; render(); });
$('#search').addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    const first = $('#list .row');
    if (first) first.click();
    $('#search').blur();
  }
  if (e.key === 'Escape') { query = e.target.value = ''; e.target.blur(); render(); }
});

document.addEventListener('mousedown', e => { if (!e.target.closest('#ctx')) hideMenu(); });
window.addEventListener('blur', hideMenu);

// keyboard
document.addEventListener('keydown', e => {
  if (e.target.matches('input')) return;
  if (e.key === 'Escape') { hideMenu(); sel.clear(); return renderTabs(); }
  if (e.key === '/' || (e.key === 'f' && (e.ctrlKey || e.metaKey))) { e.preventDefault(); return $('#search').focus(); }
  if (curPanel().type === 'bookmarks') return;
  const act = tabs.find(t => t.active), i = visible.findIndex(n => n.tab.id === act?.id), n = visible[i];
  const go = m => m && chrome.tabs.update(m.tab.id, { active: true });
  if (e.key === 'ArrowDown') { e.preventDefault(); go(visible[i + 1]); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); go(visible[Math.max(0, i - 1)]); }
  else if (e.key === 'ArrowLeft' && n) n.desc && !n.collapsed ? send({ type: 'collapse', id: n.tab.id, value: true }) : go(nodeById(n.parent));
  else if (e.key === 'ArrowRight' && n?.collapsed) send({ type: 'collapse', id: n.tab.id, value: false });
  else if (e.key === 'Delete' && act) closeIds(sel.size ? [...sel][0] : act.id);
});

// ---------- drag & drop ----------
const MIME = 'application/x-raboj';
let dragIds = null;

document.addEventListener('dragstart', e => {
  const r = e.target.closest('.row[data-id], .pin');
  if (!r) return;
  const id = +r.dataset.id;
  dragIds = sel.has(id) ? [...sel] : [id];
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData(MIME, JSON.stringify(dragIds));
  e.dataTransfer.setData('text/uri-list', dragIds.map(i => tabById(i)?.url).filter(Boolean).join('\n'));
});
document.addEventListener('dragend', () => { dragIds = null; clearDrop(); });

const clearDrop = () => document.querySelectorAll('.drop-before,.drop-after,.drop-child,.drop').forEach(x => x.classList.remove('drop-before', 'drop-after', 'drop-child', 'drop'));
function zone(e, r) {
  const b = r.getBoundingClientRect(), y = (e.clientY - b.top) / b.height;
  return y < .25 ? 'before' : y > .75 ? 'after' : 'child';
}
const accepts = e => e.dataTransfer.types.includes(MIME) || e.dataTransfer.types.includes('text/uri-list');

document.addEventListener('dragover', e => {
  if (!accepts(e)) return;
  const pb = e.target.closest('.panel[data-panel]');
  const r = e.target.closest('#list .row[data-id], #pinned .pin');
  if (!pb && !r && !e.target.closest('#list')) return;
  e.preventDefault();
  clearDrop();
  if (pb) pb.classList.add('drop');
  else if (r?.classList.contains('row')) r.classList.add('drop-' + zone(e, r));
});

document.addEventListener('drop', async e => {
  if (!accepts(e)) return;
  e.preventDefault();
  clearDrop();
  const ours = e.dataTransfer.getData(MIME);
  const ids = ours ? JSON.parse(ours) : null;
  const urls = ours ? [] : e.dataTransfer.getData('text/uri-list').split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#'));
  const pb = e.target.closest('.panel[data-panel]');
  const pin = e.target.closest('#pinned .pin');
  const r = e.target.closest('#list .row[data-id]');

  if (pb) {
    const p = cfg.panels.find(x => x.id === pb.dataset.panel);
    if (p.type === 'bookmarks') return;
    if (ids) return send({ type: 'toPanel', ids, panel: p.id });
    for (const url of urls) await send({ type: 'newTab', windowId: winId, panel: p.id, url, active: false });
    return;
  }
  if (pin && ids) {
    await Promise.all(ids.map(i => chrome.tabs.update(i, { pinned: true })));
    return chrome.tabs.move(ids, { windowId: winId, index: tabById(+pin.dataset.id).index });
  }
  if (curPanel().type === 'bookmarks') return;
  const target = r ? +r.dataset.id : null, pos = r ? zone(e, r) : 'end';
  if (ids) {
    if (ids.some(i => tabById(i)?.pinned)) {
      await Promise.all(ids.map(i => chrome.tabs.update(i, { pinned: false })));
    }
    return send({ type: 'move', ids, target, pos, windowId: winId, panel: curPanel().id });
  }
  for (const url of urls) {
    const n = target != null && nodeById(target);
    await send({ type: 'newTab', windowId: winId, panel: curPanel().id, url, parent: pos === 'child' ? target : n ? n.parent : undefined });
  }
});

// ---------- init ----------
(async () => {
  winId = (await chrome.windows.getCurrent()).id;
  for (const ev of ['onCreated', 'onRemoved', 'onUpdated', 'onMoved', 'onActivated', 'onAttached', 'onDetached', 'onReplaced']) chrome.tabs[ev].addListener(schedule);
  for (const ev of ['onCreated', 'onRemoved', 'onChanged', 'onMoved']) chrome.bookmarks[ev].addListener(() => curPanel().type === 'bookmarks' && schedule());
  chrome.storage.onChanged.addListener(schedule);
  render();
})();
