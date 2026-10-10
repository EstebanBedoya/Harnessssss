import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { cypher, projectFor, search, snippet } from './graph.mjs';
import { deleteRows, readRows, upsertRows } from './toonfile.mjs';

// Caché de las respuestas de Haiku (las caras): una fila por candidato, válida mientras los archivos citados no cambien.
// HARNESS_REUSE_DIR lo saca del repo (pruebas, o proyectos que no quieren .harness/reuse).
const sha8 = (t) => createHash('sha1').update(t).digest('hex').slice(0, 8);
export const fileHash = (root, p) => { try { return sha8(readFileSync(join(root, p))); } catch { return ''; } };
const cacheDir = (root) => (process.env.HARNESS_REUSE_DIR ? join(process.env.HARNESS_REUSE_DIR, sha8(resolve(root))) : join(root, '.harness', 'reuse'));
const normalize = (t) => String(t).trim().toLowerCase().replace(/\s+/g, ' ');
const TTL = 7 * 24 * 3600 * 1000; const TTL_NEW = 24 * 3600 * 1000;
const STOP = new Set('the and for with that this from into where when what how does which who why are was were has have not you your por para que con una uno unos unas los las del como donde cual cuales esta este estos estas son sus ser hay sin sobre entre desde hasta cuando quien porque'.split(' '));
// Palabras clave de una frase: identificadores sin palabras vacías, y las partes de los camelCase / snake_case.
export function keywords(q) {
  const out = [];
  for (const w of String(q).match(/[A-Za-z_$][\w$./-]{2,}/g) || []) {
    if (STOP.has(w.toLowerCase())) continue;
    out.push(w);
    const parts = w.split(/(?<=[a-z0-9])(?=[A-Z])|[_-]/).filter((x) => x.length > 3 && !STOP.has(x.toLowerCase()));
    if (parts.length > 1 && !/^[a-z]+$/.test(w)) out.push(...parts);
  }
  return [...new Set(out)].slice(0, 6);
}
function readDeep(root, key) {
  const rows = readRows(cacheDir(root), 'deep').filter((r) => r.key === key);
  if (!rows.length) return null;
  const age = Date.now() - Date.parse(rows[0].ts);
  const real = rows.filter((r) => r.path);
  if (age > (real.length ? TTL : TTL_NEW)) return null;
  for (const r of real) if (fileHash(root, r.path) !== r.hash) return null; // un archivo citado cambió: la respuesta ya no vale
  return real.length ? real : [];
}
function writeDeep(root, key, intent, rows, usd) {
  const ts = new Date().toISOString(); const dir = cacheDir(root);
  deleteRows(dir, 'deep', (r) => r.key === key);
  const base = { key, intent, ts, usd };
  upsertRows(dir, 'deep', rows.length ? rows.map((r) => ({ ...base, verdict: r.verdict, name: r.name, path: r.path, line: r.line, why: r.why, hash: r.hash })) : [{ ...base, verdict: 'new', name: '', path: '', line: '', why: '', hash: '' }], (r) => `${r.key}>${r.name}>${r.path}>${r.verdict}`);
}

// Reutilización: antes de escribir código, ¿ya existe algo que sirva? Y después: lo que se escribió, ¿duplica algo existente?
const NOT_CODE = /(^|\/)(tests?|__tests__|migrations|scripts|\.storybook)\/|\.(spec|test|stories)\.|\.d\.ts$/;
const HTTP = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const KINDS = new Set(['Function', 'Method', 'Class', 'Interface', 'Enum', 'Type']);
const JS = /\.(tsx?|jsx?|mjs|cjs)$/;
const q = (s) => JSON.stringify(String(s)); // comillas dobles de Cypher
const KW = new Set('break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof let new null return super switch this throw true try typeof undefined var void while with yield async await of from as type interface implements public private protected readonly static get set'.split(' '));
const GLOBALS = new Set('Number Math JSON Object Array Promise Date String Boolean Intl Map Set Error RegExp Symbol console process'.split(' '));

function usedByMap(project, qns) {
  if (!qns.length) return new Map();
  const r = cypher(project, `MATCH (n)<-[r:CALLS|USAGE|IMPORTS]-(m) WHERE n.qualified_name IN [${qns.map(q).join(',')}] RETURN n.qualified_name AS q, count(r) AS c`);
  return new Map((r?.rows || []).map(([a, c]) => [a, Number(c)]));
}
function similarMap(project, qns) {
  if (!qns.length) return new Map();
  const r = cypher(project, `MATCH (a)-[r:SIMILAR_TO]-(b) WHERE a.qualified_name IN [${qns.map(q).join(',')}] RETURN a.qualified_name AS a, b.qualified_name AS b, r.jaccard AS j`);
  const m = new Map();
  for (const [a, b, j] of r?.rows || []) { if (!m.has(a)) m.set(a, []); m.get(a).push(`${b.split('.').slice(-1)[0]} (${b.replace(/^[^.]+\./, '').split('.').slice(0, -1).join('/')}, j=${j})`); }
  return m;
}

