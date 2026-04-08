/**
 * MCP tool handler functions — one per tool.
 *
 * Each handler receives validated args and returns a ToolResult.
 * The dispatch map in server.ts routes tool calls here.
 */

import { listEntries, readEntry, writeEntry, deleteEntry } from './knowledge/store.js';
import { gitPull, gitPush, gitSync, ensureRepo } from './knowledge/git.js';
import { getKnowledgeGraph, RELATIONSHIP_TYPES, type RelationshipType } from './knowledge/graph.js';
import { getEntryScoring } from './knowledge/scoring.js';
import { checkDuplicates } from './knowledge/consolidate.js';
import { consolidate } from './knowledge/consolidate.js';
import { reflect } from './knowledge/reflect.js';
import { indexKnowledgeEntry } from './sessions/indexer.js';
import { searchSessions } from './sessions/search.js';
import { searchKnowledge, invalidateKnowledgeIndexCache } from './knowledge/search.js';
import { listSessions, getSessionSummary } from './sessions/summary.js';
import { wakeup } from './wakeup.js';
import { scopedSearch, type SearchScope } from './sessions/scopes.js';
import { VectorStore } from './vectorstore/index.js';
import {
  getProjectDirs,
  getSessionFiles,
  parseSessionFile,
  extractMessages,
  getSessionMeta,
} from './sessions/parser.js';
import { getConfig, loadPersistedConfig, savePersistedConfig, getConfigLocation } from './types.js';
import {
  requireString,
  optionalString,
  optionalNumber as _optionalNumber,
  optionalBoolean as _optionalBoolean,
  optionalEnum,
} from './validate.js';

import { CATEGORIES } from './knowledge/store.js';
const SCOPES = ['errors', 'plans', 'configs', 'tools', 'files', 'decisions', 'all'] as const;

export { SCOPES };

// ── Validation wrappers ─────────────────────────────────────────────────────
// Thin wrappers to match the call-site signatures used throughout this file.

function optionalNumber(
  args: Record<string, unknown>,
  key: string,
  min?: number,
  max?: number,
): number | undefined {
  return _optionalNumber(args, key, { min, max });
}

function optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const val = _optionalBoolean(args, key);
  // validate.ts returns false for undefined; we need undefined here
  if (args[key] === undefined || args[key] === null) return undefined;
  return val;
}

function validateEnum<T extends string>(
  val: string | undefined,
  allowed: readonly T[],
  key: string,
): T | undefined {
  if (val === undefined) return undefined;
  // Use optionalEnum with a synthetic args object
  return optionalEnum({ [key]: val }, key, allowed) as T | undefined;
}

// ── Tool result types ────────────────────────────────────────────────────────

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export function ok(result: unknown): ToolResult {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
  };
}

export function err(message: string): ToolResult {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: message }, null, 2) }],
    isError: true,
  };
}

// ── Argument type guard ──────────────────────────────────────────────────────

/**
 * Validate that args is a non-null, non-array object.
 * Use at the top of every handler to get a typed Record<string, unknown>.
 */
export function validateArgs(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error('Invalid tool arguments');
  }
  return args as Record<string, unknown>;
}

// ── Handler type ─────────────────────────────────────────────────────────────

export type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult> | ToolResult;

// ── Handlers ─────────────────────────────────────────────────────────────────

/**
 * Unified CRUD + sync handler for knowledge base operations.
 * Routes by `action`: list, read, write, delete, sync.
 */
