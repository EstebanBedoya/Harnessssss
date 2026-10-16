import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fleetSnapshot } from './fleet.mjs';

// Panel de control en ANSI puro (sin dependencias). Vistas: 1 Proyectos · 2 En vivo · 3 Métricas; Enter abre un proyecto.
// Todo se dibuja desde `fleetSnapshot()`, que solo lee archivos; las únicas acciones que escriben son `s` (agents sync) y `c` (metrics collect), con confirmación.

const E = '\x1b[';
export const style = (on) => {
  const w = (code) => (s) => (on ? `${E}${code}m${s}${E}0m` : String(s));
  return {
    bold: w('1'), dim: w('2'), inv: w('7'),
    red: w('38;5;203'), green: w('38;5;78'), yellow: w('38;5;221'), blue: w('38;5;75'), violet: w('38;5;141'), gray: w('38;5;245'), cyan: w('38;5;80'),
  };
};

const strip = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');
const vlen = (s) => [...strip(s)].length;
export const pad = (s, w, right = false) => {
  const t = String(s); const n = vlen(t);
  if (n > w) return [...strip(t)].slice(0, Math.max(0, w - 1)).join('') + '…'; // al truncar se pierde el color: es lo que se quiere en una celda estrecha
  return right ? ' '.repeat(w - n) + t : t + ' '.repeat(w - n);
};
export const money = (n) => `$${n >= 100 ? n.toFixed(0) : n.toFixed(2)}`;
export const tok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n)));
export const ago = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`; };
export const bar = (v, max, w) => { const n = max > 0 ? Math.round((v / max) * w) : 0; return '█'.repeat(n) + '░'.repeat(Math.max(0, w - n)); };

const TABS = ['Proyectos', 'En vivo', 'Métricas'];

function header(c, snap, tab, W) {
  const t = snap.totals;
  const tabs = TABS.map((n, i) => (i === tab ? c.inv(c.bold(` ${i + 1} ${n} `)) : c.gray(` ${i + 1} ${n} `))).join(' ');
  const stats = `${c.cyan(t.projects)} proyectos · ${t.running ? c.green(`● ${t.running} corriendo`) : c.gray('○ nada corriendo')} · ${t.outdated ? c.yellow(`⚠ ${t.outdated} desactualizados`) : c.green('✓ al día')} · ${c.bold(money(t.cost))} en tareas`;
  return [`${c.bold(c.violet('◆ harness'))}  ${tabs}`, `${stats}`, c.gray('─'.repeat(W))];
}

function projectState(c, p) {
  if (!p.configured) return c.red('✗ roto');
  if (p.runs.some((r) => r.running)) return c.green('● corriendo');
  if (p.outdated) return c.yellow('⚠ desactualizado');
  if (p.issues.length) return c.yellow('! revisar');
  return c.gray('○ al día');
}

function viewProjects(c, snap, sel, W) {
  const nameW = Math.max(10, ...snap.projects.map((p) => p.name.length)) + 1;
  const L = [c.gray(`${pad('PROYECTO', nameW)} ${pad('ESTADO', 17)} ${pad('EJECUTOR', 30)} ${pad('GATE', 18)} ${pad('TAREAS', 9)} ${pad('COSTO', 8, true)}`)];
  snap.projects.forEach((p, i) => {
    const done = p.tasks.done || 0; const total = Object.values(p.tasks).reduce((a, b) => a + b, 0);
    const ex = p.configured ? `${p.executor.provider} · ${p.executor.model.replace(/^.*\//, '')}` : '—';
    const row = `${pad(p.name, nameW)} ${pad(projectState(c, p), 17)} ${pad(ex, 30)} ${pad(p.gate || c.red('sin gate'), 18)} ${pad(`${done}/${total}`, 9)} ${pad(money(p.metrics.cost), 8, true)}`;
    L.push(i === sel ? c.inv(` ${strip(row)} `.slice(0, W)) : ` ${row}`);
  });
  if (!snap.projects.length) L.push(c.gray('  No encontré proyectos con .harness/profile.json. Raíces: ~/Projects, ~/Lab, ~/Servers (o ~/.harness/fleet.json).'));
  return L;
}

