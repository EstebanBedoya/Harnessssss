import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { applyMain, checkProfile, familyOf, parsePiModels, sameFamily } from '../src/config.mjs';
import { DEFAULT_PROFILE } from '../src/defaults.mjs';
import { route } from '../src/router.mjs';
import { addTask, applyEvent, nextStep } from '../src/tasks.mjs';
import { loadBacklog, loadProfile, setProfileValue } from '../src/store.mjs';
import { parseVerdict } from '../src/verdict.mjs';
import { runWizard } from '../src/wizard.mjs';
import { initSelect, physicalRows, reduceSelect, reduceText, renderSelect, visibleOptions } from '../src/prompt.mjs';

const BIN = fileURLToPath(new URL('../bin/harness.mjs', import.meta.url));
const tmp = () => mkdtempSync(join(tmpdir(), 'harness-cfg-'));
const withGlobal = (file) => { process.env.HARNESS_CONFIG = file; };
const withModels = (m) => ({ ...DEFAULT_PROFILE, models: { ...DEFAULT_PROFILE.models, ...m } });
const entry = (provider, model) => ({ provider, model, effort: { T0: 'medium', T1: 'high', T2: 'high' } });

test('familia: se deduce del modelo; sin modelo, del runner cuando es de un solo proveedor', () => {
  assert.equal(familyOf('pi', 'openai/gpt-5.3-codex'), 'openai');
  assert.equal(familyOf('pi', 'google/gemini-2.5-pro'), 'google');
  assert.equal(familyOf('claude', 'claude-opus-5-5'), 'anthropic');
  assert.equal(familyOf('claude', null), 'anthropic');
  assert.equal(familyOf('pi', null), null); // pi usa el modelo que tenga: no se sabe
  assert.equal(sameFamily({ provider: 'pi', model: null }, { provider: 'pi', model: null }), true); // no se puede probar que difieran
  assert.equal(sameFamily({ provider: 'pi', model: null }, { provider: 'claude', model: 'claude-sonnet-5-5' }), false);
});

test('router: executor en pi con codex y reviewer en pi con gemini son familias distintas', () => {
  const ok = withModels({ executor: entry('pi', 'openai/gpt-5.3-codex'), reviewer: entry('pi', 'google/gemini-2.5-pro') });
  const r = route(ok, 'reviewer', { tier: 'T1', executorProvider: 'pi' });
  assert.deepEqual([r.provider, r.model], ['pi', 'google/gemini-2.5-pro']);
  const same = withModels({ executor: entry('pi', 'openai/gpt-5.3-codex'), reviewer: { ...entry('pi', 'openai/gpt-5.5'), crossFamily: undefined } });
  assert.equal(route(same, 'reviewer', { tier: 'T1', executorProvider: 'pi' }).wait, true);
  const cross = withModels({ executor: entry('pi', 'openai/gpt-5.3-codex'), reviewer: { ...entry('pi', 'openai/gpt-5.5'), crossFamily: entry('claude', 'claude-sonnet-5-5') } });
  assert.equal(route(cross, 'reviewer', { tier: 'T1', executorProvider: 'pi' }).provider, 'claude');
  assert.match(checkProfile(same).join('\n'), /misma familia/);
  assert.deepEqual(checkProfile(ok), []);
});

test('capas: defecto < global < proyecto, y el global no se vuelca al proyecto', () => {
  const root = tmp(); const g = join(root, 'global.json'); withGlobal(g);
  mkdirSync(join(root, '.harness'));
  writeFileSync(g, JSON.stringify({ models: { executor: { model: 'openai/gpt-5.3-codex' }, reviewer: { provider: 'pi', model: 'google/gemini-2.5-pro' } } }));
  let p = loadProfile(root);
  assert.equal(p.models.executor.model, 'openai/gpt-5.3-codex');
  assert.equal(p.models.reviewer.provider, 'pi');
  assert.equal(p.models.planner.provider, 'claude'); // lo no tocado sigue por defecto
  setProfileValue(root, 'models.reviewer.model', 'google/gemini-2.5-flash');
  p = loadProfile(root);
  assert.equal(p.models.reviewer.model, 'google/gemini-2.5-flash'); // el proyecto manda
  assert.equal(p.models.reviewer.provider, 'pi'); // y lo demás viene del global
  assert.deepEqual(JSON.parse(readFileSync(join(root, '.harness/profile.json'), 'utf8')), { models: { reviewer: { model: 'google/gemini-2.5-flash' } } });
  setProfileValue(root, 'models.planner.model', 'claude-opus-5-5', { global: true });
  assert.equal(JSON.parse(readFileSync(g, 'utf8')).models.planner.model, 'claude-opus-5-5');
});

