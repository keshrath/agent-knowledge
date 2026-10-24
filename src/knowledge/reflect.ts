/**
 * Reflection Cycle — surfaces unconnected knowledge entries and prepares
 * a structured prompt for the calling agent's LLM to identify relationships.
 *
 * Does NOT call an LLM itself. Returns entries, summaries, and a prompt
 * that the agent can process to discover new connections.
 */

import { listEntries, readEntry, type KnowledgeEntry } from './store.js';
import { getKnowledgeGraph } from './graph.js';
import { parseFrontmatter } from './store.js';

export interface UnconnectedEntry {
  path: string;
  title: string;
  category: string;
  tags: string[];
  /** First 300 chars of body content (frontmatter stripped) */
  summary: string;
}

export interface ReflectionResult {
  /** Total entries scanned */
  totalEntries: number;
  /** Entries that have zero graph edges */
  unconnectedEntries: UnconnectedEntry[];
  /** Entries that have edges (for context) */
  connectedCount: number;
  /** Structured prompt for the agent's LLM */
  prompt: string;
  /** Suggested actions after reflection */
  instructions: string;
}

function readEntrySummary(dir: string, entryPath: string): string {
  try {
    const { content } = readEntry(dir, entryPath);
    const { body } = parseFrontmatter(content);
    const trimmed = body.slice(0, 300).replace(/\n/g, ' ').trim();
    return body.length > 300 ? trimmed + '...' : trimmed;
  } catch {
    return '(could not read content)';
  }
}

/**
 * Scan knowledge entries and find those without any graph edges.
 * Returns a structured prompt the agent can feed to its LLM.
 */
export function reflect(dir: string, category?: string, maxEntries: number = 20): ReflectionResult {
  const entries = listEntries(dir, category);
  const graph = getKnowledgeGraph();
  const allEdges = graph.links();

  // Build set of paths that appear in any edge
  const connectedPaths = new Set<string>();
  for (const edge of allEdges) {
    connectedPaths.add(edge.source);
    connectedPaths.add(edge.target);
  }

  const unconnected: UnconnectedEntry[] = [];
  const connected: KnowledgeEntry[] = [];

  for (const entry of entries) {
    if (connectedPaths.has(entry.path)) {
      connected.push(entry);
    } else {
      if (unconnected.length >= maxEntries) continue;

      const summary = readEntrySummary(dir, entry.path);

      unconnected.push({
        path: entry.path,
        title: entry.title,
        category: entry.category,
        tags: entry.tags,
        summary,
      });
    }
  }

  // Build the prompt
  const prompt = buildReflectionPrompt(unconnected, connected, allEdges.length);

  const instructions =
    'After analyzing the prompt above, call `knowledge_graph` with action "link" for each relationship ' +
    'you identify. Use relationship types: related_to, supersedes, depends_on, ' +
    'contradicts, specializes, part_of, alternative_to, builds_on. ' +
    'Set strength between 0.3 (weak) and 0.9 (strong).';

  return {
    totalEntries: entries.length,
    unconnectedEntries: unconnected,
    connectedCount: connected.length,
    prompt,
    instructions,
  };
}

function buildReflectionPrompt(
  unconnected: UnconnectedEntry[],
  connected: KnowledgeEntry[],
  edgeCount: number,
): string {
  if (unconnected.length === 0) {
    return 'All knowledge entries are connected in the graph. No reflection needed.';
  }

  const lines: string[] = [];

  lines.push('# Knowledge Graph Reflection');
  lines.push('');
  lines.push(
    `The knowledge base has ${unconnected.length + connected.length} entries ` +
      `and ${edgeCount} edges. ${unconnected.length} entries have NO connections.`,
  );
  lines.push('');
  lines.push('## Unconnected Entries');
  lines.push('');
  lines.push('These entries exist in isolation. Analyze each and suggest connections:');
  lines.push('');

  for (const entry of unconnected) {
    lines.push(`### ${entry.path}`);
    lines.push(`- **Title**: ${entry.title}`);
    lines.push(`- **Category**: ${entry.category}`);
    if (entry.tags.length > 0) {
      lines.push(`- **Tags**: ${entry.tags.join(', ')}`);
    }
    lines.push(`- **Summary**: ${entry.summary}`);
    lines.push('');
  }

  if (connected.length > 0) {
    lines.push('## Connected Entries (potential link targets)');
    lines.push('');
    for (const entry of connected) {
      lines.push(`- **${entry.path}** — ${entry.title} [${entry.category}]`);
    }
    lines.push('');
  }

  lines.push('## Task');
  lines.push('');
  lines.push('For each unconnected entry, identify which connected entries (or other ');
  lines.push('unconnected entries) it should be linked to. For each suggested link, specify:');
  lines.push('');
  lines.push('1. `source` — the unconnected entry path');
  lines.push('2. `target` — the entry to link to');
  lines.push('3. `rel_type` — one of: related_to, supersedes, depends_on, contradicts, ');
  lines.push('   specializes, part_of, alternative_to, builds_on');
  lines.push('4. `strength` — a number between 0.3 and 0.9');
  lines.push('');
  lines.push('Return your suggestions as a list of `knowledge_graph` action "link" calls.');

  return lines.join('\n');
}
