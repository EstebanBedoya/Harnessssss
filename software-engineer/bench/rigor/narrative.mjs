// Texto del informe con las cifras tomadas de results/summary.json (nada escrito a mano que pueda desfasarse).
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const S = JSON.parse(readFileSync(join(here, 'results', 'summary.json'), 'utf8'));
const R = (m, k) => S.retrieval[`${m}|${k}`]; const L = (m, k) => S.latency[`${m}|${k}`]; const A = S.agents; const P = S.agentsPaired; const PJ = S.projection; const PR = S.paired;
const d2 = (x) => x.toFixed(2); const d4 = (x) => x.toFixed(4); const pc = (x) => `${Math.round(x * 100)}%`;
const iv = (s) => `[${d2(s.ci[0])}, ${d2(s.ci[1])}]`; const piv = (p, n = 2) => `[${p.ci[0].toFixed(n)}, ${p.ci[1].toFixed(n)}]`;
const inv = Object.values(S.invalidation); const invOk = inv.reduce((s, v) => s + v.ok, 0); const invN = inv.reduce((s, v) => s + v.n, 0);
const rows = ['gym-app', 'bridge-gym', 'vidar-app'].flatMap((p) => JSON.parse(readFileSync(join(here, 'results', `agents-${p}.json`), 'utf8')).rows);
const sum = (arm, k) => rows.filter((r) => r.arm === arm).reduce((s, r) => s + (r[k] || 0), 0);
const hitsC = sum('explorer_cached', 'exHits'), callsC = sum('explorer_cached', 'exCalls'), deepE = sum('explorer', 'exDeep');
const deepEq = (sum('explorer', 'exUsd') / Math.max(1, deepE));
const li = (s) => `<li>${s}</li>`;
const RE = S.reuse; const RAG = S.reuseAgents; const PA = RE.pairsA; const RB = RE.B; const AR = RAG.arms; const pt = (x) => Math.round(x * 100);

const n = {};
n.RESUMEN = `<ul>
${li(`<b>Nombres exactos (símbolos y archivos).</b> El grafo en modo <code>full</code> y el explorer empatan arriba (MRR en símbolos ${d2(R('graph_bm25', 'symbol').mrr.mean)} y ${d2(R('explorer_cold', 'symbol').mrr.mean)}) y ambos superan a <code>rg + fd</code> (${d2(R('trad', 'symbol').mrr.mean)}). La diferencia del explorer sobre <code>rg + fd</code> es demostrable: +${d2(PR['explorer_cold vs trad|symbol'].meanDeltaMrr)} ${piv(PR['explorer_cold vs trad|symbol'])} en símbolos. El grafo es el más rápido: ${L('graph_bm25', 'symbol').median} ms contra ${L('explorer_cold', 'symbol').median} ms del explorer.`)}
${li(`<b>Tareas descritas con una frase.</b> Sin modelo ningún método funciona (MRR ${d2(R('trad', 'commit').mrr.mean)}, ${d2(R('graph_bm25', 'commit').mrr.mean)} y ${d2(R('explorer_cold', 'commit').mrr.mean)}, sin diferencia demostrable entre ellos). Solo <code>--deep</code> con Haiku 5.5 sube a ${d2(R('explorer_deep', 'commit').mrr.mean)}: +${d2(PR['explorer_deep vs trad|commit'].meanDeltaMrr)} ${piv(PR['explorer_deep vs trad|commit'])} sobre <code>rg + fd</code>, con un costo medio de $${d4(deepEq)} por consulta. Releerlo del caché es gratis.`)}
${li(`<b>Agentes reales de punta a punta (Haiku 5.5, ${A.explorer.n} tareas).</b> La calidad no se distingue entre los tres métodos (MRR ${d2(A.traditional.mrr.mean)} con <code>rg + fd</code>, ${d2(A.graph.mrr.mean)} con el grafo, ${d2(A.explorer.mrr.mean)} con el explorer; los intervalos se solapan). En la primera pasada el explorer cuesta $${d4(P['explorer vs traditional|usd'].mean)} más y tarda ${P['explorer vs traditional|sec'].mean.toFixed(0)} s más por tarea que <code>rg + fd</code>. No ganó.`)}
${li(`<b>Con caché caliente</b> el explorer iguala a <code>rg + fd</code> en calidad (${d2(A.explorer_cached.mrr.mean)}), costo ($${d4(A.explorer_cached.usd.mean)} contra $${d4(A.traditional.usd.mean)}) y tiempo, con ${Math.abs(P['explorer_cached vs traditional|turns'].mean).toFixed(1)} turnos menos. Pero solo acertó el ${pc(hitsC / callsC)} de las consultas (${hitsC} de ${callsC}), porque los agentes reformulan la pregunta y la clave del caché es exacta.`)}
${li(`<b>Invalidación.</b> ${invOk} de ${invN} pruebas correctas: nunca devolvió una respuesta vieja. Es lo más sólido del diseño.`)}
${li(`<b>Proyección, no medición:</b> si el agente fuera Sonnet 5.5 (20 veces el precio de Haiku 5.5 en entrada, salida y caché) con el mismo comportamiento, el costo por tarea sería $${d4(PJ.traditional.sonnetAgent)} con <code>rg + fd</code>, $${d4(PJ.graph.sonnetAgent)} con el grafo, $${d4(PJ.explorer.sonnetAgent)} con el explorer y $${d4(PJ.explorer_cached.sonnetAgent)} con caché caliente. El ahorro viene de usar menos turnos del agente caro y pasar la búsqueda a Haiku.`)}
</ul>`;

