import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { matches } from '../src/glob.mjs';
import { classify } from '../src/classify.mjs';
import { route } from '../src/router.mjs';
import { DEFAULT_PROFILE } from '../src/defaults.mjs';
import { addTask, applyEvent, nextStep } from '../src/tasks.mjs';
import { loadBacklog, loadProfile } from '../src/store.mjs';
import { parseTranscript, costOf, collect } from '../src/metrics.mjs';
import { readRows } from '../src/toonfile.mjs';
import { proposeProfile } from '../src/init.mjs';
import { chmodSync } from 'node:fs';

const P = { ...DEFAULT_PROFILE, tiers: { t2: ['migrations/**', 'src/**/auth/**'], t1: [], ui: ['src/components/**'] }, gate: { cmd: 'true' } };
const tmp = () => mkdtempSync(join(tmpdir(), 'harness-'));

test('glob', () => {
  assert.ok(matches('src/a/b/auth/x.ts', ['src/**/auth/**']));
  assert.ok(matches('README.md', ['**/*.md']));
  assert.ok(!matches('src/a.ts', ['**/*.md']));
  assert.ok(!matches('src/a/b.ts', ['src/*.ts']));
});

test('classify: gana el tier más alto y detiene docs que toca src', () => {
  assert.equal(classify(P, 'docs', ['README.md']).tier, 'T0');
  assert.equal(classify(P, 'feature', ['src/x.ts']).tier, 'T1');
  assert.equal(classify(P, 'refactor', ['migrations/1.sql']).tier, 'T2');
  const bad = classify(P, 'docs', ['src/x.ts']);
  assert.equal(bad.ok, false);
  assert.match(bad.errors[0], /fuera de su alcance/);
  assert.equal(classify(P, 'feature', ['src/components/B.tsx']).ui, true);
  assert.equal(classify(P, 'hotfix', []).base, 'main');
  assert.equal(classify(P, 'nada', []).ok, false);
});

test('router: Claude solo planner y QA (Sonnet 5.5); executor, designer y explore en Codex; sin fallback del executor', () => {
  assert.deepEqual(route(P, 'planner', { tier: 'T1' }), { role: 'planner', provider: 'claude', model: 'claude-opus-5-5', effort: 'high' });
  assert.deepEqual(route(P, 'executor', { tier: 'T1' }), { role: 'executor', provider: 'codex', model: 'gpt-6.1-sol', effort: 'high' });
  assert.equal(route(P, 'executor', { tier: 'T1', attempt: 1 }).effort, 'xhigh'); // un reintento sube un nivel
  assert.equal(route(P, 'executor', { tier: 'T0' }).effort, 'medium');
  assert.equal(route(P, 'executor', { tier: 'T0', attempt: 1 }).effort, 'high');
  // Sin Codex NO cae a Claude: espera y avisa
  const down = route(P, 'executor', { available: ['claude'] });
  assert.equal(down.wait, true);
  assert.match(down.reason, /no hay fallback a Claude/);
  assert.equal(route(P, 'executor', { available: [] }).wait, true);
  // QA: Sonnet 5.5, de otra familia que el executor (Codex)
  assert.deepEqual(route(P, 'reviewer', { tier: 'T2', executorProvider: 'codex' }), { role: 'reviewer', provider: 'claude', model: 'claude-sonnet-5-5', effort: 'high' });
  // Solo si un humano registró que ejecutó Claude, el revisor pasa a Codex
  assert.equal(route(P, 'reviewer', { tier: 'T2', executorProvider: 'claude' }).provider, 'codex');
  const noCross = { ...P, models: { ...P.models, reviewer: { ...P.models.reviewer, crossFamily: undefined } } };
  assert.equal(route(noCross, 'reviewer', { executorProvider: 'claude' }).wait, true);
  assert.equal(route(P, 'reviewer', { executorProvider: 'codex', available: ['codex'] }).wait, true); // el QA es Claude y no está disponible
  // explore: Haiku 5.5 (script + `claude -p`), sin esfuerzo
  assert.deepEqual(route(P, 'explore', { tier: 'T2' }), { role: 'explore', provider: 'claude', model: 'claude-haiku-5-5', effort: null });
});

test('designer: Codex con Pencil por defecto; una clave lo pasa a Claude (Sonnet 5.5, xhigh)', () => {
  assert.deepEqual(route(P, 'designer', { tier: 'T1' }), { role: 'designer', provider: 'codex', model: 'gpt-6.1-sol', effort: 'high' });
  const claude = { ...P, models: { ...P.models, designer: { ...P.models.designer, use: 'claude' } } };
  assert.deepEqual(route(claude, 'designer', { tier: 'T1' }), { role: 'designer', provider: 'claude', model: 'claude-sonnet-5-5', effort: 'xhigh' });
  assert.equal(route(P, 'designer', { tier: 'T1', attempt: 1 }).effort, 'xhigh');
  assert.equal(route(claude, 'designer', { tier: 'T1', attempt: 1 }).effort, 'xhigh'); // el tope del reintento es xhigh
});

test('máquina de estados: T1 con revisión, reintento, bloqueo y T0 se cierra con el gate', () => {
  const root = tmp();
  addTask(root, P, { id: 'a1', title: 'x', category: 'feature', paths: ['src/**'] });
  const st = () => loadBacklog(root).tasks.a1;
  assert.equal(nextStep(P, st()).action, 'await_approval');
  assert.throws(() => applyEvent(root, P, 'a1', 'gate_pass'), /no válido/);
  applyEvent(root, P, 'a1', 'approve');
  assert.equal(nextStep(P, st()).role, 'executor');
  applyEvent(root, P, 'a1', 'exec_started', { provider: 'codex' });
  applyEvent(root, P, 'a1', 'exec_done');
  assert.equal(nextStep(P, st()).action, 'gate');
  applyEvent(root, P, 'a1', 'gate_fail');
  assert.equal(st().status, 'executing');
  assert.equal(st().attempts, 1);
  assert.equal(nextStep(P, st()).route.effort, 'xhigh');
  applyEvent(root, P, 'a1', 'exec_done');
  applyEvent(root, P, 'a1', 'gate_pass');
  const n = nextStep(P, st());
  assert.equal(n.role, 'reviewer');
  assert.equal(n.events.start, 'review_started');
  assert.equal(n.route.provider, 'claude'); // el executor fue codex
  applyEvent(root, P, 'a1', 'review_started');
  applyEvent(root, P, 'a1', 'verdict_rejected');
  assert.equal(st().status, 'blocked');
  assert.equal(nextStep(P, st()).action, 'human');
  applyEvent(root, P, 'a1', 'human_retry');
  assert.equal(st().status, 'executing');

  addTask(root, P, { id: 't0', title: 'doc', category: 'docs', paths: ['README.md'] });
  applyEvent(root, P, 't0', 'approve');
  applyEvent(root, P, 't0', 'exec_started', { provider: 'codex' });
  applyEvent(root, P, 't0', 'exec_done');
  applyEvent(root, P, 't0', 'gate_pass');
  assert.equal(loadBacklog(root).tasks.t0.status, 'done'); // T0: basta el gate
});

test('UI con el designer en Codex: diseña en Codex, y la verificación visual la hace el QA (Claude tiene Chrome)', () => {
  const root = tmp();
  addTask(root, P, { id: 'u1', title: 'ui', category: 'feature', paths: ['src/components/**'] });
  applyEvent(root, P, 'u1', 'approve');
  const t = () => loadBacklog(root).tasks.u1;
  const d = nextStep(P, t());
  assert.deepEqual([d.role, d.phase, d.route.provider], ['designer', 'spec', 'codex']);
  applyEvent(root, P, 'u1', 'design_failed'); // el designer terminó sin dejar nada
  assert.deepEqual([t().status, t().attempts], ['approved', 1]);
  assert.equal(nextStep(P, t()).route.effort, 'xhigh'); // reintento con más esfuerzo
  applyEvent(root, P, 'u1', 'design_failed');
  assert.equal(t().status, 'blocked'); // agotado: lo decide el humano
  applyEvent(root, P, 'u1', 'human_retry');
  applyEvent(root, P, 'u1', 'exec_started', { provider: 'codex' });
  applyEvent(root, P, 'u1', 'exec_done');
  applyEvent(root, P, 'u1', 'gate_pass');
  const v = nextStep(P, t());
  assert.deepEqual([v.role, v.phase, v.route.provider, v.route.model, v.events.done], ['reviewer', 'visual', 'claude', 'claude-sonnet-5-5', 'visual_done']);
});

test('UI con el designer en Claude: él mismo hace el diseño y la verificación visual; design_done reinicia los intentos', () => {
  const claude = { ...P, models: { ...P.models, designer: { ...P.models.designer, use: 'claude' } } };
  const root = tmp();
  addTask(root, claude, { id: 'u2', title: 'ui', category: 'feature', paths: ['src/components/**'] });
  applyEvent(root, claude, 'u2', 'approve');
  const t = () => loadBacklog(root).tasks.u2;
  assert.deepEqual([nextStep(claude, t()).role, nextStep(claude, t()).route.provider], ['designer', 'claude']);
  applyEvent(root, claude, 'u2', 'design_failed');
  assert.equal(t().attempts, 1);
  applyEvent(root, claude, 'u2', 'design_done');
  assert.equal(t().attempts, 0); // el diseño ya no cuenta contra los intentos del executor
  assert.equal(nextStep(claude, t()).role, 'executor');
  applyEvent(root, claude, 'u2', 'exec_started', { provider: 'codex' });
  applyEvent(root, claude, 'u2', 'exec_done');
  applyEvent(root, claude, 'u2', 'gate_pass');
  assert.deepEqual([nextStep(claude, t()).role, nextStep(claude, t()).phase], ['designer', 'visual']);
});

function fakeTranscript(dir) {
  const a = (id, model, ts, usage, extra = []) => JSON.stringify({ type: 'assistant', timestamp: ts, gitBranch: 'main', message: { id, model, usage, content: extra } });
  const u1 = { input_tokens: 100, output_tokens: 200, cache_read_input_tokens: 1000, cache_creation_input_tokens: 500, cache_creation: { ephemeral_1h_input_tokens: 500 } };
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 's1234567-aaaa.jsonl'), [
    a('msg_1', 'claude-opus-5-5', '2026-10-02T10:00:00Z', u1, [{ type: 'tool_use', name: 'Bash' }]),
    a('msg_1', 'claude-opus-5-5', '2026-10-02T10:00:01Z', u1), // bloque repetido: se deduplica
    a('msg_2', 'claude-opus-5-5', '2026-10-02T10:00:30Z', { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 1500 }, [{ type: 'tool_use', name: 'Bash' }]),
    JSON.stringify({ type: 'user', timestamp: '2026-10-02T10:01:00Z', message: { content: 'secreto' } }),
  ].join('\n'));
}

