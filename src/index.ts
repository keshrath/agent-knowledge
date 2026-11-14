#!/usr/bin/env node
// =============================================================================
// agent-knowledge — MCP stdio entry point
//
// Serves the MCP tools over stdio. The process that holds the REST port
// (AGENT_KNOWLEDGE_PORT, default 3423) also runs the background indexer; the
// others retry the port and take over when its holder exits.
// =============================================================================

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';
import { DEFAULT_PORT, serveRestWhenFree } from './rest-server.js';
import { backgroundIndex, closeVectorStore } from './sessions/indexer.js';
import { warmKnowledgeIndex } from './knowledge/search.js';
import { warmSessionIndex } from './sessions/search.js';
import { getConfig } from './types.js';
import { ensureRepo } from './knowledge/git.js';

async function main() {
  // The knowledge folder exists (cloned from the remote the first time) before anything reads it.
  const config = getConfig();
  const repo = await ensureRepo(config.memoryDir, config.gitUrl);
  console.error(`[knowledge] Repo init: ${repo.message}`);

  const port = parseInt(process.env.AGENT_KNOWLEDGE_PORT || String(DEFAULT_PORT), 10);
  const rest = serveRestWhenFree(port, 5_000, () => {
    // The searches the plugin's lifecycle and the pane send land on warm indexes.
    warmKnowledgeIndex(getConfig().memoryDir)
      .then(() => warmSessionIndex())
      .catch((err) => console.error('[knowledge] warming the search indexes failed:', err));
    setTimeout(
      () =>
        backgroundIndex().catch((bgErr) =>
          console.error('[knowledge] Background index failed:', bgErr),
        ),
      5000,
    ).unref();
  });
  process.on('exit', () => {
    rest.close();
    closeVectorStore();
  });

  const server = createServer();
  await server.connect(new StdioServerTransport());
}

main().catch(console.error);
