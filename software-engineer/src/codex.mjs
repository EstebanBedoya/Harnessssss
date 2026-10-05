import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PRICES } from './defaults.mjs';

// Lector de las sesiones de Codex (~/.codex/sessions/AAAA/MM/DD/rollout-*.jsonl). Solo números y nombres: nada de contenido.
// Cada sesión trae session_meta, turn_context (modelo, esfuerzo, sandbox reales), token_count (acumulado) y llamadas a herramientas.
// Codex puede lanzar subagentes propios (source.subagent.thread_spawn): forman un árbol con `parent`.

export const codexSessionsDir = () => join(homedir(), '.codex', 'sessions');

const firstLine = (file) => {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(16384);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString('utf8').split('\n')[0];
  } finally { closeSync(fd); }
};

// Archivos de rollout cuyo cwd está bajo `root`. Lee solo la primera línea (session_meta) de cada uno.
export function findRollouts(root, { dir = codexSessionsDir(), sinceMs = 0 } = {}) {
  if (!existsSync(dir)) return [];
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) {
        if (sinceMs && statSync(p).mtimeMs < sinceMs) continue;
        try {
          const meta = JSON.parse(firstLine(p));
          const cwd = meta?.payload?.cwd || '';
          if (meta?.type === 'session_meta' && (cwd === root || cwd.startsWith(`${root}/`))) out.push(p);
        } catch { /* línea ilegible: se ignora */ }
      }
    }
  };
  walk(dir);
  return out;
}

// USD: la entrada incluye la caché (total = entrada + salida, verificado en datos reales); el razonamiento va dentro de la salida (SUPUESTO).
export function codexCost(tokens, model, prices = PRICES) {
  const p = prices[model];
  if (!p || !tokens) return null;
  const cached = tokens.cached_input_tokens || 0;
  return (((tokens.input_tokens || 0) - cached) * p.in + cached * p.cache_read + (tokens.output_tokens || 0) * p.out) / 1e6;
}

const pct = (q) => (q && typeof q.used_percent === 'number' ? q.used_percent : null);

export function parseRollout(file) {
  const rows = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    try { rows.push(JSON.parse(line)); } catch { /* línea cortada */ }
  }
  const meta = rows.find((r) => r.type === 'session_meta')?.payload;
  if (!meta) return null;
  const spawn = meta.source?.subagent?.thread_spawn;
  const ctx = rows.find((r) => r.type === 'turn_context')?.payload || {};
  const tools = new Map();
  let lastTokens = null; let maxContext = 0; let turns = 0;
  const quotas = [];
  for (const r of rows) {
    const p = r.payload || {};
    if (r.type === 'response_item' && ['custom_tool_call', 'function_call', 'local_shell_call'].includes(p.type)) {
      const name = p.name || p.type;
      tools.set(name, (tools.get(name) || 0) + 1);
    } else if (r.type === 'event_msg' && p.type === 'task_started') turns++;
    else if (r.type === 'event_msg' && p.type === 'token_count' && p.info) {
      lastTokens = p.info.total_token_usage || lastTokens;
      maxContext = Math.max(maxContext, p.info.model_context_window || 0);
      const rl = p.rate_limits;
      if (rl) quotas.push({ ts: r.timestamp, plan: rl.plan_type || '', p5h: pct(rl.primary), week: pct(rl.secondary), resets_5h: rl.primary?.resets_at ?? null, resets_week: rl.secondary?.resets_at ?? null });
    }
  }
  const stamps = rows.map((r) => Date.parse(r.timestamp)).filter(Number.isFinite);
  const t0 = Date.parse(meta.timestamp) || Math.min(...stamps);
  const t1 = Math.max(...stamps);
  const model = ctx.model || '';
  const t = lastTokens || {};
  const first = quotas[0]; const last = quotas.at(-1);
  return {
    session: {
      session: meta.id, parent: spawn?.parent_thread_id || meta.forked_from_id || '', depth: spawn?.depth ?? 0,
      agent: spawn?.agent_path || (spawn ? 'subagent' : 'root'), nickname: meta.agent_nickname || '',
      cli: meta.cli_version || '', model, effort: ctx.effort || '', sandbox: ctx.sandbox_policy?.type || '', approval: ctx.approval_policy || '',
      started: new Date(t0).toISOString(), ended: new Date(t1).toISOString(), wall_s: Math.round((t1 - t0) / 1000), turns,
      in: t.input_tokens || 0, cached: t.cached_input_tokens || 0, out: t.output_tokens || 0, reasoning: t.reasoning_output_tokens || 0,
      max_ctx: maxContext, tool_calls: [...tools.values()].reduce((a, b) => a + b, 0),
      // Vacío (no 0) si el modelo no tiene tarifa conocida: un 0 sería un dato falso.
      cost_est: codexCost(t, model) === null ? '' : Number(codexCost(t, model).toFixed(4)),
    },
    tools: [...tools].map(([tool, calls]) => ({ session: meta.id, tool, calls })),
    quota: first ? { session: meta.id, plan: last.plan, start_ts: first.ts, end_ts: last.ts, p5h_start: first.p5h, p5h_end: last.p5h, week_start: first.week, week_end: last.week, resets_5h: last.resets_5h, resets_week: last.resets_week } : null,
  };
}

// Archivo de rollout de una sesión por su id (el nombre termina en <id>.jsonl).
export function findRolloutById(id, { dir = codexSessionsDir() } = {}) {
  if (!id || !existsSync(dir)) return null;
  let found = null;
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (found) return;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(`${id}.jsonl`)) found = p;
    }
  };
  walk(dir);
  return found;
}

// Último mensaje del agente en una sesión (task_complete.last_agent_message): es su respuesta final aunque no pueda escribir archivos
// (por ejemplo `explore`, que corre en solo lectura). Cadena vacía si no hay.
export function finalAgentMessage(id, opts) {
  const file = findRolloutById(id, opts);
  if (!file) return '';
  let last = '';
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.includes('task_complete')) continue;
    try { const m = JSON.parse(line)?.payload?.last_agent_message; if (typeof m === 'string' && m.trim()) last = m.trim(); } catch { /* línea cortada */ }
  }
  return last;
}

// Respaldo cuando Herdr no da el id de la sesión: la sesión raíz de Codex de este proyecto que empezó justo después de lanzarla.
export function sessionStartedSince(root, sinceMs, opts = {}) {
  let best = null;
  for (const f of findRollouts(root, { dir: opts.dir, sinceMs: sinceMs - 60_000 })) {
    try {
      const m = JSON.parse(firstLine(f)).payload;
      if (m.source?.subagent) continue; // los subagentes de Codex no son la sesión raíz
      const t = Date.parse(m.timestamp);
      if (t >= sinceMs - 10_000 && (!best || t < best.t)) best = { t, id: m.id };
    } catch { /* ilegible */ }
  }
  return best?.id || '';
}
