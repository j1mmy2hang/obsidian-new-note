'use strict';

const { Plugin, PluginSettingTab, Setting, Notice, TFile, moment, normalizePath } = require('obsidian');

/**
 * New Note: one plugin that makes a new note, start to finish.
 *
 * This used to be three plugins, each acting at a different moment:
 *   Timestamp New Note  named the file            (at 0 ms)
 *   Templater           wrote the frontmatter     (after a fixed 300 ms wait)
 *   Note UID Generator  added `uid`               (after a 500 ms debounce)
 * so a new note showed up empty and then changed twice in front of you.
 *
 * Now the name and the full content are decided before the file exists and
 * written in one `vault.create`. Nothing waits and nothing is written twice.
 *
 * The content comes from two ordinary template notes you edit like any other
 * note: one for notes, one for todos. Placeholders, in core Templates syntax:
 *   {{date}} {{date:FORMAT}} {{time}} {{time:FORMAT}} {{title}} {{uid}}
 * plus {{content}}, which is empty here. With it, the same template also works
 * as an iOS Quick Capture template, where it becomes the captured text.
 *
 * The single patch point is FileManager.createNewFile(parent, name, ext, data).
 * Every way of making a note in the UI calls it: Cmd+N, the explorer's
 * "New note" button, the folder context menu, new-in-pane, clicking a link
 * to a note that doesn't exist yet, and mobile quick capture. The "Untitled"
 * label is chosen inside it, so filling in `name` beforehand keeps Obsidian's
 * own open-and-select-title behaviour exactly as it is.
 *
 *   - An unnamed markdown note gets a timestamp title.
 *   - A markdown note created empty gets the note template. If a caller
 *     passes its own content (Excalidraw, daily notes), that content is kept.
 *   - The "New todo" command (Cmd+J) runs the same core command as Cmd+N, so
 *     it opens, places and selects the title the same way. Only the template
 *     is different.
 *
 * iOS Quick Capture writes notes from outside the app, so none of the above
 * runs for it. It fills its own placeholders, leaves `uid: {{uid}}` as typed,
 * and names the note "Untitled", "Untitled 1", ... So on every device, at
 * startup and whenever a note is created, changes or syncs in, the plugin
 * tidies such a note: it fills the uid and renames it to the timestamp of its
 * creation time.
 */

const DEFAULT_SETTINGS = {
  noteTemplate: 'asset/template/New Note Template.md',
  todoTemplate: 'asset/template/New Todo Template.md',
};

// What an unnamed note is called. If two notes are made in the same minute,
// the second gets the seconds format rather than Obsidian's "... 1".
const TITLE_FORMAT = 'YYYYMMDDHHmm';
const TITLE_TAKEN_FORMAT = 'YYYYMMDDHHmmss';

const DATE_FORMAT = 'YYYY-MM-DD';
const TIME_FORMAT = 'HH:mm';

// `uid`: 4-character nanoid, never one another note already has.
const UID_KEY = 'uid';
const UID_LENGTH = 4;
const UID_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

// Used only when a template file is missing, so making a note never fails.
const FALLBACK_TEMPLATES = {
  note: '---\ncreated: {{date}}\ntags:\ndescriptive:\nuid: {{uid}}\n---\n',
  todo: '---\ndo date:\ndue date:\ndescriptive:\n  - todo\nuid: {{uid}}\n---\n',
};

