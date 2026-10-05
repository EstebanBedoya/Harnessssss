import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const short = (t, n = 60) => (t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t);
const has = (root, f) => existsSync(join(root, f));
const json = (root, f) => { try { return JSON.parse(readFileSync(join(root, f), 'utf8')); } catch { return null; } };

// Detección por script, siempre con evidencia (archivo y qué dice). El LLM interpreta el resumen (5.2).
export function detect(root) {
  const ev = [];
  const add = (file, what) => ev.push({ file, what });
  const stack = { languages: [], frameworks: [], pm: null, commands: {} };

  const pkg = json(root, 'package.json');
  if (pkg) {
    stack.languages.push('javascript/typescript'); add('package.json', 'proyecto Node');
    const pm = has(root, 'pnpm-lock.yaml') ? 'pnpm' : has(root, 'yarn.lock') ? 'yarn' : has(root, 'bun.lockb') ? 'bun' : 'npm';
    stack.pm = pm; add(pm === 'npm' ? 'package.json' : `${pm} lockfile`, `gestor: ${pm}`);
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const [dep, name] of [['next', 'next'], ['react', 'react'], ['vue', 'vue'], ['@angular/core', 'angular'], ['express', 'express'],
      ['@nestjs/core', 'nestjs'], ['prisma', 'prisma'], ['@prisma/client', 'prisma'], ['drizzle-orm', 'drizzle'], ['@supabase/supabase-js', 'supabase']]) {
      if (deps[dep] && !stack.frameworks.includes(name)) { stack.frameworks.push(name); add('package.json', `dependencia ${dep}`); }
    }
    for (const s of ['typecheck', 'lint', 'test', 'build']) {
      const real = pkg.scripts?.[s];
      if (real) { stack.commands[s] = pm === 'npm' ? `npm run ${s}` : `${pm} ${s}`; if (s === 'test' && pm === 'npm') stack.commands[s] = 'npm test'; add('package.json', `script ${s}: ${real}`); }
    }
  }
  if (has(root, 'pyproject.toml')) { stack.languages.push('python'); add('pyproject.toml', 'proyecto Python'); }
  if (has(root, 'go.mod')) { stack.languages.push('go'); add('go.mod', 'proyecto Go'); stack.commands.test ??= 'go test ./...'; }
  if (has(root, 'Cargo.toml')) { stack.languages.push('rust'); add('Cargo.toml', 'proyecto Rust'); stack.commands.test ??= 'cargo test'; }
  if (has(root, 'pom.xml')) { stack.languages.push('java'); add('pom.xml', 'proyecto Java (Maven)'); }
  for (const f of ['Dockerfile', 'docker-compose.yml', 'compose.yaml']) if (has(root, f)) add(f, 'contenedores');
  if (has(root, '.github/workflows')) add('.github/workflows', 'CI en GitHub Actions');

  const git = { isRepo: false, branches: [] };
  const g = spawnSync('git', ['branch', '--format=%(refname:short)'], { cwd: root, encoding: 'utf8' });
  if (g.status === 0) { git.isRepo = true; git.branches = g.stdout.split('\n').filter(Boolean); }
  return { stack, git, evidence: ev };
}

const dirsThatExist = (root, candidates) => candidates.filter((d) => has(root, d.replace(/\/\*\*.*$/, '')));

// Perfil borrador. El humano confirma tiers y gate: esto solo propone.
export function proposeProfile(root, d = detect(root)) {
  const c = d.stack.commands;
  const gateParts = ['typecheck', 'lint', 'test', 'build'].filter((k) => c[k]).map((k) => c[k]);
  const missing = ['typecheck', 'lint', 'test'].filter((k) => !c[k]);
  const integration = d.git.branches.includes('develop') ? 'develop' : d.git.branches.includes('main') ? 'main' : d.git.branches[0] || 'main';
  const deploy = d.git.branches.includes('main') ? 'main' : integration;
  return {
    profile: {
      version: 1,
      stack: d.stack,
      gate: { cmd: gateParts.length ? gateParts.join(' && ') : null, timeoutMs: 600000, missing },
      git: { integration, deploy },
      tiers: {
        t2: dirsThatExist(root, ['prisma/**', 'supabase/migrations/**', 'migrations/**', 'src/**/auth/**', 'Dockerfile', 'docker-compose*.yml', '.github/**']),
        t1: [],
        ui: dirsThatExist(root, ['src/app/**', 'src/components/**', 'components/**', 'pages/**', 'app/**', 'styles/**', 'public/**']),
      },
    },
    evidence: d.evidence,
    notes: [
      ...(missing.length ? [`el gate no cubre: ${missing.join(', ')}`] : []),
      ...(!gateParts.length ? ['no se detectó ningún comando de verificación: el gate queda sin configurar y bloquea'] : []),
      'los tiers T2 son una sugerencia por carpetas: confírmalos antes de usarlos',
    ],
  };
}