export async function handleKnowledge(args: Record<string, unknown>): Promise<ToolResult> {
  const a = validateArgs(args);
  const action = requireString(a, 'action');
  const config = getConfig();

  switch (action) {
    case 'list': {
      const category = validateEnum(optionalString(a, 'category'), CATEGORIES, 'category');
      const tag = optionalString(a, 'tag');
      await gitPull(config.memoryDir);
      const entries = listEntries(config.memoryDir, category, tag);
      return ok(entries);
    }
    case 'read': {
      const entryPath = requireString(a, 'path');
      await gitPull(config.memoryDir);
      const result = readEntry(config.memoryDir, entryPath);

      const scoring = getEntryScoring();
      const scoreInfo = scoring.recordAccess(entryPath);

      const graph = getKnowledgeGraph();
      const related = graph.getRelated(entryPath);

      return ok({ ...result, score: scoreInfo, related });
    }
    case 'write': {
      const category = requireString(a, 'category');
      const filename = requireString(a, 'filename');
      const writeContent = requireString(a, 'content');
      if (writeContent.length > 1_000_000) {
        return err('Content too large (max 1MB)');
      }
      await gitPull(config.memoryDir);
      const filePath = writeEntry(config.memoryDir, category, filename, writeContent);
      invalidateKnowledgeIndexCache();
      const pushResult = await gitPush(config.memoryDir);

      // Index the entry for embeddings
      const autoLinks: Array<{ target: string; similarity: number }> = [];
      try {
        await indexKnowledgeEntry(filePath, writeContent);

        // Auto-link: find similar entries via vector search
        const { getEmbeddingProvider } = await import('./embeddings/index.js');
        const provider = await getEmbeddingProvider();
        if (provider) {
          const queryVector = await provider.embedOne(writeContent.slice(0, 2000));
          const vecStore = new VectorStore();
          const similar = vecStore.searchBySource(queryVector, 'knowledge', 4);
          const graphStore = getKnowledgeGraph();

          for (const hit of similar) {
            if (hit.sourceId === filePath) continue;
            if (hit.score > 0.7) {
              graphStore.link(filePath, hit.sourceId, 'related_to', hit.score);
              autoLinks.push({
                target: hit.sourceId,
                similarity: Math.round(hit.score * 100) / 100,
              });
            }
            if (autoLinks.length >= 3) break;
          }
        }
      } catch (linkErr) {
        console.error('[knowledge] Auto-link failed:', linkErr);
      }

      let duplicateWarnings: Array<{ path: string; title: string; similarity: number }> = [];
      try {
        duplicateWarnings = checkDuplicates(config.memoryDir, filePath, writeContent);
      } catch (dupErr) {
        console.error('[knowledge] Duplicate check failed:', dupErr);
      }

      const response: Record<string, unknown> = { path: filePath, git: pushResult };
      if (autoLinks.length > 0) {
        response.autoLinked = autoLinks;
        response.autoLinkMessage =
          'Auto-linked to: ' +
          autoLinks.map((l) => l.target + ' (' + l.similarity + ')').join(', ');
      }
      if (duplicateWarnings.length > 0) {
        response.similarEntries = duplicateWarnings;
        response.duplicateWarning =
          'Similar entries found: ' +
          duplicateWarnings.map((w) => `${w.path} (similarity: ${w.similarity})`).join(', ');
      }
      return ok(response);
    }
    case 'delete': {
      const entryPath = requireString(a, 'path');
      await gitPull(config.memoryDir);
      const deleted = deleteEntry(config.memoryDir, entryPath);
      invalidateKnowledgeIndexCache();
      const pushResult = await gitPush(config.memoryDir);
      return ok({ deleted, git: pushResult });
    }
    case 'sync': {
      const result = await gitSync(config.memoryDir);
      return ok(result);
    }
    case 'wakeup': {
      const tokenBudget = optionalNumber(a, 'token_budget', 50, 8000);
      // Reuses the existing `category` param — same enum, same meaning.
      const scope = validateEnum(optionalString(a, 'category'), CATEGORIES, 'category');
      const result = wakeup({ tokenBudget, scope });
      return ok(result);
    }
    default:
      return err(
        `Unknown action: ${action}. Valid actions: list, read, write, delete, sync, wakeup`,
      );
  }
}

