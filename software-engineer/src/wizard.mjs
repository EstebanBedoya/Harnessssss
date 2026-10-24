import { EFFORTS } from './defaults.mjs';
import { RUNNERS, ROLES, checkProfile, familyOf, rolePatch } from './config.mjs';

const TIERS = ['T0', 'T1', 'T2'];
const [DEFAULT, CUSTOM, KEEP, PER_TIER] = ['__default', '__custom', '__keep', '__per_tier'];
const [SAVE, QUIT, BACK] = ['__save', '__quit', '__back'];
const MODEL_AUTH = new Set(['pi', 'opencode']); // runners cuya sesión depende del modelo elegido

// Esfuerzo: completo («T0 medium · T1 high · T2 high») o corto para la lista («medium/high/high»); igual en los tres tiers: «high».
const same = (e) => new Set(Object.values(e)).size === 1;
export const fmtEffort = (e) => (!e ? 'sin esfuerzo' : same(e) ? Object.values(e)[0] : TIERS.map((t) => `${t} ${e[t]}`).join(' · '));
const shortEffort = (e) => (!e ? 'sin esfuerzo' : same(e) ? Object.values(e)[0] : TIERS.map((t) => e[t]).join('/'));
const modelText = (m) => m ?? 'default del runner';
export const fmtAgent = (m) => `${m.provider} · ${modelText(m.model)} · ${fmtEffort(m.effort)}`;

