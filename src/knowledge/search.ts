import fs from 'fs';
import path from 'path';
import { BM25Index } from '../search/bm25.js';
import { getEntryScoring, computeFinalScore, decayFactor, maturityMultiplier } from './scoring.js';
import { buildExcerpt } from '../search/excerpt.js';
import { listEntries, readEntry, KnowledgeEntry } from './store.js';
import { rerankMMR, jaccardTokenSim } from '../search/mmr.js';

export interface SearchOptions {
  category?: string;
  maxResults?: number;
  caseSensitive?: boolean;
  /**
   * How to use `category`:
   *  - 'filter': only entries in `category` are indexed — silently drops
   *     everything else.
   *  - 'boost' (DEFAULT): all entries are indexed; matching-category entries
   *     get a score multiplier. Prevents the "zero results because the
   *     category guess was wrong" failure mode.
   *
   * NOTE: The default flipped from 'filter' to 'boost' in v1.8.0 as part of
   * the agent-UX pass. Pass 'filter' explicitly for the legacy hard-filter
   * behavior.
   */
  categoryMode?: 'filter' | 'boost';
  /** Apply MMR diversification to the result list. Default: false. */
  mmr?: boolean;
  /** MMR relevance-vs-diversity tradeoff 0-1. Default: 0.7. */
  mmrLambda?: number;
  /** When true, each result carries a `score_components` breakdown. */
  explain?: boolean;
}

/** Score multiplier applied to entries whose category matches in 'boost' mode. */
export const CATEGORY_BOOST_MULTIPLIER = 1.25;

/** Default MMR tradeoff when the caller passes `mmr: true` without `mmrLambda`. */
export const DEFAULT_MMR_LAMBDA = 0.7;

export interface ScoreComponents {
  bm25: number;
  decay: number;
  maturity: number;
  confidence: number;
  category_boost: number;
  mmr_penalty: number;
}

/**
 * Freshness + trust metadata attached to every knowledge hit (v1.8.1).
 *
 * These are automatic signals — no agent action required. The agent can read
 * them to form a trust judgment ("body last edited 120 days ago, still being
 * accessed 8x/week → probably out of date") without us imposing policy via
 * demotion or flags.
 */
export interface FreshnessMeta {
  /** Days since the underlying markdown file was last modified on disk. */
  body_age_days: number | null;
  /** ISO timestamp of the most recent read via knowledge(action:"read"). */
  last_accessed: string | null;
  /** Number of recorded reads. */
  access_count: number;
  /** ISO timestamp of the last promoter auto-verify (or future explicit verify). */
  verified_at: string | null;
  /** Days since last verified, null if never verified. */
  verification_age_days: number | null;
  /** Evergreen entries are exempt from decay-based demotion; surfaced here for UI. */
  evergreen: boolean;
}

export interface SearchResult {
  entry: KnowledgeEntry;
  score: number;
  excerpt: string;
  /** Populated only when the caller passes `explain: true`. */
  score_components?: ScoreComponents;
  /** Automatic freshness + trust signal — present on every hit. */
  freshness?: FreshnessMeta;
}

// ── TF-IDF index cache for knowledge entries ──────────────────────────────

interface KnowledgeIndexCache {
  index: BM25Index;
  documents: Array<{ entry: KnowledgeEntry; content: string }>;
  timestamp: number;
  /** Cache key: dir + category */
  cacheKey: string;
}

let _knowledgeIndexCache: KnowledgeIndexCache | null = null;
const KNOWLEDGE_INDEX_TTL = 60_000; // 60 seconds, matching session search cache

/** Invalidate the knowledge TF-IDF index cache (call on write/delete). */
export function invalidateKnowledgeIndexCache(): void {
  _knowledgeIndexCache = null;
}

function getOrBuildKnowledgeIndex(
  dir: string,
  category?: string,
): { index: BM25Index; documents: Array<{ entry: KnowledgeEntry; content: string }> } {
  const cacheKey = `${dir}:${category ?? ''}`;
  const now = Date.now();

  if (
    _knowledgeIndexCache &&
    now - _knowledgeIndexCache.timestamp < KNOWLEDGE_INDEX_TTL &&
    _knowledgeIndexCache.cacheKey === cacheKey
  ) {
    return _knowledgeIndexCache;
  }

  const entries = listEntries(dir, category);
  const documents: Array<{ entry: KnowledgeEntry; content: string }> = [];

  for (const entry of entries) {
    try {
      const { content } = readEntry(dir, entry.path);
      documents.push({ entry: { ...entry, content }, content });
    } catch {
      continue;
    }
  }

  const index = new BM25Index();
  for (const doc of documents) {
    index.addDocument(doc.entry.path, doc.content);
  }

  _knowledgeIndexCache = { index, documents, timestamp: now, cacheKey };
  return { index, documents };
}

/**
 * Search knowledge entries using TF-IDF ranking with regex fallback.
 *
 * Uses a cached TF-IDF index (60s TTL, invalidated on write/delete) to
 * avoid rebuilding the index on every search. Falls back to regex search
 * if TF-IDF returns no results (useful for exact phrase matches).
 *
 * Scoring:
 *   score = bm25 * decay(last_accessed) * maturity(level) * confidence * category_boost
 *
 * When `mmr` is true, the TF-IDF top-K is re-ranked with Maximal Marginal
 * Relevance on token-Jaccard similarity — see search/mmr.ts.
 */
