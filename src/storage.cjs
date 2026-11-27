// SPDX-FileCopyrightText: 2026 chai-in
// SPDX-License-Identifier: AGPL-3.0-only

'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { promisify } = require('node:util');
const zlib = require('node:zlib');

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);
const maxBytes = 32 * 1024 * 1024;
const adapters = new Set(['sugarcube', 'web-storage']);
const idPattern = /^[a-zA-Z0-9-]{1,80}$/;
const uuidPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const digestPattern = /^[a-f0-9]{64}$/;

const hash = value => createHash('sha256').update(value).digest('hex');
const matches = (pattern, value) => typeof value === 'string' && pattern.test(value);

async function writeSynced(file, data, flags) {
  const handle = await fs.open(file, flags, 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function atomicWrite(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeSynced(temp, data, 'wx');
    await fs.rename(temp, file);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

function validateCatalog(catalog) {
  const invalid = () => new Error('The save-slot catalog is damaged or uses an unsupported version.');
  if (catalog?.version !== 1 || !Array.isArray(catalog.games)) throw invalid();
  const games = new Set();
  const slots = new Set();
  for (const game of catalog.games) {
    if (!matches(idPattern, game?.id) || games.has(game.id) || typeof game.revision !== 'string' ||
      !game.revision || !Array.isArray(game.slots)) throw invalid();
    games.add(game.id);
    for (const slot of game.slots) {
      if (!matches(uuidPattern, slot?.id) || slots.has(slot.id) || typeof slot.name !== 'string' ||
        typeof slot.createdAt !== 'string') throw invalid();
      if (slot.parent !== null && (!matches(uuidPattern, slot.parent?.slotId) ||
        !matches(uuidPattern, slot.parent?.checkpointId))) throw invalid();
      slots.add(slot.id);
    }
  }
}

async function readCatalog(root) {
  let data;
  try {
    data = await fs.readFile(path.join(root, 'catalog.json'), 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const entries = await fs.readdir(root);
    if (['history', 'objects', 'library.json'].some(name => entries.includes(name))) {
      throw new Error('The save-slot catalog is missing. Use a dedicated save-slot directory.');
    }
    return { version: 1, games: [] };
  }

  let catalog;
  try {
    catalog = JSON.parse(data);
  } catch (error) {
    throw new Error('The save-slot catalog is damaged.', { cause: error });
  }
  validateCatalog(catalog);
  return catalog;
}

function parseCheckpoint(data) {
  if (typeof data !== 'string' || !data.isWellFormed()) {
    throw new TypeError('Checkpoint data must be a UTF-8 encodable JSON string.');
  }
  if (Buffer.byteLength(data) > maxBytes) throw new RangeError('Checkpoint exceeds the 32 MiB limit.');
  const parsed = JSON.parse(data);
  if (parsed?.schema !== 1 || !adapters.has(parsed.adapter)) {
    throw new Error('Unsupported checkpoint format.');
  }
  return parsed;
}

async function readJournal(file, revision, repair = false) {
  const raw = await fs.readFile(file);
  const boundary = raw.lastIndexOf(10) + 1;
  const complete = raw.subarray(0, boundary);
  const tail = raw.subarray(boundary);
  const rows = [];
  const ids = new Set();

  function addRow(row) {
    if (!matches(uuidPattern, row?.id) || ids.has(row.id) || !matches(digestPattern, row.digest) ||
      row.revision !== revision || row.previous !== (rows.at(-1)?.id ?? null) ||
      !adapters.has(row.adapter) || typeof row.timestamp !== 'string' ||
      typeof row.label !== 'string' || typeof row.passage !== 'string' ||
      (row.bookmark !== undefined && row.bookmark !== true)) {
      throw new Error('A checkpoint history record is damaged.');
    }
    ids.add(row.id);
    rows.push(row);
  }

  for (const line of complete.toString('utf8').split('\n').slice(0, -1)) {
    addRow(JSON.parse(line));
  }
  if (tail.length === 0) return rows;
  if (!repair) throw new Error('Checkpoint history has an unterminated record. Reopen the store.');

  // Save torn bytes before repairing the journal. A valid record missing its newline is retained.
  let row;
  try {
    row = JSON.parse(tail.toString('utf8'));
  } catch {
    await atomicWrite(`${file}.torn-${randomUUID()}`, tail);
    await atomicWrite(file, complete);
    return rows;
  }
  addRow(row);
  await atomicWrite(file, Buffer.concat([raw, Buffer.from('\n')]));
  return rows;
}

function makeRow(revision, previous, digest, state, label, bookmark = false) {
  return {
    id: randomUUID(),
    digest,
    timestamp: new Date().toISOString(),
    label: String(label).slice(0, 100),
    passage: String(state.passage || '').slice(0, 160),
    adapter: state.adapter,
    revision,
    previous,
    ...(bookmark ? { bookmark: true } : {}),
  };
}

class Store {
  #root;
  #catalog;
  #heads = new Map();
  #pending = Promise.resolve();
  #writeError;

  constructor(root, catalog) {
    this.#root = root;
    this.#catalog = catalog;
  }

  static async open(directory) {
    const root = path.resolve(directory);
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const store = new Store(root, await readCatalog(root));
    for (const game of store.#catalog.games) {
      for (const slot of game.slots) {
        const rows = await readJournal(store.#journal(slot.id), game.revision, true);
        store.#heads.set(slot.id, rows.at(-1) ?? null);
      }
    }
    return store;
  }

  #enqueue(task) {
    const next = this.#pending.then(() => {
      if (this.#writeError) {
        throw new Error('A journal write was interrupted. Reopen the store.', { cause: this.#writeError });
      }
      return task();
    });
    this.#pending = next.catch(() => {});
    return next;
  }

  #game(id) {
    const game = this.#catalog.games.find(item => item.id === id);
    if (!game) throw new Error('Game not found.');
    return game;
  }

  #slot(game, id) {
    const slot = game.slots.find(item => item.id === id);
    if (!slot) throw new Error('Save slot not found.');
    return slot;
  }

  #journal(id) {
    return path.join(this.#root, 'history', `${id}.jsonl`);
  }

  #object(digest) {
    return path.join(this.#root, 'objects', digest.slice(0, 2), `${digest}.json.gz`);
  }

  async #readObject(digest) {
    const compressed = await fs.readFile(this.#object(digest));
    const raw = await gunzip(compressed, { maxOutputLength: maxBytes }).catch(error => {
      throw new Error('Checkpoint could not be decompressed.', { cause: error });
    });
    if (hash(raw) !== digest) throw new Error('Checkpoint integrity check failed.');
    return raw.toString('utf8');
  }

  async #commitCatalog(games) {
    const catalog = { version: 1, games };
    await atomicWrite(path.join(this.#root, 'catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`);
    this.#catalog = catalog;
  }

  registerGame(id, revision) {
    return this.#enqueue(async () => {
      if (!matches(idPattern, id) || typeof revision !== 'string' || !revision) {
        throw new TypeError('Expected a game ID and a nonempty revision string.');
      }
      const existing = this.#catalog.games.find(game => game.id === id);
      if (existing?.revision === revision) return;
      if (existing) throw new Error('Game ID is already registered with another revision.');
      await this.#commitCatalog([...this.#catalog.games, { id, revision, slots: [] }]);
    });
  }

  listSlots(gameId) {
    return this.#enqueue(() => this.#game(gameId).slots.map(slot => this.#slotWithHead(slot)));
  }

  #slotWithHead(slot) {
    return structuredClone({ ...slot, head: this.#heads.get(slot.id) });
  }

  async #addSlot(game, name, parent, initialRow) {
    const slot = {
      id: randomUUID(),
      name: String(name || `Slot ${game.slots.length + 1}`).slice(0, 80),
      createdAt: new Date().toISOString(),
      parent,
    };
    await atomicWrite(this.#journal(slot.id), initialRow ? `${JSON.stringify(initialRow)}\n` : '');
    await this.#commitCatalog(this.#catalog.games.map(item => (
      item === game ? { ...game, slots: [...game.slots, slot] } : item
    )));
    this.#heads.set(slot.id, initialRow);
    return this.#slotWithHead(slot);
  }

  createSlot(gameId, name) {
    return this.#enqueue(() => this.#addSlot(this.#game(gameId), name, null, null));
  }

  history(gameId, slotId) {
    return this.#enqueue(() => {
      const game = this.#game(gameId);
      const slot = this.#slot(game, slotId);
      return readJournal(this.#journal(slot.id), game.revision);
    });
  }

  async #findCheckpoint(game, slot, checkpointId) {
    const rows = await readJournal(this.#journal(slot.id), game.revision);
    const row = rows.find(item => item.id === checkpointId);
    if (!row) throw new Error('Checkpoint not found in this slot.');
    return row;
  }

  readCheckpoint(gameId, slotId, checkpointId) {
    return this.#enqueue(async () => {
      const game = this.#game(gameId);
      const row = await this.#findCheckpoint(game, this.#slot(game, slotId), checkpointId);
      return { row, data: await this.#readObject(row.digest) };
    });
  }

  async #append(slot, row) {
    try {
      // The catalog holds slot metadata. The journal is the sole source for the head.
      await writeSynced(this.#journal(slot.id), `${JSON.stringify(row)}\n`, constants.O_WRONLY | constants.O_APPEND);
    } catch (error) {
      this.#writeError = error;
      throw error;
    }
    this.#heads.set(slot.id, row);
    return structuredClone(row);
  }

  checkpoint(gameId, slotId, data, { label = 'Action', force = false, bookmark = false } = {}) {
    return this.#enqueue(async () => {
      const game = this.#game(gameId);
      const slot = this.#slot(game, slotId);
      const state = parseCheckpoint(data);
      const digest = hash(data);
      const head = this.#heads.get(slot.id);
      try {
        await this.#readObject(digest);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        await atomicWrite(this.#object(digest), await gzip(data, { level: 6 }));
      }
      if (!force && !bookmark && head?.digest === digest) return structuredClone(head);
      return this.#append(slot, makeRow(game.revision, head?.id ?? null, digest, state, label, bookmark));
    });
  }

  restore(gameId, slotId, checkpointId) {
    return this.#enqueue(async () => {
      const game = this.#game(gameId);
      const slot = this.#slot(game, slotId);
      const selected = await this.#findCheckpoint(game, slot, checkpointId);
      await this.#readObject(selected.digest);
      const row = makeRow(game.revision, this.#heads.get(slot.id).id, selected.digest, selected, 'Restored from history');
      return this.#append(slot, row);
    });
  }

  branch(gameId, slotId, checkpointId, name) {
    return this.#enqueue(async () => {
      const game = this.#game(gameId);
      const selected = await this.#findCheckpoint(game, this.#slot(game, slotId), checkpointId);
      await this.#readObject(selected.digest);
      const row = makeRow(game.revision, null, selected.digest, selected, 'Branched from history');
      return this.#addSlot(game, name || `Branch ${game.slots.length + 1}`, { slotId, checkpointId }, row);
    });
  }
}

module.exports = { Store };