export function handleKnowledgeSession(
  args: Record<string, unknown>,
): ToolResult | Promise<ToolResult> {
  const a = validateArgs(args);
  const action = requireString(a, 'action');

  switch (action) {
    case 'list': {
      const project = optionalString(a, 'project');
      const limit = optionalNumber(a, 'limit', 1, 500) ?? 20;
      const offset = optionalNumber(a, 'offset', 0, 100000) ?? 0;
      let sessions = listSessions(project);
      const total = sessions.length;
      sessions = sessions.slice(offset, offset + limit);
      return ok({ total, offset, limit, sessions });
    }
    case 'get': {
      const sessionId = requireString(a, 'session_id');
      const projectFilter = optionalString(a, 'project');
      const includeTools = optionalBoolean(a, 'include_tools') ?? false;
      const tail = optionalNumber(a, 'tail', 1, 10000);

      const projects = getProjectDirs().filter(
        (p) => !projectFilter || p.name.toLowerCase().includes(projectFilter.toLowerCase()),
      );

      for (const proj of projects) {
        const sessions = getSessionFiles(proj.path);
        const match = sessions.find((s) => s.id === sessionId);
        if (match) {
          const entries = parseSessionFile(match.file);
          let messages = extractMessages(entries);
          if (!includeTools) {
            messages = messages.filter((m) => m.role === 'user' || m.role === 'assistant');
          }
          if (tail && tail > 0) {
            messages = messages.slice(-tail);
          }
          const meta = getSessionMeta(entries);
          return ok({ meta, messages });
        }
      }

      return err(`Session ${sessionId} not found.`);
    }
    case 'summary': {
      const sessionId = requireString(a, 'session_id');
      const project = optionalString(a, 'project');
      const result = getSessionSummary(sessionId, project);
      if (!result) {
        return err(`Session ${sessionId} not found.`);
      }
      return ok(result);
    }
    default:
      return err(`Unknown action: ${action}. Valid actions: list, get, summary`);
  }
}

/**
 * Unified search handler — merges knowledge_search and knowledge_recall.
 * When `scope` is provided, behaves as scoped recall.
 * Otherwise, performs general hybrid search.
 */
export async function handleKnowledgeSearch(args: Record<string, unknown>): Promise<ToolResult> {
  const a = validateArgs(args);
  const query = requireString(a, 'query');
  const project = optionalString(a, 'project');
  const maxResults = optionalNumber(a, 'max_results', 1, 500) ?? 20;
  const semantic = optionalBoolean(a, 'semantic') ?? true;

  // If scope is provided, delegate to scoped search (recall behavior)
  const scope = optionalString(a, 'scope');
  if (scope !== undefined) {
    validateEnum(scope, SCOPES, 'scope');
    const results = await scopedSearch(scope as SearchScope, query, {
      project,
      maxResults,
      semantic,
    });
    return ok(results);
  }

  // General search — sessions + knowledge entries
  const role =
    validateEnum(optionalString(a, 'role'), ['user', 'assistant', 'all'] as const, 'role') ?? 'all';
  const ranked = optionalBoolean(a, 'ranked') ?? true;
  const sessionResults = await searchSessions(query, {
    project,
    role,
    maxResults,
    ranked,
    semantic,
  });

  const config = getConfig();
  const category = optionalString(a, 'category');
  const categoryMode = validateEnum(
    optionalString(a, 'category_mode'),
    ['filter', 'boost'] as const,
    'category_mode',
  );
  const knowledgeResults = searchKnowledge(config.memoryDir, query, {
    maxResults: 10,
    category,
    categoryMode,
  }).map((r) => ({
    source: 'knowledge' as const,
    id: r.entry.path,
    path: r.entry.path,
    category: r.entry.category,
    title: r.entry.title || r.entry.path,
    excerpt: r.excerpt,
    score: r.score,
  }));

  return ok({ sessions: sessionResults, knowledge: knowledgeResults });
}

