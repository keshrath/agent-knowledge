/**
 * Knowledge Graph Layer — manages typed edges between knowledge entries.
 *
 * Stores edges in the same SQLite database as the vector store, with
 * BFS traversal for multi-hop graph queries.
 */

import { join, dirname } from 'path';
import { mkdirSync } from 'fs';
import { createRequire } from 'module';
import { getConfig } from '../types.js';

import type DatabaseConstructor from 'better-sqlite3';

const require = createRequire(import.meta.url);
type Database = InstanceType<typeof DatabaseConstructor>;

export const RELATIONSHIP_TYPES = [
  'related_to',
  'supersedes',
  'depends_on',
  'contradicts',
  'specializes',
  'part_of',
  'alternative_to',
  'builds_on',
  'calls',
  'imports',
  'inherits',
] as const;

export type RelationshipType = (typeof RELATIONSHIP_TYPES)[number];

export interface Edge {
  source: string;
  target: string;
  rel_type: RelationshipType;
  strength: number;
  created_at: string;
  /** ISO date (YYYY-MM-DD or full ISO timestamp) when this fact became true. Null = always valid. */
  valid_from: string | null;
  /** ISO date when this fact stopped being true. Null = still valid. */
  valid_to: string | null;
  origin: string; // 'manual' | 'auto-link' | 'distill' | 'reflect' | 'tree-sitter'
}

/** Returns true if the edge is valid at the given ISO date (or now). */
export function isEdgeValidAt(edge: Edge, asOf?: string): boolean {
  if (!asOf) return edge.valid_to === null;
  if (edge.valid_from && edge.valid_from > asOf) return false;
  if (edge.valid_to && edge.valid_to < asOf) return false;
  return true;
}

export interface GraphNode {
  path: string;
  depth: number;
}

export type TraverseDirection = 'outbound' | 'inbound' | 'both';

export interface GraphResult {
  nodes: GraphNode[];
  edges: Edge[];
}

/**
 * Knowledge graph backed by SQLite.
 * Lazily initializes the database on first access.
 */
export class KnowledgeGraph {
  private db: Database | null = null;
  private dbPath: string;
  private initialized = false;

  constructor(dbPath?: string) {
    // Use a separate lightweight DB — NOT the 544MB vector store
    this.dbPath = dbPath ?? join(getConfig().dataDir, 'knowledge-scores.db');
  }

