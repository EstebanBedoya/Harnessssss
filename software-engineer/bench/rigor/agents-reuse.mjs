#!/usr/bin/env node
// ¿Un agente que recibe un requisito para el que YA existe una función la reutiliza o la reescribe?
// Dos brazos con el mismo agente (Haiku 5.5): sin guía y con las reglas de reutilización del executor (harness explore --reuse, reuse-check).
// Trabaja en una COPIA indexada del repo; la verdad es la función existente. Resultado: reutilizó / duplicó / hizo otra cosa.
// Uso: node bench/rigor/agents-reuse.mjs --project gym-app [--n 8] [--budget 0.4]
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { call, projectFor, reindex } from '../../src/graph.mjs';
import { declarations, reuseCheck } from '../../src/reuse.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2); const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i < 0 ? d : argv[i + 1]; };
const project = opt('project'); const N = Number(opt('n', 8)); const BUDGET = opt('budget', '0.40');
const HARNESS = join(here, '..', '..', 'bin', 'harness.mjs'); const MODEL = 'claude-haiku-5-5';
const repo = `/Users/ebedoya/Projects/Gym Suit/${project}`;
const clone = mkdtempSync(join(tmpdir(), 'reuse-agents-')); spawnSync('git', ['clone', '-q', '--local', repo, clone]);
const idx = reindex(clone); const gp = projectFor(clone)?.name;
process.env.HARNESS_REUSE_DIR = mkdtempSync(join(tmpdir(), 'reuse-agents-cache-'));
const rng = (a) => () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const R = rng(21 + project.length);