export async function handleKnowledgeAdmin(args: Record<string, unknown>): Promise<ToolResult> {
  const a = validateArgs(args);
  const action = requireString(a, 'action');

  switch (action) {
    case 'status': {
      const store = new VectorStore();
      const stats = store.stats();
      return ok(stats);
    }
    case 'rebuild_embeddings': {
      const { getEmbeddingProvider } = await import('./embeddings/index.js');
      const provider = await getEmbeddingProvider();
      if (!provider) {
        return err('No embedding provider available');
      }

      const config = getConfig();
      const store = new VectorStore();

      // Wipe existing vectors
      store.wipe();
      store.connect(provider.dimensions);
      store.setProvider(provider.name, provider.dimensions);

      // Re-embed all knowledge entries
      const entries = listEntries(config.memoryDir);
      let processed = 0;
      let failed = 0;

      for (const entry of entries) {
        try {
          const { content } = readEntry(config.memoryDir, entry.path);
          await indexKnowledgeEntry(entry.path, content);
          processed++;
        } catch (entryErr) {
          console.error(`[knowledge] rebuild: failed ${entry.path}: ${entryErr}`);
          failed++;
        }
      }

      return ok({
        message: 'Embedding rebuild complete',
        provider: provider.name,
        dimensions: provider.dimensions,
        processed,
        failed,
        total: entries.length,
      });
    }
    case 'config': {
      const config = getConfig();
      const gitUrlArg = optionalString(a, 'git_url');
      const memoryDirArg = optionalString(a, 'memory_dir');
      const autoDistillArg = optionalBoolean(a, 'auto_distill');

      const hasUpdates =
        gitUrlArg !== undefined || memoryDirArg !== undefined || autoDistillArg !== undefined;

      if (hasUpdates) {
        const updates: Record<string, unknown> = {};
        if (gitUrlArg !== undefined) updates.gitUrl = gitUrlArg || undefined;
        if (memoryDirArg !== undefined) updates.memoryDir = memoryDirArg || undefined;
        if (autoDistillArg !== undefined) updates.autoDistill = autoDistillArg;
        savePersistedConfig(updates);

        const newConfig = getConfig();
        if (gitUrlArg && gitUrlArg.length > 0) {
          const repoResult = ensureRepo(newConfig.memoryDir, newConfig.gitUrl);
          return ok({
            message: 'Config saved',
            repoSetup: repoResult,
            config: {
              gitUrl: newConfig.gitUrl,
              memoryDir: newConfig.memoryDir,
              autoDistill: newConfig.autoDistill,
              embeddingProvider: newConfig.embeddingProvider,
            },
          });
        }

        return ok({
          message: 'Config saved',
          config: {
            gitUrl: newConfig.gitUrl,
            memoryDir: newConfig.memoryDir,
            autoDistill: newConfig.autoDistill,
            embeddingProvider: newConfig.embeddingProvider,
          },
        });
      }

      const persisted = loadPersistedConfig();
      return ok({
        active: {
          gitUrl: config.gitUrl ?? null,
          memoryDir: config.memoryDir,
          autoDistill: config.autoDistill,
          embeddingProvider: config.embeddingProvider,
          embeddingAlpha: config.embeddingAlpha,
        },
        persisted,
        configFile: getConfigLocation(),
        note: 'Config stored at a tool-agnostic location. Env vars override persisted config.',
      });
    }
    case 'prune_orphans': {
      const store = new VectorStore();
      const live = new Set(listSessions().map((s) => s.sessionId));
      const result = store.pruneOrphanSessions(live);
      const doVacuum = _optionalBoolean(a, 'vacuum') ?? true;
      let vacuum: { beforeBytes: number; afterBytes: number; reclaimedBytes: number } | null = null;
      if (doVacuum && (result.sessions > 0 || _optionalBoolean(a, 'force_vacuum'))) {
        vacuum = store.vacuum();
      }
      return ok({
        message:
          result.sessions === 0
            ? 'No orphan sessions found'
            : `Pruned ${result.sessions} orphan session(s) (${result.chunks} chunks)`,
        prunedSessions: result.sessions,
        prunedChunks: result.chunks,
        vacuum,
      });
    }
    case 'vacuum': {
      const store = new VectorStore();
      const result = store.vacuum();
      return ok({
        message: `VACUUM complete, reclaimed ${(result.reclaimedBytes / (1024 * 1024)).toFixed(2)} MB`,
        ...result,
      });
    }
    default:
      return err(
        `Unknown action: ${action}. Valid actions: status, config, rebuild_embeddings, prune_orphans, vacuum`,
      );
  }
}

