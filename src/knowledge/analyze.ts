/**
 * Knowledge graph analysis — god nodes, bridges, gaps, and knowledge brief.
 *
 * All analysis is based on the edges table in the graph DB and the
 * entry metadata in the markdown store. No LLM calls.
 */

import { listEntries, type KnowledgeEntry } from './store.js';
import { getKnowledgeGraph } from './graph.js';
import { getEntryScoring } from './scoring.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface GodNode {
  path: string;
  title: string;
  category: string;
  degree: number;
  confidence?: string;
}

export interface Bridge {
  path: string;
  title: string;
  betweenness: number;
  connects: string[];
  why: string;
}

export interface Gap {
  path: string;
  title: string;
  category: string;
  degree: number;
  maturity: string;
  daysSinceAccess: number | null;
}

export interface KnowledgeBrief {
  total_entries: number;
  total_edges: number;
  core_concepts: string[];
  active_projects: string[];
  recent_decisions: string[];
  stale_count: number;
  gap_count: number;
  generated_at: string;
  text: string;
}

// ── God Nodes ────────────────────────────────────────────────────────────────

/**
 * Find the most-connected entries in the knowledge graph (degree centrality).
 * Excludes auto-distilled entries that only have auto-link edges (noise).
 */
export function godNodes(dir: string, topN: number = 10): GodNode[] {
  const graph = getKnowledgeGraph();
  const allEdges = graph.links();

  if (allEdges.length === 0) return [];

  // Count degree per entry
  const degree = new Map<string, number>();
  const hasManualEdge = new Set<string>();

  for (const edge of allEdges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
    if (edge.origin !== 'auto-link') {
      hasManualEdge.add(edge.source);
      hasManualEdge.add(edge.target);
    }
  }

  // Load entry metadata
  const entries = listEntries(dir);
  const entryMap = new Map<string, KnowledgeEntry>();
  for (const e of entries) {
    entryMap.set(e.path, e);
  }

  // Sort by degree, filter out pure auto-link nodes and code graph nodes
  const sorted = Array.from(degree.entries())
    .filter(([path]) => entryMap.has(path) && !path.startsWith('code:'))
    .sort((a, b) => b[1] - a[1]);

  const result: GodNode[] = [];
  for (const [path, deg] of sorted) {
    const entry = entryMap.get(path)!;
    // Skip entries that ONLY have auto-link edges (noise from vector similarity)
    if (!hasManualEdge.has(path) && entry.tags?.includes('auto-distilled')) {
      continue;
    }
    result.push({
      path,
      title: entry.title,
      category: entry.category,
      degree: deg,
      confidence: entry.confidence,
    });
    if (result.length >= topN) break;
  }

  return result;
}

// ── Bridges ──────────────────────────────────────────────────────────────────

/**
 * Find entries that bridge otherwise separate clusters.
 * Uses simplified betweenness centrality — BFS from each node, counting
 * shortest paths through each intermediate node.
 */
