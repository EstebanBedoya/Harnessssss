// Informe legible a partir de las tablas TOON. Solo lee y formatea: no gasta tokens.
const usd = (n) => `$${Number(n || 0).toFixed(2)}`;
const mins = (s) => { const m = Math.round((Number(s) || 0) / 60); return m >= 90 ? `${(m / 60).toFixed(1)} h` : `${m} min`; };
const k = (n) => { const x = Number(n) || 0; return x >= 1e6 ? `${(x / 1e6).toFixed(1)}M` : x >= 1e3 ? `${(x / 1e3).toFixed(1)}k` : String(x); };
const pad = (v, n, right = false) => (right ? String(v).padStart(n) : String(v).padEnd(n));

export function report(t, { only = null } = {}) {
  const L = [];
  const tasks = t.tasks.filter((x) => !only || x.task === only);
  const q = [...t.quota].sort((a, b) => String(a.end_ts).localeCompare(String(b.end_ts))).at(-1);
  L.push(`# Métricas del harness`, '');
  if (q) L.push(`Cuota de Codex (suscripción ${q.plan}), última lectura ${String(q.end_ts).slice(0, 16).replace('T', ' ')} UTC: ventana de 5 h ${q.p5h_end}% usada, semanal ${q.week_end}% usada.`, '');
  let total = 0;
  for (const x of tasks) {
    total += Number(x.total_cost) || 0;
    L.push(`## ${x.task}  (${x.category} ${x.tier}, ${x.status})`, '');
    L.push(`- Reloj: ${mins(x.wall_s)} (incluye esperas por el humano). Ejecutar ${mins(x.exec_s)} · gate ${mins(x.gate_s)} · revisión ${mins(x.review_s)} (puede incluir esperas)${Number(x.rework_s) ? ` · rehacer ${mins(x.rework_s)}` : ''}`);
    L.push(`- Intentos: ${x.exec_runs} ejecuciones de Codex (${x.exec_failed} sin resultado), ${x.gate_fail} gate en rojo, ${x.rejections} revisión rechazada, ${x.human_retries} reintento humano`);
    if (x.commits !== '') L.push(`- Código: ${x.commits} commits, ${x.files} archivos, +${x.additions} −${x.deletions}`);
    const cx = t.codex.filter((c) => c.task === x.task);
    const cfg = [...new Set(cx.map((c) => `${c.model} ${c.effort} (${c.sandbox})`))];
    if (cx.length) {
      L.push(`- Codex: ${cx.length} sesiones (${cx.filter((c) => Number(c.depth) > 0).length} de subagentes), config real: ${cfg.join('; ')}`);
      L.push(`  tokens: entrada ${k(x.codex_in)} + caché ${k(x.codex_cached)} · salida ${k(x.codex_out)} · costo estimado ${usd(x.codex_cost)} · cuota usada ≈ ${x.quota_5h_pts} pts (5 h), ${x.quota_week_pts} pts (semana)`);
    }
    const roles = t.task_roles.filter((r) => r.task === x.task);
    if (roles.length) {
      L.push('', `  ${pad('rol', 14)}${pad('proveedor', 10)}${pad('modelo', 20)}${pad('turnos', 8, true)}${pad('salida', 9, true)}${pad('caché leída', 13, true)}${pad('costo est.', 12, true)}`);
      for (const r of roles) L.push(`  ${pad(r.role, 14)}${pad(r.provider, 10)}${pad(r.model, 20)}${pad(r.turns, 8, true)}${pad(k(r.out), 9, true)}${pad(k(r.cache_read), 13, true)}${pad(usd(r.cost_est), 12, true)}`);
    }
    L.push('', `  **Total estimado: ${usd(x.total_cost)}** (Claude ${usd(x.claude_cost)} + Codex ${usd(x.codex_cost)})`, '');
  }
  if (!only) {
    // "Fuera de las tareas" = lo ocurrido en el mismo período que ellas (el transcript trae todo el historial del proyecto).
    const from = t.tasks.map((x) => Date.parse(x.started)).filter(Number.isFinite).reduce((a, b) => Math.min(a, b), Infinity);
    const inPeriod = (ts) => !ts || !Number.isFinite(from) || Date.parse(ts) >= from;
    const loose = t.turns.filter((r) => !r.task && inPeriod(r.ts));
    const looseCost = loose.reduce((a, r) => a + (Number(r.cost_est) || 0), 0);
    const looseCodex = t.codex.filter((c) => !c.task && inPeriod(c.started));
    L.push('## Resumen', '', `- Total de las ${tasks.length} tareas: ${usd(total)}`);
    L.push(`- Uso de Claude fuera de las tareas del harness, en el mismo período: ${loose.length} turnos, ${usd(looseCost)} (tu trabajo normal en el proyecto)`);
    L.push(`- Uso de Codex fuera de las tareas, en el mismo período: ${looseCodex.length} sesiones, ${usd(looseCodex.reduce((a, c) => a + (Number(c.cost_est) || 0), 0))}`, '');
  }
  const unpriced = [...new Set(t.codex.filter((c) => c.cost_est === '' && (c.in || c.out)).map((c) => c.model))];
  if (unpriced.length) L.push(`Sin tarifa conocida, costo NO estimado (figura vacío, no 0): ${unpriced.join(', ')}.`);
  L.push('Los costos son estimados (tabla de precios en defaults.mjs; la escritura de caché y la lectura de Haiku son supuestos). La cuota es de toda la cuenta: incluye tu uso de Codex fuera del harness.');
  return `${L.join('\n')}\n`;
}