test('main: reasigna planner, executor y reviewer que nadie fijó; no toca designer ni explore ni lo explícito', () => {
  const explicit = { models: { reviewer: { provider: 'claude' } } };
  const p = applyMain({ ...DEFAULT_PROFILE, main: 'codex' }, explicit);
  assert.deepEqual([p.models.planner.provider, p.models.planner.model], ['codex', null]);
  assert.equal(p.models.executor.provider, 'codex');
  assert.equal(p.models.reviewer.provider, 'claude'); // explícito
  assert.equal(p.models.designer.provider, 'claude');
  assert.equal(p.models.explore.provider, 'claude');
  assert.equal(applyMain(DEFAULT_PROFILE, {}), DEFAULT_PROFILE); // sin main no cambia nada
});

test('pi: parsea la tabla de modelos; el veredicto del reviewer solo vale con la línea VERDICT', () => {
  const t = 'provider  model  context\nopenai    gpt-5.3-codex  400K\ngoogle    gemini-2.5-pro  1M\n';
  assert.deepEqual(parsePiModels(t).map((m) => m.model), ['openai/gpt-5.3-codex', 'google/gemini-2.5-pro']);
  assert.deepEqual(parseVerdict('VERDICT approved'), { approved: true, reason: '' });
  assert.deepEqual(parseVerdict('algo\nVERDICT rejected: faltan tests'), { approved: false, reason: 'faltan tests' });
  assert.equal(parseVerdict('me parece bien'), null);
});

// UI guionizada: cada select/text consume la siguiente respuesta; comprueba que el valor exista entre las opciones.
const scripted = (answers, log = []) => ({
  select: async ({ message, options }) => {
    const v = answers.shift();
    log.push({ message, options });
    assert.ok(options.some((o) => o.value === v && !o.disabled), `«${message}»: ${String(v)} no es una opción válida (${options.map((o) => o.value)})`);
    return v;
  },
  text: async ({ message }) => { log.push({ message }); return answers.shift(); },
});
const ENV = { herdr: true, runners: { claude: true, pi: true, codex: true, opencode: false, antigravity: true }, install: {} };

const piList = (runner) => (runner === 'pi' ? [{ provider: 'openai', id: 'gpt-5.3-codex', model: 'openai/gpt-5.3-codex' }, { provider: 'openai', id: 'gpt-5.5', model: 'openai/gpt-5.5' }] : []);
const HIGH = { T0: 'high', T1: 'high', T2: 'high' };
const menu = (log, message) => log.filter((l) => l.message === message).at(-1);

test('asistente: lista de agentes con su info; al elegir uno se ve su config y se cambia campo por campo', async () => {
  const said = []; const log = [];
  const ui = scripted([
    'executor', 'model', 'openai/gpt-5.3-codex', '__back',                  // executor: solo el modelo
    'reviewer', 'runner', 'pi', 'openai/gpt-5.5', 'effort', 'high', '__back', // reviewer: runner (pide el modelo enseguida) y esfuerzo
    '__save',
  ], log);
  const r = await runWizard({ profile: withModels({}), env: ENV, ui, say: (m) => said.push(m), listModels: piList });
  assert.deepEqual(r.patches, {
    'models.executor.provider': 'pi', 'models.executor.model': 'openai/gpt-5.3-codex',
    'models.reviewer.provider': 'pi', 'models.reviewer.model': 'openai/gpt-5.5', 'models.reviewer.effort': HIGH, // era medium/high/high
  });
  const list = log[0].options.map((o) => o.label);
  assert.match(list[0], /^planner\s+claude · claude-opus-5-5 · medium\/high\/high$/); // la info de cada agente está en la lista
  assert.match(list[1], /^executor\s+pi · default del runner · medium\/high\/high$/);
  assert.match(list[4], /^explore\s+claude · claude-haiku-5-5 · sin esfuerzo$/);
  const detail = log.find((l) => l.message === 'planner' || l.message === 'executor').options.map((o) => o.label);
  assert.deepEqual(detail.slice(0, 3), ['Runner     pi', 'Modelo     default del runner', 'Esfuerzo   T0 medium · T1 high · T2 high']);
  assert.match(menu(log, 'reviewer  (cambiado)').options[0].label, /Runner     pi/); // al volver se ve lo ya cambiado
  assert.match(said.join('\n'), /misma familia/); // gpt-5.3-codex y gpt-5.5: ambos openai
  assert.deepEqual(r.changes.filter((c) => c.includes('reviewer') || c.includes('runner') || c.includes('modelo') || c.includes('esfuerzo')).slice(-4), ['  reviewer', '    runner     claude → pi', '    modelo     claude-sonnet-5-5 → openai/gpt-5.5', '    esfuerzo   T0 medium · T1 high · T2 high → high']);
  assert.equal(log.find((l) => l.message === 'reviewer · runner').options.find((o) => o.value === 'opencode').disabled, true); // no instalado
  assert.deepEqual((await runWizard({ profile: withModels({}), env: ENV, ui: null, yes: true })).patches, {});
});

