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
import { createRouter, json, serveStatic, setupWebSocket, type RouteHandler } from 'agent-common';
import { listEntries, readEntry } from './knowledge/store.js';
import { searchKnowledge } from './knowledge/search.js';
import { getEntryScoring, decayFactor, maturityMultiplier } from './knowledge/scoring.js';
import { getKnowledgeGraph } from './knowledge/graph.js';
import { consolidate } from './knowledge/consolidate.js';
import { reflect } from './knowledge/reflect.js';
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

// ── Per-endpoint rate limiter (knowledge-specific: heavy bucket for embeddings) ─
// Kept local rather than generalized into agent-common because the
// "heavy endpoints" concept is unique to this server's embedding workload.

const RATE_LIMIT_WINDOW = 60_000;
const RATE_LIMIT_MAX = 100;
const RATE_LIMIT_MAX_HEAVY = 20;

interface RateBucket {
  count: number;
  resetAt: number;
}

const rateBuckets = new Map<string, RateBucket>();
const rateBucketsHeavy = new Map<string, RateBucket>();

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, b] of rateBuckets) if (b.resetAt <= now) rateBuckets.delete(key);
  for (const [key, b] of rateBucketsHeavy) if (b.resetAt <= now) rateBucketsHeavy.delete(key);
}, 300_000);
cleanupTimer.unref();

const HEAVY_ENDPOINTS = new Set([
  '/api/knowledge/search',
  '/api/knowledge/consolidate',
  '/api/knowledge/reflect',
  '/api/sessions/search',
  '/api/sessions/recall',
]);

function getClientIp(req: http.IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress ?? 'unknown';
}

function checkBucket(
  bucket: Map<string, RateBucket>,
  ip: string,
  max: number,
): { allowed: boolean; resetAt: number } {
  const now = Date.now();
  let b = bucket.get(ip);
  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + RATE_LIMIT_WINDOW };
    bucket.set(ip, b);
  }
  b.count++;
  return { allowed: b.count <= max, resetAt: b.resetAt };
}

function rateLimit(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): boolean {
  if (!pathname.startsWith('/api/')) return false;
  const ip = getClientIp(req);
  const general = checkBucket(rateBuckets, ip, RATE_LIMIT_MAX);
  if (!general.allowed) {
    res.writeHead(429, {
      'Content-Type': 'application/json',
      'Retry-After': String(Math.ceil((general.resetAt - Date.now()) / 1000)),
      'X-RateLimit-Limit': String(RATE_LIMIT_MAX),
      'X-RateLimit-Remaining': '0',
    });
    res.end(JSON.stringify({ error: 'Too many requests' }));
    return true;
  }
  if (HEAVY_ENDPOINTS.has(pathname)) {
    const heavy = checkBucket(rateBucketsHeavy, ip, RATE_LIMIT_MAX_HEAVY);
    if (!heavy.allowed) {
      res.writeHead(429, {
        'Content-Type': 'application/json',
        'Retry-After': String(Math.ceil((heavy.resetAt - Date.now()) / 1000)),
        'X-RateLimit-Limit': String(RATE_LIMIT_MAX_HEAVY),
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
  return {
    knowledge: s.knowledge,
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
        ...e,
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
  let sessions = listSessions(project);
  if (offset > 0) sessions = sessions.slice(offset);
  if (limit !== undefined) sessions = sessions.slice(0, limit);
  json(res, sessions);
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
  router.route('GET', '/api/knowledge', knowledgeListRoute);
  router.route('GET', '/api/knowledge/:entryPath/links', knowledgeLinksRoute);
  router.route('GET', '/api/knowledge/:entryPath', knowledgeEntryRoute);
  router.route('GET', '/api/sessions/search', sessionsSearchRoute);
  router.route('GET', '/api/sessions/recall', sessionsRecallRoute);
  router.route('GET', '/api/sessions', sessionsListRoute);
  router.route('GET', '/api/sessions/:sessionId/summary', sessionSummaryRoute);
  router.route('GET', '/api/sessions/:sessionId', sessionDetailRoute);

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'OPTIONS') {
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
