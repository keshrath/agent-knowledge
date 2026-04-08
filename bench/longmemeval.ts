/**
 * LongMemEval benchmark runner for agent-knowledge.
 *
 * LongMemEval (Wu et al. 2024, ICLR 2025) — public academic benchmark for
 * long-term memory retrieval in conversational agents. 500 questions across
 * 6 question types, ~54 candidate sessions per question.
 * Dataset: https://huggingface.co/datasets/xiaowu0162/longmemeval
 *
 * Task: for each question, retrieve top-K sessions from a haystack of ~54
 * candidate sessions and score 1 if any ground-truth `answer_session_ids`
 * appears in the top-K.
 *
 * Modes:
 *   raw       — TF-IDF only. No boosts, no embeddings.
 *   boosts    — TF-IDF + the v1.4 proper-noun and temporal-proximity boosts
 *               from src/search/boosts.ts applied at re-rank.
 *   semantic  — Local Hugging Face embedding (Xenova/all-MiniLM-L6-v2) with
 *               per-session chunking and max-pool cosine similarity.
 *   hybrid    — alpha · TF-IDF + (1-alpha) · semantic, with v1.4 boosts.
 *               Default alpha=0.3 (matches getConfig().embeddingAlpha).
 *
 * Usage:
 *   # one-time: download the dataset (~264 MB)
 *   curl -L -o ~/.claude/tmp/longmemeval/longmemeval_s_cleaned.json \
 *     https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json
 *
 *   # run
 *   npx tsx bench/longmemeval.ts                # raw
 *   npx tsx bench/longmemeval.ts --boosts       # raw + v1.4 boosts
 *   npx tsx bench/longmemeval.ts --limit 50     # quick smoke
 *
 * Env:
 *   LONGMEMEVAL_PATH  override dataset location
 */

import fs from 'fs';
import path from 'path';
import { homedir } from 'os';
import { TfIdfIndex } from '../src/search/tfidf.js';
import { BM25Index } from '../src/search/bm25.js';
import { applyBoosts, buildBoostContext, hasAnyBoostSignal } from '../src/search/boosts.js';
import { getEmbeddingProvider } from '../src/embeddings/index.js';

interface Turn {
  role: string;
  content: string;
}

interface Question {
  question_id: string;
  question_type: string;
  question: string;
  answer: string;
  question_date?: string;
  haystack_dates?: string[];
  haystack_session_ids: string[];
  haystack_sessions: Turn[][];
  answer_session_ids: string[];
}

const args = process.argv.slice(2);
const useBoosts = args.includes('--boosts');
const rankerArg = args.find((a) => a.startsWith('--ranker'));
const ranker = rankerArg ? (rankerArg.split('=')[1] ?? args[args.indexOf(rankerArg) + 1]) : 'tfidf';
const useSemantic = args.includes('--semantic');
const useHybrid = args.includes('--hybrid');
const alphaArg = args.find((a) => a.startsWith('--alpha'));
const alpha = alphaArg
  ? parseFloat(alphaArg.split('=')[1] ?? args[args.indexOf(alphaArg) + 1])
  : 0.3;
const limitArg = args.find((a) => a.startsWith('--limit'));
const limit = limitArg
  ? parseInt(limitArg.split('=')[1] ?? args[args.indexOf(limitArg) + 1], 10)
  : 0;

const datasetPath =
  process.env.LONGMEMEVAL_PATH ??
  path.join(homedir(), '.claude', 'tmp', 'longmemeval', 'longmemeval_s_cleaned.json');

if (!fs.existsSync(datasetPath)) {
  console.error(`LongMemEval dataset not found at ${datasetPath}`);
  console.error('Download with:');
  console.error(
    '  curl -L -o ~/.claude/tmp/longmemeval/longmemeval_s_cleaned.json \\\n    https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json',
  );
  process.exit(1);
}

console.error(`Loading ${datasetPath}...`);
const t0 = Date.now();
const raw = fs.readFileSync(datasetPath, 'utf-8');
const data: Question[] = JSON.parse(raw);
console.error(`Loaded ${data.length} questions in ${Date.now() - t0}ms`);

const questions = limit > 0 ? data.slice(0, limit) : data;

