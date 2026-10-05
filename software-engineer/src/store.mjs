import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_PROFILE } from './defaults.mjs';

export const dirs = (root) => ({
  base: join(root, '.harness'),
  profile: join(root, '.harness', 'profile.json'),
  backlog: join(root, '.harness', 'backlog.json'),
  metrics: join(root, '.harness', 'metrics'),
});

const merge = (a, b) => {
  if (b === undefined) return a;
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const out = { ...a };
    for (const k of Object.keys(b)) out[k] = merge(a[k], b[k]);
    return out;
  }
  return b;
};

export function loadProfile(root) {
  const f = dirs(root).profile;
  const user = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {};
  return merge(DEFAULT_PROFILE, user);
}

export function writeJson(file, data) {
  mkdirSync(join(file, '..'), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  renameSync(tmp, file); // escritura atómica: el estado lo lee un script
}

export const loadBacklog = (root) => {
  const f = dirs(root).backlog;
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : { tasks: {} };
};
export const saveBacklog = (root, b) => writeJson(dirs(root).backlog, b);

// Cambia una clave del perfil del usuario (`models.designer.use`) sin volcar los valores por defecto al archivo.
export function setProfileValue(root, dotted, value) {
  const f = dirs(root).profile;
  const user = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {};
  const keys = dotted.split('.');
  let cur = user;
  for (const k of keys.slice(0, -1)) cur = (cur[k] && typeof cur[k] === 'object') ? cur[k] : (cur[k] = {});
  cur[keys.at(-1)] = value;
  writeJson(f, user);
  return user;
}

export function getProfileValue(profile, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), profile);
}
