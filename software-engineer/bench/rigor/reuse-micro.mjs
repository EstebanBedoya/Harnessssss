#!/usr/bin/env node
// (el método `explorer_deep` del informe histórico ya no existe: se eliminó el explorer de búsqueda de texto)
// A) descubrimiento: ¿cada método pone entre sus 8 primeros archivos lo que el desarrollador realmente reutilizó?
// B) duplicados: se inyectan copias disfrazadas de funciones existentes en una COPIA indexada del repo y se mide si reuse-check las encuentra.
// Uso: node bench/rigor/reuse-micro.mjs --project gym-app [--no-deep] [--n 12]
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { call, projectFor, reindex } from '../../src/graph.mjs';
import { declarations, exploreReuse, keywords, reuseCheck, reuseSearch } from '../../src/reuse.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2); const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i < 0 ? d : argv[i + 1]; };
const project = opt('project'); const DEEP = !argv.includes('--no-deep'); const N = Number(opt('n', 12)); const K = 8;
const cases = JSON.parse(readFileSync(join(here, 'cases-reuse.json'), 'utf8')).cases.filter((c) => c.project === project);
const repo = cases[0].repo; const gp = cases[0].graphProject;
process.env.HARNESS_REUSE_DIR = mkdtempSync(join(tmpdir(), 'reuse-bench-'));

