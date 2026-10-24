import { emitKeypressEvents } from 'node:readline';

// Menús de terminal sin dependencias: flechas para moverse, Enter para elegir, Esc o Ctrl+C para cancelar, y en las listas
// largas basta teclear para filtrar. La lógica (reducer y render) es pura y se prueba sin terminal; `createUI` solo la conecta al TTY.

export class Cancelled extends Error { constructor() { super('cancelado'); this.name = 'Cancelled'; } }

const norm = (s) => String(s).toLowerCase();
export const visibleOptions = (st) => (st.filterable && st.filter ? st.options.filter((o) => norm(`${o.label} ${o.hint || ''}`).includes(norm(st.filter))) : st.options);

export function initSelect({ options, initial = 0, pageSize = 10, filterable = false }) {
  const st = { options, filterable, pageSize, filter: '', cursor: 0, top: 0 };
  const start = typeof initial === 'number' ? initial : options.findIndex((o) => o.value === initial);
  st.cursor = Math.max(0, Math.min(start, options.length - 1));
  return settle(st, 1);
}

// Mantiene el cursor sobre una opción habilitada y dentro de la ventana visible.
function settle(st, dir) {
  const vis = visibleOptions(st);
  let c = Math.max(0, Math.min(st.cursor, vis.length - 1));
  while (vis[c]?.disabled && c + dir >= 0 && c + dir < vis.length) c += dir;
  if (vis[c]?.disabled) { c = vis.findIndex((o) => !o.disabled); if (c < 0) c = 0; }
  let top = st.top;
  if (c < top) top = c;
  if (c >= top + st.pageSize) top = c - st.pageSize + 1;
  return { ...st, cursor: c, top: Math.max(0, Math.min(top, Math.max(0, vis.length - st.pageSize))) };
}

// key: { name, ctrl, sequence } como lo entrega readline. Devuelve { state } | { done: valor } | { cancel: true }.
export function reduceSelect(st, key) {
  const vis = visibleOptions(st);
  if (key.ctrl && key.name === 'c') return { cancel: true };
  switch (key.name) {
    case 'escape': return st.filter ? { state: settle({ ...st, filter: '', cursor: 0 }, 1) } : { cancel: true };
    case 'return': { const o = vis[st.cursor]; return o && !o.disabled ? { done: o.value } : { state: st }; }
    case 'up': return { state: settle({ ...st, cursor: st.cursor - 1 }, -1) };
    case 'down': return { state: settle({ ...st, cursor: st.cursor + 1 }, 1) };
    case 'pageup': return { state: settle({ ...st, cursor: st.cursor - st.pageSize }, -1) };
    case 'pagedown': return { state: settle({ ...st, cursor: st.cursor + st.pageSize }, 1) };
    case 'home': return { state: settle({ ...st, cursor: 0 }, 1) };
    case 'end': return { state: settle({ ...st, cursor: vis.length - 1 }, -1) };
    case 'backspace': return st.filterable ? { state: settle({ ...st, filter: st.filter.slice(0, -1), cursor: 0, top: 0 }, 1) } : { state: st };
    default:
      if (st.filterable && key.sequence && key.sequence.length === 1 && key.sequence >= ' ' && !key.ctrl && !key.meta) return { state: settle({ ...st, filter: st.filter + key.sequence, cursor: 0, top: 0 }, 1) };
      return { state: st };
  }
}

// Filas físicas que ocupan unas líneas en una terminal de `cols` columnas: una línea larga se parte en varias y, al redibujar,
// hay que subir por filas, no por líneas (si no, cada tecla deja un residuo del título en pantalla).
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
export const physicalRows = (lines, cols = 80) => lines.reduce((n, l) => n + Math.max(1, Math.ceil([...l.replace(ANSI, '')].length / Math.max(1, cols))), 0);