export function searchKnowledge(
  dir: string,
  query: string,
  options: SearchOptions = {},
): Array<SearchResult> {
  const {
    category,
    maxResults = 10,
    caseSensitive = false,
    categoryMode = 'boost',
    mmr = false,
    mmrLambda = DEFAULT_MMR_LAMBDA,
    explain = false,
  } = options;

  // In 'boost' mode, build the index over the full corpus (no category restriction).
  // In 'filter' mode, keep legacy behavior of restricting the index to one category.
  const indexCategory = categoryMode === 'boost' ? undefined : category;
  const { index, documents } = getOrBuildKnowledgeIndex(dir, indexCategory);

  if (documents.length === 0) return [];

  // Fetch a wider candidate pool when MMR is enabled so diversification has
  // room to operate. Cap at 3× maxResults to avoid pathological long tails.
  const candidatePool = mmr ? Math.min(maxResults * 3, documents.length) : maxResults;

  // Search using TF-IDF
  const tfidfResults = index.search(query, candidatePool);

  if (tfidfResults.length > 0) {
    const results: SearchResult[] = [];
    const scoring = getEntryScoring();
    const entryPaths = tfidfResults
      .map((r) => documents.find((d) => d.entry.path === r.id)?.entry.path)
      .filter((p): p is string => p !== undefined);
    const scores = scoring.getScores(entryPaths);

    for (const result of tfidfResults) {
      const doc = documents.find((d) => d.entry.path === result.id);
      if (!doc) continue;

      const scoreInfo = scores.get(doc.entry.path);
      const maturity = (scoreInfo?.maturity ?? 'candidate') as
        | 'candidate'
        | 'established'
        | 'proven';
      const lastAccessed = scoreInfo?.last_accessed ?? null;
      const confidence = doc.entry.confidence;
      const evergreen = doc.entry.evergreen === true;
      let finalScore = computeFinalScore(
        result.score,
        lastAccessed,
        maturity,
        confidence,
        evergreen,
      );

      // Category boost: in 'boost' mode, give matching-category entries an
      // edge instead of dropping non-matching entries.
      let categoryBoost = 1;
      if (categoryMode === 'boost' && category && doc.entry.category === category) {
        categoryBoost = CATEGORY_BOOST_MULTIPLIER;
        finalScore *= categoryBoost;
      }

      const components: ScoreComponents | undefined = explain
        ? {
            bm25: result.score,
            decay: evergreen ? 1 : lastAccessed ? decayFactor(lastAccessed) : 1,
            maturity: maturityMultiplier(maturity),
            confidence: confidence === 'inferred' ? 0.85 : 1,
            category_boost: categoryBoost,
            mmr_penalty: 1, // updated below if MMR runs
          }
        : undefined;

      // v1.8.1: automatic freshness metadata per hit — surface the trust
      // signals the agent needs to judge whether this entry is still current,
      // without requiring any agent-proactive call. Cheap: scoring row is
      // already loaded above; body mtime is a single fs.statSync. We tolerate
      // stat errors gracefully and emit `null` age.
      let bodyAgeDays: number | null = null;
      try {
        const full = path.join(dir, doc.entry.path);
        const stat = fs.statSync(full);
        bodyAgeDays = Math.round(((Date.now() - stat.mtimeMs) / (24 * 3600_000)) * 10) / 10;
      } catch {
        /* ignore — file may have been moved */
      }
      const verifiedAt = scoreInfo?.verified_at ?? null;
      const freshness = {
        body_age_days: bodyAgeDays,
        last_accessed: lastAccessed,
        access_count: scoreInfo?.access_count ?? 0,
        verified_at: verifiedAt,
        verification_age_days: verifiedAt
          ? Math.round(((Date.now() - new Date(verifiedAt).getTime()) / (24 * 3600_000)) * 10) / 10
          : null,
        evergreen,
      };

      const res: SearchResult = {
        entry: doc.entry,
        score: finalScore,
        excerpt: buildExcerpt(doc.content, query, { caseSensitive, contextAfter: 200 }),
        freshness,
      };
      if (components) res.score_components = components;
      results.push(res);
    }

    // Filter out negative scores and sort by final score
    const filtered = results.filter((r) => r.score > 0);
    filtered.sort((a, b) => b.score - a.score);

    // Optional MMR re-ranking — diversifies the top-K at a small relevance cost.
    if (mmr && filtered.length > 1) {
      const reranked = rerankMMR(filtered, {
        k: maxResults,
        lambda: mmrLambda,
        relevance: (r) => r.score,
        sim: (a, b) =>
          jaccardTokenSim(a.entry.content ?? a.excerpt ?? '', b.entry.content ?? b.excerpt ?? ''),
      });
      if (explain) {
        // Track where each item came from for the mmr_penalty component.
        // Items picked first get penalty=1 (no penalty); later picks get
        // a smaller value reflecting diversity cost.
        const originalRank = new Map(filtered.map((r, idx) => [r.entry.path, idx + 1]));
        reranked.forEach((r, newIdx) => {
          const orig = originalRank.get(r.entry.path) ?? newIdx + 1;
          if (r.score_components) {
            r.score_components.mmr_penalty = newIdx === 0 ? 1 : Math.min(1, orig / (newIdx + 1));
          }
        });
      }
      return reranked;
    }

    return filtered.slice(0, maxResults);
  }

  // Fallback: regex search for exact phrase matches
  const flags = caseSensitive ? 'g' : 'gi';
  let regex: RegExp;
  try {
    regex = new RegExp(query, flags);
  } catch {
    regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
  }

  const regexResults: SearchResult[] = [];
  for (const doc of documents) {
    regex.lastIndex = 0; // Reset before test() — global regex is stateful
    if (regex.test(doc.content)) {
      regexResults.push({
        entry: doc.entry,
        score: 1,
        excerpt: buildExcerpt(doc.content, query, { caseSensitive, contextAfter: 200 }),
      });
      if (regexResults.length >= maxResults) break;
    }
  }

  return regexResults;
}
