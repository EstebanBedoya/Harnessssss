import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { agentStates, discoverProjects, fleetRoots } from './fleet.mjs';
import { loadProfile } from './store.mjs';

// El CLI se instala desde un clon de git (install.sh enlaza bin/ y skill/ a esa carpeta): actualizar es traer los commits nuevos,
// reinstalar dependencias y refrescar los proyectos. Nada de esto toca el clon si tiene cambios locales o divergió.

const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
};

export function versionInfo(core) {
  let version = null; try { version = JSON.parse(readFileSync(join(core, 'package.json'), 'utf8')).version; } catch { /* sin package.json */ }
  const commit = git(core, 'rev-parse', '--short', 'HEAD');
  if (!commit.ok) return { version, core, git: false };
  return {
    version, core, git: true, commit: commit.out, branch: git(core, 'rev-parse', '--abbrev-ref', 'HEAD').out,
    date: git(core, 'log', '-1', '--format=%cs').out, remote: git(core, 'remote', 'get-url', 'origin').out || null,
  };
}

// ¿Hay algo nuevo? Hace `git fetch` (no cambia el árbol de trabajo) y compara con la rama que sigue el clon.
export function checkUpgrade(core) {
  const top = git(core, 'rev-parse', '--show-toplevel');
  if (!top.ok) return { ok: false, reason: `${core} no es un clon de git: el upgrade solo funciona si instalaste desde el repo` };
  const up = git(core, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}');
  if (!up.ok) return { ok: false, reason: 'la rama actual no sigue ninguna rama remota (git branch --set-upstream-to=origin/main)' };
  const fetch = git(core, 'fetch', '--quiet');
  if (!fetch.ok) return { ok: false, reason: `git fetch falló: ${fetch.err.split('\n')[0]}` };
  const [ahead, behind] = git(core, 'rev-list', '--left-right', '--count', 'HEAD...@{u}').out.split(/\s+/).map(Number);
  const dirty = git(core, 'status', '--porcelain', '--untracked-files=no').out.split('\n').filter(Boolean);
  // git devuelve la ruta real (en macOS /var es un enlace a /private/var): se compara contra la del core resuelta.
  const real = realpathSync(core);
  const files = behind ? git(core, 'diff', '--name-only', 'HEAD..@{u}').out.split('\n').filter(Boolean).map((f) => relative(real, join(top.out, f))) : [];
  const inCore = files.filter((f) => !f.startsWith('..'));
  return {
    ok: true, upstream: up.out, ahead, behind, dirty,
    commits: behind ? git(core, 'log', '--format=%h %s', 'HEAD..@{u}').out.split('\n').filter(Boolean) : [],
    depsChanged: inCore.some((f) => f === 'package.json' || f === 'pnpm-lock.yaml'),
    agentsChanged: inCore.some((f) => f.startsWith('agents/')),
    files: inCore,
  };
}

// Trae los cambios (solo avance rápido), reinstala y deja el clon listo. Devuelve qué hizo o por qué se detuvo.
export function upgrade(core, { check = false, install = defaultInstall } = {}) {
  const before = versionInfo(core);
  const c = checkUpgrade(core);
  if (!c.ok) return { updated: false, error: c.reason, before };
  if (c.behind === 0) return { updated: false, upToDate: true, note: c.ahead ? `el clon tiene ${c.ahead} commit(s) locales sin subir` : undefined, before, upstream: c.upstream };
  const plan = { behind: c.behind, commits: c.commits, depsChanged: c.depsChanged, agentsChanged: c.agentsChanged, upstream: c.upstream };
  if (check) return { updated: false, available: true, ...plan, before, next: 'harness upgrade' };
  if (c.ahead > 0) return { updated: false, error: `el clon divergió del remoto (${c.ahead} commit(s) locales y ${c.behind} nuevos): resuélvelo con git, no lo toco`, ...plan, before };
  if (c.dirty.length) return { updated: false, error: `el clon tiene cambios sin commitear (${c.dirty.slice(0, 5).join(', ')}): guárdalos o descártalos y vuelve a correr`, ...plan, before };
  const pull = git(core, 'pull', '--ff-only', '--quiet');
  if (!pull.ok) return { updated: false, error: `git pull falló: ${pull.err.split('\n')[0]}`, ...plan, before };
  const inst = install(core);
  return { updated: true, ...plan, install: inst, before, after: versionInfo(core) };
}

// install.sh es idempotente: pnpm install --frozen-lockfile, repara los enlaces y corre `doctor`.
function defaultInstall(core) {
  const script = join(core, 'install.sh');
  if (!existsSync(script)) return { ok: false, note: 'no encuentro install.sh' };
  const r = spawnSync('bash', [script], { cwd: core, encoding: 'utf8' });
  return { ok: r.status === 0, ...(r.status === 0 ? {} : { error: (r.stderr || r.stdout || '').trim().split('\n').slice(-3).join(' | ') }) };
}

// Proyectos con harness y qué tienen desactualizado (agentes frente a las plantillas actuales). Con `sync` los refresca.
export function fleetStale({ roots = fleetRoots(), sync = null } = {}) {
  const projects = discoverProjects(roots).map((root) => {
    let stale = [];
    try { stale = agentStates(root, loadProfile(root)).filter((a) => a.state !== 'ok').map((a) => a.role); } catch { return { root, name: basename(root), error: 'profile.json ilegible' }; }
    const row = { root, name: basename(root), stale };
    if (sync && stale.length) row.sync = sync(root);
    return row;
  });
  return { projects, outdated: projects.filter((p) => p.stale?.length).length };
}
