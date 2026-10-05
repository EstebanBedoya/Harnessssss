// A qué tarea del harness pertenece un instante: las ventanas salen del historial del backlog (de `added` al último evento).
const GRACE_MS = 120_000;

export function taskWindows(backlog, now = Date.now()) {
  return Object.values(backlog.tasks || {}).map((t) => {
    const from = Date.parse(t.history[0].ts);
    const last = Date.parse(t.history.at(-1).ts);
    const open = !['done', 'cancelled'].includes(t.status);
    return { id: t.id, from, to: (open ? now : last) + GRACE_MS };
  });
}

// Si dos ventanas se solapan gana la tarea que empezó más tarde (la que está en curso). Sin ventana: ''.
export function taskAt(windows, tsMs) {
  let best = null;
  for (const w of windows) if (tsMs >= w.from && tsMs <= w.to && (!best || w.from > best.from)) best = w;
  return best ? best.id : '';
}
