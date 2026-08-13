/**
 * Copies runtime assets that `tsc` does not: the SQL schema and the
 * questionnaire configs, both of which are read from disk at runtime rather
 * than imported.
 *
 * Without this the service still works when `src/` sits next to `dist/` (the
 * loaders fall back to the source tree), but a lean container image has no
 * `src/` — so it would start and then fail on the first database call. Copying
 * them makes `dist/` genuinely self-contained.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** [from, to] pairs, relative to the backend package root. */
const ASSETS = [
  ['src/db/schema.sql', 'dist/db/schema.sql'],
  ['src/questionnaire/config', 'dist/questionnaire/config'],
];

let copied = 0;

for (const [from, to] of ASSETS) {
  const source = path.join(root, from);
  const target = path.join(root, to);

  if (!fs.existsSync(source)) {
    console.error(`Missing build asset: ${from}`);
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });

  if (fs.statSync(source).isDirectory()) {
    fs.cpSync(source, target, { recursive: true });
    copied += fs.readdirSync(source).length;
  } else {
    fs.copyFileSync(source, target);
    copied += 1;
  }
}

console.log(`Copied ${copied} runtime asset(s) into dist/.`);
