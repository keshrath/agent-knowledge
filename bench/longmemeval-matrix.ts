/**
 * LongMemEval ablation matrix — runs multiple retrieval modes over the SAME
 * 500-question corpus and prints one consolidated comparison table.
 *
 * The existing `longmemeval.ts` runs ONE mode per invocation. This wrapper
 * orchestrates N invocations (as child processes so each run gets fresh
 * module state) and aggregates the OVERALL + per-question-type rows from
 * each run's markdown output.
 *
 * Use this to gate retrieval-layer changes:
 *   1. Record the matrix before the change.
 *   2. Record it after.
 *   3. A change is shippable only if R@5 doesn't regress on any mode AND
 *      the targeted mode actually improves on its target metric.
 *
 * Default matrix (fast — all sparse, ~30s total):
 *   - `tfidf`      — raw TF-IDF, no boosts (paper-style baseline)
 *   - `tfidf+boosts` — TF-IDF with v1.4 proper-noun + temporal boosts
 *   - `bm25`       — raw BM25
 *   - `bm25+boosts` — BM25 with boosts (the shipped v1.5 default)
 *
 * Opt into the slow hybrid mode with `--include-hybrid` (~70 min extra for
 * 500 questions, because the local MiniLM embedder is the bottleneck).
 *
 * Usage:
 *   npx tsx bench/longmemeval-matrix.ts
 *   npx tsx bench/longmemeval-matrix.ts --limit 50   # smoke
 *   npx tsx bench/longmemeval-matrix.ts --include-hybrid
 *
 * The bench is deterministic: rerunning the same matrix yields byte-for-byte
 * the same numbers. Safe to commit the output under docs/ as a snapshot.
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const args = process.argv.slice(2);
const limitArg = args.find((a) => a.startsWith('--limit'));
const limit = limitArg
  ? parseInt(limitArg.split('=')[1] ?? args[args.indexOf(limitArg) + 1], 10)
  : 0;
const includeHybrid = args.includes('--include-hybrid');

interface Mode {
  label: string;
  flags: string[];
  description: string;
}

const MODES: Mode[] = [
  { label: 'tfidf', flags: [], description: 'raw TF-IDF, no boosts (paper-style baseline)' },
  { label: 'tfidf+boosts', flags: ['--boosts'], description: 'TF-IDF with v1.4 boosts' },
  { label: 'bm25', flags: ['--ranker', 'bm25'], description: 'raw BM25, no boosts' },
  {
    label: 'bm25+boosts',
    flags: ['--boosts', '--ranker', 'bm25'],
    description: 'BM25 with v1.4 boosts (v1.5 default)',
  },
];

if (includeHybrid) {
  MODES.push({
    label: 'bm25+boosts+hybrid',
    flags: ['--hybrid', '--boosts', '--ranker', 'bm25'],
    description: 'BM25 + semantic hybrid + boosts (~70 min at 500 Q)',
  });
}

interface RowsByType {
  [questionType: string]: { n: number; r1: number; r5: number; r10: number };
}

interface Parsed {
  overall: { n: number; r1: number; r5: number; r10: number };
  byType: RowsByType;
  elapsedSec: number;
}

function parsePct(s: string): number {
  const m = s.match(/^([0-9.]+)%$/);
  return m ? parseFloat(m[1]) : NaN;
}

function parseOutput(out: string): Parsed | null {
  // The longmemeval.ts runner emits markdown like:
  //   | single-session-user | 70 | 92.9% | 100.0% | 100.0% |
  //   | **OVERALL** | **500** | **87.6%** | **97.2%** | **98.4%** |
  const overall: Parsed['overall'] = { n: 0, r1: NaN, r5: NaN, r10: NaN };
  const byType: RowsByType = {};

  const rowRe =
    /^\|\s*(?:\*\*)?([a-z-]+|OVERALL)(?:\*\*)?\s*\|\s*(?:\*\*)?(\d+)(?:\*\*)?\s*\|\s*(?:\*\*)?([0-9.]+%|—)(?:\*\*)?\s*\|\s*(?:\*\*)?([0-9.]+%|—)(?:\*\*)?\s*\|\s*(?:\*\*)?([0-9.]+%|—)(?:\*\*)?\s*\|$/i;

  for (const line of out.split('\n')) {
    const m = line.trim().match(rowRe);
    if (!m) continue;
    const [, name, nStr, r1, r5, r10] = m;
    const row = {
      n: parseInt(nStr, 10),
      r1: parsePct(r1),
      r5: parsePct(r5),
      r10: parsePct(r10),
    };
    if (name.toUpperCase() === 'OVERALL') {
      Object.assign(overall, row);
    } else {
      byType[name] = row;
    }
  }

  const timeMatch = out.match(/Processed \d+ questions in ([0-9.]+)s/);
  const elapsedSec = timeMatch ? parseFloat(timeMatch[1]) : NaN;

  if (!Number.isFinite(overall.r5)) return null;
  return { overall, byType, elapsedSec };
}

function runMode(mode: Mode): Parsed | null {
  const runnerPath = path.resolve(__dirname, 'longmemeval.ts');
  const flagStr = [...mode.flags, ...(limit > 0 ? ['--limit', String(limit)] : [])]
    .map((f) => (/\s/.test(f) ? `"${f}"` : f))
    .join(' ');
  const cmd = `npx tsx "${runnerPath}" ${flagStr}`.trim();

  process.stderr.write(`\n[matrix] running mode "${mode.label}" (${mode.description})...\n`);
  // shell:true with a single string dodges the arg-concatenation deprecation.
  // Timing lives on stderr (console.error) in longmemeval.ts — capture both
  // streams and combine so parseOutput sees the full run log.
  const res = spawnSync(cmd, {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
    env: { ...process.env, NODE_OPTIONS: (process.env.NODE_OPTIONS ?? '') + ' --no-warnings' },
  });

  if (res.status !== 0) {
    process.stderr.write(`[matrix] mode "${mode.label}" exited ${res.status}; skipping.\n`);
    return null;
  }
  const combined = (res.stdout ?? '') + '\n' + (res.stderr ?? '');
  // Still stream the child's stderr so the user sees progress.
  process.stderr.write(res.stderr ?? '');
  return parseOutput(combined);
}

// ── Main ──────────────────────────────────────────────────────────────────

const results = new Map<string, Parsed>();
for (const mode of MODES) {
  const parsed = runMode(mode);
  if (parsed) results.set(mode.label, parsed);
}

if (results.size === 0) {
  process.stderr.write('[matrix] no modes succeeded. Did you download the dataset?\n');
  process.exit(1);
}

const header = '# LongMemEval — ablation matrix';
const footer = [
  '',
  '_Each row is evaluated on the SAME 500 questions (or --limit subset). ' +
    'Numbers are deterministic across runs. Rerun before/after a retrieval change ' +
    'and ship only if targeted R@K moves the right direction without regressing the others._',
].join('\n');

const tableHead = ['| Mode | R@1 | R@5 | R@10 | Time (s) |', '|---|---|---|---|---|'];
const tableRows: string[] = [];

const modeOrder = MODES.map((m) => m.label).filter((l) => results.has(l));
const baselineLabel = modeOrder[0];
const baseline = results.get(baselineLabel);

function fmt(pct: number, base: number | null): string {
  if (!Number.isFinite(pct)) return '—';
  const main = `${pct.toFixed(1)}%`;
  if (base === null || !Number.isFinite(base)) return main;
  const delta = pct - base;
  if (Math.abs(delta) < 0.05) return main;
  return `${main} _(${delta > 0 ? '+' : ''}${delta.toFixed(1)}pp)_`;
}

for (const label of modeOrder) {
  const p = results.get(label)!;
  const isBaseline = label === baselineLabel;
  tableRows.push(
    `| \`${label}\`${isBaseline ? ' _(baseline)_' : ''} | ` +
      fmt(p.overall.r1, isBaseline ? null : (baseline?.overall.r1 ?? null)) +
      ' | ' +
      fmt(p.overall.r5, isBaseline ? null : (baseline?.overall.r5 ?? null)) +
      ' | ' +
      fmt(p.overall.r10, isBaseline ? null : (baseline?.overall.r10 ?? null)) +
      ' | ' +
      (Number.isFinite(p.elapsedSec) ? p.elapsedSec.toFixed(1) : '—') +
      ' |',
  );
}

// Per-question-type breakdown for the best mode (last = most-augmented).
const bestLabel = modeOrder[modeOrder.length - 1];
const best = results.get(bestLabel)!;
const typeOrder = [
  'single-session-user',
  'single-session-assistant',
  'single-session-preference',
  'multi-session',
  'temporal-reasoning',
  'knowledge-update',
];

const perTypeRows: string[] = [];
perTypeRows.push('| Question type | n | R@1 | R@5 | R@10 |');
perTypeRows.push('|---|---|---|---|---|');
for (const t of typeOrder) {
  const row = best.byType[t];
  if (!row) continue;
  perTypeRows.push(
    `| ${t} | ${row.n} | ${fmt(row.r1, null)} | ${fmt(row.r5, null)} | ${fmt(row.r10, null)} |`,
  );
}

console.log(header);
console.log('');
console.log(`Corpus: longmemeval_s_cleaned (${limit > 0 ? `limit ${limit}` : '500 Q'})`);
console.log('');
console.log('## Overall');
console.log('');
console.log(tableHead.join('\n'));
console.log(tableRows.join('\n'));
console.log('');
console.log(`## Per-question-type breakdown for \`${bestLabel}\``);
console.log('');
console.log(perTypeRows.join('\n'));
console.log(footer);
