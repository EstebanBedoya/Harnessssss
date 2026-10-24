import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkAuth, formatAuth, loginInfo, piProviderOf, runLogin } from '../src/auth.mjs';
import { DEFAULT_PROFILE } from '../src/defaults.mjs';
import { addTask, applyEvent } from '../src/tasks.mjs';
import { loadProfile } from '../src/store.mjs';
import { runWizard } from '../src/wizard.mjs';

process.env.HARNESS_CONFIG = join(tmpdir(), `harness-test-no-global-${process.pid}.json`);
const BIN = fileURLToPath(new URL('../bin/harness.mjs', import.meta.url));
const stub = (table) => (bin, args) => { const k = args.join(' '); const r = table[k] ?? { status: 1, out: '' }; return r; };
const at = (runner, table, extra = {}) => checkAuth(runner, { bin: `/x/${runner}`, run: stub(table), ...extra });

test('auth: cada runner dice si hay sesión con su propio comando', () => {
  assert.equal(at('claude', { 'auth status': { status: 0, out: '{"loggedIn":true,"authMethod":"claude.ai"}' } }).state, 'ok');
  assert.equal(at('claude', { 'auth status': { status: 0, out: '{"loggedIn":false}' } }).state, 'missing');
  assert.equal(at('claude', { 'auth status': { status: 0, out: 'basura' } }).state, 'unknown'); // no se pudo leer: no bloquea
  assert.equal(at('codex', { 'login status': { status: 0, out: 'Logged in using ChatGPT' } }).detail, 'Logged in using ChatGPT');
  assert.equal(at('codex', { 'login status': { status: 1, out: 'Not logged in' } }).state, 'missing');
  assert.equal(at('antigravity', { models: { status: 0, out: 'gemini-3.8-flash-high\tGemini' } }).state, 'ok');
  const out = at('antigravity', { models: { status: 1, out: 'Error: Please sign in to view available models.' } });
  assert.deepEqual([out.state, out.login.cmd, out.login.args], ['missing', '/x/antigravity', []]); // el login de agy es abrirlo sin argumentos
  assert.equal(at('antigravity', { models: { status: 1, out: 'dial tcp: i/o timeout' } }).state, 'unknown'); // un fallo de red no es «sin sesión»
  assert.equal(checkAuth('claude', { bin: null }).state, 'unknown');
});

test('auth: pi comprueba el proveedor del modelo; opencode acepta sus modelos gratis sin login', () => {
  const pi = (model, status) => at('pi', { 'auth check --provider google --json': { status: 0, out: status }, 'auth check --provider openai --json': { status: 0, out: '{"status":"ready","authType":"oauth"}' } }, { model });
  assert.equal(pi('google/gemini-2.5-pro', '{"status":"not_ready","reason":"credentials_not_configured"}').state, 'missing');
  assert.match(pi('google/gemini-2.5-pro', '{"status":"not_ready","reason":"credentials_not_configured"}').detail, /sin credenciales de google/);
  assert.equal(pi('google/gemini-2.5-pro', '{"status":"ready"}').state, 'ok');
  assert.equal(pi('openai/gpt-5.5', '').state, 'ok');
  assert.equal(piProviderOf(null, { exists: () => true, read: () => '{"defaultProvider":"openai"}' }), 'openai'); // sin modelo: el de pi
  assert.equal(piProviderOf('google/x'), 'google');
  const oc = (model, list) => at('opencode', { 'auth list': { status: 0, out: list } }, { model });
  assert.equal(oc('opencode/big-pickle', '0 credentials').state, 'ok');
  assert.equal(oc('openai/gpt-5.5', '0 credentials').state, 'missing');
  assert.equal(oc('openai/gpt-5.5', '2 credentials').state, 'ok');
});

test('auth: runLogin lanza el comando de login y vuelve a comprobar', () => {
  const calls = []; let logged = false;
  const run = (bin, args) => (args[0] === 'models' ? { status: logged ? 0 : 1, out: logged ? 'm\tM' : 'Please sign in' } : { status: 0, out: '' });
  const r = runLogin('antigravity', { bin: '/x/agy', run, spawn: (c, a) => { calls.push([c, a]); logged = true; return { status: 0 }; } });
  assert.deepEqual(calls, [['/x/agy', []]]);
  assert.equal(r.ok, true);
  assert.equal(runLogin('antigravity', { bin: '/x/agy', run: () => ({ status: 1, out: 'Please sign in' }), spawn: () => ({ status: 0 }) }).ok, false); // no completó el login
  assert.deepEqual(loginInfo('claude', '/c').args, ['auth', 'login']);
  assert.match(formatAuth([{ runner: 'claude', state: 'ok', detail: 'claude.ai' }, { runner: 'antigravity', state: 'missing' }, { runner: 'pi', state: 'unknown' }]), /✓ claude\s+sesión iniciada · claude\.ai\n {2}✗ antigravity\s+sin sesión\s+→ harness login antigravity\n {2}\? pi/);
});

