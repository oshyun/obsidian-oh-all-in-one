# 0h All In One

An Obsidian plugin that bundles small but useful quality-of-life features for daily note-taking.

Requires Obsidian 1.13.0 or later (settings are built on the declarative settings API).

## Features

### Delete Empty New Note

Automatically deletes a newly created note when you navigate away without typing anything.
A 10-second notice with an undo link appears after deletion so you can restore it instantly.

### Pin

Pin files and folders to the top of their parent folder in the file explorer.
A pin icon appears next to pinned items.
Right-click any file or folder to pin or unpin it.

### Hide

Hide files and folders from the file explorer using `.gitignore`-style glob patterns.

Example patterns:

```
*.excalidraw.md
_templates/
.trash/
```

### Home Note

Automatically opens a designated note when all tabs are closed.

### Tab List

Adds a tab list button to the view header for quickly switching between open tabs.
Works on both desktop and mobile: switch tabs, toggle pin, and reorder by dragging.
On touch devices, tabs can also be closed by swiping.

### Collapse Children

Collapse all sub-folders inside a folder at once.

- **Desktop**: Hold `Alt` (Mac: `⌥ Opt`) and click a folder.
- **Mobile / context menu**: Long-press a folder and tap "Collapse all sub-folders".

### Global Hotkeys

Register system-wide keyboard shortcuts that trigger Obsidian commands even when Obsidian is running in the background. Desktop only.

## Installation

### Community Plugins (recommended)

Search for `0h All In One` in **Settings → Community Plugins → Browse**.

### Manual

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](../../releases/latest).
2. Copy them into `<vault>/.obsidian/plugins/oh-all-in-one/`.
3. Enable the plugin in **Settings → Community Plugins**.

## License

[MIT](LICENSE)
