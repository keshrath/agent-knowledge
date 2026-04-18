import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ensureRepo } from './knowledge/git.js';
import { RELATIONSHIP_TYPES } from './knowledge/graph.js';
import { backgroundIndex } from './sessions/indexer.js';
import { getConfig } from './types.js';
import { getVersion } from './version.js';
import { toolHandlers, validateArgs, err, SCOPES } from './tool-handlers.js';
import { CATEGORIES } from './knowledge/store.js';

export interface ServerOptions {
  /** Only the leader instance (dashboard owner) runs background indexing. */
  isLeader?: boolean;
}

// ── Tool definitions ─────────────────────────────────────────────────────────
// All six tools are exposed to the LLM. An earlier draft (dropped pre-release)
// hid the four advanced tools by default — in practice that saved near-zero
// tokens for Claude Code (which defers MCP schemas via ToolSearch anyway) and
// broke the knowledge-ingest skill. Clients that want a smaller surface should
// filter at the MCP client layer, not inside the server.

const KNOWLEDGE_TOOL = {
  name: 'knowledge',
  description:
    'Knowledge base CRUD, sync, and session-start hydration. Actions: ' +
    '"list" (browse entries), "read" (get entry content), ' +
    '"write" (create/update entry, auto git sync), ' +
    '"delete" (remove entry, auto git sync), "sync" (manual git pull + push), ' +
    '"wakeup" (return token-budgeted section-priority context bundle — identity, active_tasks, recent_decisions, known_gotchas, last_session_summary, top_weighted, semantic_fallback — call once at session start).',
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'read', 'write', 'delete', 'sync', 'wakeup'],
        description: 'Action to perform',
      },
      token_budget: {
        type: 'number',
        description: '[wakeup] Max tokens to render (chars/4 estimate, default 800)',
      },
      sections: {
        type: 'string',
        description:
          '[wakeup] Comma-separated, ordered section list. ' +
          'Valid: identity, active_tasks, recent_decisions, known_gotchas, last_session_summary, top_weighted, semantic_fallback. ' +
          'Default: all seven in that order. Omit to preserve v1.8.0 behaviour.',
      },
      section_budgets: {
        type: 'object',
        description:
          '[wakeup] Per-section token-budget overrides, e.g. {"identity": 200, "top_weighted": 400}. ' +
          'Unspecified sections split the remainder evenly. Unused budget redistributes to later sections.',
        additionalProperties: { type: 'number' },
      },
      category: {
        type: 'string',
        enum: [...CATEGORIES],
        description:
          'Category (action=list: filter; action=write: target directory). ' +
          'One of: projects, people, decisions, workflows, notes',
      },
      tag: {
        type: 'string',
        description: 'Filter by tag (action=list)',
      },
      path: {
        type: 'string',
        description:
          "Relative path to the entry, e.g. 'projects/my-project.md' (action=read, delete)",
      },
      filename: {
        type: 'string',
        description: "Filename with or without .md extension (action=write), e.g. 'my-project.md'",
      },
      content: {
        type: 'string',
        description: 'Full markdown content for the entry (action=write)',
      },
    },
    required: ['action'],
  },
};

