import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { CORE_AGENTS_DIR, renderAgent } from './init.mjs';
import { formatRunEvent, isSettled } from './runners.mjs';
import { compareExecutors } from './rollup.mjs';
import { dirs, loadProfile } from './store.mjs';
import { readRows } from './toonfile.mjs';

// Datos de la TUI: todos los proyectos con harness, su configuración, qué está desactualizado, qué corre y cuánto han gastado.
// Solo lee archivos (y `herdr pane list`); nada de esto gasta tokens.

const SKIP = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'target', 'vendor', '.venv', 'Library', '.Trash']);

export function fleetRoots({ home = homedir(), read = (f) => readFileSync(f, 'utf8'), exists = existsSync } = {}) {
  const cfg = join(home, '.harness', 'fleet.json');
  try { if (exists(cfg)) return JSON.parse(read(cfg)).roots.map((r) => r.replace(/^~/, home)); } catch { /* config rota: se usan los de siempre */ }
  return ['Projects', 'Lab', 'Servers'].map((d) => join(home, d));
}

// Carpetas con .harness/profile.json hasta `depth` niveles; al encontrar una no se baja más (sus subcarpetas son del mismo proyecto).
export function discoverProjects(roots, depth = 3) {
  const found = [];
  const walk = (dir, left) => {
    let ents; try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    if (existsSync(join(dir, '.harness', 'profile.json'))) { found.push(dir); return; }
    if (left === 0) return;
    for (const e of ents) if (e.isDirectory() && !SKIP.has(e.name) && !e.name.startsWith('.')) walk(join(dir, e.name), left - 1);
  };
  for (const r of roots) walk(r, depth);
  return found.sort();
}

// Estado de cada agente instalado frente a lo que `agents sync` escribiría hoy.
export function agentStates(root, profile, srcDir = CORE_AGENTS_DIR) {
  const name = basename(root);
  return readdirSync(srcDir).filter((f) => f.endsWith('.md')).sort().map((f) => {
    const role = f.replace(/\.md$/, '');
    const dst = join(root, '.claude', 'agents', f);
    if (!existsSync(dst)) return { role, state: 'missing' };
    const want = renderAgent(readFileSync(join(srcDir, f), 'utf8'), role, name, profile);
    return { role, state: readFileSync(dst, 'utf8') === want ? 'ok' : 'stale' };
  });
}

// Llaves del perfil que ya no significan nada (Codex, designer con Pencil): se pueden limpiar.
export function legacyKeys(root) {
  try {
    const raw = JSON.parse(readFileSync(dirs(root).profile, 'utf8'));
    return [raw.codex !== undefined && 'codex', raw.models?.designer?.use !== undefined && 'models.designer.use', raw.models?.designer?.codex !== undefined && 'models.designer.codex'].filter(Boolean);
  } catch { return []; }
}

// Corridas de pi: un log por tarea. Corre si no llegó a `agent_settled` y se escribió hace poco.
export function liveRuns(root, now = Date.now(), freshMs = 180000) {
  const dir = join(root, '.harness', 'logs');
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.jsonl'))) {
    const p = join(dir, f);
    const st = statSync(p);
    const lines = readFileSync(p, 'utf8').split('\n').filter(Boolean);
    let settled = false; let last = ''; let started = st.birthtimeMs;
    for (const l of lines) {
      try { const ev = JSON.parse(l); if (isSettled(ev)) settled = true; const t = formatRunEvent(ev); if (t) last = t; if (ev.type === 'session' && ev.timestamp) started = Date.parse(ev.timestamp); } catch { /* cortada */ }
    }
    const running = !settled && now - st.mtimeMs < freshMs;
    out.push({ task: basename(f, '.jsonl'), running, last: last.replace(/^[^\p{L}\p{N}]+/u, '').slice(0, 120) || '(sin actividad)', started, updated: st.mtimeMs });
  }
  return out.sort((a, b) => b.updated - a.updated);
}

export function claudePanes() {
  try {
    const j = JSON.parse(execFileSync('herdr', ['pane', 'list'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000 }));
    return (j.result?.panes || []).filter((p) => p.agent).map((p) => ({ agent: p.agent, status: p.agent_status, title: p.terminal_title_stripped || p.terminal_title || '', cwd: p.foreground_cwd || p.cwd || '', pane: p.pane_id }));
  } catch { return []; }
}

const num = (v) => Number(v) || 0;

export function projectMetrics(root) {
  const tasks = readRows(dirs(root).metrics, 'tasks');
  const sum = (k) => tasks.reduce((a, t) => a + num(t[k]), 0);
  return {
    tasks, count: tasks.length,
    cost: sum('total_cost'), claudeCost: sum('claude_cost'), externalCost: sum('codex_cost'),
    tokensIn: sum('codex_in'), tokensOut: sum('codex_out'), claudeOut: sum('claude_out'),
    byProvider: Object.entries(tasks.reduce((m, t) => { const k = t.executor || '—'; m[k] = (m[k] || 0) + num(t.codex_cost); return m; }, {})),
  };
}