export function bridges(dir: string, topN: number = 5): Bridge[] {
  const graph = getKnowledgeGraph();
  const allEdges = graph.links();

  if (allEdges.length === 0) return [];

  // Build adjacency list
  const adj = new Map<string, Set<string>>();
  for (const edge of allEdges) {
    if (!adj.has(edge.source)) adj.set(edge.source, new Set());
    if (!adj.has(edge.target)) adj.set(edge.target, new Set());
    adj.get(edge.source)!.add(edge.target);
    adj.get(edge.target)!.add(edge.source);
  }

  const nodes = Array.from(adj.keys());
  if (nodes.length < 3) return [];

  // Betweenness centrality (Brandes-like, simplified)
  const betweenness = new Map<string, number>();
  for (const n of nodes) betweenness.set(n, 0);

  // BFS from a sample of nodes (cap at 50 for performance)
  const sampleNodes = nodes.length <= 50 ? nodes : nodes.slice(0, 50);

  for (const source of sampleNodes) {
    // BFS
    const dist = new Map<string, number>();
    const paths = new Map<string, number>();
    const pred = new Map<string, string[]>();
    const stack: string[] = [];

    dist.set(source, 0);
    paths.set(source, 1);
    const queue = [source];

    while (queue.length > 0) {
      const v = queue.shift()!;
      stack.push(v);
      const dv = dist.get(v)!;

      for (const w of adj.get(v) ?? []) {
        if (!dist.has(w)) {
          dist.set(w, dv + 1);
          queue.push(w);
        }
        if (dist.get(w) === dv + 1) {
          paths.set(w, (paths.get(w) ?? 0) + (paths.get(v) ?? 1));
          if (!pred.has(w)) pred.set(w, []);
          pred.get(w)!.push(v);
        }
      }
    }

    // Back-propagation
    const delta = new Map<string, number>();
    for (const n of nodes) delta.set(n, 0);

    while (stack.length > 0) {
      const w = stack.pop()!;
      for (const v of pred.get(w) ?? []) {
        const d = ((paths.get(v) ?? 1) / (paths.get(w) ?? 1)) * (1 + (delta.get(w) ?? 0));
        delta.set(v, (delta.get(v) ?? 0) + d);
      }
      if (w !== source) {
        betweenness.set(w, (betweenness.get(w) ?? 0) + (delta.get(w) ?? 0));
      }
    }
  }

  // Load entry metadata
  const entries = listEntries(dir);
  const entryMap = new Map<string, KnowledgeEntry>();
  for (const e of entries) entryMap.set(e.path, e);

  // Sort by betweenness, find what they connect (exclude code graph nodes)
  const sorted = Array.from(betweenness.entries())
    .filter(([path]) => entryMap.has(path) && !path.startsWith('code:'))
    .filter(([, score]) => score > 0)
    .sort((a, b) => b[1] - a[1]);

  const result: Bridge[] = [];
  for (const [path, score] of sorted) {
    const entry = entryMap.get(path)!;
    const neighbors = adj.get(path) ?? new Set();
    const neighborCategories = new Set<string>();
    for (const n of neighbors) {
      const ne = entryMap.get(n);
      if (ne && ne.category !== entry.category) {
        neighborCategories.add(ne.category);
      }
    }

    const connects = Array.from(neighborCategories);
    if (connects.length === 0) continue; // Only interesting if it bridges categories

    result.push({
      path,
      title: entry.title,
      betweenness: Math.round(score * 100) / 100,
      connects: [entry.category, ...connects],
      why: `bridges ${entry.category} ↔ ${connects.join(', ')}`,
    });
    if (result.length >= topN) break;
  }

  return result;
}

// ── Gaps ─────────────────────────────────────────────────────────────────────

/**
 * Find entries with 0-1 graph edges. Includes maturity info — a "proven"
 * entry with no edges is more concerning than a fresh "candidate".
 */
export function gaps(dir: string, maxEntries: number = 30): Gap[] {
  const graph = getKnowledgeGraph();
  const allEdges = graph.links();
  const scoring = getEntryScoring();

  // Count degree per entry
  const degree = new Map<string, number>();
  for (const edge of allEdges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }

  const entries = listEntries(dir);
  const result: Gap[] = [];

  for (const entry of entries) {
    if (entry.path.startsWith('code:')) continue;
    const deg = degree.get(entry.path) ?? 0;
    if (deg > 1) continue;

    const scoreInfo = scoring.getScore(entry.path);
    const maturity = scoreInfo?.maturity ?? 'candidate';
    let daysSinceAccess: number | null = null;
    if (scoreInfo?.last_accessed) {
      const lastDate = new Date(scoreInfo.last_accessed).getTime();
      if (!isNaN(lastDate)) {
        daysSinceAccess = Math.round((Date.now() - lastDate) / (1000 * 60 * 60 * 24));
      }
    }

    result.push({
      path: entry.path,
      title: entry.title,
      category: entry.category,
      degree: deg,
      maturity,
      daysSinceAccess,
    });
  }

  // Sort: proven entries with gaps first (most concerning), then by degree ascending
  const maturityOrder: Record<string, number> = { proven: 0, established: 1, candidate: 2 };
  result.sort((a, b) => {
    const ma = maturityOrder[a.maturity] ?? 3;
    const mb = maturityOrder[b.maturity] ?? 3;
    if (ma !== mb) return ma - mb;
    return a.degree - b.degree;
  });

  return result.slice(0, maxEntries);
}