test('métricas: deduplica, calcula costo, no guarda contenido y es idempotente en TOON', () => {
  const dir = tmp();
  fakeTranscript(dir);
  const file = join(dir, 's1234567-aaaa.jsonl');
  const r = parseTranscript(file, { session: 's1234567', agent: 'main' });
  assert.equal(r.turns.length, 2);
  assert.equal(r.session.turns, 2);
  assert.equal(r.session.first_ctx, 1600);
  assert.equal(r.session.wall_s, 60);
  assert.deepEqual(r.tools, [{ session: 's1234567', agent: 'main', role: 'main', tool: 'Bash', calls: 2 }]);
  const expected = (100 * 4 + 200 * 20 + 1000 * 0.2 + 500 * 4 * 2) / 1e6;
  assert.ok(Math.abs(costOf('claude-opus-5-5', { input_tokens: 100, output_tokens: 200, cache_read_input_tokens: 1000, cache_creation_input_tokens: 500, cache_creation: { ephemeral_1h_input_tokens: 500 } }) - expected) < 1e-9);

  const root = tmp(); const md = join(root, 'm');
  const c1 = collect(root, md, { tdir: dir });
  const c2 = collect(root, md, { tdir: dir });
  assert.equal(c1.turns.total, 2);
  assert.equal(c2.turns.total, 2); // reprocesar no duplica
  assert.equal(c2.turns.added, 0);
  assert.equal(readRows(md, 'sessions')[0].turns, 2);
  const raw = readFileSync(join(md, 'turns.toon'), 'utf8');
  assert.match(raw, /^rows\[2\]\{session,agent,role,mid,model,ts,task,in,out,cache_read,cache_write,cost_est\}:/);
  assert.ok(!raw.includes('secreto'));
});

test('init: detecta el proyecto con evidencia y arma el gate', () => {
  const root = tmp();
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'vitest', lint: 'eslint .' }, dependencies: { next: '1', react: '1' } }));
  mkdirSync(join(root, 'prisma')); mkdirSync(join(root, 'src/components'), { recursive: true });
  const p = proposeProfile(root);
  assert.equal(p.profile.gate.cmd, 'npm run lint && npm test');
  assert.deepEqual(p.profile.gate.missing, ['typecheck']);
  assert.ok(p.profile.tiers.t2.includes('prisma/**'));
  assert.ok(p.profile.tiers.ui.includes('src/components/**'));
  assert.ok(p.evidence.some((e) => e.what.includes('dependencia next')));
  assert.ok(p.profile.stack.frameworks.includes('next'));
});

test('CLI: init es dry-run por defecto y no pisa un perfil existente', () => {
  const root = tmp();
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'true' } }));
  const run = (...a) => spawnSync('node', [join(import.meta.dirname, '../bin/harness.mjs'), ...a, '--root', root], { encoding: 'utf8' });
  assert.match(run('init').stdout, /dry-run/);
  assert.equal(run('init', '--apply').status, 0);
  assert.notEqual(run('init', '--apply').status, 0);
  assert.equal(loadProfile(root).gate.cmd, 'npm test');
});

import { existsSync } from 'node:fs';
import { buildAgentsMd, detect, installAgents, recommend, writeAgentsMd } from '../src/init.mjs';

const nextProject = () => {
  const root = tmp();
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'vitest', lint: 'eslint .', typecheck: 'tsc' }, dependencies: { next: '1', react: '1', '@supabase/supabase-js': '1' } }));
  mkdirSync(join(root, 'supabase/migrations'), { recursive: true }); mkdirSync(join(root, 'src/components'), { recursive: true });
  return root;
};

test('init: AGENTS.md corto (≤ 80 líneas) con gate, tiers y reglas de git', () => {
  const root = nextProject();
  const md = buildAgentsMd('demo', proposeProfile(root).profile);
  assert.ok(md.split('\n').length <= 80);
  assert.match(md, /`npm run typecheck && npm run lint && npm test`/);
  assert.match(md, /supabase\/migrations\/\*\*/);
  assert.match(md, /only the user pushes/);
  assert.match(md, /executor\*\*, \*\*designer\*\* \(Pencil\) and \*\*explore\*\* \(read-only\) run in Codex/); // el reparto vigente
  assert.match(md, /never falls back to Claude/);
});

test('init: AGENTS.md y CLAUDE.md existentes no se pisan; la propuesta queda aparte', () => {
  const root = tmp();
  assert.equal(writeAgentsMd(root, 'nuevo').written, true);
  assert.equal(readFileSync(join(root, 'AGENTS.md'), 'utf8'), 'nuevo');
  const r2 = writeAgentsMd(root, 'otro');
  assert.equal(r2.written, false);
  assert.equal(readFileSync(join(root, 'AGENTS.md'), 'utf8'), 'nuevo');
  assert.equal(readFileSync(r2.proposal, 'utf8'), 'otro');
  const root2 = tmp(); writeFileSync(join(root2, 'CLAUDE.md'), 'mío');
  assert.equal(writeAgentsMd(root2, 'x').written, false);
  assert.ok(!existsSync(join(root2, 'AGENTS.md')));
});

test('init: instala los 5 agentes, es idempotente y no pisa archivos distintos', () => {
  const root = tmp();
  const a = installAgents(root);
  assert.deepEqual(a.installed.sort(), ['designer.md', 'executor.md', 'explore.md', 'planner.md', 'reviewer.md']);
  assert.equal(installAgents(root).unchanged.length, 5);
  writeFileSync(join(root, '.claude/agents/planner.md'), 'editado a mano');
  const b = installAgents(root);
  assert.deepEqual(b.skipped, ['planner.md']);
  assert.equal(readFileSync(join(root, '.claude/agents/planner.md'), 'utf8'), 'editado a mano');
  assert.deepEqual(installAgents(root, { force: true }).installed, ['planner.md']);
});

test('init: recomienda solo skills existentes y MCPs con su razón; no instala nada', () => {
  const root = nextProject(); const home = tmp();
  mkdirSync(join(home, '.claude/skills/nextjs'), { recursive: true });
  mkdirSync(join(home, '.claude/skills/commit-work'), { recursive: true });
  const r = recommend(root, detect(root), home);
  assert.deepEqual(r.skills.core, ['commit-work']);
  assert.deepEqual(r.skills.project, ['nextjs']); // shadcn-ui no existe en este home: no se propone
  assert.ok(r.mcps.some((m) => m.mcp === 'Supabase MCP' && m.because.includes('supabase')));
  assert.equal(r.mcps.filter((m) => m.mcp.startsWith('Context7')).length, 1);
});

import { detectLegacy, planSdd, buildImport, sdd as sddCopy, headings } from '../src/migrate.mjs';

function legacyProject() {
  const root = tmp();
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }));
  writeFileSync(join(root, 'CLAUDE.md'), '# Proj\n\n## Rules\n- a\n\n## Stack\n- b\n\n### deep\n\n## Harness — flujo anterior\n- z\n');
  writeFileSync(join(root, 'skills-lock.json'), JSON.stringify({ version: 1, skills: { accessibility: { source: 'a/b', sourceType: 'github', computedHash: 'h1' } } }));
  mkdirSync(join(root, 'Docs/specs'), { recursive: true }); writeFileSync(join(root, 'Docs/specs/01-x.md'), 'x');
  writeFileSync(join(root, 'DECISIONS.md'), 'd'); writeFileSync(join(root, 'AI_USAGE.md'), 'a');
  mkdirSync(join(root, 'openspec')); mkdirSync(join(root, '.atl'));
  mkdirSync(join(root, '.claude/agents'), { recursive: true });
  writeFileSync(join(root, '.claude/agents/planner.md'), 'mío'); writeFileSync(join(root, '.claude/agents/otro.md'), 'o');
  return root;
}

const dump = () => ({
  version: '0.1.0', exported_at: 'x',
  sessions: [{ id: 's1', project: 'demo', directory: '/d', started_at: 't' }, { id: 's2', project: 'other', directory: '/o', started_at: 't' }],
  observations: [
    { id: 1, sync_id: 'o1', session_id: 's1', project: 'demo', topic_key: 'sdd/feat-a/spec', title: 'spec A', content: 'C1', type: 'architecture', scope: 'project', created_at: 'c1' },
    { id: 2, sync_id: 'o2', session_id: 's1', project: 'demo', topic_key: 'sdd/feat-a/archive-report', title: 'arch A', content: 'C2', type: 'architecture', scope: 'project', created_at: 'c2' },
    { id: 3, sync_id: 'o3', session_id: 's1', project: 'demo', topic_key: 'sdd/feat-b/spec', title: 'spec B', content: 'C3', type: 'architecture', scope: 'project', created_at: 'c3' },
    { id: 4, sync_id: 'o4', session_id: 's2', project: 'other', topic_key: 'sdd/x/spec', title: 'ajeno', content: 'C4', type: 'architecture', scope: 'project', created_at: 'c4' },
    { id: 5, sync_id: 'o5', session_id: 's1', project: 'demo', topic_key: 'decision/otra', title: 'no sdd', content: 'C5', type: 'decision', scope: 'project', created_at: 'c5' },
  ],
  prompts: [],
});

test('migración: detecta rastros previos con su acción y marca los conflictos de agentes', () => {
  const l = detectLegacy(legacyProject());
  const by = (k) => l.items.filter((i) => i.kind === k);
  assert.equal(by('guide')[0].action, 'adapt');
  assert.deepEqual(by('guide')[0].headings.map((h) => h.title), ['Proj', 'Rules', 'Stack', 'Harness — flujo anterior']); // sin ### y con su línea
  assert.deepEqual(by('guide')[0].headings.filter((h) => h.flow).map((h) => h.line), [11]); // el flujo viejo se marca
  assert.equal(by('skills-lock')[0].locked[0].hash, 'h1');
  assert.deepEqual(l.conventions, { specs: 'Docs/specs', decisions: 'DECISIONS.md', aiUsage: 'AI_USAGE.md', openspec: 'openspec' });
  assert.equal(by('atl')[0].action, 'leave');
  assert.deepEqual(by('agent').map((a) => [a.path, a.action]).sort(), [['.claude/agents/otro.md', 'keep'], ['.claude/agents/planner.md', 'conflict']]);
});

test('migración: AGENTS.md adaptado conserva las reglas como punteros y sigue en ≤ 80 líneas', () => {
  const root = legacyProject();
  const md = buildAgentsMd('demo', proposeProfile(root).profile, detectLegacy(root));
  assert.match(md, /`CLAUDE.md` §Rules \(line 3\)/);
  assert.match(md, /Harness — flujo anterior \(line 11\) ⚠ previous workflow/);
  assert.match(md, /specs: `Docs\/specs`/);
  assert.ok(md.split('\n').length <= 80);
});