test('asistente: salir sin cambios, salir con cambios pide confirmar, y descartar no deja parches', async () => {
  const none = await runWizard({ profile: withModels({}), env: ENV, ui: scripted(['__save']) });
  assert.deepEqual(none.patches, {});
  assert.equal((await runWizard({ profile: withModels({}), env: ENV, ui: scripted(['__save']) })).cancelled, undefined); // «Salir» sin cambios no es cancelar
  const log = [];
  const quit = await runWizard({ profile: withModels({}), env: ENV, ui: scripted(['planner', 'effort', 'low', '__back', '__quit', false, '__quit', true], log) });
  assert.deepEqual([quit.cancelled, quit.patches], [true, {}]);
  assert.match(menu(log, 'Hay 1 cambio(s) sin guardar').options.map((o) => o.label).join('|'), /Volver a la lista\|Descartar y salir/);
  assert.ok(log.some((l) => l.options?.some((o) => o.value === '__save' && /Guardar y salir \(1 cambio\)/.test(o.label)))); // el contador de cambios
});

test('asistente: esfuerzo igual en los tres tiers o por tier; no aplica a explore ni a opencode', async () => {
  const one = await runWizard({ profile: withModels({}), env: ENV, ui: scripted(['executor', 'effort', 'xhigh', '__back', '__save']) });
  assert.deepEqual(one.patches, { 'models.executor.effort': { T0: 'xhigh', T1: 'xhigh', T2: 'xhigh' } }); // pi · default ya era el valor de fábrica: solo cambia el esfuerzo
  const tiers = await runWizard({ profile: withModels({}), env: ENV, ui: scripted(['executor', 'effort', '__per_tier', 'low', 'medium', 'xhigh', '__back', '__save']) });
  assert.deepEqual(tiers.patches['models.executor.effort'], { T0: 'low', T1: 'medium', T2: 'xhigh' });
  const log = [];
  await runWizard({ profile: withModels({}), env: ENV, ui: scripted(['explore', '__back', '__save'], log) });
  assert.equal(menu(log, 'explore').options.find((o) => o.value === 'effort').disabled, true); // Haiku no admite esfuerzo
  const oc = [];
  await runWizard({
    profile: withModels({}), env: { ...ENV, runners: { ...ENV.runners, opencode: true } }, ui: scripted(['executor', 'runner', 'opencode', 'opencode/big-pickle', '__back', '__save'], oc),
    listModels: (r) => (r === 'opencode' ? [{ model: 'opencode/big-pickle' }] : []),
  });
  assert.equal(menu(oc, 'executor  (cambiado)').options.find((o) => o.value === 'effort').disabled, true); // opencode no recibe el esfuerzo
});

test('asistente: un runner sin lista pide el modelo escrito, y «Escribir otro…» también', async () => {
  const typed = await runWizard({ profile: withModels({}), env: ENV, ui: scripted(['planner', 'runner', 'antigravity', 'gemini-3.8-flash-high', '__back', '__save']) });
  assert.deepEqual(typed.patches, { 'models.planner.provider': 'antigravity', 'models.planner.model': 'gemini-3.8-flash-high' });
  const log = [];
  const custom = await runWizard({ profile: withModels({}), env: ENV, ui: scripted(['executor', 'model', '__custom', 'gemini-9', '__back', '__save'], log), listModels: (r) => (r === 'pi' ? [{ model: 'openai/x' }] : []) });
  assert.deepEqual(menu(log, 'executor · modelo (pi)').options.map((o) => o.value), ['__default', 'openai/x', '__custom']);
  assert.equal(custom.patches['models.executor.model'], 'gemini-9');
});

test('CLI: config role --global escribe el global; show indica la capa; role valida el runner', () => {
  const root = tmp(); const g = join(root, 'g', 'config.json');
  mkdirSync(join(root, '.harness'));
  const run = (...a) => spawnSync('node', [BIN, ...a, '--root', root], { encoding: 'utf8', env: { ...process.env, HARNESS_CONFIG: g } });
  const set = run('config', 'role', 'reviewer', 'pi', 'google/gemini-2.5-pro', '--global');
  assert.equal(set.status, 0, set.stderr);
  assert.deepEqual(JSON.parse(readFileSync(g, 'utf8')).models.reviewer, { provider: 'pi', model: 'google/gemini-2.5-pro' });
  assert.equal(existsSync(join(root, '.harness/profile.json')), false); // el proyecto no se tocó
  const show = JSON.parse(run('config', 'show', '--json').stdout);
  assert.deepEqual([show.roles.reviewer.runner, show.roles.reviewer.model, show.roles.reviewer.from], ['pi', 'google/gemini-2.5-pro', 'global']);
  assert.equal(show.roles.planner.from, 'defecto');
  run('config', 'role', 'reviewer', 'claude', 'claude-sonnet-5-5'); // el proyecto sobrescribe
  assert.equal(JSON.parse(run('config', 'show', '--json').stdout).roles.reviewer.from, 'proyecto');
  assert.match(run('config', 'show').stdout, /reviewer\s+claude · claude-sonnet-5-5 · T0 medium · T1 high · T2 high\s+\[proyecto\]/); // texto legible por defecto
  assert.notEqual(run('config', 'role', 'reviewer', 'nada').status, 0);
});

