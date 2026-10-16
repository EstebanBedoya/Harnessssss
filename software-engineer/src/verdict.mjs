// Error del proveedor (cuota, límite de uso, sesión caída): la corrida murió, no es una respuesta del agente.
export const providerError = (text) => /usage_limit_exceeded|usage limit|rate[_ ]limit|insufficient_quota|you've hit your .*limit/i.test(String(text || ''));

// ¿Salió bien una corrida de pi? Que vuelva a `idle` no prueba nada.
//  - error del proveedor -> fallo (la corrida murió), aunque haya archivos sucios;
//  - executor con commits nuevos sobre la base de la corrida -> bien, incluso si respondió FAILED (el gate decide si sirven);
//  - respuesta que empieza por FAILED -> fallo (con su motivo);
//  - respuesta no vacía -> bien;
//  - sin respuesta: el designer es bien si dejó archivos de diseño; el executor sin commits nunca (archivos sucios no prueban nada).
export function judgeRun({ role, reply, changed, commits = 0, screen = '' }) {
  const text = String(reply || '').trim();
  if (providerError(text) || (!text && providerError(screen))) return { ok: false, reason: `error del proveedor: ${(text || String(screen).trim().split('\n').filter((l) => providerError(l)).pop() || '').slice(0, 200)}` };
  if (role === 'executor' && commits > 0) return { ok: true, ...(/^FAILED\b/i.test(text) ? { reason: `respondió FAILED pero dejó ${commits} commit(s): decide el gate` } : {}) };
  if (/^FAILED\b/i.test(text)) return { ok: false, reason: text.slice(0, 240) };
  if (text) return { ok: true };
  if (role === 'designer' && changed) return { ok: true, reason: 'cambios sin línea de respuesta' };
  return { ok: false, reason: 'terminó sin responder ni dejar commits' };
}