// Capa 1 (sin modelo): candidatos existentes por texto sobre el grafo, con firma y cuántos lo usan.
export function reuseSearch(root, intent, { limit = 8 } = {}) {
  const g = projectFor(root);
  if (!g) {
    return { graph: false, note: 'sin índice del grafo para este repo: `harness explore --reindex` lo construye (hace falta para reutilizar)', rows: [] };
  }
  const queries = [intent, keywords(intent).join(' ')].filter((x, i, a) => x && a.indexOf(x) === i);
  const seen = new Map();
  for (const qq of queries) for (const r of search(g.name, { query: qq, limit: 60 })?.results || []) if (!seen.has(r.qualified_name)) seen.set(r.qualified_name, r);
  const cands = [...seen.values()].filter((r) => KINDS.has(r.label) && r.file_path && !NOT_CODE.test(r.file_path) && !HTTP.has(r.name)).slice(0, 14);
  const used = usedByMap(g.name, cands.map((c) => c.qualified_name));
  const sim = similarMap(g.name, cands.map((c) => c.qualified_name));
  const maxAbs = Math.max(1e-9, ...cands.map((c) => Math.abs(c.rank || 0)));
  const rows = [];
  for (const c of cands) {
    const sn = snippet(g.name, c.qualified_name);
    if (!sn || !String(sn.source || '').includes(c.name)) continue; // el índice puede estar viejo: si el símbolo ya no está ahí, no se ofrece
    const usedBy = used.get(c.qualified_name) || 0;
    const score = Math.abs(c.rank || 0) / maxAbs + 0.12 * Math.log1p(usedBy) + (sn.is_exported ? 0.08 : 0);
    rows.push({ score, name: c.name, kind: c.label, path: c.file_path.replace(`${root}/`, ''), line: c.start_line, endLine: c.end_line, signature: `${c.name}${sn.signature || ''}${sn.return_type || ''}`.slice(0, 140), usedBy, exported: !!sn.is_exported, similar: (sim.get(c.qualified_name) || []).slice(0, 2).join('; '), qn: c.qualified_name }); // texto plano: así TOON lo imprime como tabla
  }
  rows.sort((a, b) => b.score - a.score);
  return { graph: true, incomplete: g.incomplete, ...(g.incomplete ? { note: 'el índice parece incompleto (modo reducido): `harness explore --reindex` lo reconstruye en modo full' } : {}), rows: rows.slice(0, limit).map(({ score, qn, ...r }) => r) };
}