// Asistente: una lista de agentes; al elegir uno se ve su configuración (runner, modelo, esfuerzo) y se cambia campo por campo.
// `ui` ofrece select({message, options:[{value,label,hint,disabled}], initial, filterable, cancelValue}) y text({message, initial})
// (ver prompt.mjs); en pruebas se inyecta uno guionizado. No escribe nada: devuelve { patches } para que quien lo llama
// los guarde en la capa elegida (global o proyecto). Con `yes` no pregunta: queda el reparto recomendado.
export async function runWizard({ profile, env, listModels = () => [], auth = null, ui, say = () => {}, yes = false }) {
  if (yes) return { patches: {}, warnings: checkProfile(profile, env) };

  const edited = {}; // rol -> { provider?, model?, effort? } con lo que el usuario cambió
  const cur = (role) => ({ ...profile.models[role], ...edited[role] });
  const view = () => ({ ...profile, models: Object.fromEntries(Object.keys(profile.models).map((r) => [r, cur(r)])) });
  const set = (role, patch) => { edited[role] = { ...edited[role], ...patch }; };
  const changedRoles = () => ROLES.filter((r) => edited[r] && JSON.stringify(cur(r)) !== JSON.stringify(profile.models[r]));
  const runnerOptions = Object.entries(RUNNERS).map(([k, v]) => ({ value: k, label: k, hint: env.runners[k] ? v.note : 'no instalado', disabled: !env.runners[k] }));
  // opencode no recibe el esfuerzo (su --variant depende del proveedor) y explore (Haiku) no lo admite: no se ofrece.
  const effortApplies = (role) => cur(role).provider !== 'opencode' && profile.models[role].effort !== null;

  // Tras elegir runner/modelo: si no hay sesión iniciada, se ofrece iniciarla ahora (no bloquea: se puede seguir sin sesión).
  const ensureAuth = async (role) => {
    if (!auth) return;
    const m = cur(role);
    const st = auth.check(m.provider, m.model);
    if (st.state !== 'missing') { if (st.state === 'ok' && st.detail) say(`✓ sesión en ${m.provider}: ${st.detail}`); return; }
    const choice = await ui.select({
      quiet: true, message: `${role}: no has iniciado sesión en ${m.provider}${st.detail ? ` (${st.detail})` : ''}`,
      options: [{ value: 'login', label: 'Iniciar sesión ahora', hint: st.login?.hint }, { value: 'later', label: 'Seguir sin sesión', hint: 'hazlo antes de usar este agente: harness login ' + m.provider }],
      cancelValue: 'later',
    });
    if (choice !== 'login') { say(`aviso: ${role} usa ${m.provider} sin sesión; antes de usarlo: harness login ${m.provider}`); return; }
    const r = await auth.login(m.provider, m.model);
    say(r.ok ? `✓ sesión iniciada en ${m.provider}` : `aviso: sigues sin sesión en ${m.provider}; reintenta con: harness login ${m.provider}`);
  };

  const pickModel = async (role, runner, current) => {
    const known = listModels(runner);
    if (!known.length) return ((await ui.text({ quiet: true, message: `Modelo de ${role} (vacío = default de ${runner})`, initial: current || '' })) || '').trim() || null;
    const options = [
      { value: DEFAULT, label: `Default de ${runner}`, hint: runner === 'pi' ? 'el modelo que tenga pi configurado' : 'el modelo que traiga el runner' },
      ...known.map((m) => ({ value: m.model, label: m.model })),
      { value: CUSTOM, label: 'Escribir otro…' },
    ];
    const choice = await ui.select({ quiet: true, message: `${role} · modelo (${runner})`, options, filterable: true, initial: current && known.some((m) => m.model === current) ? current : DEFAULT });
    if (choice === DEFAULT) return null;
    if (choice === CUSTOM) return ((await ui.text({ quiet: true, message: `Modelo de ${role}${runner === 'pi' ? ' (proveedor/id)' : ''}` })) || '').trim() || null;
    return choice;
  };

  const pickEffort = async (role, current) => {
    const choice = await ui.select({ quiet: true,
      message: `${role} · esfuerzo de razonamiento`,
      options: [
        { value: KEEP, label: `Mantener (${fmtEffort(current)})` },
        ...EFFORTS.map((e) => ({ value: e, label: e, hint: { low: 'más rápido y barato', xhigh: 'solo para trabajo difícil', max: 'lo máximo; caro y lento' }[e] || '' })),
        { value: PER_TIER, label: 'Distinto por tier…', hint: 'T0 tarea simple · T1 normal · T2 riesgo alto' },
      ],
      initial: KEEP, cancelValue: KEEP,
    });
    if (choice === KEEP) return current;
    if (choice !== PER_TIER) return Object.fromEntries(TIERS.map((t) => [t, choice]));
    const e = {};
    for (const t of TIERS) e[t] = await ui.select({ quiet: true, message: `${role} · esfuerzo en ${t}`, options: EFFORTS.map((x) => ({ value: x, label: x })), initial: current[t] || 'high' });
    return e;
  };

  // Pantalla de un agente: su configuración como opciones; elegir una la cambia y vuelve aquí.
  const editAgent = async (role) => {
    let last = 0;
    for (;;) {
      const now = cur(role);
      const fields = [
        { value: 'runner', label: `Runner     ${now.provider}`, hint: env.runners[now.provider] ? '' : 'no instalado' },
        { value: 'model', label: `Modelo     ${modelText(now.model)}` },
        { value: 'effort', label: `Esfuerzo   ${fmtEffort(now.effort)}`, disabled: !effortApplies(role), hint: effortApplies(role) ? '' : 'no aplica' },
        { value: BACK, label: '← Volver a la lista' },
      ];
      const field = await ui.select({ quiet: true, message: `${role}${changedRoles().includes(role) ? '  (cambiado)' : ''}`, options: fields, initial: last, cancelValue: BACK });
      if (field === BACK) return;
      last = ['runner', 'model', 'effort'].indexOf(field);
      if (field === 'runner') {
        const runner = await ui.select({ quiet: true, message: `${role} · runner`, options: runnerOptions, initial: now.provider, cancelValue: now.provider });
        if (runner !== now.provider) {
          // La sesión se comprueba antes de listar modelos (sin sesión la lista ni se puede pedir), salvo en pi y opencode,
          // donde depende del modelo (el proveedor de pi; los opencode/* son gratis).
          set(role, { provider: runner, model: null }); // el modelo anterior ya no vale
          if (!MODEL_AUTH.has(runner)) await ensureAuth(role);
          set(role, { model: await pickModel(role, runner, null) });
          if (MODEL_AUTH.has(runner)) await ensureAuth(role);
          last = 1;
        }
      } else if (field === 'model') { set(role, { model: await pickModel(role, now.provider, now.model) }); if (MODEL_AUTH.has(now.provider)) await ensureAuth(role); }
      else set(role, { effort: await pickEffort(role, now.effort) });
      for (const w of checkProfile(view(), env)) say(`aviso: ${w}`);
    }
  };

  // Lista de agentes: cada fila muestra su configuración; elegir uno abre su pantalla.
  let last = 0;
  for (;;) {
    const changed = changedRoles();
    const rows = ROLES.map((r) => {
      const m = cur(r);
      return { value: r, label: `${r.padEnd(9)} ${m.provider} · ${modelText(m.model)} · ${shortEffort(m.effort)}`, hint: changed.includes(r) ? 'cambiado' : '' };
    });
    const choice = await ui.select({ quiet: true,
      message: 'Agentes — elige uno para ver y cambiar su configuración',
      options: [...rows, { value: SAVE, label: changed.length ? `✔ Guardar y salir (${changed.length} cambio${changed.length > 1 ? 's' : ''})` : '✔ Salir' }, ...(changed.length ? [{ value: QUIT, label: '✗ Salir sin guardar' }] : [])],
      initial: last, cancelValue: QUIT,
    });
    if (choice === SAVE) break;
    if (choice === QUIT) {
      if (!changed.length) return { patches: {}, changes: [], cancelled: true };
      const discard = await ui.select({ quiet: true, message: `Hay ${changed.length} cambio(s) sin guardar`, options: [{ value: false, label: 'Volver a la lista' }, { value: true, label: 'Descartar y salir' }], cancelValue: false });
      if (discard) return { patches: {}, changes: [], cancelled: true };
      continue;
    }
    last = ROLES.indexOf(choice);
    await editAgent(choice);
  }

  const patches = {};
  for (const r of changedRoles()) {
    const m = cur(r); const base = profile.models[r];
    if (m.provider !== base.provider || m.model !== base.model) Object.assign(patches, rolePatch(r, { runner: m.provider, model: m.model }));
    if (JSON.stringify(m.effort) !== JSON.stringify(base.effort)) patches[`models.${r}.effort`] = m.effort;
  }
  // Solo lo que cambió, campo por campo: «runner claude → antigravity».
  const changes = changedRoles().flatMap((r) => {
    const base = profile.models[r]; const m = cur(r);
    return [
      `  ${r}`,
      ...(m.provider !== base.provider ? [`    runner     ${base.provider} → ${m.provider}`] : []),
      ...(m.model !== base.model ? [`    modelo     ${modelText(base.model)} → ${modelText(m.model)}`] : []),
      ...(JSON.stringify(m.effort) !== JSON.stringify(base.effort) ? [`    esfuerzo   ${fmtEffort(base.effort)} → ${fmtEffort(m.effort)}`] : []),
    ];
  });
  return { patches, changes, warnings: checkProfile(view(), env), families: Object.fromEntries(ROLES.map((r) => [r, familyOf(cur(r).provider, cur(r).model)])) };
}
