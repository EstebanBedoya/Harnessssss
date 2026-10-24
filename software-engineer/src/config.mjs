import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolvePi } from './pi.mjs';

// Capas de configuración: DEFAULT_PROFILE < global (~/.config/harness/config.json) < proyecto (.harness/profile.json).
export const globalConfigFile = (env = process.env, home = homedir()) =>
  env.HARNESS_CONFIG || join(env.XDG_CONFIG_HOME || join(home, '.config'), 'harness', 'config.json');

export const readJsonFile = (file) => { try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}; } catch { return {}; } };

// Runners que el harness conoce. `exec`: ¿`harness exec` sabe lanzarlo en headless? (claude no: corre como subagente que lanza el planner).
export const RUNNERS = {
  claude: { bin: 'claude', exec: false, note: 'subagente de Claude Code (lo lanza el planner)' },
  pi: { bin: 'pi', exec: true, note: 'headless con `harness exec`; admite varios proveedores (/login en pi)', install: 'npm i -g --ignore-scripts @earendil-works/pi-coding-agent' },
  codex: { bin: 'codex', exec: true, note: '`codex exec` headless con `harness exec`', install: 'instala Codex CLI' },
  antigravity: { bin: 'agy', exec: true, note: '`agy --print` headless con `harness exec` (Gemini, Claude y GPT-OSS con tu cuenta Google)', install: 'brew install --cask antigravity-cli' },
  opencode: { bin: 'opencode', exec: true, note: '`opencode run` headless con `harness exec`', install: 'instala opencode' },
};
export const ROLES = ['planner', 'executor', 'reviewer', 'designer', 'explore'];
// `main` solo reasigna estos: el designer (Claude Design + Chrome) y explore (Haiku) se quedan donde están salvo que se pida.
export const MAIN_ROLES = ['planner', 'executor', 'reviewer'];

// Dónde instalar lo que falta. Herdr: brew; pi: npm (Node ≥ 22.19).
export const INSTALL = { herdr: 'brew install herdr', pi: RUNNERS.pi.install };

// pi se busca con resolvePi (PI_BIN, PATH, nvm): en muchas máquinas es una función de shell y `which` no lo ve.
export function detectEnvironment(profile = {}, { which = (b) => spawnSync('which', [b]).status === 0, findPi = () => resolvePi(profile) } = {}) {
  const runners = Object.fromEntries(Object.entries(RUNNERS).map(([k, v]) => [k, k === 'pi' ? !!findPi() : which(v.bin)]));
  return { herdr: which('herdr'), runners, install: { ...(which('herdr') ? {} : { herdr: INSTALL.herdr }), ...(runners.pi ? {} : { pi: INSTALL.pi }) } };
}

// Familia del modelo: lo que importa para que quien revisa no sea quien escribió. null = no se puede saber.
export function familyOf(provider, model) {
  const m = String(model || '').toLowerCase();
  if (m) {
    if (/claude|anthropic|opus|sonnet|haiku/.test(m)) return 'anthropic';
    if (/gpt|codex|openai|\bo[134](-|$)/.test(m)) return 'openai';
    if (/gemini|google|gemma/.test(m)) return 'google';
    if (/grok|xai/.test(m)) return 'xai';
    if (/deepseek/.test(m)) return 'deepseek';
    if (/qwen|alibaba/.test(m)) return 'qwen';
    if (/mistral|codestral/.test(m)) return 'mistral';
    if (/llama|meta/.test(m)) return 'meta';
    return null;
  }
  if (provider === 'claude') return 'anthropic';
  if (provider === 'codex') return 'openai';
  return null;
}

// ¿Comparten familia? Desconocida contra desconocida solo cuenta como igual si es el mismo runner (no se puede probar que difieran).
export function sameFamily(a, b) {
  const fa = familyOf(a.provider, a.model); const fb = familyOf(b.provider, b.model);
  if (fa || fb) return fa === fb;
  return a.provider === b.provider;
}

// Avisos de la config resultante: reviewer de la misma familia que el executor, runner no instalado, runner sin lanzador.
export function checkProfile(profile, env) {
  const w = [];
  const { executor: e, reviewer: r } = profile.models;
  if (e && r && sameFamily(e, r)) {
    const f = familyOf(e.provider, e.model);
    w.push(`el reviewer y el executor son de la misma familia${f ? ` (${f})` : ''}: usa otro modelo para revisar${r.crossFamily ? ' (hay crossFamily configurado, pero solo entra si el executor cae a otro proveedor)' : ''}`);
  }
  for (const [role, m] of Object.entries(profile.models)) {
    if (!RUNNERS[m.provider]) w.push(`${role}: runner desconocido "${m.provider}" (válidos: ${Object.keys(RUNNERS).join(', ')})`);
    else if (env && env.runners[m.provider] === false) w.push(`${role}: ${m.provider} no está instalado`);
    if (m.provider === 'pi' && m.model && !m.model.includes('/')) w.push(`${role}: el modelo de pi se escribe proveedor/id (recibí "${m.model}")`);
  }
  return w;
}

// Aplica `main` a los roles que nadie asignó de forma explícita (en ninguna capa). Devuelve una copia.
export function applyMain(profile, explicit) {
  const main = profile.main;
  if (!main) return profile;
  const models = { ...profile.models };
  for (const role of MAIN_ROLES) {
    if (explicit?.models?.[role]?.provider !== undefined) continue;
    models[role] = { ...models[role], provider: main, model: explicit?.models?.[role]?.model ?? null };
  }
  return { ...profile, models };
}

// Parche mínimo para asignar un rol (se escribe con setValue, nunca se vuelcan los defaults).
export function rolePatch(role, { runner, model = null, effort }) {
  const p = { [`models.${role}.provider`]: runner, [`models.${role}.model`]: model };
  if (effort !== undefined) p[`models.${role}.effort`] = effort;
  return p;
}

// Valores recomendados para `--yes`: lo que ya trae DEFAULT_PROFILE, más el runner principal si se pide.
export function recommendedPatch({ main = null } = {}) {
  return main ? { main } : {};
}

// Modelos de pi: `pi --list-models` imprime una tabla "provider model context ...".
export function parsePiModels(text) {
  return String(text || '').split('\n').slice(1).map((l) => l.trim().split(/\s+/)).filter((c) => c.length >= 2 && c[0] !== 'provider').map((c) => ({ provider: c[0], id: c[1], model: `${c[0]}/${c[1]}` }));
}
export function listPiModels(bin) {
  const r = spawnSync(bin, ['--list-models'], { encoding: 'utf8', timeout: 15000, env: { ...process.env, PATH: `${dirname(bin)}:${process.env.PATH || ''}` } });
  return r.status === 0 ? parsePiModels(r.stdout) : [];
}
