// Arma el HTML del artifact: datos de results/summary.json + texto de narrative.json.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const sum = readFileSync(join(here, 'results', 'summary.json'), 'utf8');
const nar = JSON.parse(readFileSync(join(here, 'narrative.json'), 'utf8'));
let t = readFileSync(join(here, 'template.html'), 'utf8').replace('__SUMMARY__', () => sum);
for (const [k, v] of Object.entries(nar)) t = t.replace(`{{${k}}}`, () => v);
if (/\{\{[A-Z_]+\}\}/.test(t)) throw new Error('faltan secciones: ' + t.match(/\{\{[A-Z_]+\}\}/g));
writeFileSync(process.argv[2] || join(here, 'results', 'report.html'), t);