const C = { dim: '\x1b[2m', cyan: '\x1b[36m', bold: '\x1b[1m', off: '\x1b[0m' };
export function renderSelect(st, message, { color = true } = {}) {
  const c = (code, t) => (color ? `${code}${t}${C.off}` : t);
  const vis = visibleOptions(st);
  const L = [`${c(C.bold, '?')} ${c(C.bold, message)}${st.filter ? c(C.dim, `  filtro: ${st.filter}`) : ''}`];
  if (!vis.length) L.push(c(C.dim, '  (nada coincide con el filtro)'));
  vis.slice(st.top, st.top + st.pageSize).forEach((o, i) => {
    const on = st.top + i === st.cursor;
    const text = `${o.label}${o.hint ? `  ${c(C.dim, o.hint)}` : ''}`;
    L.push(on ? `${c(C.cyan, '❯')} ${c(C.cyan, o.label)}${o.hint ? `  ${c(C.dim, o.hint)}` : ''}` : `  ${o.disabled ? c(C.dim, text) : text}`);
  });
  const more = vis.length > st.pageSize ? ` · ${st.cursor + 1}/${vis.length}` : '';
  L.push(c(C.dim, `  ↑↓ mover · Enter elegir · Esc cancelar${st.filterable ? ' · teclea para filtrar' : ''}${more}`));
  return L;
}

export function reduceText(st, key) {
  if (key.ctrl && key.name === 'c') return { cancel: true };
  if (key.name === 'escape') return { cancel: true };
  if (key.name === 'return') return { done: st.value };
  if (key.name === 'backspace') return { state: { value: st.value.slice(0, -1) } };
  if (key.sequence && key.sequence.length === 1 && key.sequence >= ' ' && !key.ctrl && !key.meta) return { state: { value: st.value + key.sequence } };
  return { state: st };
}

// ---------- terminal real ----------

export function createUI({ input = process.stdin, output = process.stdout } = {}) {
  const color = !!output.isTTY && !process.env.NO_COLOR;
  emitKeypressEvents(input, { escapeCodeTimeout: 50 }); // por defecto un Esc solo tarda 500 ms en reconocerse (podría ser el inicio de una flecha)
  const wasRaw = input.isRaw;

  // Dibuja `lines`, y por cada tecla recalcula; al terminar deja una sola línea con la respuesta.
  const loop = (draw, step, summary, cancelValue) => new Promise((resolve, reject) => {
    let drawn = 0; // filas físicas del último dibujo
    const cols = () => output.columns || 80;
    const paint = (lines) => { if (drawn) output.write(`\x1b[${drawn}A\x1b[J`); output.write(`${lines.join('\n')}\n`); drawn = physicalRows(lines, cols()); };
    const end = (line) => { if (drawn) output.write(`\x1b[${drawn}A\x1b[J`); if (line) output.write(`${line}\n`); input.setRawMode?.(!!wasRaw); input.pause(); input.off('keypress', onKey); };
    let st = step.init;
    const onKey = (_s, key = {}) => {
      const r = step.reduce(st, key);
      if (r.cancel) { end(); if (cancelValue !== undefined) resolve(cancelValue); else reject(new Cancelled()); return; }
      if ('done' in r) { end(summary(r.done)); resolve(r.done); return; }
      st = r.state; paint(draw(st));
    };
    input.setRawMode?.(true); input.resume(); input.on('keypress', onKey);
    paint(draw(st));
  });

  return {
    // cancelValue: si se da, Esc devuelve ese valor (p. ej. «volver») en vez de cancelar todo el asistente.
    async select({ message, options, initial = 0, pageSize = 10, filterable = false, cancelValue, quiet = false }) {
      const init = initSelect({ options, initial, pageSize, filterable });
      return loop((st) => renderSelect(st, message, { color }), { init, reduce: reduceSelect },
        (v) => (quiet ? '' : `${color ? C.cyan : ''}✔${color ? C.off : ''} ${message}  ${options.find((o) => o.value === v)?.label ?? v}`), cancelValue);
    },
    async text({ message, initial = '', quiet = false }) {
      return loop((st) => [`? ${message}: ${st.value}${color ? `${C.dim}▏${C.off}` : ''}`, `${color ? C.dim : ''}  Enter confirma · Esc cancela${color ? C.off : ''}`],
        { init: { value: initial }, reduce: reduceText }, (v) => (quiet ? '' : `${color ? C.cyan : ''}✔${color ? C.off : ''} ${message}  ${v || '(vacío)'}`));
    },
    note: (msg) => output.write(`${msg}\n`),
  };
}
