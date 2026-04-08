import { TfIdfIndex, recencyDecay } from '../search/tfidf.js';
import { buildExcerpt } from '../search/excerpt.js';
import { buildBoostContext, applyBoosts, hasAnyBoostSignal } from '../search/boosts.js';
import {
  getProjectDirs,
  getSessionFiles,
  parseSessionFile,
  extractMessages,
  getSessionMeta,
} from './parser.js';
import type { SearchResult } from '../search/types.js';
import { getEmbeddingProvider } from '../embeddings/index.js';
import { VectorStore } from '../vectorstore/index.js';
import { getConfig } from '../types.js';

export interface SearchSessionOptions {
  project?: string;
  role?: 'user' | 'assistant' | 'all';
  caseSensitive?: boolean;
  maxResults?: number;
  /** When true (default), use TF-IDF ranking. When false, use regex matching. */
  ranked?: boolean;
  /** When true (default when embeddings available), blend semantic similarity with TF-IDF. */
  semantic?: boolean;
}

// ── Lazy VectorStore singleton ──────────────────────────────────────────────

let _vectorStore: VectorStore | null = null;

function getVectorStore(): VectorStore {
  if (!_vectorStore) {
    _vectorStore = new VectorStore();
  }
  return _vectorStore;
}

/**
 * Search across all session transcripts.
 *
 * Supports three modes:
 * - **hybrid** (default when embeddings available): blends TF-IDF ranking
 *   with semantic vector similarity using configurable alpha weighting.
 * - **ranked** (default fallback): builds a TF-IDF index over all messages,
 *   returns results ordered by relevance score.
 * - **legacy** (`ranked: false`): regex-based matching, faster for exact
 *   phrases and pattern searches.
 *
 * Returns results with excerpts (100 chars before + 100 chars after match).
 */
export async function searchSessions(
  query: string,
  options: SearchSessionOptions = {},
): Promise<SearchResult[]> {
  const {
    project,
    role = 'all',
    caseSensitive = false,
    maxResults = 20,
    ranked = true,
    semantic = true,
  } = options;

  const projects = getProjectDirs().filter(
    (p) => !project || p.name.toLowerCase().includes(project.toLowerCase()),
  );

  if (!ranked) {
    return regexSearch(query, projects, role, caseSensitive, maxResults);
  }

  const tfidfResults = rankedSearch(query, projects, role, maxResults);

  if (semantic) {
    try {
      const config = getConfig();
      const hybridResults = await hybridSearch(
        query,
        tfidfResults,
        maxResults,
        config.embeddingAlpha,
      );
      return hybridResults;
    } catch {
      // Semantic failed silently — fall back to pure TF-IDF
    }
  }

  return tfidfResults;
}

// ── Hybrid search (TF-IDF + semantic) ───────────────────────────────────────

async function hybridSearch(
  query: string,
  tfidfResults: SearchResult[],
  maxResults: number,
  alpha: number,
): Promise<SearchResult[]> {
  const provider = await getEmbeddingProvider();
  if (!provider) {
    return tfidfResults;
  }

  let queryVector: number[];
  try {
    queryVector = await provider.embedOne(query);
  } catch {
    return tfidfResults;
  }

  const store = getVectorStore();
  let vectorResults;
  try {
    vectorResults = store.searchBySource(queryVector, 'session', maxResults * 2);
  } catch {
    return tfidfResults;
  }

  if (vectorResults.length === 0) {
    return tfidfResults;
  }

  // Build a map of semantic scores keyed by sessionId
  // Multiple chunks may match for the same session — take the max score
  const semanticScores = new Map<string, number>();
  for (const vr of vectorResults) {
    const existing = semanticScores.get(vr.sourceId) ?? 0;
    if (vr.score > existing) {
      semanticScores.set(vr.sourceId, vr.score);
    }
  }

  // Normalize TF-IDF scores to 0-1 range
  const maxTfidf = tfidfResults.length > 0 ? Math.max(...tfidfResults.map((r) => r.score)) : 1;
  const normFactor = maxTfidf > 0 ? maxTfidf : 1;

  // Build boost context once per query (proper-noun + temporal-proximity boosts).
  // hasAnyBoostSignal short-circuits when neither signal is present.
  const boostCtx = buildBoostContext(query);
  const boostsActive = hasAnyBoostSignal(boostCtx);

  // Merge: start with TF-IDF results, blend in semantic scores
  const merged = new Map<string, SearchResult>();

  for (const result of tfidfResults) {
    const key = `${result.id}:${result.timestamp ?? ''}`;
    const normalizedTfidf = result.score / normFactor;
    const semanticScore = semanticScores.get(result.id) ?? 0;
    const blended = alpha * normalizedTfidf + (1 - alpha) * semanticScore;

    // Apply recency decay on top of blended score
    const ts = result.timestamp ?? (result.metadata?.sessionDate as string | undefined);
    const decay = ts ? recencyDecay(ts) : 1;
    const decayed = blended * decay;
    const finalScore = boostsActive
      ? applyBoosts(decayed, boostCtx, { docText: result.excerpt, docTimestamp: ts ?? null })
      : decayed;

    merged.set(key, {
      ...result,
      score: finalScore,
      metadata: {
        ...result.metadata,
        tfidfScore: normalizedTfidf,
        semanticScore,
        blendAlpha: alpha,
      },
    });
  }

  for (const vr of vectorResults) {
    const alreadyPresent = Array.from(merged.values()).some((r) => r.id === vr.sourceId);
    if (!alreadyPresent) {
      const semanticScore = vr.score;
      const blended = (1 - alpha) * semanticScore;
      // Use chunkText metadata for excerpt
      const excerpt = vr.chunkText.length > 200 ? vr.chunkText.slice(0, 200) + '...' : vr.chunkText;
      const timestamp = (vr.metadata?.timestamp as string | undefined) ?? undefined;
      const decay = timestamp ? recencyDecay(timestamp) : 0.5;
      const finalScore = blended * decay;

      const key = `${vr.sourceId}:${timestamp ?? ''}`;
      if (!merged.has(key)) {
        merged.set(key, {
          source: 'session',
          id: vr.sourceId,
          role: (vr.metadata?.role as string | undefined) ?? 'unknown',
          timestamp,
          excerpt,
          score: finalScore,
          metadata: {
            tfidfScore: 0,
            semanticScore,
            blendAlpha: alpha,
          },
        });
      }
    }
  }

  const results = Array.from(merged.values());
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, maxResults);
}

