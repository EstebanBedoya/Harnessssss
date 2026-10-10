import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

// Acceso mínimo al grafo de código (codebase-memory-mcp) por su CLI local. Todo es opcional: si el binario o el índice faltan, devuelve null
// y quien llama cae a la búsqueda de texto.
const bin = () => process.env.HARNESS_GRAPH_BIN || 'codebase-memory-mcp'; // se lee en cada llamada: los tests lo cambian

export function call(tool, args, timeout = 60000) {
  const r = spawnSync(bin(), ['cli', tool], { input: JSON.stringify(args), encoding: 'utf8', maxBuffer: 128 << 20, timeout });
  if (r.error || r.status !== 0) return null;
  const line = (r.stdout || '').split('\n').filter((l) => l.startsWith('{')).pop();
  try { return JSON.parse(line); } catch { return null; }
}
const real = (p) => { try { return realpathSync(p); } catch { return resolve(p); } }; // macOS: /var/... y /private/var/... son la misma carpeta
export const graphAvailable = () => spawnSync(bin(), ['--version'], { encoding: 'utf8' }).status === 0;
export const slugFor = (root) => `harness-${createHash('sha1').update(resolve(root)).digest('hex').slice(0, 8)}`;

// Proyecto indexado para esta raíz: el de más nodos (un índice por defecto puede estar incompleto; el modo full tiene ~7 nodos por archivo).
// `incomplete` avisa cuando el índice parece de un modo reducido y conviene `harness explore --reindex`.
export function projectFor(root) {
  const l = call('list_projects', {});
  const mine = (l?.projects || []).filter((p) => p.root_path && real(p.root_path) === real(root));
  if (!mine.length) return null;
  const p = mine.sort((a, b) => b.nodes - a.nodes)[0];
  const files = spawnSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: root, encoding: 'utf8', maxBuffer: 128 << 20 }).stdout.split('\n').filter(Boolean).length || 1;
  return { name: p.name, nodes: p.nodes, incomplete: p.nodes / files < 3 };
}

// Indexa en modo full con un nombre propio de esta raíz. Lento (decenas de segundos en un repo mediano): solo bajo pedido.
export function reindex(root) {
  const t0 = Date.now();
  const r = call('index_repository', { repo_path: resolve(root), mode: 'full', name: slugFor(root) }, 600000);
  return r ? { project: r.project, nodes: r.nodes, edges: r.edges, ms: Date.now() - t0 } : null;
}

export const search = (project, args) => call('search_graph', { project, ...args });
export const cypher = (project, query) => call('query_graph', { project, query });
export const snippet = (project, qualified_name) => call('get_code_snippet', { project, qualified_name });