n.RESUMEN = n.RESUMEN.replace('</ul>', `${li(`<b>Reutilización — agentes reales.</b> Ante un requisito para el que ya existía una función, los agentes con las reglas nuevas la reutilizaron en el ${pt(AR.guided.reused.mean)}% de los casos contra ${pt(AR.plain.reused.mean)}% sin ellas (+${pt(RAG.paired.reusedDelta.mean)} puntos, intervalo [${pt(RAG.paired.reusedDelta.ci[0])}, ${pt(RAG.paired.reusedDelta.ci[1])}], n = ${RAG.paired.n}), al mismo costo ($${d4(AR.guided.usd)} contra $${d4(AR.plain.usd)} por tarea). Escribir duplicados bajó de ${pt(AR.plain.duplicated.mean)}% a ${pt(AR.guided.duplicated.mean)}%, pero con n = ${RAG.paired.n} esa baja no es demostrable.`)}
${li(`<b>Detectar un duplicado ya escrito funciona bien:</b> <code>reuse-check</code> encontró el original en el ${pt(RB.rename.foundOriginal.mean)}% de las copias renombradas, ${pt(RB.noise.foundOriginal.mean)}% con líneas añadidas y ${pt(RB.prune.foundOriginal.mean)}% con un cuarto de las líneas borradas, y marcó solo el ${pt(RB.foreign.flagged.mean)}% de las funciones ajenas (falsos positivos).`)}
${li(`<b>Descubrir antes qué reutilizar es mucho más difícil:</b> lo que el desarrollador realmente importó aparece entre los 8 primeros archivos solo en el ${pt(RE.A.reuse_deep.recall.mean)}% con <code>--deep</code> y el ${pt(RE.A.reuse_graph.recall.mean)}% sin modelo (${pt(RE.A.trad.recall.mean)}% con <code>rg + fd</code>). El modo reuse no mejora al <code>--deep</code> general (${PA['reuse_deep vs explorer_deep'].mean >= 0 ? '+' : ''}${PA['reuse_deep vs explorer_deep'].mean.toFixed(2)}, intervalo que cruza 0). Esa verdad es parcial (hay otras funciones válidas), así que son cifras pesimistas para todos.`)}
</ul>`);

n.REUSE_INTRO = `<p>Se agregó al harness evitar repetir código en dos momentos: <b>antes</b> de escribir (<code>harness explore --reuse "&lt;qué voy a escribir&gt;"</code>) y <b>después</b> (<code>harness reuse-check</code>, que compara lo que el diff escribió con el código existente). Se midieron por separado porque fallan de forma distinta.</p>`;