module.exports = class NewNotePlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.addSettingTab(new NewNoteSettingTab(this.app, this));

    // Kind of note the next creation should become. Set by a command just
    // before it calls core, used up synchronously on entry to the patch.
    this.pendingKind = null;

    const fileManager = this.app.fileManager;
    const original = fileManager.createNewFile;

    fileManager.createNewFile = async (parent, name, extension, data) => {
      const kind = this.pendingKind || 'note';
      this.pendingKind = null;

      if (this.isMarkdown(name, extension)) {
        if (!name) name = this.timestampTitle(parent) || name;
        if (!data && !this.inTemplateFolder(parent)) {
          data = await this.content(kind, name);
        }
      }
      return original.call(fileManager, parent, name, extension, data);
    };
    this.register(() => {
      fileManager.createNewFile = original;
    });

    // uids handed out this session, so two notes filled back to back can't
    // get the same one before the metadata cache has caught up.
    this.issuedUids = new Set();
    // Notes being tidied, and notes that changed meanwhile and need one more
    // pass (e.g. the metadata cache reading a new note's frontmatter while it
    // was being renamed). Keyed by TFile, which keeps its identity on rename.
    this.tidying = new Set();
    this.tidyAgain = new Set();

    // Registered after layout-ready: during startup the vault fires `create`
    // for every existing file, and the scan below covers those instead.
    this.app.workspace.onLayoutReady(() => {
      this.registerEvent(this.app.metadataCache.on('changed', (file) => this.tidyCapturedNote(file)));
      this.registerEvent(this.app.vault.on('create', (file) => this.tidyCapturedNote(file)));
      for (const file of this.app.vault.getMarkdownFiles()) this.tidyCapturedNote(file);
    });

    this.addCommand({
      id: 'new-todo',
      name: 'New todo',
      callback: () => this.createLikeCmdN('todo'),
    });
  }

  /**
   * Create a note exactly as Cmd+N does (same folder, same new tab, title
   * selected), but from `kind`'s template.
   *
   * Core's createAndOpenMarkdownFile reaches createNewFile synchronously,
   * before its first `await`, so the patch reads `pendingKind` within this
   * call. Clearing it in `finally` means a failed call can't leave it set for
   * an unrelated note later.
   */
  createLikeCmdN(kind) {
    this.pendingKind = kind;
    try {
      const ran = this.app.commands.executeCommandById('file-explorer:new-file');
      if (!ran) {
        // File explorer core plugin is off: call what its command calls.
        this.app.fileManager.createAndOpenMarkdownFile('', 'tab');
      }
    } finally {
      this.pendingKind = null;
    }
  }

  // Core decides the extension the same way: the explicit one, else the
  // name's own if Obsidian knows that type, else markdown.
  isMarkdown(name, extension) {
    if (extension) return extension === 'md';
    const dot = name ? name.lastIndexOf('.') : -1;
    if (dot <= 0) return true;
    const ext = name.slice(dot + 1);
    return !(ext !== 'md' && this.app.fileManager.fileParentCreatorByType?.hasOwnProperty(ext));
  }

  // Notes made inside the core Templates folder are templates, not notes.
  inTemplateFolder(parent) {
    const folder = this.app.internalPlugins.getPluginById('templates')?.instance?.options?.folder;
    if (!folder || !parent || !parent.path) return false;
    const root = folder.replace(/^\/+|\/+$/g, '');
    return root !== '' && (parent.path === root || parent.path.startsWith(root + '/'));
  }

  async content(kind, title) {
    const path = kind === 'todo' ? this.settings.todoTemplate : this.settings.noteTemplate;
    const file = path && this.app.vault.getAbstractFileByPath(normalizePath(path));
    let template;
    if (file instanceof TFile) {
      template = await this.app.vault.cachedRead(file);
    } else {
      new Notice(`New Note: template "${path}" not found. Using the built-in one.`);
      template = FALLBACK_TEMPLATES[kind] || FALLBACK_TEMPLATES.note;
    }
    return this.fill(template, title || '');
  }

  fill(template, title) {
    const now = moment();
    let uid = null; // made once, only if the template asks for it
    // {{content}} is Quick Capture's captured text. A new note has none, so it
    // goes, with its line break, rather than leaving an extra empty line.
    return template.replace(/\{\{\s*content\s*\}\}(\r?\n)?/gi, '').replace(/\{\{\s*(date|time|title|uid)\s*(?::([^}]*))?\}\}/gi, (_, key, format) => {
      switch (key.toLowerCase()) {
        case 'date': return now.format(format?.trim() || DATE_FORMAT);
        case 'time': return now.format(format?.trim() || TIME_FORMAT);
        case 'title': return title;
        case 'uid': return (uid = uid || this.newUid());
      }
    });
  }

  /**
   * Finish a note that Quick Capture (or anything else outside the app) left
   * half-done. One note at a time, so the fill and the rename can't overlap.
   */
  async tidyCapturedNote(file) {
    if (!(file instanceof TFile) || file.extension !== 'md') return;
    if (this.inTemplateFolder(file.parent)) return;
    if (this.tidying.has(file)) {
      this.tidyAgain.add(file);
      return;
    }
    this.tidying.add(file);
    try {
      await this.fillUidPlaceholder(file);
      await this.renameUntitled(file);
    } catch (err) {
      console.error('New Note: could not tidy', file.path, err);
    } finally {
      this.tidying.delete(file);
      if (this.tidyAgain.delete(file) && file.parent) this.tidyCapturedNote(file);
    }
  }

  /**
   * "Untitled", "Untitled 1", "Untitled (1)" → the creation-time timestamp,
   * with the same same-minute fallback as a new note. The timestamp comes from
   * the file's ctime, so on whichever device does it, the name says when the
   * note was captured, not when it was tidied. renameFile updates links.
   */
  async renameUntitled(file) {
    if (!/^untitled(?: ?\(?\d+\)?)?$/i.test(file.basename)) return;
    const when = moment(file.stat.ctime || Date.now());
    let name = when.format(TITLE_FORMAT);
    if (this.noteExists(file.parent, name)) name = when.format(TITLE_TAKEN_FORMAT);
    if (this.noteExists(file.parent, name)) return; // leave it rather than guess
    await this.app.fileManager.renameFile(file, file.parent.getParentPrefix() + name + '.md');
  }

  /**
   * Replace an unfilled `{{uid}}` in a note's frontmatter with a real uid.
   *
   * YAML reads `uid: {{uid}}` as a one-key object, `{ "{ uid }": null }`, so
   * the metadata cache finds candidates without reading any file. The text is
   * then checked and changed in one `vault.process`, touching only the
   * frontmatter block. Templates are skipped: they hold the placeholder on
   * purpose.
   */
  async fillUidPlaceholder(file) {
    const value = this.app.metadataCache.getFileCache(file)?.frontmatter?.[UID_KEY];
    if (!isUidPlaceholder(value)) return;
    await this.app.vault.process(file, (text) => {
      const block = /^---\r?\n[\s\S]*?\r?\n---(?=\r?\n|$)/.exec(text);
      if (!block) return text;
      const filled = block[0].replace(/\{\{\s*uid\s*\}\}/gi, () => this.newUid());
      return filled + text.slice(block[0].length);
    });
  }

  // A uid no note in the vault already has. With 62^4 ≈ 14.8M values and a
  // few thousand notes, the loop almost never runs twice.
  newUid() {
    const taken = new Set(this.issuedUids);
    for (const file of this.app.vault.getMarkdownFiles()) {
      const uid = this.app.metadataCache.getFileCache(file)?.frontmatter?.[UID_KEY];
      if (uid != null) taken.add(String(uid));
    }
    for (;;) {
      const uid = this.randomUid();
      if (!taken.has(uid)) {
        this.issuedUids.add(uid);
        return uid;
      }
    }
  }

  // Bytes past the last whole multiple of the alphabet size are skipped, so
  // every character is equally likely.
  randomUid() {
    const n = UID_ALPHABET.length;
    const limit = 256 - (256 % n);
    let uid = '';
    while (uid.length < UID_LENGTH) {
      for (const b of crypto.getRandomValues(new Uint8Array(UID_LENGTH * 2))) {
        if (b < limit && uid.length < UID_LENGTH) uid += UID_ALPHABET[b % n];
      }
    }
    return uid;
  }

  timestampTitle(parent) {
    const now = moment();
    const name = now.format(TITLE_FORMAT);
    if (!this.noteExists(parent, name)) return name;
    const fallback = now.format(TITLE_TAKEN_FORMAT);
    return this.noteExists(parent, fallback) ? name : fallback; // core adds " 1"
  }

  noteExists(parent, name) {
    const folder = parent || this.app.vault.getRoot();
    return this.app.vault.getAbstractFileByPath(folder.getParentPrefix() + name + '.md') !== null;
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
};

// `uid: {{uid}}` as YAML parses it, or the string if it was quoted.
function isUidPlaceholder(value) {
  if (typeof value === 'string') return /^\{\{\s*uid\s*\}\}$/i.test(value.trim());
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 1 && /^\{\s*uid\s*\}$/i.test(keys[0]) && value[keys[0]] == null;
}

class NewNoteSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    this.containerEl.empty();

    this.containerEl.createEl('p', {
      text: 'Placeholders: {{date}}, {{date:YYYY-MM-DD}}, {{time}}, {{title}}, {{uid}}.',
      cls: 'setting-item-description',
    });

    this.addPathSetting('noteTemplate', 'Note template', 'Used for Cmd+N, the "New note" button, links to new notes and quick capture.');
    this.addPathSetting('todoTemplate', 'Todo template', 'Used for the "New todo" command.');
  }

  addPathSetting(key, name, desc) {
    new Setting(this.containerEl)
      .setName(name)
      .setDesc(desc)
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS[key])
          .setValue(this.plugin.settings[key])
          .onChange(async (value) => {
            this.plugin.settings[key] = value.trim() || DEFAULT_SETTINGS[key];
            await this.plugin.saveSettings();
          })
      );
  }
}