const sh = (cmd, args, input) => spawnSync(cmd, args, { cwd: repo, input, encoding: 'utf8', maxBuffer: 128 << 20 });
const lines = (t) => (t || '').split('\n').filter(Boolean).map((l) => l.replace(/^\.\//, ''));
const EXC = ['-g', '!node_modules', '-g', '!.next', '-g', '!.harness', '-g', '!*lock*', '-g', '!.git'];
const rgFiles = (q) => lines(sh('rg', ['-l', '-F', '-i', '--sort', 'path', ...EXC, '--', q, '.']).stdout);
const fdFiles = (q) => lines(sh('fd', ['-t', 'f', '-i', '-F', '-E', 'node_modules', '-E', '.next', q]).stdout);
const uniq = (a) => [...new Set(a)];
const M = {
  trad(c) { const sc = new Map(); for (const k of keywords(c.query)) { for (const f of rgFiles(k)) sc.set(f, (sc.get(f) || 0) + 1); for (const f of fdFiles(k)) sc.set(f, (sc.get(f) || 0) + 2); } return [...sc].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([f]) => f); },
  graph_bm25(c) { return uniq((call('search_graph', { project: gp, query: c.query, limit: 30 })?.results || []).map((r) => r.file_path).filter(Boolean)).map((f) => f.replace(`${repo}/`, '')); },
  reuse_graph(c) { return uniq(reuseSearch(repo, c.query, { limit: K }).rows.map((r) => r.path)); },
  reuse_deep(c) { return uniq(exploreReuse(repo, c.query, { deep: true, fresh: true, role: 'bench' }).rows.map((r) => r.path)); },
};
const rowsA = [];
for (const c of cases) {
  for (const m of Object.keys(M)) {
    if (!DEEP && /deep/.test(m)) continue;
    const t = performance.now(); const files = M[m](c).slice(0, K); const ms = Math.round(performance.now() - t);
    const T = new Set(c.truth); const first = files.findIndex((f) => T.has(f));
    rowsA.push({ id: c.id, method: m, ms, recall: files.filter((f) => T.has(f)).length / T.size, any: first >= 0 ? 1 : 0, mrr: first < 0 ? 0 : 1 / (first + 1), n: files.length });
  }
  process.stderr.write('.');
}

// ---------- B: duplicados inyectados ----------
const clone = mkdtempSync(join(tmpdir(), 'reuse-inj-'));
spawnSync('git', ['clone', '-q', '--local', repo, clone]);
const idx = reindex(clone); const cloneProject = projectFor(clone)?.name;
const rng = (a) => () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const R = rng(5 + project.length);
const pickFns = (root, n, avoid = new Set()) => {
  const files = spawnSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).stdout.split('\n').filter((f) => /\.(ts|tsx)$/.test(f) && !/(\.|\/)(spec|test)\.|__tests__|\.d\.ts|(^|\/)(node_modules|dist|\.next|scripts|migrations|tests?)\//.test(f));
  const out = [];
  for (const f of files) { let t; try { t = readFileSync(join(root, f), 'utf8'); } catch { continue; } for (const d of declarations(t)) if (/^export\s+(async\s+)?function/.test(d.source) && d.end - d.start >= 6 && d.end - d.start <= 40 && !avoid.has(d.name) && !/^(GET|POST|PUT|PATCH|DELETE|default)$/.test(d.name)) out.push({ name: d.name, path: f, line: d.start, source: d.source }); }
  const seen = new Set(); const uniqueFns = out.filter((x) => (seen.has(x.name) ? false : seen.add(x.name)));
  for (let i = uniqueFns.length - 1; i > 0; i--) { const j = Math.floor(R() * (i + 1)); [uniqueFns[i], uniqueFns[j]] = [uniqueFns[j], uniqueFns[i]]; }
  return uniqueFns.slice(0, n);
};
const declared = (src) => { const ids = new Set(); const head = src.split('\n')[0]; for (const m of head.matchAll(/[(,]\s*([A-Za-z_$][\w$]*)\s*[:?,)=]/g)) ids.add(m[1]); for (const m of src.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) ids.add(m[1]); return [...ids].filter((x) => x.length > 1); };
const rename = (src, name) => { let s = src.replace(new RegExp(`(?<![.\\w$])${name}\\b`, 'g'), `${name}Copy`); for (const id of declared(src)) s = s.replace(new RegExp(`(?<![.\\w$])${id}\\b`, 'g'), `${id}X`); return s; };
const noise = (s) => s.replace(/\{\n/, '{\n  const _trace = 0;\n').replace(/\n(\s*)return /g, '\n$1void _trace;\n$1return ');
const prune = (s) => { const L = s.split('\n'); return L.filter((l, i) => i === 0 || i === L.length - 1 || /[{}]|return/.test(l) || R() > 0.25).join('\n'); };
const LEVELS = { rename: (s, n) => rename(s, n), noise: (s, n) => noise(rename(s, n)), prune: (s, n) => prune(noise(rename(s, n))) };
const rowsB = []; const fn = pickFns(clone, N);
const run = (kind, level, orig, src, dir = dirname(orig.path)) => {
  const rel = join(dir, '__bench_dup.ts'); const injected = join(clone, rel); // la carpeta de la función original existe en este repo
  writeFileSync(injected, `${src}\n`);
  const out = reuseCheck(clone, { base: 'HEAD' });
  rmSync(injected, { force: true });
  const f = out.findings.find((x) => x.path === rel);
  const hit = f?.matches.find((m) => m.name === orig.name && m.path === orig.path);
  rowsB.push({ kind, level, orig: orig.name, flagged: f ? 1 : 0, foundOriginal: hit ? 1 : 0, duplicate: f?.verdict === 'duplicate' ? 1 : 0, jaccard: hit ? hit.jaccard : 0, topJaccard: f ? f.matches[0].jaccard : 0, scanned: out.scanned });
};
if (cloneProject) {
  for (const o of fn) for (const [lv, f] of Object.entries(LEVELS)) run('positive', lv, o, f(o.source, o.name));
  const others = ['gym-app', 'bridge-gym', 'vidar-app'].filter((p) => p !== project);
  const foreign = others.flatMap((p) => pickFns(`/Users/ebedoya/Projects/Gym Suit/${p}`, Math.ceil(N / 2)));
  for (const o of foreign.slice(0, N)) run('negative', 'foreign', o, rename(o.source, o.name), dirname(fn[0].path));
  call('delete_project', { project: cloneProject });
}
rmSync(clone, { recursive: true, force: true });
writeFileSync(join(here, 'results', `reuse-${project}.json`), JSON.stringify({ project, rowsA, rowsB, index: idx }, null, 1));
process.stderr.write(`\nok ${project}: A ${rowsA.length} B ${rowsB.length} (índice ${idx?.nodes ?? '?'} nodos en ${idx ? Math.round(idx.ms / 1000) : '?'} s)\n`);
