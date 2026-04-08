/**
 * agent-knowledge benchmark runner — R@5 / R@10 over hand-authored fixtures.
 *
 * Calls the internal `searchKnowledge` API directly (no MCP wrapping). Loads
 * `bench/fixtures.jsonl`, runs each query against `~/agent-knowledge/`, and
 * prints a per-category and overall recall@5 / recall@10 table.
 *
 * Usage:
 *   npm run build && node dist/bench/run.js
 *   (or)
 *   npx tsx bench/run.ts
 *
 * Add fixtures by appending JSON lines: `{"query":"...","expected":"path","category":"..."}`
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { searchKnowledge } from '../src/knowledge/search.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface Fixture {
  query: string;
  expected: string;
  category: string;
}

let fixturesPath = path.resolve(__dirname, 'fixtures.jsonl');
if (!fs.existsSync(fixturesPath)) {
  const examplePath = path.resolve(__dirname, 'fixtures.example.jsonl');
  if (fs.existsSync(examplePath)) {
    console.error(`fixtures.jsonl not found — falling back to fixtures.example.jsonl`);
    fixturesPath = examplePath;
  } else {
    console.error(`fixtures.jsonl not found at ${fixturesPath}`);
    process.exit(1);
  }
}

const fixtures: Fixture[] = fs
  .readFileSync(fixturesPath, 'utf-8')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l.length > 0 && !l.startsWith('//'))
  .map((l) => JSON.parse(l));

const memoryDir = process.env.KNOWLEDGE_MEMORY_DIR || path.join(homedir(), 'agent-knowledge');

if (!fs.existsSync(memoryDir)) {
  console.error(`memoryDir not found: ${memoryDir}`);
  process.exit(1);
}

interface Bucket {
  total: number;
  hitTop5: number;
  hitTop10: number;
}

const buckets = new Map<string, Bucket>();
function getBucket(name: string): Bucket {
  let b = buckets.get(name);
  if (!b) {
    b = { total: 0, hitTop5: 0, hitTop10: 0 };
    buckets.set(name, b);
  }
  return b;
}

const overall = getBucket('OVERALL');

for (const fx of fixtures) {
  const results = searchKnowledge(memoryDir, fx.query, { maxResults: 10 });
  const ranks = results.map((r) => r.entry.path);
  const idx = ranks.indexOf(fx.expected);
  const inTop5 = idx >= 0 && idx < 5;
  const inTop10 = idx >= 0 && idx < 10;

  const bucket = getBucket(fx.category);
  bucket.total++;
  overall.total++;
  if (inTop5) {
    bucket.hitTop5++;
    overall.hitTop5++;
  }
  if (inTop10) {
    bucket.hitTop10++;
    overall.hitTop10++;
  }

  if (!inTop10) {
    console.error(
      `MISS: [${fx.category}] "${fx.query}" → expected ${fx.expected}, got top: ${ranks.slice(0, 3).join(', ') || '(none)'}`,
    );
  }
}

function pct(n: number, d: number): string {
  if (d === 0) return '—';
  return `${((n / d) * 100).toFixed(1)}%`;
}

const rows: string[] = [];
rows.push('| Category | n | R@5 | R@10 |');
rows.push('|---|---|---|---|');
for (const [name, b] of buckets) {
  if (name === 'OVERALL') continue;
  rows.push(`| ${name} | ${b.total} | ${pct(b.hitTop5, b.total)} | ${pct(b.hitTop10, b.total)} |`);
}
rows.push(
  `| **OVERALL** | **${overall.total}** | **${pct(overall.hitTop5, overall.total)}** | **${pct(overall.hitTop10, overall.total)}** |`,
);

console.log('\n# agent-knowledge bench results\n');
console.log(`memoryDir: ${memoryDir}`);
console.log(`fixtures: ${fixtures.length}\n`);
console.log(rows.join('\n'));
console.log('');
