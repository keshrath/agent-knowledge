/**
 * agent-knowledge benchmark runner — R@5 / R@10 + diversity@5 over
 * hand-authored fixtures.
 *
 * Calls the internal `searchKnowledge` API directly (no MCP wrapping). Loads
 * `bench/fixtures.jsonl`, runs each query against `~/agent-knowledge/`, and
 * prints a per-category + overall recall table plus a diversity metric.
 *
 * Flags:
 *   --mmr            Apply MMR re-ranking (lambda 0.7 unless --mmr-lambda is set).
 *   --mmr-lambda=N   MMR tradeoff 0-1 (default 0.7).
 *   --category-mode=filter|boost  Default: boost. Passthrough to searchKnowledge.
 *
 * Usage:
 *   npm run build && node dist/bench/run.js
 *   npx tsx bench/run.ts
 *   npx tsx bench/run.ts --mmr
 *   npx tsx bench/run.ts --mmr --mmr-lambda=0.5
 *
 * Add fixtures by appending JSON lines: `{"query":"...","expected":"path","category":"..."}`
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { searchKnowledge } from '../src/knowledge/search.js';
import { jaccardTokenSim, diversityAtK } from '../src/search/mmr.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface Fixture {
  query: string;
  expected: string;
  category: string;
}

// ── Arg parsing ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function flag(name: string): boolean {
  return args.includes(name);
}
function opt(name: string): string | undefined {
  for (const a of args) {
    if (a.startsWith(`${name}=`)) return a.slice(name.length + 1);
    const idx = args.indexOf(name);
    if (idx >= 0 && idx + 1 < args.length && !args[idx + 1].startsWith('--')) {
      return args[idx + 1];
    }
  }
  return undefined;
}

const useMmr = flag('--mmr');
const mmrLambda = opt('--mmr-lambda') ? parseFloat(opt('--mmr-lambda')!) : 0.7;
const categoryMode = (opt('--category-mode') ?? 'boost') as 'filter' | 'boost';

// ── Fixture loading ─────────────────────────────────────────────────────────

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

// ── Result buckets ─────────────────────────────────────────────────────────

interface Bucket {
  total: number;
  hitTop5: number;
  hitTop10: number;
  /** Average unique-cluster count @5, weighted across queries in this bucket. */
  diversityAt5Sum: number;
  diversityAt5Count: number;
}

const buckets = new Map<string, Bucket>();
function getBucket(name: string): Bucket {
  let b = buckets.get(name);
  if (!b) {
    b = { total: 0, hitTop5: 0, hitTop10: 0, diversityAt5Sum: 0, diversityAt5Count: 0 };
    buckets.set(name, b);
  }
  return b;
}

const overall = getBucket('OVERALL');

// ── Run ────────────────────────────────────────────────────────────────────

for (const fx of fixtures) {
  const results = searchKnowledge(memoryDir, fx.query, {
    maxResults: 10,
    categoryMode,
    mmr: useMmr,
    mmrLambda,
  });
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

  // Diversity@5: count unique clusters in top-5 using token-Jaccard similarity
  // at threshold 0.5. Gives an integer in [1, min(5, results.length)]. Higher
  // = more varied top-5 (good — fewer near-duplicates).
  const top5 = results.slice(0, 5);
  if (top5.length > 0) {
    const div = diversityAtK(
      top5,
      (a, b) =>
        jaccardTokenSim(a.entry.content ?? a.excerpt ?? '', b.entry.content ?? b.excerpt ?? ''),
      0.5,
    );
    bucket.diversityAt5Sum += div;
    bucket.diversityAt5Count++;
    overall.diversityAt5Sum += div;
    overall.diversityAt5Count++;
  }

  if (!inTop10) {
    console.error(
      `MISS: [${fx.category}] "${fx.query}" → expected ${fx.expected}, got top: ${ranks.slice(0, 3).join(', ') || '(none)'}`,
    );
  }
}

// ── Format ──────────────────────────────────────────────────────────────────

function pct(n: number, d: number): string {
  if (d === 0) return '—';
  return `${((n / d) * 100).toFixed(1)}%`;
}

function avgDiversity(b: Bucket): string {
  if (b.diversityAt5Count === 0) return '—';
  return (b.diversityAt5Sum / b.diversityAt5Count).toFixed(2);
}

const rows: string[] = [];
rows.push('| Category | n | R@5 | R@10 | Div@5 |');
rows.push('|---|---|---|---|---|');
for (const [name, b] of buckets) {
  if (name === 'OVERALL') continue;
  rows.push(
    `| ${name} | ${b.total} | ${pct(b.hitTop5, b.total)} | ${pct(b.hitTop10, b.total)} | ${avgDiversity(b)} |`,
  );
}
rows.push(
  `| **OVERALL** | **${overall.total}** | **${pct(overall.hitTop5, overall.total)}** | **${pct(overall.hitTop10, overall.total)}** | **${avgDiversity(overall)}** |`,
);

const modeTag = useMmr ? `mmr (λ=${mmrLambda})` : 'no-mmr';

console.log('\n# agent-knowledge bench results\n');
console.log(`memoryDir: ${memoryDir}`);
console.log(`fixtures: ${fixtures.length}`);
console.log(`mode: ${modeTag}, category_mode: ${categoryMode}\n`);
console.log(rows.join('\n'));
console.log('');
console.log(
  '_Div@5 = average unique-cluster count in top-5 (token-Jaccard ≥ 0.5 merges into same cluster). Higher = more diverse top-5._',
);
console.log('');
