import {
  getProjectDirs,
  getSessionFiles,
  parseSessionFile,
  extractMessages,
  getSessionMeta,
  type SessionMessage,
} from './parser.js';
import { recencyDecay } from '../search/tfidf.js';
import { BM25Index } from '../search/bm25.js';
import { buildExcerpt } from '../search/excerpt.js';
import type { SearchResult } from '../search/types.js';
import { getEmbeddingProvider } from '../embeddings/index.js';
import { VectorStore } from '../vectorstore/index.js';
import { getConfig } from '../types.js';

// ── Types ───────────────────────────────────────────────────────────────────

export type SearchScope = 'errors' | 'plans' | 'configs' | 'tools' | 'files' | 'decisions' | 'all';

export interface ScopedSearchOptions {
  project?: string;
  maxResults?: number;
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

// ── Scope pattern definitions ───────────────────────────────────────────────

const SCOPE_PATTERNS: Record<Exclude<SearchScope, 'all' | 'tools'>, RegExp> = {
  errors:
    /\b(error|exception|failed|failure|crash|stack\s*trace|ENOENT|EACCES|EPERM|ECONNREFUSED|TypeError|ReferenceError|SyntaxError|FATAL|panic|segfault|abort|unhandled|rejected)\b/i,
  plans:
    /\b(plan|step\s+\d|phase|approach|strategy|TODO|FIXME|architecture|roadmap|milestone|objective|next\s+steps|action\s+items)\b/i,
  configs:
    /\b(config|settings|\.env|\.json|\.yaml|\.yml|\.toml|tsconfig|package\.json|webpack|vite|eslint|prettier|docker|compose|nginx)\b/i,
  files:
    /(?:src\/|lib\/|dist\/|\.ts\b|\.js\b|\.py\b|\.rs\b|\.go\b|\.java\b|\.vue\b|\.tsx\b|\.jsx\b|\/[\w.-]+\/|created|modified|deleted|renamed|moved)\b/i,
  decisions:
    /\b(decided|chose|chosen|because|tradeoff|trade-off|instead\s+of|going\s+with|opted\s+for|rationale|reasoning|prefer|alternative|pros\s+and\s+cons|conclusion)\b/i,
};

// ── Scoped search ───────────────────────────────────────────────────────────

/**
 * Perform a search scoped to a specific category of content.
 *
 * Each scope pre-filters messages by role/content patterns, then applies TF-IDF
 * ranking with the user query on the remaining messages. When semantic search
 * is available, blends vector similarity with TF-IDF scores.
 */
export async function scopedSearch(
  scope: SearchScope,
  query: string,
  options: ScopedSearchOptions = {},
): Promise<SearchResult[]> {
  const { project, maxResults = 20, semantic = true } = options;

  const projects = getProjectDirs().filter(
    (p) => !project || p.name.toLowerCase().includes(project.toLowerCase()),
  );

  const index = new BM25Index();
  const docMap = new Map<
    string,
    {
      project: string;
      sessionId: string;
      role: string;
      timestamp: string | null;
      content: string;
      sessionDate: string;
    }
  >();
  let docCounter = 0;

  for (const proj of projects) {
    const sessions = getSessionFiles(proj.path);
    for (const sess of sessions) {
      try {
        const entries = parseSessionFile(sess.file);
        if (entries.length === 0) continue;
        const meta = getSessionMeta(entries);
        const messages = extractMessages(entries);

        const filtered = filterByScope(scope, messages);

        for (const msg of filtered) {
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

  const ranked = index.search(query, maxResults * 2);

  const tfidfResults = ranked
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
          scope,
          sessionDate: doc.sessionDate,
          relevanceScore: score,
          recencyMultiplier: Math.round(decay * 100) / 100,
        },
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  tfidfResults.sort((a, b) => b.score - a.score);
  const trimmedTfidf = tfidfResults.slice(0, maxResults);

  if (!semantic) {
    return trimmedTfidf;
  }

  try {
    const provider = await getEmbeddingProvider();
    if (!provider) return trimmedTfidf;

    const queryVector = await provider.embedOne(query);
    const store = getVectorStore();
    const vectorResults = store.searchBySource(queryVector, 'session', maxResults * 2);

    if (vectorResults.length === 0) return trimmedTfidf;

    const config = getConfig();
    const alpha = config.embeddingAlpha;

    const semanticScores = new Map<string, number>();
    for (const vr of vectorResults) {
      const existing = semanticScores.get(vr.sourceId) ?? 0;
      if (vr.score > existing) {
        semanticScores.set(vr.sourceId, vr.score);
      }
    }

    const maxTfidf = trimmedTfidf.length > 0 ? Math.max(...trimmedTfidf.map((r) => r.score)) : 1;
    const normFactor = maxTfidf > 0 ? maxTfidf : 1;

    const results = trimmedTfidf.map((result) => {
      const normalizedTfidf = result.score / normFactor;
      const semanticScore = semanticScores.get(result.id) ?? 0;
      const blended = alpha * normalizedTfidf + (1 - alpha) * semanticScore;
      const ts = result.timestamp ?? (result.metadata?.sessionDate as string | undefined);
      const decay = ts ? recencyDecay(ts) : 1;
      const finalScore = blended * decay;

      return {
        ...result,
        score: finalScore,
        metadata: {
          ...result.metadata,
          tfidfScore: normalizedTfidf,
          semanticScore,
          blendAlpha: alpha,
        },
      };
    });

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, maxResults);
  } catch {
    return trimmedTfidf;
  }
}

// ── Scope filters ───────────────────────────────────────────────────────────

function filterByScope(scope: SearchScope, messages: SessionMessage[]): SessionMessage[] {
  if (scope === 'all') {
    return messages;
  }

  if (scope === 'tools') {
    return messages.filter((m) => m.role === 'tool_use' || m.role === 'tool_result');
  }

  const pattern = SCOPE_PATTERNS[scope];
  return messages.filter((m) => pattern.test(m.content));
}