const ENV = { herdr: true, runners: { claude: true, pi: true, codex: true, opencode: true, antigravity: true }, install: {} };
const scripted = (answers) => ({ select: async ({ options }) => { const v = answers.shift(); assert.ok(options.some((o) => o.value === v && !o.disabled), `${String(v)} no está entre ${options.map((o) => o.value)}`); return v; }, text: async () => answers.shift() });

test('asistente: al elegir un runner sin sesión ofrece iniciarla y lo vuelve a comprobar', async () => {
  const said = []; const logins = []; let logged = false;
  const auth = { check: (runner) => (runner === 'antigravity' && !logged ? { state: 'missing', login: { hint: 'abre agy' } } : { state: 'ok' }), login: async (runner) => { logins.push(runner); logged = true; return { ok: true }; } };
  const ui = scripted(['reviewer', 'runner', 'antigravity', 'login', 'gemini-3.8-flash-high', '__back', '__save']);
  const r = await runWizard({ profile: { ...DEFAULT_PROFILE }, env: ENV, ui, auth, say: (m) => said.push(m) });
  assert.deepEqual(logins, ['antigravity']);
  assert.match(said.join('\n'), /✓ sesión iniciada en antigravity/);
  assert.equal(r.patches['models.reviewer.provider'], 'antigravity');
  // «Seguir sin sesión» no bloquea: avisa cómo hacerlo después
  const said2 = [];
  await runWizard({ profile: { ...DEFAULT_PROFILE }, env: ENV, ui: scripted(['reviewer', 'runner', 'antigravity', 'later', 'gemini-3.8-flash-high', '__back', '__save']), auth: { check: () => ({ state: 'missing', login: {} }), login: async () => assert.fail('no debe iniciar sesión') }, say: (m) => said2.push(m) });
  assert.match(said2.join('\n'), /sin sesión; antes de usarlo: harness login antigravity/);
  // sesión desconocida u ok: no pregunta nada
  await runWizard({ profile: { ...DEFAULT_PROFILE }, env: ENV, ui: scripted(['reviewer', 'runner', 'antigravity', 'gemini-3.8-flash-high', '__back', '__save']), auth: { check: () => ({ state: 'unknown' }), login: async () => assert.fail('no') } });
});

// agy falso: `models` falla como cuando no hay sesión
test('exec: sin sesión en el runner no gasta un intento y explica cómo iniciarla', () => {
  const root = mkdtempSync(join(tmpdir(), 'harness-auth-'));
  spawnSync('git', ['init', '-q'], { cwd: root });
  spawnSync('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=t', 'commit', '--allow-empty', '-q', '-m', 'i'], { cwd: root });
  mkdirSync(join(root, '.harness'));
  writeFileSync(join(root, '.harness/profile.json'), JSON.stringify({ gate: { cmd: 'true' }, models: { executor: { provider: 'antigravity', model: null } } }));
  const agy = join(root, 'agy');
  writeFileSync(agy, '#!/usr/bin/env bash\nif [ "$1" = "models" ]; then echo "Error: Please sign in to view available models." >&2; exit 1; fi\necho should-not-run\n');
  chmodSync(agy, 0o755);
  const P = loadProfile(root);
  addTask(root, P, { id: 'n1', title: 'x', category: 'feature', paths: ['src/**'] });
  applyEvent(root, P, 'n1', 'approve');
  const r = spawnSync('node', [BIN, 'exec', 'n1', '--quiet', '--root', root], { encoding: 'utf8', env: { ...process.env, AGY_BIN: agy, HERDR_ENV: '' } });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no has iniciado sesión en antigravity.*harness login antigravity.*no gasté ningún intento/);
});

test('asistente: la sesión se comprueba antes de listar modelos, salvo en pi, donde depende del modelo', async () => {
  const order = [];
  const auth = { check: (runner, model) => { order.push(`auth:${runner}:${model ?? '-'}`); return { state: 'ok' }; }, login: async () => ({ ok: true }) };
  const listModels = (runner) => { order.push(`models:${runner}`); return [{ provider: 'google', model: 'google/gemini-2.5-pro' }]; };
  await runWizard({ profile: { ...DEFAULT_PROFILE }, env: ENV, ui: scripted(['reviewer', 'runner', 'antigravity', '__default', '__back', '__save']), auth, listModels });
  assert.deepEqual(order, ['auth:antigravity:-', 'models:antigravity', 'models:antigravity'].slice(0, 2)); // primero la sesión, luego la lista
  order.length = 0;
  await runWizard({ profile: { ...DEFAULT_PROFILE }, env: ENV, ui: scripted(['executor', 'model', 'google/gemini-2.5-pro', '__back', '__save']), auth, listModels });
  assert.deepEqual(order, ['models:pi', 'auth:pi:google/gemini-2.5-pro']); // pi: con el modelo ya elegido, para saber de qué proveedor
});