function viewDetail(c, snap, p, W) {
  if (!p) return [c.gray('  (sin proyecto)')];
  const L = [`${c.bold(p.name)}  ${projectState(c, p)}   ${c.gray(p.root)}`, ''];
  if (!p.configured) return [...L, c.red(`  ${p.error}`)];
  L.push(`  ${c.gray('executor')}  ${p.executor.provider} · ${p.executor.model}      ${c.gray('designer')}  ${p.designer.provider} · ${p.designer.model}`);
  L.push(`  ${c.gray('gate')}      ${p.gate || c.red('sin configurar')}`, '');
  L.push(`  ${c.bold('Agentes instalados')}  ${p.agents.map((a) => (a.state === 'ok' ? c.green(`✓ ${a.role}`) : a.state === 'stale' ? c.yellow(`⚠ ${a.role}`) : c.red(`✗ ${a.role}`))).join('  ')}`);
  if (p.issues.length) { L.push('', `  ${c.bold('Pendientes')}`); for (const i of p.issues) L.push(`   ${c.yellow('•')} ${i}`); }
  const live = p.runs.filter((r) => r.running);
  L.push('', `  ${c.bold('Ahora')}`);
  if (!live.length && !p.panes.length) L.push(`   ${c.gray('nada corriendo')}`);
  for (const r of live) L.push(`   ${c.green('●')} pi · ${r.task} · ${ago(snap.now - r.started)}  ${c.gray(r.last)}`);
  for (const a of p.panes) L.push(`   ${a.status === 'working' ? c.green('●') : c.gray('○')} ${a.agent} · ${a.title} · ${a.status}`);
  const m = p.metrics;
  L.push('', `  ${c.bold('Consumo')}  ${money(m.cost)} total · Claude ${money(m.claudeCost)} · externo ${money(m.externalCost)} · ${tok(m.tokensIn)} in / ${tok(m.tokensOut)} out (externo)`);
  L.push('', `  ${c.bold('Últimas tareas')}`);
  for (const t of (p.taskList || []).slice(0, 7)) {
    const mt = m.tasks.find((x) => x.task === t.id);
    L.push(`   ${pad(t.id, 34)} ${pad(t.tier, 3)} ${pad(t.status, 10)} ${pad(t.executor || '—', 7)} ${pad(mt ? money(Number(mt.total_cost) || 0) : '', 8, true)}`);
  }
  return L.map((l) => (vlen(l) > W ? pad(l, W) : l));
}

function viewLive(c, snap, W) {
  const L = [c.gray(`${pad('PROYECTO', 20)} ${pad('AGENTE', 32)} ${pad('ESTADO', 12)} ${pad('TIEMPO', 7)} ÚLTIMA ACCIÓN`)];
  let n = 0;
  for (const p of snap.projects) {
    for (const r of p.runs.filter((x) => x.running)) { n++; L.push(`${pad(p.name, 20)} ${pad(c.cyan(`pi executor · ${r.task}`), 32)} ${pad(c.green('● corriendo'), 12)} ${pad(ago(snap.now - r.started), 7)} ${c.gray(pad(r.last, Math.max(10, W - 78)))}`); }
    for (const a of p.panes) { n++; L.push(`${pad(p.name, 20)} ${pad(c.violet(`${a.agent} · ${a.title}`), 32)} ${pad(a.status === 'working' ? c.green('● trabaja') : c.gray(`○ ${a.status}`), 12)} ${pad('', 7)} ${c.gray(a.pane)}`); }
  }
  if (!n) L.push('', c.gray('  Ningún agente activo ahora mismo.'));
  return L;
}

function viewMetrics(c, snap, scope, p, W) {
  const t = snap.totals;
  const src = scope === 'proyecto' && p ? { name: p.name, cost: p.metrics.cost, claude: p.metrics.claudeCost, ext: p.metrics.externalCost, inn: p.metrics.tokensIn, out: p.metrics.tokensOut, tasks: p.metrics.count } : { name: 'todos los proyectos', cost: t.cost, claude: t.claudeCost, ext: t.externalCost, inn: t.tokensIn, out: t.tokensOut, tasks: t.tasks };
  const L = [`${c.bold(src.name)}  ${c.gray(`p: alternar general/proyecto`)}`, '',
    `  ${c.gray('tareas')} ${src.tasks}   ${c.gray('costo total')} ${c.bold(money(src.cost))}   ${c.gray('Claude')} ${money(src.claude)}   ${c.gray('externo (pi/Codex)')} ${money(src.ext)}   ${c.gray('tokens externos')} ${tok(src.inn)} in / ${tok(src.out)} out`, ''];
  const max = Math.max(1, ...snap.projects.map((x) => x.metrics.cost));
  L.push(`  ${c.bold('Costo por proyecto')}`);
  for (const x of [...snap.projects].sort((a, b) => b.metrics.cost - a.metrics.cost)) {
    const bw = Math.min(34, W - 44); const cw = Math.round((x.metrics.claudeCost / max) * bw); const ew = Math.round((x.metrics.externalCost / max) * bw);
    L.push(`   ${pad(x.name, 22)} ${c.violet('█'.repeat(cw))}${c.blue('█'.repeat(ew))}${c.gray('░'.repeat(Math.max(0, bw - cw - ew)))} ${pad(money(x.metrics.cost), 8, true)}  ${c.gray(`Claude ${money(x.metrics.claudeCost)} · ext ${money(x.metrics.externalCost)}`)}`);
  }
  L.push('', `  ${c.bold('Executor: pi vs Codex')} ${c.gray('(promedio por tarea cerrada; necesita ~5 tareas por grupo)')}`);
  L.push(c.gray(`   ${pad('tier', 5)} ${pad('executor', 9)} ${pad('tareas', 7, true)} ${pad('1er int.', 9, true)} ${pad('exec/t', 7, true)} ${pad('exec min', 9, true)} ${pad('tok in', 8, true)} ${pad('costo/t', 9, true)}`));
  for (const r of snap.compare.filter((x) => scope !== 'proyecto' || !p || p.metrics.tasks.some((t2) => t2.executor === x.executor && t2.tier === x.tier))) {
    const few = r.tasks < 5;
    L.push(`   ${pad(r.tier, 5)} ${pad(r.executor, 9)} ${pad(r.tasks, 7, true)} ${pad(`${r.first_try_pct}%`, 9, true)} ${pad(r.exec_runs, 7, true)} ${pad(r.exec_min, 9, true)} ${pad(`${r.tokens_in_k}k`, 8, true)} ${pad(money(r.total_cost_usd), 9, true)}${few ? c.yellow('  · pocas') : ''}`);
  }
  if (!snap.compare.length) L.push(c.gray('   Sin tareas cerradas con executor registrado. Corre `harness metrics collect` en cada proyecto (tecla c).'));
  return L;
}

