import { classify } from './classify.mjs';
import { route } from './router.mjs';
import { loadBacklog, saveBacklog } from './store.mjs';

const now = () => new Date().toISOString();
const keys = (id) => ({
  plan: `harness/${id}/plan`,
  design: `harness/${id}/design`,
  impl: `harness/${id}/impl-report`,
  review: `harness/${id}/review`,
});

export function addTask(root, profile, { id, title, category, paths = [] }) {
  const b = loadBacklog(root);
  if (b.tasks[id]) throw new Error(`la tarea ${id} ya existe`);
  const c = classify(profile, category, paths);
  if (!c.ok) throw new Error(c.errors.join('; '));
  b.tasks[id] = {
    id, title, category, paths, tier: c.tier, ui: c.ui, commit: c.commit, branch: `${c.branch}${id}`, base: c.base,
    status: 'proposed', attempts: 0, designed: false, visualDone: false, executor: null, gate: null,
    history: [{ ts: now(), event: 'added' }],
  };
  saveBacklog(root, b);
  return b.tasks[id];
}

// Transiciones. Solo el script marca done: ningún agente lo hace.
function transition(profile, t, event, data = {}) {
  const retry = () => {
    if (t.attempts < profile.retries) { t.attempts += 1; t.status = 'executing'; } else t.status = 'blocked';
  };
  switch (`${t.status}:${event}`) {
    case 'proposed:approve': t.status = 'approved'; t.approvedBy = data.by || 'human'; t.baseline = data.baseline || {}; break;
    case 'approved:design_done': t.designed = true; t.attempts = 0; break;
    case 'approved:design_failed': // el designer terminó sin dejar nada: cuenta como intento fallido
      if (t.attempts < profile.retries) t.attempts += 1; else t.status = 'blocked';
      break;
    case 'approved:exec_started':
    case 'executing:exec_started': t.status = 'executing'; t.executor = data.provider || t.executor; break;
    case 'executing:exec_done': t.status = 'gating'; break;
    // Fallback legítimo a otro proveedor: queda registrado quién ejecutó, y de ahí sale que el reviewer sea de la otra familia.
    case 'executing:fallback':
    case 'gating:fallback': t.executor = data.provider; t.status = 'executing'; break;
    case 'executing:exec_failed': retry(); break; // el executor terminó sin dejar nada: cuenta como intento fallido
    case 'gating:gate_pass': t.gate = 'pass'; t.status = 'gated'; break;
    case 'gating:gate_fail': t.gate = 'fail'; retry(); break;
    case 'gated:visual_done': t.visualDone = true; break;
    case 'gated:review_started': t.status = 'reviewing'; break;
    case 'reviewing:verdict_approved': t.status = 'done'; break;
    case 'reviewing:verdict_rejected': retry(); break;
    case 'blocked:human_retry': t.attempts = 0; t.status = 'executing'; break;
    case 'blocked:human_cancel': t.status = 'cancelled'; break;
    default: throw new Error(`evento ${event} no válido en estado ${t.status}`);
  }
  // T0 sin UI: basta el gate (7.2). El script cierra la tarea.
  if (t.status === 'gated' && t.tier === 'T0' && (!t.ui || t.visualDone)) t.status = 'done';
}

export function applyEvent(root, profile, id, event, data) {
  const b = loadBacklog(root);
  const t = b.tasks[id];
  if (!t) throw new Error(`tarea desconocida: ${id}`);
  transition(profile, t, event, data);
  t.history.push({ ts: now(), event, ...(data?.provider ? { provider: data.provider } : {}) });
  saveBacklog(root, b);
  return t;
}

// Dice cuál es el siguiente paso. El planner lanza al agente; esto no es un LLM.
export function nextStep(profile, t, opts = {}) {
  const k = keys(t.id);
  const r = (role) => route(profile, role, { tier: t.tier, attempt: t.attempts, executorProvider: t.executor, ...opts });
  // events: qué registrar al lanzar y al terminar (`harness task event <id> <evento>`). Lo aplica el planner o `harness exec`.
  const EVENTS = {
    executor: { start: 'exec_started', done: 'exec_done' },
    reviewer: { start: 'review_started', done: 'verdict_approved | verdict_rejected' },
    designer: { start: null, done: 'design_done' },
    explore: { start: null, done: null },
  };
  const run = (role, extra = {}) => {
    const rt = r(role);
    if (rt.wait) return { action: 'wait', ...rt };
    const events = extra.phase === 'visual' ? { start: null, done: 'visual_done' } : EVENTS[role];
    return { action: 'run', role, route: rt, refs: k, task: t.id, events, ...extra };
  };
  // La verificación visual de la UI real necesita un navegador: si el designer corre en Codex (sin Chrome), la hace el QA en Claude Code.
  const visualRole = profile.models.designer?.use === 'codex' ? 'reviewer' : 'designer';
  switch (t.status) {
    case 'proposed': return { action: 'await_approval', task: t.id, tier: t.tier, category: t.category };
    case 'approved':
      if (t.ui && !t.designed) return run('designer', { phase: 'spec' });
      return run('executor');
    case 'executing': return run('executor');
    case 'gating': return { action: 'gate', task: t.id };
    case 'gated':
      if (t.ui && !t.visualDone) return run(visualRole, { phase: 'visual' });
      return run('reviewer');
    case 'reviewing': return run('reviewer');
    case 'blocked': return { action: 'human', task: t.id, reason: `agotó ${profile.retries + 1} intento(s)` };
    default: return { action: 'none', status: t.status };
  }
}