// pi falso: lista dos proveedores y responde un veredicto fijo por JSONL.
function fakePi(dir, reply) {
  const f = join(dir, 'pi');
  const ev = (o) => JSON.stringify(o).replace(/'/g, "'\\''");
  writeFileSync(f, `#!/usr/bin/env bash
if [ "$1" = "--list-models" ]; then printf 'provider model context\\nopenai gpt-5.3-codex 400K\\ngoogle gemini-2.5-pro 1M\\n'; exit 0; fi
echo '${ev({ type: 'session', id: 's1' })}'
echo '${ev({ type: 'message_end', message: { role: 'assistant', model: 'gemini-2.5-pro', content: [{ type: 'text', text: reply }], usage: { input: 10, output: 5, cost: { total: 0.01 } } } })}'
`);
  chmodSync(f, 0o755);
  return f;
}

test('exec: el reviewer corre en pi con gemini, su VERDICT mueve la tarea y el executor queda en codex', () => {
  const root = tmp();
  spawnSync('git', ['init', '-q'], { cwd: root });
  spawnSync('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=t', 'commit', '--allow-empty', '-q', '-m', 'init'], { cwd: root });
  mkdirSync(join(root, '.harness'));
  const prof = { gate: { cmd: 'true' }, models: { executor: { provider: 'pi', model: 'openai/gpt-5.3-codex' }, reviewer: { provider: 'pi', model: 'google/gemini-2.5-pro' } } };
  writeFileSync(join(root, '.harness/profile.json'), JSON.stringify(prof));
  const P = loadProfile(root);
  addTask(root, P, { id: 'r1', title: 'x', category: 'feature', paths: ['src/**'] });
  for (const e of ['approve']) applyEvent(root, P, 'r1', e);
  applyEvent(root, P, 'r1', 'exec_started', { provider: 'pi', model: 'openai/gpt-5.3-codex' });
  applyEvent(root, P, 'r1', 'exec_done');
  applyEvent(root, P, 'r1', 'gate_pass');
  assert.equal(nextStep(P, loadBacklog(root).tasks.r1).route.model, 'google/gemini-2.5-pro'); // familias distintas: sin wait
  const run = (reply) => spawnSync('node', [BIN, 'exec', 'r1', '--role', 'reviewer', '--quiet', '--root', root], { encoding: 'utf8', env: { ...process.env, PI_BIN: fakePi(root, reply), HERDR_ENV: '' } });
  const bad = run('me parece bien');
  assert.equal(bad.status, 2, bad.stdout + bad.stderr);
  assert.equal(loadBacklog(root).tasks.r1.status, 'reviewing'); // sin VERDICT no hay veredicto
  const ok = run('VERDICT approved');
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.equal(JSON.parse(ok.stdout).verdict, 'approved');
  assert.equal(loadBacklog(root).tasks.r1.status, 'done');
});

test('exec: se niega a revisar si el reviewer es de la misma familia que el executor', () => {
  const root = tmp();
  mkdirSync(join(root, '.harness'));
  writeFileSync(join(root, '.harness/profile.json'), JSON.stringify({ gate: { cmd: 'true' }, models: { executor: { provider: 'pi', model: 'openai/gpt-5.3-codex' }, reviewer: { provider: 'pi', model: 'openai/gpt-5.5', crossFamily: null } } }));
  const P = loadProfile(root);
  addTask(root, P, { id: 'r2', title: 'x', category: 'feature', paths: ['src/**'] });
  applyEvent(root, P, 'r2', 'approve');
  applyEvent(root, P, 'r2', 'exec_started', { provider: 'pi', model: 'openai/gpt-5.3-codex' });
  applyEvent(root, P, 'r2', 'exec_done'); applyEvent(root, P, 'r2', 'gate_pass');
  const n = nextStep(P, loadBacklog(root).tasks.r2);
  assert.equal(n.action, 'wait');
  assert.match(n.reason, /misma familia/);
});

// ---------- codex y opencode (eventos reales capturados con `codex exec --json` y `opencode run --format json`) ----------
import { codexArgs, formatRunEvent, isSettled, opencodeArgs, parseCodexJsonl, parseOpencodeJsonl, withRoleFile } from '../src/runners.mjs';

