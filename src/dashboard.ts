// =============================================================================
// agent-knowledge dashboard
//
// HTTP + WebSocket plumbing is delegated to agent-common (createRouter, json,
// serveStatic, setupWebSocket). Only the knowledge-specific routes, the
// per-endpoint heavy rate limiter, and the state snapshot live here.
// =============================================================================

import http from 'http';
import fs from 'fs';
import path from 'path';
import {
  createRouter,
  json,
  readBody,
  serveStatic,
  setupWebSocket,
  type RouteHandler,
} from 'agent-common';

// ── Inline rate limiter ──────────────────────────────────────────────────────
// agent-common no longer ships createRateLimiter; reproduce the minimal token
// bucket we depend on locally. Keyed by remote IP, with named windows.

interface RateWindow {
  max: number;
  windowMs: number;
}

interface RateLimiterOptions {
  windows: Record<string, RateWindow>;
}

interface RateCheckResult {
  allowed: boolean;
  limit: number;
  resetAt: number;
}

interface BucketEntry {
  count: number;
  resetAt: number;
}

function createRateLimiter(opts: RateLimiterOptions) {
  const buckets = new Map<string, BucketEntry>();
  return {
    check(req: http.IncomingMessage, windowName = 'default'): RateCheckResult {
      const win = opts.windows[windowName] ?? opts.windows.default;
      if (!win) return { allowed: true, limit: Infinity, resetAt: Date.now() };
      const ip =
        (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
        req.socket.remoteAddress ||
        'unknown';
      const key = `${windowName}:${ip}`;
      const now = Date.now();
      let entry = buckets.get(key);
      if (!entry || entry.resetAt <= now) {
        entry = { count: 0, resetAt: now + win.windowMs };
        buckets.set(key, entry);
      }
      entry.count += 1;
      return {
        allowed: entry.count <= win.max,
        limit: win.max,
        resetAt: entry.resetAt,
      };
    },
  };
}
import { listEntries, readEntry, writeEntry } from './knowledge/store.js';
import { searchKnowledge, invalidateKnowledgeIndexCache } from './knowledge/search.js';
import { getEntryScoring, decayFactor, maturityMultiplier } from './knowledge/scoring.js';
import { getKnowledgeGraph } from './knowledge/graph.js';
import { consolidate } from './knowledge/consolidate.js';
import { reflect } from './knowledge/reflect.js';
import {
  godNodes,
  bridges,
  gaps,
  generateBrief,
  invalidateBriefCache,
} from './knowledge/analyze.js';
import { gitPull, gitPush } from './knowledge/git.js';
import { indexKnowledgeEntry } from './sessions/indexer.js';
import { checkDuplicates } from './knowledge/consolidate.js';
import {
  getProjectDirs,
  getSessionFiles,
  parseSessionFile,
  extractMessages,
  getSessionMeta,
} from './sessions/parser.js';
import { searchSessions } from './sessions/search.js';
import { listSessions, getSessionSummary } from './sessions/summary.js';
import { scopedSearch, type SearchScope } from './sessions/scopes.js';
import { VectorStore } from './vectorstore/index.js';
import { getConfig } from './types.js';
import { getVersion } from './version.js';

const VERSION = getVersion();
const DEFAULT_PORT = 3423;

// ── Per-endpoint rate limiter ────────────────────────────────────────────────
// Default bucket for all /api/ requests, plus a stricter "heavy" bucket for
// embedding-backed endpoints. Both buckets share one rateLimiter instance
// from agent-common.

const rateLimiter = createRateLimiter({
  windows: {
    default: { max: 100, windowMs: 60_000 },
    heavy: { max: 20, windowMs: 60_000 },
  },
});

const HEAVY_ENDPOINTS = new Set([
  '/api/knowledge/search',
  '/api/knowledge/consolidate',
  '/api/knowledge/reflect',
  '/api/knowledge/god-nodes',
  '/api/knowledge/bridges',
  '/api/knowledge/gaps',
  '/api/knowledge/brief',
  '/api/sessions/search',
  '/api/sessions/recall',
]);

function rateLimit(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): boolean {
  if (!pathname.startsWith('/api/')) return false;
  const general = rateLimiter.check(req);
  if (!general.allowed) {
    res.writeHead(429, {
      'Content-Type': 'application/json',
      'Retry-After': String(Math.ceil((general.resetAt - Date.now()) / 1000)),
      'X-RateLimit-Limit': String(general.limit),
      'X-RateLimit-Remaining': '0',
    });
    res.end(JSON.stringify({ error: 'Too many requests' }));
    return true;
  }
  if (HEAVY_ENDPOINTS.has(pathname)) {
    const heavy = rateLimiter.check(req, 'heavy');
    if (!heavy.allowed) {
      res.writeHead(429, {
        'Content-Type': 'application/json',
        'Retry-After': String(Math.ceil((heavy.resetAt - Date.now()) / 1000)),
        'X-RateLimit-Limit': String(heavy.limit),
        'X-RateLimit-Remaining': '0',
      });
      res.end(JSON.stringify({ error: 'Too many requests (rate limit for search/analyze)' }));
      return true;
    }
  }
  return false;
}

// ── UI dir resolution ────────────────────────────────────────────────────────

function resolveUiDir(): string {
  const moduleUrl = new URL(import.meta.url);
  let moduleDir =
    process.platform === 'win32'
      ? moduleUrl.pathname.replace(/^\/([a-zA-Z]:)/, '$1')
      : moduleUrl.pathname;
  moduleDir = path.dirname(moduleDir);
  const srcUi = path.resolve(moduleDir, 'ui');
  if (fs.existsSync(srcUi)) return srcUi;
  const distUi = path.resolve(moduleDir, '..', 'dist', 'ui');
  if (fs.existsSync(distUi)) return distUi;
  return srcUi;
}

// ── State snapshot (cached, used by WS) ──────────────────────────────────────

interface Snapshot {
  knowledge: ReturnType<typeof listEntries>;
  sessionCount: number;
  vectorCount: number;
  builtAt: number;
}

let snapshotCache: Snapshot | null = null;
const SNAPSHOT_TTL = 30_000;

function buildSnapshot(): Snapshot {
  const now = Date.now();
  if (snapshotCache && now - snapshotCache.builtAt < SNAPSHOT_TTL) return snapshotCache;

  const config = getConfig();
  let knowledge: ReturnType<typeof listEntries> = [];
  let sessionCount = 0;
  let vectorCount = snapshotCache?.vectorCount ?? 0;

  try {
    knowledge = listEntries(config.memoryDir);
    for (const proj of getProjectDirs()) sessionCount += getSessionFiles(proj.path).length;
    if (!snapshotCache) {
      try {
        vectorCount = new VectorStore().stats().totalEntries;
      } catch (err) {
        console.error('[knowledge] vector stats:', err instanceof Error ? err.message : err);
      }
    }
  } catch (err) {
    console.error('[knowledge] snapshot:', err instanceof Error ? err.message : err);
  }

  snapshotCache = { knowledge, sessionCount, vectorCount, builtAt: now };
  return snapshotCache;
}

function fullState(): Record<string, unknown> {
  const s = buildSnapshot();
  // Enrich with live scoring so the WS-delivered state carries the same
  // last_accessed / maturity / access_count shape the REST route returns.
  // Enrichment lives here (not buildSnapshot) because scoring changes on every
  // read while the entry list itself only changes on file mutation.
  let knowledge: unknown = s.knowledge;
  try {
    const scoring = getEntryScoring();
    const scores = scoring.getScores(s.knowledge.map((e) => e.path));
    knowledge = s.knowledge.map((e) => {
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
  } catch (err) {
    console.error('[knowledge] ws enrichment:', err instanceof Error ? err.message : err);
  }
  return {
    knowledge,
    stats: {
      knowledge_entries: s.knowledge.length,
      session_count: s.sessionCount,
      vector_count: s.vectorCount,
      uptime: process.uptime(),
      version: VERSION,
    },
  };
}

// ── Routes ───────────────────────────────────────────────────────────────────

function urlOf(req: http.IncomingMessage): URL {
  return new URL(req.url ?? '/', `http://${req.headers.host || 'localhost'}`);
}

const healthRoute: RouteHandler = (_req, res) => {
  const config = getConfig();
  const entries = listEntries(config.memoryDir);
  json(res, {
    status: 'ok',
    version: VERSION,
    uptime: process.uptime(),
    knowledge_entries: entries.length,
  });
};

const indexStatusRoute: RouteHandler = (_req, res) => {
  try {
    json(res, new VectorStore().stats());
  } catch (err) {
    console.error('[knowledge] index-status:', err instanceof Error ? err.message : err);
    json(res, {
      totalEntries: 0,
      knowledgeEntries: 0,
      sessionEntries: 0,
      uniqueSessions: 0,
      dbSizeMB: 0,
      provider: null,
      dimensions: 0,
    });
  }
};

const knowledgeSearchRoute: RouteHandler = (req, res) => {
  const memoryDir = getConfig().memoryDir;
  const url = urlOf(req);
  const q = url.searchParams.get('q') || '';
  const category = url.searchParams.get('category') || undefined;
  const maxResults = url.searchParams.get('max_results');
  const results = searchKnowledge(memoryDir, q, {
    category,
    maxResults: maxResults ? parseInt(maxResults, 10) : undefined,
  });
  try {
    const scoring = getEntryScoring();
    const scores = scoring.getScores(results.map((r) => r.entry.path));
    const enriched = results.map((r) => {
      const score = scores.get(r.entry.path);
      return {
        ...r,
        maturity: score?.maturity ?? 'candidate',
        access_count: score?.access_count ?? 0,
        decay_factor: score?.last_accessed ? decayFactor(score.last_accessed) : 1,
        maturity_multiplier: maturityMultiplier(score?.maturity ?? 'candidate'),
      };
    });
    json(res, enriched);
  } catch (err) {
    console.error('[knowledge] search enrichment:', err instanceof Error ? err.message : err);
    json(res, results);
  }
};

const consolidateRoute: RouteHandler = (req, res) => {
  const url = urlOf(req);
  const category = url.searchParams.get('category') || undefined;
  const thresholdParam = url.searchParams.get('threshold');
  const threshold = thresholdParam ? parseFloat(thresholdParam) : 0.5;
  json(res, consolidate(getConfig().memoryDir, category, threshold));
};

const reflectRoute: RouteHandler = (req, res) => {
  const url = urlOf(req);
  const category = url.searchParams.get('category') || undefined;
  const maxParam = url.searchParams.get('max_entries');
  const maxEntries = maxParam ? parseInt(maxParam, 10) : 20;
  json(res, reflect(getConfig().memoryDir, category, maxEntries));
};

const godNodesRoute: RouteHandler = (req, res) => {
  const url = urlOf(req);
  const topNParam = url.searchParams.get('top_n');
  const topN = topNParam ? parseInt(topNParam, 10) : 10;
  json(res, godNodes(getConfig().memoryDir, topN));
};

const bridgesRoute: RouteHandler = (req, res) => {
  const url = urlOf(req);
  const topNParam = url.searchParams.get('top_n');
  const topN = topNParam ? parseInt(topNParam, 10) : 5;
  json(res, bridges(getConfig().memoryDir, topN));
};

const gapsRoute: RouteHandler = (req, res) => {
  const url = urlOf(req);
  const maxParam = url.searchParams.get('max_entries');
  const maxEntries = maxParam ? parseInt(maxParam, 10) : 30;
  json(res, gaps(getConfig().memoryDir, maxEntries));
};

const briefRoute: RouteHandler = (_req, res) => {
  json(res, generateBrief(getConfig().memoryDir));
};

const graphDataRoute: RouteHandler = (_req, res) => {
  try {
    const entries = listEntries(getConfig().memoryDir);
    const allEdges = getKnowledgeGraph().links();
    const scoring = getEntryScoring();
    const scores = scoring.getScores(entries.map((e) => e.path));

    const categoryColors: Record<string, string> = {
      projects: '#5d8da8',
      decisions: '#c2885c',
      notes: '#7a9a6d',
      workflows: '#9b7db8',
      people: '#b85c5c',
    };

    const nodes = entries.map((e) => {
      const cat = e.path.split('/')[0] || 'notes';
      const score = scores.get(e.path);
      const degree = allEdges.filter((ed) => ed.source === e.path || ed.target === e.path).length;
      return {
        id: e.path,
        label: (e.title || e.path.split('/').pop()?.replace('.md', '') || e.path).slice(0, 40),
        title: `${e.path}\nCategory: ${cat}\nEdges: ${degree}\nMaturity: ${score?.maturity ?? 'candidate'}`,
        group: cat,
        color: categoryColors[cat] || '#888',
        size: Math.max(4, Math.min(16, 4 + degree * 2)),
        maturity: score?.maturity ?? 'candidate',
      };
    });

    const edges = allEdges.map((e) => ({
      from: e.source,
      to: e.target,
      title: `${e.rel_type.replace(/_/g, ' ')} (strength: ${e.strength ?? 0.5})`,
      rel_type: e.rel_type,
      strength: e.strength ?? 0.5,
      origin: e.origin ?? 'manual',
    }));

    json(res, { nodes, edges });
  } catch (err) {
    console.error('[knowledge] graph-data:', err instanceof Error ? err.message : err);
    json(res, { nodes: [], edges: [] });
  }
};

const knowledgeListRoute: RouteHandler = (req, res) => {
  const url = urlOf(req);
  const category = url.searchParams.get('category') || undefined;
  const tag = url.searchParams.get('tag') || undefined;
  const entries = listEntries(getConfig().memoryDir, category, tag);
  try {
    const scoring = getEntryScoring();
    const scores = scoring.getScores(entries.map((e) => e.path));
    const enriched = entries.map((e) => {
      const score = scores.get(e.path);
      return {
        // `...e` carries through `evergreen` and `author` from the store
        // when they are present in frontmatter; both are optional.
        ...e,
        evergreen: e.evergreen === true,
        author: e.author ?? null,
        maturity: score?.maturity ?? 'candidate',
        access_count: score?.access_count ?? 0,
        last_accessed: score?.last_accessed ?? null,
      };
    });
    json(res, enriched);
  } catch (err) {
    console.error('[knowledge] entries enrichment:', err instanceof Error ? err.message : err);
    json(res, entries);
  }
};

const knowledgeLinksRoute: RouteHandler = (_req, res, params) => {
  try {
    json(res, getKnowledgeGraph().links(params.entryPath));
  } catch (err) {
    console.error('[knowledge] links:', err instanceof Error ? err.message : err);
    json(res, []);
  }
};

const knowledgeEntryRoute: RouteHandler = (_req, res, params) => {
  const entryPath = params.entryPath;
  const entry = readEntry(getConfig().memoryDir, entryPath);
  try {
    const score = getEntryScoring().getScore(entryPath);
    json(res, {
      ...entry,
      maturity: score?.maturity ?? 'candidate',
      access_count: score?.access_count ?? 0,
      last_accessed: score?.last_accessed ?? null,
      decay_factor: score?.last_accessed ? decayFactor(score.last_accessed) : 1,
      maturity_multiplier: maturityMultiplier(score?.maturity ?? 'candidate'),
    });
  } catch (err) {
    console.error('[knowledge] entry enrichment:', err instanceof Error ? err.message : err);
    json(res, entry);
  }
};

const sessionsSearchRoute: RouteHandler = async (req, res) => {
  const url = urlOf(req);
  const q = url.searchParams.get('q') || '';
  const role = (url.searchParams.get('role') || 'all') as 'user' | 'assistant' | 'all';
  const maxResults = url.searchParams.get('max_results');
  const ranked = url.searchParams.get('ranked') !== 'false';
  const project = url.searchParams.get('project') || undefined;
  const semantic = url.searchParams.get('semantic') === 'true';
  json(
    res,
    await searchSessions(q, {
      role,
      maxResults: maxResults ? parseInt(maxResults, 10) : 20,
      ranked,
      semantic,
      project,
    }),
  );
};

const sessionsRecallRoute: RouteHandler = async (req, res) => {
  const url = urlOf(req);
  const scope = (url.searchParams.get('scope') || 'all') as SearchScope;
  const q = url.searchParams.get('q') || '';
  const maxResults = url.searchParams.get('max_results');
  const project = url.searchParams.get('project') || undefined;
  json(
    res,
    await scopedSearch(scope, q, {
      maxResults: maxResults ? parseInt(maxResults, 10) : 20,
      project,
    }),
  );
};

const sessionsListRoute: RouteHandler = (req, res) => {
  const url = urlOf(req);
  const project = url.searchParams.get('project') || undefined;
  const limitParam = url.searchParams.get('limit');
  const offsetParam = url.searchParams.get('offset');
  const limit = limitParam ? Math.min(parseInt(limitParam, 10), 500) : undefined;
  const offset = offsetParam ? parseInt(offsetParam, 10) : 0;
  const all = listSessions(project);
  const total = all.length;
  let sessions = all;
  if (offset > 0) sessions = sessions.slice(offset);
  if (limit !== undefined) sessions = sessions.slice(0, limit);
  if (limitParam !== null || offsetParam !== null) {
    json(res, { sessions, total });
  } else {
    json(res, sessions);
  }
};

const sessionSummaryRoute: RouteHandler = (req, res, params) => {
  const project = urlOf(req).searchParams.get('project') || undefined;
  const summary = getSessionSummary(params.sessionId, project);
  if (!summary) json(res, { error: `Session ${params.sessionId} not found` }, 404);
  else json(res, summary);
};

const sessionDetailRoute: RouteHandler = (req, res, params) => {
  const url = urlOf(req);
  const sessionId = params.sessionId;
  const project = url.searchParams.get('project') || undefined;
  const includeTools = url.searchParams.get('include_tools') === 'true';
  const tailParam = url.searchParams.get('tail');
  const tail = tailParam ? parseInt(tailParam, 10) : undefined;

  const projects = getProjectDirs().filter(
    (p) => !project || p.name.toLowerCase().includes(project.toLowerCase()),
  );
  for (const proj of projects) {
    const sessions = getSessionFiles(proj.path);
    const match = sessions.find((s) => s.id === sessionId);
    if (match) {
      const entries = parseSessionFile(match.file);
      let messages = extractMessages(entries);
      if (!includeTools)
        messages = messages.filter((m) => m.role === 'user' || m.role === 'assistant');
      if (tail && tail > 0) messages = messages.slice(-tail);
      json(res, { meta: getSessionMeta(entries), messages });
      return;
    }
  }
  json(res, { error: `Session ${sessionId} not found` }, 404);
};

// ── Write endpoint ──────────────────────────────────────────────────────────
// POST /api/knowledge — mirrors the MCP knowledge(action=write) pipeline:
// writeEntry → index → auto-link → git push. Used by agent-tasks
// KnowledgeBridge and other services that need HTTP-based writes.

const knowledgeWriteRoute: RouteHandler = async (req, res) => {
  const config = getConfig();
  let body: Record<string, unknown>;
  try {
    body = await readBody(req, 1_048_576);
  } catch (e) {
    json(res, { error: e instanceof Error ? e.message : 'Bad request' }, 400);
    return;
  }

  const category = typeof body.category === 'string' ? body.category.trim() : '';
  const filename = typeof body.filename === 'string' ? body.filename.trim() : '';
  const content = typeof body.content === 'string' ? body.content : '';

  if (!category || !filename || !content) {
    json(res, { error: 'Required fields: category, filename, content' }, 422);
    return;
  }

  const CATEGORIES = new Set(['projects', 'people', 'decisions', 'workflows', 'notes']);
  if (!CATEGORIES.has(category)) {
    json(res, { error: `Invalid category. Must be one of: ${[...CATEGORIES].join(', ')}` }, 422);
    return;
  }

  try {
    await gitPull(config.memoryDir);
    const filePath = writeEntry(config.memoryDir, category, filename, content);
    invalidateKnowledgeIndexCache();
    invalidateBriefCache();
    const pushResult = await gitPush(config.memoryDir);

    const autoLinks: Array<{ target: string; similarity: number }> = [];
    try {
      await indexKnowledgeEntry(filePath, content);
      const { getEmbeddingProvider } = await import('./embeddings/index.js');
      const provider = await getEmbeddingProvider();
      if (provider) {
        const queryVector = await provider.embedOne(content.slice(0, 2000));
        const vecStore = new VectorStore();
        const similar = vecStore.searchBySource(queryVector, 'knowledge', 4);
        const graphStore = getKnowledgeGraph();
        for (const hit of similar) {
          if (hit.sourceId === filePath) continue;
          if (hit.score > 0.7) {
            graphStore.link(
              filePath,
              hit.sourceId,
              'related_to',
              hit.score,
              null,
              null,
              'auto-link',
            );
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
  } catch (e) {
    json(res, { error: e instanceof Error ? e.message : 'Write failed' }, 500);
  }
};

// ── Server bootstrap ─────────────────────────────────────────────────────────

export function startDashboard(port?: number): Promise<http.Server> {
  const listenPort = port ?? DEFAULT_PORT;
  const uiDir = resolveUiDir();

  const router = createRouter({ staticDir: uiDir });
  router.route('GET', '/health', healthRoute);
  router.route('GET', '/api/index-status', indexStatusRoute);
  router.route('GET', '/api/knowledge/search', knowledgeSearchRoute);
  router.route('GET', '/api/knowledge/consolidate', consolidateRoute);
  router.route('GET', '/api/knowledge/reflect', reflectRoute);
  router.route('GET', '/api/knowledge/god-nodes', godNodesRoute);
  router.route('GET', '/api/knowledge/bridges', bridgesRoute);
  router.route('GET', '/api/knowledge/gaps', gapsRoute);
  router.route('GET', '/api/knowledge/brief', briefRoute);
  router.route('GET', '/api/knowledge/graph-data', graphDataRoute);
  router.route('GET', '/api/knowledge', knowledgeListRoute);
  router.route('GET', '/api/knowledge/:entryPath/links', knowledgeLinksRoute);
  router.route('GET', '/api/knowledge/:entryPath', knowledgeEntryRoute);
  router.route('GET', '/api/sessions/search', sessionsSearchRoute);
  router.route('GET', '/api/sessions/recall', sessionsRecallRoute);
  router.route('GET', '/api/sessions', sessionsListRoute);
  router.route('GET', '/api/sessions/:sessionId/summary', sessionSummaryRoute);
  router.route('GET', '/api/sessions/:sessionId', sessionDetailRoute);
  router.route('POST', '/api/knowledge', knowledgeWriteRoute);

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const isPost = req.method === 'POST';
      if (req.method !== 'GET' && !isPost && req.method !== 'OPTIONS') {
        json(res, { error: 'Method not allowed' }, 405);
        return;
      }
      if (isPost && !req.url?.startsWith('/api/')) {
        json(res, { error: 'Method not allowed' }, 405);
        return;
      }

      let pathname: string;
      try {
        pathname = new URL(req.url ?? '/', `http://${req.headers.host || 'localhost'}`).pathname;
      } catch {
        json(res, { error: 'Bad request' }, 400);
        return;
      }

      if (rateLimit(req, res, pathname)) return;

      await router.handle(req, res);
    });

    setupWebSocket({
      httpServer: server,
      getFingerprints: () => {
        const s = buildSnapshot();
        return { v: `${s.builtAt}:${s.knowledge.length}:${s.sessionCount}` };
      },
      getCategoryData: () => fullState(),
      getFullState: () => fullState(),
      pollIntervalMs: 5_000,
    });

    // ── File watcher (UI live reload via fs.watch) ─────────────────────────
    let fileWatcher: fs.FSWatcher | null = null;
    try {
      if (fs.existsSync(uiDir)) {
        fileWatcher = fs.watch(uiDir, { recursive: true }, () => {
          // Best-effort: clients pick up changes on the next WS poll cycle.
        });
      }
    } catch (err) {
      console.error('[knowledge] file watcher:', err instanceof Error ? err.message : err);
    }

    server.on('close', () => {
      if (fileWatcher) fileWatcher.close();
    });

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') reject(new Error(`Port ${listenPort} already in use`));
      else reject(err);
    });

    server.listen(listenPort, () => resolve(server));
  });
}

export { serveStatic };
