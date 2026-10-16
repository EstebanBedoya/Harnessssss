import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// Proveedor externo agnóstico: pi (pi.dev) en modo headless. El proveedor y el modelo salen de la config de pi
// (`/login`, `pi --list-models`); el harness solo pasa --model si el perfil lo fija. Sin sandbox ni aprobaciones: pi no los tiene.

// pi pide Node >= 22.19 y su shebang usa el `node` del PATH: al lanzarlo se antepone la carpeta de su propio node.
export function resolvePi(profile = {}, { env = process.env, exists = existsSync, home = homedir(), versions = (d) => readdirSync(d) } = {}) {
  const fixed = env.PI_BIN || profile.pi?.bin;
  if (fixed) return exists(fixed) ? fixed : null;
  const onPath = spawnSync('which', ['pi'], { encoding: 'utf8', env }).stdout?.trim();
  if (onPath) return onPath;
  const nvm = join(home, '.nvm', 'versions', 'node');
  try {
    for (const v of versions(nvm).sort().reverse()) if (exists(join(nvm, v, 'bin', 'pi'))) return join(nvm, v, 'bin', 'pi');
  } catch { /* sin nvm */ }
  return null;
}

// Banderas de una corrida: JSONL por stdout, sin sesión guardada, prompt de rol añadido al del sistema.
// effort del perfil == nivel de pensamiento de pi (low|medium|high|xhigh).
// --approve: sin él pi no carga las skills del proyecto (.agents/skills); el repo es del usuario, así que se confía en él.
export function piArgs(route, { promptFile, prompt }) {
  const a = ['--mode', 'json', '--no-session', '--approve'];
  if (promptFile) a.push('--append-system-prompt', promptFile);
  if (route.model) a.push('--model', route.model);
  if (route.effort) a.push('--thinking', route.effort);
  a.push('--', prompt);
  return a;
}

// Lee el JSONL de `pi --mode json`: respuesta final, tokens y costo sumados de cada mensaje del asistente.
export function parsePiJsonl(text) {
  const r = { session: '', model: '', text: '', error: '', turns: 0, in: 0, cached: 0, out: 0, cost: 0 };
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    let ev; try { ev = JSON.parse(line); } catch { continue; } // línea cortada
    if (ev.type === 'session') r.session = ev.id || r.session;
    if (ev.type !== 'message_end' || ev.message?.role !== 'assistant') continue;
    const m = ev.message; const u = m.usage || {};
    r.turns += 1;
    r.in += (u.input || 0) + (u.cacheRead || 0);
    r.cached += u.cacheRead || 0;
    r.out += u.output || 0;
    r.cost += u.cost?.total || 0;
    r.model = m.responseModel || m.model || r.model;
    const body = Array.isArray(m.content) ? m.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim() : String(m.content || '').trim();
    if (m.stopReason === 'error' || m.stopReason === 'aborted') r.error = m.errorMessage || m.stopReason;
    else { r.error = ''; if (body) r.text = body; }
  }
  r.cost = Number(r.cost.toFixed(6));
  return r;
}

// Lanza pi y espera. Devuelve lo crudo; juzgarlo es de verdict.mjs.
export function runPi({ bin, cwd, args, timeoutMs = 300000, env = process.env, onLine = null }) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd, env: { ...env, PATH: `${dirname(bin)}:${env.PATH || ''}` }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let timedOut = false;
    let pending = '';
    child.stdout.on('data', (d) => {
      stdout += d;
      if (!onLine) return;
      pending += d;
      const lines = pending.split('\n'); pending = lines.pop(); // el último trozo puede venir cortado
      for (const l of lines) if (l.trim()) onLine(l);
    });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 5000).unref(); }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: `${stderr}${e.message}`, timedOut }); });
    child.on('close', (code) => { clearTimeout(timer); if (onLine && pending.trim()) onLine(pending); resolve({ code, stdout, stderr, timedOut }); });
  });
}

// ¿Hay algún modelo disponible (login hecho)? Se pregunta antes de abrir una tarea: sin login no se gasta un intento.
export function piHasModels(bin) {
  const r = spawnSync(bin, ['--list-models'], { encoding: 'utf8', env: { ...process.env, PATH: `${dirname(bin)}:${process.env.PATH || ''}` } });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  return r.status === 0 && !/No models available/i.test(out);
}

// Una línea legible por evento, para verlo trabajar (`exec --live`, `harness watch`). Los deltas de texto no se muestran: el mensaje completo sí.
const short = (v, n = 110) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const toolArg = (a = {}) => short(a.command ?? a.path ?? a.file_path ?? a.pattern ?? a.query ?? JSON.stringify(a));
export function formatPiEvent(ev) {
  switch (ev?.type) {
    case 'session': return `▶ sesión ${ev.id} en ${ev.cwd}`;
    case 'tool_execution_start': return `🔧 ${ev.toolName} ${toolArg(ev.args)}`;
    case 'tool_execution_end': return `   ${ev.isError ? '✗ error' : '✓'}${ev.durationMs != null ? ` ${ev.durationMs} ms` : ''}${ev.isError ? ` · ${short(ev.result?.content?.[0]?.text, 160)}` : ''}`;
    case 'message_end': {
      const m = ev.message;
      if (m?.role !== 'assistant') return null;
      if (m.stopReason === 'error' || m.stopReason === 'aborted') return `✗ ${m.errorMessage || m.stopReason}`;
      const t = Array.isArray(m.content) ? m.content.filter((c) => c.type === 'text').map((c) => c.text).join(' ') : '';
      const u = m.usage || {};
      return t ? `💬 ${short(t, 300)}  [${(u.input || 0) + (u.cacheRead || 0)} in / ${u.output || 0} out]` : null;
    }
    case 'agent_settled': return ev.aborted ? '■ abortado' : '■ terminó';
    default: return null;
  }
}
