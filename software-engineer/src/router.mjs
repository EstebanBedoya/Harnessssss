import { EFFORTS } from './defaults.mjs';
import { RUNNERS, sameFamily } from './config.mjs';

const bump = (effort) => {
  if (!effort) return effort;
  const i = EFFORTS.indexOf(effort);
  return EFFORTS[Math.min(i + 1, EFFORTS.indexOf('xhigh'))];
};

const pick = (entry, tier, attempt) => {
  const base = entry.effort ? entry.effort[tier] : null;
  return {
    provider: entry.provider,
    model: entry.model,
    effort: attempt > 0 ? bump(base) : base, // un reintento sube un nivel, como máximo a xhigh
  };
};

// available: proveedores con capacidad confirmada (Engram, cuota). Es una señal de entrada, no se infiere aquí.
export function route(profile, role, { tier = 'T1', attempt = 0, executorProvider = null, executorModel = null, available = Object.keys(RUNNERS) } = {}) {
  const m = profile.models[role];
  if (!m) return { error: `rol desconocido: ${role}` };
  let entry = m;
  if (role === 'reviewer' && executorProvider) {
    // El revisor nunca es de la misma familia que el executor (6.3 obs. 5): se compara la familia del modelo, no el runner
    // (pi con codex y pi con gemini sí son familias distintas). Un fallback registrado cambia lo que ejecutó.
    const configured = profile.models.executor;
    const executed = { provider: executorProvider, model: executorModel ?? (executorProvider === configured?.provider ? configured.model : null) };
    if (sameFamily(executed, m)) {
      if (!m.crossFamily) return { wait: true, reason: `el reviewer no puede ser de la misma familia que el executor (${executorProvider}${executed.model ? `/${executed.model}` : ''}) y no hay revisor de otra familia configurado` };
      entry = m.crossFamily;
    }
  }
  if (!entry?.provider) return { error: `rol ${role} mal configurado` };
  if (!available.includes(entry.provider)) {
    const why = role === 'executor' ? `el executor está configurado en ${entry.provider} y no hay fallback a Claude: el planner se detiene y avisa` : `${entry.provider} no disponible para ${role}`;
    return { wait: true, reason: why };
  }
  return { role, ...pick(entry, tier, attempt) };
}
