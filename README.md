# Răboj

A tab manager for Brave and other Chromium browsers, in the browser's side panel: tree tabs, panels, snapshots.

*A răboj is the old Romanian tally stick: every notch kept count of something. This one keeps count of your tabs.*

Tabs nest under the tab that opened them, so you can see where each one came from. You can collapse whole branches, group tabs into panels and save snapshots of your session. No build step and no dependencies: plain JavaScript, Manifest V3.

## Features

**Tree tabs**
- Tabs opened from a page nest under it
- Collapse and expand branches, with a count of the hidden tabs
- Closing a collapsed parent closes its whole branch (can be turned off)
- When a parent closes, its children either move up a level or close too (your choice)

**Drag and drop**
- Drop on a tab's top or bottom edge to place it beside that tab, in the middle to make it a child
- Drop on a panel's button to move the tab there
- Drop a link from a page to open it at that spot
- Drag several selected tabs at once

**Panels**
- Separate tab lists in each window, each with its own name and colour
- New tabs open in the panel you're viewing
- Tabs opened from a page stay in their parent's panel
- Optionally switch to a tab's panel when that tab is activated, and return to a panel's last tab when you come back to it

**Also**
- Pinned tabs shown as a row of icons at the top
- Bookmarks panel with folders
- Search with `/`
- Select several tabs with Ctrl or Shift click
- Right-click menu: new child tab, reload, duplicate, pin, mute, unload, copy URL, bookmark, move to panel or new window, close branch, close tabs below, close other tabs

**Snapshots**
- Automatic on a timer, or manual
- Restoring one brings back windows, panels and the tree
- Restored tabs stay unloaded until clicked (optional)
- Export and import as JSON

**Restarts**
- The tree survives browser restarts and extension reloads; it's rebuilt by matching tab URLs

**Customization**
- Normal or compact density, indent size, custom CSS
- Settings export and import

## Install

1. Download or clone this repository.
2. Open `brave://extensions` (or `chrome://extensions`) and turn on **Developer mode**.
3. Click **Load unpacked** and select the `raboj` folder.
4. Click the Răboj toolbar icon, or press `Alt+Shift+S`, to open the sidebar.

Tip: turn on Brave's vertical tabs and collapse them, so the native tab list takes less space.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Alt+Shift+S` | Open the sidebar |
| `Alt+Shift+←` / `→` | Previous / next panel |
| `Alt+Shift+T` | New child tab of the active tab |
| (unassigned) | Collapse branch, close branch, take snapshot |

Change them at `brave://extensions/shortcuts`.

Inside the sidebar:

| Key | Action |
|---|---|
| `↑` / `↓` | Switch to the previous / next tab |
| `←` / `→` | Collapse / expand, or go to the parent tab |
| `Del` | Close the selected tabs |
| `/` or `Ctrl+F` | Search |
| `Esc` | Clear search and selection |

## How it works

The tree isn't stored as its own structure. Each tab only stores its parent, panel and collapsed state; the tree is rebuilt from the browser's own tab order every time. Moving tabs in Brave's own tab bar therefore can't corrupt it: a tab whose parent no longer comes right before it simply becomes a top-level tab.

| File | Role |
|---|---|
| `tree.js` | Default settings and rebuilding the tree (shared code) |
| `background.js` | Tab events, moving tabs, panels, snapshots, restart recovery |
| `sidebar.*` | The side panel interface |
| `options.*` | Settings, snapshots, backup |

Run the tree test with `node test_tree.js`.

## Limitations

These come from Chromium and can't be fixed from an extension:

- Brave's own tab strip can't be hidden, and it shows the tabs of every panel.
- No containers per panel. Brave has its own containers (Settings → Brave Content), but no extension API for them yet.
- After a restart, if several tabs have exactly the same URL, a few can end up in the wrong place in the tree.

## Permissions

`tabs`, `storage`, `unlimitedStorage` (snapshots), `sidePanel`, `bookmarks`, `alarms` (auto snapshots), `favicon`. Nothing leaves your browser: no network requests, no tracking.

## License

MIT