// ---------- Segunda parte del init: AGENTS.md, agentes instalados y recomendaciones ----------

export const CORE_AGENTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'agents');

// AGENTS.md corto con punteros (principios 5 y 8: ≤ 80 líneas). El detalle se lee bajo demanda.
export function buildAgentsMd(name, p, legacy = null) {
  const c = p.stack.commands;
  const cmds = Object.entries(c).map(([k, v]) => `- ${k}: \`${v}\``);
  const L = [
    `# ${name} — agent guide`,
    '',
    'Short on purpose: read what you need, ask for the rest. Generated by `/harness init`; edit freely, `/harness init` will not overwrite it.',
    '',
    '## Stack',
    `- Languages: ${p.stack.languages.join(', ') || 'unknown'}`,
    `- Frameworks: ${p.stack.frameworks.join(', ') || 'none detected'}`,
    ...(p.stack.pm ? [`- Package manager: ${p.stack.pm}`] : []),
    '',
    '## Commands',
    ...(cmds.length ? cmds : ['- none detected']),
    `- **Gate** (single verification command): ${p.gate.cmd ? `\`${p.gate.cmd}\`` : '_not configured: add `gate.cmd` in `.harness/profile.json`_'}`,
    ...(p.gate.missing?.length ? [`- Gate does not cover: ${p.gate.missing.join(', ')}`] : []),
    '',
    '## Git',
    `- Integration branch: \`${p.git.integration}\`; deploy branch: \`${p.git.deploy}\`.`,
    '- Conventional Commits, no AI attribution. One task = one category = one branch.',
    '- Stage explicit paths (never `git add -A`). Agents commit; **only the user pushes**. No merge, rebase, tags or `reset --hard`.',
    '',
    '## Risk tiers',
    '- T2 paths (need explicit approval, independent review):',
    ...(p.tiers.t2.length ? p.tiers.t2.map((x) => `  - \`${x}\``) : ['  - none set yet: confirm in `.harness/profile.json`']),
    ...(p.tiers.ui.length ? ['- UI paths (the designer runs before and after):', ...p.tiers.ui.map((x) => `  - \`${x}\``)] : []),
    '',
    ...legacySection(legacy),
    '## Harness',
    '- State and profile: `.harness/profile.json`, `.harness/backlog.json`; metrics in `.harness/metrics/*.toon`.',
    '- Next step of a task: `harness next <id>`. Only the script marks a task done.',
    '- Context between agents travels as Engram topic keys `harness/<task>/{plan,design,impl-report,review}`, never pasted.',
    '- Roles: **planner** (Claude Opus, the session you talk to) and **reviewer / QA** (Claude Sonnet 5.5, a subagent); **executor**, **designer** (Pencil) and **explore** (read-only) run in Codex via `harness exec --role <role>`. `harness next <id>` says which one to launch; the executor never falls back to Claude on its own.',
    '- Agent prompts live in `.claude/agents/` (Claude Code) and `.harness/prompts/` (Codex, generated). A single role can be called directly for small work.',
    '- Use only the skills listed in `profile.skills`.',
  ];
  return `${L.join('\n')}\n`;
}

// Reglas previas del proyecto como punteros (título y línea), no copiadas: el detalle se lee bajo demanda (principio 5).
function legacySection(legacy) {
  if (!legacy) return [];
  const out = [];
  const guides = legacy.items.filter((i) => i.kind === 'guide' && i.headings?.length);
  if (guides.length) {
    out.push('## Existing project rules (read on demand)');
    for (const g of guides) for (const h of g.headings) out.push(`- \`${g.path}\` §${short(h.title, 90)} (line ${h.line})${h.flow ? ' ⚠ previous workflow: may conflict with the harness flow' : ''}`);
    out.push('');
  }
  const conv = Object.entries(legacy.conventions || {});
  if (conv.length) {
    out.push('## Project conventions');
    for (const [k, v] of conv) out.push(`- ${k}: \`${v}\``);
    out.push('');
  }
  return out;
}