test('migración SDD: copia por clave con enlace al original, sin tocar lo ajeno ni lo no-sdd', () => {
  const plan = planSdd('demo', dump());
  assert.deepEqual([plan.found, plan.cambios, plan.archived, plan.toCopy], [3, 2, 1, 3]);
  const imp = buildImport(plan, dump());
  assert.deepEqual(imp.observations.map((o) => o.topic_key), ['harness/feat-a/spec', 'harness/feat-a/archive-report', 'harness/feat-b/spec']);
  assert.ok(imp.observations.every((o) => !('id' in o) && o.sync_id.startsWith('obs-harness-mig-')));
  assert.match(imp.observations[0].content, /^C1\n\n_migrated-from: sdd\/feat-a\/spec · obs #1 · status: archived/);
  assert.match(imp.observations[2].content, /status: open/);
  assert.equal(imp.observations[0].created_at, 'c1'); // conserva la fecha original
  assert.deepEqual(imp.sessions.map((s) => s.id), ['s1']); // solo la sesión referenciada
  assert.equal(planSdd('demo', dump(), { scope: 'open' }).toCopy, 1); // solo feat-b sigue abierto
});

test('migración SDD: es idempotente (engram import no lo es) y no escribe en dry-run', () => {
  const calls = []; let current = dump();
  const fake = (args) => {
    calls.push(args[0]);
    if (args[0] === 'export') writeFileSync(args[1], JSON.stringify(current));
    if (args[0] === 'import') {
      const imp = JSON.parse(readFileSync(args[1], 'utf8'));
      current = { ...current, observations: [...current.observations, ...imp.observations.map((o, i) => ({ ...o, id: 100 + i }))] };
    }
    return '';
  };
  assert.equal(sddCopy('demo', { dry: true, engram: fake }).copied, 0);
  assert.ok(!calls.includes('import'));
  assert.equal(sddCopy('demo', { dry: false, engram: fake }).copied, 3);
  const again = sddCopy('demo', { dry: false, engram: fake });
  assert.equal(again.copied, 0);
  assert.equal(again.already, 3);
  assert.equal(calls.filter((c) => c === 'import').length, 1); // la segunda corrida no importó nada
  assert.equal(current.observations.filter((o) => o.project === 'demo' && o.topic_key.startsWith('sdd/')).length, 3); // originales intactos
  assert.equal(current.observations.filter((o) => o.project === 'other').length, 1); // lo ajeno no se tocó
  assert.equal(sddCopy('demo', { scope: 'none', engram: fake }).skipped, true);
});

test('migración: headings devuelve punteros con línea', () => {
  const root = legacyProject();
  assert.deepEqual(headings(join(root, 'CLAUDE.md')).map((h) => h.line), [1, 3, 6, 11]);
});

import { assignSkills, projectBlock, recommendationsMd } from '../src/init.mjs';

const prof = () => ({
  stack: { languages: ['javascript/typescript'], frameworks: ['next', 'prisma'] },
  gate: { cmd: 'npm test' }, git: { integration: 'develop', deploy: 'main' },
  tiers: { t2: ['prisma/**'], ui: ['src/components/**'] }, conventions: { specs: 'Docs/specs' },
  rules: [{ file: 'CLAUDE.md', title: 'Reglas', line: 3 }, { file: 'CLAUDE.md', title: 'Harness viejo', line: 9, flow: true }],
  skills: { core: ['commit-work', 'release-pr'], project: ['next-best-practices', 'prisma-client-api', 'zod', 'frontend-design', 'accessibility', 'shadcn-ui', 'manual-video'] },
});

test('skills por agente: el executor recibe el stack, el designer solo el diseño y solo con UI; lo dudoso queda sin asignar', () => {
  const p = prof();
  const a = assignSkills(p.skills, { ui: true });
  assert.deepEqual(a.assigned.executor.sort(), ['commit-work', 'next-best-practices', 'prisma-client-api', 'shadcn-ui', 'zod']); // la librería de componentes también la usa el executor
  assert.deepEqual(a.assigned.designer.sort(), ['accessibility', 'frontend-design', 'shadcn-ui']);
  assert.deepEqual(a.assigned.reviewer.sort(), ['accessibility', 'next-best-practices']);
  assert.ok(a.assigned.planner.includes('release-pr'));
  assert.deepEqual(a.assigned.explore, []);
  assert.deepEqual(a.unassigned, ['manual-video']);
  assert.deepEqual(assignSkills(p.skills, { ui: false }).assigned.designer, []);
});

test('bloque de proyecto: contenido por rol y corto', () => {
  const p = prof(); p.agents = Object.fromEntries(Object.entries(assignSkills(p.skills, { ui: true }).assigned).map(([r, skills]) => [r, { skills }]));
  const ex = projectBlock('executor', 'demo', p);
  assert.match(ex, /Gate: `npm test`/);
  assert.match(ex, /T2 paths.*`prisma\/\*\*`/);
  assert.match(ex, /Skills you may use \(only these\): .*`zod`/);
  assert.match(ex, /Harness viejo.*⚠ previous workflow/);
  assert.ok(ex.split('\n').length <= 12);
  assert.doesNotMatch(projectBlock('explore', 'demo', p), /Gate:|T2 paths/);
  assert.match(projectBlock('explore', 'demo', p), /do not invoke skills/);
  assert.match(projectBlock('designer', 'demo', p), /UI paths/);
});

test('agentes: plantilla pura se renderiza, el bloque se refresca y lo editado a mano no se pisa', () => {
  const root = tmp(); const p = prof(); p.agents = Object.fromEntries(Object.entries(assignSkills(p.skills, { ui: true }).assigned).map(([r, skills]) => [r, { skills }]));
  installAgents(root); // copia pura, como la v0.1 (lo que ya quedó instalado en proyectos)
  const r1 = installAgents(root, { profile: p, name: 'demo' });
  assert.equal(r1.refreshed.length, 5);
  assert.match(readFileSync(join(root, '.claude/agents/executor.md'), 'utf8'), /## Project: demo/);
  assert.equal(installAgents(root, { profile: p, name: 'demo' }).unchanged.length, 5); // idempotente

  const f = join(root, '.claude/agents/executor.md');
  writeFileSync(f, `LÍNEA MÍA\n${readFileSync(f, 'utf8')}`);
  p.agents.executor.skills = ['zod'];
  const r2 = installAgents(root, { profile: p, name: 'demo' });
  assert.deepEqual(r2.refreshed, ['executor.md']);
  const after = readFileSync(f, 'utf8');
  assert.ok(after.startsWith('LÍNEA MÍA')); // lo de fuera del bloque se conserva
  assert.match(after, /only these\): `zod`\n/); // el bloque se actualizó

  writeFileSync(join(root, '.claude/agents/reviewer.md'), 'reescrito entero');
  assert.deepEqual(installAgents(root, { profile: p, name: 'demo' }).skipped, ['reviewer.md']);
  assert.equal(readFileSync(join(root, '.claude/agents/reviewer.md'), 'utf8'), 'reescrito entero');
});

test('recomendaciones: informe legible con skills por agente y MCPs con alternativa', () => {
  const root = nextProject(); const p = prof();
  p.agents = Object.fromEntries(Object.entries(assignSkills(p.skills, { ui: true }).assigned).map(([r, skills]) => [r, { skills }]));
  p.skillsUnassigned = ['manual-video'];
  const md = recommendationsMd('demo', p, recommend(root, detect(root), tmp()), detect(root));
  assert.match(md, /\| executor \| .*`zod`/);
  assert.match(md, /manual-video/);
  assert.match(md, /Supabase MCP/);
  assert.match(md, /not verified/);
});

test('bloque de proyecto: los títulos largos de las reglas se acortan', () => {
  const p = prof(); p.agents = { executor: { skills: [] } };
  p.rules = [{ file: 'CLAUDE.md', title: 'X'.repeat(200), line: 1 }];
  const b = projectBlock('executor', 'demo', p);
  assert.ok(!b.includes('X'.repeat(70)));
  assert.match(b, /X{50,}…/);
});

import { checkScope, snapshotDirty } from '../src/gate.mjs';

test('scope: lo que ya estaba sucio al aprobar no cuenta; si cambia después, sí', () => {
  const root = tmp(); const g = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf8' });
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  mkdirSync(join(root, 'src')); writeFileSync(join(root, 'Dockerfile'), 'a'); writeFileSync(join(root, 'src/a.ts'), 'a');
  g('add', '-A'); g('commit', '-qm', 'init');
  writeFileSync(join(root, 'Dockerfile'), 'sucio de antes'); mkdirSync(join(root, '.claude/agents'), { recursive: true }); writeFileSync(join(root, '.claude/agents/x.md'), 'x');
  const baseline = snapshotDirty(root, 'main');
  assert.deepEqual(Object.keys(baseline).sort(), ['.claude/agents/x.md', 'Dockerfile']);
  const task = { paths: ['src/**'], base: 'main', baseline };
  assert.deepEqual(checkScope(root, task).violations, []); // nada de la tarea todavía
  writeFileSync(join(root, 'src/a.ts'), 'cambio de la tarea');
  assert.deepEqual(checkScope(root, task).violations, []); // en scope
  writeFileSync(join(root, 'src/otro.ts'), 'nuevo en scope');
  assert.equal(checkScope(root, task).ignored, 2);
  writeFileSync(join(root, 'Dockerfile'), 'la tarea lo tocó');
  assert.deepEqual(checkScope(root, task).violations, ['Dockerfile']); // fuera de scope y cambiado desde la línea base
  assert.equal(checkScope(root, { ...task, baseline: {} }).violations.length, 2); // sin línea base, Dockerfile y el agente serían ruido
});

import { checkLocalDb, runGate } from '../src/gate.mjs';

test('T2: no corre contra una base remota, y suma los pasos extra del gate', () => {
  const root = tmp();
  const pr = { ...P, gate: { cmd: 'true', t2Cmd: 'test -f extra.ok' } };
  writeFileSync(join(root, '.env'), 'DATABASE_URL="postgresql://u:secreto@db.prod.example.com:5432/x"\n');
  const r = checkLocalDb(root, pr);
  assert.deepEqual([r.ok, r.host], [false, 'db.prod.example.com']);
  const t2 = { tier: 'T2', paths: [], base: 'main' };
  const g = runGate(root, pr, t2);
  assert.equal(g.reason, 'db no local');
  assert.ok(!JSON.stringify(g).includes('secreto')); // no se filtran credenciales
  assert.equal(runGate(root, pr, { ...t2, tier: 'T1' }).pass, true); // T1 no revisa la base
  writeFileSync(join(root, '.env'), 'DATABASE_URL=postgresql://u:p@localhost:5434/x\n');
  assert.equal(runGate(root, pr, t2).pass, false); // falta el paso extra de T2
  writeFileSync(join(root, 'extra.ok'), '');
  assert.equal(runGate(root, pr, t2).pass, true);
  assert.equal(checkLocalDb(tmp(), pr).checked, false); // sin .env no hay nada que validar
});

import { codexArgs, codexSandbox } from '../src/herdr.mjs';

test('codex: el sandbox y la aprobación se pueden fijar por tier', () => {
  const r = { model: 'gpt-6.1-sol', effort: 'high' };
  assert.deepEqual(codexArgs(P, r, 'T1').slice(0, 4), ['-s', 'workspace-write', '-a', 'never']); // por defecto
  const open = { ...P, codex: { sandbox: 'danger-full-access', approval: 'never', byTier: {} } };
  assert.equal(codexSandbox(open, 'T0').sandbox, 'danger-full-access');
  const t2only = { ...P, codex: { ...P.codex, byTier: { T2: { sandbox: 'danger-full-access' } } } };
  assert.equal(codexSandbox(t2only, 'T2').sandbox, 'danger-full-access');
  assert.equal(codexSandbox(t2only, 'T1').sandbox, 'workspace-write');
  assert.equal(codexSandbox(t2only, 'T2').approval, 'never'); // lo no fijado cae al valor global
  assert.ok(codexArgs(open, r, 'T1').includes('model_reasoning_effort="high"'));
});

test('bloque de proyecto: el planner y el reviewer ven el paso extra del gate T2', () => {
  const p = prof(); p.gate.t2Cmd = 'pnpm test:int'; p.agents = {};
  assert.match(projectBlock('planner', 'demo', p), /T2 gate also runs: `pnpm test:int`/);
  assert.match(projectBlock('reviewer', 'demo', p), /T2 gate also runs/);
  assert.doesNotMatch(projectBlock('executor', 'demo', p), /T2 gate also runs/);
});

import { installRoleSkills, roleSkill } from '../src/init.mjs';

test('comandos /rol: por defecto solo /planner, apunta al agente y no pisa una skill del usuario', () => {
  const root = tmp();
  const r1 = installRoleSkills(root, {});
  assert.deepEqual(r1.installed, ['/planner']);
  const f = join(root, '.claude/skills/planner/SKILL.md');
  const md = readFileSync(f, 'utf8');
  assert.match(md, /^---\nname: planner\n/);
  assert.match(md, /\.claude\/agents\/planner\.md/);
  assert.match(md, /\$ARGUMENTS/);
  assert.match(md, /disable-model-invocation: true/);
  assert.ok(!existsSync(join(root, '.claude/skills/executor'))); // el resto de roles no se instala solo
  assert.deepEqual(installRoleSkills(root, {}).unchanged, ['/planner']); // idempotente
  const multi = installRoleSkills(root, { slashRoles: ['planner', 'designer'] });
  assert.deepEqual(multi.installed, ['/designer']);
  writeFileSync(f, '---\nname: planner\n---\nmía');
  assert.deepEqual(installRoleSkills(root, {}).skipped, ['/planner']); // sin marca: es del usuario
  assert.equal(readFileSync(f, 'utf8'), '---\nname: planner\n---\nmía');
  assert.equal(roleSkill('planner').includes('<!-- harness:generated -->'), true);
});

import http from 'node:http';
import { backlogInfo, bridgePidFile, bridgeRunning, clearBridgePid, ensureBridge, diff as pxDiff, liveServers, post as pxPost, sessionId as pxSid, tick as pxTick } from '../src/pixel.mjs';

const ag = (status, o = {}) => ({ agent: 'codex', agent_status: status, cwd: '/p/gym-app', pane_id: 'w1:p9', terminal_title_stripped: 'exec-feat', agent_session: { value: 'sess-codex-1' }, ...o });
const names = (r) => r.events.map((e) => e.hook_event_name);

test('puente Pixel: un Codex nuevo, sus transiciones y su salida se traducen a eventos de hooks', () => {
  let r = pxDiff(new Map(), [ag('working')]);
  assert.deepEqual(names(r), ['SessionStart', 'PreToolUse']);
  assert.equal(r.events[0].transcript_path, undefined); // sin transcript: Pixel Agents crea un personaje "hooks-only"
  assert.equal(r.events[0].cwd, '/p/gym-app');
  assert.equal(r.events[1].tool_input.command, 'codex · gym-app');
  r = pxDiff(r.next, [ag('working')]);
  assert.deepEqual(r.events, []); // sin cambios no se emite nada
  r = pxDiff(r.next, [ag('blocked')]);
  assert.deepEqual(names(r), ['PermissionRequest']);
  r = pxDiff(r.next, [ag('working')]);
  assert.deepEqual(names(r), ['PreToolUse']);
  r = pxDiff(r.next, [ag('done')]);
  assert.deepEqual(names(r), ['PostToolUse', 'Stop']);
  r = pxDiff(r.next, [ag('unknown')]); // unknown no prueba nada
  assert.deepEqual(r.events, []);
  assert.equal(r.next.get('herdr-w1:p9').status, 'done');
  r = pxDiff(r.next, []);
  assert.deepEqual(r.events.map((e) => [e.hook_event_name, e.reason]), [['SessionEnd', 'exit']]);
  assert.deepEqual(names(pxDiff(new Map(), [ag('idle')])), ['SessionStart', 'Stop']); // el Stop confirma el personaje
});

test('puente Pixel: ignora a Claude y respeta el prefijo de cwd; sin id de sesión usa el pane', () => {
  assert.deepEqual(pxDiff(new Map(), [ag('working', { agent: 'claude' })]).events, []);
  assert.deepEqual(pxDiff(new Map(), [ag('working', { cwd: '/otro/proyecto' })], { cwdPrefix: '/p/gym-app' }).events, []);
  assert.equal(pxDiff(new Map(), [ag('working')], { cwdPrefix: '/p/gym-app' }).events.length, 2);
  assert.equal(pxSid(ag('idle')), 'herdr-w1:p9'); // estable aunque Codex reciba su uuid después
  assert.equal(pxSid(ag('idle', { agent_session: undefined })), 'herdr-w1:p9');
  const tracked = pxDiff(new Map(), [ag('working')], { trackedDir: '/home/u/.claude/projects/-p-gym-app' });
  assert.equal(tracked.events[0].cwd, '/home/u/.claude/projects/-p-gym-app'); // la carpeta que Pixel Agents vigila, no el repo
});

test('puente Pixel: publica con token a /api/hooks/claude y reanuncia si el servidor se reinicia', async () => {
  const got = [];
  const srv = http.createServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { got.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(b) }); res.end('ok'); }); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    assert.equal(await pxPost({ port, token: 'T0K' }, { session_id: 's', hook_event_name: 'Stop' }), 200);
    assert.deepEqual([got[0].url, got[0].auth], ['/api/hooks/claude', 'Bearer T0K']);
    let servers = [{ port, token: 'T0K', pid: 1 }];
    const opts = { agents: () => [ag('working')], servers: () => servers };
    let st = await pxTick({ prev: new Map(), sig: '' }, opts);
    assert.equal(st.sent, 2);
    st = await pxTick(st, opts);
    assert.equal(st.sent, 0); // mismo servidor, mismo estado
    servers = [{ port, token: 'NUEVO', pid: 2 }]; // el servidor se reinició: no conoce a nadie
    st = await pxTick(st, opts);
    assert.equal(st.sent, 2);
    assert.equal(got.at(-1).auth, 'Bearer NUEVO');
    st = await pxTick({ prev: new Map(), sig: 'x' }, { agents: () => [ag('working')], servers: () => [] }); // sin servidor: no manda ni pierde el estado
    assert.equal(st.servers, 0);
  } finally { srv.close(); }
  assert.deepEqual(liveServers('/ruta/que/no/existe'), []);
});