// ── TF-IDF ranked search with index cache ─────────────────────────────────

interface DocRef {
  project: string;
  sessionId: string;
  role: string;
  timestamp: string | null;
  content: string;
  sessionDate: string;
}

interface IndexCache {
  index: TfIdfIndex;
  docMap: Map<string, DocRef>;
  timestamp: number;
  projectHash: string;
  role: string;
}

let _indexCache: IndexCache | null = null;
const INDEX_TTL = 60_000; // 60 seconds

function getOrBuildIndex(
  projects: Array<{ name: string; path: string }>,
  role: string,
): { index: TfIdfIndex; docMap: Map<string, DocRef> } {
  const projectHash = projects.map((p) => p.name).join(',');
  const now = Date.now();

  if (
    _indexCache &&
    now - _indexCache.timestamp < INDEX_TTL &&
    _indexCache.projectHash === projectHash &&
    _indexCache.role === role
  ) {
    return _indexCache;
  }

  const index = new TfIdfIndex();
  const docMap = new Map<string, DocRef>();
  let docCounter = 0;

  for (const proj of projects) {
    const sessions = getSessionFiles(proj.path);
    for (const sess of sessions) {
      try {
        const entries = parseSessionFile(sess.file);
        if (entries.length === 0) continue;
        const meta = getSessionMeta(entries);
        const messages = extractMessages(entries);

        for (const msg of messages) {
          if (role !== 'all' && msg.role !== role) continue;

          const docId = `doc_${docCounter++}`;
          index.addDocument(docId, msg.content);
          docMap.set(docId, {
            project: proj.name,
            sessionId: sess.id,
            role: msg.role,
            timestamp: msg.timestamp,
            content: msg.content,
            sessionDate: meta.startTime,
          });
        }
      } catch {
        // skip broken files
      }
    }
  }

  _indexCache = { index, docMap, timestamp: now, projectHash, role };
  return _indexCache;
}

function rankedSearch(
  query: string,
  projects: Array<{ name: string; path: string }>,
  role: string,
  maxResults: number,
): SearchResult[] {
  const { index, docMap } = getOrBuildIndex(projects, role);
  const ranked = index.search(query, maxResults * 2);

  const results = ranked
    .map(({ id, score }) => {
      const doc = docMap.get(id);
      if (!doc) return null;
      const excerpt = buildExcerpt(doc.content, query);
      const ts = doc.timestamp ?? doc.sessionDate;
      const decay = recencyDecay(ts);
      const adjustedScore = score * decay;

      return {
        source: 'session' as const,
        id: doc.sessionId,
        project: doc.project,
        role: doc.role,
        timestamp: ts,
        excerpt,
        score: adjustedScore,
        metadata: {
          sessionDate: doc.sessionDate,
          relevanceScore: score,
          recencyMultiplier: Math.round(decay * 100) / 100,
        },
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, maxResults);
}

// ── Regex-based search (legacy mode) ────────────────────────────────────────

function regexSearch(
  query: string,
  projects: Array<{ name: string; path: string }>,
  role: string,
  caseSensitive: boolean,
  maxResults: number,
): SearchResult[] {
  const flags = caseSensitive ? 'g' : 'gi';
  let regex: RegExp;
  try {
    regex = new RegExp(query, flags);
  } catch {
    regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
  }

  const matches: SearchResult[] = [];

  for (const proj of projects) {
    const sessions = getSessionFiles(proj.path);
    for (const sess of sessions) {
      try {
        const entries = parseSessionFile(sess.file);
        if (entries.length === 0) continue;
        const meta = getSessionMeta(entries);
        const messages = extractMessages(entries);

        for (const msg of messages) {
          if (role !== 'all' && msg.role !== role) continue;
          // Reset lastIndex before test() — global regex is stateful
          regex.lastIndex = 0;
          if (!regex.test(msg.content)) continue;

          const excerpt = buildExcerpt(msg.content, query, { caseSensitive });

          matches.push({
            source: 'session',
            id: sess.id,
            project: proj.name,
            role: msg.role,
            timestamp: msg.timestamp ?? meta.startTime,
            excerpt,
            score: 1, // no ranking in regex mode
            metadata: {
              sessionDate: meta.startTime,
            },
          });

          if (matches.length >= maxResults) break;
        }
      } catch {
        // skip
      }
      if (matches.length >= maxResults) break;
    }
    if (matches.length >= maxResults) break;
  }

  return matches;
}

// buildExcerpt imported from ../search/excerpt.js
