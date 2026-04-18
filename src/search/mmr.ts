/**
 * Maximal Marginal Relevance re-ranking.
 *
 * MMR iteratively picks items that maximize relevance to the query while
 * penalizing similarity to items already picked. Trades a little top-1
 * relevance for diversity in the top-K — kills near-duplicate clusters in
 * the output, which is the common failure mode of "5 hits that all say the
 * same thing".
 *
 *   score(c) = lambda * relevance(c) - (1 - lambda) * max_{s ∈ selected} sim(c, s)
 *
 * Lambda:
 *   1.0 = pure relevance (no reranking; identity pass)
 *   0.7 = default — mild diversification
 *   0.0 = pure diversity — maximally spread, often drops obviously-relevant hits
 */

export interface MmrOptions<T> {
  /** Number of items to return. Default: min(items.length, 10). */
  k?: number;
  /** Relevance-vs-diversity tradeoff, 0-1. Default: 0.7. */
  lambda?: number;
  /** Pairwise similarity fn — cosine on embeddings, Jaccard on token sets, etc. */
  sim: (a: T, b: T) => number;
  /** Query-relevance score for an item. Typically the retrieval ranker's score. */
  relevance: (x: T) => number;
}

/**
 * Re-rank items using MMR. Returns a new array (does not mutate input).
 *
 * The returned array has length min(items.length, k) and is sorted by pick
 * order — first element is the highest-relevance item, subsequent elements
 * trade relevance for novelty.
 */
export function rerankMMR<T>(items: readonly T[], options: MmrOptions<T>): T[] {
  const { sim, relevance } = options;
  const lambda = options.lambda ?? 0.7;
  const k = Math.min(options.k ?? 10, items.length);
  if (k <= 0 || items.length === 0) return [];

  // Normalize lambda for safety — clamp to [0, 1].
  const lam = Math.max(0, Math.min(1, lambda));

  const remaining: T[] = [...items];
  const selected: T[] = [];

  // Pick #1: highest relevance (same as the input ranker).
  remaining.sort((a, b) => relevance(b) - relevance(a));
  selected.push(remaining.shift()!);

  while (selected.length < k && remaining.length > 0) {
    let bestIdx = 0;
    let bestScore = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i];
      let maxSim = 0;
      for (const s of selected) {
        const pairSim = sim(candidate, s);
        if (pairSim > maxSim) maxSim = pairSim;
      }
      const score = lam * relevance(candidate) - (1 - lam) * maxSim;
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }

    selected.push(remaining.splice(bestIdx, 1)[0]);
  }

  return selected;
}

/**
 * Count distinct "clusters" in a ranked list, where items are considered in
 * the same cluster if pairwise similarity exceeds threshold. Useful as a
 * diversity@K metric — how many DIFFERENT things does the top-K surface?
 *
 * Uses simple connected-components over the similarity graph.
 */
export function diversityAtK<T>(
  items: readonly T[],
  sim: (a: T, b: T) => number,
  threshold = 0.7,
): number {
  const n = items.length;
  if (n === 0) return 0;

  const parent = Array.from({ length: n }, (_, i) => i);
  function find(x: number): number {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  }
  function union(a: number, b: number): void {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (sim(items[i], items[j]) >= threshold) union(i, j);
    }
  }

  const roots = new Set<number>();
  for (let i = 0; i < n; i++) roots.add(find(i));
  return roots.size;
}

/**
 * Cosine similarity for number[] embeddings. Returns 0 for zero-magnitude
 * vectors rather than NaN, so MMR remains well-defined.
 */
export function cosineSim(a: readonly number[], b: readonly number[]): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Token-set Jaccard similarity — a cheap, embedding-free fallback for MMR.
 * Tokenizes by whitespace/punctuation and lowercases. Good enough to catch
 * the "same-topic near-duplicate" case when embeddings are unavailable.
 */
export function jaccardTokenSim(a: string, b: string): number {
  const tokenize = (s: string): Set<string> => {
    const out = new Set<string>();
    for (const tok of s.toLowerCase().split(/[\s.,;:!?()[\]{}"'<>/\\|`~@#$%^&*=+_-]+/)) {
      if (tok.length > 2) out.add(tok);
    }
    return out;
  };
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union;
}
