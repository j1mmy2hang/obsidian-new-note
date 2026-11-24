# New Note

An Obsidian plugin that makes a new note complete in one step: a timestamp
title (`202611121202`), selected and ready to type over, and its frontmatter
with a unique `uid`, all written in one go when the file is created.

Without it, the same result usually takes three plugins: one to name the note,
Templater to fill in the frontmatter, and a UID plugin to add the id. Each acts
at a different moment, so a new note opens empty and then changes twice.
Templater alone waits a fixed 300 ms before it writes.

Works on desktop and on mobile.

## What it does

The content comes from two ordinary template notes. Edit them like any other
note, and every new note after that follows. Set their paths in the plugin's
settings (defaults: `asset/template/New Note Template.md` and
`asset/template/New Todo Template.md`).

- **Note template**: used for every new note. That means Cmd+N, the "New note"
  button, the folder menu, mobile quick capture, and clicking a link to a note
  that doesn't exist yet. For example:

  ```yaml
  ---
  created: {{date}}
  tags:
  descriptive:
  uid: {{uid}}
  ---
  ```

- **Todo template**: used by the **New todo** command (bind it to a hotkey,
  e.g. Cmd+J). It opens exactly like Cmd+N.

Placeholders, in core Templates syntax: `{{date}}` (`YYYY-MM-DD`),
`{{date:FORMAT}}`, `{{time}}` (`HH:mm`), `{{time:FORMAT}}`, `{{title}}`, and
`{{uid}}`: 4 characters from `0-9A-Za-z`, never one another note already has.
`{{content}}` becomes nothing, so the same file can also serve as an iOS
Quick Capture template, where it becomes the captured text.

## iOS Quick Capture

Quick Capture saves notes from outside the app, so no plugin can run at capture
time. Point a Quick Capture Location at the note template: Quick Capture fills
`{{date}}`, `{{time}}` and `{{content}}` itself, leaves `uid: {{uid}}` as it is,
and names the note "Untitled", "Untitled 1", and so on.

New Note finishes such notes on every device, as soon as Obsidian runs: at
startup, and whenever a note is created, changes or syncs in. It replaces an
unfilled `{{uid}}` in the frontmatter with a real uid, and renames an
"Untitled" note to the timestamp of its creation time (`YYYYMMDDHHmm`). Links
to it are updated. Notes in the folder that
holds your templates are skipped.

## For other plugins

Plugins that make notes can hand the job to New Note, so every note is born
the same way:

```js
const file = await app.plugins.getPlugin('new-note')?.createNote({
  kind: 'todo',                          // 'note' (default) or 'todo'
  folder: 'today',                       // default: Obsidian's new-note folder
  name: 'Buy milk',                      // default: a timestamp title
  properties: { 'do date': '2026-11-15' },
});
```

The properties are merged into the template's frontmatter (a key the template
has is replaced in place, a new one is added at the end), and the file is
created in one write, so no other plugin ever sees it half-made.

## Install

The plugin is not in the community catalogue. Use
[BRAT](https://github.com/TfTHacker/obsidian42-brat):

1. Install **BRAT** from Community Plugins and enable it.
2. Run **BRAT: Add a beta plugin for testing** from the command palette.
3. Paste `j1mmy2hang/obsidian-new-note` and choose the latest version.
4. Enable **New Note** in Settings → Community Plugins.

To install by hand instead, copy `main.js` and `manifest.json` from the latest
release into `<vault>/.obsidian/plugins/new-note/`.

## How it works

Every way of making a note in Obsidian calls `FileManager.createNewFile(parent,
name, extension, data)`, and the "Untitled" label is chosen inside it. The
plugin fills in `name` and `data` before that call, so the file is created
complete and Obsidian's own opening and title selection stay unchanged.
