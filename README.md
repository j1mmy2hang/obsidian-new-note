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

- **Every new note**: Cmd+N, the "New note" button, the folder menu, or
  clicking a link to a note that doesn't exist yet. It gets:

  ```yaml
  ---
  created: 2026-11-12
  tags:
  descriptive:
  uid: pUCq
  ---
  ```

- **New todo** command (bind it to a hotkey, e.g. Cmd+J). It opens exactly like
  Cmd+N, with this frontmatter instead:

  ```yaml
  ---
  do date:
  due date:
  descriptive:
    - todo
  uid: QIW9
  ---
  ```

- An unnamed note is titled `YYYYMMDDHHmm`. A second note made in the same
  minute gets `YYYYMMDDHHmmss`.
- A `uid` is 4 characters from `0-9A-Za-z`, never one another note already has.
- Notes created with their own content (Excalidraw, daily notes) and notes made
  inside the core Templates folder are left as they are.

The fields are defined at the top of `main.js`.

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