export function handleKnowledgeGraphConsolidated(args: Record<string, unknown>): ToolResult {
  const a = validateArgs(args);
  const action = requireString(a, 'action');

  switch (action) {
    case 'link': {
      const source = requireString(a, 'source');
      const target = requireString(a, 'target');
      const relType = requireString(a, 'rel_type');
      validateEnum(relType, RELATIONSHIP_TYPES, 'rel_type');
      const strength = optionalNumber(a, 'strength', 0, 1) ?? 0.5;
      const validFrom = optionalString(a, 'valid_from') ?? null;
      const validTo = optionalString(a, 'valid_to') ?? null;
      const graphStore = getKnowledgeGraph();
      const edge = graphStore.link(
        source,
        target,
        relType as RelationshipType,
        strength,
        validFrom,
        validTo,
      );
      return ok(edge);
    }
    case 'unlink': {
      const source = requireString(a, 'source');
      const target = requireString(a, 'target');
      const relType = validateEnum(
        optionalString(a, 'rel_type'),
        RELATIONSHIP_TYPES,
        'rel_type',
      ) as RelationshipType | undefined;
      const graphStore = getKnowledgeGraph();
      const removed = graphStore.unlink(source, target, relType);
      return ok({ removed });
    }
    case 'invalidate': {
      const source = requireString(a, 'source');
      const target = requireString(a, 'target');
      const relType = validateEnum(
        optionalString(a, 'rel_type'),
        RELATIONSHIP_TYPES,
        'rel_type',
      ) as RelationshipType | undefined;
      const validTo = optionalString(a, 'valid_to') ?? new Date().toISOString().slice(0, 10);
      const graphStore = getKnowledgeGraph();
      const updated = graphStore.invalidate(source, target, relType, validTo);
      return ok({ updated, valid_to: validTo });
    }
    case 'list': {
      const entry = optionalString(a, 'entry');
      const relType = validateEnum(
        optionalString(a, 'rel_type'),
        RELATIONSHIP_TYPES,
        'rel_type',
      ) as RelationshipType | undefined;
      const asOf = optionalString(a, 'as_of');
      const graphStore = getKnowledgeGraph();
      const edges = graphStore.links(entry, relType, asOf);
      return ok(edges);
    }
    case 'traverse': {
      const entry = requireString(a, 'entry');
      const depth = optionalNumber(a, 'depth', 1, 10) ?? 2;
      const asOf = optionalString(a, 'as_of');
      const graphStore = getKnowledgeGraph();
      const graphResult = graphStore.graph(entry, depth, asOf);
      return ok(graphResult);
    }
    default:
      return err(
        `Unknown action: ${action}. Valid actions: link, unlink, invalidate, list, traverse`,
      );
  }
}

export async function handleKnowledgeAnalyze(args: Record<string, unknown>): Promise<ToolResult> {
  const a = validateArgs(args);
  const action = requireString(a, 'action');
  const config = getConfig();

  switch (action) {
    case 'consolidate': {
      const category = validateEnum(optionalString(a, 'category'), CATEGORIES, 'category');
      const threshold = optionalNumber(a, 'threshold', 0, 1) ?? 0.5;
      await gitPull(config.memoryDir);
      const report = consolidate(config.memoryDir, category, threshold);
      return ok(report);
    }
    case 'reflect': {
      const category = validateEnum(optionalString(a, 'category'), CATEGORIES, 'category');
      const maxEntries = optionalNumber(a, 'max_entries', 1, 100) ?? 20;
      await gitPull(config.memoryDir);
      const result = reflect(config.memoryDir, category, maxEntries);
      return ok(result);
    }
    default:
      return err(`Unknown action: ${action}. Valid actions: consolidate, reflect`);
  }
}

// ── Dispatch map ─────────────────────────────────────────────────────────────

export const toolHandlers: Record<string, ToolHandler> = {
  // Consolidated tools (6 total) — wakeup folded into `knowledge` as an action
  knowledge: handleKnowledge,
  knowledge_search: handleKnowledgeSearch,
  knowledge_graph: handleKnowledgeGraphConsolidated,
  knowledge_session: handleKnowledgeSession,
  knowledge_analyze: handleKnowledgeAnalyze,
  knowledge_admin: handleKnowledgeAdmin,
};
