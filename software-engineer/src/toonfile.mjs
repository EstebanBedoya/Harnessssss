import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decode, encode } from '@toon-format/toon';

// Cada archivo .toon es { rows: [...] }, una fila por registro. Upsert por clave: reprocesar no duplica.
export function upsertRows(dir, name, rows, keyFn) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name}.toon`);
  const cur = existsSync(file) ? (decode(readFileSync(file, 'utf8')).rows ?? []) : [];
  const map = new Map(cur.map((r) => [keyFn(r), r]));
  for (const r of rows) map.set(keyFn(r), r);
  const raw = [...map.values()];
  // Una sola forma de fila: unión de columnas en orden de aparición, '' donde falte (así TOON sigue siendo tabular).
  const cols = [...new Set(raw.flatMap((r) => Object.keys(r)))];
  const all = raw.map((r) => Object.fromEntries(cols.map((c) => [c, r[c] ?? ''])));
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, encode({ rows: all }) + '\n');
  renameSync(tmp, file);
  return { file, total: all.length, added: all.length - cur.length };
}
export const readRows = (dir, name) => {
  const f = join(dir, `${name}.toon`);
  return existsSync(f) ? (decode(readFileSync(f, 'utf8')).rows ?? []) : [];
};