const modeName = useHybrid
  ? `hybrid (alpha=${alpha})`
  : useSemantic
    ? 'semantic'
    : useBoosts
      ? 'raw + boosts'
      : 'raw TF-IDF';
console.error(`Running on ${questions.length} questions in ${modeName} mode...`);

// Lazy-load embedding provider only if needed
let _provider: Awaited<ReturnType<typeof getEmbeddingProvider>> | null = null;
async function ensureProvider() {
  if (_provider !== null) return _provider;
  if (!useSemantic && !useHybrid) return null;
  console.error('Loading local embedding provider (Xenova/all-MiniLM-L6-v2)...');
  _provider = await getEmbeddingProvider();
  if (!_provider) {
    console.error('No embedding provider available — falling back to raw TF-IDF');
  }
  return _provider;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

// MiniLM has a 256-token context (~1000 chars). One embedding per session
// would silently drop everything past the first message — the answer is
// often later in the session. Instead, split each session into N chunks of
// CHUNK_CHARS with CHUNK_OVERLAP, embed each, and take max-cosine per session.
// This mirrors what `vectorstore.searchBySource` does in production.
const CHUNK_CHARS = 900;
const CHUNK_OVERLAP = 150;
const MAX_CHUNKS_PER_SESSION = 6;

function chunkForEmbedding(text: string): string[] {
  if (text.length <= CHUNK_CHARS) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length && chunks.length < MAX_CHUNKS_PER_SESSION) {
    const end = Math.min(start + CHUNK_CHARS, text.length);
    chunks.push(text.slice(start, end));
    if (end === text.length) break;
    start += CHUNK_CHARS - CHUNK_OVERLAP;
  }
  return chunks;
}

interface Bucket {
  total: number;
  hit5: number;
  hit10: number;
  hit1: number;
}
const overall: Bucket = { total: 0, hit5: 0, hit10: 0, hit1: 0 };
const byType = new Map<string, Bucket>();
function getBucket(name: string): Bucket {
  let b = byType.get(name);
  if (!b) {
    b = { total: 0, hit5: 0, hit10: 0, hit1: 0 };
    byType.set(name, b);
  }
  return b;
}

function joinSession(turns: Turn[]): string {
  // Concatenate role-prefixed turns into one document per session.
  return turns.map((t) => `[${t.role}]: ${t.content}`).join('\n');
}

const startMs = Date.now();
let processed = 0;

const provider = await ensureProvider();
const semanticActive = (useSemantic || useHybrid) && provider !== null;

