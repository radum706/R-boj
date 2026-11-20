const $ = s => document.querySelector(s);
let cfg = DEFAULTS;

const load = async () => structuredClone({ ...DEFAULTS, ...(await chrome.storage.local.get('cfg')).cfg });
const save = () => chrome.storage.local.set({ cfg });

function download(name, data) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

let onFile;
const pickFile = fn => { onFile = fn; $('#file').value = ''; $('#file').click(); };
$('#file').addEventListener('change', async e => {
  const f = e.target.files[0];
  if (!f) return;
  try { await onFile(JSON.parse(await f.text())); } catch (err) { $('#file').title = String(err); }
});

// ---------- simple fields ----------
function fill() {
  for (const i of document.querySelectorAll('[data-k]')) {
    const v = cfg[i.dataset.k];
    if (i.type === 'checkbox') i.checked = !!v; else i.value = v;
  }
  renderPanels();
}
let t;
document.addEventListener('input', e => {
  const i = e.target.closest('[data-k]');
  if (!i) return;
  cfg[i.dataset.k] = i.type === 'checkbox' ? i.checked : i.type === 'number' ? +i.value : i.value;
  clearTimeout(t);
  t = setTimeout(save, 250);
});

// ---------- panels ----------
function renderPanels() {
  const box = $('#panels-ed');
  box.replaceChildren(...cfg.panels.map((p, i) => {
    const r = document.createElement('div');
    r.className = 'prow';
    const name = Object.assign(document.createElement('input'), { type: 'text', value: p.name });
    name.addEventListener('change', () => { p.name = name.value.trim() || p.name; save(); });
    const color = Object.assign(document.createElement('input'), { type: 'color', value: p.color });
    color.addEventListener('change', () => { p.color = color.value; save(); });
    const kind = Object.assign(document.createElement('small'), { textContent: p.type === 'bookmarks' ? 'bookmarks' : 'tabs' });
    kind.style.color = 'var(--muted)';
    const btn = (label, fn, disabled) => Object.assign(document.createElement('button'), { className: 'btn', textContent: label, disabled, onclick: fn });
    const swap = j => { [cfg.panels[i], cfg.panels[j]] = [cfg.panels[j], cfg.panels[i]]; save(); renderPanels(); };
    const lastTabs = p.type !== 'bookmarks' && tabPanels(cfg).length === 1;
    r.append(color, name, kind,
      btn('↑', () => swap(i - 1), i === 0),
      btn('↓', () => swap(i + 1), i === cfg.panels.length - 1),
      btn('Delete', () => { cfg.panels.splice(i, 1); save(); renderPanels(); }, lastTabs));
    return r;
  }));
  $('#add-bm').disabled = cfg.panels.some(p => p.type === 'bookmarks');
}
$('#add-panel').onclick = () => {
  cfg.panels.push({ id: 'p' + Date.now().toString(36), name: `Panel ${tabPanels(cfg).length + 1}`, color: '#38b2ac' });
  save(); renderPanels();
};
$('#add-bm').onclick = () => {
  cfg.panels.push({ id: 'bookmarks', name: 'Bookmarks', color: '#e0a030', type: 'bookmarks' });
  save(); renderPanels();
};

// ---------- snapshots ----------
async function renderSnaps() {
  const { snaps = [] } = await chrome.storage.local.get('snaps');
  const box = $('#snaps');
  if (!snaps.length) {
    box.replaceChildren(Object.assign(document.createElement('p'), { className: 'note', textContent: 'No snapshots yet.' }));
    return;
  }
  box.replaceChildren(...snaps.map((s, i) => {
    const r = document.createElement('div');
    r.className = 'snap';
    const info = document.createElement('div');
    info.className = 'info';
    const n = s.windows.reduce((a, w) => a + w.tabs.length, 0);
    info.append(`${new Date(s.time).toLocaleString()} · ${s.label}`, document.createElement('br'),
      Object.assign(document.createElement('small'), { textContent: `${s.windows.length} window(s), ${n} tabs` }));
    const btn = (label, fn) => Object.assign(document.createElement('button'), { className: 'btn', textContent: label, onclick: fn });
    r.append(info,
      btn('Restore', () => chrome.runtime.sendMessage({ type: 'restoreSnapshot', i })),
      btn('Export', () => download(`raboj-snapshot-${s.time}.json`, s)),
      btn('Delete', async () => { snaps.splice(i, 1); await chrome.storage.local.set({ snaps }); }));
    return r;
  }));
}
$('#snap-now').onclick = () => chrome.runtime.sendMessage({ type: 'snapshot', label: 'Manual' });
$('#snap-import').onclick = () => pickFile(async s => {
  if (!Array.isArray(s.windows)) throw new Error('Not a snapshot file');
  const { snaps = [] } = await chrome.storage.local.get('snaps');
  snaps.unshift({ ...s, label: 'Imported', panels: s.panels || [] });
  await chrome.storage.local.set({ snaps });
});

// ---------- backup ----------
$('#exp').onclick = () => download('raboj-settings.json', cfg);
$('#imp').onclick = () => pickFile(async c => {
  if (!Array.isArray(c.panels) || !c.panels.some(p => p.type !== 'bookmarks')) throw new Error('Not a settings file');
  cfg = { ...DEFAULTS, ...c };
  await save();
});
$('#reset').onclick = async () => { cfg = structuredClone(DEFAULTS); await save(); };

chrome.storage.onChanged.addListener(async (ch, area) => {
  if (area !== 'local') return;
  if (ch.snaps) renderSnaps();
  if (ch.cfg && !document.activeElement?.matches('input,textarea,select')) { cfg = await load(); fill(); }
});

(async () => { cfg = await load(); fill(); renderSnaps(); })();