// Recomienda y no instala (5.3, 5.4). Solo propone skills que ya existen en la máquina o en el proyecto.
const SKILL_BY_FRAMEWORK = { next: ['nextjs', 'shadcn-ui'], react: ['shadcn-ui'] };
const MCP_BY_SIGNAL = {
  supabase: { mcp: 'Supabase MCP', alternative: 'CLI `supabase` / `psql` (adds no schemas to context)' },
  next: { mcp: 'Context7 (library docs)', alternative: 'WebFetch of the official docs' },
  react: { mcp: 'Context7 (library docs)', alternative: 'WebFetch of the official docs' },
  prisma: { mcp: 'Context7 (library docs)', alternative: '`prisma` CLI and the official docs' },
};
export function recommend(root, d, home = homedir()) {
  const skillExists = (n) => has(root, `.claude/skills/${n}`) || existsSync(join(home, '.claude', 'skills', n));
  const core = ['commit-work', 'release-pr'].filter(skillExists);
  const project = [...new Set(d.stack.frameworks.flatMap((f) => SKILL_BY_FRAMEWORK[f] || []))].filter(skillExists);
  const seen = new Set();
  const mcps = d.stack.frameworks.filter((f) => MCP_BY_SIGNAL[f]).map((f) => ({ because: `${f} detected`, ...MCP_BY_SIGNAL[f] }))
    .filter((m) => !seen.has(m.mcp) && seen.add(m.mcp));
  return { skills: { core, project }, mcps, note: 'recommendation only: nothing is installed; each MCP costs tokens at every session start' };
}

// Si ya hay AGENTS.md o CLAUDE.md no se pisan: la propuesta queda aparte para que la revises (5.2).
export function writeAgentsMd(root, text) {
  const existing = ['AGENTS.md', 'CLAUDE.md'].find((f) => has(root, f));
  if (existing) {
    const proposed = join(root, '.harness', 'AGENTS.proposed.md');
    mkdirSync(dirname(proposed), { recursive: true });
    writeFileSync(proposed, text);
    return { written: false, reason: `ya existe ${existing}`, proposal: proposed };
  }
  writeFileSync(join(root, 'AGENTS.md'), text);
  return { written: true, file: join(root, 'AGENTS.md') };
}

// ---------- Adaptación de los agentes al proyecto (7.6) ----------

// Reparto de skills por rol según el nombre: BORRADOR heurístico que el humano ajusta en .harness/profile.json (agents.<rol>.skills).
const RE = {
  design: /design|\bux\b|ui-ux|accessib|composition|seo|shadcn|radix|tailwind/i,
  stack: /next|react|typescript|node|prisma|supabase|postgres|zod|tailwind|vue|angular|express|nest|drizzle|python|golang|rust|java/i,
  arch: /patterns|best-practices|architecture|setup|upgrade|postgres|backend/i,
};
export function assignSkills(skills, { ui = false } = {}) {
  const project = skills.project || [];
  const stack = project.filter((n) => RE.stack.test(n) && !RE.design.test(n));
  const design = project.filter((n) => RE.design.test(n));
  const assigned = {
    planner: [...stack.filter((n) => RE.arch.test(n)), ...(skills.core || []).filter((n) => n === 'release-pr')],
    executor: [...stack, ...design.filter((n) => /shadcn|radix|tailwind/i.test(n)), ...(skills.core || []).filter((n) => n === 'commit-work')],
    reviewer: [...stack.filter((n) => /best-practices/.test(n)), ...design.filter((n) => /accessib|seo/i.test(n))],
    designer: ui ? design : [],
    explore: [],
  };
  const used = new Set(Object.values(assigned).flat());
  return { assigned, unassigned: [...project, ...(skills.core || [])].filter((n) => !used.has(n)) };
}

const START_RE = /<!-- harness:project:start[^>]*-->/;
const sha = (t) => createHash('sha1').update(t).digest('hex').slice(0, 8);
const END = '<!-- harness:project:end -->';

