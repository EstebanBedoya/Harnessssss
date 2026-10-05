// Glob mínimo: ** cruza carpetas, * no cruza '/', ? un carácter.
const cache = new Map();
export function globToRegex(glob) {
  if (cache.has(glob)) return cache.get(glob);
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  const r = new RegExp(`^${re}$`);
  cache.set(glob, r);
  return r;
}
export const matches = (path, globs = []) => globs.some((g) => globToRegex(g).test(path));
