import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { taskAt } from './attribution.mjs';
import { PRICES } from './defaults.mjs';
import { loadBacklog } from './store.mjs';
import { readRows, upsertRows } from './toonfile.mjs';

// Claude Code guarda el transcript en ~/.claude/projects/<ruta con todo lo no alfanumérico cambiado por '-'>.
export const transcriptDir = (root) => join(homedir(), '.claude', 'projects', root.replace(/[^a-zA-Z0-9]/g, '-'));

const ctx = (u) => (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);

export function costOf(model, u, prices = PRICES) {
  const p = prices[model];
  if (!p) return null;
  const cc = u.cache_creation || {};
  const w1h = cc.ephemeral_1h_input_tokens || 0;
  const w5m = (u.cache_creation_input_tokens || 0) - w1h;
  const m = prices._cache_write_mult;
  const usd = ((u.input_tokens || 0) * p.in + (u.output_tokens || 0) * p.out + (u.cache_read_input_tokens || 0) * p.cache_read
    + w5m * p.in * m['5m'] + w1h * p.in * m['1h']) / 1e6;
  return usd;
}

// Lee un transcript .jsonl y devuelve filas por turno (deduplicado por message.id). Solo números: nada de contenido.
export function parseTranscript(file, { session, agent, role = 'main', desc = '' }) {
  const turns = new Map();
  const tools = new Map();
  let branch = '';
  let firstTs = null;
  let lastTs = null;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.gitBranch && !branch) branch = o.gitBranch;
    const ts = o.timestamp ? Date.parse(o.timestamp) : null;
    if (ts) { firstTs ??= ts; lastTs = ts; }
    if (o.type !== 'assistant') continue;
    const m = o.message || {};
    for (const c of m.content || []) if (c?.type === 'tool_use') tools.set(c.name, (tools.get(c.name) || 0) + 1);
    if (!m.id || !m.usage) continue;
    const u = m.usage;
    turns.set(m.id, {
      session, agent, role, mid: m.id.slice(-12), model: m.model || '', ts: o.timestamp || '', task: '',
      in: u.input_tokens || 0, out: u.output_tokens || 0,
      cache_read: u.cache_read_input_tokens || 0, cache_write: u.cache_creation_input_tokens || 0,
      cost_est: Number((costOf(m.model, u) ?? 0).toFixed(5)),
      _ctx: ctx(u),
    });
  }
  const rows = [...turns.values()];
  const session_row = rows.length ? {
    session, agent, role, desc, branch, model: rows[0].model, turns: rows.length, task: '', started: rows[0].ts,
    first_ctx: rows[0]._ctx, max_ctx: Math.max(...rows.map((r) => r._ctx)),
    in: sum(rows, 'in'), out: sum(rows, 'out'), cache_read: sum(rows, 'cache_read'), cache_write: sum(rows, 'cache_write'),
    cost_est: Number(sum(rows, 'cost_est').toFixed(4)),
    wall_s: firstTs && lastTs ? Math.round((lastTs - firstTs) / 1000) : 0,
  } : null;
  return {
    turns: rows.map(({ _ctx, ...r }) => r),
    session: session_row,
    tools: [...tools].map(([tool, calls]) => ({ session, agent, role, tool, calls })),
  };
}
const sum = (rows, k) => rows.reduce((a, r) => a + r[k], 0);

// Tablas derivadas (se regeneran desde las fuentes). `runs` y `gates` se registran en vivo y no se pueden regenerar: nunca se borran.
export const SCHEMA_VERSION = '2';
const DERIVED = ['turns', 'sessions', 'tools', 'tasks', 'codex_sessions', 'codex_tools', 'quota', 'events', 'phases', 'task_roles', 'git'];

export function ensureSchema(metricsDir) {
  mkdirSync(metricsDir, { recursive: true });
  const f = join(metricsDir, 'SCHEMA');
  const cur = existsSync(f) ? readFileSync(f, 'utf8').trim() : '';
  if (cur === SCHEMA_VERSION) return false;
  for (const t of DERIVED) rmSync(join(metricsDir, `${t}.toon`), { force: true });
  writeFileSync(f, `${SCHEMA_VERSION}\n`);
  return true;
}

const readMeta = (jsonl) => {
  try { return JSON.parse(readFileSync(jsonl.replace(/\.jsonl$/, '.meta.json'), 'utf8')); } catch { return {}; }
};

