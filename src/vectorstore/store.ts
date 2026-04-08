/**
 * SQLite-backed vector store using better-sqlite3 and sqlite-vec
 * for semantic similarity search over knowledge and session embeddings.
 */

import { join, dirname } from 'path';
import { statSync, mkdirSync } from 'fs';
import { createRequire } from 'module';
import { getConfig } from '../types.js';

import type DatabaseConstructor from 'better-sqlite3';

const require = createRequire(import.meta.url);
type Database = InstanceType<typeof DatabaseConstructor>;

/** A single embedding entry to store. */
export interface VectorEntry {
  id: string;
  source: 'knowledge' | 'session';
  sourceId: string;
  chunkIndex: number;
  chunkText: string;
  provider: string;
  dimensions: number;
  embedding: number[];
  metadata?: Record<string, unknown>;
}

/** A search result with similarity score. */
export interface VectorSearchResult {
  id: string;
  sourceId: string;
  source: 'knowledge' | 'session';
  chunkText: string;
  score: number;
  metadata?: Record<string, unknown>;
}

/** Aggregate statistics about the vector store. */
export interface VectorStoreStats {
  totalEntries: number;
  knowledgeEntries: number;
  sessionEntries: number;
  uniqueSessions: number;
  dbSizeMB: number;
  provider: string | null;
  dimensions: number | null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function toFloat32Buffer(vec: number[]): Buffer {
  const f32 = new Float32Array(vec);
  return Buffer.from(f32.buffer);
}

/**
 * SQLite + sqlite-vec vector store for semantic search.
 *
 * Call `connect()` once before using the store, or let public methods
 * auto-connect on first access. The DB connection and schema are set up
 * once; subsequent calls are no-ops.
 */
export class VectorStore {
  private db: Database | null = null;
  private dbPath: string;
  private connected = false;
  private vecAvailable = false;
  private currentDimensions: number | null = null;
  private connectError: Error | null = null;

  constructor(dbPath?: string) {
    this.dbPath = dbPath ?? join(getConfig().dataDir, 'knowledge-vectors.db');
  }

  // ── Connection ─────────────────────────────────────────────────────────────

  /**
   * Open the database, create tables, and load the sqlite-vec extension.
   * Safe to call multiple times — subsequent calls are no-ops unless
   * `dimensions` changes (which recreates the vec0 virtual table).
   *
   * If called without `dimensions`, uses the value stored in the meta table
   * from a previous run. Throws if no dimensions are available at all.
   */
  connect(dimensions?: number): void {
    if (this.connectError) {
      throw new Error(`Vector store previously failed to initialize: ${this.connectError.message}`);
    }

    const dims = dimensions ?? this.currentDimensions ?? this.readStoredDimensions();

    if (this.connected && this.currentDimensions === dims) return;

    try {
      this.openDb();
      this.createSchema();
      this.loadVecExtension();

      if (dims !== null && this.vecAvailable) {
        this.ensureVecTable(dims);
        this.currentDimensions = dims;
      }

      this.connected = true;
    } catch (err) {
      this.connectError = err instanceof Error ? err : new Error(String(err));
      console.error(`[knowledge] Failed to initialize vector store: ${err}`);
      throw this.connectError;
    }
  }