// Bloque generado, corto, por rol. Lo que está fuera de los marcadores es del usuario y no se toca.
// bodyHash: huella del cuerpo de la plantilla con que se generó el archivo; permite actualizar el cuerpo solo si nadie lo editó.
export function projectBlock(role, name, profile, bodyHash) {
  const a = profile.agents?.[role]?.skills || [];
  const rules = (profile.rules || []).slice(0, 6);
  const t2 = profile.tiers?.t2 || [];
  const L = [`<!-- harness:project:start${bodyHash ? ` body=${bodyHash}` : ''} -->`, `## Project: ${name} (generated by \`/harness init\`; refresh with \`harness agents sync\`)`];
  const stack = [...(profile.stack?.languages || []), ...(profile.stack?.frameworks || [])];
  if (stack.length) L.push(`- Stack: ${stack.join(', ')}`);
  if (['planner', 'executor', 'reviewer'].includes(role)) L.push(`- Gate: ${profile.gate?.cmd ? `\`${profile.gate.cmd}\`` : 'not configured (set gate.cmd in .harness/profile.json)'}`);
  if (['planner', 'reviewer'].includes(role) && profile.gate?.t2Cmd) L.push(`- T2 gate also runs: \`${profile.gate.t2Cmd}\``);
  if (role === 'planner') L.push(`- Branches: integration \`${profile.git.integration}\`, deploy \`${profile.git.deploy}\``);
  if (['planner', 'executor', 'reviewer'].includes(role) && t2.length) L.push(`- T2 paths (explicit approval, independent review): ${t2.map((x) => `\`${x}\``).join(', ')}`);
  if (['planner', 'designer'].includes(role) && profile.tiers?.ui?.length) L.push(`- UI paths: ${profile.tiers.ui.map((x) => `\`${x}\``).join(', ')}`);
  if (role !== 'explore') {
    const conv = profile.conventions || {};
    const c = Object.entries(conv).map(([k, v]) => `${k}: \`${v}\``);
    if (c.length) L.push(`- Project conventions: ${c.join('; ')}`);
    if (rules.length) L.push(`- Existing project rules (read on demand): ${rules.map((r) => `\`${r.file}\` §${short(r.title)} (l.${r.line})${r.flow ? ' ⚠ previous workflow' : ''}`).join('; ')}`);
    L.push('- Full guide: `AGENTS.md` (or `.harness/AGENTS.proposed.md` until reviewed).');
  }
  L.push(a.length ? `- Skills you may use (only these): ${a.map((s) => `\`${s}\``).join(', ')}` : '- Skills: none assigned; do not invoke skills.');
  L.push(END);
  return L.join('\n');
}

export function renderAgent(template, role, name, profile) {
  const block = projectBlock(role, name, profile, sha(template.trimEnd()));
  return `${template.trimEnd()}\n\n${block}\n`;
}

// Reemplaza solo el bloque generado de un archivo ya renderizado.
const swapBlock = (text, block) => text.replace(new RegExp(`${START_RE.source}[\\s\\S]*?${END}`), () => block);

// Instala o refresca los agentes. Sin `profile` copia la plantilla tal cual (modo básico).
// Con `profile`: archivo igual a la plantilla → es nuestro, se renderiza; con marcadores → solo se refresca el bloque;
// distinto y sin marcadores → editado a mano, se omite salvo --force.
export function installAgents(root, { force = false, srcDir = CORE_AGENTS_DIR, profile = null, name = basename(root) } = {}) {
  const dest = join(root, '.claude', 'agents');
  const done = { installed: [], refreshed: [], unchanged: [], skipped: [], legacy: [], bodyEdited: [] };
  mkdirSync(dest, { recursive: true });
  for (const f of readdirSync(srcDir).filter((x) => x.endsWith('.md'))) {
    const role = f.replace(/\.md$/, '');
    const tpl = readFileSync(join(srcDir, f), 'utf8');
    const dst = join(dest, f);
    const want = profile ? renderAgent(tpl, role, name, profile) : tpl;
    if (!existsSync(dst)) { writeFileSync(dst, want); done.installed.push(f); continue; }
    const cur = readFileSync(dst, 'utf8');
    if (cur === want) { done.unchanged.push(f); continue; }
    if (force) { writeFileSync(dst, want); done.installed.push(f); continue; }
    if (!profile) { done.skipped.push(f); continue; }
    if (cur === tpl) { writeFileSync(dst, want); done.refreshed.push(f); continue; } // copia pura de la plantilla
    const start = cur.match(START_RE);
    if (start && cur.includes(END)) {
      const recorded = start[0].match(/body=([0-9a-f]{8})/)?.[1];
      const outside = cur.slice(0, start.index).trimEnd();
      if (recorded && sha(outside) === recorded) {
        // El cuerpo es el que generamos y nadie lo tocó: se actualiza entero (plantilla nueva y bloque).
        writeFileSync(dst, want); done.refreshed.push(f);
      } else {
        // Cuerpo editado a mano, o archivo de una versión sin huella: solo se refresca el bloque y se conserva lo demás.
        const next = swapBlock(cur, projectBlock(role, name, profile, recorded));
        if (next === cur) done.unchanged.push(f); else { writeFileSync(dst, next); done.refreshed.push(f); }
        if (!recorded) done.legacy.push(f); // el cuerpo no se puede actualizar solo; `agents sync --force` lo reemplaza
        else done.bodyEdited.push(f);
      }
      continue;
    }
    done.skipped.push(f); // editado a mano
  }
  return { dir: dest, ...done };
}

// Informe legible de recomendaciones: skills por agente, lo que no se asignó y MCPs con su razón.
export function recommendationsMd(name, profile, rec, det) {
  const roles = Object.entries(profile.agents || {});
  const L = [`# Harness recommendations — ${name}`, '', 'Draft: skill assignment is by name heuristics. Edit `.harness/profile.json` (`agents.<role>.skills`) and run `harness agents sync`.', '', '## Skills per agent (agents use only these)', ''];
  L.push('| Agent | Skills |', '|---|---|');
  for (const [r, v] of roles) L.push(`| ${r} | ${v.skills.length ? v.skills.map((s) => `\`${s}\``).join(', ') : '—'} |`);
  if (profile.skillsUnassigned?.length) L.push('', `Not assigned to any agent (purpose unclear from the name): ${profile.skillsUnassigned.map((s) => `\`${s}\``).join(', ')}`);
  L.push('', '> Whether Claude Code can restrict skills per subagent at the tool level is **not verified**; today the limit is written in each agent prompt.');
  L.push('', '## MCPs (recommended, not installed)', '');
  if (rec.mcps.length) {
    L.push('| MCP | Because | Alternative without MCP |', '|---|---|---|');
    for (const m of rec.mcps) L.push(`| ${m.mcp} | ${m.because} | ${m.alternative} |`);
    L.push('', 'Each MCP adds its tool names and instructions to **every** session start (measured here: ~9.5k tokens for the enabled set).');
  } else L.push('No MCP recommendations from the detected stack.');
  L.push('', '## Detected, evidence', '');
  for (const e of det.evidence.slice(0, 12)) L.push(`- \`${e.file}\`: ${e.what}`);
  return `${L.join('\n')}\n`;
}