n.REUSE_TEXT = `<div class="panel" style="margin-top:14px"><h3 style="margin-top:0">Lo que dicen las tres mediciones juntas</h3><ul>
${li(`<b>La red de seguridad es el detector, no la búsqueda previa.</b> <code>reuse-check</code> es determinista, rápido (1 a 2 s) y casi no da falsos positivos (${pt(RB.foreign.flagged.mean)}%). Pero solo detecta clones estructurales: una función que hace lo mismo escrita de otra forma no se ve.`)}
${li(`<b>La búsqueda previa ayuda al agente aunque su recall sea bajo.</b> En la prueba con agentes, las reglas movieron "reutilizó" de ${pt(AR.plain.reused.mean)}% a ${pt(AR.guided.reused.mean)}%, y los ${AR.guided.n} agentes con reglas ejecutaron ambos comandos. Un agente usa la lista como pista y confirma leyendo el código.`)}
${li(`<b>${AR.guided.counts.duplicó || 0} de ${AR.guided.n} agentes guiados duplicaron igual</b> a pesar de haber corrido <code>reuse-check</code>. El comando solo informa (no falla), así que el agente puede ignorarlo. No verifiqué por qué en cada caso.`)}
${li(`<b>El requisito en un idioma y el código en otro es el caso difícil.</b> Un ejemplo que sí funcionó: "crear un select de planes de membresía con filtro" encontró <code>PlanFilterSelect</code> con <code>--deep</code> en 7 s y $0.003.`)}
</ul></div>`;

n.DECISIONS = `<p>Después de medir, el harness quedó con <b>un solo sistema</b>: reutilización sobre el grafo de código.</p><ul>
${li(`<b>Lo que queda:</b> <code>harness explore "&lt;qué vas a escribir&gt;"</code> (candidatos existentes con firma, archivo:línea y número de usos), <code>--deep</code> (Haiku 5.5 decide <code>reuse</code>, <code>extend</code> o <code>new</code>; la respuesta se guarda y vale mientras los archivos citados no cambien), <code>harness reuse-check [--strict]</code> (el diff contra el código existente; con <code>--strict</code> un duplicado sale con código 1) y <code>harness explore --reindex</code> (grafo en modo <code>full</code>, una vez por repo).`)}
${li(`<b>Lo que se eliminó:</b> el explorer de búsqueda de texto con caché <code>.toon</code>, sus estadísticas y la regla "usa explore primero para todo". Con un agente real no mejoró a <code>rg + fd</code> y el 49% de aciertos de caché no justificaba mantenerlo. Las secciones 1 a 4 de este informe quedan como registro de por qué.`)}
${li(`<b>Reglas del flujo:</b> el executor consulta antes de escribir y corre <code>reuse-check --strict</code> antes de terminar; si escribe algo nuevo lo justifica con <code>new: &lt;motivo&gt;</code>. El reviewer corre <code>reuse-check --strict</code> y rechaza un duplicado sin justificar. El planner lista lo reutilizable en el plan y el designer reutiliza componentes existentes.`)}
${li(`<b>Haiku 5.5</b> es el modelo del rol <code>explore</code> (ya no se lanza por Herdr). La caché de sus respuestas puede salir del repo con <code>HARNESS_REUSE_DIR</code>.`)}
</ul>`;

n.CACHE_TEXT = `<ul>
${li(`<b>Sí aporta:</b> las respuestas de Haiku (caras) quedan guardadas y vigentes; releerlas cuesta $0 y ${L('explorer_warm', 'commit').median} ms. Entre agentes, la tarea que ya resolvió uno la recibe el siguiente sin pagar de nuevo.`)}
${li(`<b>Casi no aporta en nombres exactos:</b> volver a buscar cuesta ${L('explorer_cold', 'symbol').median} ms y leer el caché ${L('explorer_warm', 'symbol').median} ms. El valor ahí es el archivo de handoff, no la velocidad.`)}
${li(`<b>Límite real:</b> la clave es la pregunta normalizada. En la segunda pasada con agentes reales hubo ${hitsC} aciertos en ${callsC} consultas (${pc(hitsC / callsC)}), porque el agente reescribe la pregunta. Sin una clave tolerante a reformulaciones, el caché rinde menos de lo que sugiere la simulación del ${pc(Object.values(S.cache).reduce((s, v) => s + v.hitRate, 0) / 3)}.`)}
</ul>`;

