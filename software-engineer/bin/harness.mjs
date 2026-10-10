#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { cwd } from 'node:process';
import { fileURLToPath } from 'node:url';
import { CATEGORIES } from '../src/defaults.mjs';
import { classify } from '../src/classify.mjs';
import { changedFiles, checkScope, runGate, snapshotDirty } from '../src/gate.mjs';
import { finalAgentMessage, sessionStartedSince } from '../src/codex.mjs';
import { judgeRun, pencilAppRunning } from '../src/verdict.mjs';
import * as herdr from '../src/herdr.mjs';
import { assignSkills, buildAgentsMd, detect, installAgents, installRoleSkills, proposeProfile, recommend, recommendationsMd, writeAgentsMd, writeRolePrompt } from '../src/init.mjs';
import { collect, collectCodex, collectRollup, ensureSchema, transcriptDir, writeGate, writeRun } from '../src/metrics.mjs';
import { taskWindows } from '../src/attribution.mjs';
import { report } from '../src/report.mjs';
import { detectLegacy, diffText, reportMd, sdd } from '../src/migrate.mjs';
import { backlogInfo, bridgePidFile, clearBridgePid, ensureBridge, tick } from '../src/pixel.mjs';
import { route } from '../src/router.mjs';
import { dirs, getProfileValue, loadBacklog, loadProfile, setProfileValue, writeJson } from '../src/store.mjs';
import { addTask, applyEvent, nextStep } from '../src/tasks.mjs';
import { readRows } from '../src/toonfile.mjs';
import { exploreReuse, reuseCheck } from '../src/reuse.mjs';
import { reindex } from '../src/graph.mjs';
import { encode } from '@toon-format/toon';

// Parser mínimo: positionals + --flag valor / --flag.
const argv = process.argv.slice(2);
const pos = []; const flag = {};
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) {
    const k = argv[i].slice(2);
    if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) flag[k] = true; else flag[k] = argv[++i];
  } else pos.push(argv[i]);
}
const root = resolve(flag.root || cwd());
const out = (o) => console.log(JSON.stringify(o, null, 2));
const fail = (m, code = 1) => { console.error(`error: ${m}`); process.exit(code); };
const list = (v) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : undefined);
const [cmd, sub, ...rest] = pos;

const need = (id) => {
  const t = loadBacklog(root).tasks[id];
  if (!t) fail(`tarea desconocida: ${id}`);
  return t;
};

