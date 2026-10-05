import { EFFORTS } from './defaults.mjs';

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
export function route(profile, role, { tier = 'T1', attempt = 0, executorProvider = null, available = ['claude', 'codex'] } = {}) {
  const m = profile.models[role];
  if (!m) return { error: `rol desconocido: ${role}` };
  let entry = m;
  if (role === 'designer') entry = m[m.use]; // `use` elige entre la variante de Codex (Pencil) y la de Claude (Claude Design)
  if (role === 'reviewer' && executorProvider && executorProvider === m.provider) {
    // El revisor nunca es de la misma familia que el executor (6.3 obs. 5). Solo pasa si un humano registró un fallback.
    if (!m.crossFamily) return { wait: true, reason: `el reviewer no puede ser ${m.provider}: ejecutó esa familia y no hay revisor de otra familia configurado` };
    entry = m.crossFamily;
  }
  if (!entry?.provider) return { error: `rol ${role} mal configurado` };
  if (!available.includes(entry.provider)) {
    const why = role === 'executor' ? 'el executor solo corre en Codex y no hay fallback a Claude: el planner se detiene y avisa' : `${entry.provider} no disponible para ${role}`;
    return { wait: true, reason: why };
  }
  return { role, ...pick(entry, tier, attempt) };
}
