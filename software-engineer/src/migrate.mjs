import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

// Detección y migración de harnesses anteriores (16.2). Nunca borra ni mueve: adopta, registra, adapta o copia.

const first = (root, cands) => cands.find((c) => existsSync(join(root, c)));
const NEW_AGENTS = ['planner.md', 'executor.md', 'reviewer.md', 'explore.md', 'designer.md'];

// Títulos de un markdown con su línea: punteros para el AGENTS.md (el detalle se lee bajo demanda).
export function headings(file, max = 14) {
  return readFileSync(file, 'utf8').split('\n')
    .map((l, i) => ({ l, n: i + 1 })).filter((x) => /^#{1,2}\s+\S/.test(x.l)).slice(0, max)
    .map((x) => {
      const title = x.l.replace(/^#+\s+/, '').trim();
      // Una sección que describe el flujo de un harness anterior puede chocar con el nuevo: se marca para decidir.
      return { title, line: x.n, ...(/harness|\bsdd\b|flujo|workflow|orquestad/i.test(title) ? { flow: true } : {}) };
    });
}

export function detectLegacy(root) {
  const items = []; const conv = {};
  const add = (kind, path, action, extra = {}) => items.push({ kind, path, action, ...extra });

  const guide = first(root, ['CLAUDE.md', 'AGENTS.md']);
  if (guide) add('guide', guide, 'adapt', { headings: headings(join(root, guide)) });
  if (existsSync(join(root, 'CLAUDE.md')) && existsSync(join(root, 'AGENTS.md'))) add('guide', 'AGENTS.md', 'adapt', { headings: headings(join(root, 'AGENTS.md')) });

  if (existsSync(join(root, 'skills-lock.json'))) {
    let locked = [];
    try {
      const lock = JSON.parse(readFileSync(join(root, 'skills-lock.json'), 'utf8'));
      locked = Object.entries(lock.skills || {}).map(([name, v]) => ({ name, source: v.source, sourceType: v.sourceType, hash: v.computedHash }));
    } catch { /* lock ilegible: se registra sin entradas */ }
    add('skills-lock', 'skills-lock.json', 'adopt', { count: locked.length, locked });
  }
  const specs = first(root, ['Docs/specs', 'docs/specs', 'specs']);
  if (specs) { conv.specs = specs; add('specs', specs, 'respect', { count: readdirSync(join(root, specs)).length }); }
  const decisions = first(root, ['DECISIONS.md', 'Docs/DECISIONS.md', 'docs/decisions']);
  if (decisions) { conv.decisions = decisions; add('decisions', decisions, 'respect'); }
  const ai = first(root, ['AI_USAGE.md', 'Docs/AI_USAGE.md']);
  if (ai) { conv.aiUsage = ai; add('ai-usage', ai, 'respect'); }
  if (existsSync(join(root, 'openspec'))) { conv.openspec = 'openspec'; add('openspec', 'openspec', 'register'); }
  if (existsSync(join(root, '.atl'))) add('atl', '.atl', 'leave', { note: 'índice de skills de gentle-ai; su refresh puede tocar .gitignore' });
  if (existsSync(join(root, 'harness', 'tareas.json'))) add('harness-base', 'harness/tareas.json', 'register', { note: 'esquema sin verificar: no se importa el backlog' });

  const agentsDir = join(root, '.claude', 'agents');
  if (existsSync(agentsDir)) {
    const names = readdirSync(agentsDir).filter((f) => f.endsWith('.md'));
    for (const f of names) add('agent', `.claude/agents/${f}`, NEW_AGENTS.includes(f) ? 'conflict' : 'keep');
  }
  return { items, conventions: conv };
}

// ---------- Historial SDD en Engram: copia (no mueve) a claves harness/{cambio}/{artefacto} ----------

export function runEngram(args, { env = process.env } = {}) {
  const r = spawnSync('engram', args, { encoding: 'utf8', env, maxBuffer: 256 * 1024 * 1024 });
  if (r.error) throw new Error(`engram no disponible: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`engram ${args[0]} falló: ${(r.stderr || r.stdout).trim().split('\n').pop()}`);
  return r.stdout;
}

function exportAll(engram) {
  const dir = mkdtempSync(join(tmpdir(), 'harness-engram-')); // 0700 por defecto; se borra siempre
  try {
    const file = join(dir, 'export.json');
    engram(['export', file]);
    return JSON.parse(readFileSync(file, 'utf8'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const toKey = (k) => k.replace(/^sdd\//, 'harness/');
const mid = (o) => `obs-harness-mig-${createHash('sha1').update(o.sync_id || String(o.id)).digest('hex').slice(0, 16)}`;

// scope: 'all' | 'open' (solo cambios sin archive-report) | 'none'
export function planSdd(project, dump, { scope = 'all' } = {}) {
  const mine = dump.observations.filter((o) => o.project === project);
  const sdd = mine.filter((o) => (o.topic_key || '').startsWith('sdd/'));
  const have = new Set(mine.map((o) => o.topic_key).filter(Boolean));
  const cambios = {};
  for (const o of sdd) {
    const [, cambio, art] = o.topic_key.split('/');
    (cambios[cambio] ??= { artifacts: [], archived: false });
    cambios[cambio].artifacts.push(art);
    if (art === 'archive-report') cambios[cambio].archived = true;
  }
  const selected = sdd.filter((o) => scope === 'all' || (scope === 'open' && !cambios[o.topic_key.split('/')[1]].archived));
  const todo = selected.filter((o) => !have.has(toKey(o.topic_key)));
  return {
    project, scope, found: sdd.length, cambios: Object.keys(cambios).length,
    archived: Object.values(cambios).filter((c) => c.archived).length,
    already: selected.length - todo.length, toCopy: todo.length,
    list: Object.entries(cambios).map(([name, c]) => ({ cambio: name, artifacts: c.artifacts.length, archived: c.archived })),
    _todo: todo,
  };
}

export function buildImport(plan, dump) {
  const sessionIds = new Set(plan._todo.map((o) => o.session_id));
  const observations = plan._todo.map((o) => {
    const { id, ...rest } = o;
    const [, cambio] = o.topic_key.split('/');
    const archived = plan.list.find((c) => c.cambio === cambio)?.archived;
    return {
      ...rest, sync_id: mid(o), topic_key: toKey(o.topic_key),
      content: `${o.content}\n\n_migrated-from: ${o.topic_key} · obs #${id} · ${archived ? 'status: archived' : 'status: open'} · by /harness init_`,
    };
  });
  return { version: dump.version, exported_at: dump.exported_at, sessions: dump.sessions.filter((s) => sessionIds.has(s.id)), observations, prompts: [] };
}