test('puente Pixel: etiqueta sin spinner y arranque automático solo si hay servidor', () => {
  const ev = pxDiff(new Map(), [ag('working', { terminal_title_stripped: '⠇ | toy', cwd: '/p/gym-app/' })]).events[1];
  assert.equal(ev.tool_input.command, 'codex · gym-app'); // el nombre de la carpeta, no el título de la terminal
  const root = tmp();
  assert.equal(bridgeRunning(root), false);
  assert.equal(ensureBridge(root, '/no/importa.mjs', { servers: () => [] }), 'no-server'); // sin Pixel Agents no se lanza nada
  assert.equal(existsSync(bridgePidFile(root)), false);
  mkdirSync(join(root, '.harness'));
  writeFileSync(bridgePidFile(root), String(process.pid)); // un pid vivo cuenta como puente corriendo
  assert.equal(bridgeRunning(root), true);
  assert.equal(ensureBridge(root, '/no/importa.mjs', { servers: () => [{}] }), 'already-running');
  clearBridgePid(root);
  assert.equal(bridgeRunning(root), false);
  writeFileSync(bridgePidFile(root), '2147483646'); // pid muerto
  assert.equal(bridgeRunning(root), false);
});

test('puente Pixel: nombra al agente con el rol y la tarea del harness (agent_type, session_name y etiqueta)', () => {
  const root = tmp();
  assert.equal(backlogInfo(root), null); // sin backlog
  mkdirSync(join(root, '.harness'));
  writeFileSync(join(root, '.harness/backlog.json'), JSON.stringify({ tasks: { a1: { id: 'a1', tier: 'T2', status: 'executing' }, b2: { id: 'b2', tier: 'T0', status: 'done' }, c3: { id: 'c3', tier: 'T1', status: 'executing' } } }));
  const info = backlogInfo(root);
  assert.deepEqual(info, { role: 'executor', tasks: 'a1 (T2), c3 (T1)' }); // solo las que están ejecutándose
  const evs = pxDiff(new Map(), [ag('working')], { info }).events;
  assert.ok(evs.every((e) => e.agent_type === 'executor' && e.session_name === 'a1 (T2), c3 (T1)')); // todos los eventos nombran al agente
  assert.equal(evs[1].tool_input.command, 'codex · executor · a1 (T2), c3 (T1)');
  const free = pxDiff(new Map(), [ag('working')], { info: null }).events;
  assert.ok(free.every((e) => e.agent_type === 'codex' && e.session_name === undefined)); // sin tarea del harness: "codex"
  assert.equal(free[1].tool_input.command, 'codex · gym-app');
});

import { waitCodexReady } from '../src/herdr.mjs';

test('exec_failed: un executor que termina sin dejar nada cuenta como intento fallido y no avanza al gate', () => {
  const root = tmp();
  addTask(root, P, { id: 'f1', title: 'x', category: 'feature', paths: ['src/**'] });
  const st = () => loadBacklog(root).tasks.f1;
  applyEvent(root, P, 'f1', 'approve');
  applyEvent(root, P, 'f1', 'exec_started', { provider: 'codex' });
  applyEvent(root, P, 'f1', 'exec_failed');
  assert.equal(st().status, 'executing'); // no pasó a gating
  assert.equal(st().attempts, 1);
  assert.equal(nextStep(P, st()).role, 'executor'); // se puede volver a lanzar
  assert.equal(nextStep(P, st()).route.effort, 'xhigh'); // y con un nivel más de esfuerzo
  applyEvent(root, P, 'f1', 'exec_started', { provider: 'codex' });
  applyEvent(root, P, 'f1', 'exec_failed');
  assert.equal(st().status, 'blocked'); // agotado: lo decide el humano
  assert.equal(nextStep(P, st()).action, 'human');
});

test('Codex listo: solo se escribe la tarea en la pantalla de entrada; un diálogo desconocido detiene todo', () => {
  const READY = '>_ OpenAI Codex\n› Ask Codex to do anything\n  GPT-6.1-Sol high';
  const TRUST = 'Do you trust the contents of this directory?\n› 1. Yes, continue\n  2. No, quit';
  const HOOKS = 'Hooks need review\n› 1. Review hooks\n  2. Trust all and continue\n  3. Continue without trusting';
  const mk = (screens) => { const sent = []; let i = 0; return { sent, io: { read: () => screens[Math.min(i++, screens.length - 1)], send: (...a) => sent.push(a), pause: () => {} } }; };

  let t = mk([READY]);
  assert.deepEqual(waitCodexReady('x', t.io), { ready: true, hooksDismissed: false });
  assert.deepEqual(t.sent, []); // no tocó nada

  t = mk([HOOKS, READY]);
  assert.deepEqual(waitCodexReady('x', t.io), { ready: true, hooksDismissed: true });
  assert.deepEqual(t.sent, [['x', 'down', 'down', 'enter']]); // "continuar sin confiar"

  t = mk([TRUST]); // el menú del diálogo tiene "›": antes se confundía con la pantalla lista
  assert.throws(() => waitCodexReady('x', t.io), /diálogo de arranque.*no escribí la tarea[\s\S]*Do you trust/);
  assert.deepEqual(t.sent, []); // ni siquiera contesta

  t = mk(['cargando...']);
  assert.throws(() => waitCodexReady('x', { ...t.io, tries: 3 }), /no llegó a su prompt de entrada/);
});

