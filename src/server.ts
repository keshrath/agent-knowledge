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

export function createServer(options?: ServerOptions): Server {
  const server = new Server(
    { name: 'agent-knowledge', version: getVersion() },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'knowledge',
        description:
          'Knowledge base CRUD and sync. Actions: ' +
          '"list" (browse entries), "read" (get entry content), ' +
          '"write" (create/update entry, auto git sync), ' +
          '"delete" (remove entry, auto git sync), "sync" (manual git pull + push).',
        inputSchema: {
          type: 'object' as const,
          properties: {
            action: {
              type: 'string',
              enum: ['list', 'read', 'write', 'delete', 'sync'],
              description: 'Action to perform',
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
              description:
                "Filename with or without .md extension (action=write), e.g. 'my-project.md'",
            },
            content: {
              type: 'string',
              description: 'Full markdown content for the entry (action=write)',
            },
          },
          required: ['action'],
        },
      },
      {
        name: 'knowledge_search',
        description:
          'Search across sessions AND knowledge entries. ' +
          'Returns both session matches (semantic + TF-IDF) and knowledge base matches. ' +
          'When "scope" is provided, searches within a specific domain (errors, plans, configs, tools, files, decisions) in sessions only.',
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
                'When provided, performs scoped recall instead of general search.',
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
          },
          required: ['query'],
        },
      },
      {
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
      },
      {
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
              enum: ['status', 'config', 'rebuild_embeddings', 'prune_orphans', 'vacuum'],
              description:
                'Action: status (vector store stats), config (view/update settings), rebuild_embeddings (re-embed all entries), prune_orphans (delete embeddings for missing sessions), vacuum (reclaim free pages)',
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
              description: 'Enable/disable session distillation (action=config)',
            },
          },
          required: ['action'],
        },
      },
      {
        name: 'knowledge_graph',
        description:
          'Knowledge graph operations: create/remove edges, list edges, or traverse via BFS. ' +
          'Relationship types: related_to, supersedes, depends_on, contradicts, specializes, part_of, alternative_to, builds_on.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            action: {
              type: 'string',
              enum: ['link', 'unlink', 'list', 'traverse'],
              description:
                'Action: link (create edge), unlink (remove edge), list (list edges), traverse (BFS)',
            },
            source: {
              type: 'string',
              description: "Source entry path (action=link/unlink), e.g. 'projects/my-project.md'",
            },
            target: {
              type: 'string',
              description:
                "Target entry path (action=link/unlink), e.g. 'decisions/architecture.md'",
            },
            entry: {
              type: 'string',
              description: 'Entry path for filtering (action=list) or BFS start (action=traverse)',
            },
            rel_type: {
              type: 'string',
              enum: [...RELATIONSHIP_TYPES],
              description: 'Relationship type (required for link, optional filter for unlink/list)',
            },
            strength: {
              type: 'number',
              description: 'Edge strength 0-1 (action=link, default: 0.5)',
            },
            depth: {
              type: 'number',
              description: 'Max traversal depth in hops (action=traverse, default: 2)',
            },
          },
          required: ['action'],
        },
      },
      {
        name: 'knowledge_analyze',
        description:
          'Analysis tools: find near-duplicate entries or unconnected entries. ' +
          'Use action "consolidate" to scan for duplicates (TF-IDF similarity), ' +
          '"reflect" to find entries with no graph connections and get a structured prompt for linking them.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            action: {
              type: 'string',
              enum: ['consolidate', 'reflect'],
              description:
                'Action: consolidate (find duplicates), reflect (find unconnected entries)',
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
          },
          required: ['action'],
        },
      },
    ],
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