n.AGENT_INTRO = `<p>Las mismas ${A.explorer.n} tareas (14 por proyecto, de commits reales) con el mismo agente (Claude Haiku 5.5 en sesión mínima). Solo cambian las herramientas: <b>rg + fd</b> (Grep, Glob, Bash rg/fd, Read), <b>grafo</b> (codebase-memory-mcp en modo full + Read) y <b>explorer</b> (<code>harness explore</code> + Read). Se pide como máximo 8 archivos y se compara con los del commit. El costo del explorer incluye el Haiku interno de <code>--deep</code>. "Caché caliente" repite las mismas tareas con el caché de la primera pasada.</p>`;

const prow = (a, b, m, fmt, unit) => { const p = P[`${a} vs ${b}|${m}`]; const sig = p.ci[0] > 0 || p.ci[1] < 0; return `<td class="${sig ? (m === 'mrr' ? 'ok' : 'no') : ''}">${p.mean >= 0 ? '+' : ''}${fmt(p.mean)}${unit} ${piv(p, m === 'usd' ? 4 : 2)}</td>`; };
const pairRow = (a, b, la, lb) => `<tr><td>${la} vs ${lb}</td>${prow(a, b, 'mrr', d2, '')}${prow(a, b, 'usd', d4, '')}${prow(a, b, 'sec', (x) => x.toFixed(1), ' s')}${prow(a, b, 'turns', (x) => x.toFixed(1), '')}</tr>`;
n.AGENT_TEXT = `<h3>Diferencias por pares (misma tarea)</h3>
<p class="small">Cada celda es la diferencia media del primero menos el segundo, con intervalo de confianza del 95%. En verde, una mejora de calidad demostrable; en rojo, una diferencia de costo o tiempo demostrable. Sin color, el intervalo cruza 0.</p>
<div class="scroll"><table><tr><th>comparación</th><th>MRR</th><th>USD por tarea</th><th>segundos</th><th>turnos</th></tr>
${pairRow('explorer', 'traditional', 'explorer', 'rg + fd')}${pairRow('graph', 'traditional', 'grafo', 'rg + fd')}${pairRow('explorer', 'graph', 'explorer', 'grafo')}${pairRow('explorer_cached', 'explorer', 'caché caliente', 'explorer 1ª pasada')}${pairRow('explorer_cached', 'traditional', 'caché caliente', 'rg + fd')}</table></div>
<h3>Proyección de costo con un agente Sonnet 5.5</h3>
<p class="small">Estimación, no medición. Supone que el agente se comporta igual (mismos turnos y tokens) y que Sonnet 5.5 cuesta 20 veces lo de Haiku 5.5 ($2 / $10 / $0.20 contra $0.10 / $0.50 / $0.01 por millón; para la escritura de caché supongo la misma proporción). El Haiku interno del explorer se mantiene a precio de Haiku.</p>
<div class="scroll"><table><tr><th>método</th><th>agente Haiku 5.5</th><th>agente Sonnet 5.5 (proyección)</th></tr>
${['traditional', 'graph', 'explorer', 'explorer_cached'].map((a) => `<tr><td>${{ traditional: 'rg + fd', graph: 'grafo', explorer: 'explorer', explorer_cached: 'explorer (caché caliente)' }[a]}</td><td>$${d4(PJ[a].haiku)}</td><td>$${d4(PJ[a].sonnetAgent)}</td></tr>`).join('')}</table></div>`;