test('plantillas de agentes: una mejora llega al cuerpo solo si nadie lo editó; el bloque siempre se refresca', () => {
  const root = tmp(); const src = tmp();
  const p = prof(); p.agents = { planner: { skills: ['zod'] }, executor: { skills: [] }, reviewer: { skills: [] }, explore: { skills: [] }, designer: { skills: [] } };
  for (const r of ['planner', 'executor', 'reviewer', 'explore', 'designer']) writeFileSync(join(src, `${r}.md`), `# ${r} v1\nregla vieja\n`);
  installAgents(root, { srcDir: src });                        // copia pura (como la v0.1)
  installAgents(root, { srcDir: src, profile: p, name: 'demo' }); // primera versión con huella
  const f = (r) => join(root, `.claude/agents/${r}.md`);
  assert.match(readFileSync(f('planner'), 'utf8'), /harness:project:start body=[0-9a-f]{8} -->/);

  for (const r of ['planner', 'executor', 'reviewer', 'explore', 'designer']) writeFileSync(join(src, `${r}.md`), `# ${r} v2\nregla NUEVA\n`);
  writeFileSync(f('executor'), `# executor mío\n${readFileSync(f('executor'), 'utf8').slice(readFileSync(f('executor'), 'utf8').indexOf('<!-- harness'))}`.replace('# executor mío\n', '# executor mío\nregla propia\n\n'));
  const r2 = installAgents(root, { srcDir: src, profile: p, name: 'demo' });
  assert.match(readFileSync(f('planner'), 'utf8'), /regla NUEVA/);   // intacto: recibe la plantilla nueva
  assert.doesNotMatch(readFileSync(f('planner'), 'utf8'), /regla vieja/);
  assert.match(readFileSync(f('executor'), 'utf8'), /regla propia/); // editado: se respeta
  assert.doesNotMatch(readFileSync(f('executor'), 'utf8'), /regla NUEVA/);
  assert.deepEqual(r2.bodyEdited, ['executor.md']); // el cuerpo editado se detecta y se avisa en la misma pasada
  const r3 = installAgents(root, { srcDir: src, profile: p, name: 'demo' });
  assert.deepEqual(r3.bodyEdited, ['executor.md']);
  assert.equal(r3.unchanged.length, 5); // nada cambia en una segunda pasada

  // archivo de una versión sin huella: solo el bloque; se avisa y --force lo reemplaza
  const old = readFileSync(f('reviewer'), 'utf8').replace(/ body=[0-9a-f]{8}/, '');
  writeFileSync(f('reviewer'), old.replace('regla NUEVA', 'regla de una versión anterior'));
  const r4 = installAgents(root, { srcDir: src, profile: p, name: 'demo' });
  assert.deepEqual(r4.legacy, ['reviewer.md']);
  assert.match(readFileSync(f('reviewer'), 'utf8'), /versión anterior/);
  installAgents(root, { srcDir: src, profile: p, name: 'demo', force: true });
  assert.match(readFileSync(f('reviewer'), 'utf8'), /regla NUEVA/);
});

test('fallback: queda registrado quién ejecutó y el reviewer pasa a la otra familia', () => {
  const root = tmp();
  addTask(root, P, { id: 'k1', title: 'x', category: 'feature', paths: ['src/**'] });
  applyEvent(root, P, 'k1', 'approve');
  applyEvent(root, P, 'k1', 'exec_started', { provider: 'codex' });
  applyEvent(root, P, 'k1', 'exec_done');                       // estado erróneo: gating
  const t = applyEvent(root, P, 'k1', 'fallback', { provider: 'claude' });
  assert.deepEqual([t.status, t.executor], ['executing', 'claude']);
  applyEvent(root, P, 'k1', 'exec_done');
  applyEvent(root, P, 'k1', 'gate_pass');
  const n = nextStep(P, loadBacklog(root).tasks.k1);
  assert.equal(n.role, 'reviewer');
  assert.equal(n.route.provider, 'codex');                       // el executor real fue Claude
});

import { codexCost, findRollouts, parseRollout } from '../src/codex.mjs';
import { taskAt, taskWindows } from '../src/attribution.mjs';
import { buildEvents, buildPhases, buildTaskRoles, buildTasks } from '../src/rollup.mjs';
import { report } from '../src/report.mjs';
import { collectCodex, collectRollup, ensureSchema } from '../src/metrics.mjs';
import { upsertRows } from '../src/toonfile.mjs';
import { gitStats } from '../src/gitstats.mjs';

const j = (o) => JSON.stringify(o);
function fakeRollout(dir, { id, cwd, ts, parent = null, model = 'gpt-6.1-sol', effort = 'high', tokens, q }) {
  const day = join(dir, '2026', '10', '02'); mkdirSync(day, { recursive: true });
  const f = join(day, `rollout-2026-10-02T00-00-00-${id}.jsonl`);
  const t0 = Date.parse(ts);
  const lines = [
    { timestamp: ts, type: 'session_meta', payload: { id, timestamp: ts, cwd, cli_version: '0.160.0', ...(parent ? { source: { subagent: { thread_spawn: { parent_thread_id: parent, depth: 1, agent_path: '/root/audit' } } }, agent_nickname: 'Mencius' } : {}) } },
    { timestamp: new Date(t0 + 1000).toISOString(), type: 'turn_context', payload: { model, effort, approval_policy: 'never', sandbox_policy: { type: 'danger-full-access' } } },
    { timestamp: new Date(t0 + 2000).toISOString(), type: 'event_msg', payload: { type: 'task_started' } },
    { timestamp: new Date(t0 + 3000).toISOString(), type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec' } },
    { timestamp: new Date(t0 + 4000).toISOString(), type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec' } },
    { timestamp: new Date(t0 + 5000).toISOString(), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 10, output_tokens: 5, reasoning_output_tokens: 2, total_tokens: 105 }, model_context_window: 258400 }, rate_limits: { plan_type: 'plus', primary: { used_percent: q[0] }, secondary: { used_percent: 7 } } } },
    { timestamp: new Date(t0 + 60000).toISOString(), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: tokens, model_context_window: 258400 }, rate_limits: { plan_type: 'plus', primary: { used_percent: q[1] }, secondary: { used_percent: 8 } } } },
  ];
  writeFileSync(f, lines.map(j).join('\n') + '\n');
  return f;
}

test('Codex: tokens, costo (entrada incluye caché), config real, herramientas, cuota y subagentes', () => {
  const dir = tmp(); const root = '/p/gym-app';
  const tok = { input_tokens: 1_000_000, cached_input_tokens: 900_000, output_tokens: 10_000, reasoning_output_tokens: 3000, total_tokens: 1_010_000 };
  const f = fakeRollout(dir, { id: 'root-1', cwd: root, ts: '2026-10-02T18:00:00.000Z', effort: 'xhigh', tokens: tok, q: [40, 43] });
  fakeRollout(dir, { id: 'child-1', cwd: root, ts: '2026-10-02T18:01:00.000Z', parent: 'root-1', tokens: tok, q: [43, 44] });
  fakeRollout(dir, { id: 'other', cwd: '/otro/proyecto', ts: '2026-10-02T18:00:00.000Z', tokens: tok, q: [1, 2] });
  assert.equal(findRollouts(root, { dir }).length, 2); // solo los de este proyecto
  const p = parseRollout(f);
  assert.deepEqual([p.session.model, p.session.effort, p.session.sandbox, p.session.approval], ['gpt-6.1-sol', 'xhigh', 'danger-full-access', 'never']);
  assert.deepEqual([p.session.in, p.session.cached, p.session.out, p.session.reasoning], [1_000_000, 900_000, 10_000, 3000]);
  assert.equal(p.session.wall_s, 60);
  assert.equal(p.session.tool_calls, 2);
  assert.deepEqual(p.tools, [{ session: 'root-1', tool: 'exec', calls: 2 }]);
  // (1.000.000 - 900.000) * $2 + 900.000 * $0,10 + 10.000 * $10, por millón
  assert.ok(Math.abs(codexCost(tok, 'gpt-6.1-sol') - (100_000 * 2 + 900_000 * 0.1 + 10_000 * 10) / 1e6) < 1e-9);
  assert.equal(p.session.cost_est, 0.39);
  assert.deepEqual([p.quota.p5h_start, p.quota.p5h_end, p.quota.week_end, p.quota.plan], [40, 43, 8, 'plus']);
  const child = parseRollout(join(dir, '2026/10/02/rollout-2026-10-02T00-00-00-child-1.jsonl')).session;
  assert.deepEqual([child.parent, child.depth, child.agent, child.nickname], ['root-1', 1, '/root/audit', 'Mencius']);
});

test('atribución: cada instante va a la tarea cuya ventana lo contiene, y gana la que empezó más tarde', () => {
  const bk = { tasks: {
    a: { id: 'a', status: 'done', history: [{ ts: '2026-10-02T10:00:00Z' }, { ts: '2026-10-02T12:00:00Z' }] },
    b: { id: 'b', status: 'done', history: [{ ts: '2026-10-02T11:00:00Z' }, { ts: '2026-10-02T13:00:00Z' }] },
  } };
  const w = taskWindows(bk);
  const at = (s) => taskAt(w, Date.parse(s));
  assert.equal(at('2026-10-02T09:59:00Z'), '');
  assert.equal(at('2026-10-02T10:30:00Z'), 'a');
  assert.equal(at('2026-10-02T11:30:00Z'), 'b'); // solapadas: la más reciente
  assert.equal(at('2026-10-02T12:01:00Z'), 'a' === 'a' ? 'b' : ''); // sigue en b
  assert.equal(at('2026-10-02T13:01:00Z'), 'b'); // dentro del margen de 2 min
  assert.equal(at('2026-10-02T13:10:00Z'), '');
});

const backlogFixture = () => ({ tasks: { t1: { id: 't1', category: 'feature', tier: 'T2', status: 'done', executor: 'codex', branch: 'feat/t1', base: 'main', history: [
  { ts: '2026-10-02T10:00:00Z', event: 'added' }, { ts: '2026-10-02T10:10:00Z', event: 'approve' }, { ts: '2026-10-02T10:12:00Z', event: 'design_done' },
  { ts: '2026-10-02T10:13:00Z', event: 'exec_started', provider: 'codex' }, { ts: '2026-10-02T10:20:00Z', event: 'exec_failed' },
  { ts: '2026-10-02T10:21:00Z', event: 'exec_started', provider: 'codex' }, { ts: '2026-10-02T10:51:00Z', event: 'exec_done' },
  { ts: '2026-10-02T10:52:00Z', event: 'gate_fail' }, { ts: '2026-10-02T11:00:00Z', event: 'exec_started', provider: 'codex' }, { ts: '2026-10-02T11:10:00Z', event: 'exec_done' },
  { ts: '2026-10-02T11:11:00Z', event: 'gate_pass' }, { ts: '2026-10-02T11:12:00Z', event: 'review_started' }, { ts: '2026-10-02T11:15:00Z', event: 'verdict_rejected' },
  { ts: '2026-10-02T11:16:00Z', event: 'human_retry' }, { ts: '2026-10-02T11:17:00Z', event: 'exec_started', provider: 'codex' }, { ts: '2026-10-02T11:30:00Z', event: 'exec_done' },
  { ts: '2026-10-02T11:31:00Z', event: 'gate_pass' }, { ts: '2026-10-02T11:32:00Z', event: 'review_started' }, { ts: '2026-10-02T12:00:00Z', event: 'verdict_approved' },
] } } });

test('eventos y fases: duración de cada fase y conteo de intentos, gates y rechazos', () => {
  const bk = backlogFixture();
  const ev = buildEvents(bk);
  assert.equal(ev.length, 19);
  assert.equal(ev.find((e) => e.event === 'approve').gap_s, 600);
  const ph = buildPhases(bk);
  const get = (n) => ph.find((p) => p.phase === n);
  assert.deepEqual([get('exec').n, get('exec').seconds], [4, 7 * 60 + 30 * 60 + 10 * 60 + 13 * 60]); // 4 ejecuciones
  assert.deepEqual([get('review').n, get('review').seconds], [2, 3 * 60 + 28 * 60]);
  assert.deepEqual([get('rework').n, get('rework').seconds], [1, 60]);
  assert.equal(get('plan').seconds, 600);
  assert.equal(get('design').seconds, 120);
});

