// SPDX-FileCopyrightText: 2026 chai-in
// SPDX-License-Identifier: AGPL-3.0-only

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { discoverGames } = require('game-shelf-save-slots');

async function temp(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'save-slots-portable-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

class MemoryStorage {
  constructor(entries = []) {
    this.values = new Map(entries);
  }

  get length() { return this.values.size; }
  key(index) { return [...this.values.keys()][index] ?? null; }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(String(key), String(value)); }
  clear() { this.values.clear(); }
}

test('discovers local HTML in deterministic order while leaving the files unchanged', async t => {
  const root = await temp(t);
  const gameHTML = '<!doctype html><title>Garden</title><button>Plant a seed</button>';
  for (const dir of ['levels', '.git', 'node_modules']) await fs.mkdir(path.join(root, dir));
  await fs.writeFile(path.join(root, 'levels', 'garden.HTM'), gameHTML);
  await fs.writeFile(path.join(root, 'start.html'), '<!doctype html><title>Start</title>');
  await fs.writeFile(path.join(root, 'instructions.txt'), 'Plant a seed.');
  await fs.writeFile(path.join(root, '.git', 'ignored.html'), gameHTML);
  await fs.writeFile(path.join(root, 'node_modules', 'ignored.html'), gameHTML);
  assert.deepEqual(await discoverGames(root), ['levels/garden.HTM', 'start.html']);
  assert.equal(await fs.readFile(path.join(root, 'levels', 'garden.HTM'), 'utf8'), gameHTML);
});

test('rejects paths through symlinks and names unsafe on Windows', { skip: process.platform === 'win32' }, async t => {
  const root = await temp(t);
  const outside = await temp(t);
  await fs.writeFile(path.join(outside, 'unlisted.html'), '<title>Unlisted</title>');
  const link = path.join(root, 'outside');
  await fs.symlink(outside, link, 'dir');
  await assert.rejects(discoverGames(root), /Symbolic link/);
  await fs.unlink(link);
  await fs.writeFile(path.join(root, 'NUL.html'), '');
  await assert.rejects(discoverGames(root), /Unsafe filename/);
});

test('Web Storage snapshots round-trip both stores and preserve unusual keys', async () => {
  const { snapshotWebStorage, restoreWebStorage } = await import('game-shelf-save-slots/web-storage');
  const local = new MemoryStorage([['score', '4'], ['__proto__', 'ordinary key']]);
  const session = new MemoryStorage([['level', '2']]);
  const data = snapshotWebStorage({ local, session, passage: 'Garden' });
  const parsed = JSON.parse(data);
  assert.equal(parsed.local.__proto__, 'ordinary key');
  assert.equal(parsed.passage, 'Garden');
  local.setItem('old', 'removed on restore');
  session.setItem('level', '9');
  restoreWebStorage(data, { local, session });
  assert.equal(snapshotWebStorage({ local, session, passage: 'Garden' }), data);
});

test('Web Storage restore validates both snapshots before replacing either store', async () => {
  const { restoreWebStorage } = await import('game-shelf-save-slots/web-storage');
  const local = new MemoryStorage([['score', '4']]);
  const session = new MemoryStorage([['level', '2']]);
  const invalid = '{"schema":1,"adapter":"web-storage","local":{"score":"7"},"session":{"level":9}}';
  assert.throws(() => restoreWebStorage(invalid, { local, session }), /values must be strings/);
  assert.equal(local.getItem('score'), '4');
  assert.equal(session.getItem('level'), '2');
});

test('Web Storage restore rolls both stores back on a failed write', async () => {
  const { restoreWebStorage } = await import('game-shelf-save-slots/web-storage');
  const local = new MemoryStorage([['score', '4']]);
  const session = new MemoryStorage([['level', '2']]);
  session.setItem = (key, value) => {
    if (value === 'too large') throw new Error('Quota exceeded');
    MemoryStorage.prototype.setItem.call(session, key, value);
  };
  const data = '{"schema":1,"adapter":"web-storage","local":{"score":"7"},"session":{"level":"too large"}}';
  assert.throws(() => restoreWebStorage(data, { local, session }), /Quota exceeded/);
  assert.deepEqual([...local.values], [['score', '4']]);
  assert.deepEqual([...session.values], [['level', '2']]);
});
