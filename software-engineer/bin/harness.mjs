#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { cwd } from 'node:process';
import { fileURLToPath } from 'node:url';
import { CATEGORIES } from '../src/defaults.mjs';
import { classify } from '../src/classify.mjs';
import { changedFiles, checkScope, headSha, newCommits, runGate, snapshotDirty } from '../src/gate.mjs';
import { judgeRun, parseVerdict } from '../src/verdict.mjs';
import { MAIN_ROLES, ROLES, RUNNERS, checkProfile, detectEnvironment, globalConfigFile, listPiModels, rolePatch } from '../src/config.mjs';
import { runWizard } from '../src/wizard.mjs';
import { fleetSnapshot } from '../src/fleet.mjs';
import { renderFrame, runTui } from '../src/tui.mjs';
import { resolvePi, runPi } from '../src/pi.mjs';
import { LAUNCHERS, formatRunEvent, isSettled, withRoleFile } from '../src/runners.mjs';
import * as herdr from '../src/herdr.mjs';
import { assignSkills, buildAgentsMd, detect, installAgents, installRoleSkills, proposeProfile, recommend, recommendationsMd, writeAgentsMd, writeRolePrompt } from '../src/init.mjs';
import { collect, collectCodex, collectRollup, piRunsAsSessions, ensureSchema, transcriptDir, writeGate, writeRun } from '../src/metrics.mjs';
import { taskWindows } from '../src/attribution.mjs';
import { report } from '../src/report.mjs';
import { compareExecutors, compareMd } from '../src/rollup.mjs';
import { detectLegacy, diffText, reportMd, sdd } from '../src/migrate.mjs';
import { backlogInfo, bridgePidFile, clearBridgePid, ensureBridge, tick } from '../src/pixel.mjs';
import { route } from '../src/router.mjs';
import { dirs, getProfileValue, layersOf, loadBacklog, loadProfile, setProfileValue, writeJson } from '../src/store.mjs';
import { addTask, applyEvent, nextStep, setTaskPaths } from '../src/tasks.mjs';
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

