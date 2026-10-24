import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { costOf } from './metrics.mjs';
import { formatPiEvent, parsePiJsonl, piArgs, piHasModels, resolvePi } from './pi.mjs';

// Lanzadores headless. Cada uno sabe encontrar su binario, armar los argumentos de una corrida y leer su salida JSONL
// con la misma forma que parsePiJsonl: { session, model, text, error, turns, in, cached, out, cost }.
// El prompt de rol va en un archivo (.harness/prompts/<rol>.md): pi lo añade al system prompt; codex y opencode no tienen
// esa bandera, así que el prompt de la tarea manda leerlo primero (referencia, no contenido: 7.13).

const short = (v, n = 110) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const emptyRun = () => ({ session: '', model: '', text: '', error: '', turns: 0, in: 0, cached: 0, out: 0, cost: 0 });
const eachEvent = (text, fn) => {
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    let ev; try { ev = JSON.parse(line); } catch { continue; } // línea cortada
    fn(ev);
  }
};

export function resolveBin(name, { env = process.env, fixed = null, envVar = null, exists = existsSync, home = homedir(), extra = [] } = {}) {
  const pinned = (envVar && env[envVar]) || fixed;
  if (pinned) return exists(pinned) ? pinned : null;
  const onPath = spawnSync('which', [name], { encoding: 'utf8', env }).stdout?.trim();
  if (onPath) return onPath;
  return [...extra, join(home, '.local', 'bin', name)].find((p) => exists(p)) || null;
}

// ---------- codex: `codex exec --json` ----------

export function codexArgs(rt, { prompt, sandbox = 'workspace-write' }) {
  const a = ['exec', '--json', '--ephemeral', '-s', sandbox];
  if (rt.model) a.push('-m', rt.model);
  if (rt.effort) a.push('-c', `model_reasoning_effort="${rt.effort}"`);
  a.push(prompt);
  return a;
}

// Eventos: thread.started, item.completed (agent_message | error de aviso | comandos), turn.completed (tokens), turn.failed / error (fallo).
// Un item de tipo `error` es un aviso (p. ej. hooks duplicados), no un fallo de la corrida.
export function parseCodexJsonl(text, { model = '' } = {}) {
  const r = emptyRun(); r.model = model;
  eachEvent(text, (ev) => {
    if (ev.type === 'thread.started') r.session = ev.thread_id || r.session;
    else if (ev.type === 'item.completed' && ev.item?.type === 'agent_message') { r.text = String(ev.item.text || '').trim() || r.text; r.error = ''; }
    else if (ev.type === 'turn.completed') {
      const u = ev.usage || {};
      r.turns += 1; r.in += u.input_tokens || 0; r.cached += u.cached_input_tokens || 0; r.out += u.output_tokens || 0; r.error = '';
    } else if (ev.type === 'turn.failed') r.error = ev.error?.message || 'turn.failed';
    else if (ev.type === 'error') r.error = ev.message || ev.error?.message || 'error';
  });
  const usd = model ? costOf(model, { input_tokens: Math.max(0, r.in - r.cached), output_tokens: r.out, cache_read_input_tokens: r.cached }) : null;
  r.cost = usd == null ? 0 : Number(usd.toFixed(6)); // modelo sin tarifa: queda en 0 y el informe lo avisa
  return r;
}

// ---------- opencode: `opencode run --format json` ----------

// `--auto` aprueba los permisos que no estén denegados: en headless nadie puede contestar (como pi, no hay sandbox).
// El esfuerzo no se pasa: `--variant` depende del proveedor y un valor desconocido rompe la corrida.
export function opencodeArgs(rt, { prompt }) {
  const a = ['run', '--format', 'json', '--auto'];
  if (rt.model) a.push('-m', rt.model);
  a.push(prompt);
  return a;
}

// Eventos: step_start, text (parte de texto), tool_use, step_finish (tokens y costo), error.
export function parseOpencodeJsonl(text, { model = '' } = {}) {
  const r = emptyRun(); r.model = model;
  eachEvent(text, (ev) => {
    r.session = ev.sessionID || r.session;
    if (ev.type === 'text' && ev.part?.text) { r.text = String(ev.part.text).trim(); r.error = ''; }
    else if (ev.type === 'step_finish') {
      const t = ev.part?.tokens || {};
      r.turns += 1; r.in += (t.input || 0) + (t.cache?.read || 0) + (t.cache?.write || 0); r.cached += t.cache?.read || 0;
      r.out += (t.output || 0) + (t.reasoning || 0); r.cost += ev.part?.cost || 0;
    } else if (ev.type === 'error') r.error = ev.error?.data?.message || ev.error?.message || ev.error?.name || 'error';
  });
  r.cost = Number(r.cost.toFixed(6));
  return r;
}

// Modelos que conoce opencode (`opencode models`, uno por línea, proveedor/id).
export function listOpencodeModels(bin) {
  const r = spawnSync(bin, ['models'], { encoding: 'utf8', timeout: 20000 });
  return r.status === 0 ? r.stdout.split('\n').map((l) => l.trim()).filter((l) => l.includes('/')) : [];
}

