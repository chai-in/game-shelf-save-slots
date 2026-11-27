// SPDX-FileCopyrightText: 2026 chai-in
// SPDX-License-Identifier: AGPL-3.0-only

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { gzipSync } = require('node:zlib');
const { Store } = require('game-shelf-save-slots');

const game = 'garden';
const save = score => JSON.stringify({
  schema: 1,
  adapter: 'web-storage',
  passage: 'Courtyard',
  local: { score: String(score) },
  session: {},
});

async function seed(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'save-slots-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = await Store.open(root);
  await store.registerGame(game, 'r1');
  const slot = await store.createSlot(game, 'Original');
  const journal = path.join(root, 'history', `${slot.id}.jsonl`);
  return { root, store, slot, journal };
}

test('serializes distinct checkpoints, deduplicates equal payloads, and retains bookmarks', async t => {
  const { store, slot } = await seed(t);
  const rows = await Promise.all(Array.from({ length: 20 }, (_, i) => store.checkpoint(game, slot.id, save(i))));
  assert.deepEqual(await store.checkpoint(game, slot.id, save(19)), rows[19]);
  const named = await store.checkpoint(game, slot.id, save(19), { bookmark: true, label: 'Found a key' });
  const forced = await store.checkpoint(game, slot.id, save(19), { force: true });
  assert.equal(rows[0].previous, null);
  assert.equal(rows[19].previous, rows[18].id);
  assert.equal(named.previous, rows[19].id);
  assert.equal(named.bookmark, true);
  assert.equal(named.label, 'Found a key');
  assert.equal(named.digest, rows[19].digest);
  assert.equal(forced.previous, named.id);
  assert.deepEqual(await store.history(game, slot.id), [...rows, named, forced]);
  assert.equal((await store.readCheckpoint(game, slot.id, rows[4].id)).data, save(4));
});

test('restores by appending and branches from older history with isolated lineage', async t => {
  const { root, store, slot } = await seed(t);
  const first = await store.checkpoint(game, slot.id, save(1));
  const future = await store.checkpoint(game, slot.id, save(2));
  const restored = await store.restore(game, slot.id, first.id);
  const branch = await store.branch(game, slot.id, first.id, 'Another route');
  const branchNext = await store.checkpoint(game, branch.id, save(3));

  assert.deepEqual(branch.parent, { slotId: slot.id, checkpointId: first.id });
  assert.equal(restored.previous, future.id);
  assert.equal(branch.head.previous, null);
  assert.equal(branch.head.digest, first.digest);
  assert.equal(restored.digest, first.digest);
  assert.equal((await store.readCheckpoint(game, slot.id, future.id)).data, save(2));
  await assert.rejects(store.readCheckpoint(game, branch.id, future.id), /not found/);
  await assert.rejects(store.branch(game, branch.id, future.id), /not found/);

  const reopened = await Store.open(root);
  assert.deepEqual(await reopened.listSlots(game), [{ ...slot, head: restored }, { ...branch, head: branchNext }]);
  assert.deepEqual(await reopened.history(game, slot.id), [first, future, restored]);
  assert.deepEqual(await reopened.history(game, branch.id), [branch.head, branchNext]);
  const objectFiles = (await fs.readdir(path.join(root, 'objects'), { recursive: true })).filter(file => file.endsWith('.gz'));
  assert.equal(objectFiles.length, 3);
});

test('serializes slot creation and keeps registered build revisions and games separate', async t => {
  const { store, slot } = await seed(t);
  await store.registerGame(game, 'r1');
  await assert.rejects(store.registerGame(game, 'r2'), /another revision/);
  await assert.rejects(store.registerGame('../outside', 'r1'), /game ID/);
  await store.registerGame('garden-r2', 'r2');
  const nextSlots = await Promise.all([store.createSlot(game), store.createSlot(game)]);
  assert.deepEqual(nextSlots.map(item => item.name), ['Slot 2', 'Slot 3']);
  assert.deepEqual(await store.listSlots(game), [slot, ...nextSlots]);
  await assert.rejects(store.history('garden-r2', slot.id), /slot not found/);
  const revisionSlot = await store.createSlot('garden-r2');
  const row = await store.checkpoint('garden-r2', revisionSlot.id, save(0));
  assert.equal(row.revision, 'r2');
  row.revision = 'corrupted by caller';
  assert.equal((await store.listSlots('garden-r2'))[0].head.revision, 'r2');
});

