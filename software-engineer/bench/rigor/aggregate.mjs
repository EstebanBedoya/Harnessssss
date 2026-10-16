#!/usr/bin/env node
// Une los resultados por proyecto y calcula medias con intervalo de confianza del 95% (bootstrap, 2000 remuestreos) y comparaciones por pares.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url)); const R = join(here, 'results');
const PROJ = ['gym-app', 'bridge-gym', 'vidar-app'];
const load = (f) => (existsSync(join(R, f)) ? JSON.parse(readFileSync(join(R, f), 'utf8')) : null);
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const rng = (a) => () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
export function ci(a, B = 2000) {
  if (a.length < 2) return [mean(a), mean(a)];
  const r = rng(12345); const ms = [];
  for (let b = 0; b < B; b++) { let s = 0; for (let i = 0; i < a.length; i++) s += a[Math.floor(r() * a.length)]; ms.push(s / a.length); }
  ms.sort((x, y) => x - y); return [ms[Math.floor(B * 0.025)], ms[Math.floor(B * 0.975)]];
}
const stat = (a) => ({ n: a.length, mean: mean(a), ci: ci(a) });
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

const micro = PROJ.flatMap((p) => load(`micro-${p}.json`)?.rows.map((r) => ({ ...r, project: p })) || []);
const lat = PROJ.flatMap((p) => load(`micro-${p}-lat.json`)?.rows.map((r) => ({ ...r, project: p })) || []);
const methods = [...new Set(micro.map((r) => r.method))];
const kinds = ['commit', 'symbol', 'file'];
const out = { retrieval: {}, latency: {}, paired: {}, cache: {}, invalidation: {}, agents: {} };
for (const m of methods) for (const k of [...kinds, 'all']) {
  const rs = micro.filter((r) => r.method === m && (k === 'all' || r.kind === k)); if (!rs.length) continue;
  out.retrieval[`${m}|${k}`] = { n: rs.length, hit1: stat(rs.map((r) => r.hit1)), hit5: stat(rs.map((r) => r.hit5)), recall10: stat(rs.map((r) => r.recall10)), mrr: stat(rs.map((r) => r.mrr)), bytes: Math.round(mean(rs.map((r) => r.bytes))), usd: mean(rs.map((r) => r.usd)) };
}
for (const m of [...new Set(lat.map((r) => r.method))]) for (const k of [...kinds, 'all']) {
  const rs = lat.filter((r) => r.method === m && (k === 'all' || r.kind === k)); if (!rs.length) continue;
  out.latency[`${m}|${k}`] = { median: median(rs.map((r) => r.ms)), p90: [...rs.map((r) => r.ms)].sort((a, b) => a - b)[Math.floor(rs.length * 0.9)], mean: Math.round(mean(rs.map((r) => r.ms))) };
}
const by = (m) => new Map(micro.filter((r) => r.method === m).map((r) => [r.id, r]));
for (const [a, b] of [['explorer_cold', 'trad'], ['explorer_cold', 'graph_bm25'], ['explorer_deep', 'trad'], ['explorer_deep', 'graph_bm25'], ['explorer_deep', 'explorer_cold'], ['graph_name', 'explorer_cold']]) for (const k of [...kinds, 'all']) {
  const A = by(a), B = by(b); let w = 0, l = 0, t = 0; const d = [];
  for (const [id, ra] of A) { const rb = B.get(id); if (!rb || (k !== 'all' && ra.kind !== k)) continue; const x = ra.mrr - rb.mrr; d.push(x); if (x > 1e-9) w++; else if (x < -1e-9) l++; else t++; }
  if (d.length) out.paired[`${a} vs ${b}|${k}`] = { n: d.length, win: w, tie: t, loss: l, meanDeltaMrr: mean(d), ci: ci(d) };
}
out.cache = Object.fromEntries(PROJ.map((p) => [p, load(`micro-${p}.json`)?.sim]));
const inv = {}; for (const p of PROJ) for (const [k, v] of Object.entries(load(`micro-${p}.json`)?.invalidation || {})) { inv[k] ??= { ok: 0, n: 0 }; inv[k].ok += v.ok; inv[k].n += v.n; }
out.invalidation = inv;
const ag = PROJ.flatMap((p) => load(`agents-${p}.json`)?.rows.map((r) => ({ ...r, project: p })) || []);
for (const arm of [...new Set(ag.map((r) => r.arm))]) {
  const rs = ag.filter((r) => r.arm === arm); const ok = rs.filter((r) => !r.error);
  out.agents[arm] = { n: rs.length, errors: rs.length - ok.length, hit1: stat(ok.map((r) => r.hit1)), hit5: stat(ok.map((r) => r.hit5)), recall: stat(ok.map((r) => r.recall)), mrr: stat(ok.map((r) => r.mrr)), usd: stat(ok.map((r) => r.usd)), turns: stat(ok.map((r) => r.turns)), toolCalls: stat(ok.map((r) => r.toolCalls)), sec: stat(ok.map((r) => r.ms / 1000)), totalUsd: ok.reduce((s, r) => s + r.usd, 0) };
}