// ── Knowledge Brief ──────────────────────────────────────────────────────────

/**
 * Generate a compact knowledge base summary (~200 tokens).
 * Cached — call invalidateBriefCache() on write/delete/link/unlink.
 */

let _briefCache: { brief: KnowledgeBrief; timestamp: number } | null = null;
const BRIEF_TTL = 3600_000; // 1 hour

export function invalidateBriefCache(): void {
  _briefCache = null;
}

export function generateBrief(dir: string): KnowledgeBrief {
  if (_briefCache && Date.now() - _briefCache.timestamp < BRIEF_TTL) {
    return _briefCache.brief;
  }

  const entries = listEntries(dir);
  const graph = getKnowledgeGraph();
  const allEdges = graph.links();
  const scoring = getEntryScoring();

  // Core concepts (top god nodes)
  const gods = godNodes(dir, 5);
  const coreConceptNames = gods.map((g) => g.title);

  // Active projects (accessed in last 30 days)
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const projectEntries = entries.filter((e) => e.category === 'projects');
  const activeProjects: string[] = [];
  for (const e of projectEntries) {
    const scoreInfo = scoring.getScore(e.path);
    if (scoreInfo?.last_accessed) {
      const lastDate = new Date(scoreInfo.last_accessed).getTime();
      if (!isNaN(lastDate) && lastDate > thirtyDaysAgo) {
        activeProjects.push(e.title);
      }
    }
  }
  // If none accessed recently, fall back to most recently updated
  if (activeProjects.length === 0) {
    const sorted = projectEntries
      .filter((e) => e.updated)
      .sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));
    for (const e of sorted.slice(0, 5)) {
      activeProjects.push(e.title);
    }
  }

  // Recent decisions
  const decisionEntries = entries
    .filter((e) => e.category === 'decisions')
    .sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));
  const recentDecisions = decisionEntries.slice(0, 3).map((e) => e.title);

  // Stale count (not accessed in 30+ days, excluding brand-new entries)
  let staleCount = 0;
  for (const e of entries) {
    const scoreInfo = scoring.getScore(e.path);
    if (!scoreInfo) continue; // Never accessed — might be brand new
    if (scoreInfo.last_accessed) {
      const lastDate = new Date(scoreInfo.last_accessed).getTime();
      if (!isNaN(lastDate) && lastDate < thirtyDaysAgo) {
        staleCount++;
      }
    }
  }

  // Gap count
  const gapEntries = gaps(dir);
  const gapCount = gapEntries.length;

  // Build text summary
  const lines: string[] = [];
  lines.push(`Knowledge Base: ${entries.length} entries, ${allEdges.length} edges`);
  if (coreConceptNames.length > 0) {
    lines.push(`Core concepts: ${coreConceptNames.join(', ')}`);
  }
  if (activeProjects.length > 0) {
    lines.push(`Active projects: ${activeProjects.slice(0, 5).join(', ')}`);
  }
  if (recentDecisions.length > 0) {
    lines.push(`Recent decisions: ${recentDecisions.join(', ')}`);
  }
  const statusParts: string[] = [];
  if (staleCount > 0) statusParts.push(`Stale: ${staleCount} entries (>30d)`);
  if (gapCount > 0) statusParts.push(`Gaps: ${gapCount} entries (0-1 edges)`);
  if (statusParts.length > 0) {
    lines.push(statusParts.join(' | '));
  }

  const brief: KnowledgeBrief = {
    total_entries: entries.length,
    total_edges: allEdges.length,
    core_concepts: coreConceptNames,
    active_projects: activeProjects.slice(0, 5),
    recent_decisions: recentDecisions,
    stale_count: staleCount,
    gap_count: gapCount,
    generated_at: new Date().toISOString(),
    text: lines.join('\n'),
  };

  _briefCache = { brief, timestamp: Date.now() };
  return brief;
}
