import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { QueryLog } from '../src/knowledge/query-log.js';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-query-log-test-'));
}

function cleanup(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

describe('QueryLog', () => {
  let tmpDir: string;
  let dbPath: string;
  let log: QueryLog;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    dbPath = path.join(tmpDir, 'test-query-log.db');
    log = new QueryLog(dbPath);
  });

  afterEach(() => {
    try {
      log.close();
    } catch {
      /* ignore */
    }
    cleanup(tmpDir);
  });

  describe('logQuery', () => {
    it('inserts a row with correct fields', () => {
      log.logQuery({ query: 'how to configure webpack', project: 'myapp', resultsCount: 3 });

      const gaps = log.getSearchGaps();
      // Non-zero-result queries never appear in search gaps; verify the
      // row exists by asking for zero-result rows on a fresh insert.
      expect(gaps).toHaveLength(0);

      log.logQuery({ query: 'kubernetes deployment strategies', resultsCount: 0 });
      const gapsAfter = log.getSearchGaps();
      expect(gapsAfter).toHaveLength(1);
      expect(gapsAfter[0].query).toBe('kubernetes deployment strategies');
      expect(gapsAfter[0].count).toBe(1);
      expect(gapsAfter[0].last_seen).toMatch(/^\d{4}-\d{2}-\d{2}/);
    });

    it('stores null project when omitted', () => {
      log.logQuery({ query: 'orphan query for probe', resultsCount: 0 });
      const gaps = log.getSearchGaps();
      expect(gaps).toHaveLength(1);
    });
  });

  describe('getSearchGaps', () => {
    it('returns only zero-result rows', () => {
      log.logQuery({ query: 'found something', resultsCount: 5 });
      log.logQuery({ query: 'nothing found here', resultsCount: 0 });
      log.logQuery({ query: 'another hit', resultsCount: 1 });
      log.logQuery({ query: 'also missing', resultsCount: 0 });

      const gaps = log.getSearchGaps();
      expect(gaps).toHaveLength(2);
      const queries = gaps.map((g) => g.query).sort();
      expect(queries).toEqual(['also missing', 'nothing found here']);
    });

    it('filters by since window', () => {
      log.logQuery({ query: 'ancient unknown query', resultsCount: 0 });
      // Far-future `since` excludes everything inserted before it.
      const future = new Date(Date.now() + 60_000).toISOString();
      const gaps = log.getSearchGaps({ since: future });
      expect(gaps).toHaveLength(0);

      const past = new Date(Date.now() - 60_000).toISOString();
      const gapsPast = log.getSearchGaps({ since: past });
      expect(gapsPast).toHaveLength(1);
    });

    it('merges similar queries into one group above the threshold', () => {
      log.logQuery({ query: 'gitlab credentials token personal', resultsCount: 0 });
      log.logQuery({ query: 'gitlab credentials token access', resultsCount: 0 });
      log.logQuery({ query: 'gitlab personal access token', resultsCount: 0 });

      const gaps = log.getSearchGaps({ groupSimilarity: 0.3 });
      expect(gaps).toHaveLength(1);
      expect(gaps[0].count).toBe(3);
      expect(gaps[0].similar_queries).toBeDefined();
      expect(gaps[0].similar_queries!.length).toBeGreaterThan(0);
    });

    it('keeps dissimilar queries as separate groups', () => {
      log.logQuery({ query: 'kubernetes deployment yaml', resultsCount: 0 });
      log.logQuery({ query: 'react hooks tutorial', resultsCount: 0 });

      const gaps = log.getSearchGaps({ groupSimilarity: 0.7 });
      expect(gaps).toHaveLength(2);
      for (const g of gaps) expect(g.count).toBe(1);
    });

    it('applies minCount filter after grouping', () => {
      log.logQuery({ query: 'singleton query one', resultsCount: 0 });
      log.logQuery({ query: 'repeated query alpha beta', resultsCount: 0 });
      log.logQuery({ query: 'repeated query alpha gamma', resultsCount: 0 });

      const gaps = log.getSearchGaps({ groupSimilarity: 0.3, minCount: 2 });
      expect(gaps).toHaveLength(1);
      expect(gaps[0].count).toBe(2);
    });

    it('excludes non-zero-result queries even when similar to a zero-result one', () => {
      log.logQuery({ query: 'webpack config example', resultsCount: 4 });
      log.logQuery({ query: 'webpack config example', resultsCount: 2 });
      const gaps = log.getSearchGaps();
      expect(gaps).toHaveLength(0);
    });
  });

  describe('scrubbing', () => {
    it('redacts secrets before storing the query text', () => {
      const secret = 'sk-' + 'a'.repeat(40);
      log.logQuery({ query: `please find ${secret} in our configs`, resultsCount: 0 });

      const gaps = log.getSearchGaps();
      expect(gaps).toHaveLength(1);
      expect(gaps[0].query).not.toContain(secret);
      expect(gaps[0].query).toContain('[REDACTED_API_KEY]');
    });
  });
});
