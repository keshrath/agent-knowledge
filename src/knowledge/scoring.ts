/**
 * Confidence/Decay Scoring — tracks access patterns for knowledge entries
 * and provides maturity-based scoring for search result ranking.
 */

import { join, dirname } from 'path';
import { mkdirSync } from 'fs';
import { createRequire } from 'module';
import { getConfig } from '../types.js';

import type DatabaseConstructor from 'better-sqlite3';

const require = createRequire(import.meta.url);
type Database = InstanceType<typeof DatabaseConstructor>;

export type Maturity = 'candidate' | 'established' | 'proven';

export interface EntryScore {
  entry_path: string;
  access_count: number;
  last_accessed: string;
  maturity: Maturity;
  created_at: string;
}

const MATURITY_MULTIPLIERS: Record<Maturity, number> = {
  candidate: 0.5,
  established: 1.0,
  proven: 1.5,
};

const PROMOTION_THRESHOLDS: Array<{ from: Maturity; to: Maturity; minAccess: number }> = [
  { from: 'candidate', to: 'established', minAccess: 5 },
  { from: 'established', to: 'proven', minAccess: 20 },
];

/**
 * Compute decay factor based on days since last access.
 * Half-life of 90 days.
 */
export function decayFactor(lastAccessed: string): number {
  const now = Date.now();
  const lastDate = new Date(lastAccessed).getTime();
  if (isNaN(lastDate)) return 1;
  const daysSince = Math.max(0, (now - lastDate) / (1000 * 60 * 60 * 24));
  return Math.pow(0.5, daysSince / 90);
}

/**
 * Get maturity multiplier for scoring.
 */
export function maturityMultiplier(maturity: Maturity): number {
  return MATURITY_MULTIPLIERS[maturity] ?? 0.5;
}

/**
 * Compute final score: baseRelevance * decayFactor * maturityMultiplier * confidence
 *
 * Evergreen entries (frontmatter `evergreen: true`) skip the decay factor.
 * Decisions, architecture, and identity entries should carry the flag so
 * their ranking isn't punished by calendar time.
 */
export function computeFinalScore(
  baseRelevance: number,
  lastAccessed: string | null,
  maturity: Maturity,
  confidence?: string,
  evergreen?: boolean,
): number {
  const decay = evergreen ? 1 : lastAccessed ? decayFactor(lastAccessed) : 1;
  const multiplier = maturityMultiplier(maturity);
  const confidenceFactor = confidence === 'inferred' ? 0.85 : 1.0;
  return baseRelevance * decay * multiplier * confidenceFactor;
}

/**
 * Entry scoring backed by SQLite.
 * Tracks access counts, last-accessed timestamps, and maturity levels.
 */
export class EntryScoring {
  private db: Database | null = null;
  private dbPath: string;
  private initialized = false;

  constructor(dbPath?: string) {
    // Use a separate lightweight DB for scoring — NOT the 544MB vector store
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
        CREATE TABLE IF NOT EXISTS entry_scores (
          entry_path TEXT PRIMARY KEY,
          access_count INTEGER DEFAULT 0,
          last_accessed TEXT,
          maturity TEXT DEFAULT 'candidate',
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
      `);

      this.initialized = true;
    } catch (err) {
      console.error(`[knowledge] Failed to initialize scoring: ${err}`);
      throw err;
    }
  }

  /**
   * Record an access to an entry. Increments access_count, updates
   * last_accessed, and checks for auto-promotion.
   */
  recordAccess(entryPath: string): EntryScore {
    this.init();
    if (!this.db) throw new Error('Scoring database not available');

    const now = new Date().toISOString();

    // Upsert: create if not exists, increment access_count
    this.db
      .prepare(
        `INSERT INTO entry_scores (entry_path, access_count, last_accessed, maturity)
         VALUES (?, 1, ?, 'candidate')
         ON CONFLICT(entry_path)
         DO UPDATE SET access_count = access_count + 1, last_accessed = excluded.last_accessed`,
      )
      .run(entryPath, now);

    // Check auto-promotion
    const score = this.db
      .prepare('SELECT * FROM entry_scores WHERE entry_path = ?')
      .get(entryPath) as EntryScore;

    for (const threshold of PROMOTION_THRESHOLDS) {
      if (score.maturity === threshold.from && score.access_count >= threshold.minAccess) {
        this.db
          .prepare('UPDATE entry_scores SET maturity = ? WHERE entry_path = ?')
          .run(threshold.to, entryPath);
        score.maturity = threshold.to;
      }
    }

    return score;
  }

  /**
   * Record access for multiple entry paths (e.g., from search results).
   */
  recordBulkAccess(entryPaths: string[]): void {
    this.init();
    if (!this.db || entryPaths.length === 0) return;

    const now = new Date().toISOString();

    const upsert = this.db.prepare(
      `INSERT INTO entry_scores (entry_path, access_count, last_accessed, maturity)
       VALUES (?, 1, ?, 'candidate')
       ON CONFLICT(entry_path)
       DO UPDATE SET access_count = access_count + 1, last_accessed = excluded.last_accessed`,
    );

    const checkPromotion = this.db.prepare(
      'SELECT entry_path, access_count, maturity FROM entry_scores WHERE entry_path = ?',
    );

    const promote = this.db.prepare('UPDATE entry_scores SET maturity = ? WHERE entry_path = ?');

    const transaction = this.db.transaction((paths: string[]) => {
      for (const p of paths) {
        upsert.run(p, now);
        const row = checkPromotion.get(p) as
          | { entry_path: string; access_count: number; maturity: string }
          | undefined;
        if (row) {
          for (const threshold of PROMOTION_THRESHOLDS) {
            if (row.maturity === threshold.from && row.access_count >= threshold.minAccess) {
              promote.run(threshold.to, p);
            }
          }
        }
      }
    });

    transaction(entryPaths);
  }

  /**
   * Get the score record for an entry. Returns null if no record exists.
   */
  getScore(entryPath: string): EntryScore | null {
    this.init();
    if (!this.db) return null;

    const row = this.db
      .prepare('SELECT * FROM entry_scores WHERE entry_path = ?')
      .get(entryPath) as EntryScore | undefined;

    return row ?? null;
  }

  /**
   * Get scores for multiple entries at once.
   */
  getScores(entryPaths: string[]): Map<string, EntryScore> {
    this.init();
    if (!this.db || entryPaths.length === 0) return new Map();

    const result = new Map<string, EntryScore>();
    const stmt = this.db.prepare('SELECT * FROM entry_scores WHERE entry_path = ?');

    for (const p of entryPaths) {
      const row = stmt.get(p) as EntryScore | undefined;
      if (row) {
        result.set(p, row);
      }
    }

    return result;
  }

  /** Close the database connection. */
  close(): void {
    try {
      this.db?.close();
    } catch (err) {
      console.error(`[knowledge] Failed to close scoring DB: ${err}`);
    } finally {
      this.db = null;
      this.initialized = false;
    }
  }
}

// ── Singleton instance ───────────────────────────────────────────────────────

let _scoringInstance: EntryScoring | null = null;

export function getEntryScoring(dbPath?: string): EntryScoring {
  if (!_scoringInstance) {
    _scoringInstance = new EntryScoring(dbPath);
  }
  return _scoringInstance;
}

/** Reset the singleton (for tests). */
export function resetEntryScoring(): void {
  if (_scoringInstance) {
    try {
      _scoringInstance.close();
    } catch {
      /* ignore */
    }
    _scoringInstance = null;
  }
}
