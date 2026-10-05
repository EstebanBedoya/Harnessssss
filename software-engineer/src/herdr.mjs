import { execFileSync } from 'node:child_process';

export const inHerdr = () => process.env.HERDR_ENV === '1';

function herdr(args, { json = true, input } = {}) {
  if (!inHerdr()) throw new Error('no estoy dentro de Herdr (HERDR_ENV != 1)');
  const out = execFileSync('herdr', args, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] });
  return json ? JSON.parse(out) : out;
}

export const splitPane = (cwd, direction = 'right') =>
  herdr(['pane', 'split', '--current', '--direction', direction, '--cwd', cwd, '--no-focus']).result.pane.pane_id;

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Un pane recién dividido tarda en mostrar el prompt del shell: `agent start` responde agent_pane_busy hasta entonces.
export function startAgent(name, kind, pane, nativeArgs = [], { tries = 20, delayMs = 500 } = {}) {
  const args = ['agent', 'start', name, '--kind', kind, '--pane', pane, ...(nativeArgs.length ? ['--', ...nativeArgs] : [])];
  for (let i = 1; ; i++) {
    try { return herdr(args); } catch (e) {
      if (!String(e.stderr || e.message).includes('agent_pane_busy') || i >= tries) throw e;
      sleep(delayMs);
    }
  }
}

export const prompt = (name, text, timeoutMs = 300000) =>
  herdr(['agent', 'prompt', name, text, '--wait', '--timeout', String(timeoutMs)]);

// Codex puede mostrar diálogos de arranque. Solo se contesta uno, y por defecto de forma conservadora:
//  - "Hooks need review": se elige "continuar sin confiar" (solo esa sesión).
//  - Cualquier otro diálogo (confiar en la carpeta, actualizar, etc.) NO se contesta: confiar en una carpeta o aceptar
//    cambios es decisión del usuario y queda guardado en su ~/.codex. Se falla con la pantalla a la vista, SIN escribir la tarea.
// La pantalla lista se reconoce por su texto exacto, no por el cursor "›", que también aparece en los menús de los diálogos.
const CODEX_READY = /Ask Codex to do anything/;
const CODEX_MENU = /›\s*\d+\./;

export function waitCodexReady(name, { tries = 30, delayMs = 500, read = agentRead, send = (n, ...k) => herdr(['agent', 'send-keys', n, ...k], { json: false }), pause = sleep } = {}) {
  let hooksDismissed = false;
  let last = '';
  for (let i = 0; i < tries; i++) {
    last = read(name, 40, 'visible');
    if (/Hooks need review/.test(last)) {
      send(name, 'down', 'down', 'enter');
      hooksDismissed = true;
      pause(delayMs * 2);
      continue;
    }
    if (CODEX_READY.test(last)) return { ready: true, hooksDismissed };
    if (CODEX_MENU.test(last)) {
      throw new Error(`Codex muestra un diálogo de arranque que hay que resolver a mano (una sola vez por carpeta); no escribí la tarea. Pantalla:\n${last.trim().slice(-600)}`);
    }
    pause(delayMs);
  }
  throw new Error(`Codex no llegó a su prompt de entrada; no escribí la tarea. Pantalla:\n${last.trim().slice(-600)}`);
}

export const agentGet = (name) => herdr(['agent', 'get', name]);
export const agentRead = (name, lines = 80, source = 'recent-unwrapped') =>
  herdr(['agent', 'read', name, '--source', source, '--lines', String(lines)], { json: false });
export const closePane = (pane) => herdr(['pane', 'close', pane], { json: false });

// Flags de Codex para correr sin quedar en `blocked` (7.13): sandbox y aprobación, modelo y esfuerzo explícitos.
export const codexSandbox = (profile, tier) => ({
  sandbox: profile.codex.byTier?.[tier]?.sandbox ?? profile.codex.sandbox,
  approval: profile.codex.byTier?.[tier]?.approval ?? profile.codex.approval,
});

export function codexArgs(profile, route, tier, { sandbox: forced } = {}) {
  const { sandbox: configured, approval } = codexSandbox(profile, tier);
  const sandbox = forced || configured; // `explore` es de solo lectura sin importar la configuración del proyecto
  const a = ['-s', sandbox, '-a', approval, '-m', route.model];
  if (route.effort) a.push('-c', `model_reasoning_effort="${route.effort}"`);
  return a;
}
