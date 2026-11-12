'use strict';

const { Plugin, moment } = require('obsidian');

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
 * The single patch point is FileManager.createNewFile(parent, name, ext, data).
 * Every way of making a note in the UI calls it: Cmd+N, the explorer's
 * "New note" button, the folder context menu, new-in-pane, and clicking a link
 * to a note that doesn't exist yet. The "Untitled" label is chosen inside it,
 * so filling in `name` beforehand keeps Obsidian's own open-and-select-title
 * behaviour exactly as it is.
 *
 *   - An unnamed markdown note gets a timestamp title.
 *   - A markdown note created empty gets the note frontmatter. If a caller
 *     passes its own content (Excalidraw, daily notes), that content is kept.
 *   - The "New todo" command (Cmd+J) runs the same core command as Cmd+N, so
 *     it opens, places and selects the title the same way. Only the content
 *     is different.
 */

// What an unnamed note is called. If two notes are made in the same minute,
// the second gets the seconds format rather than Obsidian's "... 1".
const TITLE_FORMAT = 'YYYYMMDDHHmm';
const TITLE_TAKEN_FORMAT = 'YYYYMMDDHHmmss';

// `uid`: same shape as Note UID Generator made (nanoid, 4 characters).
const UID_KEY = 'uid';
const UID_LENGTH = 4;
const UID_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

// The frontmatter for each kind of note, in order. `null` is an empty value,
// an array is a YAML list. `uid` is added last.
const KINDS = {
  note: () => [
    ['created', moment().format('YYYY-MM-DD')],
    ['tags', null],
    ['descriptive', null],
  ],
  todo: () => [
    ['do date', null],
    ['due date', null],
    ['descriptive', ['todo']],
  ],
};

module.exports = class NewNotePlugin extends Plugin {
  async onload() {
    // Kind of note the next unnamed creation should become. Set by a command
    // just before it calls core, used up within the same synchronous call.
    this.pendingKind = null;

    const fileManager = this.app.fileManager;
    const original = fileManager.createNewFile;

    fileManager.createNewFile = (parent, name, extension, data) => {
      const kind = this.pendingKind || 'note';
      this.pendingKind = null;

      if (this.isMarkdown(name, extension)) {
        if (!name) name = this.timestampTitle(parent) || name;
        if (!data && !this.inTemplateFolder(parent)) data = this.content(kind);
      }
      return original.call(fileManager, parent, name, extension, data);
    };
    this.register(() => {
      fileManager.createNewFile = original;
    });

    this.addCommand({
      id: 'new-todo',
      name: 'New todo',
      callback: () => this.createLikeCmdN('todo'),
    });
  }

  /**
   * Create a note exactly as Cmd+N does (same folder, same new tab, title
   * selected), but with `kind`'s content.
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

  content(kind) {
    const fields = (KINDS[kind] || KINDS.note)();
    fields.push([UID_KEY, this.newUid()]);

    const lines = ['---'];
    for (const [key, value] of fields) {
      if (Array.isArray(value)) {
        lines.push(`${key}:`, ...value.map((item) => `  - ${item}`));
      } else {
        lines.push(value == null ? `${key}:` : `${key}: ${value}`);
      }
    }
    lines.push('---', '');
    return lines.join('\n');
  }

  // A uid no note in the vault already has. With 62^4 ≈ 14.8M values and a
  // few thousand notes, the loop almost never runs twice.
  newUid() {
    const taken = new Set();
    for (const file of this.app.vault.getMarkdownFiles()) {
      const uid = this.app.metadataCache.getFileCache(file)?.frontmatter?.[UID_KEY];
      if (uid != null) taken.add(String(uid));
    }
    for (;;) {
      const uid = this.randomUid();
      if (!taken.has(uid)) return uid;
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
};