const CODEX_OUT = [
  { type: 'thread.started', thread_id: 'th-1' },
  { type: 'item.completed', item: { id: 'item_0', type: 'error', message: 'loading hooks from both hooks.json and config.toml' } }, // aviso, no fallo
  { type: 'turn.started' },
  { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'DONE ok' } },
  { type: 'turn.completed', usage: { input_tokens: 21716, cached_input_tokens: 1000, cache_write_input_tokens: 0, output_tokens: 6, reasoning_output_tokens: 0 } },
].map((e) => JSON.stringify(e)).join('\n');
const OC_OUT = [
  { type: 'step_start', sessionID: 'ses_1', part: { type: 'step-start' } },
  { type: 'text', sessionID: 'ses_1', part: { type: 'text', text: 'DONE ok' } },
  { type: 'step_finish', sessionID: 'ses_1', part: { type: 'step-finish', reason: 'stop', tokens: { total: 37184, input: 35368, output: 5, reasoning: 19, cache: { write: 0, read: 1792 } }, cost: 0.002 } },
].map((e) => JSON.stringify(e)).join('\n');

test('codex: argumentos de la corrida y lectura de su JSONL (el aviso de hooks no es un fallo)', () => {
  assert.deepEqual(codexArgs({ model: 'gpt-5.3-codex', effort: 'high' }, { prompt: 'P', sandbox: 'workspace-write' }),
    ['exec', '--json', '--ephemeral', '-s', 'workspace-write', '-m', 'gpt-5.3-codex', '-c', 'model_reasoning_effort="high"', 'P']);
  assert.deepEqual(codexArgs({ model: null, effort: null }, { prompt: 'P' }), ['exec', '--json', '--ephemeral', '-s', 'workspace-write', 'P']); // sin modelo: el de Codex
  const r = parseCodexJsonl(CODEX_OUT, { model: 'gpt-6.1-sol' });
  assert.deepEqual([r.session, r.text, r.error, r.turns, r.in, r.cached, r.out], ['th-1', 'DONE ok', '', 1, 21716, 1000, 6]);
  assert.ok(r.cost > 0); // gpt-6.1-sol tiene tarifa
  assert.equal(parseCodexJsonl(CODEX_OUT, { model: 'modelo-sin-tarifa' }).cost, 0);
  const failed = parseCodexJsonl(JSON.stringify({ type: 'turn.failed', error: { message: 'usage limit' } }));
  assert.equal(failed.error, 'usage limit');
});

test('opencode: argumentos y lectura de su JSON (entrada incluye caché, salida incluye razonamiento)', () => {
  assert.deepEqual(opencodeArgs({ model: 'opencode/big-pickle', effort: 'high' }, { prompt: 'P' }), ['run', '--format', 'json', '--auto', '-m', 'opencode/big-pickle', 'P']); // el esfuerzo no se pasa
  const r = parseOpencodeJsonl(OC_OUT, { model: 'opencode/big-pickle' });
  assert.deepEqual([r.session, r.text, r.turns, r.in, r.cached, r.out, r.cost], ['ses_1', 'DONE ok', 1, 35368 + 1792, 1792, 5 + 19, 0.002]);
  assert.equal(parseOpencodeJsonl(JSON.stringify({ type: 'error', error: { name: 'ProviderAuthError', data: { message: 'no auth' } } })).error, 'no auth');
});

test('eventos en vivo: una línea legible por runner y cuándo terminó la corrida', () => {
  assert.equal(formatRunEvent({ type: 'item.completed', item: { type: 'agent_message', text: 'hola' } }), '💬 hola');
  assert.match(formatRunEvent({ type: 'item.started', item: { type: 'command_execution', command: 'pnpm test' } }), /🔧 bash pnpm test/);
  assert.match(formatRunEvent({ type: 'tool_use', part: { tool: 'bash', state: { status: 'completed', input: { command: 'ls' } } } }), /🔧 bash ls/);
  assert.equal(formatRunEvent({ type: 'agent_settled' }), '■ terminó'); // pi sigue igual
  assert.deepEqual([{ type: 'turn.completed' }, { type: 'agent_settled' }, { type: 'step_finish', part: { reason: 'stop' } }, { type: 'step_finish', part: { reason: 'tool-calls' } }, { type: 'item.completed' }].map(isSettled), [true, true, true, false, false]);
});

test('prompt de rol: pi lo recibe por bandera; codex y opencode, la orden de leerlo primero', () => {
  assert.equal(withRoleFile('pi', 'T', '.harness/prompts/executor.md'), 'T');
  assert.match(withRoleFile('codex', 'T', '.harness/prompts/executor.md'), /^Your role instructions are in \.harness\/prompts\/executor\.md.*\nT$/s);
});

