import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { checkUpgrade, fleetStale, upgrade, versionInfo } from '../src/upgrade.mjs';

process.env.HARNESS_CONFIG = join(tmpdir(), `harness-test-no-global-${process.pid}.json`);

const G = (cwd, ...a) => { const r = spawnSync('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=t', ...a], { cwd, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
const write = (dir, f, text) => { mkdirSync(join(dir, f, '..'), { recursive: true }); writeFileSync(join(dir, f), text); };

// origin (bare) + el clon donde está instalado el CLI (con el core en software-engineer/) + otro clon desde el que se suben cambios.
function setup() {
  const base = mkdtempSync(join(tmpdir(), 'harness-up-'));
  const origin = join(base, 'origin.git'); const install = join(base, 'install'); const dev = join(base, 'dev');
  spawnSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  spawnSync('git', ['clone', '-q', origin, dev]);
  write(dev, 'software-engineer/package.json', '{"version":"0.1.0"}');
  write(dev, 'software-engineer/agents/executor.md', 'v1');
  G(dev, 'add', '.'); G(dev, 'commit', '-q', '-m', 'init'); G(dev, 'push', '-q', 'origin', 'main');
  spawnSync('git', ['clone', '-q', origin, install]);
  return { install, dev, core: join(install, 'software-engineer') };
}
const pushChange = (dev, files, msg) => { for (const [f, t] of Object.entries(files)) write(dev, f, t); G(dev, 'add', '.'); G(dev, 'commit', '-q', '-m', msg); G(dev, 'push', '-q', 'origin', 'main'); };

test('version: versión de package.json, commit y rama', () => {
  const { core } = setup();
  const v = versionInfo(core);
  assert.deepEqual([v.version, v.git, v.branch], ['0.1.0', true, 'main']);
  assert.match(v.commit, /^[0-9a-f]{7,}$/);
  assert.equal(versionInfo(mkdtempSync(join(tmpdir(), 'harness-nogit-'))).git, false);
});

test('upgrade: al día no hace nada; --check avisa de lo nuevo sin tocar el clon', () => {
  const { core, dev } = setup();
  assert.equal(upgrade(core).upToDate, true);
  pushChange(dev, { 'software-engineer/agents/executor.md': 'v2', 'software-engineer/pnpm-lock.yaml': 'x' }, 'feat: mejora');
  const before = versionInfo(core).commit;
  const r = upgrade(core, { check: true });
  assert.deepEqual([r.available, r.behind, r.depsChanged, r.agentsChanged], [true, 1, true, true]);
  assert.deepEqual(r.commits.map((c) => c.replace(/^\w+ /, '')), ['feat: mejora']);
  assert.equal(versionInfo(core).commit, before); // --check no cambia el árbol
  assert.equal(readFileSync(join(core, 'agents/executor.md'), 'utf8'), 'v1');
});

test('upgrade: trae los commits (solo avance rápido), reinstala y devuelve antes y después', () => {
  const { core, dev } = setup();
  pushChange(dev, { 'software-engineer/agents/executor.md': 'v2' }, 'feat: mejora');
  let installed = 0;
  const r = upgrade(core, { install: () => { installed += 1; return { ok: true }; } });
  assert.deepEqual([r.updated, installed, r.install.ok], [true, 1, true]);
  assert.notEqual(r.before.commit, r.after.commit);
  assert.equal(readFileSync(join(core, 'agents/executor.md'), 'utf8'), 'v2');
  assert.equal(upgrade(core).upToDate, true);
});

test('upgrade: se detiene sin pisar nada si el clon tiene cambios locales o divergió', () => {
  const { core, dev, install } = setup();
  pushChange(dev, { 'software-engineer/agents/executor.md': 'v2' }, 'feat: remoto');
  write(install, 'software-engineer/agents/executor.md', 'editado a mano');
  const dirty = upgrade(core, { install: () => assert.fail('no debe instalar') });
  assert.equal(dirty.updated, false);
  assert.match(dirty.error, /cambios sin commitear/);
  assert.equal(readFileSync(join(core, 'agents/executor.md'), 'utf8'), 'editado a mano');
  G(install, 'checkout', '--', '.');
  write(install, 'software-engineer/local.txt', 'x'); G(install, 'add', '.'); G(install, 'commit', '-q', '-m', 'feat: local');
  const div = upgrade(core, { install: () => assert.fail('no debe instalar') });
  assert.match(div.error, /divergió/);
});

test('upgrade: fuera de un clon de git explica por qué no puede', () => {
  const dir = mkdtempSync(join(tmpdir(), 'harness-nogit-'));
  assert.match(upgrade(dir).error, /no es un clon de git/);
  assert.equal(checkUpgrade(dir).ok, false);
});

test('fleet: lista los proyectos con agentes desactualizados y --sync los refresca', () => {
  const home = mkdtempSync(join(tmpdir(), 'harness-fleet-'));
  const p = join(home, 'proj'); mkdirSync(join(p, '.harness'), { recursive: true });
  writeFileSync(join(p, '.harness/profile.json'), '{"gate":{"cmd":"true"}}');
  const r = fleetStale({ roots: [home] });
  assert.equal(r.outdated, 1);
  assert.ok(r.projects[0].stale.length > 0); // sin agentes instalados: todos «missing»
  const calls = [];
  fleetStale({ roots: [home], sync: (root) => { calls.push(root); return 'ok'; } });
  assert.deepEqual(calls, [p]);
});