const KNOWLEDGE_SEARCH_TOOL = {
  name: 'knowledge_search',
  description:
    'Search across sessions AND knowledge entries. ' +
    'Returns `{mode, sessions, knowledge}`. ' +
    'General mode (no `scope`): hybrid TF-IDF + semantic over both sources, with optional MMR diversity and category boost. ' +
    'Scoped mode (`scope` set): sessions-only filtered recall for a specific domain (errors, plans, configs, tools, files, decisions).',
  inputSchema: {
    type: 'object' as const,
    properties: {
      query: {
        type: 'string',
        description: 'Search query -- supports keywords and phrases',
      },
      scope: {
        type: 'string',
        enum: [...SCOPES],
        description:
          'Search scope (optional): errors (stack traces), plans (architecture, TODOs), ' +
          'configs (settings, env vars), tools (MCP tool calls), ' +
          'files (file paths, code refs), decisions (trade-offs, choices), all (no filter). ' +
          'When set, response mode switches to "scoped" and results are sessions-only.',
      },
      project: {
        type: 'string',
        description: 'Restrict search to sessions from this project',
      },
      role: {
        type: 'string',
        enum: ['user', 'assistant', 'all'],
        description: 'Filter by message role (default: all, ignored when scope is set)',
      },
      max_results: {
        type: 'number',
        description: 'Maximum number of results to return (default: 20)',
      },
      ranked: {
        type: 'boolean',
        description:
          'Use TF-IDF ranking (default: true, ignored when scope is set). Set false for regex mode.',
      },
      semantic: {
        type: 'boolean',
        description:
          'Blend semantic vector similarity with TF-IDF (default: true). Falls back to pure TF-IDF if embeddings unavailable.',
      },
      category: {
        type: 'string',
        enum: [...CATEGORIES],
        description:
          'Knowledge category hint (optional). By default applied as a boost (non-matching kept, matching +25%). Pass category_mode="filter" for the legacy hard-filter behavior.',
      },
      category_mode: {
        type: 'string',
        enum: ['filter', 'boost'],
        description:
          'How `category` is applied to knowledge results (default: "boost"). "boost" keeps all entries but gives matching-category entries a 25% score boost; "filter" restricts to matching category only.',
      },
      mmr: {
        type: 'boolean',
        description:
          'Apply Maximal Marginal Relevance re-ranking to knowledge results (default: false). Trades a small amount of top-1 relevance for diversity in the top-K.',
      },
      mmr_lambda: {
        type: 'number',
        description: 'MMR tradeoff 0-1 (default: 0.7). 1.0 = pure relevance; 0.0 = pure diversity.',
      },
      explain: {
        type: 'boolean',
        description:
          'When true, each knowledge hit carries `score_components` (bm25, decay, maturity, confidence, category_boost, mmr_penalty).',
      },
    },
    required: ['query'],
  },
};

const KNOWLEDGE_SESSION_TOOL = {
  name: 'knowledge_session',
  description:
    'Session operations: list sessions, get a full conversation, or get a summary. ' +
    'Use action "list" to browse sessions, "get" to retrieve messages, "summary" for a quick overview.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'get', 'summary'],
        description: 'Action to perform',
      },
      session_id: {
        type: 'string',
        description: 'Session UUID (required for get, summary)',
      },
      project: {
        type: 'string',
        description: 'Filter by project name (substring match)',
      },
      include_tools: {
        type: 'boolean',
        description: 'Include tool_use and tool_result messages (action=get, default: false)',
      },
      tail: {
        type: 'number',
        description: 'Only return the last N messages (action=get)',
      },
      limit: {
        type: 'number',
        description: 'Max sessions to return (action=list, default: 20, max: 500)',
      },
      offset: {
        type: 'number',
        description: 'Skip first N sessions (action=list, default: 0)',
      },
    },
    required: ['action'],
  },
};

const KNOWLEDGE_ADMIN_TOOL = {
  name: 'knowledge_admin',
  description:
    'Admin operations: view vector store stats, view/update configuration, rebuild embeddings, ' +
    'prune orphan session embeddings, or VACUUM the database. ' +
    'Use action "status" for index stats, "config" to view or update settings, ' +
    '"rebuild_embeddings" to re-embed all knowledge entries (useful when switching providers), ' +
    '"prune_orphans" to delete embeddings for sessions no longer present on disk, ' +
    '"vacuum" to reclaim free pages.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['status', 'config', 'rebuild_embeddings', 'prune_orphans', 'vacuum', 'promote'],
        description:
          'Action: status (vector store stats), config (view/update settings), rebuild_embeddings (re-embed all entries), prune_orphans (delete embeddings for missing sessions), vacuum (reclaim free pages), promote (run the scored promoter — see promote_mode)',
      },
      vacuum: {
        type: 'boolean',
        description: 'Run VACUUM after pruning (action=prune_orphans, default true)',
      },
      force_vacuum: {
        type: 'boolean',
        description: 'Run VACUUM even if no orphans were pruned (action=prune_orphans)',
      },
      git_url: {
        type: 'string',
        description: 'Git remote URL (action=config). Set to empty string to remove.',
      },
      memory_dir: {
        type: 'string',
        description: 'Local knowledge base directory (action=config). Empty to reset.',
      },
      auto_distill: {
        type: 'boolean',
        description: 'Enable/disable scheduled promotion (action=config)',
      },
      promote_mode: {
        type: 'string',
        enum: ['apply', 'explain'],
        description:
          'action=promote mode (default: explain). "explain" returns score breakdowns without writing; "apply" promotes candidates that pass all gates.',
      },
      min_score: {
        type: 'number',
        description: '[promote] Minimum composite score to promote (default: 0.5).',
      },
      min_recall_count: {
        type: 'number',
        description: '[promote] Minimum recall count gate (default: 2).',
      },
      min_unique_queries: {
        type: 'number',
        description: '[promote] Minimum unique-query gate (default: 2).',
      },
    },
    required: ['action'],
  },
};