// Asistente de runners/modelos, compartido por `harness config` y `harness init --apply`. Devuelve lo guardado.
async function configure({ offerInstall = false } = {}) {
  const profile = loadProfile(root);
  let env = detectEnvironment(profile);
  const interactive = !flag.yes && process.stdin.isTTY;
  const rl = interactive ? (await import('node:readline/promises')).createInterface({ input: process.stdin, output: process.stdout }) : null;
  try {
    if (rl && offerInstall) {
      for (const [what, cmdline] of Object.entries(env.install)) {
        if ((await rl.question(`${what} no está instalado. ¿Instalarlo con \`${cmdline}\`? (s/N) [n]: `)).trim().toLowerCase().startsWith('s')) {
          const r = spawnSync(cmdline, { shell: true, stdio: 'inherit' });
          console.error(r.status === 0 ? `ok      ${what} instalado` : `error   no pude instalar ${what} (código ${r.status}); instálalo a mano y vuelve a correr \`harness config\``);
        }
      }
      env = detectEnvironment(profile);
    }
    const bin = resolvePi(profile);
    const r = await runWizard({
      profile, env, piModels: bin ? listPiModels(bin) : [], yes: !rl, main: flag.main || null,
      ask: async (q, def) => (await rl.question(`${q}${def ? ` [${def}]` : ''}: `)) || def,
      say: (m) => console.error(m),
    });
    let global = !!flag.global;
    if (rl && Object.keys(r.patches).length) global = (await rl.question('¿Dónde guardo? (g = global, para todos tus proyectos; p = solo este proyecto) [p]: ')).trim().toLowerCase().startsWith('g');
    for (const [k, v] of Object.entries(r.patches)) setProfileValue(root, k, v, { global });
    return { saved: Object.keys(r.patches), scope: global ? 'global' : 'proyecto', interactive: !!rl, warnings: checkProfile(loadProfile(root), env) };
  } finally { rl?.close(); }
}

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
          mode: 'dry-run (usa --apply para escribir)', project: name, ...p, recommend: rec, environment: detectEnvironment(p.profile),
          agentSkills: Object.fromEntries(Object.entries(p.profile.agents).map(([r, v]) => [r, v.skills])), skillsUnassigned: asg.unassigned,
          legacy: { items: legacy.items.map(({ headings, locked, ...i }) => i), conventions: legacy.conventions },
          sdd: safeSdd(true),
          would_write: ['.harness/profile.json', '.harness/backlog.json', '.harness/migration.md', '.harness/recommendations.md', 'AGENTS.md (o .harness/AGENTS.proposed.md si ya existe una guía)', '.claude/agents/*.md (5 agentes con un bloque del proyecto; lo editado a mano no se pisa)', 'asistente de runners y modelos (solo en una terminal; `--yes` lo omite; después: `harness config`)', `Engram: copia sdd/* → harness/* (--sdd ${scope})`],
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
      const setup = flag.yes || !process.stdin.isTTY ? { skipped: 'sin terminal o con --yes: reparto recomendado; cámbialo con `harness config`' } : await configure({ offerInstall: true });
      const sddResult = safeSdd(false);
      const guide = legacy.items.find((i) => i.kind === 'guide');
      const agentsDiff = agentsMd.proposal && guide ? diffText(join(root, guide.path), agentsMd.proposal) : '';
      const report = join(d.base, 'migration.md');
      writeFileSync(report, reportMd(name, legacy, sddResult, { agentsDiff }));
      out({ project: name, written: [d.profile, d.backlog, report, recFile], setup, agentsMd, agents, commands, agentSkills: Object.fromEntries(Object.entries(p.profile.agents).map(([r, v]) => [r, v.skills])), sdd: sddResult, legacyFound: legacy.items.length, recommend: rec, notes: p.notes, committed: false });
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
      else if (sub === 'paths') {
        if (!rest[0] || (!flag.add && !flag.remove)) fail('uso: task paths <id> [--add a,b] [--remove c]');
        out(setTaskPaths(root, profile, rest[0], { add: list(flag.add), remove: list(flag.remove) }));
      }
      else if (sub === 'redesign') out(applyEvent(root, profile, rest[0], 'redesign'));
      else if (sub === 'event') out(applyEvent(root, profile, rest[0], rest[1], { provider: flag.provider }));
      else if (sub === 'list') out(Object.values(loadBacklog(root).tasks).map((t) => ({ id: t.id, category: t.category, tier: t.tier, status: t.status, attempts: t.attempts })));
      else fail('uso: task add|approve|paths|redesign|event|list');
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
      // Lanza en headless (JSONL) al executor o al reviewer cuando su runner es pi, codex u opencode. El designer es un subagente de Claude; la exploración es `harness explore`. El prompt lleva referencias, no contenido (7.13).
      const role = flag.role || 'executor';
      if (role === 'explore') fail('explore ya no se lanza por exec: cualquier agente lo llama como comando local, `harness explore "<pregunta>"`');
      if (!['executor', 'reviewer'].includes(role)) fail(`exec lanza al executor o al reviewer (recibí ${role}); el designer es un subagente de Claude`);
      const profile = loadProfile(root);
      const t = need(sub);
      const step = nextStep(profile, t, { available: list(flag.available) });
      if (step.action !== 'run' || step.role !== role) fail(`el siguiente paso no es ${role}: ${JSON.stringify(step)}`);
      const rt = step.route; const refs = step.refs;
      const launcher = LAUNCHERS[rt.provider];
      if (!launcher) fail(`\`exec\` lanza ${Object.keys(LAUNCHERS).join(', ')}; la ruta de ${role} eligió ${rt.provider}${rt.provider === 'claude' ? ' (corre como subagente de Claude: lo lanza el planner)' : ''}`);
      const bin = launcher.resolve(profile);
      if (!bin) fail(`no encuentro ${rt.provider}: ${launcher.install}; no gasté ningún intento.`);
      const notReady = launcher.ready(bin, rt);
      if (notReady) fail(`${notReady}; no gasté ningún intento.`);
      if (rt.provider === 'pi' && rt.model && !listPiModels(bin).some((m) => m.model === rt.model)) fail(`pi no conoce el modelo ${rt.model} (¿falta /login de ese proveedor?). Mira \`pi --list-models\` o cámbialo con \`harness config\`; no gasté ningún intento.`);
      const replyRel = `.harness/replies/${t.id}${role === 'executor' ? '' : `.${role}`}.txt`;
      mkdirSync(join(root, '.harness', 'replies'), { recursive: true });
      rmSync(join(root, replyRel), { force: true }); // una respuesta vieja no cuenta como evidencia de esta corrida
      const promptFile = writeRolePrompt(root, role, profile);
      const t2note = t.tier === 'T2' && role === 'executor' ? 'TIER T2: database commands only against the LOCAL test database, never against any other DATABASE_URL. Never run prisma migrate reset, db push, or anything with --force. Do not read or modify prisma/*.sql snapshot or backup files, or any .env file. Make migrations reversible or explain why not in your reply.' : '';
      const text = (role === 'reviewer' ? [
        `You are the reviewer for task ${t.id} (${t.category}, tier ${t.tier}): ${t.title}`,
        `Branch: ${t.branch}. Allowed paths: ${t.paths.join(', ') || '(any)'}. Review the diff of the branch against its base.`,
        `Plan and context: Engram keys ${refs.plan} and ${refs.design} (read them with the engram MCP; skip if missing).`,
        flag.instruction ? `Instruction: ${flag.instruction}` : '',
        'Read-only: do not edit files, do not commit, push or merge.', 'Reply with ONE line: VERDICT approved  or  VERDICT rejected: <up to 3 concrete reasons>.',
      ] : [
        `You are the ${role} for task ${t.id} (${t.category}, tier ${t.tier}): ${t.title}`,
        `Branch: ${t.branch}. Allowed paths: ${t.paths.join(', ') || '(any)'}. Do not touch anything else.`,
        `Plan and context: Engram keys ${refs.plan} and ${refs.design} (read them with the engram MCP; skip if missing).`,
        flag.instruction ? `Instruction: ${flag.instruction}` : '', t2note,
        'Do not push, merge or mark the task done.', 'Reply with ONE line: DONE <summary> or FAILED <reason>.',
      ]).filter(Boolean).join('\n');
      const t0 = Date.now();
      const headBefore = headSha(root);
      if (role === 'executor') applyEvent(root, profile, t.id, 'exec_started', { provider: rt.provider, model: rt.model });
      else if (t.status === 'gated') applyEvent(root, profile, t.id, 'review_started');
      // Log en vivo: `tail -f` o `harness watch <id>` desde otra terminal; `--live` lo imprime aquí mismo (stderr, el stdout sigue siendo el JSON final).
      const logFile = join(root, '.harness', 'logs', `${t.id}.jsonl`);
      mkdirSync(dirname(logFile), { recursive: true });
      writeFileSync(logFile, '');
      // Verlo trabajar es lo normal: dentro de Herdr se abre un pane que lo sigue; fuera, se imprime por stderr. `--quiet` lo apaga.
      const paneFile = join(dirname(logFile), `${t.id}.pane`);
      let watchPane = null;
      if (!flag.quiet && herdr.inHerdr()) {
        try {
          if (existsSync(paneFile)) { try { herdr.closePane(readFileSync(paneFile, 'utf8').trim()); } catch { /* ya no existe */ } }
          watchPane = herdr.openWatchPane(root, t.id, fileURLToPath(import.meta.url));
          writeFileSync(paneFile, watchPane);
        } catch (e) { console.error(`[exec] no pude abrir el pane de seguimiento (${String(e.message).split('\n')[0]}): sigo sin él`); }
      }
      const live = !flag.quiet && !watchPane;
      const onLine = (l) => {
        appendFileSync(logFile, `${l}\n`);
        if (live) { try { const f = formatRunEvent(JSON.parse(l)); if (f) console.error(f); } catch { /* línea cortada */ } }
      };
      const promptRel = relative(root, promptFile);
      const run = await runPi({ bin, cwd: root, onLine, args: launcher.args(rt, { promptFile, prompt: withRoleFile(rt.provider, text, promptRel), profile, tier: t.tier, role }), timeoutMs: Number(flag.timeout || profile[rt.provider]?.timeoutMs?.[role] || profile.pi?.timeoutMs?.[role] || 600000) });
      if (watchPane) { // el pane de seguimiento no sobrevive a la corrida; una pausa deja que `watch` imprima el cierre
        await new Promise((r) => setTimeout(r, 1000));
        try { herdr.closePane(watchPane); } catch { /* ya lo cerraron */ }
        rmSync(paneFile, { force: true });
      }
      const res = launcher.parse(run.stdout, rt);
      const failure = run.timedOut ? `${rt.provider} superó el tiempo máximo (${Math.round((Date.now() - t0) / 1000)} s)` : res.error || (!res.text && run.code !== 0 ? `${rt.provider} terminó con código ${run.code}: ${run.stderr.trim().slice(-300)}` : '');
      const answer = failure ? '' : res.text;
      const commits = newCommits(root, headBefore);
      let verdict = failure ? { ok: false, reason: failure } : judgeRun({ role, reply: answer, commits, screen: run.stderr });
      // El reviewer no escribe código: sin una línea VERDICT no hay veredicto y la tarea sigue en `reviewing` (se puede volver a lanzar).
      let review = null;
      if (role === 'reviewer' && verdict.ok) {
        review = parseVerdict(answer);
        if (!review) verdict = { ok: false, reason: 'el reviewer no devolvió una línea VERDICT approved|rejected' };
        else if (commits > 0) verdict = { ok: false, reason: `el reviewer dejó ${commits} commit(s): es de solo lectura; revisa la rama antes de aceptar su veredicto` };
      }
      writeFileSync(join(root, replyRel), `${answer || (failure ? `FAILED ${failure}` : '')}\n`);
      if (role === 'executor') applyEvent(root, profile, t.id, verdict.ok ? 'exec_done' : 'exec_failed');
      else if (verdict.ok && review) applyEvent(root, profile, t.id, review.approved ? 'verdict_approved' : 'verdict_rejected');
      if (!verdict.ok) process.exitCode = 2;
      writeRun(dirs(root).metrics, { task: t.id, role, provider: rt.provider, model: res.model || rt.model || '', effort: rt.effort || '', ts: new Date(t0).toISOString(), ms: Date.now() - t0, state: verdict.ok ? 'done' : 'failed', attempt: t.attempts, session: res.session, turns: res.turns, in: res.in, cached: res.cached, out: res.out, cost: res.cost, evidence: verdict.ok ? 'yes' : 'no' });
      out({ ok: verdict.ok, role, ...(review ? { verdict: review.approved ? 'approved' : 'rejected', reason: review.reason } : {}), ...(watchPane ? { watchPane } : {}), ...(!verdict.ok ? { error: `${rt.provider} (${role}): ${verdict.reason}. Intento fallido (harness next dice cómo seguir)`, ...(launcher.hint && role === 'executor' ? { hint: launcher.hint } : {}) } : {}), route: rt, model: res.model, tokens: { in: res.in, cached: res.cached, out: res.out }, cost: res.cost, reply: (answer || verdict.reason || '(sin respuesta)').slice(0, 600) });
      break;
    }
    case 'tui': {
      // Panel de todos los proyectos con harness. `--once [--view proyectos|vivo|tareas|consumo]` imprime un cuadro y sale (útil para scripts).
      if (!flag.once) { if (!process.stdout.isTTY) fail('la TUI necesita una terminal; usa --once para imprimir un cuadro'); runTui(); break; }
      const tab = { proyectos: 0, vivo: 1, tareas: 2, consumo: 3, metricas: 3 }[flag.view || 'proyectos'] ?? 0;
      console.log(renderFrame(fleetSnapshot(), { tab, sel: Number(flag.sel || 0), detail: !!flag.detail, scope: flag.scope || 'general' }, { width: Number(flag.width || 110), height: 40, color: !!process.stdout.isTTY }));
      break;
    }
    case 'watch': {
      // Sigue el log de la última corrida de una tarea y lo muestra legible. Ctrl+C para salir; termina solo cuando pi acaba.
      need(sub); // valida que la tarea exista
      const file = join(root, '.harness', 'logs', `${sub}.jsonl`);
      if (!existsSync(file)) fail(`no hay log de ${sub} todavía (${file}): lanza antes \`harness exec ${sub}\``);
      let pos = 0; let buf = ''; let done = false;
      const pump = () => {
        const data = readFileSync(file); if (data.length < pos) pos = 0; // el log se reinició: otra corrida
        buf += data.subarray(pos).toString('utf8'); pos = data.length;
        const lines = buf.split('\n'); buf = lines.pop();
        for (const l of lines) { try { const ev = JSON.parse(l); const f = formatRunEvent(ev); if (f) console.log(f); if (isSettled(ev)) done = true; } catch { /* cortada */ } }
      };
      while (!done) { pump(); if (!done) await new Promise((r) => setTimeout(r, 400)); }
      break;
    }
    case 'config': {
      // config                      asistente interactivo (runner principal, runner y modelo por rol)
      // config show                 la configuración efectiva y de qué capa sale cada valor
      // config get <clave> | set <clave> <valor> [--global] | role <rol> <runner> [modelo] [--global]
      const asGlobal = !!flag.global;
      const profile = loadProfile(root);
      const env = detectEnvironment(profile);
      const applyPatches = (patches) => {
        for (const [k, v] of Object.entries(patches)) setProfileValue(root, k, v, { global: asGlobal });
        return Object.keys(patches);
      };
      const summary = (p) => ({
        main: p.main ?? null,
        roles: Object.fromEntries(Object.keys(p.models).map((r) => [r, { runner: p.models[r].provider, model: p.models[r].model, effort: p.models[r].effort, from: layersOf(root, `models.${r}.provider`) === 'defecto' && p.main && MAIN_ROLES.includes(r) ? 'main' : layersOf(root, `models.${r}.provider`) }])),
        warnings: checkProfile(p, env),
        files: { global: globalConfigFile(), project: dirs(root).profile },
      });
      if (sub === 'show') { out(summary(profile)); break; }
      if (sub === 'get') { out(getProfileValue(profile, rest[0] || '') ?? null); break; }
      if (sub === 'role') {
        const [role, runner, model] = rest;
        if (!role || !runner) fail('uso: config role <rol> <runner> [proveedor/id] [--global]');
        if (!ROLES.includes(role)) fail(`rol desconocido: ${role} (válidos: ${ROLES.join(', ')})`);
        if (!RUNNERS[runner]) fail(`runner desconocido: ${runner} (válidos: ${Object.keys(RUNNERS).join(', ')})`);
        const keys = applyPatches(rolePatch(role, { runner, model: model ?? null }));
        out({ set: keys, scope: asGlobal ? 'global' : 'proyecto', ...summary(loadProfile(root)) });
        break;
      }
      if (sub === 'set') {
        if (!rest[0] || rest[1] === undefined) fail('uso: config set <clave> <valor> [--global]');
        let value = rest[1];
        try { value = JSON.parse(rest[1]); } catch { /* texto plano */ }
        setProfileValue(root, rest[0], value, { global: asGlobal });
        out({ set: rest[0], value, scope: asGlobal ? 'global' : 'proyecto', note: rest[0].startsWith('models.') || rest[0] === 'main' ? 'el cambio aplica en el siguiente `harness next`' : undefined, warnings: checkProfile(loadProfile(root), env) });
        break;
      }
      if (sub) fail('uso: config [show | get <clave> | set <clave> <valor> | role <rol> <runner> [modelo]] [--global]');
      if (!process.stdin.isTTY && !flag.yes) fail('el asistente necesita una terminal; usa `config role`, `config set` o `--yes`');
      out({ ...(await configure({ offerInstall: true })), ...summary(loadProfile(root)) });
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
        const tables = Object.fromEntries(['tasks', 'task_roles', 'turns', 'codex_sessions', 'quota'].map((n) => [n === 'codex_sessions' ? 'codex' : n, n === 'codex_sessions' ? [...readRows(md, n), ...piRunsAsSessions(readRows(md, 'runs'))] : readRows(md, n)]));
        process.stdout.write(report(tables, { only: rest[0] || null }));
      } else if (sub === 'compare') {
        process.stdout.write(compareMd(compareExecutors(readRows(md, 'tasks'))));
      } else if (sub === 'show') {
        out(readRows(md, rest[0] || 'sessions').slice(-Number(flag.n || 10)));
      } else fail('uso: metrics collect | report [tarea] | compare | show [tabla] [--n N]');
      break;
    }
    case 'doctor': {
      const profile = loadProfile(root);
      const env = detectEnvironment(profile);
      out({
        herdr: { bin: env.herdr, inside: herdr.inHerdr() },
        runners: { ...env.runners, pi: resolvePi(profile) || false },
        profile: existsSync(dirs(root).profile),
        gate: profile.gate.cmd || null,
        config: { main: profile.main ?? null, global: globalConfigFile(), warnings: checkProfile(profile, env) },
        install: env.install,
        note: 'pi: la suscripción se conecta con /login dentro de pi; `pi mcp list` muestra los MCP (engram, codebase-memory). Cambiar runners y modelos: `harness config`',
      });
      break;
    }
    default:
      console.log(`harness <comando>
  pixel bridge [--once] [--all]              (legado) muestra en Pixel Agents a los agentes de Codex
  agents sync [--reassign] [--force] regenera el bloque de proyecto de cada agente y las recomendaciones
  init [--apply] [--force] [--yes]    detecta el proyecto y propone .harness/profile.json; con --apply abre el asistente de runners/modelos
  categories | classify <cat> --paths a,b
  task add <id> --title T --category C [--paths a,b] | approve <id> | paths <id> --add a,b --remove c | redesign <id> | event <id> <evento> | list
  next <id> [--available claude,pi]   siguiente paso (lo consulta el planner)
  route <rol> --tier T1 --attempt 0 --executor pi|claude
  gate <id>                           corre el gate y mueve el estado
  explore "<qué vas a escribir>" [--deep] [--fresh] [--json]   ¿ya existe algo reutilizable? (grafo; --deep: Haiku decide)
  explore --reindex                           indexa el grafo en modo full (hace falta una vez por repo)
  reuse-check [id] [--base ref] [--strict]    ¿lo escrito en el diff duplica código existente? (--strict: código 1 si hay duplicado)
  exec <id> [--role executor|reviewer] [--instruction T] [--timeout ms] [--quiet]   lanza ese rol en su runner (pi, codex u opencode; headless); lo muestra en vivo (pane de Herdr o stderr)
  tui [--once]                               panel de todos los proyectos: configuración, desactualizados, agentes en vivo y métricas
  watch <id>                                 sigue en vivo la última corrida de esa tarea (desde otra terminal)
  config                                     asistente: runner principal, runner y modelo por rol (global o proyecto)
  config show | get <clave> | set <clave> <valor> [--global] | role <rol> <runner> [modelo] [--global]
  metrics collect | report [tarea] | compare | show [tabla] métricas completas en TOON y un informe legible, sin gastar tokens
  doctor
  --root DIR (por defecto: directorio actual)`);
  }
} catch (e) {
  fail(e.message);
}