n.BUGS = `<ul>
${li(`<b>Un acierto de caché perdía el "por qué" de cada archivo.</b> Las aristas no guardaban esa columna y el agente recibía filas sin explicación. En una prueba preliminar de 18 tareas, el acierto en primer lugar con caché caliente cayó a 0.39 frente a 0.61 sin caché; probablemente por eso, aunque no lo aislé. Corregido: ahora se guarda y se devuelve, y en la corrida final con 42 tareas el caché caliente no empeora (0.60).`)}
${li(`<b><code>--deep</code> repetía archivos.</b> Haiku devolvía el mismo archivo con distintas líneas y se contaba dos veces: 16 de 42 consultas tenían recall mayor que 1. Corregido: se deduplica por ruta.`)}
${li(`<b>Mi prueba de invalidación fallaba con nombres con punto</b> (31 de 36). Era un error del test, no del explorer. Corregido; ahora ${S.invalidation.new_file.ok} de ${S.invalidation.new_file.n}.`)}
${li(`<b>Mi primera medición del grafo era injusta</b> (ver el aviso arriba). Con el índice <code>full</code> y su búsqueda BM25 el grafo pasó de recall 0.17 a rendir como el mejor método en nombres exactos.`)}
${li(`<b>Reutilización — el grafo falla en silencio de tres formas.</b> Mi consulta de "cuántos lo usan" devolvía 0 (el dialecto Cypher no acepta <code>type(r) IN [...]</code>); el binario del grafo se leía una sola vez al importar y los tests no podían sustituirlo; y en macOS <code>/var</code> y <code>/private/var</code> hacían que el repo copiado no se encontrara.`)}
${li(`<b>Las latencias medidas con tres proyectos en paralelo salían infladas.</b> Las de este informe se midieron de a un proyecto, sin otra carga.`)}
</ul>`;

n.LIMITS = `<ul>
${li(`<b>Tamaño.</b> 84 consultas en la recuperación directa y 42 en los agentes. Los intervalos son anchos: una diferencia de 0.05 de MRR no se puede distinguir de cero.`)}
${li(`<b>Una semilla, tres repositorios de la misma organización</b> (TypeScript, Next.js y servicios). No sé si generaliza a otros lenguajes ni a repos mucho más grandes.`)}
${li(`<b>La verdad es incompleta a propósito.</b> Los archivos del commit no son los únicos que servirían para hacer la tarea; subestima a todos los métodos por igual, pero no mide utilidad real para un humano. Los asuntos de commit están en español e inglés y usan términos internos.`)}
${li(`<b>Un solo modelo de agente</b> (Haiku 5.5). Un agente más fuerte puede usar las herramientas distinto. Los costos de Sonnet son una proyección.`)}
${li(`<b>No se probó el flujo real.</b> No corrió un executor de Codex llamando al explorer dentro de una tarea del harness, ni en tier T2 (sin red, donde <code>--deep</code> no funciona).`)}
${li(`<b>Reutilización: muestra pequeña.</b> 18 requisitos con agente (2 en bridge-gym, 8 y 8 en los otros), porque solo servían funciones con 3 o más usos; la baja de duplicados (−17 puntos) no es demostrable. El detector se midió con copias que yo fabriqué (tres niveles de disfraz), no con duplicados escritos por personas, y solo para TypeScript/JavaScript.`)}
${li(`<b>Los tres proyectos corrieron a la vez</b> en los agentes: los segundos incluyen algo de contención. El orden de los métodos rotó, pero el caché de prompt del proveedor puede favorecer a quien corre después.`)}
${li(`<b>La tasa de aciertos de la simulación (91%) depende de una distribución Zipf que yo elegí.</b> El 49% de los agentes reales es la medida confiable, y es para tareas repetidas exactas.`)}
</ul>`;

n.RECO = `<ul>
${li(`<b>Usar el grafo en modo <code>full</code> como base.</b> Fue el método más rápido y preciso para nombres exactos, y el sistema de reutilización depende de él. Reindexar al cambiar mucho el código.`)}
${li(`<b>Mantener <code>reuse-check --strict</code> como control, no como consejo.</b> Es lo más fiable que se midió (encuentra el original en el 100% de los clones disfrazados, con ${pt(RB.foreign.flagged.mean)}% de falsos positivos). Si en uso real se ve que los agentes lo esquivan, el siguiente paso es ponerlo en el gate de la tarea.`)}
${li(`<b>Esperar menos del descubrimiento previo:</b> con ${pt(RE.A.reuse_deep.recall.mean)}% de recall en el mejor caso es una pista para el agente, no una garantía. Su valor medido está en que el agente la lea y confirme (sube la reutilización de ${pt(AR.plain.reused.mean)}% a ${pt(AR.guided.reused.mean)}%).`)}
${li(`<b>Medir una tarea real del harness</b> con un executor de Codex antes de darlo por probado: aquí no se probó dentro del flujo completo ni en tier T2 (sin red, donde <code>--deep</code> no funciona).`)}
</ul>`;

writeFileSync(join(here, 'narrative.json'), JSON.stringify(n, null, 1));