const KNOWLEDGE_GRAPH_TOOL = {
  name: 'knowledge_graph',
  description:
    'Knowledge graph operations with temporal validity and code structure support. ' +
    'Create/remove edges, traverse via directed BFS, bulk-import code graph edges. ' +
    'Relationship types: related_to, supersedes, depends_on, contradicts, specializes, part_of, alternative_to, builds_on, calls, imports, inherits. ' +
    'Code structure types (calls/imports/inherits) are created by knowledge-ingest and use "code:" prefixed node IDs.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['link', 'unlink', 'invalidate', 'list', 'traverse', 'bulk_link', 'unlink_by_origin'],
        description:
          'Action: link (create edge), unlink (remove edge), invalidate (set valid_to), list (list edges), traverse (directed BFS), bulk_link (batch-create edges), unlink_by_origin (delete all edges from a specific origin)',
      },
      source: {
        type: 'string',
        description:
          "Source entry path (action=link/unlink/invalidate), e.g. 'projects/my-project.md'",
      },
      target: {
        type: 'string',
        description:
          "Target entry path (action=link/unlink/invalidate), e.g. 'decisions/architecture.md'",
      },
      entry: {
        type: 'string',
        description: 'Entry path for filtering (action=list) or BFS start (action=traverse)',
      },
      rel_type: {
        type: 'string',
        enum: [...RELATIONSHIP_TYPES],
        description:
          'Relationship type (required for link, optional filter for unlink/invalidate/list)',
      },
      strength: {
        type: 'number',
        description: 'Edge strength 0-1 (action=link, default: 0.5)',
      },
      depth: {
        type: 'number',
        description: 'Max traversal depth in hops (action=traverse, default: 2)',
      },
      valid_from: {
        type: 'string',
        description:
          'ISO date the fact became true (action=link, optional). Null/omitted = unbounded.',
      },
      valid_to: {
        type: 'string',
        description:
          'ISO date the fact stopped being true (action=link/invalidate). For invalidate, defaults to today.',
      },
      as_of: {
        type: 'string',
        description:
          'ISO date — only return edges valid at this date (action=list/traverse, optional)',
      },
      direction: {
        type: 'string',
        enum: ['outbound', 'inbound', 'both'],
        description:
          'Traversal direction (action=traverse, default: both). ' +
          'outbound: follow source→target (what does X call?). ' +
          'inbound: follow target→source (who calls X?). ' +
          'both: undirected (default, preserves legacy behavior).',
      },
      edges: {
        type: 'array',
        description:
          'Array of edges to create (action=bulk_link). Each: { source, target, rel_type, strength?, origin? }',
        items: {
          type: 'object',
          properties: {
            source: { type: 'string' },
            target: { type: 'string' },
            rel_type: { type: 'string', enum: [...RELATIONSHIP_TYPES] },
            strength: { type: 'number' },
            origin: { type: 'string' },
          },
          required: ['source', 'target', 'rel_type'],
        },
      },
      origin: {
        type: 'string',
        description:
          'Edge origin to delete (action=unlink_by_origin). E.g. "tree-sitter" to clear code graph before re-ingest.',
      },
    },
    required: ['action'],
  },
};