test('retains a complete tail without newline and saves torn bytes before repairing', async t => {
  const { root, store, slot, journal } = await seed(t);
  const row = await store.checkpoint(game, slot.id, save(5));
  const complete = await fs.readFile(journal);
  await fs.truncate(journal, complete.length - 1);
  const repaired = await Store.open(root);
  assert.equal((await repaired.listSlots(game))[0].head.id, row.id);
  assert.deepEqual(await fs.readFile(journal), complete);

  const torn = Buffer.concat([Buffer.from('{"label":"'), Buffer.from([0xf0, 0x9f])]);
  await fs.appendFile(journal, torn);
  const reopened = await Store.open(root);
  const savedTail = (await fs.readdir(path.dirname(journal))).find(file => file.includes('.torn-'));
  assert.deepEqual(await fs.readFile(path.join(path.dirname(journal), savedTail)), torn);
  assert.deepEqual(await fs.readFile(journal), complete);
  const next = await reopened.checkpoint(game, slot.id, save(6));
  assert.deepEqual(await reopened.history(game, slot.id), [row, next]);
});

test('reports corrupt payloads and preserves a slot when restore or branch fails', async t => {
  const { root, store, slot } = await seed(t);
  const row = await store.checkpoint(game, slot.id, save(3));
  const object = path.join(root, 'objects', row.digest.slice(0, 2), `${row.digest}.json.gz`);
  await fs.writeFile(object, 'damaged');
  await assert.rejects(store.readCheckpoint(game, slot.id, row.id), /decompressed/);
  await fs.writeFile(object, gzipSync(save(4)));
  await assert.rejects(store.restore(game, slot.id, row.id), /integrity/);
  await assert.rejects(store.branch(game, slot.id, row.id), /integrity/);
  await assert.rejects(store.checkpoint(game, slot.id, save(3)), /integrity/);
  assert.deepEqual(await store.history(game, slot.id), [row]);
  assert.equal((await store.listSlots(game)).length, 1);
});

test('keeps a full damaged journal record intact and refuses to open it', async t => {
  const { root, store, slot, journal } = await seed(t);
  await store.checkpoint(game, slot.id, save(1));
  await fs.appendFile(journal, '{"id":"bad"}\n');
  const original = await fs.readFile(journal);
  await assert.rejects(Store.open(root), /history record is damaged/);
  assert.deepEqual(await fs.readFile(journal), original);
});

test('fails safely when a journal vanishes and preserves history after reopening', async t => {
  const { root, store, slot, journal } = await seed(t);
  const first = await store.checkpoint(game, slot.id, save(0));
  await fs.rename(journal, `${journal}.saved`);
  await assert.rejects(Store.open(root), { code: 'ENOENT' });
  await assert.rejects(store.checkpoint(game, slot.id, save(1)), { code: 'ENOENT' });
  await assert.rejects(store.listSlots(game), /Reopen the store/);
  await fs.rename(`${journal}.saved`, journal);
  assert.deepEqual(await (await Store.open(root)).history(game, slot.id), [first]);
});

test('publishes a branch only when its catalog update succeeds', async t => {
  const { root, store, slot } = await seed(t);
  const first = await store.checkpoint(game, slot.id, save(1));
  const catalog = path.join(root, 'catalog.json');
  await fs.rename(catalog, `${catalog}.saved`);
  await fs.mkdir(catalog);
  await assert.rejects(store.branch(game, slot.id, first.id));
  assert.deepEqual(await store.listSlots(game), [{ ...slot, head: first }]);
  await fs.rmdir(catalog);
  await assert.rejects(Store.open(root), /catalog is missing/);
  await fs.rename(`${catalog}.saved`, catalog);
  const reopened = await Store.open(root);
  assert.deepEqual(await reopened.listSlots(game), [{ ...slot, head: first }]);
  assert.deepEqual(await reopened.history(game, slot.id), [first]);
});

test('validates the checkpoint envelope and retains opaque SugarCube data as supplied', async t => {
  const { store, slot } = await seed(t);
  await assert.rejects(store.checkpoint(game, slot.id, {}), /JSON string/);
  await assert.rejects(store.checkpoint(game, slot.id, 'null'), /Unsupported/);
  await assert.rejects(store.checkpoint(game, slot.id, '{'), SyntaxError);
  await assert.rejects(store.checkpoint(game, slot.id, 'x'.repeat(32 * 1024 * 1024 + 1)), /32 MiB/);
  const opaque = '{ "schema": 1, "adapter": "sugarcube", "passage": "Café", "active": { "variables": { "turn": 2 } } }';
  const row = await store.checkpoint(game, slot.id, opaque);
  assert.equal(row.passage, 'Café');
  assert.deepEqual(await store.readCheckpoint(game, slot.id, row.id), { row, data: opaque });
  assert.deepEqual(await store.history(game, slot.id), [row]);
});
