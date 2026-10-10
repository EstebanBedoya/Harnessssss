// Valores por defecto del núcleo. Todo lo específico de un proyecto vive en .harness/profile.json.
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
export const TIERS = ['T0', 'T1', 'T2'];

// Taxonomía de 7.10 de las notas.
export const CATEGORIES = {
  feature: { commit: 'feat', branch: 'feat/', base: 'develop', minTier: 'T1', spec: true },
  fix: { commit: 'fix', branch: 'fix/', base: 'develop', minTier: 'T1' },
  hotfix: { commit: 'fix', branch: 'hotfix/', base: 'deploy', minTier: 'T2' },
  refactor: { commit: 'refactor', branch: 'refactor/', base: 'develop', minTier: 'T0' },
  perf: { commit: 'perf', branch: 'perf/', base: 'develop', minTier: 'T1' },
  docs: { commit: 'docs', branch: 'docs/', base: 'develop', minTier: 'T0', allowPaths: ['**/*.md', 'docs/**'] },
  test: {
    commit: 'test', branch: 'test/', base: 'develop', minTier: 'T0',
    allowPaths: ['**/*.test.*', '**/*.spec.*', 'test/**', 'tests/**', '__tests__/**'],
  },
  infrastructure: { commit: 'build', branch: 'infra/', base: 'develop', minTier: 'T2' },
  chore: { commit: 'chore', branch: 'chore/', base: 'develop', minTier: 'T0' },
  release: { commit: 'chore', branch: 'release/', base: 'develop', minTier: 'T2' },
};

// Tabla de 6.7: modelo y esfuerzo por rol. effort: null = el modelo no admite esfuerzo (Haiku 4.5).
export const DEFAULT_PROFILE = {
  version: 1,
  gate: { cmd: null, timeoutMs: 600000 },
  git: { integration: 'develop', deploy: 'main' },
  tiers: { t2: [], t1: [], ui: [] },
  retries: 1,
  // byTier: { T2: { sandbox: 'danger-full-access' } } para fijar el sandbox o la aprobación por tier
  codex: { sandbox: 'workspace-write', approval: 'never', byTier: {} },
  // Reparto (2026-10-04): Claude solo para el planner y el QA (reviewer, Sonnet 5.5); todo lo demás corre en Codex.
  // El executor NO cae a Claude si Codex falla: el planner se detiene y avisa (un fallback manual se registra con el evento `fallback`).
  models: {
    planner: { provider: 'claude', model: 'claude-opus-5-5', effort: { T0: 'medium', T1: 'high', T2: 'high' } },
    executor: { provider: 'codex', model: 'gpt-6.1-sol', effort: { T0: 'medium', T1: 'high', T2: 'high' } },
    reviewer: {
      provider: 'claude', model: 'claude-sonnet-5-5', effort: { T0: 'medium', T1: 'high', T2: 'high' },
      // Solo si un humano registró que el executor fue Claude: el revisor pasa a la otra familia.
      crossFamily: { provider: 'codex', model: 'gpt-6.1-sol', effort: { T0: 'medium', T1: 'high', T2: 'high' } },
    },
    // Prueba: el designer en Codex con Pencil. Si se rechaza: `harness config set models.designer.use claude` (Claude Design con Sonnet 5.5 a xhigh).
    designer: {
      use: 'codex',
      codex: { provider: 'codex', model: 'gpt-6.1-sol', effort: { T0: 'high', T1: 'high', T2: 'high' } },
      claude: { provider: 'claude', model: 'claude-sonnet-5-5', effort: { T0: 'xhigh', T1: 'xhigh', T2: 'xhigh' } },
    },
    // Ya no se lanza por Herdr: `harness explore` (script) y, con --deep, Haiku por `claude -p`. effort: null (no consta que Haiku 5.5 lo admita).
    explore: { provider: 'claude', model: 'claude-haiku-5-5', effort: null },
  },
  effortCap: 'high', // el perfil no fija nada por encima; solo un reintento puede subir un nivel (máx. xhigh)
};

// USD por millón de tokens. Entrada/salida/lectura de caché: de la tabla de modelos y de la búsqueda del 2026-10-02.
// Escritura de caché: SUPUESTO (x1,25 para 5 min, x2 para 1 h). Haiku 4.5 lectura: SUPUESTO.
export const PRICES = {
  'claude-opus-5-5': { in: 4, out: 20, cache_read: 0.2 },
  'claude-sonnet-5-5': { in: 2, out: 10, cache_read: 0.2 },
  'claude-haiku-5-5': { in: 0.1, out: 0.5, cache_read: 0.01 }, // hasta 100.000 tokens de prompt; sobre eso 0.5 / 2.5 / 0.05
  'claude-haiku-4-5': { in: 1, out: 5, cache_read: 0.1 },
  'gpt-6.1-sol': { in: 2, out: 10, cache_read: 0.1 },
  _cache_write_mult: { '5m': 1.25, '1h': 2 },
};
