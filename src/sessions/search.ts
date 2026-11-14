import { statSync, type Stats } from 'node:fs';
import { recencyDecay } from '../search/tfidf.js';
import { BM25Index } from '../search/bm25.js';
import { runSliced } from '../slice.js';
import { buildExcerpt } from '../search/excerpt.js';
import { buildBoostContext, applyBoosts, hasAnyBoostSignal } from '../search/boosts.js';
import {
  getProjectDirs,
  getSessionFiles,
  parseSessionFile,
  extractMessages,
  getSessionMeta,
  readSessionTail,
  type SessionEntry,
} from './parser.js';
import type { SearchResult } from '../search/types.js';
import { projectName } from './human.js';
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

  const tfidfResults = await rankedSearch(query, projects, role, maxResults);

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
  /** The project as a person names it (`projectName`). */
  name: string;
  sessionId: string;
  role: string;
  timestamp: string | null;
  content: string;
  sessionDate: string;
}

/**
 * One TF-IDF index over every session message (a search for a role or projects filters its
 * ranking), kept in step with
 * the session files. Each search compares the files' sizes with what was read: a session file
 * that grew (a live session appends to it) is read from where the last read ended, one that
 * shrank or was replaced is read again, a new one is read whole and a gone one dropped. A
 * session an adapter serves from elsewhere (a database: no file) is read again once a minute.
 */
interface SessionIndex {
  index: BM25Index;
  docMap: Map<string, DocRef>;
  /** Per session: the byte its file was read up to (-1: no file), when read, and its docs. */
  files: Map<
    string,
    { end: number; mtimeMs: number; startTime: string; name: string; docIds: string[] }
  >;
  checkedAt: number;
  nextId: number;
}

let sessionIndex: SessionIndex | null = null;
/** Searches within this long of the last comparison trust it. */
const RECHECK_MS = 2_000;
/** How often a session without a file is read again. */
const VIRTUAL_REFRESH_MS = 60_000;

function dropFile(idx: SessionIndex, file: string): void {
  for (const id of idx.files.get(file)?.docIds ?? []) {
    idx.index.removeDocument(id);
    idx.docMap.delete(id);
  }
  idx.files.delete(file);
}

/** Indexes `entries` of a session; `startTime` is the session's own, from its first read. */
function addEntries(
  idx: SessionIndex,
  entries: SessionEntry[],
  ref: { project: string; name: string; sessionId: string; startTime: string },
): string[] {
  const docIds: string[] = [];
  for (const msg of extractMessages(entries)) {
    const docId = `doc_${idx.nextId++}`;
    idx.index.addDocument(docId, msg.content);
    idx.docMap.set(docId, {
      project: ref.project,
      name: ref.name,
      sessionId: ref.sessionId,
      role: msg.role,
      timestamp: msg.timestamp,
      content: msg.content,
      sessionDate: ref.startTime,
    });
    docIds.push(docId);
  }
  return docIds;
}

/** Brings one session's documents up to date with its file (or its adapter). */
function refreshSession(
  idx: SessionIndex,
  file: string,
  ref: { project: string; sessionId: string },
  now: number,
): void {
  const had = idx.files.get(file);
  let st: Stats | null = null;
  try {
    st = statSync(file);
  } catch {
    /* no file: an adapter's session */
  }

  if (!st) {
    if (had && now - had.mtimeMs < VIRTUAL_REFRESH_MS) return;
    dropFile(idx, file);
    const entries = parseSessionFile(file);
    const meta = getSessionMeta(entries);
    const name = projectName(meta.cwd, ref.project);
    const docIds = addEntries(idx, entries, { ...ref, startTime: meta.startTime, name });
    idx.files.set(file, { end: -1, mtimeMs: now, startTime: meta.startTime, name, docIds });
    return;
  }

  if (had && had.end === st.size && had.mtimeMs === st.mtimeMs) return;
  const grew = had !== undefined && had.end >= 0 && st.size >= had.end;
  if (!grew) dropFile(idx, file);
  const { entries, end } = readSessionTail(file, grew ? had.end : 0);
  // The session's start and folder come with its first lines: a read that found none yet
  // (a file still empty) leaves them to the next one.
  const meta = grew && had.startTime ? null : getSessionMeta(entries);
  const startTime = meta ? (entries.length ? meta.startTime : '') : had!.startTime;
  const name = meta ? projectName(entries.length ? meta.cwd : '', ref.project) : had!.name;
  const docIds = addEntries(idx, entries, { ...ref, startTime, name });
  idx.files.set(file, {
    end,
    mtimeMs: st.mtimeMs,
    startTime,
    name,
    docIds: grew ? [...had.docIds, ...docIds] : docIds,
  });
}