// Capa 2: Haiku decide qué se reutiliza tal cual, qué hay que extender y si de verdad no existe nada.
function deepReuse(root, intent, seed) {
  const bin = process.env.HARNESS_EXPLORE_CLAUDE || 'claude';
  const list = seed.rows.slice(0, 10).map((r) => `${r.name || '?'} ${r.path}:${r.line}${r.signature ? ` ${r.signature}` : ''}${r.usedBy ? ` (used by ${r.usedBy})` : ''}`).join('\n');
  const prompt = [
    `A developer is about to implement: ${intent}`,
    'Decide what ALREADY exists in this repository (functions, hooks, components, utilities, types) that can be reused or extended instead of writing new code.',
    list ? `Candidates from a code graph (may be wrong or irrelevant):\n${list}` : 'A code graph found no candidates.',
    'Verify with Read/Grep/Glob, at most 8 tool calls. Look for the same behavior under different names (the code may be in English, the task in Spanish).',
    'Reply with ONLY lines: verdict|name|path|line|why   (verdict: reuse = use as is, extend = needs a small change, new = nothing fitting exists, then leave name, path and line empty; why ≤12 words; at most 8 lines).',
  ].join('\n');
  const args = ['-p', prompt, '--model', 'claude-haiku-5-5', '--output-format', 'json', '--no-session-persistence', '--tools', 'Read,Grep,Glob', '--allowedTools', 'Read,Grep,Glob', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--disable-slash-commands', '--setting-sources', ''];
  const r = spawnSync(bin, args, { cwd: root, encoding: 'utf8', maxBuffer: 32 << 20, timeout: 180000 });
  if (r.error || r.status !== 0) return { error: (r.error?.message || r.stderr || `exit ${r.status}`).toString().slice(0, 300) };
  let j; try { j = JSON.parse(r.stdout); } catch { return { error: 'respuesta no es JSON' }; }
  if (Array.isArray(j)) j = j.find((x) => x.type === 'result') || {};
  if (j.is_error) return { error: String(j.result || 'error del modelo').slice(0, 200) };
  const rows = []; let newOnly = false;
  for (const ln of String(j.result || '').split('\n')) {
    const m = ln.trim().match(/^`?(reuse|extend|new)\|([^|]*)\|([^|]*)\|(\d*)\|(.*?)`?$/);
    if (!m) continue;
    if (m[1] === 'new') { newOnly = true; continue; }
    const p = m[3].trim();
    if (!p || !existsSync(join(root, p)) || rows.some((x) => x.path === p && x.name === m[2].trim())) continue; // una ruta inventada no entra
    rows.push({ name: m[2].trim(), kind: '', path: p, line: m[4], verdict: m[1], why: m[5].trim().slice(0, 100), hash: fileHash(root, p) });
  }
  return { rows: rows.slice(0, 8), newOnly, usd: j.total_cost_usd != null ? String(Number(j.total_cost_usd).toFixed(6)) : '' };
}

export function exploreReuse(root, intent, { deep = false, fresh = false } = {}) {
  const key = normalize(intent);
  const done = (res, extra) => ({ intent, hit: !!extra.hit, source: extra.source, ...(extra.usd ? { usd: extra.usd } : {}), ...(res.note ? { note: res.note } : {}), ...(res.advice ? { advice: res.advice } : {}), rows: res.rows.map(({ hash, ...r }) => r) });
  if (!deep) {
    const r = reuseSearch(root, intent);
    return done({ ...r, advice: r.rows.length ? 'Read the best candidates before writing anything new: import or extend what fits. If you still write new code, say why in your DONE line.' : r.graph ? 'No candidates found by text; if the task is described in other words than the code uses, repeat with --deep.' : '' }, { source: r.graph ? 'graph' : 'none' });
  }
  const cached = fresh ? null : readDeep(root, key);
  if (cached) return done({ rows: cached.map((r) => ({ name: r.name, kind: '', path: r.path, line: r.line, verdict: r.verdict, why: r.why })), advice: cached.length ? '' : 'Haiku found nothing reusable: writing new code is justified.' }, { hit: true, source: 'model' });
  const seed = reuseSearch(root, intent);
  const d = deepReuse(root, intent, seed);
  if (d.error) return done({ ...seed, note: `deep falló (${d.error}); se devuelven los candidatos del grafo` }, { source: seed.graph ? 'graph' : 'none' });
  writeDeep(root, key, intent, d.rows, d.usd);
  return done({ rows: d.rows, advice: d.newOnly && !d.rows.length ? 'Haiku found nothing reusable: writing new code is justified.' : '' }, { source: 'model', usd: d.usd });
}

// ---------- reuse-check: lo escrito en el diff contra lo que ya existía ----------
function tokenize(src) {
  const re = /\/\/[^\n]*|\/\*[\s\S]*?\*\/|`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|\d+(?:\.\d+)?|[A-Za-z_$][\w$]*|=>|===|!==|\?\?|\?\.|\.\.\.|[^\s\w]/g;
  const out = []; let prev = '';
  for (const t of src.match(re) || []) {
    if (t.startsWith('//') || t.startsWith('/*')) continue;
    let n;
    if (/^[`"']/.test(t)) n = 'S'; else if (/^\d/.test(t)) n = 'N';
    else if (/^[A-Za-z_$]/.test(t)) n = KW.has(t) || GLOBALS.has(t) || prev === '.' || prev === '?.' ? t : 'I'; // los nombres locales no cuentan: un renombrado no oculta un duplicado
    else n = t;
    out.push(n); prev = t;
  }
  return out;
}
const shingles = (toks, k = 4) => { const s = new Set(); for (let i = 0; i + k <= toks.length; i++) s.add(toks.slice(i, i + k).join(' ')); return s; };
export const jaccard = (a, b) => { if (!a.size || !b.size) return 0; let i = 0; for (const x of a) if (b.has(x)) i++; return i / (a.size + b.size - i); };
export const similarity = (srcA, srcB) => jaccard(shingles(tokenize(srcA)), shingles(tokenize(srcB)));

