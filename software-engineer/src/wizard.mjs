import { MAIN_ROLES, RUNNERS, ROLES, checkProfile, familyOf, rolePatch } from './config.mjs';

const label = (m) => `${m.provider}${m.model ? ` · ${m.model}` : ''}`;

// Asistente de configuración. `ask(pregunta, porDefecto)` devuelve el texto escrito o el valor por defecto (Enter).
// No escribe nada: devuelve { patches, main } para que quien lo llama los guarde en la capa elegida (global o proyecto).
// Con `yes` no pregunta: queda el reparto recomendado (o el runner principal pedido).
export async function runWizard({ profile, env, piModels = [], ask, say = () => {}, yes = false, main: mainFlag = null }) {
  const patches = {};
  let main = mainFlag ?? profile.main ?? null;
  if (yes) return { patches, main, warnings: checkProfile(profile, env) };

  const installed = Object.entries(env.runners).filter(([, ok]) => ok).map(([k]) => k);
  say(`Runners instalados: ${installed.join(', ') || '(ninguno)'}${Object.entries(env.runners).filter(([, ok]) => !ok).length ? `; faltan: ${Object.entries(env.runners).filter(([, ok]) => !ok).map(([k]) => k).join(', ')}` : ''}`);

  const pickRunner = async (q, def) => {
    for (;;) {
      const a = (await ask(q, def)).trim().toLowerCase();
      if (!a || a === def) return def;
      if (RUNNERS[a]) return a;
      say(`  "${a}" no es un runner válido (${Object.keys(RUNNERS).join(', ')})`);
    }
  };

  // 1. Runner principal: el de los roles que no asignes de forma explícita. Enter = el reparto recomendado.
  const mainAns = (await ask(`Runner principal (${Object.keys(RUNNERS).join('/')}) para los roles sin asignar [Enter = reparto recomendado${main ? `, ahora: ${main}` : ''}]`, '')).trim().toLowerCase();
  if (mainAns && RUNNERS[mainAns]) main = mainAns;
  else if (mainAns) say(`  "${mainAns}" no es un runner válido; sigo sin cambiarlo`);
  if (main !== (profile.main ?? null)) patches.main = main;

  // 2. Rol por rol: runner y modelo. Enter conserva lo actual.
  const cur = (role) => ({ ...profile.models[role], ...(patches[`models.${role}.provider`] ? { provider: patches[`models.${role}.provider`], model: patches[`models.${role}.model`] } : {}) });
  const roles = [...MAIN_ROLES];
  if ((await ask('¿Configurar también designer y explore? (s/N)', 'n')).trim().toLowerCase().startsWith('s')) roles.push(...ROLES.filter((r) => !MAIN_ROLES.includes(r)));
  for (const role of roles) {
    const now = cur(role);
    say(`${role}: ${label(now)}`);
    const runner = await pickRunner(`  runner de ${role} [Enter = ${now.provider}]`, now.provider);
    let model = runner === now.provider ? now.model : null;
    if (runner === 'pi' && piModels.length) {
      const byProv = [...piModels.reduce((acc, m) => acc.set(m.provider, (acc.get(m.provider) || 0) + 1), new Map())].map(([p, n]) => `${p} (${n})`).join(', ');
      say(`  proveedores con sesión en pi: ${byProv}`);
    }
    const m = (await ask(`  modelo de ${role}${runner === 'pi' ? ' (proveedor/id; Enter = ' + (model ? model : 'el de pi') + ')' : ` [Enter = ${model || 'el del runner'}]`}`, '')).trim();
    if (m) {
      if (runner === 'pi' && piModels.length && !piModels.some((x) => x.model === m)) say(`  aviso: pi no lista "${m}"; si es de otro proveedor falta hacer /login en pi`);
      model = m;
    }
    if (runner !== profile.models[role].provider || model !== profile.models[role].model) Object.assign(patches, rolePatch(role, { runner, model }));
  }

  // 3. Avisos de la configuración resultante.
  const merged = { ...profile, models: Object.fromEntries(Object.keys(profile.models).map((r) => [r, cur(r)])) };
  const warnings = checkProfile(merged, env);
  for (const w of warnings) say(`aviso: ${w}`);
  return { patches, main, warnings, families: Object.fromEntries(roles.map((r) => [r, familyOf(cur(r).provider, cur(r).model)])) };
}