// Un cuadro completo como texto. Pura: la usan el bucle interactivo, `--once` y los tests.
export function renderFrame(snap, ui, { width = 100, height = 30, color = true } = {}) {
  const c = style(color);
  const W = Math.max(60, width);
  const p = snap.projects[ui.sel];
  let lines;
  if (ui.detail) lines = viewDetail(c, snap, p, W);
  else if (ui.tab === 0) lines = viewProjects(c, snap, ui.sel, W);
  else if (ui.tab === 1) lines = viewLive(c, snap, W);
  else lines = viewMetrics(c, snap, ui.scope, p, W);
  const foot = ui.confirm
    ? c.yellow(` ${ui.confirm.text} (y/n) `)
    : c.gray(` ${ui.msg ? `${ui.msg}  ·  ` : ''}1-3 vistas · ↑↓ elegir · Enter detalle · Esc atrás · s sync · c métricas · r refrescar · q salir`);
  const room = Math.max(5, height - 5);
  return [...header(c, snap, ui.tab, W), ...lines.slice(0, room), ...Array(Math.max(0, room - lines.length)).fill(''), c.gray('─'.repeat(W)), foot].join('\n');
}

export function runTui({ script = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'harness.mjs'), intervalMs = 2500 } = {}) {
  const out = process.stdout;
  const ui = { tab: 0, sel: 0, detail: false, scope: 'general', confirm: null, msg: '' };
  let snap = fleetSnapshot();
  const draw = () => {
    ui.sel = Math.min(ui.sel, Math.max(0, snap.projects.length - 1));
    out.write(`${E}H${renderFrame(snap, ui, { width: out.columns, height: out.rows }).split('\n').map((l) => `${l}${E}K`).join('\n')}${E}J`);
  };
  const refresh = () => { snap = fleetSnapshot(); draw(); };
  const act = (args, p, label) => {
    ui.msg = `${label} ${p.name}…`; draw();
    const r = spawnSync(process.execPath, [script, ...args, '--root', p.root], { encoding: 'utf8', timeout: 120000 });
    ui.msg = r.status === 0 ? `${label} ${p.name}: listo` : `${label} ${p.name}: falló (${String(r.stderr || r.stdout).trim().split('\n').pop().slice(0, 80)})`;
    refresh();
  };
  const quit = () => { clearInterval(timer); out.write(`${E}?25h${E}?1049l`); process.stdin.setRawMode?.(false); process.exit(0); };
  out.write(`${E}?1049h${E}?25l`);
  const timer = setInterval(refresh, intervalMs);
  out.on('resize', draw);
  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (k) => {
    if (k === '\x03') return quit();
    const p = snap.projects[ui.sel];
    if (ui.confirm) { if (k === 'y') { const f = ui.confirm.run; ui.confirm = null; f(); } else { ui.confirm = null; ui.msg = 'cancelado'; } return draw(); }
    ui.msg = '';
    if (k === 'q') return quit();
    if (k === '1' || k === '2' || k === '3') { ui.tab = Number(k) - 1; ui.detail = false; }
    else if (k === '\x1b[A' || k === 'k') ui.sel = Math.max(0, ui.sel - 1);
    else if (k === '\x1b[B' || k === 'j') ui.sel = Math.min(snap.projects.length - 1, ui.sel + 1);
    else if (k === '\r' && ui.tab === 0) ui.detail = true;
    else if (k === '\x1b' || k === 'b') ui.detail = false;
    else if (k === 'p') ui.scope = ui.scope === 'general' ? 'proyecto' : 'general';
    else if (k === 'r') return refresh();
    else if (k === 's' && p?.configured) ui.confirm = { text: `Sincronizar agentes de ${p.name}${p.outdated ? '' : ' (ya está al día)'}`, run: () => act(['agents', 'sync'], p, 'sync') };
    else if (k === 'c' && p?.configured) { act(['metrics', 'collect'], p, 'métricas de'); return; }
    draw();
  });
  draw();
}
