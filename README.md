# Game Shelf Save Slots

A local Node.js library for discovering HTML game entry files and keeping append-only save histories. It uses Node.js 22 or later and has zero npm dependencies.

## Run the example

From the package directory, run the following with Node.js. The example keeps its saves in `.saves/`.

```sh
node <<'NODE'
const { Store } = require('game-shelf-save-slots');

async function main() {
  const store = await Store.open('.saves');
  await store.registerGame('demo', 'build-1');
  const main = await store.createSlot('demo', 'Main');

  const save = score => JSON.stringify({
    schema: 1,
    adapter: 'web-storage',
    passage: 'Garden',
    local: { score: String(score) },
    session: {},
  });

  const first = await store.checkpoint('demo', main.id, save(1));
  await store.checkpoint('demo', main.id, save(2));
  const branch = await store.branch('demo', main.id, first.id, 'Try another route');
  await store.restore('demo', main.id, first.id);
  const { data } = await store.readCheckpoint('demo', branch.id, branch.head.id);
  console.log(branch.name, JSON.parse(data).local.score); // Try another route 1
}

main().catch(error => { console.error(error); process.exitCode = 1; });
NODE
```

## API

The main module exports `Store` and `discoverGames(directory)`. Discovery returns sorted relative `.html` and `.htm` paths with `/` separators. It skips `.git`, `node_modules`, and `.DS_Store` and rejects symlinks and unsafe names encountered under the game root.

| Store method | Result |
| --- | --- |
| `Store.open(directory)` | Opens or initializes the local store and recovers interrupted journal tails. |
| `registerGame(gameId, revision)` | Registers a game ID of up to 80 letters, digits, or hyphens. A repeat with the same revision is safe. Use a separate game ID for a different build. |
| `createSlot(gameId, name?)` | Creates a slot with an empty history. |
| `listSlots(gameId)` | Returns slot summaries with `id`, `name`, `createdAt`, `head`, and `parent`. |
| `checkpoint(gameId, slotId, data, options?)` | Returns the new row or the current head when the payload matches. Options are `label`, `force`, and `bookmark`. A forced or bookmarked checkpoint always adds a row. |
| `history(gameId, slotId)` | Returns checkpoint rows in append order, oldest first. |
| `readCheckpoint(gameId, slotId, checkpointId)` | Returns `{ row, data }`, with the original JSON string verified against its digest. |
| `restore(gameId, slotId, checkpointId)` | Appends the selected state to the same slot and returns the new row. Earlier and later rows remain available. |
| `branch(gameId, slotId, checkpointId, name?)` | Returns a new slot seeded with the selected state. Its `parent` identifies the original slot and checkpoint. |

Checkpoint data is a UTF-8 JSON string up to 32 MiB with `schema: 1` and an `adapter` of `web-storage` or `sugarcube`. The optional `passage` supplies the display location. The caller supplies a build revision, typically the SHA-256 digest of the game HTML. The store keeps the payload as supplied and uses its byte representation for deduplication.

The browser-compatible `game-shelf-save-slots/web-storage` ES module exports `snapshotWebStorage({ local, session, passage? })` and `restoreWebStorage(data, { local, session })`. Supply Storage objects from an origin or storage partition dedicated to the game. Restore replaces both stores and attempts to put back their previous contents if a write fails. The host manages browser isolation, reloads, checkpoint timing, and any SugarCube state capture or replay. Web Storage covers local and session storage only.

## Persistence

Use a dedicated directory with one `Store` instance at a time. The package uses its own disk format. Back up the full directory between writes or after the process exits. Payloads are gzip-compressed and shared by SHA-256 digest. The catalog and payload files use synced temporary files and atomic renames. Synced journal records determine slot heads. On open, a torn final record is saved beside its journal before repair. Reopen the store after an interrupted journal write. Checkpoint payloads are stored unencrypted and history grows until the directory is archived or removed.

Run `npm test` to exercise the package with synthetic fixtures.

## License and provenance

The save store, file discovery, and Web Storage helpers are adapted from first-party Game Shelf code by chai-in in `src/storage.cjs`, `src/files.cjs`, and `src/adapter.js`. This package is licensed under `AGPL-3.0-only`. See [LICENSE](LICENSE).
