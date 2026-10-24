/**
 * Memory Consolidation — detects near-duplicate knowledge entries using TF-IDF.
 *
 * Two capabilities:
 * 1. On `knowledge` action "write", checks for similar existing entries and returns warnings.
 * 2. `knowledge_analyze` action "consolidate" scans a category and groups entries by similarity.
 */

import { TfIdfIndex } from '../search/tfidf.js';
import { listEntries, readEntry, type KnowledgeEntry } from './store.js';

export interface DuplicateWarning {
  path: string;
  title: string;
  similarity: number;
}

export interface ConsolidationCluster {
  /** Representative entry (highest connectivity in cluster) */
  representative: string;
  /** All entries in the cluster with pairwise similarities */
  entries: Array<{ path: string; title: string }>;
  /** Pairwise similarity pairs within the cluster */
  similarities: Array<{ a: string; b: string; score: number }>;
}

export interface ConsolidationReport {
  totalEntries: number;
  clustersFound: number;
  clusters: ConsolidationCluster[];
  threshold: number;
}

/**
 * Check for near-duplicate entries after writing.
 *
 * Builds a lightweight TF-IDF index from at most 50 recent entries plus the
 * written entry itself, searches with the new content, and returns entries
 * exceeding the similarity threshold. Capped at 50 entries to keep duplicate
 * detection O(1) amortized per write instead of O(n).
 */
export function checkDuplicates(
  dir: string,
  writtenPath: string,
  writtenContent: string,
  threshold: number = 0.6,
): DuplicateWarning[] {
  const entries = listEntries(dir);
  if (entries.length <= 1) return [];

  // Sort by recency so the cap keeps the most relevant entries
  entries.sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));

  const documents: Array<{ path: string; title: string; content: string }> = [];
  let hasWritten = false;

  for (const entry of entries) {
    if (entry.path === writtenPath) hasWritten = true;
    try {
      const { content } = readEntry(dir, entry.path);
      documents.push({ path: entry.path, title: entry.title, content });
    } catch {
      continue;
    }
    if (documents.length >= 50) break;
  }

  // Ensure the written entry is always included
  if (!hasWritten) {
    documents.push({ path: writtenPath, title: writtenPath, content: writtenContent });
  }

  if (documents.length <= 1) return [];

  // Build TF-IDF index from all collected entries (including written one)
  const index = new TfIdfIndex();
  for (const doc of documents) {
    index.addDocument(doc.path, doc.content);
  }

  // Search using the written content as query
  const results = index.search(writtenContent, 10);

  const warnings: DuplicateWarning[] = [];
  for (const result of results) {
    // Skip the entry itself
    if (result.id === writtenPath) continue;
    if (result.score >= threshold) {
      const doc = documents.find((d) => d.path === result.id);
      warnings.push({
        path: result.id,
        title: doc?.title ?? result.id,
        similarity: Math.round(result.score * 100) / 100,
      });
    }
  }

  return warnings;
}

/**
 * Scan all entries in a category (or all categories) and group
 * near-duplicates into clusters using TF-IDF similarity.
 */
export function consolidate(
  dir: string,
  category?: string,
  threshold: number = 0.5,
): ConsolidationReport {
  const entries = listEntries(dir, category);
  const documents: Array<{ entry: KnowledgeEntry; content: string }> = [];

  for (const entry of entries) {
    try {
      const { content } = readEntry(dir, entry.path);
      documents.push({ entry, content });
    } catch (err) {
      console.error('[knowledge] consolidate read:', err instanceof Error ? err.message : err);
      continue;
    }
  }

  if (documents.length < 2) {
    return { totalEntries: documents.length, clustersFound: 0, clusters: [], threshold };
  }

  // Build TF-IDF index
  const index = new TfIdfIndex();
  for (const doc of documents) {
    index.addDocument(doc.entry.path, doc.content);
  }

  // Compute pairwise similarities above threshold
  const pairs: Array<{ a: string; b: string; score: number }> = [];

  for (const doc of documents) {
    const results = index.search(doc.content, documents.length);
    for (const result of results) {
      if (result.id === doc.entry.path) continue;
      if (result.score >= threshold) {
        // Deduplicate: only store pair once (a < b lexically)
        const [a, b] =
          doc.entry.path < result.id ? [doc.entry.path, result.id] : [result.id, doc.entry.path];
        if (!pairs.some((p) => p.a === a && p.b === b)) {
          pairs.push({ a, b, score: Math.round(result.score * 100) / 100 });
        }
      }
    }
  }

  if (pairs.length === 0) {
    return { totalEntries: documents.length, clustersFound: 0, clusters: [], threshold };
  }

  // Build clusters using union-find
  const parent = new Map<string, string>();
  function find(x: string): string {
    if (!parent.has(x)) parent.set(x, x);
    if (parent.get(x) !== x) parent.set(x, find(parent.get(x)!));
    return parent.get(x)!;
  }
  function union(a: string, b: string): void {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }

  for (const pair of pairs) {
    union(pair.a, pair.b);
  }

  // Group entries by cluster root
  const clusterMap = new Map<string, Set<string>>();
  const allPaths = new Set<string>();
  for (const pair of pairs) {
    allPaths.add(pair.a);
    allPaths.add(pair.b);
  }
  for (const path of allPaths) {
    const root = find(path);
    if (!clusterMap.has(root)) clusterMap.set(root, new Set());
    clusterMap.get(root)!.add(path);
  }

  // Build cluster objects
  const clusters: ConsolidationCluster[] = [];
  for (const members of clusterMap.values()) {
    if (members.size < 2) continue;

    const memberPaths = Array.from(members);
    const clusterPairs = pairs.filter((p) => members.has(p.a) && members.has(p.b));

    // Representative: entry with most connections
    const connectionCount = new Map<string, number>();
    for (const p of clusterPairs) {
      connectionCount.set(p.a, (connectionCount.get(p.a) ?? 0) + 1);
      connectionCount.set(p.b, (connectionCount.get(p.b) ?? 0) + 1);
    }
    const representative = memberPaths.reduce((best, curr) =>
      (connectionCount.get(curr) ?? 0) > (connectionCount.get(best) ?? 0) ? curr : best,
    );

    const entryList = memberPaths.map((path) => {
      const doc = documents.find((d) => d.entry.path === path);
      return { path, title: doc?.entry.title ?? path };
    });

    clusters.push({
      representative,
      entries: entryList,
      similarities: clusterPairs,
    });
  }

  // Sort clusters by size descending
  clusters.sort((a, b) => b.entries.length - a.entries.length);

  return {
    totalEntries: documents.length,
    clustersFound: clusters.length,
    clusters,
    threshold,
  };
}