const DECL = [
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=>]+)?=>/,
  /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
];
// Declaraciones de un archivo con su cuerpo (llaves balanceadas; sin parser, vale para TS/JS "normal").
export function declarations(text) {
  const lines = text.split('\n'); const out = [];
  for (let i = 0; i < lines.length; i++) {
    let m; for (const re of DECL) if ((m = lines[i].match(re))) break;
    if (!m) continue;
    let depth = 0, opened = false, j = i;
    for (; j < lines.length && j < i + 400; j++) {
      const clean = lines[j].replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g, '');
      for (const ch of clean) { if (ch === '{') { depth++; opened = true; } else if (ch === '}') depth--; }
      if (opened && depth <= 0) break;
      if (!opened && j >= i + 2 && /;\s*$/.test(lines[j])) break; // cuerpo de expresión sin llaves
    }
    out.push({ name: m[1], start: i + 1, end: j + 1, source: lines.slice(i, j + 1).join('\n') });
    i = Math.max(i, j);
  }
  return out;
}

function changedRanges(root, base) {
  const files = new Map();
  const d = spawnSync('git', ['diff', '-U0', '--no-color', '--diff-filter=AM', base, '--'], { cwd: root, encoding: 'utf8', maxBuffer: 256 << 20 }).stdout || '';
  let cur = null;
  for (const ln of d.split('\n')) {
    const f = ln.match(/^\+\+\+ b\/(.+)$/); if (f) { cur = f[1]; files.set(cur, []); continue; }
    const h = ln.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (h && cur) { const n = h[2] === undefined ? 1 : Number(h[2]); if (n > 0) files.get(cur).push([Number(h[1]), Number(h[1]) + n - 1]); }
  }
  for (const f of (spawnSync('git', ['ls-files', '-o', '--exclude-standard'], { cwd: root, encoding: 'utf8' }).stdout || '').split('\n').filter(Boolean)) files.set(f, [[1, 1e9]]);
  return files;
}

export function reuseCheck(root, { base = 'HEAD', limit = 5, minJaccard = 0.35 } = {}) {
  const g = projectFor(root);
  if (!g) return { graph: false, note: 'reuse-check necesita el índice del grafo: `harness explore --reindex`', findings: [] };
  const findings = []; let scanned = 0;
  for (const [file, ranges] of changedRanges(root, base)) {
    if (!JS.test(file) || NOT_CODE.test(file) || !existsSync(join(root, file))) continue;
    const text = readFileSync(join(root, file), 'utf8');
    for (const d of declarations(text)) {
      if (!ranges.some(([a, b]) => d.start >= a && d.start <= b)) continue; // solo lo que el diff escribió
      if (d.end - d.start < 3 && d.source.length < 120) continue; // funciones diminutas: ruido
      scanned++;
      const mine = shingles(tokenize(d.source));
      const words = d.name.split(/(?=[A-Z])|[_-]/).filter((w) => w.length > 2);
      const calls = [...new Set((d.source.match(/(?:\.|\b)([A-Za-z_$][\w$]{3,})\s*\(/g) || []).map((x) => x.replace(/[.\s(]/g, '')))].filter((x) => !KW.has(x)).slice(0, 8);
      const res = search(g.name, { query: [...words, ...calls].join(' '), limit: 40 })?.results || [];
      const cands = res.filter((r) => KINDS.has(r.label) && r.file_path && !NOT_CODE.test(r.file_path) && !(r.file_path.endsWith(file) && Math.abs(r.start_line - d.start) < 3)).slice(0, 15);
      const used = usedByMap(g.name, cands.map((c) => c.qualified_name));
      const matches = [];
      for (const c of cands) {
        const sn = snippet(g.name, c.qualified_name); if (!sn?.source) continue;
        const j = jaccard(mine, shingles(tokenize(sn.source)));
        if (j >= minJaccard) matches.push({ name: c.name, path: c.file_path.replace(`${root}/`, ''), line: c.start_line, jaccard: +j.toFixed(2), usedBy: used.get(c.qualified_name) || 0 });
      }
      matches.sort((a, b) => b.jaccard - a.jaccard);
      if (matches.length) findings.push({ symbol: d.name, path: file, line: d.start, verdict: matches[0].jaccard >= 0.6 ? 'duplicate' : 'similar', matches: matches.slice(0, limit) });
    }
  }
  findings.sort((a, b) => b.matches[0].jaccard - a.matches[0].jaccard);
  return { graph: true, base, scanned, findings, ...(g.incomplete ? { note: 'el índice parece incompleto: `harness explore --reindex`' } : {}) };
}