export function collect(root, metricsDir, { tdir = transcriptDir(root), windows = [] } = {}) {
  if (!existsSync(tdir)) return { error: `no hay transcripts en ${tdir}` };
  const files = [];
  for (const f of readdirSync(tdir)) {
    const p = join(tdir, f);
    if (f.endsWith('.jsonl')) files.push({ p, session: basename(f, '.jsonl').slice(0, 8), agent: 'main', role: 'main' });
    else if (statSync(p).isDirectory() && existsSync(join(p, 'subagents'))) {
      for (const s of readdirSync(join(p, 'subagents')).filter((x) => x.endsWith('.jsonl'))) {
        const full = join(p, 'subagents', s);
        const meta = readMeta(full); // agent-<id>.meta.json: agentType (designer, reviewer, executor…), description, model
        files.push({ p: full, session: f.slice(0, 8), agent: `sub-${basename(s, '.jsonl').slice(-8)}`, role: meta.agentType || 'subagent', desc: String(meta.description || '').slice(0, 80) });
      }
    }
  }
  const T = []; const S = []; const L = [];
  for (const f of files) {
    const r = parseTranscript(f.p, f);
    for (const t of r.turns) t.task = t.ts ? taskAt(windows, Date.parse(t.ts)) : '';
    if (r.session) r.session.task = r.session.started ? taskAt(windows, Date.parse(r.session.started)) : '';
    T.push(...r.turns); if (r.session) S.push(r.session); L.push(...r.tools);
  }
  return {
    files: files.length,
    turns: upsertRows(metricsDir, 'turns', T, (r) => `${r.session}|${r.agent}|${r.mid}`),
    sessions: upsertRows(metricsDir, 'sessions', S, (r) => `${r.session}|${r.agent}`),
    tools: upsertRows(metricsDir, 'tools', L, (r) => `${r.session}|${r.agent}|${r.tool}`),
  };
}

// runs.toon: una fila por lanzamiento de un agente por Herdr (Codex no deja transcript propio que se haya verificado).
export const writeRun = (metricsDir, row) => upsertRows(metricsDir, 'runs', [row], (r) => `${r.task}|${r.role}|${r.ts}`);
export { readRows };

// ---------- Codex, git y resumen por tarea ----------

import { findRollouts, parseRollout } from './codex.mjs';
import { gitStats } from './gitstats.mjs';
import { buildEvents, buildPhases, buildTaskRoles, buildTasks } from './rollup.mjs';

export function collectCodex(root, metricsDir, { dir, windows = [], sinceMs = 0 } = {}) {
  const files = findRollouts(root, { dir, sinceMs });
  const parsed = files.map(parseRollout).filter(Boolean);
  const byId = new Map(parsed.map((p) => [p.session.session, p.session]));
  const taskOf = (s) => {
    let cur = s; const seen = new Set();
    while (cur?.parent && byId.has(cur.parent) && !seen.has(cur.session)) { seen.add(cur.session); cur = byId.get(cur.parent); } // los subagentes heredan la tarea de su raíz
    return taskAt(windows, Date.parse(cur.started));
  };
  // Rol de cada sesión de Codex: lo registró `harness exec` (runs.toon: codex_session → rol); los subagentes de Codex heredan el de su raíz.
  const roleByRun = new Map(readRows(metricsDir, 'runs').filter((r) => r.codex_session).map((r) => [r.codex_session, r.role || 'executor']));
  const roleOf = (s) => {
    let cur = s; const seen = new Set();
    while (cur && !roleByRun.has(cur.session) && cur.parent && byId.has(cur.parent) && !seen.has(cur.session)) { seen.add(cur.session); cur = byId.get(cur.parent); }
    return (cur && roleByRun.get(cur.session)) || 'executor';
  };
  const S = []; const T = []; const Q = [];
  for (const p of parsed) {
    const task = taskOf(p.session);
    const q = p.quota;
    S.push({ ...p.session, role: roleOf(p.session), task, q5h_start: q?.p5h_start ?? '', q5h_end: q?.p5h_end ?? '', qweek_start: q?.week_start ?? '', qweek_end: q?.week_end ?? '' });
    T.push(...p.tools);
    if (q) Q.push({ session: q.session, task, plan: q.plan, start_ts: q.start_ts, end_ts: q.end_ts, p5h_start: q.p5h_start ?? '', p5h_end: q.p5h_end ?? '', week_start: q.week_start ?? '', week_end: q.week_end ?? '' });
  }
  return {
    files: files.length,
    sessions: upsertRows(metricsDir, 'codex_sessions', S, (r) => r.session),
    tools: upsertRows(metricsDir, 'codex_tools', T, (r) => `${r.session}|${r.tool}`),
    quota: upsertRows(metricsDir, 'quota', Q, (r) => r.session),
  };
}

export function collectRollup(root, metricsDir) {
  const backlog = loadBacklog(root);
  const events = buildEvents(backlog); const phases = buildPhases(backlog);
  const git = Object.values(backlog.tasks).map((t) => gitStats(root, t)).filter(Boolean);
  const turns = readRows(metricsDir, 'turns'); const codex = readRows(metricsDir, 'codex_sessions'); const gates = readRows(metricsDir, 'gates');
  const taskRoles = buildTaskRoles({ turns, codex });
  const tasks = buildTasks({ backlog, taskRoles, phases, events, git, codex, gates });
  return {
    events: upsertRows(metricsDir, 'events', events, (r) => `${r.task}|${r.ts}|${r.event}`),
    phases: upsertRows(metricsDir, 'phases', phases, (r) => `${r.task}|${r.phase}`),
    git: upsertRows(metricsDir, 'git', git, (r) => r.task),
    task_roles: upsertRows(metricsDir, 'task_roles', taskRoles, (r) => `${r.task}|${r.role}|${r.provider}|${r.model}`),
    tasks: upsertRows(metricsDir, 'tasks', tasks, (r) => r.task),
  };
}

// gates.toon: una fila por corrida del gate, escrita en el momento (no se puede regenerar).
export const writeGate = (metricsDir, row) => upsertRows(metricsDir, 'gates', [row], (r) => `${r.task}|${r.ts}`);