test('resumen por tarea: gasto por rol (Claude + Codex), intentos, cuota y totales', () => {
  const bk = backlogFixture();
  const turns = [
    { task: 't1', role: 'main', model: 'claude-opus-5-5', in: 10, out: 100, cache_read: 1000, cache_write: 50, cost_est: 1.5 },
    { task: 't1', role: 'main', model: 'claude-opus-5-5', in: 10, out: 100, cache_read: 1000, cache_write: 50, cost_est: 1.5 },
    { task: 't1', role: 'reviewer', model: 'claude-opus-5-5', in: 5, out: 40, cache_read: 500, cache_write: 0, cost_est: 0.75 },
    { task: '', role: 'main', model: 'claude-opus-5-5', in: 1, out: 1, cache_read: 1, cache_write: 0, cost_est: 9 },
  ];
  const codex = [
    { task: 't1', depth: 0, model: 'gpt-6.1-sol', turns: 1, in: 1000, cached: 900, out: 50, cost_est: 0.3, wall_s: 600, q5h_start: 40, q5h_end: 43, qweek_start: 7, qweek_end: 8 },
    { task: 't1', depth: 1, model: 'gpt-6.1-sol', turns: 2, in: 400, cached: 300, out: 20, cost_est: 0.1, wall_s: 100, q5h_start: 43, q5h_end: 44, qweek_start: 8, qweek_end: 8 },
  ];
  const roles = buildTaskRoles({ turns, codex });
  const main = roles.find((r) => r.role === 'main');
  assert.deepEqual([main.turns, main.cost_est], [2, 3]);
  assert.ok(!roles.some((r) => r.cost_est === 9)); // lo que no es de una tarea no entra
  assert.equal(roles.find((r) => r.role === 'executor/sub').provider, 'codex');
  const events = buildEvents(bk); const phases = buildPhases(bk);
  const [t] = buildTasks({ backlog: bk, taskRoles: roles, phases, events, git: [{ task: 't1', commits: 7, files: 52, additions: 2700, deletions: 16 }], codex, gates: [{ task: 't1' }, { task: 't1' }, { task: 't1' }] });
  assert.deepEqual([t.exec_runs, t.exec_failed, t.gate_fail, t.rejections, t.human_retries, t.gate_runs], [4, 1, 1, 1, 1, 3]);
  assert.deepEqual([t.claude_cost, t.codex_cost, t.total_cost], [3.75, 0.4, 4.15]);
  assert.deepEqual([t.commits, t.files, t.additions], [7, 52, 2700]);
  assert.equal(t.quota_5h_pts, 3); // solo la sesión raíz: los subagentes no suman cuota aparte
  assert.equal(t.codex_sessions, 2);
});

test('informe: legible, con la config real de Codex, la cuota y el uso fuera de las tareas', () => {
  const bk = backlogFixture();
  const codex = [{ task: 't1', depth: 0, model: 'gpt-6.1-sol', effort: 'xhigh', sandbox: 'danger-full-access', turns: 1, in: 1_000_000, cached: 900_000, out: 10_000, cost_est: 0.39, wall_s: 600, q5h_start: 40, q5h_end: 43, qweek_start: 7, qweek_end: 8 }, { task: '', depth: 0, model: 'gpt-6.1-sol', cost_est: 0.2 }];
  const turns = [{ task: 't1', role: 'reviewer', model: 'claude-opus-5-5', in: 5, out: 4000, cache_read: 500_000, cache_write: 0, cost_est: 0.75 }, { task: '', role: 'main', model: 'claude-opus-5-5', in: 1, out: 1, cache_read: 1, cache_write: 0, cost_est: 9 }];
  const roles = buildTaskRoles({ turns, codex });
  const tasks = buildTasks({ backlog: bk, taskRoles: roles, phases: buildPhases(bk), events: buildEvents(bk), git: [], codex });
  const out = report({ tasks, task_roles: roles, turns, codex, quota: [{ plan: 'plus', end_ts: '2026-10-02T18:00:00Z', p5h_end: 43, week_end: 8 }] });
  assert.match(out, /## t1  \(feature T2, done\)/);
  assert.match(out, /4 ejecuciones de Codex \(1 sin resultado\)/);
  assert.match(out, /gpt-6\.1-sol xhigh \(danger-full-access\)/);
  assert.match(out, /ventana de 5 h 43% usada/);
  assert.match(out, /Claude fuera de las tareas del harness, en el mismo período: 1 turnos, \$9\.00/);
  assert.match(out, /estimados/);
  assert.match(report({ tasks, task_roles: roles, turns, codex, quota: [] }, { only: 't1' }), /## t1/);
  assert.doesNotMatch(report({ tasks, task_roles: roles, turns, codex, quota: [] }, { only: 't1' }), /## Resumen/);
});

test('recolección completa: rol de subagentes por .meta.json, tarea por ventana, esquema que se regenera, TOON de forma única', () => {
  const root = tmp(); const md = join(root, 'm'); const tdir = tmp();
  // sesión principal + un subagente con su meta
  const line = (id, ts, model = 'claude-opus-5-5') => j({ type: 'assistant', timestamp: ts, message: { id, model, usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 100 }, content: [] } });
  writeFileSync(join(tdir, 's1234567-aaaa.jsonl'), `${line('m1', '2026-10-02T10:30:00Z')}\n${line('m2', '2026-10-02T15:00:00Z')}\n`);
  mkdirSync(join(tdir, 's1234567-aaaa', 'subagents'), { recursive: true });
  writeFileSync(join(tdir, 's1234567-aaaa', 'subagents', 'agent-abc12345.jsonl'), `${line('r1', '2026-10-02T10:40:00Z')}\n`);
  writeFileSync(join(tdir, 's1234567-aaaa', 'subagents', 'agent-abc12345.meta.json'), j({ agentType: 'reviewer', description: 'Revisar el diff', model: 'opus' }));
  const windows = taskWindows(backlogFixture());
  const c = collect(root, md, { tdir, windows });
  assert.equal(c.files, 2);
  const turns = readRows(md, 'turns');
  assert.deepEqual(turns.map((x) => [x.role, x.task]).sort(), [['main', ''], ['main', 't1'], ['reviewer', 't1']]); // 15:00 queda fuera de la ventana
  const sess = readRows(md, 'sessions').find((s) => s.role === 'reviewer');
  assert.equal(sess.desc, 'Revisar el diff');
  assert.equal(sess.task, 't1');
  // Codex bajo la misma raíz
  const cdir = tmp();
  const tok = { input_tokens: 1000, cached_input_tokens: 900, output_tokens: 10, reasoning_output_tokens: 1, total_tokens: 1010 };
  fakeRollout(cdir, { id: 'rc1', cwd: root, ts: '2026-10-02T10:22:00.000Z', tokens: tok, q: [10, 12] });
  fakeRollout(cdir, { id: 'rc2', cwd: root, ts: '2026-10-02T10:30:00.000Z', parent: 'rc1', tokens: tok, q: [12, 12] });
  const cx = collectCodex(root, md, { dir: cdir, windows });
  assert.equal(cx.sessions.total, 2);
  const cs = readRows(md, 'codex_sessions');
  assert.deepEqual(cs.map((x) => x.task), ['t1', 't1']); // el subagente hereda la tarea de su raíz
  // idempotente
  assert.equal(collectCodex(root, md, { dir: cdir, windows }).sessions.added, 0);
  // esquema: cambiar la versión borra solo lo derivado; runs y gates sobreviven
  upsertRows(md, 'runs', [{ task: 'x', role: 'executor', ts: 'a' }], (r) => r.task);
  writeFileSync(join(md, 'SCHEMA'), '1\n');
  assert.equal(ensureSchema(md), true);
  assert.equal(readRows(md, 'turns').length, 0);
  assert.equal(readRows(md, 'runs').length, 1);
  assert.equal(ensureSchema(md), false);
  // filas de forma distinta: una sola cabecera tabular
  upsertRows(md, 'runs', [{ task: 'y', role: 'executor', ts: 'b', codex_session: 'zz' }], (r) => r.task);
  assert.match(readFileSync(join(md, 'runs.toon'), 'utf8'), /^rows\[2\]\{task,role,ts,codex_session\}:/);
});

test('git por tarea: commits, archivos y líneas de base..rama', () => {
  const root = tmp(); const g = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf8' });
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  writeFileSync(join(root, 'a.txt'), 'a\n'); g('add', '-A'); g('commit', '-qm', 'base');
  g('checkout', '-q', '-b', 'feat/t1');
  writeFileSync(join(root, 'b.txt'), '1\n2\n3\n'); g('add', '-A'); g('commit', '-qm', 'uno');
  writeFileSync(join(root, 'a.txt'), 'a\nmás\n'); g('add', '-A'); g('commit', '-qm', 'dos');
  const task = { id: 't1', branch: 'feat/t1', base: 'main', history: [{ ts: new Date(Date.now() - 3600_000).toISOString() }, { ts: new Date().toISOString() }] };
  const s = gitStats(root, task);
  assert.deepEqual([s.source, s.commits, s.files, s.additions, s.deletions], ['rama(desde inicio)', 2, 2, 4, 0]);
  assert.equal(gitStats(tmp(), task), null); // fuera de un repo
  const gone = gitStats(root, { ...task, branch: 'feat/borrada' });
  assert.equal(gone.source, 'tiempo'); // si la rama ya no existe, cae a la ventana de tiempo
});

test('git por tarea: con ramas apiladas no cuenta los commits de la tarea anterior', () => {
  const root = tmp(); const g = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf8' });
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  const commit = (file, msg, iso) => { writeFileSync(join(root, file), `${msg}\n`); g('add', '-A'); spawnSync('git', ['commit', '-qm', msg], { cwd: root, env: { ...process.env, GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso } }); };
  commit('base.txt', 'base', '2026-10-02T08:00:00Z');
  g('checkout', '-q', '-b', 'feat/uno'); commit('uno.txt', 'uno', '2026-10-02T10:00:00Z'); commit('uno2.txt', 'uno-dos', '2026-10-02T10:30:00Z');
  g('checkout', '-q', '-b', 'feat/dos'); commit('dos.txt', 'dos', '2026-10-02T13:00:00Z'); // parte de feat/uno
  const task2 = { id: 'dos', branch: 'feat/dos', base: 'main', history: [{ ts: '2026-10-02T12:00:00Z' }, { ts: '2026-10-02T14:00:00Z' }] };
  const s = gitStats(root, task2);
  assert.deepEqual([s.commits, s.files], [1, 1]); // solo "dos", no los dos commits de feat/uno
});

import { getProfileValue, setProfileValue } from '../src/store.mjs';
import { rolePromptText } from '../src/init.mjs';

test('config: cambiar una clave del perfil escribe solo esa clave y el router la usa', () => {
  const root = tmp();
  writeFileSync(join(root, 'package.json'), '{}');
  mkdirSync(join(root, '.harness'));
  writeFileSync(join(root, '.harness/profile.json'), JSON.stringify({ gate: { cmd: 'pnpm test' } }));
  assert.equal(getProfileValue(loadProfile(root), 'models.designer.use'), 'codex'); // valor por defecto
  setProfileValue(root, 'models.designer.use', 'claude');
  const raw = JSON.parse(readFileSync(join(root, '.harness/profile.json'), 'utf8'));
  assert.deepEqual(raw, { gate: { cmd: 'pnpm test' }, models: { designer: { use: 'claude' } } }); // no vuelca los valores por defecto
  const prof = loadProfile(root);
  assert.equal(route(prof, 'designer', { tier: 'T1' }).provider, 'claude');
  assert.equal(route(prof, 'executor', { tier: 'T1' }).provider, 'codex'); // lo demás sigue por defecto
  assert.equal(getProfileValue(prof, 'models.nada.x'), undefined);
});

test('prompt de rol para Codex: sin frontmatter de Claude Code, con Pencil y el bloque del proyecto', () => {
  const p = { stack: { languages: ['ts'], frameworks: ['next'] }, gate: { cmd: 'pnpm test' }, git: { integration: 'develop', deploy: 'main' }, tiers: { t2: [], ui: ['src/components/**'] }, agents: { designer: { skills: ['frontend-design'] }, executor: { skills: ['zod'] } } };
  const d = rolePromptText('designer', 'demo', p);
  assert.ok(!d.startsWith('---'));
  assert.doesNotMatch(d, /^model:/m);
  assert.match(d, /Pencil MCP/);
  assert.match(d, /Skills you may use \(only these\): `frontend-design`/);
  assert.match(rolePromptText('executor', 'demo', p), /`zod`/);
  assert.match(rolePromptText('reviewer', 'demo', p), /Visual check/);
});

test('Codex: explore va siempre de solo lectura aunque el proyecto tenga el sandbox quitado', () => {
  const open = { ...P, codex: { sandbox: 'danger-full-access', approval: 'never', byTier: {} } };
  const r = { model: 'gpt-6-luna', effort: 'low' };
  assert.deepEqual(codexArgs(open, r, 'T1').slice(0, 2), ['-s', 'danger-full-access']);
  assert.deepEqual(codexArgs(open, r, 'T1', { sandbox: 'read-only' }).slice(0, 4), ['-s', 'read-only', '-a', 'never']);
  assert.ok(codexArgs(open, r, 'T1', { sandbox: 'read-only' }).includes('gpt-6-luna'));
});

test('puente Pixel: el rol que se ve sigue el estado de la tarea (designer antes, executor después)', () => {
  const root = tmp(); mkdirSync(join(root, '.harness'));
  const bk = (tasks) => writeFileSync(join(root, '.harness/backlog.json'), JSON.stringify({ tasks }));
  bk({ a: { id: 'a', tier: 'T1', status: 'approved', ui: true, designed: false } });
  assert.deepEqual(backlogInfo(root), { role: 'designer', tasks: 'a (T1)' });
  bk({ a: { id: 'a', tier: 'T1', status: 'approved', ui: true, designed: true } });
  assert.equal(backlogInfo(root), null); // diseñada y todavía sin ejecutor lanzado
  bk({ a: { id: 'a', tier: 'T1', status: 'executing', ui: true, designed: true } });
  assert.equal(backlogInfo(root).role, 'executor');
  bk({ a: { id: 'a', tier: 'T1', status: 'approved', ui: false, designed: false } });
  assert.equal(backlogInfo(root), null); // sin UI no hay designer
});

test('los archivos de design/ no cuentan como fuera de scope', () => {
  const root = tmp(); const g = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf8' });
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  writeFileSync(join(root, 'a.txt'), 'a'); g('add', '-A'); g('commit', '-qm', 'base');
  mkdirSync(join(root, 'design')); writeFileSync(join(root, 'design/t1.pen'), 'x'); writeFileSync(join(root, 'otro.txt'), 'x');
  const sc = checkScope(root, { paths: ['src/**'], base: 'main' });
  assert.deepEqual(sc.violations, ['otro.txt']); // design/t1.pen no es violación
});

test('métricas de Codex: el rol de cada sesión sale de runs.toon y los subagentes lo heredan', () => {
  const root = tmp(); const md = join(root, 'm'); const cdir = tmp();
  const tok = { input_tokens: 1000, cached_input_tokens: 900, output_tokens: 10, reasoning_output_tokens: 1, total_tokens: 1010 };
  fakeRollout(cdir, { id: 'sd', cwd: root, ts: '2026-10-02T10:22:00.000Z', tokens: tok, q: [1, 2] });
  fakeRollout(cdir, { id: 'sd-child', cwd: root, ts: '2026-10-02T10:23:00.000Z', parent: 'sd', tokens: tok, q: [2, 2] });
  fakeRollout(cdir, { id: 'se', cwd: root, ts: '2026-10-02T10:40:00.000Z', tokens: tok, q: [2, 3] });
  upsertRows(md, 'runs', [{ task: 't1', role: 'designer', ts: 'a', codex_session: 'sd' }], (r) => r.ts);
  collectCodex(root, md, { dir: cdir, windows: taskWindows(backlogFixture()) });
  const by = Object.fromEntries(readRows(md, 'codex_sessions').map((x) => [x.session, x.role]));
  assert.deepEqual(by, { sd: 'designer', 'sd-child': 'designer', se: 'executor' }); // sin fila en runs: executor
  const roles = buildTaskRoles({ turns: [], codex: readRows(md, 'codex_sessions') });
  assert.deepEqual(roles.map((r) => r.role).sort(), ['designer', 'designer/sub', 'executor']);
});

import { judgeRun, pencilAppRunning } from '../src/verdict.mjs';
import { finalAgentMessage, findRolloutById } from '../src/codex.mjs';

test('veredicto de una corrida de Codex: FAILED es fallo aunque exista la respuesta; sin respuesta solo valen los cambios reales', () => {
  assert.deepEqual(judgeRun({ role: 'executor', reply: 'DONE hecho', changed: false }), { ok: true });
  const failed = judgeRun({ role: 'designer', reply: 'FAILED get_editor_state: Pencil desktop connection failed', changed: true });
  assert.equal(failed.ok, false); // aunque haya archivos en design/, lo que dijo Codex manda
  assert.match(failed.reason, /Pencil desktop connection failed/);
  assert.equal(judgeRun({ role: 'executor', reply: '', changed: true }).ok, true); // olvidó escribir su línea pero trabajó
  assert.equal(judgeRun({ role: 'executor', reply: '', changed: false }).ok, false);
  assert.equal(judgeRun({ role: 'explore', reply: '', changed: true }).ok, false); // explore nunca cambia nada
  assert.equal(judgeRun({ role: 'explore', reply: 'DONE hay 3 archivos', changed: false }).ok, true);
  assert.equal(judgeRun({ role: 'executor', reply: '  failed: sin red', changed: true }).ok, false); // mayúsculas o espacios no la salvan
});

test('Pencil: solo cuenta la app de escritorio, no los servidores MCP sueltos', () => {
  const soloMcp = '/Applications/Pencil.app/Contents/Resources/app.asar.unpacked/out/mcp-server-darwin-arm64 --app desktop\n/usr/bin/other';
  assert.equal(pencilAppRunning(() => soloMcp), false);
  assert.equal(pencilAppRunning(() => `${soloMcp}\n/Applications/Pencil.app/Contents/MacOS/Pencil -psn_0_1234`), true);
  assert.equal(pencilAppRunning(() => ''), false);
});

test('respuesta final de Codex: se lee de su sesión (task_complete) aunque no pudiera escribir archivos', () => {
  const dir = tmp();
  const day = join(dir, '2026', '10', '04'); mkdirSync(day, { recursive: true });
  const f = join(day, 'rollout-2026-10-04T00-00-00-abc-123.jsonl');
  writeFileSync(f, [
    j({ type: 'event_msg', payload: { type: 'task_started' } }),
    j({ type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'DONE primera' } }),
    j({ type: 'event_msg', payload: { type: 'task_started' } }),
    j({ type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'DONE final: hay 3 archivos' } }),
  ].join('\n') + '\n');
  assert.equal(findRolloutById('abc-123', { dir }), f);
  assert.equal(finalAgentMessage('abc-123', { dir }), 'DONE final: hay 3 archivos'); // la última
  assert.equal(finalAgentMessage('no-existe', { dir }), '');
  assert.equal(finalAgentMessage('', { dir }), '');
});

