import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { matches } from './glob.mjs';

// El designer (Pencil) guarda sus archivos en design/: no son parte del scope del código pero tampoco una violación.
export const DESIGN_PATHS = ['design/**'];

const git = (root, args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });

// Lo cambiado respecto de la base de la tarea: commits de la rama, cambios en el árbol y archivos nuevos.
export function changedFiles(root, base) {
  if (git(root, ['rev-parse', '--git-dir']).status !== 0) return null;
  const mb = base ? git(root, ['merge-base', 'HEAD', base]) : { status: 1 };
  const ref = mb.status === 0 ? mb.stdout.trim() : 'HEAD';
  const tracked = git(root, ['diff', '--name-only', ref]).stdout.split('\n');
  const untracked = git(root, ['ls-files', '-o', '--exclude-standard']).stdout.split('\n');
  return [...new Set([...tracked, ...untracked].filter(Boolean))].filter((p) => !p.startsWith('.harness/'));
}

const hashOf = (root, f) => {
  const r = git(root, ['hash-object', '--', f]);
  return r.status === 0 ? r.stdout.trim() : 'deleted';
};

// Línea base al aprobar: lo que ya estaba sucio antes de empezar no es de la tarea (se guarda su hash).
export function snapshotDirty(root, base) {
  const files = changedFiles(root, base);
  return files ? Object.fromEntries(files.map((f) => [f, hashOf(root, f)])) : {};
}

// Scope manifest: lo cambiado tiene que caer dentro de task.paths. Comprobación mecánica, no del LLM.
export function checkScope(root, task) {
  const files = changedFiles(root, task.base);
  if (files === null || !task.paths?.length) return { checked: false, violations: [] };
  const base = task.baseline || {};
  const mine = files.filter((f) => base[f] === undefined || base[f] !== hashOf(root, f)); // el archivo ya sucio solo cuenta si cambió después
  return { checked: true, files: mine, ignored: files.length - mine.length, violations: mine.filter((f) => !matches(f, [...task.paths, ...DESIGN_PATHS])) };
}

// Una tarea T2 no corre contra una base remota: el host de DATABASE_URL tiene que ser local (sin leer ni mostrar credenciales).
export function checkLocalDb(root, profile) {
  const file = join(root, profile.gate.dbEnvFile || '.env');
  if (!existsSync(file)) return { checked: false, ok: true };
  const m = readFileSync(file, 'utf8').match(/^DATABASE_URL=["']?[^@\n]*@([^:/?"'\n]+)/m);
  if (!m) return { checked: false, ok: true };
  const host = m[1];
  return { checked: true, host, ok: ['localhost', '127.0.0.1', '::1', 'postgres', 'postgres-test'].includes(host) };
}

export function runGate(root, profile, task) {
  const scope = checkScope(root, task);
  if (scope.violations.length) {
    return { pass: false, reason: 'scope', scope, ms: 0, tail: `fuera de scope: ${scope.violations.join(', ')}` };
  }
  if (task.tier === 'T2' && profile.gate.requireLocalDb !== false) {
    const db = checkLocalDb(root, profile);
    if (!db.ok) return { pass: false, reason: 'db no local', ms: 0, tail: `DATABASE_URL apunta a ${db.host}: una tarea T2 solo corre contra una base local`, scope };
  }
  if (!profile.gate.cmd) return { pass: false, reason: 'sin gate configurado', ms: 0, tail: '', scope };
  const t0 = Date.now();
  const cmd = task.tier === 'T2' && profile.gate.t2Cmd ? `${profile.gate.cmd} && ${profile.gate.t2Cmd}` : profile.gate.cmd; // T2: pasos extra, por ejemplo aplicar la migración a la base de pruebas
  const r = spawnSync(cmd, { cwd: root, shell: true, encoding: 'utf8', timeout: profile.gate.timeoutMs });
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim().split('\n').slice(-15).join('\n');
  return { pass: r.status === 0, reason: r.status === 0 ? 'ok' : `exit ${r.status}`, ms: Date.now() - t0, tail: out, scope };
}
