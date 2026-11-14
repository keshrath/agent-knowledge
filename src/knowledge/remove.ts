// =============================================================================
// agent-knowledge — deleting an entry, for the MCP tool and the REST route
// =============================================================================

import { getKnowledgeGraph } from './graph.js';
import { gitPull, gitPush, type GitResult } from './git.js';
import { invalidateBriefCache } from './analyze.js';
import { invalidateKnowledgeIndexCache } from './search.js';
import { deleteEntry } from './store.js';

/**
 * Deletes `entryPath` from the knowledge base in `dir` and every graph edge to or from it (a
 * link to a gone entry leads nowhere and would still count in the link analysis), then pushes.
 * Git is null when nothing was deleted. Throws on a path outside the knowledge base.
 */
export async function removeKnowledgeEntry(
  dir: string,
  entryPath: string,
): Promise<{ deleted: boolean; git: GitResult | null }> {
  await gitPull(dir);
  const deleted = deleteEntry(dir, entryPath);
  if (!deleted) return { deleted, git: null };
  getKnowledgeGraph().forget(entryPath);
  invalidateKnowledgeIndexCache();
  invalidateBriefCache();
  return { deleted, git: await gitPush(dir) };
}