import { sessionStartedSince } from '../src/codex.mjs';

test('sesión de Codex sin id de Herdr: se encuentra la raíz que empezó justo después del lanzamiento', () => {
  const dir = tmp(); const root = '/p/gym-app';
  const tok = { input_tokens: 10, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0, total_tokens: 11 };
  fakeRollout(dir, { id: 'antes', cwd: root, ts: '2026-10-02T09:00:00.000Z', tokens: tok, q: [1, 1] });
  fakeRollout(dir, { id: 'raiz', cwd: root, ts: '2026-10-02T10:00:05.000Z', tokens: tok, q: [1, 1] });
  fakeRollout(dir, { id: 'hija', cwd: root, ts: '2026-10-02T10:00:20.000Z', parent: 'raiz', tokens: tok, q: [1, 1] });
  fakeRollout(dir, { id: 'ajena', cwd: '/otro', ts: '2026-10-02T10:00:06.000Z', tokens: tok, q: [1, 1] });
  const since = Date.parse('2026-10-02T10:00:00.000Z');
  assert.equal(sessionStartedSince(root, since, { dir }), 'raiz'); // ni la anterior, ni la hija, ni la de otro proyecto
  assert.equal(sessionStartedSince(root, Date.parse('2026-10-03T00:00:00.000Z'), { dir }), '');
});

test('agents sync no congela los valores por defecto en el perfil del proyecto', () => {
  const root = tmp();
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' }, dependencies: { next: '1' } }));
  const run = (...a) => spawnSync('node', [join(import.meta.dirname, '../bin/harness.mjs'), ...a, '--root', root], { encoding: 'utf8' });
  assert.equal(run('init', '--apply').status, 0);
  const file = join(root, '.harness/profile.json');
  const user = JSON.parse(readFileSync(file, 'utf8'));
  delete user.agents; delete user.rules; delete user.skillsUnassigned; // como un perfil de una versión anterior
  writeFileSync(file, JSON.stringify(user));
  assert.equal(run('agents', 'sync').status, 0);
  const after = JSON.parse(readFileSync(file, 'utf8'));
  assert.ok(after.agents && after.rules); // lo calculado sí se guarda
  assert.equal(after.models, undefined); // y los modelos por defecto NO
  assert.equal(after.effortCap, undefined);
  assert.equal(loadProfile(root).models.explore.provider, 'claude'); // así que un default nuevo llega al proyecto
});

test('modelo sin tarifa (gpt-6-luna): el costo queda vacío y el informe lo avisa', () => {
  const dir = tmp(); const root = '/p/x';
  const tok = { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 0, total_tokens: 1010 };
  const f = fakeRollout(dir, { id: 'luna', cwd: root, ts: '2026-10-02T10:00:00.000Z', model: 'gpt-6-luna', tokens: tok, q: [1, 1] });
  const s = parseRollout(f).session;
  assert.equal(s.cost_est, ''); // no 0
  assert.equal(codexCost(tok, 'gpt-6-luna'), null);
  const rows = [{ ...s, task: 't1', depth: 0, in: 1000, cached: 0, out: 10, role: 'explore' }];
  const out = report({ tasks: [], task_roles: [], turns: [], codex: rows, quota: [] });
  assert.match(out, /Sin tarifa conocida.*gpt-6-luna/);
});

// ---- helpers para los tests de reutilización ----
const git = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8' });
function repoWithCode() {
  const r = tmp();
  git(r, 'init', '-q');
  mkdirSync(join(r, 'src'), { recursive: true });
  writeFileSync(join(r, 'src', 'billing.ts'), 'export class BillingPort {\n  charge() {}\n}\n');
  writeFileSync(join(r, 'src', 'billing.spec.ts'), "import { BillingPort } from './billing';\n");
  writeFileSync(join(r, 'README.md'), 'Uses BillingPort for payments\n');
  git(r, 'add', '-A');
  return r;
}