  private init(): void {
    if (this.initialized) return;

    try {
      if (!this.db) {
        mkdirSync(dirname(this.dbPath), { recursive: true });
        const BetterSqlite3 = require('better-sqlite3') as typeof DatabaseConstructor;
        this.db = new BetterSqlite3(this.dbPath);
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('foreign_keys = ON');
      }

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS edges (
          source TEXT NOT NULL,
          target TEXT NOT NULL,
          rel_type TEXT NOT NULL,
          strength REAL DEFAULT 0.5,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          valid_from TEXT,
          valid_to TEXT,
          PRIMARY KEY (source, target, rel_type)
        );
        CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source);
        CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target);
      `);

      // Backwards-compat migration: existing DBs may not have valid_from/valid_to
      for (const col of ['valid_from', 'valid_to']) {
        try {
          this.db.exec(`ALTER TABLE edges ADD COLUMN ${col} TEXT`);
        } catch {
          // column already exists
        }
      }

      // Migration: add origin column
      try {
        this.db.exec(`ALTER TABLE edges ADD COLUMN origin TEXT DEFAULT 'manual'`);
      } catch {
        // column already exists
      }

      this.initialized = true;
    } catch (err) {
      console.error(`[knowledge] Failed to initialize graph: ${err}`);
      throw err;
    }
  }

  /**
   * Create or update an edge between two entries.
   *
   * Optional `validFrom`/`validTo` mark this fact's temporal validity window.
   * Both are ISO date strings (YYYY-MM-DD or full ISO timestamp); null = unbounded.
   */
  link(
    source: string,
    target: string,
    relType: RelationshipType,
    strength: number = 0.5,
    validFrom: string | null = null,
    validTo: string | null = null,
    origin: string = 'manual',
  ): Edge {
    this.init();
    if (!this.db) throw new Error('Graph database not available');

    if (!RELATIONSHIP_TYPES.includes(relType)) {
      throw new Error(
        `Invalid relationship type: ${relType}. Must be one of: ${RELATIONSHIP_TYPES.join(', ')}`,
      );
    }
    if (strength < 0 || strength > 1) {
      throw new Error('Strength must be between 0 and 1');
    }
    if (source === target) {
      throw new Error('Cannot create self-referencing edge');
    }

    this.db
      .prepare(
        `INSERT INTO edges (source, target, rel_type, strength, valid_from, valid_to, origin)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(source, target, rel_type)
         DO UPDATE SET strength = excluded.strength,
                       valid_from = excluded.valid_from,
                       valid_to = excluded.valid_to,
                       origin = excluded.origin`,
      )
      .run(source, target, relType, strength, validFrom, validTo, origin);

    const row = this.db
      .prepare('SELECT * FROM edges WHERE source = ? AND target = ? AND rel_type = ?')
      .get(source, target, relType) as Edge;

    return row;
  }

  /**
   * Mark an existing edge as no longer valid by setting `valid_to`.
   * If relType is omitted, invalidates all matching edges between source and target.
   * Returns number of edges updated.
   */
  invalidate(
    source: string,
    target: string,
    relType: RelationshipType | undefined,
    validTo: string,
  ): number {
    this.init();
    if (!this.db) throw new Error('Graph database not available');

    if (relType) {
      const result = this.db
        .prepare('UPDATE edges SET valid_to = ? WHERE source = ? AND target = ? AND rel_type = ?')
        .run(validTo, source, target, relType);
      return result.changes;
    }
    const result = this.db
      .prepare('UPDATE edges SET valid_to = ? WHERE source = ? AND target = ?')
      .run(validTo, source, target);
    return result.changes;
  }

  /**
   * Remove edge(s) between two entries.
   * If relType is omitted, removes all edges between source and target.
   */
  unlink(source: string, target: string, relType?: RelationshipType): number {
    this.init();
    if (!this.db) throw new Error('Graph database not available');

    if (relType) {
      const result = this.db
        .prepare('DELETE FROM edges WHERE source = ? AND target = ? AND rel_type = ?')
        .run(source, target, relType);
      return result.changes;
    }

    const result = this.db
      .prepare('DELETE FROM edges WHERE source = ? AND target = ?')
      .run(source, target);
    return result.changes;
  }

  /**
   * List edges, optionally filtered by entry path and/or relationship type.
   * If `asOf` is set, only edges valid at that date are returned.
   */
  links(entry?: string, relType?: RelationshipType, asOf?: string): Edge[] {
    this.init();
    if (!this.db) return [];

    let rows: Edge[];
    if (entry && relType) {
      rows = this.db
        .prepare(
          `SELECT * FROM edges
           WHERE (source = ? OR target = ?) AND rel_type = ?
           ORDER BY created_at DESC`,
        )
        .all(entry, entry, relType) as Edge[];
    } else if (entry) {
      rows = this.db
        .prepare(
          `SELECT * FROM edges
           WHERE source = ? OR target = ?
           ORDER BY created_at DESC`,
        )
        .all(entry, entry) as Edge[];
    } else if (relType) {
      rows = this.db
        .prepare('SELECT * FROM edges WHERE rel_type = ? ORDER BY created_at DESC')
        .all(relType) as Edge[];
    } else {
      rows = this.db.prepare('SELECT * FROM edges ORDER BY created_at DESC').all() as Edge[];
    }

    if (asOf !== undefined) {
      return rows.filter((e) => isEdgeValidAt(e, asOf));
    }
    return rows;
  }

  /**
   * BFS traversal from a starting entry, returning all nodes and edges
   * within `depth` hops.
   *
   * @param direction - `outbound` follows source→target only, `inbound` follows
   *   target→source only, `both` (default) follows edges in either direction.
   * @param relType - if set, only follow edges of this relationship type.
   * @param asOf - if set, only edges valid at that date are followed.
   */
  graph(
    entry: string,
    depth: number = 2,
    asOf?: string,
    direction: TraverseDirection = 'both',
    relType?: RelationshipType,
  ): GraphResult {
    this.init();
    if (!this.db) return { nodes: [], edges: [] };

    const visited = new Map<string, number>(); // path -> depth
    const resultEdges: Edge[] = [];
    const queue: Array<{ path: string; currentDepth: number }> = [{ path: entry, currentDepth: 0 }];

    visited.set(entry, 0);

    while (queue.length > 0) {
      const item = queue.shift()!;
      if (item.currentDepth >= depth) continue;

      // Query edges based on direction
      let rawEdges: Edge[];
      if (direction === 'outbound') {
        rawEdges = this.db.prepare('SELECT * FROM edges WHERE source = ?').all(item.path) as Edge[];
      } else if (direction === 'inbound') {
        rawEdges = this.db.prepare('SELECT * FROM edges WHERE target = ?').all(item.path) as Edge[];
      } else {
        rawEdges = this.db
          .prepare('SELECT * FROM edges WHERE source = ? OR target = ?')
          .all(item.path, item.path) as Edge[];
      }

      // Apply filters
      let edges = rawEdges;
      if (relType) {
        edges = edges.filter((e) => e.rel_type === relType);
      }
      if (asOf !== undefined) {
        edges = edges.filter((e) => isEdgeValidAt(e, asOf));
      }

      for (const edge of edges) {
        const isDuplicate = resultEdges.some(
          (e) =>
            e.source === edge.source && e.target === edge.target && e.rel_type === edge.rel_type,
        );
        if (!isDuplicate) {
          resultEdges.push(edge);
        }

        // Determine neighbor based on direction
        let neighbor: string;
        if (direction === 'outbound') {
          neighbor = edge.target;
        } else if (direction === 'inbound') {
          neighbor = edge.source;
        } else {
          neighbor = edge.source === item.path ? edge.target : edge.source;
        }

        if (!visited.has(neighbor)) {
          const neighborDepth = item.currentDepth + 1;
          visited.set(neighbor, neighborDepth);
          queue.push({ path: neighbor, currentDepth: neighborDepth });
        }
      }
    }

    const nodes: GraphNode[] = Array.from(visited.entries()).map(([p, d]) => ({
      path: p,
      depth: d,
    }));

    return { nodes, edges: resultEdges };
  }

  /**
   * Get 1-hop connected entries for a given entry path.
   */
  getRelated(entry: string): Array<{ path: string; rel_type: string; strength: number }> {
    this.init();
    if (!this.db) return [];

    const edges = this.db
      .prepare('SELECT * FROM edges WHERE source = ? OR target = ?')
      .all(entry, entry) as Edge[];

    return edges.map((e) => ({
      path: e.source === entry ? e.target : e.source,
      rel_type: e.rel_type,
      strength: e.strength,
    }));
  }

  /**
   * Bulk-create edges in a single transaction. Efficient for ingesting
   * code structure (call graphs, imports, inheritance) where hundreds of
   * edges are created at once.
   *
   * Edges that would be self-referencing are silently skipped.
   * Returns the number of edges created/updated.
   */
  bulkLink(
    edges: Array<{
      source: string;
      target: string;
      rel_type: RelationshipType;
      strength?: number;
      origin?: string;
    }>,
  ): number {
    this.init();
    if (!this.db) throw new Error('Graph database not available');

    // ON CONFLICT intentionally only updates strength + origin (not valid_from/valid_to)
    // because code structure edges don't use temporal validity windows.
    const stmt = this.db.prepare(
      `INSERT INTO edges (source, target, rel_type, strength, origin)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(source, target, rel_type)
       DO UPDATE SET strength = excluded.strength, origin = excluded.origin`,
    );

    let count = 0;
    const run = this.db.transaction(() => {
      for (const edge of edges) {
        if (edge.source === edge.target) continue;
        if (!RELATIONSHIP_TYPES.includes(edge.rel_type)) continue;
        const strength = edge.strength ?? 0.5;
        if (strength < 0 || strength > 1) continue;
        stmt.run(edge.source, edge.target, edge.rel_type, strength, edge.origin ?? 'tree-sitter');
        count++;
      }
    });
    run();

    return count;
  }

  /**
   * Delete all edges matching a given origin. Useful for clearing stale
   * code graph edges before re-ingesting.
   */
  unlinkByOrigin(origin: string): number {
    this.init();
    if (!this.db) throw new Error('Graph database not available');
    const result = this.db.prepare('DELETE FROM edges WHERE origin = ?').run(origin);
    return result.changes;
  }

  /** Close the database connection. */
  close(): void {
    try {
      this.db?.close();
    } catch (err) {
      console.error(`[knowledge] Failed to close graph DB: ${err}`);
    } finally {
      this.db = null;
      this.initialized = false;
    }
  }
}

// ── Singleton instance ───────────────────────────────────────────────────────

let _graphInstance: KnowledgeGraph | null = null;

export function getKnowledgeGraph(dbPath?: string): KnowledgeGraph {
  if (!_graphInstance) {
    _graphInstance = new KnowledgeGraph(dbPath);
  }
  return _graphInstance;
}

/** Reset the singleton (for tests). */
export function resetKnowledgeGraph(): void {
  if (_graphInstance) {
    _graphInstance.close();
    _graphInstance = null;
  }
}
