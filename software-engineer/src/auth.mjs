import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { LAUNCHERS, resolveBin } from './runners.mjs';

// ¿Hay sesión iniciada en cada runner? Cada CLI lo dice a su manera; aquí se unifica en { state, detail, login }.
//   state: 'ok' | 'missing' (seguro que falta) | 'unknown' (no se pudo saber: red, versión): no bloquea nada.
//   login: cómo iniciarla { cmd, args, hint }; el login es interactivo (navegador o menú), lo corre el usuario en su terminal.

const defaultRun = (bin, args, { timeout = 20000, env = process.env } = {}) => {
  const r = spawnSync(bin, args, { encoding: 'utf8', timeout, env, stdio: ['ignore', 'pipe', 'pipe'] });
  return { status: r.error ? -1 : r.status, out: `${r.stdout || ''}${r.stderr || ''}`.trim() };
};

const binOf = (runner, profile) => (LAUNCHERS[runner] ? LAUNCHERS[runner].resolve(profile) : resolveBin(runner, { fixed: profile?.[runner]?.bin }));

// Proveedor de un modelo de pi («google/gemini-…» → google); sin modelo, el que pi tenga por defecto.
export function piProviderOf(model, { read = (f) => readFileSync(f, 'utf8'), exists = existsSync, home = homedir() } = {}) {
  if (model && model.includes('/')) return model.split('/')[0];
  const f = join(home, '.pi', 'agent', 'settings.json');
  try { return exists(f) ? JSON.parse(read(f)).defaultProvider || null : null; } catch { return null; }
}

export function loginInfo(runner, bin) {
  return {
    claude: { cmd: bin || 'claude', args: ['auth', 'login'], hint: 'se abre el navegador para entrar con tu cuenta de Anthropic' },
    pi: { cmd: bin || 'pi', args: [], hint: 'se abre pi: escribe /login y elige el proveedor (o exporta su API key, p. ej. GEMINI_API_KEY); luego sal de pi' },
    codex: { cmd: bin || 'codex', args: ['login'], hint: 'se abre el navegador para entrar con tu cuenta de ChatGPT' },
    opencode: { cmd: bin || 'opencode', args: ['auth', 'login'], hint: 'elige el proveedor y pega su credencial' },
    antigravity: { cmd: bin || 'agy', args: [], hint: 'se abre agy: inicia sesión con tu cuenta de Google en el navegador y ciérralo cuando termine (Ctrl+C)' },
  }[runner] || null;
}

export function checkAuth(runner, { profile = {}, model = null, run = defaultRun, bin = binOf(runner, profile), piProvider = piProviderOf } = {}) {
  const login = loginInfo(runner, bin);
  const done = (state, detail = '') => ({ runner, state, detail, login });
  if (!bin) return done('unknown', 'no está instalado');
  switch (runner) {
    case 'claude': {
      const r = run(bin, ['auth', 'status']);
      try { const j = JSON.parse(r.out); return j.loggedIn ? done('ok', j.authMethod) : done('missing'); } catch { return done('unknown'); }
    }
    case 'pi': {
      const provider = piProvider(model);
      if (!provider) return done('unknown', 'pi no tiene un proveedor por defecto');
      const r = run(bin, ['auth', 'check', '--provider', provider, '--json'], { env: { ...process.env, PATH: `${join(bin, '..')}:${process.env.PATH || ''}` } });
      try {
        const j = JSON.parse(r.out);
        if (j.status === 'ready') return done('ok', `${provider}${j.authType ? ` (${j.authType})` : ''}`);
        return j.status === 'not_ready' ? done('missing', `sin credenciales de ${provider}`) : done('unknown');
      } catch { return done('unknown'); }
    }
    case 'codex': {
      const r = run(bin, ['login', 'status']);
      if (r.status === 0) return done('ok', r.out.split('\n')[0]);
      return /not logged in|no.*credentials/i.test(r.out) || r.status === 1 ? done('missing') : done('unknown');
    }
    case 'opencode': {
      if (model && model.startsWith('opencode/')) return done('ok', 'modelo gratis: no necesita login');
      const m = run(bin, ['auth', 'list']).out.match(/(\d+)\s+credentials?/i);
      if (!m) return done('unknown');
      return Number(m[1]) > 0 ? done('ok', `${m[1]} credencial(es)`) : done('missing', 'sin credenciales (solo funcionan los modelos opencode/*)');
    }
    case 'antigravity': {
      const r = run(bin, ['models'], { timeout: 30000 });
      if (r.status === 0) return done('ok');
      return /sign in|log ?in|unauthor|credential/i.test(r.out) ? done('missing') : done('unknown', r.out.split('\n').pop().slice(0, 120));
    }
    default: return done('unknown');
  }
}

// Lanza el login del runner en la terminal del usuario (interactivo) y vuelve a comprobar.
export function runLogin(runner, opts = {}) {
  const st = checkAuth(runner, opts);
  if (!st.login || !st.login.cmd) return { ok: false, error: `no sé iniciar sesión en ${runner}` };
  const r = (opts.spawn || ((c, a) => spawnSync(c, a, { stdio: 'inherit', env: runner === 'pi' && opts.bin ? { ...process.env, PATH: `${join(opts.bin, '..')}:${process.env.PATH || ''}` } : process.env })))(st.login.cmd, st.login.args);
  const after = checkAuth(runner, opts);
  return { ok: after.state === 'ok', state: after.state, status: r.status, detail: after.detail };
}

// Una línea por runner: «✓ claude  sesión iniciada», «✗ antigravity  sin sesión → harness login antigravity».
export function formatAuth(rows) {
  const L = ['Sesión en los runners que usa tu configuración:'];
  for (const r of rows) {
    if (r.state === 'ok') L.push(`  ✓ ${r.runner.padEnd(12)} sesión iniciada${r.detail ? ` · ${r.detail}` : ''}`);
    else if (r.state === 'missing') L.push(`  ✗ ${r.runner.padEnd(12)} sin sesión${r.detail ? ` · ${r.detail}` : ''}  → harness login ${r.runner}`);
    else L.push(`  ? ${r.runner.padEnd(12)} no pude comprobarlo${r.detail ? ` · ${r.detail}` : ''}`);
  }
  return L.join('\n');
}
