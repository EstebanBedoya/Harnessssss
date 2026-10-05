import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

// Puente Herdr → Pixel Agents (9.5, camino 2). Pixel Agents solo ve Claude Code; Codex no deja transcript que lea.
// Pero su servidor acepta eventos de hooks por HTTP y, si un SessionStart llega SIN transcript_path, crea el personaje
// "hooks-only" (todo su estado sale de los eventos). Este módulo traduce el estado que Herdr ya expone
// (idle, working, blocked, done) a esos eventos, sin modificar Pixel Agents.

export const REGISTRY_DIR = join(homedir(), '.pixel-agents', 'servers');
// Sin el título de la terminal: trae el spinner de Codex (⠇ | proyecto) y cambia cada segundo.
const LABEL = (a, info) => `codex · ${info ? `${info.role} · ${info.tasks}` : basename(String(a.cwd || '').replace(/\/+$/, '')) || a.pane_id}`;

// Qué hace el harness ahora, según su backlog: { role: 'executor', tasks: 'feat-1 (T2)' }. Sin tareas en ejecución devuelve null.
export function backlogInfo(root) {
  try {
    const b = JSON.parse(readFileSync(join(root, '.harness', 'backlog.json'), 'utf8'));
    const tasks = Object.values(b.tasks);
    const label = (list) => list.map((t) => `${t.id} (${t.tier})`).join(', ');
    const exec = tasks.filter((t) => t.status === 'executing');
    if (exec.length) return { role: 'executor', tasks: label(exec) };
    const design = tasks.filter((t) => t.status === 'approved' && t.ui && !t.designed); // el designer corre antes que el executor
    if (design.length) return { role: 'designer', tasks: label(design) };
    return null;
  } catch { return null; }
}

export const sessionId = (a) => `herdr-${a.pane_id}`;

function forStatus(base, a, status, first, was, info) {
  switch (status) {
    case 'working': // animación de escribir, con una etiqueta legible
      return [{ ...base, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: LABEL(a, info) } }];
    case 'blocked': // globo de "espera un permiso"
      return [{ ...base, hook_event_name: 'PermissionRequest' }];
    case 'idle':
    case 'done': {
      const out = [];
      if (!first && was === 'working') out.push({ ...base, hook_event_name: 'PostToolUse' });
      out.push({ ...base, hook_event_name: 'Stop' }); // turno terminado; en un agente nuevo, además confirma el personaje
      return out;
    }
    default: return []; // `unknown` no prueba nada: no se emite
  }
}

// Función pura: estado anterior + agentes actuales → eventos y estado nuevo. Solo agentes de Codex (Claude ya se ve solo).
// trackedDir: carpeta de sesiones que Pixel Agents ya vigila (~/.claude/projects/<proyecto>). Un agente "hooks-only" usa `cwd` como
// directorio de proyecto y solo se adopta si coincide con una carpeta vigilada (o si Watch All Sessions está activo).
export function diff(prev, agents, { cwdPrefix = null, trackedDir = null, info = null } = {}) {
  const events = []; const next = new Map();
  for (const a of agents) {
    if (a.agent !== 'codex') continue;
    if (cwdPrefix && !String(a.cwd || '').startsWith(cwdPrefix)) continue;
    const sid = sessionId(a); const status = a.agent_status;
    const before = prev.get(sid);
    // agent_type / session_name: Pixel Agents los muestra como el nombre del agente (rol y tarea). Sin tarea del harness, es "codex".
    const base = { session_id: sid, agent_type: info?.role ?? 'codex', ...(info ? { session_name: info.tasks } : {}) };
    if (!before) {
      next.set(sid, { status });
      events.push({ ...base, hook_event_name: 'SessionStart', source: 'startup', cwd: trackedDir || a.cwd }); // sin transcript_path a propósito
      events.push(...forStatus(base, a, status, true, undefined, info));
    } else {
      const changed = status !== before.status && status !== 'unknown';
      next.set(sid, { status: changed ? status : before.status });
      if (changed) events.push(...forStatus(base, a, status, false, before.status, info));
    }
  }
  for (const sid of prev.keys()) if (!next.has(sid)) events.push({ session_id: sid, hook_event_name: 'SessionEnd', reason: 'exit' });
  return { events, next };
}

// Servidores vivos de Pixel Agents: el mismo registro que usa su script de hooks.
export function liveServers(dir = REGISTRY_DIR) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json')).flatMap((f) => {
    try {
      const s = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      if (!s.port || !s.token || !s.pid) return [];
      process.kill(s.pid, 0); // lanza si el proceso ya no existe
      return [s];
    } catch { return []; }
  });
}

export async function post(server, event) {
  const r = await fetch(`http://127.0.0.1:${server.port}/api/hooks/claude`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${server.token}` },
    body: JSON.stringify(event),
    signal: AbortSignal.timeout(2000),
  });
  return r.status;
}

export const herdrAgents = () => JSON.parse(execFileSync('herdr', ['agent', 'list'], { encoding: 'utf8' })).result.agents;

// Una pasada: lee Herdr, calcula eventos y los manda a todos los servidores vivos. Devuelve el estado para la siguiente.
export async function tick(state, { agents = herdrAgents, servers = liveServers, cwdPrefix, trackedDir, info = () => null, log = () => {} } = {}) {
  const live = servers();
  const sig = live.map((s) => `${s.pid}:${s.port}`).join(',');
  // Si el servidor se reinició, no conoce a nadie: hay que reanunciar a todos.
  const prev = sig === state.sig ? state.prev : new Map();
  const { events, next } = diff(prev, agents(), { cwdPrefix, trackedDir, info: info() });
  for (const s of live) for (const e of events) {
    try { const code = await post(s, e); log(`${e.hook_event_name} ${e.session_id.slice(0, 8)} -> :${s.port} ${code}`); }
    catch (err) { log(`error ${e.hook_event_name} -> :${s.port} ${err.message}`); }
  }
  return { prev: live.length ? next : prev, sig, sent: events.length, servers: live.length };
}

// ---------- Puente en segundo plano: lo levanta `harness exec` solo si Pixel Agents está corriendo ----------

export const bridgePidFile = (root) => join(root, '.harness', 'pixel-bridge.pid');

export function bridgeRunning(root) {
  try { process.kill(Number(readFileSync(bridgePidFile(root), 'utf8')), 0); return true; } catch { return false; }
}

// 'no-server' | 'already-running' | 'started'. El proceso se desacopla y se apaga solo (ver --idle-exit).
export function ensureBridge(root, binPath, { servers = liveServers } = {}) {
  if (!servers().length) return 'no-server';
  if (bridgeRunning(root)) return 'already-running';
  mkdirSync(join(root, '.harness'), { recursive: true });
  const child = spawn(process.execPath, [binPath, 'pixel', 'bridge', '--root', root], { cwd: root, detached: true, stdio: 'ignore' });
  child.unref();
  writeFileSync(bridgePidFile(root), String(child.pid));
  return 'started';
}

export const clearBridgePid = (root) => { try { rmSync(bridgePidFile(root)); } catch { /* ya no estaba */ } };
