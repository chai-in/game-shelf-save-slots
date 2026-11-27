// SPDX-FileCopyrightText: 2026 chai-in
// SPDX-License-Identifier: AGPL-3.0-only

function storageEntries(storage) {
  return Array.from({ length: storage.length }, (_, index) => {
    const key = storage.key(index);
    return [key, storage.getItem(key)];
  });
}

function snapshotEntries(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Expected a Web Storage snapshot object.');
  }
  const entries = Object.entries(value);
  if (entries.some(([, item]) => typeof item !== 'string')) {
    throw new TypeError('Web Storage values must be strings.');
  }
  return entries;
}

function replaceStorage(storage, entries) {
  storage.clear();
  for (const [key, value] of entries) storage.setItem(key, value);
}

export function snapshotWebStorage({ local, session, passage = '' }) {
  return JSON.stringify({
    schema: 1,
    adapter: 'web-storage',
    passage,
    local: Object.fromEntries(storageEntries(local)),
    session: Object.fromEntries(storageEntries(session)),
  });
}

export function restoreWebStorage(data, { local, session }) {
  const snapshot = JSON.parse(data);
  if (snapshot?.schema !== 1 || snapshot.adapter !== 'web-storage') {
    throw new TypeError('Unsupported Web Storage checkpoint format.');
  }

  const changes = [
    { storage: local, next: snapshotEntries(snapshot.local), before: storageEntries(local) },
    { storage: session, next: snapshotEntries(snapshot.session), before: storageEntries(session) },
  ];
  const attempted = [];
  try {
    for (const change of changes) {
      attempted.push(change);
      replaceStorage(change.storage, change.next);
    }
  } catch (error) {
    const errors = [error];
    for (const { storage, before } of attempted) {
      try {
        replaceStorage(storage, before);
      } catch (rollbackError) {
        errors.push(rollbackError);
      }
    }
    if (errors.length > 1) throw new AggregateError(errors, 'Web Storage restore and rollback failed.');
    throw error;
  }
}