// ---------- registro ----------

// Para cada runner con lanzador: cómo encontrarlo, cómo armar la corrida y cómo leerla.
export const LAUNCHERS = {
  pi: {
    resolve: (profile) => resolvePi(profile),
    install: 'npm i -g --ignore-scripts @earendil-works/pi-coding-agent (Node ≥ 22.19) o fija pi.bin / PI_BIN',
    ready: (bin) => (piHasModels(bin) ? null : 'pi no tiene modelos: ejecuta `pi`, haz /login con tu suscripción o API key'),
    args: (rt, { promptFile, prompt }) => piArgs(rt, { promptFile, prompt }),
    parse: (stdout) => parsePiJsonl(stdout),
  },
  codex: {
    resolve: (profile) => resolveBin('codex', { fixed: profile.codex?.bin, envVar: 'CODEX_BIN' }),
    install: 'instala Codex CLI o fija codex.bin / CODEX_BIN',
    ready: () => null,
    // El sandbox de Codex bloquea .git en `workspace-write`: el executor, que debe commitear, corre sin sandbox (como pi; decisión del usuario).
    // El reviewer queda en `workspace-write`: puede correr el gate pero no commitear.
    args: (rt, { prompt, profile, tier, role }) => codexArgs(rt, {
      prompt,
      sandbox: role === 'reviewer' ? (profile.codex?.reviewSandbox || 'workspace-write') : (profile.codex?.byTier?.[tier]?.sandbox || profile.codex?.execSandbox || 'danger-full-access'),
    }),
    parse: (stdout, rt) => parseCodexJsonl(stdout, { model: rt.model || '' }),
    hint: 'si el executor no dejó commits, revisa el sandbox de Codex (`codex.execSandbox`, por defecto danger-full-access) y que .git sea escribible',
  },
  opencode: {
    resolve: (profile) => resolveBin('opencode', { fixed: profile.opencode?.bin, envVar: 'OPENCODE_BIN', extra: [join(homedir(), '.opencode', 'bin', 'opencode')] }),
    install: 'instala opencode o fija opencode.bin / OPENCODE_BIN',
    ready: (bin, rt) => {
      if (!rt.model) return null;
      const known = listOpencodeModels(bin);
      return !known.length || known.includes(rt.model) ? null : `opencode no conoce el modelo ${rt.model} (mira \`opencode models\`)`;
    },
    args: (rt, { prompt }) => opencodeArgs(rt, { prompt }),
    parse: (stdout, rt) => parseOpencodeJsonl(stdout, { model: rt.model || '' }),
  },
};

// El prompt de rol viaja por archivo para pi; para los demás se le pide al agente que lo lea primero.
export const withRoleFile = (runner, prompt, promptRel) => (runner === 'pi' ? prompt : `Your role instructions are in ${promptRel}: read that file first and follow it exactly.\n${prompt}`);

// ---------- eventos en vivo (para `harness watch`, el pane de Herdr y la TUI) ----------

export function formatRunEvent(ev) {
  const pi = formatPiEvent(ev);
  if (pi) return pi;
  switch (ev?.type) {
    case 'thread.started': return `▶ sesión ${ev.thread_id}`;
    case 'item.started': return ev.item?.type === 'command_execution' ? `🔧 bash ${short(ev.item.command)}` : null;
    case 'item.completed': {
      const i = ev.item || {};
      if (i.type === 'agent_message') return `💬 ${short(i.text, 300)}`;
      if (i.type === 'command_execution') return `   ${i.exit_code ? `✗ exit ${i.exit_code}` : '✓'}`;
      if (i.type === 'file_change') return `✎ ${(i.changes || []).map((c) => c.path).join(', ').slice(0, 110)}`;
      return null;
    }
    case 'turn.completed': return '■ terminó';
    case 'turn.failed': return `✗ ${short(ev.error?.message, 160)}`;
    case 'step_start': return '▶ paso';
    case 'text': return ev.part?.text ? `💬 ${short(ev.part.text, 300)}` : null;
    case 'tool_use': {
      const p = ev.part || {};
      return `🔧 ${p.tool} ${short(p.state?.input?.command ?? p.state?.input?.filePath ?? p.state?.input?.pattern ?? JSON.stringify(p.state?.input || {}))}${p.state?.status === 'error' ? ' ✗' : ''}`;
    }
    case 'step_finish': return ev.part?.reason === 'stop' ? '■ terminó' : null;
    case 'error': return `✗ ${short(ev.error?.data?.message || ev.error?.name || ev.message, 160)}`;
    default: return null;
  }
}

// ¿Esta corrida ya terminó? pi: agent_settled; codex: turn.completed | turn.failed; opencode: step_finish con razón `stop`.
export const isSettled = (ev) => ev?.type === 'agent_settled' || ev?.type === 'turn.completed' || ev?.type === 'turn.failed'
  || (ev?.type === 'step_finish' && ev.part?.reason === 'stop') || (ev?.type === 'error' && !!ev.error);
