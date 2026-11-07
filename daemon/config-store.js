/**
 * AuraPet daemon - file-backed app config store.
 *
 * Single writer for `app-settings.json` (same schema as v1.5.2). Every write is
 * atomic (tmp file + rename) so a crash mid-save cannot truncate the config, and
 * the pre-migration file is copied to `<name>.bak` once before the first write.
 *
 * Plain Node only: this module must stay free of `electron` so it can move into
 * the headless daemon unchanged.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = 1;
const CONFIG_MODE = 0o600;

function writeFileAtomic(filePath, contents, mode = CONFIG_MODE) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.tmp`);
  const fd = fs.openSync(tmpPath, 'w', mode);
  try {
    fs.writeFileSync(fd, contents);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, filePath);
  try {
    fs.chmodSync(filePath, mode);
  } catch {
    /* chmod is best effort (some filesystems ignore it) */
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {{ dir: string, file?: string }} options
 *   dir: directory that holds the config file (Electron's userData in v1.x)
 */
function createConfigStore(options = {}) {
  const { dir, file = 'app-settings.json' } = options;
  if (!dir) throw new TypeError('createConfigStore requires a directory');

  const filePath = path.join(dir, file);
  const backupPath = `${filePath}.bak`;
  let backupChecked = false;
  let data = readFromDisk();

  function readFromDisk() {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return isPlainObject(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  // Runs once, before the first write, so the on-disk format the user came from
  // stays recoverable even if the migration goes wrong.
  function ensureMigrationBackup() {
    if (backupChecked) return;
    backupChecked = true;
    if (fs.existsSync(backupPath) || !fs.existsSync(filePath)) return;
    try {
      fs.copyFileSync(filePath, backupPath);
      fs.chmodSync(backupPath, CONFIG_MODE);
    } catch (err) {
      console.warn('Could not back up app settings:', err.message);
    }
  }

  const store = {
    dir,
    filePath,
    backupPath,
    schemaVersion: SCHEMA_VERSION,

    get(key) {
      return data[key];
    },

    getAll() {
      return { ...data };
    },

    /** Merge a patch into the config and persist it atomically. */
    patch(patch) {
      if (!isPlainObject(patch)) return store.getAll();
      const next = { ...data };
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) continue;
        next[key] = value;
      }
      next.schemaVersion = SCHEMA_VERSION;
      ensureMigrationBackup();
      try {
        writeFileAtomic(filePath, `${JSON.stringify(next, null, 2)}\n`);
        data = next;
      } catch (err) {
        console.warn('Could not save app settings:', err.message);
      }
      return store.getAll();
    },

    set(key, value) {
      return store.patch({ [key]: value });
    }
  };

  return store;
}

module.exports = {
  CONFIG_MODE,
  SCHEMA_VERSION,
  createConfigStore,
  writeFileAtomic
};