// 1) objetivos: funciones exportadas de TS, 6 a 40 líneas, usadas en 3+ lugares (existe una razón real para reutilizarlas)
const files = spawnSync('git', ['ls-files'], { cwd: clone, encoding: 'utf8' }).stdout.split('\n').filter((f) => /\.ts$/.test(f) && !/(\.|\/)(spec|test)\.|__tests__|\.d\.ts|(^|\/)(node_modules|dist|scripts|migrations|tests?|app)\//.test(f));
const pool = [];
for (const f of files) { let t; try { t = readFileSync(join(clone, f), 'utf8'); } catch { continue; } for (const d of declarations(t)) if (/^export\s+(async\s+)?function/.test(d.source) && d.end - d.start >= 6 && d.end - d.start <= 40) pool.push({ name: d.name, path: f, line: d.start, source: d.source }); }
for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(R() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
const usedBy = (qn) => Number(call('query_graph', { project: gp, query: `MATCH (n)<-[r:CALLS|USAGE|IMPORTS]-(m) WHERE n.qualified_name = ${JSON.stringify(qn)} RETURN count(r) AS c` })?.rows?.[0]?.[0] || 0);
const targets = []; const usedFiles = new Set();
for (const c of pool) {
  if (targets.length >= N) break; if (usedFiles.has(c.path)) continue;
  const hit = (call('search_graph', { project: gp, name_pattern: `^${c.name}$`, limit: 5 })?.results || []).find((r) => r.file_path.endsWith(c.path));
  if (!hit || usedBy(hit.qualified_name) < 3) continue;
  usedFiles.add(c.path); targets.push({ ...c, usedBy: usedBy(hit.qualified_name) });
}
// 2) requisito en lenguaje natural, sin el nombre de la función (lo redacta Haiku, sin herramientas)
const run1 = (args, cwd, input) => spawnSync('claude', args, { cwd, input, encoding: 'utf8', maxBuffer: 32 << 20, timeout: 120000 });
const MIN = ['--no-session-persistence', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--disable-slash-commands', '--setting-sources', '', '--output-format', 'json'];
for (const t of targets) {
  const p = `Here is a function from a codebase:\n\n${t.source}\n\nWrite ONE sentence in English, phrased as a requirement for a developer ("I need a function that ..."), describing what it does and its inputs/outputs. Do NOT use the function name, nor any identifier from the code. Reply with only that sentence.`;
  const r = run1(['-p', p, '--model', MODEL, '--tools', '', ...MIN], clone); let j; try { j = JSON.parse(r.stdout); } catch { j = {}; }
  if (Array.isArray(j)) j = j.find((x) => x.type === 'result') || {};
  t.intent = String(j.result || '').trim().replace(/^["`]|["`]$/g, ''); t.intentUsd = Number(j.total_cost_usd) || 0;
}
const cases = targets.filter((t) => t.intent && !t.intent.includes(t.name));

const reuseRules = `Rules for this task (reuse before writing):
1. Before writing any new function, run: node ${HARNESS} explore --reuse "<what you are about to write>" --for executor   (if the answer looks off, repeat once with --deep).
2. If an existing function fits, import and use it instead of writing a new one. If you write new code anyway, say why.
3. Before finishing, run: node ${HARNESS} reuse-check   and fix any "duplicate" it reports by using the existing symbol.`;
const ARMS = {
  plain: { extra: '', allowed: ['Read', 'Grep', 'Glob', 'Write', 'Edit', 'Bash(rg:*)', 'Bash(fd:*)'], tools: 'Read,Grep,Glob,Write,Edit,Bash' },
  guided: { extra: `\n${reuseRules}`, allowed: ['Read', 'Grep', 'Glob', 'Write', 'Edit', `Bash(node ${HARNESS} explore:*)`, `Bash(node ${HARNESS} reuse-check:*)`], tools: 'Read,Grep,Glob,Write,Edit,Bash' },
};
const reset = () => { spawnSync('git', ['checkout', '-q', '--', '.'], { cwd: clone }); spawnSync('git', ['clean', '-fdq'], { cwd: clone }); };
function runAgent(arm, t, rel) {
  const a = ARMS[arm];
  const prompt = `You work in the repository in the current directory.\nRequirement: ${t.intent}\nCreate the file ${rel} (TypeScript) exporting the function(s) needed to satisfy this requirement.${a.extra}\nKeep it short. Final answer: one line saying what you did.`;
  const args = ['-p', prompt, '--model', MODEL, '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--tools', a.tools, '--allowedTools', ...a.allowed, '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--disable-slash-commands', '--setting-sources', '', '--max-budget-usd', BUDGET, '--permission-mode', 'acceptEdits'];
  return new Promise((resolve) => {
    const t0 = Date.now(); const p = spawn('claude', args, { cwd: clone }); let out = '';
    const timer = setTimeout(() => p.kill('SIGKILL'), 420000);
    p.stdout.on('data', (d) => { out += d; });
    p.on('close', () => { clearTimeout(timer); const ev = out.split('\n').filter((l) => l.startsWith('{')).map((l) => { try { return JSON.parse(l); } catch { return {}; } }); const res = ev.find((x) => x.type === 'result') || {}; const tools = ev.filter((x) => x.type === 'assistant').flatMap((x) => x.message?.content || []).filter((b) => b.type === 'tool_use'); resolve({ ms: Date.now() - t0, usd: Number(res.total_cost_usd) || 0, turns: res.num_turns ?? 0, tools: tools.map((b) => b.name), commands: tools.filter((b) => b.name === 'Bash').map((b) => String(b.input?.command || '').replace(HARNESS, 'harness').slice(0, 90)), error: res.is_error ? String(res.result).slice(0, 120) : '' }); });
  });
}
const rows = [];
for (const [i, t] of cases.entries()) {
  // El archivo nuevo va en la carpeta de OTRO objetivo: junto al original un `ls` ya delataría la función y no mediría nada.
  const other = cases.find((c, k) => k !== i && dirname(c.path) !== dirname(t.path)) || cases[(i + 1) % cases.length];
  const rel = join(dirname(other.path), '__task.ts');
  for (const arm of (i % 2 ? ['guided', 'plain'] : ['plain', 'guided'])) {
    reset();
    const r = await runAgent(arm, t, rel);
    const written = existsSync(join(clone, rel)) ? readFileSync(join(clone, rel), 'utf8') : '';
    const base = t.path.replace(/\.ts$/, '').split('/').pop();
    const importsOriginal = new RegExp(`from\\s+['"][^'"]*${base}['"]`).test(written) || new RegExp(`\\b${t.name}\\b`).test(written);
    const out = reuseCheck(clone, { base: 'HEAD' });
    const f = out.findings.find((x) => x.path === rel);
    const dupOfOriginal = !!f?.matches.some((m) => m.name === t.name && m.path === t.path);
    const outcome = !written ? 'nada' : importsOriginal && !dupOfOriginal ? 'reutilizó' : dupOfOriginal ? 'duplicó' : 'independiente';
    rows.push({ id: `${project}:${i}`, arm, target: t.name, usedBy: t.usedBy, outcome, importsOriginal, dupOfOriginal, lines: written.split('\n').length, ...r });
    writeFileSync(join(here, 'results', `agents-reuse-${project}.json`), JSON.stringify({ project, model: MODEL, intents: cases.map((c) => ({ name: c.name, intent: c.intent, usedBy: c.usedBy })), rows }, null, 1));
    process.stderr.write(outcome[0]);
  }
}
reset(); if (gp) call('delete_project', { project: gp }); rmSync(clone, { recursive: true, force: true });
process.stderr.write(`\nok ${project}: ${rows.length}\n`);