// dry: solo planifica. Copiar escribe en Engram (reversible solo borrando las observaciones nuevas).
export function sdd(project, { scope = 'all', dry = true, engram = runEngram } = {}) {
  if (scope === 'none') return { skipped: true };
  const dump = exportAll(engram);
  const plan = planSdd(project, dump, { scope });
  const { _todo, ...pub } = plan;
  if (dry || plan.toCopy === 0) return { ...pub, copied: 0, dry };
  const dir = mkdtempSync(join(tmpdir(), 'harness-engram-'));
  try {
    const f = join(dir, 'import.json');
    writeFileSync(f, JSON.stringify(buildImport(plan, dump)));
    engram(['import', f]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  return { ...pub, copied: plan.toCopy, dry: false };
}

// ---------- Informe ----------

export function diffText(a, b, max = 60) {
  const r = spawnSync('diff', ['-u', a, b], { encoding: 'utf8' });
  return r.stdout.split('\n').slice(0, max).join('\n');
}

export function reportMd(name, legacy, sddResult, extra = {}) {
  const L = [`# Harness migration — ${name}`, '', 'Nothing was deleted or moved. Originals are untouched.', '', '## Found', ''];
  const act = { adapt: 'adapted (proposal, original intact)', adopt: 'adopted into the profile', respect: 'registered as a project convention', register: 'registered only', leave: 'left as is', keep: 'kept', conflict: 'kept, **conflicts** with a new agent of the same name (merge by hand)' };
  for (const i of legacy.items) L.push(`- \`${i.path}\` (${i.kind}) → ${act[i.action]}${i.count !== undefined ? `, ${i.count} entries` : ''}${i.note ? ` — ${i.note}` : ''}`);
  const flows = legacy.items.filter((i) => i.kind === 'guide').flatMap((i) => (i.headings || []).filter((h) => h.flow).map((h) => `\`${i.path}\` §${h.title} (line ${h.line})`));
  if (flows.length) L.push('', '## Needs your decision', '', 'These sections describe a previous workflow and may conflict with the new harness flow (keep / replace / merge):', ...flows.map((f) => `- ${f}`));
  if (!legacy.items.length) L.push('- no previous harness traces');
  L.push('', '## Engram history (sdd → harness)', '');
  if (!sddResult || sddResult.skipped) L.push('- not requested');
  else if (sddResult.error) L.push(`- not migrated: ${sddResult.error}`);
  else {
    L.push(`- project \`${sddResult.project}\`: ${sddResult.found} observations in ${sddResult.cambios} changes (${sddResult.archived} archived), scope \`${sddResult.scope}\``);
    L.push(`- copied now: ${sddResult.copied}; already there (skipped): ${sddResult.already}; originals untouched`);
  }
  if (extra.agentsDiff) L.push('', '## AGENTS.md proposal vs existing guide (first lines)', '', '```diff', extra.agentsDiff, '```');
  return `${L.join('\n')}\n`;
}
