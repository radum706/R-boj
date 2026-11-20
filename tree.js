// Shared by background and sidebar. Tree is derived from native tab order + meta[tabId].p,
// so native drags in Brave's own tab strip can never corrupt it: an invalid parent just makes a root.
const DEFAULTS = {
  panels: [
    { id: 'default', name: 'Tabs', color: '#7c8cff', icon: 'tabs' },
    { id: 'bookmarks', name: 'Bookmarks', color: '#e0a030', type: 'bookmarks', icon: 'bookmark' },
  ],
  nest: true,                    // nest tabs under their opener
  closeCollapsedBranch: true,    // closing a collapsed parent closes its branch
  onParentClose: 'promote',      // 'promote' children to grandparent | 'close' them
  switchPanelOnActivate: true,   // follow the active tab to its panel
  activateLastOnPanelSwitch: true,
  density: 'normal',             // 'compact' | 'normal'
  indent: 14,
  showCount: true,
  css: '',
  snapInterval: 30,              // minutes, 0 = off
  snapKeep: 20,
  restoreUnloaded: true,         // restored snapshot tabs stay unloaded until clicked
};

const tabPanels = cfg => cfg.panels.filter(p => p.type !== 'bookmarks');

function panelOf(m, cfg) {
  const ps = tabPanels(cfg);
  return m && ps.some(p => p.id === m.panel) ? m.panel : ps[0].id;
}

// tabs: one window, in index order. Returns visible-order nodes for one panel.
function buildTree(tabs, meta, cfg, panelId) {
  const out = [], stack = [];
  for (const tab of tabs) {
    if (tab.pinned) continue;
    const m = meta[tab.id] || {};
    if (panelOf(m, cfg) !== panelId) continue;
    const at = m.p == null ? -1 : stack.findIndex(n => n.tab.id === m.p);
    stack.length = at + 1;
    const parent = stack[stack.length - 1];
    const node = {
      tab, depth: stack.length, parent: parent ? parent.tab.id : null,
      collapsed: !!m.c, hidden: !!parent && (parent.collapsed || parent.hidden), desc: 0,
    };
    for (const n of stack) n.desc++;
    stack.push(node);
    out.push(node);
  }
  return out;
}

// Pinned tabs shown in a panel: the global ones (meta.g) in every panel, the others only in their own.
function pinnedFor(tabs, meta, cfg, panelId) {
  const pinned = tabs.filter(t => t.pinned);
  return {
    global: pinned.filter(t => meta[t.id]?.g),
    panel: pinned.filter(t => !meta[t.id]?.g && panelOf(meta[t.id], cfg) === panelId),
  };
}

// Node plus all descendants, in order.
const subtree = (nodes, i) => nodes.slice(i, i + 1 + nodes[i].desc);

if (typeof module !== 'undefined') module.exports = { DEFAULTS, panelOf, tabPanels, buildTree, subtree, pinnedFor };