// ---------- Comandos /<rol> (skills que adoptan el rol del agente en la sesión actual) ----------

const GEN = '<!-- harness:generated -->';
export const roleSkill = (role) => `---
name: ${role}
description: "Harness: act as the project's ${role} in this session. Use /${role} <what you want>."
argument-hint: "[what you want to do]"
disable-model-invocation: true
---
${GEN}
Adopt the **${role}** role for this session. First read \`.claude/agents/${role}.md\` and follow it exactly; it is the single source of the role, do not paraphrase it.

Request: $ARGUMENTS

If the request is empty, ask me what I want to do.
`;

// Una skill por rol pedido (profile.slashRoles, por defecto solo el planner: cada skill suma ~80 tokens al arranque de cada sesión).
// Se refresca solo si la generó el harness (marca); una skill del mismo nombre escrita por el usuario no se toca.
export function installRoleSkills(root, profile) {
  const roles = profile?.slashRoles ?? ['planner'];
  const done = { installed: [], unchanged: [], skipped: [] };
  for (const role of roles) {
    const dir = join(root, '.claude', 'skills', role);
    const file = join(dir, 'SKILL.md');
    const want = roleSkill(role);
    if (!existsSync(file)) { mkdirSync(dir, { recursive: true }); writeFileSync(file, want); done.installed.push(`/${role}`); continue; }
    const cur = readFileSync(file, 'utf8');
    if (cur === want) done.unchanged.push(`/${role}`);
    else if (cur.includes(GEN)) { writeFileSync(file, want); done.installed.push(`/${role}`); }
    else done.skipped.push(`/${role}`);
  }
  return done;
}

// ---------- Prompt de rol para agentes que corren en Codex ----------

// Codex no lee `.claude/agents`: el cuerpo del agente (sin el frontmatter de Claude Code) más el bloque del proyecto
// se escribe en `.harness/prompts/<rol>.md` y la tarea le dice a Codex que lo lea. Se pasa una referencia, no el contenido.
export function rolePromptText(role, name, profile, srcDir = CORE_AGENTS_DIR) {
  const tpl = readFileSync(join(srcDir, `${role}.md`), 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '').trim();
  return `${tpl}\n\n${projectBlock(role, name, profile)}\n`;
}

export function writeRolePrompt(root, role, profile, srcDir = CORE_AGENTS_DIR) {
  const dir = join(root, '.harness', 'prompts');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${role}.md`);
  writeFileSync(file, rolePromptText(role, basename(root), profile, srcDir));
  return file;
}