for (const q of questions) {
  if (q.haystack_sessions.length !== q.haystack_session_ids.length) {
    console.error(`skip ${q.question_id}: id/session length mismatch`);
    continue;
  }

  // Build a fresh sparse index over this question's haystack
  const index: TfIdfIndex | BM25Index = ranker === 'bm25' ? new BM25Index() : new TfIdfIndex();
  const sessionDates = new Map<string, string>();
  for (let i = 0; i < q.haystack_sessions.length; i++) {
    const id = q.haystack_session_ids[i];
    const text = joinSession(q.haystack_sessions[i]);
    index.addDocument(id, text);
    if (q.haystack_dates && q.haystack_dates[i]) {
      sessionDates.set(id, q.haystack_dates[i]);
    }
  }

  let ranked = index.search(q.question, 20);

  // ── Semantic / hybrid path ──────────────────────────────────────────────
  if (semanticActive && provider) {
    // Build a flat list of (sessionId, chunkText) so we can batch-embed.
    const allChunks: string[] = [];
    const chunkOwner: number[] = []; // index into haystack_session_ids
    for (let i = 0; i < q.haystack_sessions.length; i++) {
      const text = joinSession(q.haystack_sessions[i]);
      const pieces = chunkForEmbedding(text);
      for (const p of pieces) {
        allChunks.push(p);
        chunkOwner.push(i);
      }
    }
    const embeddings = await provider.embed(allChunks);
    const queryVec = await provider.embedOne(q.question);

    // Max-pool: best chunk score per session
    const maxBySession = new Array<number>(q.haystack_session_ids.length).fill(-Infinity);
    for (let c = 0; c < embeddings.length; c++) {
      const sim = cosine(queryVec, embeddings[c]);
      const owner = chunkOwner[c];
      if (sim > maxBySession[owner]) maxBySession[owner] = sim;
    }

    const maxTfidf = ranked.length > 0 ? Math.max(...ranked.map((r) => r.score)) : 1;
    const norm = maxTfidf > 0 ? maxTfidf : 1;
    const tfidfMap = new Map<string, number>();
    for (const r of ranked) tfidfMap.set(r.id, r.score / norm);

    const semScores: Array<{ id: string; score: number }> = [];
    for (let i = 0; i < q.haystack_session_ids.length; i++) {
      const id = q.haystack_session_ids[i];
      const sem = maxBySession[i] === -Infinity ? 0 : maxBySession[i];
      if (useHybrid) {
        const tf = tfidfMap.get(id) ?? 0;
        semScores.push({ id, score: alpha * tf + (1 - alpha) * sem });
      } else {
        semScores.push({ id, score: sem });
      }
    }
    semScores.sort((a, b) => b.score - a.score);
    ranked = semScores.slice(0, 20);
  }

  if (useBoosts || useHybrid) {
    const ctx = buildBoostContext(q.question);
    if (hasAnyBoostSignal(ctx)) {
      ranked = ranked
        .map((r) => {
          // Pull the original session text for boost matching
          const sessionIdx = q.haystack_session_ids.indexOf(r.id);
          const docText = sessionIdx >= 0 ? joinSession(q.haystack_sessions[sessionIdx]) : '';
          const docTimestamp = sessionDates.get(r.id) ?? null;
          const boosted = applyBoosts(r.score, ctx, { docText, docTimestamp });
          return { ...r, score: boosted };
        })
        .sort((a, b) => b.score - a.score);
    }
  }

  const top = ranked.map((r) => r.id);
  const answerSet = new Set(q.answer_session_ids);
  const inTop = (k: number) => top.slice(0, k).some((id) => answerSet.has(id));

  const bucket = getBucket(q.question_type);
  bucket.total++;
  overall.total++;
  if (inTop(1)) {
    bucket.hit1++;
    overall.hit1++;
  }
  if (inTop(5)) {
    bucket.hit5++;
    overall.hit5++;
  }
  if (inTop(10)) {
    bucket.hit10++;
    overall.hit10++;
  }

  processed++;
  if (processed % 50 === 0) {
    process.stderr.write(`  ${processed}/${questions.length}\r`);
  }
}

const elapsedMs = Date.now() - startMs;
console.error(`\nProcessed ${processed} questions in ${(elapsedMs / 1000).toFixed(1)}s`);

function pct(n: number, d: number): string {
  if (d === 0) return '—';
  return `${((n / d) * 100).toFixed(1)}%`;
}

const rows: string[] = [];
rows.push('| Question type | n | R@1 | R@5 | R@10 |');
rows.push('|---|---|---|---|---|');

const order = [
  'single-session-user',
  'single-session-assistant',
  'single-session-preference',
  'multi-session',
  'temporal-reasoning',
  'knowledge-update',
];
for (const name of order) {
  const b = byType.get(name);
  if (!b) continue;
  rows.push(
    `| ${name} | ${b.total} | ${pct(b.hit1, b.total)} | ${pct(b.hit5, b.total)} | ${pct(b.hit10, b.total)} |`,
  );
}
// Any types we didn't pre-list
for (const [name, b] of byType) {
  if (!order.includes(name)) {
    rows.push(
      `| ${name} | ${b.total} | ${pct(b.hit1, b.total)} | ${pct(b.hit5, b.total)} | ${pct(b.hit10, b.total)} |`,
    );
  }
}
rows.push(
  `| **OVERALL** | **${overall.total}** | **${pct(overall.hit1, overall.total)}** | **${pct(overall.hit5, overall.total)}** | **${pct(overall.hit10, overall.total)}** |`,
);

console.log('\n# LongMemEval results — agent-knowledge\n');
console.log(`Mode: **${modeName}**`);
console.log(`Dataset: longmemeval_s (${data.length} questions, 500 expected)`);
console.log(`Processed: ${processed} questions`);
console.log(`Time: ${(elapsedMs / 1000).toFixed(1)}s\n`);
console.log(rows.join('\n'));
console.log('');
