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
import { listEntries, parseFrontmatter, readEntry, writeEntry } from '../knowledge/store.js';
import {
  searchKnowledge,
  indexedEntries,
  invalidateKnowledgeIndexCache,
  warmKnowledgeIndex,
} from '../knowledge/search.js';
import { getEntryScoring, decayFactor, maturityMultiplier } from '../knowledge/scoring.js';
import { getKnowledgeGraph } from '../knowledge/graph.js';
import { gaps, godNodes, invalidateBriefCache } from '../knowledge/analyze.js';
import { checkDuplicates } from '../knowledge/consolidate.js';
import { gitPull, gitPush, gitSync } from '../knowledge/git.js';
import { removeKnowledgeEntry } from '../knowledge/remove.js';
import { getVectorStore, indexKnowledgeEntry } from '../sessions/indexer.js';
import { searchSessions } from '../sessions/search.js';
import { findSession, listSessions, loadSessionSummary } from '../sessions/summary.js';
import { getProjectDirs, getSessionFiles } from '../sessions/parser.js';
import { recentEvents, recordEvent } from '../events.js';
import { writeSessionSnapshot } from '../sessions/snapshot.js';
import { ingestFreshness } from '../knowledge/ingest-freshness.js';
import { promptSimilarity } from '../knowledge/similar.js';
import {
  buildContextBundle,
  DEFAULT_SECTIONS,
  identityState,
  type SectionName,
} from '../wakeup.js';
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

/**
 * The knowledge base counted as the index holds it (files re-read only when changed): `entries`
 * are the curated ones, as Browse lists them, `categories` theirs by folder (`other` at the
 * top), `snapshots` the sessions' records (`isSnapshot`: the snapshots, the 2.x dumps).
 */
function countEntries(dir: string) {
  const categories: Record<string, number> = {};
  let snapshots = 0;
  for (const e of indexedEntries(dir)) {
    if (e.snapshot) snapshots++;
    else {
      const c = e.path.includes('/') ? e.category : 'other';
      categories[c] = (categories[c] ?? 0) + 1;
    }
  }
  const entries = Object.values(categories).reduce((a, b) => a + b, 0);
  return { entries, snapshots, categories };
}