const KNOWLEDGE_ANALYZE_TOOL = {
  name: 'knowledge_analyze',
  description:
    'Analysis tools: find duplicates, unconnected entries, most-connected concepts (god nodes), ' +
    'bridge entries, knowledge gaps, zero-result search queries, stale-by-code-activity entries, ' +
    'or generate a compact knowledge brief. ' +
    'Actions: consolidate, reflect, god_nodes, bridges, gaps, brief, search_gaps, stale_by_code_activity.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: [
          'consolidate',
          'reflect',
          'god_nodes',
          'bridges',
          'gaps',
          'brief',
          'search_gaps',
          'stale_by_code_activity',
        ],
        description:
          'Action: consolidate (find duplicates), reflect (find unconnected entries), ' +
          'god_nodes (most-connected entries), bridges (cross-cluster connectors), ' +
          'gaps (entries with 0-1 edges), brief (compact knowledge base summary), ' +
          'search_gaps (zero-result knowledge_search queries grouped by similarity — ' +
          'the single best signal for "what entries should I write next?"), ' +
          'stale_by_code_activity (entries whose referenced file paths were modified in ' +
          'recent sessions after the entry body was last edited — automatic staleness signal, v1.8.1).',
      },
      category: {
        type: 'string',
        enum: [...CATEGORIES],
        description: 'Scan only this category (omit for all)',
      },
      threshold: {
        type: 'number',
        description: 'Similarity threshold 0-1 (action=consolidate, default: 0.5)',
      },
      max_entries: {
        type: 'number',
        description: 'Max unconnected entries to include (action=reflect, default: 20)',
      },
      top_n: {
        type: 'number',
        description: 'Number of results (action=god_nodes default: 10, action=bridges default: 5)',
      },
      since_days: {
        type: 'number',
        description:
          '[search_gaps] Lookback window in days (default: 30). Only queries logged within this window are considered.',
      },
      min_count: {
        type: 'number',
        description:
          '[search_gaps] Minimum occurrence count per merged group (default: 1). Raise to surface only repeated misses.',
      },
      group_similarity: {
        type: 'number',
        description:
          '[search_gaps] Jaccard token similarity threshold for merging near-duplicate queries (default: 0.35, range 0-1). Low because short queries yield low Jaccard even when topically related.',
      },
      min_touching_sessions: {
        type: 'number',
        description:
          "[stale_by_code_activity] Minimum distinct sessions that must have modified one of the entry's referenced files for it to be flagged (default: 1).",
      },
    },
    required: ['action'],
  },
};

export const TOOLS = [
  KNOWLEDGE_TOOL,
  KNOWLEDGE_SEARCH_TOOL,
  KNOWLEDGE_SESSION_TOOL,
  KNOWLEDGE_ADMIN_TOOL,
  KNOWLEDGE_GRAPH_TOOL,
  KNOWLEDGE_ANALYZE_TOOL,
] as const;

export function createServer(options?: ServerOptions): Server {
  const server = new Server(
    { name: 'agent-knowledge', version: getVersion() },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...TOOLS],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    const handler = toolHandlers[name];
    if (!handler) {
      return err(`Unknown tool: ${name}`);
    }

    try {
      const validated = validateArgs(args);
      return await handler(validated);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return err(`Error in ${name}: ${message}`);
    }
  });

  const startupConfig = getConfig();
  const repoResult = ensureRepo(startupConfig.memoryDir, startupConfig.gitUrl);
  console.error(`[knowledge] Repo init: ${repoResult.message}`);

  if (options?.isLeader !== false) {
    setTimeout(
      () =>
        backgroundIndex().catch((bgErr) =>
          console.error('[knowledge] Background index failed:', bgErr),
        ),
      5000,
    );
  } else {
    console.error('[knowledge] Follower instance -- skipping background indexing');
  }

  return server;
}