function fakeClaude(dir, body) {
  const f = join(dir, 'claude');
  writeFileSync(f, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(f, 0o755);
  return f;
}

// ---- reutilización: explore --reuse y reuse-check ----
import { declarations, exploreReuse, reuseCheck, reuseSearch, similarity } from '../src/reuse.mjs';

const FORMAT_SRC = 'export function formatMoney(value: number): string {\n  if (value === null) return "-";\n  const n = Number(value);\n  if (!Number.isFinite(n)) return "-";\n  const cents = !Number.isInteger(n);\n  return `$${cents ? WITH.format(n) : WHOLE.format(n)}`;\n}\n';

// Grafo falso: responde con lo que el test le pone en FAKE_GRAPH (herramienta → respuesta).
function fakeGraph(dir, root, answers) {
  const f = join(dir, 'fake-graph');
  writeFileSync(f, `#!/usr/bin/env node
const a = JSON.parse(process.env.FAKE_GRAPH || '{}');
if (process.argv[2] === '--version') { console.log('fake 0'); process.exit(0); }
let d = ''; process.stdin.on('data', (c) => (d += c)).on('end', () => { const t = process.argv[3]; let r = a[t]; if (r && r.$when) { const hit = r.$when.find(([re]) => new RegExp(re).test(d)); r = hit ? hit[1] : (r.$default ?? {}); } console.log(JSON.stringify(r ?? {})); });
`);
  chmodSync(f, 0o755);
  process.env.HARNESS_GRAPH_BIN = f;
  process.env.FAKE_GRAPH = '';
  return (m) => { process.env.FAKE_GRAPH = JSON.stringify(m); };
}
const cleanGraph = () => { delete process.env.HARNESS_GRAPH_BIN; delete process.env.FAKE_GRAPH; };

test('declarations: funciones, flechas y clases con su cuerpo; ignora lo que no es declaración', () => {
  const t = 'import x from "y";\nexport function a(p) {\n  if (p) {\n    return 1;\n  }\n  return 2;\n}\nexport const b = async (q: number) => {\n  return q;\n};\nclass C {\n  m() {}\n}\nconst z = 5;\n';
  const d = declarations(t);
  assert.deepEqual(d.map((x) => [x.name, x.start, x.end]), [['a', 2, 7], ['b', 8, 10], ['C', 11, 13]]);
});

test('similarity: un renombrado sigue siendo duplicado; una función distinta no', () => {
  const renamed = FORMAT_SRC.replaceAll('formatMoney', 'toPesos').replaceAll('value', 'amount').replaceAll('cents', 'frac').replaceAll(' n ', ' num ').replaceAll('(n)', '(num)');
  assert.ok(similarity(FORMAT_SRC, renamed) > 0.8, `renombrado: ${similarity(FORMAT_SRC, renamed)}`);
  const other = 'export function slug(t: string): string {\n  return t.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");\n}\n';
  assert.ok(similarity(FORMAT_SRC, other) < 0.2);
});

test('explore --reuse: ordena por relevancia y uso, descarta tests, rutas HTTP y símbolos que el índice ya no tiene', () => {
  const r = repoWithCode(); const set = fakeGraph(r, r);
  const qn = (n) => `proj.src.${n}`;
  set({
    list_projects: { projects: [{ name: 'proj', root_path: r, nodes: 900 }] },
    search_graph: { results: [
      { name: 'formatMoney', qualified_name: qn('format.formatMoney'), label: 'Function', file_path: `${r}/src/format.ts`, start_line: 1, end_line: 7, rank: -10 },
      { name: 'formatDate', qualified_name: qn('format.formatDate'), label: 'Function', file_path: `${r}/src/format.ts`, start_line: 9, end_line: 12, rank: -9 },
      { name: 'helperTest', qualified_name: qn('x.helperTest'), label: 'Function', file_path: `${r}/src/x.spec.ts`, start_line: 1, end_line: 3, rank: -9 },
      { name: 'GET', qualified_name: qn('route.GET'), label: 'Function', file_path: `${r}/src/app/route.ts`, start_line: 1, end_line: 3, rank: -8 },
      { name: 'ghost', qualified_name: qn('old.ghost'), label: 'Function', file_path: `${r}/src/old.ts`, start_line: 1, end_line: 3, rank: -8 },
    ] },
    query_graph: { $when: [['SIMILAR_TO', { rows: [] }]], $default: { rows: [[qn('format.formatMoney'), '53'], [qn('format.formatDate'), '2']] } },
    get_code_snippet: { $when: [['ghost', { source: 'function other() {}', is_exported: true }], ['formatMoney', { source: 'export function formatMoney(a) {}', signature: '(a: number)', return_type: ': string', is_exported: true }], ['formatDate', { source: 'export function formatDate(a) {}', signature: '(a: Date)', return_type: ': string', is_exported: true }]], $default: {} },
  });
  try {
    const a = exploreReuse(r, 'format money amounts');
    assert.equal(a.source, 'graph');
    assert.deepEqual(a.rows.map((x) => x.name), ['formatMoney', 'formatDate']); // sin test, sin GET, sin el símbolo desaparecido
    assert.equal(a.rows[0].usedBy, 53);
    assert.equal(a.rows[0].signature, 'formatMoney(a: number): string');
  } finally { cleanGraph(); }
});

test('explore sin grafo: avisa cómo construirlo y no inventa candidatos', () => {
  const r = repoWithCode();
  process.env.HARNESS_GRAPH_BIN = '/no/existe/grafo';
  try {
    const a = reuseSearch(r, 'BillingPort charge');
    assert.equal(a.graph, false);
    assert.deepEqual(a.rows, []);
    assert.match(a.note, /--reindex/);
  } finally { cleanGraph(); }
});

test('explore --reuse --deep: veredictos de Haiku, ruta inventada fuera, y la segunda vez sale del caché', () => {
  const r = repoWithCode(); const set = fakeGraph(r, r);
  set({ list_projects: { projects: [{ name: 'proj', root_path: r, nodes: 900 }] }, search_graph: { results: [] }, query_graph: { rows: [] } });
  const claude = join(r, 'claude');
  writeFileSync(claude, `#!/usr/bin/env node\nconsole.log(JSON.stringify([{type:'result',result:'reuse|BillingPort|src/billing.ts|1|already charges customers\\nextend|Fake|src/inventada.ts|4|no existe\\nnew|||| nada más',total_cost_usd:0.003}]));\n`);
  chmodSync(claude, 0o755); process.env.HARNESS_EXPLORE_CLAUDE = claude;
  try {
    const a = exploreReuse(r, 'cobrar al cliente', { deep: true });
    assert.equal(a.source, 'model');
    assert.deepEqual(a.rows.map((x) => [x.name, x.verdict, x.path]), [['BillingPort', 'reuse', 'src/billing.ts']]);
    const b = exploreReuse(r, 'cobrar al cliente', { deep: true });
    assert.equal(b.hit, true);
    assert.equal(b.rows[0].name, 'BillingPort');
    assert.equal(b.rows[0].why, 'already charges customers');
    writeFileSync(join(r, 'src', 'billing.ts'), 'cambió\n'); // el archivo citado cambia: la respuesta cara caduca
    assert.equal(exploreReuse(r, 'cobrar al cliente', { deep: true }).hit, false);
  } finally { cleanGraph(); delete process.env.HARNESS_EXPLORE_CLAUDE; }
});

test('reuse-check: marca el duplicado renombrado y no marca la función distinta', () => {
  const r = repoWithCode(); const set = fakeGraph(r, r);
  mkdirSync(join(r, 'src', 'lib'), { recursive: true });
  writeFileSync(join(r, 'src', 'lib', 'pesos.ts'), 'export function toPesos(amount: number): string {\n  if (amount === null) return "-";\n  const num = Number(amount);\n  if (!Number.isFinite(num)) return "-";\n  const frac = !Number.isInteger(num);\n  return `$${frac ? WITH.format(num) : WHOLE.format(num)}`;\n}\n\nexport function slug(t: string): string {\n  const lower = t.toLowerCase().trim();\n  const dashed = lower.replace(/[^a-z0-9]+/g, "-");\n  return dashed.replace(/^-|-$/g, "");\n}\n');
  set({
    list_projects: { projects: [{ name: 'proj', root_path: r, nodes: 900 }] },
    search_graph: { results: [{ name: 'formatMoney', qualified_name: 'proj.src.format.formatMoney', label: 'Function', file_path: `${r}/src/format.ts`, start_line: 1, end_line: 7, rank: -5 }] },
    query_graph: { rows: [['proj.src.format.formatMoney', '53']] },
    get_code_snippet: { source: FORMAT_SRC },
  });
  try {
    const out = reuseCheck(r, { base: 'HEAD' });
    assert.equal(out.graph, true);
    const hit = out.findings.find((f) => f.symbol === 'toPesos');
    assert.ok(hit, JSON.stringify(out));
    assert.equal(hit.verdict, 'duplicate');
    assert.equal(hit.matches[0].name, 'formatMoney');
    assert.equal(hit.matches[0].usedBy, 53);
    assert.ok(!out.findings.some((f) => f.symbol === 'slug'));
  } finally { cleanGraph(); }
});

test('harness explore --reuse (CLI): la intención con espacios llega completa', () => {
  const r = repoWithCode();
  process.env.HARNESS_GRAPH_BIN = '/no/existe/grafo';
  try {
    const out = spawnSync('node', [join(import.meta.dirname, '..', 'bin', 'harness.mjs'), 'explore', '--reuse', 'format money amounts', '--root', r, '--json'], { encoding: 'utf8', env: process.env });
    assert.equal(JSON.parse(out.stdout).intent, 'format money amounts');
  } finally { cleanGraph(); }
});

test('reuse-check --strict: sale con código 1 solo si hay un duplicado', () => {
  const r = repoWithCode(); const set = fakeGraph(r, r);
  mkdirSync(join(r, 'src', 'lib'), { recursive: true });
  const dup = 'export function toPesos(amount: number): string {\n  if (amount === null) return "-";\n  const num = Number(amount);\n  if (!Number.isFinite(num)) return "-";\n  const frac = !Number.isInteger(num);\n  return `$${frac ? WITH.format(num) : WHOLE.format(num)}`;\n}\n';
  writeFileSync(join(r, 'src', 'lib', 'pesos.ts'), dup);
  set({ list_projects: { projects: [{ name: 'proj', root_path: r, nodes: 900 }] }, search_graph: { results: [{ name: 'formatMoney', qualified_name: 'proj.src.format.formatMoney', label: 'Function', file_path: `${r}/src/format.ts`, start_line: 1, end_line: 7, rank: -5 }] }, query_graph: { rows: [] }, get_code_snippet: { source: FORMAT_SRC } });
  const cli = (...a) => spawnSync('node', [join(import.meta.dirname, '..', 'bin', 'harness.mjs'), 'reuse-check', ...a, '--root', r], { encoding: 'utf8', env: process.env });
  try {
    assert.equal(cli().status, 0); // sin --strict solo informa
    assert.equal(cli('--strict').status, 1);
    writeFileSync(join(r, 'src', 'lib', 'pesos.ts'), 'export function slug(t: string): string {\n  const lower = t.toLowerCase().trim();\n  const dashed = lower.replace(/[^a-z0-9]+/g, "-");\n  return dashed.replace(/^-|-$/g, "");\n}\n');
    assert.equal(cli('--strict').status, 0); // nada duplicado: no bloquea
  } finally { cleanGraph(); }
});