  private openDb(): void {
    if (this.db) return;
    mkdirSync(dirname(this.dbPath), { recursive: true });
    const BetterSqlite3 = require('better-sqlite3') as typeof DatabaseConstructor;
    this.db = new BetterSqlite3(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
  }

  private createSchema(): void {
    if (!this.db) return;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS embeddings (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL CHECK(source IN ('knowledge','session')),
        source_id TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        chunk_text TEXT NOT NULL,
        provider TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        embedding BLOB NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        metadata TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_emb_source ON embeddings(source, source_id);
      CREATE INDEX IF NOT EXISTS idx_emb_provider ON embeddings(provider);

      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  private loadVecExtension(): void {
    if (!this.db || this.vecAvailable) return;

    try {
      const sqliteVec = require('sqlite-vec') as { load: (db: Database) => void };
      sqliteVec.load(this.db);
      this.vecAvailable = true;
    } catch (err) {
      console.error(
        `[knowledge] sqlite-vec extension not available, vector search disabled: ${err}`,
      );
      this.vecAvailable = false;
    }
  }

  private ensureVecTable(dimensions: number): void {
    if (!this.db || !this.vecAvailable) return;

    try {
      const existing = this.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='vec_idx'")
        .get() as { name: string } | undefined;

      if (existing) {
        const storedDims = this.getMetaValue('dimensions');
        if (storedDims && parseInt(storedDims, 10) === dimensions) {
          return;
        }
        this.db.exec('DROP TABLE IF EXISTS vec_idx');
      }

      this.db.exec(
        `CREATE VIRTUAL TABLE vec_idx USING vec0(id TEXT PRIMARY KEY, embedding float[${dimensions}])`,
      );
      this.setMetaValue('dimensions', String(dimensions));
    } catch (err) {
      console.error(`[knowledge] Failed to create vec0 table: ${err}`);
      this.vecAvailable = false;
    }
  }

  /**
   * Read stored dimensions from meta (opens a temporary read-only DB if needed).
   */
  private readStoredDimensions(): number | null {
    if (this.db) {
      const val = this.getMetaValue('dimensions');
      return val ? parseInt(val, 10) : null;
    }
    try {
      const BetterSqlite3 = require('better-sqlite3') as typeof DatabaseConstructor;
      const tmpDb = new BetterSqlite3(this.dbPath, { readonly: true });
      try {
        const row = tmpDb.prepare("SELECT value FROM meta WHERE key = 'dimensions'").get() as
          | { value: string }
          | undefined;
        return row ? parseInt(row.value, 10) : null;
      } finally {
        tmpDb.close();
      }
    } catch (err) {
      console.error('[knowledge] stored dimensions:', err instanceof Error ? err.message : err);
      return null;
    }
  }

  /**
   * Ensure the store is connected. Auto-connects if not yet connected.
   * If `dimensions` is provided, also ensures the vec0 table matches.
   *
   * Throws a clear error if initialization fails.
   */
  private requireConnection(dimensions?: number): Database {
    if (!this.connected || (dimensions && this.currentDimensions !== dimensions)) {
      this.connect(dimensions ?? undefined);
    }
    if (!this.db) {
      throw new Error('Vector store database is not available');
    }
    return this.db;
  }

  // ── Meta helpers ───────────────────────────────────────────────────────────

  private getMetaValue(key: string): string | null {
    if (!this.db) return null;
    try {
      const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
        | { value: string }
        | undefined;
      return row?.value ?? null;
    } catch (err) {
      console.error('[knowledge] get meta:', err instanceof Error ? err.message : err);
      return null;
    }
  }

  private setMetaValue(key: string, value: string): void {
    if (!this.db) return;
    try {
      this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value);
    } catch (err) {
      console.error(`[knowledge] Failed to set meta value ${key}: ${err}`);
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Store embeddings for a source. Replaces existing chunks for the same source_id.
   * Uses a transaction for atomicity.
   */
  upsert(entries: VectorEntry[]): void {
    if (entries.length === 0) return;

    try {
      const dims = entries[0].dimensions;
      const db = this.requireConnection(dims);

      const insertEmbed = db.prepare(`
        INSERT OR REPLACE INTO embeddings
          (id, source, source_id, chunk_index, chunk_text, provider, dimensions, embedding, metadata)
        VALUES
          (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const deleteVec = this.vecAvailable ? db.prepare('DELETE FROM vec_idx WHERE id = ?') : null;

      const insertVec = this.vecAvailable
        ? db.prepare('INSERT INTO vec_idx (id, embedding) VALUES (?, ?)')
        : null;

      const deleteBySourceEmbed = db.prepare('SELECT id FROM embeddings WHERE source_id = ?');

      const transaction = db.transaction((items: VectorEntry[]) => {
        const sourceIds = new Set(items.map((e) => e.sourceId));
        for (const sid of sourceIds) {
          if (deleteVec) {
            const existing = deleteBySourceEmbed.all(sid) as Array<{ id: string }>;
            for (const row of existing) {
              deleteVec.run(row.id);
            }
          }
          db.prepare('DELETE FROM embeddings WHERE source_id = ?').run(sid);
        }

        for (const entry of items) {
          const buf = toFloat32Buffer(entry.embedding);
          insertEmbed.run(
            entry.id,
            entry.source,
            entry.sourceId,
            entry.chunkIndex,
            entry.chunkText,
            entry.provider,
            entry.dimensions,
            buf,
            entry.metadata ? JSON.stringify(entry.metadata) : null,
          );

          if (insertVec) {
            insertVec.run(entry.id, buf);
          }
        }
      });

      transaction(entries);
    } catch (err) {
      console.error(`[knowledge] Vector upsert failed: ${err}`);
    }
  }

  /**
   * Search by vector similarity. Returns top-k nearest neighbors.
   */
  search(queryVector: number[], maxResults: number = 10): VectorSearchResult[] {
    return this.searchInternal(queryVector, maxResults);
  }

  /**
   * Search filtered by source type (knowledge or session).
   */
  searchBySource(
    queryVector: number[],
    source: 'knowledge' | 'session',
    maxResults: number = 10,
  ): VectorSearchResult[] {
    return this.searchInternal(queryVector, maxResults, source);
  }

  private searchInternal(
    queryVector: number[],
    maxResults: number,
    source?: 'knowledge' | 'session',
  ): VectorSearchResult[] {
    let db: Database;
    try {
      db = this.requireConnection(queryVector.length);
    } catch (err) {
      console.error('[knowledge] search init:', err instanceof Error ? err.message : err);
      return [];
    }

    if (!this.vecAvailable) {
      console.error('[knowledge] Vector search unavailable — sqlite-vec not loaded');
      return [];
    }

    try {
      const queryBuf = toFloat32Buffer(queryVector);
      const fetchLimit = source ? maxResults * 3 : maxResults;

      const rows = db
        .prepare(
          `SELECT v.id, v.distance
           FROM vec_idx v
           WHERE v.embedding MATCH ?
           ORDER BY v.distance
           LIMIT ?`,
        )
        .all(queryBuf, fetchLimit) as Array<{ id: string; distance: number }>;

      if (rows.length === 0) return [];

      const idPlaceholders = rows.map(() => '?').join(',');
      const embeddingRows = db
        .prepare(
          `SELECT id, source, source_id, chunk_text, metadata
           FROM embeddings
           WHERE id IN (${idPlaceholders})`,
        )
        .all(...rows.map((r) => r.id)) as Array<{
        id: string;
        source: 'knowledge' | 'session';
        source_id: string;
        chunk_text: string;
        metadata: string | null;
      }>;

      const embMap = new Map(embeddingRows.map((r) => [r.id, r]));

      const results: VectorSearchResult[] = [];
      for (const row of rows) {
        const emb = embMap.get(row.id);
        if (!emb) continue;
        if (source && emb.source !== source) continue;

        results.push({
          id: row.id,
          sourceId: emb.source_id,
          source: emb.source,
          chunkText: emb.chunk_text,
          score: 1 - row.distance,
          metadata: emb.metadata ? JSON.parse(emb.metadata) : undefined,
        });

        if (results.length >= maxResults) break;
      }

      return results;
    } catch (err) {
      console.error(`[knowledge] Vector search failed: ${err}`);
      return [];
    }
  }

  /**
   * Delete all embeddings for a given source_id.
   */
  deleteBySource(sourceId: string): void {
    let db: Database;
    try {
      db = this.requireConnection();
    } catch (err) {
      console.error('[knowledge] deleteBySource init:', err instanceof Error ? err.message : err);
      return;
    }

    try {
      const ids = db
        .prepare('SELECT id FROM embeddings WHERE source_id = ?')
        .all(sourceId) as Array<{ id: string }>;

      if (ids.length === 0) return;

      const transaction = db.transaction(() => {
        if (this.vecAvailable) {
          const deleteVec = db.prepare('DELETE FROM vec_idx WHERE id = ?');
          for (const row of ids) {
            deleteVec.run(row.id);
          }
        }
        db.prepare('DELETE FROM embeddings WHERE source_id = ?').run(sourceId);
      });

      transaction();
    } catch (err) {
      console.error(`[knowledge] Delete by source failed: ${err}`);
    }
  }

  /**
   * Check whether a source_id has any stored embeddings.
   */
  hasEmbeddings(sourceId: string): boolean {
    let db: Database;
    try {
      db = this.requireConnection();
    } catch (err) {
      console.error('[knowledge] hasEmbeddings init:', err instanceof Error ? err.message : err);
      return false;
    }

    try {
      const row = db
        .prepare('SELECT 1 FROM embeddings WHERE source_id = ? LIMIT 1')
        .get(sourceId) as Record<string, unknown> | undefined;
      return row !== undefined;
    } catch (err) {
      console.error(`[knowledge] hasEmbeddings check failed: ${err}`);
      return false;
    }
  }

  /**
   * Get the name of the currently active embedding provider.
   */
  getCurrentProvider(): string | null {
    try {
      this.requireConnection();
    } catch (err) {
      console.error('[knowledge] getProvider init:', err instanceof Error ? err.message : err);
      return null;
    }
    return this.getMetaValue('provider');
  }

  /**
   * Set the active embedding provider. If the provider has changed since
   * the last call, all existing embeddings are wiped to avoid mixing
   * incompatible vector spaces.
   */
  setProvider(providerName: string, dimensions: number): boolean {
    const db = this.requireConnection(dimensions);
    if (!db) return false;

    const current = this.getMetaValue('provider');
    if (current && current !== providerName) {
      this.wipe();
      this.connected = false;
      this.connectError = null;
      this.connect(dimensions);
      this.setMetaValue('provider', providerName);
      this.setMetaValue('dimensions', String(dimensions));
      return true;
    }

    if (!current) {
      this.setMetaValue('provider', providerName);
    }
    return false;
  }

  /**
   * Wipe all embeddings and the vec0 index.
   * Used when switching embedding providers to avoid mixing vector spaces.
   */
  wipe(): void {
    let db: Database;
    try {
      db = this.requireConnection();
    } catch (err) {
      console.error('[knowledge] wipe init:', err instanceof Error ? err.message : err);
      return;
    }

    try {
      db.exec('DELETE FROM embeddings');
      if (this.vecAvailable) {
        db.exec('DROP TABLE IF EXISTS vec_idx');
      }
      db.exec("DELETE FROM meta WHERE key = 'dimensions'");
      this.currentDimensions = null;
    } catch (err) {
      console.error(`[knowledge] Wipe failed: ${err}`);
    }
  }

  /**
   * Get statistics about the vector store.
   */
  stats(): VectorStoreStats {
    const empty: VectorStoreStats = {
      totalEntries: 0,
      knowledgeEntries: 0,
      sessionEntries: 0,
      uniqueSessions: 0,
      dbSizeMB: 0,
      provider: null,
      dimensions: null,
    };

    let db: Database;
    try {
      db = this.requireConnection();
    } catch (err) {
      console.error('[knowledge] stats init:', err instanceof Error ? err.message : err);
      try {
        this.openDb();
        this.createSchema();
        this.connected = true;
        this.connectError = null;
        db = this.db!;
      } catch (err2) {
        console.error('[knowledge] stats db open:', err2 instanceof Error ? err2.message : err2);
        return empty;
      }
    }

    if (!db) return empty;

    try {
      const total = db.prepare('SELECT COUNT(*) as count FROM embeddings').get() as {
        count: number;
      };

      const knowledge = db
        .prepare("SELECT COUNT(*) as count FROM embeddings WHERE source = 'knowledge'")
        .get() as { count: number };

      const session = db
        .prepare("SELECT COUNT(*) as count FROM embeddings WHERE source = 'session'")
        .get() as { count: number };

      const uniqueSessions = db
        .prepare(
          "SELECT COUNT(DISTINCT source_id) as count FROM embeddings WHERE source = 'session'",
        )
        .get() as { count: number };

      let dbSizeMB = 0;
      try {
        const stat = statSync(this.dbPath);
        dbSizeMB = Math.round((stat.size / (1024 * 1024)) * 100) / 100;
      } catch (err) {
        console.error('[knowledge] db stat:', err instanceof Error ? err.message : err);
      }

      const provider = this.getMetaValue('provider');
      const dimStr = this.getMetaValue('dimensions');

      return {
        totalEntries: total.count,
        knowledgeEntries: knowledge.count,
        sessionEntries: session.count,
        uniqueSessions: uniqueSessions.count,
        dbSizeMB,
        provider,
        dimensions: dimStr ? parseInt(dimStr, 10) : null,
      };
    } catch (err) {
      console.error(`[knowledge] Stats query failed: ${err}`);
      return empty;
    }
  }

  /**
   * List distinct session source_ids that currently have embeddings.
   */
  listIndexedSessionIds(): string[] {
    let db: Database;
    try {
      db = this.requireConnection();
    } catch (err) {
      console.error(
        '[knowledge] listIndexedSessionIds init:',
        err instanceof Error ? err.message : err,
      );
      return [];
    }
    try {
      const rows = db
        .prepare("SELECT DISTINCT source_id FROM embeddings WHERE source = 'session'")
        .all() as Array<{ source_id: string }>;
      return rows.map((r) => r.source_id);
    } catch (err) {
      console.error(`[knowledge] listIndexedSessionIds failed: ${err}`);
      return [];
    }
  }

  /**
   * Delete embeddings for sessions whose source_id is not in `liveIds`.
   * Returns the number of orphan sessions removed and the chunk count deleted.
   */
  pruneOrphanSessions(liveIds: Set<string>): { sessions: number; chunks: number } {
    const indexed = this.listIndexedSessionIds();
    const orphans = indexed.filter((id) => !liveIds.has(id));
    if (orphans.length === 0) return { sessions: 0, chunks: 0 };

    let db: Database;
    try {
      db = this.requireConnection();
    } catch (err) {
      console.error('[knowledge] pruneOrphans init:', err instanceof Error ? err.message : err);
      return { sessions: 0, chunks: 0 };
    }

    let chunks = 0;
    try {
      const countStmt = db.prepare(
        "SELECT COUNT(*) as count FROM embeddings WHERE source = 'session' AND source_id = ?",
      );
      const transaction = db.transaction(() => {
        for (const sid of orphans) {
          const c = countStmt.get(sid) as { count: number };
          chunks += c.count;
          if (this.vecAvailable) {
            const ids = db
              .prepare("SELECT id FROM embeddings WHERE source = 'session' AND source_id = ?")
              .all(sid) as Array<{ id: string }>;
            const deleteVec = db.prepare('DELETE FROM vec_idx WHERE id = ?');
            for (const row of ids) deleteVec.run(row.id);
          }
          db.prepare("DELETE FROM embeddings WHERE source = 'session' AND source_id = ?").run(sid);
        }
      });
      transaction();
    } catch (err) {
      console.error(`[knowledge] pruneOrphans failed: ${err}`);
    }
    return { sessions: orphans.length, chunks };
  }

  /**
   * Run SQLite VACUUM to reclaim free pages. Returns the size delta in bytes.
   */
  vacuum(): { beforeBytes: number; afterBytes: number; reclaimedBytes: number } {
    let beforeBytes = 0;
    let afterBytes = 0;
    try {
      beforeBytes = statSync(this.dbPath).size;
    } catch {
      /* ignore */
    }
    try {
      const db = this.requireConnection();
      db.exec('VACUUM');
    } catch (err) {
      console.error(`[knowledge] VACUUM failed: ${err}`);
    }
    try {
      afterBytes = statSync(this.dbPath).size;
    } catch {
      /* ignore */
    }
    return { beforeBytes, afterBytes, reclaimedBytes: Math.max(0, beforeBytes - afterBytes) };
  }

  /** Close the database connection and release resources. */
  close(): void {
    try {
      this.db?.close();
    } catch (err) {
      console.error(`[knowledge] Failed to close vector store: ${err}`);
    } finally {
      this.db = null;
      this.connected = false;
      this.connectError = null;
      this.currentDimensions = null;
    }
  }
}
