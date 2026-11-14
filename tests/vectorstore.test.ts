import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { VectorStore } from '../src/vectorstore/store.js';
import type { VectorEntry } from '../src/vectorstore/store.js';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-vecstore-test-'));
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function makeEntry(overrides: Partial<VectorEntry> = {}): VectorEntry {
  return {
    id: overrides.id ?? 'entry-1',
    source: overrides.source ?? 'knowledge',
    sourceId: overrides.sourceId ?? 'doc-1',
    chunkIndex: overrides.chunkIndex ?? 0,
    chunkText: overrides.chunkText ?? 'test chunk text',
    provider: overrides.provider ?? 'test-provider',
    dimensions: overrides.dimensions ?? 4,
    embedding: overrides.embedding ?? [0.1, 0.2, 0.3, 0.4],
    metadata: overrides.metadata,
  };
}

describe('VectorStore', () => {
  let tmpDir: string;
  let dbPath: string;
  let store: VectorStore;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    dbPath = path.join(tmpDir, 'test-vectors.db');
    store = new VectorStore(dbPath);
  });

  afterEach(() => {
    try {
      store.close();
    } catch {
      /* ignore */
    }
    cleanup(tmpDir);
  });

  it('creates DB file on first operation', () => {
    store.setProvider('test-provider', 4);
    expect(fs.existsSync(dbPath)).toBe(true);
  });

  it('setProvider stores provider name and dimensions in meta', () => {
    store.setProvider('test-provider', 4);
    const stats = store.stats();
    expect(stats.provider).toBe('test-provider');
    expect(stats.dimensions).toBe(4);
  });

  it('setProvider with different provider wipes existing data and returns true', () => {
    store.setProvider('provider-a', 4);
    store.upsert([makeEntry({ provider: 'provider-a' })]);
    expect(store.stats().totalEntries).toBe(1);

    const wiped = store.setProvider('provider-b', 8);
    expect(wiped).toBe(true);
    expect(store.stats().totalEntries).toBe(0);
    expect(store.stats().provider).toBe('provider-b');
  });

  it('setProvider with same provider returns false (no wipe)', () => {
    store.setProvider('provider-a', 4);
    store.upsert([makeEntry({ provider: 'provider-a' })]);

    const wiped = store.setProvider('provider-a', 4);
    expect(wiped).toBe(false);
    expect(store.stats().totalEntries).toBe(1);
  });

  it('upsert stores entries and hasEmbeddings returns true', () => {
    store.setProvider('test-provider', 4);
    store.upsert([makeEntry()]);
    expect(store.hasEmbeddings('doc-1')).toBe(true);
  });

  it('upsert with empty array does nothing', () => {
    store.setProvider('test-provider', 4);
    store.upsert([]);
    expect(store.stats().totalEntries).toBe(0);
  });

  it('upsert replaces existing entries for same sourceId', () => {
    store.setProvider('test-provider', 4);
    store.upsert([
      makeEntry({ id: 'e1', sourceId: 'doc-1', chunkIndex: 0 }),
      makeEntry({ id: 'e2', sourceId: 'doc-1', chunkIndex: 1 }),
    ]);
    expect(store.stats().totalEntries).toBe(2);

    store.upsert([
      makeEntry({ id: 'e3', sourceId: 'doc-1', chunkIndex: 0, chunkText: 'new text' }),
    ]);
    expect(store.stats().totalEntries).toBe(1);
  });

  it('hasEmbeddings returns false for unknown sourceId', () => {
    store.setProvider('test-provider', 4);
    expect(store.hasEmbeddings('nonexistent')).toBe(false);
  });

  it('deleteBySource removes entries', () => {
    store.setProvider('test-provider', 4);
    store.upsert([
      makeEntry({ id: 'e1', sourceId: 'doc-1' }),
      makeEntry({ id: 'e2', sourceId: 'doc-2' }),
    ]);
    expect(store.stats().totalEntries).toBe(2);

    store.deleteBySource('doc-1');
    expect(store.hasEmbeddings('doc-1')).toBe(false);
    expect(store.hasEmbeddings('doc-2')).toBe(true);
    expect(store.stats().totalEntries).toBe(1);
  });

  it('deleteBySource with nonexistent source does not throw', () => {
    store.setProvider('test-provider', 4);
    expect(() => store.deleteBySource('nonexistent')).not.toThrow();
  });

  it('stats returns correct counts by source type', () => {
    store.setProvider('test-provider', 4);
    store.upsert([
      makeEntry({ id: 'k1', source: 'knowledge', sourceId: 'know-1' }),
      makeEntry({ id: 'k2', source: 'knowledge', sourceId: 'know-2' }),
      makeEntry({ id: 's1', source: 'session', sourceId: 'sess-1' }),
    ]);

    const stats = store.stats();
    expect(stats.totalEntries).toBe(3);
    expect(stats.knowledgeEntries).toBe(2);
    expect(stats.sessionEntries).toBe(1);
    expect(stats.dbSizeMB).toBeGreaterThanOrEqual(0);
  });

  it('wipe clears everything', () => {
    store.setProvider('test-provider', 4);
    store.upsert([
      makeEntry({ id: 'e1', sourceId: 'doc-1' }),
      makeEntry({ id: 'e2', sourceId: 'doc-2' }),
    ]);
    expect(store.stats().totalEntries).toBe(2);

    store.wipe();
    expect(store.stats().totalEntries).toBe(0);
  });

  it('close does not throw', () => {
    store.setProvider('test-provider', 4);
    expect(() => store.close()).not.toThrow();
  });

  it('close can be called multiple times', () => {
    store.setProvider('test-provider', 4);
    store.close();
    expect(() => store.close()).not.toThrow();
  });

  // ── Vector search tests (skip if sqlite-vec unavailable) ─────────────

  describe('vector search', () => {
    let vecAvailable: boolean;

    beforeEach(() => {
      store.setProvider('test-provider', 4);
      try {
        store.upsert([makeEntry()]);
        const results = store.search([0.1, 0.2, 0.3, 0.4], 5);
        vecAvailable = results.length > 0;
      } catch {
        vecAvailable = false;
      }
    });

    it('search returns results when vec extension is available', () => {
      if (!vecAvailable) {
        console.warn('Skipping: sqlite-vec not available');
        return;
      }
      store.upsert([makeEntry()]);
      const results = store.search([0.1, 0.2, 0.3, 0.4], 5);
      expect(results.length).toBe(1);
      expect(results[0].sourceId).toBe('doc-1');
      expect(results[0].score).toBeGreaterThan(0);
    });

    it('searchBySource filters by source type', () => {
      if (!vecAvailable) {
        console.warn('Skipping: sqlite-vec not available');
        return;
      }
      store.upsert([
        makeEntry({ id: 'k1', source: 'knowledge', sourceId: 'know-1' }),
        makeEntry({ id: 's1', source: 'session', sourceId: 'sess-1' }),
      ]);
      const knowledgeResults = store.searchBySource([0.1, 0.2, 0.3, 0.4], 'knowledge', 5);
      expect(knowledgeResults.every((r) => r.source === 'knowledge')).toBe(true);
    });

    it('search returns empty array when no data exists', () => {
      if (!vecAvailable) {
        console.warn('Skipping: sqlite-vec not available');
        return;
      }
      store.wipe();
      store.setProvider('test-provider', 4);
      const results = store.search([0.1, 0.2, 0.3, 0.4], 5);
      expect(results).toEqual([]);
    });
  });

  it('knowledgeVectors: every knowledge chunk by entry, again only once they changed', () => {
    store.setProvider('test-provider', 4);
    store.upsert([
      makeEntry({ id: 'a0', sourceId: 'notes/a.md', chunkIndex: 0, embedding: [1, 0, 0, 0] }),
      makeEntry({ id: 'a1', sourceId: 'notes/a.md', chunkIndex: 1, embedding: [0, 1, 0, 0] }),
      makeEntry({ id: 'b0', sourceId: 'notes/b.md', embedding: [0, 0, 1, 0] }),
      makeEntry({ id: 's0', source: 'session', sourceId: 'sess-1', embedding: [0, 0, 0, 1] }),
    ]);
    const first = store.knowledgeVectors('test-provider', 4)!;
    expect([...first.vectors.keys()].sort()).toEqual(['notes/a.md', 'notes/b.md']);
    expect(first.vectors.get('notes/a.md')!.map((v) => [...v])).toEqual([
      [1, 0, 0, 0],
      [0, 1, 0, 0],
    ]);
    expect(store.knowledgeVectors('test-provider', 4, first.stamp)).toBeNull();
    expect(store.knowledgeVectors('another-provider', 4)!.vectors.size).toBe(0);
    store.upsert([makeEntry({ id: 'b0', sourceId: 'notes/b.md', embedding: [0, 0, 0.5, 0.5] })]);
    const next = store.knowledgeVectors('test-provider', 4, first.stamp)!;
    expect([...next.vectors.get('notes/b.md')![0]!]).toEqual([0, 0, 0.5, 0.5]);
  });
});