const healthRoute: RouteHandler = (_req, res) => {
  const { entries, snapshots } = countEntries(getConfig().memoryDir);
  // The holder's self-check asks this: the counts come from the folder listing alone.
  json(res, { status: 'ok', version: getVersion(), uptime: process.uptime(), entries, snapshots });
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

/**
 * GET /api/knowledge/search?q=…: `prompt=true` says `q` is a person's prompt, searched for what
 * it asks about, a hit holding enough of its content terms (`searchKnowledge` `prompt`).
 */
/** How long a search waits for the index to be read before it says it is warming up. */
const WARM_WAIT_MS = 4_000;

const knowledgeSearchRoute: RouteHandler = async (req, res) => {
  const url = urlOf(req);
  const dir = getConfig().memoryDir;
  const q = url.searchParams.get('q') || '';
  // A server just started on a large knowledge base is still reading it: a search waits for
  // that a bounded while, then says so (503) rather than holding the caller past its timeout.
  const isWarm = await Promise.race([
    warmKnowledgeIndex(dir).then(() => true),
    new Promise<boolean>((r) => setTimeout(() => r(false), WARM_WAIT_MS).unref()),
  ]);
  if (!isWarm) throw new HttpError(503, 'warming up: the search index is still being read');
  const prompt = url.searchParams.get('prompt') === 'true';
  // A prompt is judged by its meaning too, where embeddings are there (`promptSimilarity`).
  const similar = prompt ? await promptSimilarity(q) : null;
  const results = searchKnowledge(dir, q, {
    category: url.searchParams.get('category') || undefined,
    maxResults: url.searchParams.has('max_results') ? intParam(url, 'max_results', 20) : undefined,
    mmr: url.searchParams.get('mmr') === 'true',
    skipCategory: url.searchParams.get('skip') || undefined,
    prompt,
    ...(similar ? { similar } : {}),
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

/**
 * GET /api/knowledge/:path: the entry and its scoring; a session snapshot also says whether its
 * session's transcript is on this machine (`session_on_machine`), so it can be opened.
 */
const knowledgeEntryRoute: RouteHandler = (_req, res, params) => {
  const entry = readOr404(params.entryPath!);
  const score = getEntryScoring().getScore(params.entryPath!);
  const { meta } = parseFrontmatter(entry.content);
  const isSnapshot = meta.type === 'session-snapshot' && typeof meta.session === 'string';
  json(res, {
    ...entry,
    ...(isSnapshot ? { session_on_machine: findSession(meta.session as string) !== null } : {}),
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

/**
 * GET /api/knowledge/:path/links: its edges, each with the title of the entry at the other end,
 * and `missing` when that entry is not there.
 */
const knowledgeLinksRoute: RouteHandler = (_req, res, params) => {
  const dir = getConfig().memoryDir;
  const self = params.entryPath!;
  json(
    res,
    getKnowledgeGraph()
      .links(self)
      .map((e) => {
        const other = e.source === self ? e.target : e.source;
        const title = titleOf(dir, other);
        // An entry no longer there (a code node of an ingest is not an entry, and not missing).
        return { ...e, title, missing: title === null && !other.startsWith('code:') };
      }),
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

const sessionSummaryRoute: RouteHandler = async (req, res, params) => {
  const summary = await loadSessionSummary(
    params.sessionId!,
    urlOf(req).searchParams.get('project') || undefined,
  );
  if (!summary) throw new HttpError(404, `Session ${params.sessionId} not found`);
  json(res, summary);
};

/**
 * POST /api/sessions/:sessionId/snapshot { event: compact | end, cwd? }: the session's gist
 * into the knowledge base (sessions/<project>/), and a live event saying so.
 */
const sessionSnapshotRoute: RouteHandler = async (req, res, params) => {
  const body = await readBody(req, 4_096);
  const event = body.event;
  if (event !== 'compact' && event !== 'end') {
    throw new HttpError(422, 'event must be "compact" or "end"');
  }
  const cwd = typeof body.cwd === 'string' ? body.cwd : undefined;
  const snap = await writeSessionSnapshot(params.sessionId!, event, cwd);
  if (!snap) throw new HttpError(404, `Session ${params.sessionId} not found`);
  if (!snap.path) return json(res, snap);
  invalidateOverview();
  // What a person reads in the toast: the session by its title.
  const evt = recordEvent(event === 'end' ? 'session-end' : 'compact', snap.title ?? snap.path);
  json(res, { ...snap, event: evt.id });
  // Committed (the snapshot alone, under its own message) and pushed after the answer: a file
  // left changed would stop the next `pull --rebase`, and a push may wait on the network.
  const dir = getConfig().memoryDir;
  if (existsSync(join(dir, '.git'))) {
    void gitPush(dir, `session ${event}: ${snap.title}`, [snap.path]).then((r) => {
      if (!r.success) console.error('[knowledge] snapshot commit:', r.message);
    });
  }
};

/**
 * GET /api/wakeup?sections=identity&budget=200: the wakeup bundle (as knowledge action=wakeup),
 * whether the person still has to say who they are (`onboarding`) and the knowledge folder.
 */
const wakeupRoute: RouteHandler = (req, res) => {
  const url = urlOf(req);
  const sections = (url.searchParams.get('sections') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is SectionName => DEFAULT_SECTIONS.includes(s as SectionName));
  const bundle = buildContextBundle({
    tokenBudget: intParam(url, 'budget', 800),
    ...(sections.length > 0 ? { sections } : {}),
  });
  const memoryDir = getConfig().memoryDir;
  // The folder as it is on disk: where the model is told to write identity.md.
  json(res, { ...bundle, onboarding: identityState(memoryDir), memory_dir: memoryDir });
};

/** GET /api/ingest?cwd=<folder>: whether the folder was ingested and what changed since. */
const ingestRoute: RouteHandler = (req, res) => {
  const cwd = urlOf(req).searchParams.get('cwd');
  if (!cwd) throw new HttpError(422, 'Required: cwd');
  json(res, ingestFreshness(cwd));
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
  let sessions = 0;
  for (const p of getProjectDirs()) sessions += getSessionFiles(p.path).length;
  const vectors = getVectorStore().stats();
  const data = {
    version: getVersion(),
    ...countEntries(config.memoryDir),
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
  let r: Awaited<ReturnType<typeof removeKnowledgeEntry>>;
  try {
    r = await removeKnowledgeEntry(getConfig().memoryDir, params.entryPath!);
  } catch (e) {
    throw new HttpError(400, e instanceof Error ? e.message : String(e));
  }
  if (!r.deleted) throw new HttpError(404, `File not found: ${params.entryPath}`);
  invalidateOverview();
  json(res, r);
};

/** POST /api/knowledge/sync: git pull then push, as knowledge(action=sync). */
const syncRoute: RouteHandler = async (_req, res) => {
  const result = await gitSync(getConfig().memoryDir);
  invalidateKnowledgeIndexCache();
  invalidateOverview();
  json(res, result);
};

/**
 * GET /api/analysis?offset=0&limit=30: the most linked entries (two links or more) and a page
 * of the ones with one link or none (`sparse`, fewest links first, then by title; all of
 * them counted in `sparse_total`), so no entry is in both.
 */
const analysisRoute: RouteHandler = (req, res) => {
  const url = urlOf(req);
  const dir = getConfig().memoryDir;
  const sparse = gaps(dir, Infinity).sort(
    (a, b) =>
      a.degree - b.degree ||
      a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' }),
  );
  const offset = Math.max(0, intParam(url, 'offset', 0));
  const limit = Math.min(Math.max(1, intParam(url, 'limit', 30)), 500);
  json(res, {
    hubs: godNodes(dir, 5).filter((n) => n.degree >= 2),
    sparse: sparse.slice(offset, offset + limit),
    sparse_total: sparse.length,
    offset,
  });
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
    .route('POST', '/api/sessions/:sessionId/snapshot', sessionSnapshotRoute)
    .route('GET', '/api/wakeup', wakeupRoute)
    .route('GET', '/api/ingest', ingestRoute)
    .route('POST', '/api/events', eventsRoute);
}