// Binarios falsos que imprimen un JSONL fijo; guardan sus argumentos para comprobarlos.
function fakeBin(dir, name, lines, { commit = false } = {}) {
  const f = join(dir, name);
  writeFileSync(f, `#!/usr/bin/env bash
if [ "$1" = "models" ]; then printf 'opencode/big-pickle\\nopenai/gpt-5.5\\n'; exit 0; fi
printf '%s\\n' "$@" > "${dir}/${name}.args"
${commit ? "git commit --allow-empty -q -m 'feat: x'" : ''}
cat <<'EOF2'
${lines}
EOF2
`);
  chmodSync(f, 0o755);
  return f;
}
function repo(models) {
  const root = tmp();
  spawnSync('git', ['init', '-q'], { cwd: root });
  spawnSync('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=t', 'commit', '--allow-empty', '-q', '-m', 'init'], { cwd: root });
  mkdirSync(join(root, '.harness'));
  writeFileSync(join(root, '.harness/profile.json'), JSON.stringify({ gate: { cmd: 'true' }, models }));
  return root;
}
const gitEnv = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 'a@b.c', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 'a@b.c' };

test('exec: el executor corre en codex, deja commits, pasa al gate y se registra con su runner', () => {
  const root = repo({ executor: { provider: 'codex', model: 'gpt-5.3-codex' } });
  const P = loadProfile(root);
  addTask(root, P, { id: 'c1', title: 'x', category: 'feature', paths: ['src/**'] });
  applyEvent(root, P, 'c1', 'approve');
  const bin = fakeBin(root, 'codex', CODEX_OUT, { commit: true });
  const r = spawnSync('node', [BIN, 'exec', 'c1', '--quiet', '--root', root], { encoding: 'utf8', env: { ...process.env, ...gitEnv, CODEX_BIN: bin, HERDR_ENV: '' } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const t = loadBacklog(root).tasks.c1;
  assert.deepEqual([t.status, t.executor, t.executorModel], ['gating', 'codex', 'gpt-5.3-codex']);
  const args = readFileSync(join(root, 'codex.args'), 'utf8');
  assert.match(args, /^exec\n--json\n--ephemeral\n-s\ndanger-full-access\n-m\ngpt-5\.3-codex/); // el sandbox de Codex bloquea .git: el executor no podría commitear
  assert.match(args, /Your role instructions are in \.harness\/prompts\/executor\.md/);
});

test('exec: sin commits el executor de codex falla y la salida trae la pista del sandbox', () => {
  const root = repo({ executor: { provider: 'codex', model: 'gpt-5.3-codex' } });
  const P = loadProfile(root);
  addTask(root, P, { id: 'c2', title: 'x', category: 'feature', paths: ['src/**'] });
  applyEvent(root, P, 'c2', 'approve');
  const bin = fakeBin(root, 'codex', CODEX_OUT.replace('DONE ok', 'FAILED no pude escribir'));
  const r = spawnSync('node', [BIN, 'exec', 'c2', '--quiet', '--root', root], { encoding: 'utf8', env: { ...process.env, CODEX_BIN: bin, HERDR_ENV: '' } });
  assert.equal(r.status, 2);
  assert.match(JSON.parse(r.stdout).hint, /execSandbox/);
  assert.equal(loadBacklog(root).tasks.c2.attempts, 1);
});

test('exec: el reviewer corre en opencode; el modelo se valida contra `opencode models`', () => {
  const root = repo({ executor: { provider: 'codex', model: 'gpt-5.3-codex' }, reviewer: { provider: 'opencode', model: 'opencode/big-pickle' } });
  const P = loadProfile(root);
  addTask(root, P, { id: 'o1', title: 'x', category: 'feature', paths: ['src/**'] });
  applyEvent(root, P, 'o1', 'approve');
  applyEvent(root, P, 'o1', 'exec_started', { provider: 'codex', model: 'gpt-5.3-codex' });
  applyEvent(root, P, 'o1', 'exec_done'); applyEvent(root, P, 'o1', 'gate_pass');
  const run = (text) => spawnSync('node', [BIN, 'exec', 'o1', '--role', 'reviewer', '--quiet', '--root', root], { encoding: 'utf8', env: { ...process.env, OPENCODE_BIN: fakeBin(root, 'opencode', OC_OUT.replace('DONE ok', text)), HERDR_ENV: '' } });
  const ok = run('VERDICT rejected: faltan tests');
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.equal(JSON.parse(ok.stdout).verdict, 'rejected');
  const t = loadBacklog(root).tasks.o1;
  assert.deepEqual([t.status, t.attempts], ['executing', 1]); // rechazado: vuelve al executor con un reintento
  assert.match(readFileSync(join(root, 'opencode.args'), 'utf8'), /^run\n--format\njson\n--auto\n-m\nopencode\/big-pickle/);
  writeFileSync(join(root, '.harness/profile.json'), JSON.stringify({ gate: { cmd: 'true' }, models: { executor: { provider: 'codex', model: 'gpt-5.3-codex' }, reviewer: { provider: 'opencode', model: 'nada/inexistente' } } }));
  applyEvent(root, loadProfile(root), 'o1', 'exec_started', { provider: 'codex', model: 'gpt-5.3-codex' });
  applyEvent(root, loadProfile(root), 'o1', 'exec_done'); applyEvent(root, loadProfile(root), 'o1', 'gate_pass');
  const bad = run('VERDICT approved');
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /opencode no conoce el modelo nada\/inexistente/);
});

test('exec: un runner sin lanzador (claude) se explica en vez de fallar mudo', () => {
  const root = repo({ executor: { provider: 'claude', model: 'claude-opus-5-5' } });
  const P = loadProfile(root);
  addTask(root, P, { id: 'x1', title: 'x', category: 'feature', paths: ['src/**'] });
  applyEvent(root, P, 'x1', 'approve');
  const r = spawnSync('node', [BIN, 'exec', 'x1', '--quiet', '--root', root], { encoding: 'utf8', env: { ...process.env, HERDR_ENV: '' } });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /subagente de Claude/);
});

