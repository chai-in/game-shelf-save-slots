// SPDX-FileCopyrightText: 2026 chai-in
// SPDX-License-Identifier: AGPL-3.0-only

'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const ignored = new Set(['.git', 'node_modules', '.DS_Store']);
const reserved = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i;

async function discoverGames(root) {
  const html = [];

  async function walk(dir, relative = '') {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (ignored.has(entry.name)) continue;
      const name = `${relative}${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`Symbolic link in game folder: ${name}`);
      if (/[\u0000-\u001f\\:<>"|?*]|[. ]$/.test(entry.name) || reserved.test(entry.name)) {
        throw new Error(`Unsafe filename in game folder: ${name}`);
      }
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), `${name}/`);
      else if (entry.isFile() && /\.html?$/i.test(entry.name)) html.push(name);
    }
  }

  await walk(await fs.realpath(root));
  return html.sort();
}

module.exports = { discoverGames };
