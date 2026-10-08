import { spawnSync } from 'node:child_process';

// ¿Salió bien una corrida de Codex? Que vuelva a `idle` no prueba nada, y una respuesta `FAILED` es un fallo aunque exista el archivo.
//  - respuesta que empieza por FAILED -> fallo (con su motivo);
//  - respuesta no vacía -> bien;
//  - sin respuesta: bien solo si hubo cambios reales (el executor puede olvidar escribir su línea), nunca para `explore`.
export function judgeRun({ role, reply, changed }) {
  const text = String(reply || '').trim();
  if (/^FAILED\b/i.test(text)) return { ok: false, reason: text.slice(0, 240) };
  if (text) return { ok: true };
  if (role !== 'explore' && changed) return { ok: true, reason: 'cambios sin línea de respuesta' };
  return { ok: false, reason: 'terminó sin responder ni dejar cambios' };
}

// El MCP de Pencil habla con la APP de escritorio; sin ella cada llamada falla ("WebSocket not connected").
// La app se renombró a Pen.app (pen.dev); se aceptan ambos nombres.
// Los servidores MCP sueltos (`mcp-server-darwin-arm64`) no cuentan: solo el ejecutable de la app.
export function pencilAppRunning(listProcesses = () => spawnSync('ps', ['-axo', 'command'], { encoding: 'utf8' }).stdout || '') {
  return listProcesses().split('\n').some((l) => /\/(Pencil|Pen)\.app\/Contents\/MacOS\//.test(l));
}