// ---------- antigravity (eventos reales de `agy --print --output-format stream-json`) ----------
import { agyArgs, modelsFor, parseAgyJsonl } from '../src/runners.mjs';

const AGY_OUT = [
  { event: 'init', conversation_id: 'c-1', init: { cwd: '/x', tools: ['run_command'], permission_mode: 'always-proceed' } },
  { event: 'step_update', step_update: { conversation_id: 'c-1', step_index: 0, state: 'DONE', step_type: 'user_input' } },
  { event: 'step_update', step_update: { conversation_id: 'c-1', step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'DONE ok' } },
  { event: 'result', result: { conversation_id: 'c-1', status: 'SUCCESS', response: 'DONE ok\n', num_turns: 1, usage: { input_tokens: 14555, output_tokens: 187, thinking_tokens: 185, cache_read_tokens: 100, total_tokens: 14742 } } },
].map((e) => JSON.stringify(e)).join('\n');

test('antigravity: argumentos (sin --effort si el id de Gemini ya lo trae) y lectura del resultado', () => {
  assert.deepEqual(agyArgs({ model: 'gemini-3.8-flash-high', effort: 'high' }, { prompt: 'P' }), ['--print', 'P', '--output-format', 'stream-json', '--dangerously-skip-permissions', '--model', 'gemini-3.8-flash-high']);
  assert.deepEqual(agyArgs({ model: 'claude-opus-4-6-thinking', effort: 'xhigh' }, { prompt: 'P' }).slice(-2), ['--effort', 'xhigh']);
  assert.deepEqual(agyArgs({ model: null, effort: null }, { prompt: 'P' }), ['--print', 'P', '--output-format', 'stream-json', '--dangerously-skip-permissions']);
  const r = parseAgyJsonl(AGY_OUT, { model: 'gemini-3.8-flash-high' });
  assert.deepEqual([r.session, r.text, r.error, r.turns, r.in, r.cached, r.out], ['c-1', 'DONE ok', '', 1, 14655, 100, 372]);
  const bad = parseAgyJsonl(JSON.stringify({ event: 'result', result: { status: 'ERROR', response: '' } }));
  assert.equal(bad.error, 'ERROR');
  assert.equal(parseAgyJsonl(AGY_OUT.split('\n').slice(0, 3).join('\n')).text, 'DONE ok'); // sin result: lo que llegó por deltas
  assert.equal(familyOf('antigravity', 'gemini-3.8-flash-high'), 'google');
});

test('antigravity: eventos en vivo y fin de la corrida', () => {
  assert.equal(formatRunEvent({ event: 'result', result: { status: 'SUCCESS' } }), '■ terminó');
  assert.equal(formatRunEvent({ event: 'step_update', step_update: { state: 'DONE', step_type: 'run_command' } }), '🔧 run_command');
  assert.equal(formatRunEvent({ event: 'step_update', step_update: { state: 'DONE', step_type: 'user_input' } }), null);
  assert.deepEqual([{ event: 'result' }, { event: 'init' }].map(isSettled), [true, false]);
});

test('modelos por runner: claude y codex sugieren los conocidos; un binario ausente da lista vacía', () => {
  assert.ok(modelsFor({}, 'claude').some((m) => m.model === 'claude-opus-5-5'));
  assert.ok(modelsFor({}, 'codex').length > 0);
  assert.deepEqual(modelsFor({ antigravity: { bin: '/no/existe' } }, 'antigravity'), []);
});