export function projectStatus(root, { panes = [], now = Date.now() } = {}) {
  const name = basename(root);
  let profile = null; let error = '';
  try { profile = loadProfile(root); } catch (e) { error = String(e.message).split('\n')[0]; }
  if (!profile) return { root, name, configured: false, error, issues: ['profile.json ilegible'], agents: [], runs: [], panes: [], tasks: {}, metrics: projectMetrics(root) };
  const agents = agentStates(root, profile);
  let backlog = { tasks: {} }; try { backlog = JSON.parse(readFileSync(dirs(root).backlog, 'utf8')); } catch { /* sin backlog */ }
  const list = Object.values(backlog.tasks || {});
  const tasks = list.reduce((m, t) => { m[t.status] = (m[t.status] || 0) + 1; return m; }, {});
  const runs = liveRuns(root, now);
  const legacy = legacyKeys(root);
  const stale = agents.filter((a) => a.state !== 'ok');
  const issues = [
    !profile.gate?.cmd && 'sin gate configurado',
    stale.length && `${stale.length} agente(s) desactualizado(s): ${stale.map((a) => a.role).join(', ')}`,
    legacy.length && `llaves viejas en el perfil: ${legacy.join(', ')}`,
  ].filter(Boolean);
  return {
    root, name, configured: true, issues, outdated: stale.length > 0 || legacy.length > 0, legacy,
    gate: profile.gate?.cmd || null,
    executor: { provider: profile.models.executor.provider, model: profile.models.executor.model || '(modelo de pi)' },
    designer: { provider: profile.models.designer.provider, model: profile.models.designer.model },
    agents, runs, tasks, taskList: list.sort((a, b) => String(b.history?.at(-1)?.ts).localeCompare(String(a.history?.at(-1)?.ts))),
    panes: panes.filter((p) => p.cwd === root || p.cwd.startsWith(`${root}/`)),
    metrics: projectMetrics(root),
  };
}

export function fleetSnapshot({ roots = fleetRoots(), now = Date.now(), panes = claudePanes() } = {}) {
  const projects = discoverProjects(roots).map((r) => projectStatus(r, { panes, now }));
  const all = projects.flatMap((p) => p.metrics.tasks.map((t) => ({ ...t, project: p.name })));
  return {
    now, projects,
    totals: {
      projects: projects.length, running: projects.reduce((a, p) => a + p.runs.filter((r) => r.running).length, 0),
      outdated: projects.filter((p) => p.outdated).length, tasks: all.length,
      cost: projects.reduce((a, p) => a + p.metrics.cost, 0), claudeCost: projects.reduce((a, p) => a + p.metrics.claudeCost, 0),
      externalCost: projects.reduce((a, p) => a + p.metrics.externalCost, 0),
      tokensIn: projects.reduce((a, p) => a + p.metrics.tokensIn, 0), tokensOut: projects.reduce((a, p) => a + p.metrics.tokensOut, 0),
    },
    compare: compareExecutors(all),
    attention: attention(projects, now),
    byDay: costByDay(projects, 14, now),
  };
}

const H = 3600000;
const lastTs = (t) => Date.parse(t.history?.at(-1)?.ts || 0) || 0;

// Lo que espera algo de ti o parece atascado. Las propuestas se agrupan por proyecto: 16 planes viejos no deben tapar lo urgente.
export function attention(projects, now = Date.now()) {
  const out = [];
  for (const p of projects) {
    const proposed = [];
    for (const t of p.taskList || []) {
      const age = now - lastTs(t);
      const base = { project: p.name, task: t.id, tier: t.tier, status: t.status, age };
      const live = p.runs.some((r) => r.task === t.id && r.running);
      if (t.status === 'blocked') out.push({ ...base, level: 'red', text: 'bloqueada: necesita tu decisión (reintentar o cancelar)' });
      else if (t.status === 'proposed') proposed.push({ ...base });
      else if (t.status === 'executing' && !live && age > 0.5 * H) out.push({ ...base, level: 'red', text: 'en ejecución sin corrida activa: ¿se cayó?' });
      else if (['gating', 'gated', 'reviewing'].includes(t.status) && age > H) out.push({ ...base, level: 'yellow', text: t.status === 'reviewing' ? 'esperando la revisión del QA' : 'esperando el gate o el QA' });
      else if (t.status === 'approved' && !live && age > 2 * H) out.push({ ...base, level: 'yellow', text: 'aprobada pero nadie la ha lanzado' });
    }
    if (proposed.length) out.push({ project: p.name, task: proposed.length === 1 ? proposed[0].task : `${proposed.length} tareas`, tier: '', status: 'proposed', age: Math.max(...proposed.map((x) => x.age)), level: 'yellow', text: proposed.length === 1 ? 'esperando tu aprobación' : 'propuestas esperando tu aprobación (la más vieja)' });
    for (const i of p.issues || []) if (/desactualizado|sin gate/.test(i)) out.push({ project: p.name, task: '', tier: '', status: '', age: 0, level: 'yellow', text: i });
  }
  return out.sort((a, b) => (a.level === b.level ? b.age - a.age : a.level === 'red' ? -1 : 1));
}

// Costo por día (fecha en que se cerró la tarea): Claude y externo por separado.
export function costByDay(projects, days = 14, now = Date.now()) {
  const m = new Map();
  for (const p of projects) for (const t of p.metrics.tasks) {
    const d = String(t.ended || '').slice(0, 10);
    if (!d) continue;
    const r = m.get(d) || { day: d, claude: 0, ext: 0, tasks: 0 };
    r.claude += num(t.claude_cost); r.ext += num(t.codex_cost); r.tasks += 1;
    m.set(d, r);
  }
  const from = new Date(now - (days - 1) * 24 * H).toISOString().slice(0, 10);
  return [...m.values()].filter((r) => r.day >= from).sort((a, b) => a.day.localeCompare(b.day));
}

// Log de una corrida de pi, ya legible (una línea por evento).
export function runLog(root, task) {
  const f = join(root, '.harness', 'logs', `${task}.jsonl`);
  if (!existsSync(f)) return [];
  const out = [];
  for (const l of readFileSync(f, 'utf8').split('\n')) { try { const t = formatRunEvent(JSON.parse(l)); if (t) out.push(t); } catch { /* cortada */ } }
  return out;
}