/** Brings the index up to date with the session files, one step per session. */
function* refreshSessionIndex(idx: SessionIndex) {
  const now = Date.now();
  const seen = new Set<string>();
  for (const proj of getProjectDirs()) {
    for (const sess of getSessionFiles(proj.path)) {
      seen.add(sess.file);
      try {
        refreshSession(idx, sess.file, { project: proj.name, sessionId: sess.id }, now);
      } catch {
        // unreadable now: its documents go, and it is read again next time
        dropFile(idx, sess.file);
      }
      yield;
    }
  }
  for (const file of [...idx.files.keys()]) if (!seen.has(file)) dropFile(idx, file);
  idx.checkedAt = now;
}

/** One refresh at a time per index: a search that comes during one waits for it. */
const refreshing = new Map<SessionIndex, Promise<void>>();

/**
 * The index, brought up to date in slices: a session store of gigabytes is read without holding
 * the process, so the REST holder keeps answering.
 */
async function getOrBuildIndex(): Promise<{ index: BM25Index; docMap: Map<string, DocRef> }> {
  sessionIndex ??= {
    index: new BM25Index(),
    docMap: new Map(),
    files: new Map(),
    checkedAt: 0,
    nextId: 0,
  };
  const index = sessionIndex;
  let running = refreshing.get(index);
  if (!running && Date.now() - index.checkedAt >= RECHECK_MS) {
    running = runSliced(refreshSessionIndex(index)).finally(() => refreshing.delete(index));
    refreshing.set(index, running);
  }
  if (running) await running;
  return index;
}

/** Builds the index every search of all sessions uses, as the REST holder starts. */
export async function warmSessionIndex(): Promise<void> {
  await getOrBuildIndex();
}

async function rankedSearch(
  query: string,
  projects: Array<{ name: string; path: string }>,
  role: string,
  maxResults: number,
): Promise<SearchResult[]> {
  const { index, docMap } = await getOrBuildIndex();
  const inProjects = new Set(projects.map((p) => p.name));
  const hits = index.search(query).flatMap(({ id, score }) => {
    const doc = docMap.get(id);
    if (!doc || !inProjects.has(doc.project)) return [];
    if (role !== 'all' && doc.role !== role) return [];
    const ts = doc.timestamp ?? doc.sessionDate;
    const decay = recencyDecay(ts);
    return [{ doc, ts, score, decay, adjusted: score * decay }];
  });
  hits.sort((a, b) => b.adjusted - a.adjusted);
  // The excerpts of the hits answered alone: a common word matches thousands of messages.
  return hits.slice(0, maxResults).map(({ doc, ts, score, decay, adjusted }) => ({
    source: 'session' as const,
    id: doc.sessionId,
    project: doc.project,
    name: doc.name,
    role: doc.role,
    timestamp: ts,
    excerpt: buildExcerpt(doc.content, query),
    score: adjusted,
    metadata: {
      sessionDate: doc.sessionDate,
      relevanceScore: score,
      recencyMultiplier: Math.round(decay * 100) / 100,
    },
  }));
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
            name: projectName(meta.cwd, proj.name),
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