// pares entre brazos de agentes (misma tarea) y proyección de costo con Sonnet 5.5 como agente
out.agentsPaired = {};
const byArm = (arm) => new Map(ag.filter((r) => r.arm === arm && !r.error).map((r) => [r.id, r]));
for (const [x, y] of [['explorer', 'traditional'], ['graph', 'traditional'], ['explorer', 'graph'], ['explorer_cached', 'explorer'], ['explorer_cached', 'traditional']]) {
  const X = byArm(x), Y = byArm(y);
  for (const [metric, get] of [['mrr', (r) => r.mrr], ['usd', (r) => r.usd], ['sec', (r) => r.ms / 1000], ['turns', (r) => r.turns]]) {
    const d = []; for (const [id, rx] of X) { const ry = Y.get(id); if (ry) d.push(get(rx) - get(ry)); }
    out.agentsPaired[`${x} vs ${y}|${metric}`] = { n: d.length, mean: mean(d), ci: ci(d) };
  }
}
// Haiku 5.5 → Sonnet 5.5: entrada, salida y caché cuestan exactamente 20x ($0.10/$0.50/$0.01 → $2/$10/$0.20). Supone el mismo comportamiento (turnos y tokens).
out.projection = {};
for (const arm of Object.keys(out.agents)) {
  const rs = ag.filter((r) => r.arm === arm && !r.error);
  const agentUsd = mean(rs.map((r) => r.agentUsd ?? r.usd)); const exUsd = mean(rs.map((r) => r.exUsd ?? 0));
  out.projection[arm] = { haiku: agentUsd + exUsd, sonnetAgent: agentUsd * 20 + exUsd, nested: exUsd };
}

// ---- reutilización: A) descubrimiento (verdad = lo que el desarrollador importó) y B) duplicados inyectados ----
{
  const rs = PROJ.map((p) => load(`reuse-${p}.json`)).filter(Boolean);
  const A = rs.flatMap((r) => r.rowsA.map((x) => ({ ...x, project: r.project }))); const B = rs.flatMap((r) => r.rowsB.map((x) => ({ ...x, project: r.project })));
  out.reuse = { A: {}, pairsA: {}, B: {} };
  for (const m of [...new Set(A.map((r) => r.method))]) { const x = A.filter((r) => r.method === m); out.reuse.A[m] = { n: x.length, recall: stat(x.map((r) => r.recall)), any: stat(x.map((r) => r.any)), mrr: stat(x.map((r) => r.mrr)), ms: median(x.map((r) => r.ms)) }; }
  const byM = (m) => new Map(A.filter((r) => r.method === m).map((r) => [r.id, r]));
  for (const [p, q] of [['reuse_deep', 'trad'], ['reuse_deep', 'graph_bm25'], ['reuse_deep', 'explorer_deep'], ['reuse_graph', 'graph_bm25'], ['reuse_graph', 'trad'], ['reuse_deep', 'reuse_graph']]) {
    const X = byM(p), Y = byM(q), d = [];
    for (const [id, r] of X) { const y = Y.get(id); if (y) d.push(r.recall - y.recall); }
    out.reuse.pairsA[`${p} vs ${q}`] = { n: d.length, mean: mean(d), ci: ci(d), win: d.filter((v) => v > 1e-9).length, tie: d.filter((v) => Math.abs(v) <= 1e-9).length, loss: d.filter((v) => v < -1e-9).length };
  }
  for (const lv of ['rename', 'noise', 'prune', 'foreign']) {
    const x = B.filter((r) => r.level === lv); if (!x.length) continue;
    out.reuse.B[lv] = { n: x.length, flagged: stat(x.map((r) => r.flagged)), foundOriginal: stat(x.map((r) => r.foundOriginal)), duplicate: stat(x.map((r) => r.duplicate)), medianJaccard: median(x.filter((r) => r.foundOriginal).map((r) => r.jaccard)) ?? 0 };
  }
}

