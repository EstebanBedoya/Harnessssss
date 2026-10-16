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

const ALL_EVENTS = ['approve', 'design_done', 'design_failed', 'exec_started', 'exec_done', 'exec_failed', 'fallback', 'gate_pass', 'gate_fail', 'visual_done', 'review_started', 'verdict_approved', 'verdict_rejected', 'redesign', 'human_retry', 'human_cancel'];
// Eventos que el estado actual acepta (se prueban sobre una copia).
export const validEvents = (profile, t) => ALL_EVENTS.filter((e) => { try { transition(profile, structuredClone(t), e, {}, true); return true; } catch { return false; } });

// Transiciones. Solo el script marca done: ningún agente lo hace.
function transition(profile, t, event, data = {}, probe = false) {
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
    // Volver a diseñar con la tarea ya aprobada o avanzada: el designer corre otra vez y el executor repite tras él.
    case 'approved:redesign': case 'executing:redesign': case 'gating:redesign': case 'gated:redesign': case 'blocked:redesign':
      t.designed = false; t.visualDone = false; t.gate = null; t.attempts = 0; t.status = 'approved'; break;
    case 'blocked:human_retry': t.attempts = 0; t.status = 'executing'; break;
    case 'blocked:human_cancel': t.status = 'cancelled'; break;
    default: throw new Error(`evento ${event} no válido en estado ${t.status}; válidos: ${probe ? '' : validEvents(profile, t).join(', ') || '(ninguno)'}`);
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
  // La verificación visual de la UI real necesita un navegador: la hace el designer (Claude, con Chrome).
  const visualRole = 'designer';
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

// Agrega o quita rutas del alcance de una tarea sin editar backlog.json a mano (`tasks` está indexado por id).
export function setTaskPaths(root, profile, id, { add = [], remove = [] }) {
  const b = loadBacklog(root);
  const t = b.tasks[id];
  if (!t) throw new Error(`tarea desconocida: ${id}`);
  const paths = [...new Set([...t.paths.filter((p) => !remove.includes(p)), ...add])];
  const c = classify(profile, t.category, paths);
  if (!c.ok) throw new Error(c.errors.join('; '));
  t.paths = paths; t.tier = c.tier; t.ui = c.ui; // el alcance nuevo puede subir el tier o activar la UI
  t.history.push({ ts: now(), event: 'paths_changed', ...(add.length ? { add } : {}), ...(remove.length ? { remove } : {}) });
  saveBacklog(root, b);
  return t;
}
