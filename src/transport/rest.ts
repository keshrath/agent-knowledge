// =============================================================================
// agent-knowledge — REST routes
//
// What the /knowledge pane, the hook scripts, the opencode plugin and
// agent-tasks' KnowledgeBridge call. JSON only; the request guard in
// rest-server.ts runs before every route.
// =============================================================================

import { existsSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';
import {
  deleteEntry,
  getAllFiles,
  listEntries,
  readEntry,
  writeEntry,
} from '../knowledge/store.js';
import { searchKnowledge, invalidateKnowledgeIndexCache } from '../knowledge/search.js';
import { getEntryScoring, decayFactor, maturityMultiplier } from '../knowledge/scoring.js';
import { getKnowledgeGraph } from '../knowledge/graph.js';
import { gaps, godNodes, invalidateBriefCache } from '../knowledge/analyze.js';
import { checkDuplicates } from '../knowledge/consolidate.js';
import { gitPull, gitPush, gitSync } from '../knowledge/git.js';
import { getVectorStore, indexKnowledgeEntry } from '../sessions/indexer.js';
import { searchSessions } from '../sessions/search.js';
import { listSessions, getSessionSummary } from '../sessions/summary.js';
import { getProjectDirs, getSessionFiles } from '../sessions/parser.js';
import { recentEvents, recordEvent } from '../events.js';
import { getConfig } from '../types.js';
import { getVersion } from '../version.js';
import { HttpError, json, readBody, Router, type RouteHandler } from './http.js';

const CATEGORIES = new Set(['projects', 'people', 'decisions', 'workflows', 'notes']);

function urlOf(req: IncomingMessage): URL {
  return new URL(req.url ?? '/', 'http://localhost');
}

function intParam(url: URL, name: string, fallback: number): number {
  const n = parseInt(url.searchParams.get(name) ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

/** An entry's live scoring next to its stored fields. */
function withScores<T extends { path: string; evergreen?: boolean; author?: string | null }>(
  entries: T[],
) {
  const scores = getEntryScoring().getScores(entries.map((e) => e.path));
  return entries.map((e) => {
    const score = scores.get(e.path);
    return {
      ...e,
      evergreen: e.evergreen === true,
      author: e.author ?? null,
      maturity: score?.maturity ?? 'candidate',
      access_count: score?.access_count ?? 0,
      last_accessed: score?.last_accessed ?? null,
    };
  });
}

/** readEntry's errors as the status they mean. */
function readOr404(entryPath: string) {
  try {
    return readEntry(getConfig().memoryDir, entryPath);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new HttpError(message.startsWith('File not found') ? 404 : 400, message);
  }
}

const healthRoute: RouteHandler = (_req, res) => {
  json(res, {
    status: 'ok',
    version: getVersion(),
    uptime: process.uptime(),
    knowledge_entries: listEntries(getConfig().memoryDir).length,
  });
};

const knowledgeListRoute: RouteHandler = (req, res) => {
  const url = urlOf(req);
  const entries = listEntries(
    getConfig().memoryDir,
    url.searchParams.get('category') || undefined,
    url.searchParams.get('tag') || undefined,
  );
  json(res, withScores(entries));
};

const knowledgeSearchRoute: RouteHandler = (req, res) => {
  const url = urlOf(req);
  const results = searchKnowledge(getConfig().memoryDir, url.searchParams.get('q') || '', {
    category: url.searchParams.get('category') || undefined,
    maxResults: url.searchParams.has('max_results') ? intParam(url, 'max_results', 20) : undefined,
  });
  const scores = getEntryScoring().getScores(results.map((r) => r.entry.path));
  json(
    res,
    results.map((r) => {
      const score = scores.get(r.entry.path);
      return {
        ...r,
        maturity: score?.maturity ?? 'candidate',
        access_count: score?.access_count ?? 0,
        decay_factor: score?.last_accessed ? decayFactor(score.last_accessed) : 1,
        maturity_multiplier: maturityMultiplier(score?.maturity ?? 'candidate'),
      };
    }),
  );
};

const knowledgeEntryRoute: RouteHandler = (_req, res, params) => {
  const entry = readOr404(params.entryPath!);
  const score = getEntryScoring().getScore(params.entryPath!);
  json(res, {
    ...entry,
    maturity: score?.maturity ?? 'candidate',
    access_count: score?.access_count ?? 0,
    last_accessed: score?.last_accessed ?? null,
    decay_factor: score?.last_accessed ? decayFactor(score.last_accessed) : 1,
    maturity_multiplier: maturityMultiplier(score?.maturity ?? 'candidate'),
  });
};

/** An entry's title, or null when the file is gone (an edge can outlive its entry). */
function titleOf(dir: string, entryPath: string): string | null {
  try {
    return readEntry(dir, entryPath).entry.title || null;
  } catch {
    return null;
  }
}

/** GET /api/knowledge/:path/links: its edges, each with the title of the entry at the other end. */
const knowledgeLinksRoute: RouteHandler = (_req, res, params) => {
  const dir = getConfig().memoryDir;
  const self = params.entryPath!;
  json(
    res,
    getKnowledgeGraph()
      .links(self)
      .map((e) => ({ ...e, title: titleOf(dir, e.source === self ? e.target : e.source) })),
  );
};

const sessionsListRoute: RouteHandler = (req, res) => {
  const url = urlOf(req);
  const all = listSessions(url.searchParams.get('project') || undefined);
  const offset = Math.max(0, intParam(url, 'offset', 0));
  const limit = Math.min(Math.max(0, intParam(url, 'limit', 50)), 500);
  json(res, { sessions: all.slice(offset, offset + limit), total: all.length });
};

const sessionsSearchRoute: RouteHandler = async (req, res) => {
  const url = urlOf(req);
  const role = url.searchParams.get('role');
  json(
    res,
    await searchSessions(url.searchParams.get('q') || '', {
      role: role === 'user' || role === 'assistant' ? role : 'all',
      maxResults: intParam(url, 'max_results', 20),
      ranked: url.searchParams.get('ranked') !== 'false',
      semantic: url.searchParams.get('semantic') === 'true',
      project: url.searchParams.get('project') || undefined,
    }),
  );
};

const sessionSummaryRoute: RouteHandler = (req, res, params) => {
  const summary = getSessionSummary(
    params.sessionId!,
    urlOf(req).searchParams.get('project') || undefined,
  );
  if (!summary) throw new HttpError(404, `Session ${params.sessionId} not found`);
  json(res, summary);
};

/** POST /api/events { kind, message }: a hook's receipt for the pane to show. */
const eventsRoute: RouteHandler = async (req, res) => {
  const body = await readBody(req, 4_096);
  const kind = typeof body.kind === 'string' ? body.kind.trim() : '';
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!kind || !message) throw new HttpError(422, 'Required fields: kind, message');
  if (kind.length > 64 || message.length > 512) {
    throw new HttpError(422, 'kind <= 64 chars, message <= 512 chars');
  }
  const evt = recordEvent(kind, message);
  json(res, { id: evt.id, ts: evt.ts }, 201);
};

/**
 * POST /api/knowledge { category, filename, content }: the MCP knowledge(action=write)
 * pipeline (write, index, auto-link, git push) for HTTP callers such as agent-tasks.
 */
const knowledgeWriteRoute: RouteHandler = async (req, res) => {
  const config = getConfig();
  const body = await readBody(req, 1_048_576);
  const category = typeof body.category === 'string' ? body.category.trim() : '';
  const filename = typeof body.filename === 'string' ? body.filename.trim() : '';
  const content = typeof body.content === 'string' ? body.content : '';
  if (!category || !filename || !content) {
    throw new HttpError(422, 'Required fields: category, filename, content');
  }
  if (!CATEGORIES.has(category)) {
    throw new HttpError(422, `Invalid category. Must be one of: ${[...CATEGORIES].join(', ')}`);
  }

  await gitPull(config.memoryDir);
  const filePath = writeEntry(config.memoryDir, category, filename, content);
  invalidateKnowledgeIndexCache();
  invalidateBriefCache();
  invalidateOverview();
  const pushResult = await gitPush(config.memoryDir);

  const autoLinks: Array<{ target: string; similarity: number }> = [];
  try {
    await indexKnowledgeEntry(filePath, content);
    const { getEmbeddingProvider } = await import('../embeddings/index.js');
    const provider = await getEmbeddingProvider();
    if (provider) {
      const queryVector = await provider.embedOne(content.slice(0, 2000));
      const similar = getVectorStore().searchBySource(queryVector, 'knowledge', 4);
      const graph = getKnowledgeGraph();
      for (const hit of similar) {
        if (hit.sourceId === filePath) continue;
        if (hit.score > 0.7) {
          graph.link(filePath, hit.sourceId, 'related_to', hit.score, null, null, 'auto-link');
          autoLinks.push({ target: hit.sourceId, similarity: Math.round(hit.score * 100) / 100 });
        }
        if (autoLinks.length >= 3) break;
      }
    }
  } catch (linkErr) {
    console.error('[knowledge] Auto-link failed:', linkErr);
  }

  let duplicateWarnings: Array<{ path: string; title: string; similarity: number }> = [];
  try {
    duplicateWarnings = checkDuplicates(config.memoryDir, filePath, content);
  } catch (dupErr) {
    console.error('[knowledge] Duplicate check failed:', dupErr);
  }

  const response: Record<string, unknown> = { path: filePath, git: pushResult };
  if (autoLinks.length > 0) response.autoLinks = autoLinks;
  if (duplicateWarnings.length > 0) response.duplicateWarnings = duplicateWarnings;
  json(res, response, 201);
};

// ── The /knowledge pane ──────────────────────────────────────────────────────

/**
 * The counts the pane polls every few seconds, from file names alone (parsing every entry
 * takes a second on a large base); kept for OVERVIEW_TTL, and a write through this server
 * drops them at once.
 */
const OVERVIEW_TTL = 10_000;
let counted: { at: number; data: Record<string, unknown> } | null = null;

export function invalidateOverview(): void {
  counted = null;
}

function countAll(): Record<string, unknown> {
  if (counted && Date.now() - counted.at < OVERVIEW_TTL) return counted.data;
  const config = getConfig();
  const categories: Record<string, number> = {};
  const paths = getAllFiles(config.memoryDir);
  for (const p of paths) {
    const c = p.includes('/') ? p.split('/')[0]! : 'other';
    categories[c] = (categories[c] ?? 0) + 1;
  }
  let sessions = 0;
  for (const p of getProjectDirs()) sessions += getSessionFiles(p.path).length;
  const vectors = getVectorStore().stats();
  const data = {
    version: getVersion(),
    entries: paths.length,
    categories,
    sessions,
    vectors: vectors.totalEntries,
    provider: vectors.provider,
    memory_dir: config.memoryDir,
    has_git: existsSync(join(config.memoryDir, '.git')),
  };
  counted = { at: Date.now(), data };
  return data;
}

/** GET /api/overview: the counts and the live events, in one cheap call. */
const overviewRoute: RouteHandler = (_req, res) => {
  json(res, { ...countAll(), events: recentEvents() });
};

/** DELETE /api/knowledge/:entryPath: the MCP knowledge(action=delete) pipeline. */
const knowledgeDeleteRoute: RouteHandler = async (_req, res, params) => {
  const dir = getConfig().memoryDir;
  await gitPull(dir);
  let deleted: boolean;
  try {
    deleted = deleteEntry(dir, params.entryPath!);
  } catch (e) {
    throw new HttpError(400, e instanceof Error ? e.message : String(e));
  }
  if (!deleted) throw new HttpError(404, `File not found: ${params.entryPath}`);
  invalidateKnowledgeIndexCache();
  invalidateBriefCache();
  invalidateOverview();
  json(res, { deleted, git: await gitPush(dir) });
};

/** POST /api/knowledge/sync: git pull then push, as knowledge(action=sync). */
const syncRoute: RouteHandler = async (_req, res) => {
  const result = await gitSync(getConfig().memoryDir);
  invalidateKnowledgeIndexCache();
  invalidateOverview();
  json(res, result);
};

/**
 * GET /api/analysis: the most linked entries (two links or more) and the ones with one link
 * or none, so no entry is in both.
 */
const analysisRoute: RouteHandler = (_req, res) => {
  const dir = getConfig().memoryDir;
  json(res, { hubs: godNodes(dir, 5).filter((n) => n.degree >= 2), sparse: gaps(dir, 30) });
};

export function createRouter(): Router {
  return new Router()
    .route('GET', '/health', healthRoute)
    .route('GET', '/api/knowledge', knowledgeListRoute)
    .route('GET', '/api/knowledge/search', knowledgeSearchRoute)
    .route('GET', '/api/knowledge/:entryPath/links', knowledgeLinksRoute)
    .route('GET', '/api/knowledge/:entryPath', knowledgeEntryRoute)
    .route('DELETE', '/api/knowledge/:entryPath', knowledgeDeleteRoute)
    .route('POST', '/api/knowledge/sync', syncRoute)
    .route('POST', '/api/knowledge', knowledgeWriteRoute)
    .route('GET', '/api/overview', overviewRoute)
    .route('GET', '/api/analysis', analysisRoute)
    .route('GET', '/api/sessions', sessionsListRoute)
    .route('GET', '/api/sessions/search', sessionsSearchRoute)
    .route('GET', '/api/sessions/:sessionId/summary', sessionSummaryRoute)
    .route('POST', '/api/events', eventsRoute);
}