try {
  switch (cmd) {
    case 'init': {
      const det = detect(root);
      const p = proposeProfile(root, det);
      const rec = recommend(root, det);
      const name = basename(root);
      const legacy = detectLegacy(root);
      const lock = legacy.items.find((i) => i.kind === 'skills-lock');
      p.profile.skills = { ...rec.skills, locked: lock?.locked || [] }; // lista blanca: solo estas skills (5.3)
      if (lock) p.profile.skills.project = [...new Set([...rec.skills.project, ...lock.locked.map((x) => x.name)])];
      p.profile.conventions = legacy.conventions;
      p.profile.rules = legacy.items.filter((i) => i.kind === 'guide').flatMap((g) => (g.headings || []).map((h) => ({ file: g.path, ...h })));
      const asg = assignSkills(p.profile.skills, { ui: p.profile.tiers.ui.length > 0 });
      p.profile.agents = Object.fromEntries(Object.entries(asg.assigned).map(([r, skills]) => [r, { skills }]));
      p.profile.skillsUnassigned = asg.unassigned;
      const scope = flag.sdd || 'all';
      const eproject = flag['engram-project'] || name;
      const safeSdd = (dry) => { try { return sdd(eproject, { scope, dry }); } catch (e) { return { error: e.message }; } };
      const d = dirs(root);
      if (!flag.apply) {
        out({
          mode: 'dry-run (usa --apply para escribir)', project: name, ...p, recommend: rec,
          agentSkills: Object.fromEntries(Object.entries(p.profile.agents).map(([r, v]) => [r, v.skills])), skillsUnassigned: asg.unassigned,
          legacy: { items: legacy.items.map(({ headings, locked, ...i }) => i), conventions: legacy.conventions },
          sdd: safeSdd(true),
          would_write: ['.harness/profile.json', '.harness/backlog.json', '.harness/migration.md', '.harness/recommendations.md', 'AGENTS.md (o .harness/AGENTS.proposed.md si ya existe una guía)', '.claude/agents/*.md (5 agentes con un bloque del proyecto; lo editado a mano no se pisa)', `Engram: copia sdd/* → harness/* (--sdd ${scope})`],
        });
        break;
      }
      if (existsSync(d.profile) && !flag.force) fail('ya existe .harness/profile.json; usa --force para reemplazarlo');
      writeJson(d.profile, p.profile);
      if (!existsSync(d.backlog)) writeJson(d.backlog, { tasks: {} });
      const agentsMd = writeAgentsMd(root, buildAgentsMd(name, p.profile, legacy));
      const agents = installAgents(root, { force: !!flag.force, profile: p.profile, name });
      const commands = installRoleSkills(root, p.profile);
      const recFile = join(d.base, 'recommendations.md');
      writeFileSync(recFile, recommendationsMd(name, p.profile, rec, det));
      const sddResult = safeSdd(false);
      const guide = legacy.items.find((i) => i.kind === 'guide');
      const agentsDiff = agentsMd.proposal && guide ? diffText(join(root, guide.path), agentsMd.proposal) : '';
      const report = join(d.base, 'migration.md');
      writeFileSync(report, reportMd(name, legacy, sddResult, { agentsDiff }));
      out({ project: name, written: [d.profile, d.backlog, report, recFile], agentsMd, agents, commands, agentSkills: Object.fromEntries(Object.entries(p.profile.agents).map(([r, v]) => [r, v.skills])), sdd: sddResult, legacyFound: legacy.items.length, recommend: rec, notes: p.notes, committed: false });
      break;
    }
    case 'agents': {
      if (sub !== 'sync') fail('uso: agents sync [--reassign] [--force]');
      const d = dirs(root);
      if (!existsSync(d.profile)) fail('no hay .harness/profile.json: corre primero `harness init --apply`');
      const profile = loadProfile(root);
      const name = basename(root);
      const det = detect(root);
      const legacy = detectLegacy(root);
      // Solo se escribe lo que se calcula (reglas, reparto de skills): nunca el perfil fusionado, o los valores por defecto
      // se congelarían en el archivo del proyecto y taparían las mejoras futuras.
      let changed = false;
      const persist = (key, value) => { setProfileValue(root, key, value); profile[key.split('.')[0]] = value; changed = true; };
      if (!profile.rules) persist('rules', legacy.items.filter((i) => i.kind === 'guide').flatMap((g) => (g.headings || []).map((h) => ({ file: g.path, ...h }))));
      if (!profile.agents || flag.reassign) {
        const asg = assignSkills(profile.skills || { core: [], project: [] }, { ui: (profile.tiers?.ui || []).length > 0 });
        persist('agents', Object.fromEntries(Object.entries(asg.assigned).map(([r, skills]) => [r, { skills }])));
        persist('skillsUnassigned', asg.unassigned);
      }
      const agents = installAgents(root, { force: !!flag.force, profile, name });
      const commands = installRoleSkills(root, profile);
      const recFile = join(d.base, 'recommendations.md');
      writeFileSync(recFile, recommendationsMd(name, profile, recommend(root, det), det));
      // La propuesta de AGENTS.md es un archivo generado: se mantiene al día. Un AGENTS.md o CLAUDE.md real nunca se toca.
      const proposal = join(d.base, 'AGENTS.proposed.md');
      const proposalRefreshed = existsSync(proposal);
      if (proposalRefreshed) writeFileSync(proposal, buildAgentsMd(name, profile, legacy));
      out({ profile: changed ? 'completed and saved' : 'unchanged', agents, commands, agentsProposal: proposalRefreshed ? 'refreshed' : 'none', recommendations: recFile, agentSkills: Object.fromEntries(Object.entries(profile.agents).map(([r, v]) => [r, v.skills])) });
      break;
    }
    case 'pixel': {
      // Puente Herdr → Pixel Agents: muestra a los agentes de Codex en la oficina. Uso: harness pixel bridge [--once] [--interval ms] [--cwd-prefix DIR]
      if (sub !== 'bridge') fail('uso: pixel bridge [--once] [--interval 1500] [--all] [--cwd-prefix DIR] [--project-dir DIR]');
      if (!herdr.inHerdr()) fail('hay que correrlo dentro de Herdr (HERDR_ENV=1)');
      const prefix = flag.all ? null : (typeof flag['cwd-prefix'] === 'string' ? flag['cwd-prefix'] : root);
      const trackedDir = flag['project-dir'] || transcriptDir(root);
      const log = (m) => console.error(`[pixel-bridge ${new Date().toISOString().slice(11, 19)}] ${m}`);
      let state = { prev: new Map(), sig: '' };
      const once = async () => { state = await tick(state, { cwdPrefix: prefix, trackedDir, info: () => backlogInfo(root), log }); return state; };
      if (flag.once) { const s = await once(); out({ servers: s.servers, sent: s.sent }); break; }
      log(`vigilando agentes de Codex en Herdr${prefix ? ` (cwd bajo ${prefix})` : ' (todos)'}; carpeta que vigila Pixel Agents: ${trackedDir}; Ctrl+C para salir`);
      mkdirSync(join(root, '.harness'), { recursive: true });
      writeFileSync(bridgePidFile(root), String(process.pid));
      const bye = () => { clearBridgePid(root); process.exit(0); };
      process.on('SIGINT', bye); process.on('SIGTERM', bye);
      // Se apaga solo: sin servidor de Pixel Agents, o sin agentes de Codex, durante --idle-exit segundos (por defecto 600).
      const idleMs = Number(flag['idle-exit'] || 600) * 1000;
      let lastActive = Date.now();
      for (;;) {
        try { const s = await once(); if (s.servers > 0 && s.prev.size > 0) lastActive = Date.now(); } catch (e) { log(`error: ${e.message}`); }
        if (Date.now() - lastActive > idleMs) { log('sin actividad: me apago'); bye(); }
        await new Promise((r) => setTimeout(r, Number(flag.interval || 1500)));
      }
    }
    case 'categories': out(CATEGORIES); break;
    case 'classify': out(classify(loadProfile(root), sub, list(flag.paths) || [])); break;
    case 'task': {
      const profile = loadProfile(root);
      if (sub === 'add') {
        if (!flag.title || !flag.category) fail('uso: task add <id> --title T --category C [--paths a,b]');
        out(addTask(root, profile, { id: rest[0], title: flag.title, category: flag.category, paths: list(flag.paths) || [] }));
      } else if (sub === 'approve') {
        const t0 = need(rest[0]);
        const baseline = snapshotDirty(root, t0.base);
        out({ ...applyEvent(root, profile, rest[0], 'approve', { by: flag.by, baseline }), baselineFiles: Object.keys(baseline).length });
      }
      else if (sub === 'event') out(applyEvent(root, profile, rest[0], rest[1], { provider: flag.provider }));
      else if (sub === 'list') out(Object.values(loadBacklog(root).tasks).map((t) => ({ id: t.id, category: t.category, tier: t.tier, status: t.status, attempts: t.attempts })));
      else fail('uso: task add|approve|event|list');
      break;
    }
    case 'next': {
      const profile = loadProfile(root);
      out(nextStep(profile, need(sub), { available: list(flag.available) }));
      break;
    }
    case 'route':
      out(route(loadProfile(root), sub, {
        tier: flag.tier || 'T1', attempt: Number(flag.attempt || 0), executorProvider: flag.executor || null, available: list(flag.available),
      }));
      break;
    case 'gate': {
      const profile = loadProfile(root);
      const t = need(sub);
      const r = runGate(root, profile, t);
      let task = t;
      if (t.status === 'gating') task = applyEvent(root, profile, sub, r.pass ? 'gate_pass' : 'gate_fail');
      writeGate(dirs(root).metrics, { task: t.id, ts: new Date().toISOString(), tier: t.tier, attempt: t.attempts, pass: r.pass ? 'pass' : 'fail', reason: r.reason, ms: r.ms, files: r.scope?.files?.length ?? '', ignored: r.scope?.ignored ?? '' });
      out({ pass: r.pass, reason: r.reason, ms: r.ms, tail: r.tail, status: task.status, attempts: task.attempts });
      process.exitCode = r.pass ? 0 : 1;
      break;
    }
    case 'explore': {
      // El sistema de búsqueda del harness: antes de escribir código, ¿ya existe algo que reutilizar? Sobre el grafo; con --deep, Haiku decide.
      // Cualquier agente (Codex o Claude) lo llama como comando local. `--reuse` se acepta como alias. `--for <rol>` se acepta e ignora.
      // El parser genérico haría que `--deep texto` se coma la primera palabra: aquí se reconstruye la intención desde argv.
      const BOOL = new Set(['deep', 'fresh', 'json', 'reindex']); const WITH_VALUE = new Set(['for', 'root']);
      const words = [];
      for (let i = argv.indexOf('explore') + 1; i < argv.length; i++) {
        const k = argv[i].startsWith('--') ? argv[i].slice(2) : '';
        if (!k) words.push(argv[i]);
        else if (k === 'reuse') { if (argv[i + 1] && !argv[i + 1].startsWith('--')) words.push(argv[++i]); }
        else if (WITH_VALUE.has(k)) i++;
        else if (BOOL.has(k)) flag[k] = true;
      }
      if (flag.reindex) { const r = reindex(root); if (!r) fail('no pude indexar: ¿está instalado codebase-memory-mcp?'); out(r); break; }
      const intent = words.filter(Boolean).join(' ').trim();
      if (!intent) fail('uso: explore "<qué vas a escribir>" [--deep] [--fresh] [--json] | explore --reindex');
      const res = exploreReuse(root, intent, { deep: !!flag.deep, fresh: !!flag.fresh });
      if (flag.json) out(res); else console.log(encode(res));
      break;
    }
    case 'reuse-check': {
      // ¿Lo que el diff escribió duplica algo que ya existía? Para el reviewer y para el executor antes de cerrar. Base: la de la tarea, --base o HEAD.
      const base = sub && loadBacklog(root).tasks[sub] ? loadBacklog(root).tasks[sub].base : typeof flag.base === 'string' ? flag.base : 'HEAD';
      const res = reuseCheck(root, { base });
      if (flag.json) out(res); else console.log(encode(res));
      // --strict: un `duplicate` (similitud ≥ 0.6) sale con código 1, para que el agente o el gate no puedan ignorarlo
      if (flag.strict && res.findings.some((f) => f.verdict === 'duplicate')) process.exitCode = 1;
      break;
    }
    case 'exec': {
      // Lanza a un agente en Codex por Herdr: executor o designer (Pencil). La exploración ya no pasa por aquí: `harness explore`. El prompt lleva referencias, no contenido (7.13).
      const role = flag.role || 'executor';
      if (role === 'explore') fail('explore ya no se lanza por Herdr: cualquier agente lo llama como comando local, `harness explore "<pregunta>"`');
      if (!['executor', 'designer'].includes(role)) fail(`--role debe ser executor o designer (recibí ${role})`);
      const profile = loadProfile(root);
      const t = need(sub);
      let rt; let refs;
      const step = nextStep(profile, t, { available: list(flag.available) });
      if (step.action !== 'run' || step.role !== role || (role === 'designer' && step.phase !== 'spec')) fail(`el siguiente paso no es ${role}: ${JSON.stringify(step)}`);
      rt = step.route; refs = step.refs;
      if (rt.provider !== 'codex') {
        fail(role === 'designer' ? `el designer está configurado en ${rt.provider}, no en Codex (cámbialo con: harness config set models.designer.use codex)` : `este comando solo lanza Codex; la ruta eligió ${rt.provider}`);
      }
      if (role === 'designer' && !pencilAppRunning()) fail('Pencil no está abierto: su MCP se conecta a la app de escritorio. Ábrela (open -a Pencil) y vuelve a lanzar; no gasté ninguna ejecución de Codex.');
      const replyRel = `.harness/replies/${t.id}${role === 'executor' ? '' : `.${role}`}.txt`;
      mkdirSync(join(root, '.harness', 'replies'), { recursive: true });
      rmSync(join(root, replyRel), { force: true }); // una respuesta vieja no cuenta como evidencia de esta corrida
      writeRolePrompt(root, role, profile);
      const contract = ['Reply with ONE line: DONE <summary> or FAILED <reason>.', `Also write that same line to ${replyRel} (the terminal output cannot be read back).`];
      const head = [`You are the ${role} for task ${t.id} (${t.category}, tier ${t.tier}): ${t.title}`, `First read .harness/prompts/${role}.md and follow it exactly.`];
      const t2note = t.tier === 'T2' ? (herdr.codexSandbox(profile, t.tier).sandbox === 'danger-full-access'
        ? 'TIER T2 (sandbox OFF: you have network and full disk access, so be careful): database commands only against the LOCAL test database, never against any other DATABASE_URL. Never run prisma migrate reset, db push, or anything with --force. Do not read or modify prisma/*.sql snapshot or backup files, or any .env file. Make migrations reversible or explain why not in your reply.'
        : 'TIER T2: your sandbox has NO network (not even localhost), so do not run database commands. Write schema/migration/code files only. Never run prisma migrate reset, db push, migrate dev/deploy or anything with --force; the gate applies and verifies the migration. Make migrations reversible or explain why not in your reply.') : '';
      const body = {
        executor: [
          `Branch: ${t.branch}. Allowed paths: ${t.paths.join(', ') || '(any)'}. Do not touch anything else.`,
          `Plan and context: Engram keys ${refs.plan} and ${refs.design} (read them directly; skip if missing).`,
          flag.instruction ? `Instruction: ${flag.instruction}` : '', t2note,
          'Do not push, merge or mark the task done.', ...contract,
        ],
        designer: [
          `Plan and context: Engram key ${refs.plan} (read it directly). Save your TEXT design spec in Engram key ${refs.design} (the executor reads it; it cannot open the canvas).`,
          `Design with the Pencil MCP and save the file as design/${t.id}.pen. Write only design/** files: do not touch code.`,
          flag.instruction ? `Instruction: ${flag.instruction}` : '', ...contract,
        ],
      }[role];
      const text = [...head, ...body].filter(Boolean).join('\n');
      const name = `${role === 'executor' ? 'exec' : role}-${t.id}`.slice(0, 31).toLowerCase().replace(/[^a-z0-9_-]/g, '-');
      const t0 = Date.now();
      const pixel = ensureBridge(root, fileURLToPath(import.meta.url));
      const pane = herdr.splitPane(root);
      try {
        herdr.startAgent(name, 'codex', pane, herdr.codexArgs(profile, rt, t.tier, {}));
        const { hooksDismissed } = herdr.waitCodexReady(name);
        if (role === 'executor') applyEvent(root, profile, t.id, 'exec_started', { provider: 'codex' });
        herdr.prompt(name, text, Number(flag.timeout || 300000));
        // Id de la sesión de Codex (su archivo en ~/.codex): une esta corrida con sus tokens, su cuota y su respuesta final.
        // Codex crea la sesión al recibir la tarea, así que se lee después de enviarla; si Herdr no lo da, se busca por carpeta y hora.
        let codexSession = '';
        try { codexSession = herdr.agentGet(name).result?.agent?.agent_session?.value || ''; } catch { /* sin id */ }
        if (!codexSession) codexSession = sessionStartedSince(root, t0);
        const replyFile = join(root, replyRel);
        const fileReply = existsSync(replyFile) ? readFileSync(replyFile, 'utf8').trim() : '';
        // Su respuesta final queda en la sesión de Codex aunque no pueda escribir archivos (explore va de solo lectura).
        const finalMsg = codexSession ? finalAgentMessage(codexSession) : '';
        const answer = fileReply || finalMsg;
        const reply = answer ? answer.slice(0, 600) : '(sin respuesta)';
        const state = herdr.agentGet(name).result?.agent?.agent_status ?? 'unknown';
        const changed = role === 'executor' ? checkScope(root, t).files?.length > 0
          : role === 'designer' ? (changedFiles(root, t.base) || []).some((f) => f.startsWith('design/')) : false;
        const verdict = judgeRun({ role, reply: answer, changed });
        const evidence = verdict.ok;
        const blocked = state === 'blocked';
        const event = { executor: evidence ? 'exec_done' : 'exec_failed', designer: evidence ? 'design_done' : 'design_failed' }[role];
        if (!blocked && event) applyEvent(root, profile, t.id, event);
        if (!blocked && !evidence) process.exitCode = 2;
        writeRun(dirs(root).metrics, { task: t.id, role, provider: 'codex', model: rt.model, effort: rt.effort || '', ts: new Date(t0).toISOString(), ms: Date.now() - t0, state, attempt: t.attempts, codex_session: codexSession, evidence: evidence ? 'yes' : 'no', hooks_dismissed: hooksDismissed ? 'yes' : 'no' });
        out({ ok: !blocked && evidence, role, ...(!blocked && !evidence ? { error: `Codex (${role}): ${verdict.reason}. Intento fallido (harness next dice cómo seguir)` } : {}), pane, agent: name, route: rt, state, hooksDismissed, pixel, reply });
      } finally {
        if (!flag.keep) { try { herdr.closePane(pane); } catch { /* el pane ya no existe */ } }
      }
      break;
    }
    case 'config': {
      // Cambia o lee una clave del perfil: harness config get models.designer | set models.designer.use claude
      const profile = loadProfile(root);
      if (sub === 'get') { out(getProfileValue(profile, rest[0] || '') ?? null); break; }
      if (sub !== 'set' || !rest[0] || rest[1] === undefined) fail('uso: config get <clave> | config set <clave> <valor>');
      let value = rest[1];
      try { value = JSON.parse(rest[1]); } catch { /* texto plano */ }
      if (rest[0] === 'models.designer.use' && !['codex', 'claude'].includes(value)) fail('models.designer.use debe ser codex o claude');
      setProfileValue(root, rest[0], value);
      out({ set: rest[0], value, note: rest[0].startsWith('models.') ? 'el cambio aplica en el siguiente `harness next`' : undefined });
      break;
    }
    case 'metrics': {
      const md = dirs(root).metrics;
      if (sub === 'collect') {
        // Todo por código, cero tokens: Claude (roles y tarea), Codex (tokens, cuota, subagentes), git y el resumen por tarea.
        const reset = ensureSchema(md);
        const windows = taskWindows(loadBacklog(root));
        const claude = collect(root, md, { ...(flag.transcripts ? { tdir: flag.transcripts } : {}), windows });
        const codex = collectCodex(root, md, { dir: flag['codex-dir'], windows });
        const rollup = collectRollup(root, md);
        const n = (x) => (x?.total ?? x?.files ?? x);
        out({ schemaReset: reset, claude: claude.error ? claude : { transcripts: claude.files, turns: n(claude.turns), sessions: n(claude.sessions) }, codex: { rollouts: codex.files, sessions: n(codex.sessions), quota: n(codex.quota) }, tasks: rollup.tasks.total, tables: Object.keys(rollup).concat(['turns', 'sessions', 'tools', 'codex_sessions', 'codex_tools', 'quota']) });
      } else if (sub === 'report') {
        const tables = Object.fromEntries(['tasks', 'task_roles', 'turns', 'codex_sessions', 'quota'].map((n) => [n === 'codex_sessions' ? 'codex' : n === 'task_roles' ? 'task_roles' : n, readRows(md, n)]));
        process.stdout.write(report(tables, { only: rest[0] || null }));
      } else if (sub === 'show') {
        out(readRows(md, rest[0] || 'sessions').slice(-Number(flag.n || 10)));
      } else fail('uso: metrics collect | report [tarea] | show [tabla] [--n N]');
      break;
    }
    case 'doctor': {
      const { spawnSync } = await import('node:child_process');
      const has = (b) => spawnSync('which', [b]).status === 0;
      const profile = loadProfile(root);
      out({
        herdr: { bin: has('herdr'), inside: herdr.inHerdr() },
        codex: has('codex'), claude: has('claude'),
        profile: existsSync(dirs(root).profile),
        gate: profile.gate.cmd || null,
        note: 'la comprobación de Engram en Codex (clave canaria) no está implementada: ver 8.3 de las notas',
      });
      break;
    }
    default:
      console.log(`harness <comando>
  pixel bridge [--once] [--all]              muestra en Pixel Agents a los agentes de Codex (Herdr → hooks)
  agents sync [--reassign] [--force] regenera el bloque de proyecto de cada agente y las recomendaciones
  init [--apply] [--force]            detecta el proyecto y propone .harness/profile.json
  categories | classify <cat> --paths a,b
  task add <id> --title T --category C [--paths a,b] | approve <id> | event <id> <evento> | list
  next <id> [--available claude,codex]   siguiente paso (lo consulta el planner)
  route <rol> --tier T1 --attempt 0 --executor codex|claude
  gate <id>                           corre el gate y mueve el estado
  explore "<qué vas a escribir>" [--deep] [--fresh] [--json]   ¿ya existe algo reutilizable? (grafo; --deep: Haiku decide)
  explore --reindex                           indexa el grafo en modo full (hace falta una vez por repo)
  reuse-check [id] [--base ref] [--strict]    ¿lo escrito en el diff duplica código existente? (--strict: código 1 si hay duplicado)
  exec <id> [--role executor|designer] [--instruction T] [--keep]   lanza ese agente en Codex por Herdr
  config get <clave> | set <clave> <valor>   p. ej. models.designer.use claude
  metrics collect | report [tarea] | show [tabla]   métricas completas en TOON y un informe legible, sin gastar tokens
  doctor
  --root DIR (por defecto: directorio actual)`);
  }
} catch (e) {
  fail(e.message);
}
