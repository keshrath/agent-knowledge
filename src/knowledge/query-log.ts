/**
 * Query log — records every `knowledge_search` call so we can surface
 * zero-result queries as "gap" signals. The single best hint for "what
 * knowledge entries are missing?" is the set of things the agent keeps
 * searching for and not finding.
 *
 * Storage: a `query_log` table inside the existing `knowledge-scores.db`
 * SQLite database (same DB path pattern as `EntryScoring`).
 */

import { join, dirname } from 'path';
import { mkdirSync } from 'fs';
import { createRequire } from 'module';
import { getConfig } from '../types.js';
import { scrubContent } from './distill.js';
import { jaccardTokenSim } from '../search/mmr.js';

import type DatabaseConstructor from 'better-sqlite3';

const require = createRequire(import.meta.url);
type Database = InstanceType<typeof DatabaseConstructor>;

export interface QueryLogRow {
  id: number;
  query: string;
  project: string | null;
  results_count: number;
  created_at: string;
}

export interface SearchGap {
  query: string;
  count: number;
  last_seen: string;
  similar_queries?: string[];
}

export interface LogQueryArgs {
  query: string;
  project?: string | null;
  resultsCount: number;
}

export interface GetSearchGapsArgs {
  /** ISO timestamp; only queries at or after this time are considered. */
  since?: string;
  /** Minimum occurrence count per group (after similarity merging). Default: 1. */
  minCount?: number;
  /**
   * Jaccard token similarity threshold for merging queries. Default: 0.35.
   *
   * Lower than one might expect because Jaccard on short queries is small:
   * "gitlab credentials" vs "gitlab token" shares 1 content token out of 3,
   * giving 0.33. A threshold of 0.7 would force every zero-result query
   * into its own group — defeating the feature. 0.35 captures obvious
   * topic-overlap while rejecting unrelated queries (Jaccard=0).
   */
  groupSimilarity?: number;
}

/**
 * SQLite-backed query log. Tracks `{query, project, results_count,
 * created_at}` for every `knowledge_search` call and exposes a grouped
 * view of zero-result queries.
 */
export class QueryLog {
  private db: Database | null = null;
  private dbPath: string;
  private initialized = false;

  constructor(dbPath?: string) {
    // Share the lightweight scoring DB — same path pattern as EntryScoring.
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
        CREATE TABLE IF NOT EXISTS query_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          query TEXT NOT NULL,
          project TEXT,
          results_count INTEGER NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_query_log_results_created
          ON query_log(results_count, created_at);
      `);

      this.initialized = true;
    } catch (err) {
      console.error(`[knowledge] Failed to initialize query log: ${err}`);
      throw err;
    }
  }

  /**
   * Insert a single query entry. The query string is scrubbed via
   * `scrubContent` BEFORE insertion to keep secrets out of the log.
   */
  logQuery(args: LogQueryArgs): void {
    this.init();
    if (!this.db) throw new Error('Query log database not available');

    const scrubbed = scrubContent(args.query);
    const project = args.project ?? null;
    // Store an explicit ISO-8601 UTC timestamp. SQLite's CURRENT_TIMESTAMP
    // emits `YYYY-MM-DD HH:MM:SS` (no `T`, no `Z`) which doesn't compare
    // lexicographically against JS `toISOString()` strings — passing the
    // timestamp explicitly keeps `since` window queries correct.
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO query_log (query, project, results_count, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(scrubbed, project, args.resultsCount, now);
  }

  /**
   * Return zero-result queries grouped by similarity.
   *
   * Rows are considered zero-result when `results_count == 0`. Groups are
   * formed greedily — iterate rows ordered by most-recent first, and merge
   * into an existing group when `jaccardTokenSim(query, representative) >
   * threshold`.
   *
   * Each returned group carries:
   *   - `query`: the most-recent query text in the group
   *   - `count`: total number of rows collapsed into the group
   *   - `last_seen`: ISO timestamp of the most-recent row
   *   - `similar_queries`: other query texts in the group (may be empty)
   */
  getSearchGaps(args: GetSearchGapsArgs = {}): SearchGap[] {
    this.init();
    if (!this.db) throw new Error('Query log database not available');

    const since = args.since;
    const minCount = args.minCount ?? 1;
    const threshold = args.groupSimilarity ?? 0.35;

    const rows = since
      ? (this.db
          .prepare(
            `SELECT query, created_at FROM query_log
             WHERE results_count = 0 AND created_at >= ?
             ORDER BY created_at DESC`,
          )
          .all(since) as Array<{ query: string; created_at: string }>)
      : (this.db
          .prepare(
            `SELECT query, created_at FROM query_log
             WHERE results_count = 0
             ORDER BY created_at DESC`,
          )
          .all() as Array<{ query: string; created_at: string }>);

    interface Group {
      representative: string;
      last_seen: string;
      members: string[];
    }

    const groups: Group[] = [];
    for (const row of rows) {
      let merged = false;
      for (const g of groups) {
        if (jaccardTokenSim(row.query, g.representative) >= threshold) {
          g.members.push(row.query);
          // `rows` is ordered DESC by created_at, so the first row to land
          // in a group is the most recent — don't overwrite `last_seen`.
          merged = true;
          break;
        }
      }
      if (!merged) {
        groups.push({
          representative: row.query,
          last_seen: row.created_at,
          members: [row.query],
        });
      }
    }

    const result: SearchGap[] = [];
    for (const g of groups) {
      if (g.members.length < minCount) continue;
      const similar = g.members
        .slice(1)
        .filter((q) => q !== g.representative)
        // de-duplicate
        .filter((q, i, arr) => arr.indexOf(q) === i);
      const gap: SearchGap = {
        query: g.representative,
        count: g.members.length,
        last_seen: g.last_seen,
      };
      if (similar.length > 0) gap.similar_queries = similar;
      result.push(gap);
    }

    // Sort: highest count first, then most recent.
    result.sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return b.last_seen.localeCompare(a.last_seen);
    });

    return result;
  }

  /** Close the database connection. */
  close(): void {
    try {
      this.db?.close();
    } catch (err) {
      console.error(`[knowledge] Failed to close query log DB: ${err}`);
    } finally {
      this.db = null;
      this.initialized = false;
    }
  }
}

// ── Singleton instance ───────────────────────────────────────────────────────

let _queryLogInstance: QueryLog | null = null;

export function getQueryLog(dbPath?: string): QueryLog {
  if (!_queryLogInstance) {
    _queryLogInstance = new QueryLog(dbPath);
  }
  return _queryLogInstance;
}

/** Reset the singleton (for tests). */
export function resetQueryLog(): void {
  if (_queryLogInstance) {
    try {
      _queryLogInstance.close();
    } catch {
      /* ignore */
    }
    _queryLogInstance = null;
  }
}

/**
 * Best-effort logging. A log failure must never fail the caller; errors
 * are swallowed and written to stderr.
 */
export function logQuery(args: LogQueryArgs): void {
  try {
    getQueryLog().logQuery(args);
  } catch (err) {
    console.error('[knowledge] logQuery failed:', err instanceof Error ? err.message : err);
  }
}

/** Thin wrapper around the singleton. */
export function getSearchGaps(args: GetSearchGapsArgs = {}): SearchGap[] {
  return getQueryLog().getSearchGaps(args);
}