test('exec: el reviewer corre en antigravity con Gemini y su VERDICT cierra la tarea', () => {
  const root = repo({ executor: { provider: 'codex', model: 'gpt-5.3-codex' }, reviewer: { provider: 'antigravity', model: 'gemini-3.8-flash-high' } });
  const P = loadProfile(root);
  addTask(root, P, { id: 'a1', title: 'x', category: 'feature', paths: ['src/**'] });
  applyEvent(root, P, 'a1', 'approve');
  applyEvent(root, P, 'a1', 'exec_started', { provider: 'codex', model: 'gpt-5.3-codex' });
  applyEvent(root, P, 'a1', 'exec_done'); applyEvent(root, P, 'a1', 'gate_pass');
  const bin = fakeBin(root, 'agy', AGY_OUT.replace('DONE ok\\n', 'VERDICT approved').replace('"DONE ok"', '"VERDICT approved"'));
  const r = spawnSync('node', [BIN, 'exec', 'a1', '--role', 'reviewer', '--quiet', '--root', root], { encoding: 'utf8', env: { ...process.env, AGY_BIN: bin, HERDR_ENV: '' } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(JSON.parse(r.stdout).verdict, 'approved');
  assert.equal(loadBacklog(root).tasks.a1.status, 'done');
  assert.match(readFileSync(join(root, 'agy.args'), 'utf8'), /^--print\n/);
});

// ---------- menús (reducer puro, sin terminal) ----------

const K = (name, extra = {}) => ({ name, sequence: extra.sequence ?? '', ...extra });
const OPTS = [{ value: 'a', label: 'alfa' }, { value: 'b', label: 'beta', disabled: true }, { value: 'c', label: 'gamma' }, { value: 'd', label: 'delta' }];

test('menú: las flechas se saltan lo deshabilitado, Enter elige y Esc cancela', () => {
  let st = initSelect({ options: OPTS });
  assert.equal(st.cursor, 0);
  st = reduceSelect(st, K('down')).state;
  assert.equal(st.cursor, 2); // beta está deshabilitada
  assert.deepEqual(reduceSelect(st, K('return')), { done: 'c' });
  assert.equal(reduceSelect(initSelect({ options: OPTS }), K('up')).state.cursor, 0); // no sale por arriba
  assert.deepEqual(reduceSelect(st, K('escape')), { cancel: true });
  assert.deepEqual(reduceSelect(st, K('c', { ctrl: true })), { cancel: true });
  assert.equal(initSelect({ options: OPTS, initial: 'd' }).cursor, 3); // initial por valor
});

test('menú: teclear filtra (solo si es filtrable), Backspace deshace y Esc limpia el filtro antes de cancelar', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ value: `m${i}`, label: i % 2 ? `openai/gpt-${i}` : `google/gemini-${i}` }));
  let st = initSelect({ options: many, filterable: true, pageSize: 5 });
  for (const ch of 'gemini') st = reduceSelect(st, K(ch, { sequence: ch })).state;
  assert.ok(visibleOptions(st).length === 15 && visibleOptions(st).every((o) => o.label.startsWith('google')));
  assert.deepEqual(reduceSelect(st, K('return')), { done: 'm0' });
  st = reduceSelect(st, K('backspace')).state;
  assert.equal(st.filter, 'gemin');
  st = reduceSelect(st, K('escape')).state;
  assert.equal(st.filter, ''); // el primer Esc solo limpia el filtro
  assert.deepEqual(reduceSelect(st, K('escape')), { cancel: true });
  const plain = initSelect({ options: OPTS });
  assert.equal(reduceSelect(plain, K('x', { sequence: 'x' })).state.filter, ''); // sin filtrable no filtra
});

test('menú: la ventana sigue al cursor y el render marca la opción actual', () => {
  const many = Array.from({ length: 25 }, (_, i) => ({ value: i, label: `op${i}` }));
  let st = initSelect({ options: many, pageSize: 5 });
  for (let i = 0; i < 12; i++) st = reduceSelect(st, K('down')).state;
  assert.equal(st.cursor, 12);
  assert.ok(st.top <= 12 && 12 < st.top + 5);
  const lines = renderSelect(st, 'Elige', { color: false });
  assert.equal(lines[0], '? Elige');
  assert.ok(lines.some((l) => l.startsWith('❯ op12')));
  assert.match(lines.at(-1), /13\/25/);
  assert.deepEqual(reduceText({ value: 'ab' }, K('backspace')), { state: { value: 'a' } });
  assert.deepEqual(reduceText({ value: 'ab' }, K('return')), { done: 'ab' });
});

test('menú: las líneas largas cuentan por filas físicas, para que el redibujado no deje residuos', () => {
  assert.equal(physicalRows(['corta', 'otra'], 80), 2);
  assert.equal(physicalRows(['x'.repeat(100)], 80), 2); // se parte en dos filas
  assert.equal(physicalRows(['x'.repeat(160)], 80), 2);
  assert.equal(physicalRows(['x'.repeat(161)], 80), 3);
  assert.equal(physicalRows([''], 80), 1); // una línea vacía ocupa una fila
  assert.equal(physicalRows(['\x1b[36m' + 'x'.repeat(70) + '\x1b[0m'], 80), 1); // los colores no ocupan columnas
  assert.equal(physicalRows(['x'.repeat(50)], 40), 2);
});
