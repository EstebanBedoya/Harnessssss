#!/usr/bin/env node
// Casos de reutilización con oráculo independiente: commits reales donde el desarrollador IMPORTÓ módulos que ya existían.
// Pregunta = asunto del commit. Verdad = archivos importados que existían en el padre del commit (no creados en él) y no son ubicuos.
// Uso: node bench/rigor/reuse-gen.mjs [--per 12]
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const per = Number(process.argv[process.argv.indexOf('--per') + 1]) || 12;
const BASE = '/Users/ebedoya/Projects/Gym Suit'; const PROJECTS = ['gym-app', 'bridge-gym', 'vidar-app'];
const git = (cwd, ...a) => { try { return execFileSync('git', a, { cwd, encoding: 'utf8', maxBuffer: 256 << 20, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return ''; } };
const rng = (a) => () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const CODE = /\.(tsx?|jsx?|mjs)$/; const TEST = /(\.|\/)(spec|test)\.|(^|\/)(tests?|__tests__|scripts|migrations)\//i;
const EXT = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '/index.ts', '/index.tsx', '/index.js'];

const cases = [];
for (const proj of PROJECTS) {
  const repo = join(BASE, proj); const r = rng(11 + proj.length);
  const head = new Set(git(repo, 'ls-files').split('\n').filter(Boolean));
  const resolveSpec = (spec, from) => {
    const bases = spec.startsWith('@/') ? [`src/${spec.slice(2)}`, spec.slice(2)] : spec.startsWith('.') ? [posix.normalize(posix.join(posix.dirname(from), spec))] : [];
    for (const b of bases) for (const e of EXT) if (head.has(b + e) && CODE.test(b + e)) return b + e;
    return null;
  };
  // cuántos archivos importan cada módulo: los ubicuos (cn, tipos base) no cuentan como "reutilización"
  const counts = new Map(); const codeFiles = [...head].filter((f) => CODE.test(f) && !TEST.test(f));
  for (const f of codeFiles) { let t; try { t = readFileSync(join(repo, f), 'utf8'); } catch { continue; } const seen = new Set(); for (const m of t.matchAll(/from\s+['"]([^'"]+)['"]/g)) { const x = resolveSpec(m[1], f); if (x && !seen.has(x)) { seen.add(x); counts.set(x, (counts.get(x) || 0) + 1); } } }
  const ubiq = (f) => (counts.get(f) || 0) / codeFiles.length > 0.06;
  const pool = []; const seen = new Set();
  for (const l of git(repo, 'log', '--no-merges', '--format=%H%x09%P%x09%s', '-n', '700').split('\n').filter(Boolean)) {
    const [h, parents, subj] = l.split('\t'); const parent = (parents || '').split(' ')[0]; if (!parent) continue;
    const q = (subj || '').replace(/^\w+(\([^)]*\))?!?:\s*/, '').trim();
    if (q.split(/\s+/).length < 4 || /^(merge|release|bump|version|wip)/i.test(q) || seen.has(q)) continue;
    const added = new Set(git(repo, 'diff-tree', '--no-commit-id', '--name-only', '-r', '--diff-filter=A', h).split('\n').filter(Boolean));
    const diff = git(repo, 'show', '--no-color', '-U0', '--diff-filter=AM', '--format=', h);
    const truth = new Set(); let file = null;
    for (const ln of diff.split('\n')) {
      const f = ln.match(/^\+\+\+ b\/(.+)$/); if (f) { file = f[1]; continue; }
      if (!file || !CODE.test(file) || TEST.test(file) || !ln.startsWith('+')) continue;
      const m = ln.match(/from\s+['"]([^'"]+)['"]/); if (!m) continue;
      const t = resolveSpec(m[1], file);
      if (t && t !== file && !added.has(t) && !ubiq(t) && git(repo, 'cat-file', '-e', `${parent}:${t}`) === '' && git(repo, 'ls-tree', parent, '--', t).trim()) truth.add(t);
    }
    if (truth.size >= 1 && truth.size <= 4) { seen.add(q); pool.push({ project: proj, repo, graphProject: `bench-${proj}`, kind: 'reuse', query: q, truth: [...truth], commit: h.slice(0, 8) }); }
  }
  const sh = [...pool]; for (let i = sh.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [sh[i], sh[j]] = [sh[j], sh[i]]; }
  cases.push(...sh.slice(0, per));
  console.error(proj, 'candidatos', pool.length);
}
cases.forEach((c, i) => { c.id = `${c.project}:reuse:${i}`; });
writeFileSync(join(here, 'cases-reuse.json'), JSON.stringify({ generated: new Date().toISOString().slice(0, 10), cases }, null, 1));
console.log(JSON.stringify({ total: cases.length, truthAvg: +(cases.reduce((s, c) => s + c.truth.length, 0) / cases.length).toFixed(2) }));