// ---- agentes ante un requisito que ya existe: ¿reutilizan o duplican? ----
{
  const rows = PROJ.flatMap((p) => load(`agents-reuse-${p}.json`)?.rows.map((r) => ({ ...r, project: p })) || []);
  out.reuseAgents = { arms: {}, paired: {}, targets: new Set(rows.map((r) => r.id)).size };
  for (const arm of ['plain', 'guided']) {
    const x = rows.filter((r) => r.arm === arm); if (!x.length) continue;
    const cnt = {}; x.forEach((r) => { cnt[r.outcome] = (cnt[r.outcome] || 0) + 1; });
    out.reuseAgents.arms[arm] = { n: x.length, counts: cnt, reused: stat(x.map((r) => (r.outcome === 'reutilizó' ? 1 : 0))), duplicated: stat(x.map((r) => (r.outcome === 'duplicó' ? 1 : 0))), usd: mean(x.map((r) => r.usd)), turns: mean(x.map((r) => r.turns)), sec: mean(x.map((r) => r.ms / 1000)), lines: mean(x.map((r) => r.lines)), usedExplore: x.filter((r) => r.commands.some((c) => /explore/.test(c))).length, usedCheck: x.filter((r) => r.commands.some((c) => /reuse-check/.test(c))).length };
  }
  const P = new Map(rows.filter((r) => r.arm === 'plain').map((r) => [r.id, r])); const d1 = [], d2 = [], tab = {};
  for (const r of rows.filter((x) => x.arm === 'guided')) { const p = P.get(r.id); if (!p) continue; d1.push((r.outcome === 'reutilizó' ? 1 : 0) - (p.outcome === 'reutilizó' ? 1 : 0)); d2.push((r.outcome === 'duplicó' ? 1 : 0) - (p.outcome === 'duplicó' ? 1 : 0)); const k = `${p.outcome} → ${r.outcome}`; tab[k] = (tab[k] || 0) + 1; }
  out.reuseAgents.paired = { n: d1.length, reusedDelta: { mean: mean(d1), ci: ci(d1) }, duplicatedDelta: { mean: mean(d2), ci: ci(d2) }, transitions: tab };
}
writeFileSync(join(R, 'summary.json'), JSON.stringify(out, null, 1));
if (process.argv.includes('--print')) {
  const f = (s) => `${s.mean.toFixed(2)} [${s.ci[0].toFixed(2)}-${s.ci[1].toFixed(2)}]`;
  for (const k of ['all', ...kinds]) { console.log(`\n== ${k}`); for (const m of methods) { const r = out.retrieval[`${m}|${k}`]; if (r) console.log(m.padEnd(20), `n=${String(r.n).padEnd(3)}`, 'hit1', f(r.hit1).padEnd(18), 'hit5', f(r.hit5).padEnd(18), 'rec10', f(r.recall10).padEnd(18), 'mrr', f(r.mrr).padEnd(18), 'B', r.bytes, 'ms', out.latency[`${m}|${k}`]?.median ?? '-'); } }
  console.log('\npareados (MRR)'); for (const [k, v] of Object.entries(out.paired)) console.log(k.padEnd(40), `n=${v.n} W${v.win}/T${v.tie}/L${v.loss} Δ=${v.meanDeltaMrr.toFixed(3)} [${v.ci[0].toFixed(3)}, ${v.ci[1].toFixed(3)}]`);
  console.log('\ncaché', JSON.stringify(out.cache)); console.log('invalidación', JSON.stringify(out.invalidation));
}
