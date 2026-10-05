import { CATEGORIES, TIERS } from './defaults.mjs';
import { matches } from './glob.mjs';

const rank = (t) => TIERS.indexOf(t);
const maxTier = (a, b) => (rank(a) >= rank(b) ? a : b);

// Gana el tier más alto entre el mínimo de la categoría y el que salga de las rutas (7.10).
// Una categoría con allowPaths (docs, test) se detiene si la tarea toca rutas fuera de ellas.
export function classify(profile, category, paths = []) {
  const cat = CATEGORIES[category];
  if (!cat) return { ok: false, errors: [`categoría desconocida: ${category}`], categories: Object.keys(CATEGORIES) };
  const errors = [];
  let tier = cat.minTier;
  for (const p of paths) {
    if (matches(p, profile.tiers?.t2)) tier = maxTier(tier, 'T2');
    else if (matches(p, profile.tiers?.t1)) tier = maxTier(tier, 'T1');
  }
  if (cat.allowPaths) {
    const out = paths.filter((p) => !matches(p, cat.allowPaths));
    if (out.length) errors.push(`categoría ${category} toca rutas fuera de su alcance: ${out.join(', ')}`);
  }
  const ui = paths.some((p) => matches(p, profile.tiers?.ui));
  const base = cat.base === 'deploy' ? profile.git.deploy : cat.base === 'develop' ? profile.git.integration : cat.base;
  return { ok: errors.length === 0, errors, tier, ui, commit: cat.commit, branch: cat.branch, base, spec: !!cat.spec };
}
