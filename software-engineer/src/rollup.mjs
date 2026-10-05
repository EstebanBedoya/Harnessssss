// Resumen por tarea a partir de las tablas ya recogidas: eventos, fases, gasto por rol y totales. Solo lee y calcula: cero tokens.
const sec = (a, b) => Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 1000));

export function buildEvents(backlog) {
  const rows = [];
  for (const t of Object.values(backlog.tasks || {})) {
    let prev = null;
    for (const h of t.history) {
      rows.push({ task: t.id, ts: h.ts, event: h.event, provider: h.provider || '', gap_s: prev ? sec(prev, h.ts) : 0 });
      prev = h.ts;
    }
  }
  return rows;
}

// Fase = tiempo entre un evento de inicio y el siguiente evento que la cierra. "review" y "plan" incluyen las esperas por el humano.
const PHASES = [
  ['plan', 'added', ['approve']],
  ['design', 'approve', ['design_done']],
  ['exec', 'exec_started', ['exec_done', 'exec_failed']],
  ['gate', 'exec_done', ['gate_pass', 'gate_fail']],
  ['visual', 'gate_pass', ['visual_done']],
  ['review', 'review_started', ['verdict_approved', 'verdict_rejected']],
  ['rework', 'human_retry', ['exec_started']],
];

export function buildPhases(backlog) {
  const rows = [];
  for (const t of Object.values(backlog.tasks || {})) {
    const acc = new Map();
    for (const [phase, start, ends] of PHASES) {
      t.history.forEach((h, i) => {
        if (h.event !== start) return;
        const end = t.history.slice(i + 1).find((x) => ends.includes(x.event));
        if (!end) return;
        const a = acc.get(phase) || { n: 0, seconds: 0 };
        a.n += 1; a.seconds += sec(h.ts, end.ts); acc.set(phase, a);
      });
    }
    for (const [phase, a] of acc) rows.push({ task: t.id, phase, n: a.n, seconds: a.seconds });
  }
  return rows;
}

const sum = (rows, k) => rows.reduce((a, r) => a + (Number(r[k]) || 0), 0);
const r4 = (n) => Number(n.toFixed(4));

// Gasto por tarea y rol (Claude por transcripts, Codex por sus sesiones).
export function buildTaskRoles({ turns, codex }) {
  const groups = new Map();
  for (const t of turns) {
    if (!t.task) continue;
    const key = `${t.task}|${t.role}|claude|${t.model}`;
    const g = groups.get(key) || { task: t.task, role: t.role, provider: 'claude', model: t.model, turns: 0, in: 0, out: 0, cache_read: 0, cache_write: 0, cost_est: 0 };
    g.turns += 1; g.in += t.in; g.out += t.out; g.cache_read += t.cache_read; g.cache_write += t.cache_write; g.cost_est += t.cost_est;
    groups.set(key, g);
  }
  for (const c of codex) {
    if (!c.task) continue;
    const base = c.role || 'executor';
    const role = Number(c.depth) === 0 ? base : `${base}/sub`;
    const key = `${c.task}|${role}|codex|${c.model}`;
    const g = groups.get(key) || { task: c.task, role, provider: 'codex', model: c.model, turns: 0, in: 0, out: 0, cache_read: 0, cache_write: 0, cost_est: 0 };
    g.turns += c.turns; g.in += c.in - c.cached; g.out += c.out; g.cache_read += c.cached; g.cost_est += c.cost_est;
    groups.set(key, g);
  }
  return [...groups.values()].map((g) => ({ ...g, cost_est: r4(g.cost_est) })).sort((a, b) => a.task.localeCompare(b.task) || b.cost_est - a.cost_est);
}

export function buildTasks({ backlog, taskRoles, phases, events, git, codex, gates = [] }) {
  return Object.values(backlog.tasks || {}).map((t) => {
    const roles = taskRoles.filter((r) => r.task === t.id);
    const claude = roles.filter((r) => r.provider === 'claude');
    const cx = codex.filter((c) => c.task === t.id);
    const ph = (name) => phases.find((p) => p.task === t.id && p.phase === name)?.seconds ?? 0;
    const ev = (name) => events.filter((e) => e.task === t.id && e.event === name).length;
    const g = git.find((x) => x.task === t.id);
    const first = t.history[0].ts; const last = t.history.at(-1).ts;
    const quota = cx.filter((c) => c.depth === 0).reduce((a, c) => a + Math.max(0, (Number(c.q5h_end) || 0) - (Number(c.q5h_start) || 0)), 0);
    const quotaWeek = cx.filter((c) => c.depth === 0).reduce((a, c) => a + Math.max(0, (Number(c.qweek_end) || 0) - (Number(c.qweek_start) || 0)), 0);
    const claudeCost = sum(claude, 'cost_est'); const codexCost = sum(cx, 'cost_est');
    return {
      task: t.id, category: t.category, tier: t.tier, status: t.status, executor: t.executor || '', started: first, ended: last,
      wall_s: sec(first, last), exec_s: ph('exec'), gate_s: ph('gate'), review_s: ph('review'), rework_s: ph('rework'),
      exec_runs: ev('exec_started'), exec_failed: ev('exec_failed'), gate_fail: ev('gate_fail'), rejections: ev('verdict_rejected'), human_retries: ev('human_retry'),
      gate_runs: gates.filter((x) => x.task === t.id).length,
      claude_turns: sum(claude, 'turns'), claude_out: sum(claude, 'out'), claude_cost: r4(claudeCost),
      codex_sessions: cx.length, codex_in: sum(cx, 'in'), codex_cached: sum(cx, 'cached'), codex_out: sum(cx, 'out'), codex_wall_s: sum(cx.filter((c) => c.depth === 0), 'wall_s'), codex_cost: r4(codexCost),
      total_cost: r4(claudeCost + codexCost),
      commits: g?.commits ?? '', files: g?.files ?? '', additions: g?.additions ?? '', deletions: g?.deletions ?? '',
      quota_5h_pts: Number(quota.toFixed(1)), quota_week_pts: Number(quotaWeek.toFixed(1)),
    };
  });
}
