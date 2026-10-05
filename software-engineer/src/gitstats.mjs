import { spawnSync } from 'node:child_process';

const git = (root, args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });

// Commits, archivos y líneas de una tarea. Usa base..rama; si la rama ya no existe, cae a la ventana de tiempo de la tarea.
export function gitStats(root, task) {
  if (git(root, ['rev-parse', '--git-dir']).status !== 0) return null;
  const from = Date.parse(task.history[0].ts); const to = Date.parse(task.history.at(-1).ts) + 120_000;
  const hasBranch = task.branch && git(root, ['rev-parse', '--verify', '--quiet', task.branch]).status === 0;
  const hasBase = task.base && git(root, ['rev-parse', '--verify', '--quiet', task.base]).status === 0;
  // Las ramas pueden estar apiladas (una parte de la anterior): base..rama traería los commits de la tarea previa. Se cuentan solo los hechos desde que esta empezó.
  const since = `--since=@${Math.floor(from / 1000)}`;
  const range = hasBranch && hasBase ? [`${task.base}..${task.branch}`, since] : hasBranch ? [task.branch, `--since=@${Math.floor(from / 1000)}`] : ['--all', `--since=@${Math.floor(from / 1000)}`, `--until=@${Math.floor(to / 1000)}`];
  const r = git(root, ['log', '--numstat', '--format=@@%H %ct', ...range]);
  if (r.status !== 0) return null;
  const commits = []; const files = new Set(); let add = 0; let del = 0;
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('@@')) { commits.push(Number(line.split(' ')[1]) * 1000); continue; }
    const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (m) { files.add(m[3]); add += m[1] === '-' ? 0 : Number(m[1]); del += m[2] === '-' ? 0 : Number(m[2]); }
  }
  return {
    task: task.id, source: hasBranch && hasBase ? 'rama(desde inicio)' : hasBranch ? 'rama+tiempo' : 'tiempo',
    commits: commits.length, files: files.size, additions: add, deletions: del,
    first_commit: commits.length ? new Date(Math.min(...commits)).toISOString() : '', last_commit: commits.length ? new Date(Math.max(...commits)).toISOString() : '',
  };
}
