import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { godNodes, gaps, generateBrief, invalidateBriefCache } from '../src/knowledge/analyze.js';
import { getKnowledgeGraph, resetKnowledgeGraph } from '../src/knowledge/graph.js';

describe('analyze', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'knowledge-analyze-'));
    dbPath = join(tempDir, 'test-scores.db');

    resetKnowledgeGraph();
    getKnowledgeGraph(dbPath);

    for (const cat of ['projects', 'decisions', 'notes']) {
      mkdirSync(join(tempDir, cat), { recursive: true });
    }

    writeFileSync(
      join(tempDir, 'projects', 'alpha.md'),
      '---\ntitle: Alpha Project\ntags: [core]\nupdated: 2026-04-01\nconfidence: extracted\n---\n\n# Alpha\nCore project.',
    );
    writeFileSync(
      join(tempDir, 'projects', 'beta.md'),
      '---\ntitle: Beta Project\ntags: [auto-distilled]\nupdated: 2026-04-05\nconfidence: inferred\nconfidence_score: 0.7\n---\n\n# Beta\nAuto project.',
    );
    writeFileSync(
      join(tempDir, 'decisions', 'use-redis.md'),
      '---\ntitle: Use Redis for caching\ntags: [architecture]\nupdated: 2026-04-08\n---\n\n# Use Redis\nDecision: Redis for caching.',
    );
    writeFileSync(
      join(tempDir, 'notes', 'orphan.md'),
      '---\ntitle: Orphan Note\ntags: []\nupdated: 2026-03-01\n---\n\nNo connections.',
    );
  });

  afterEach(() => {
    resetKnowledgeGraph();
    invalidateBriefCache();
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  describe('godNodes', () => {
    it('returns empty array when no edges exist', () => {
      const result = godNodes(tempDir);
      expect(result).toEqual([]);
    });

    it('ranks entries by degree', () => {
      const graph = getKnowledgeGraph();
      graph.link('projects/alpha.md', 'projects/beta.md', 'related_to', 0.8);
      graph.link('projects/alpha.md', 'decisions/use-redis.md', 'depends_on', 0.9);
      graph.link('projects/alpha.md', 'notes/orphan.md', 'related_to', 0.5);

      const result = godNodes(tempDir);
      expect(result.length).toBeGreaterThan(0);
      expect(result[0].path).toBe('projects/alpha.md');
      expect(result[0].degree).toBe(3);
    });
  });

  describe('gaps', () => {
    it('finds entries with no edges', () => {
      const graph = getKnowledgeGraph();
      graph.link('projects/alpha.md', 'projects/beta.md', 'related_to', 0.8);

      const result = gaps(tempDir);
      const gapPaths = result.map((g) => g.path);
      expect(gapPaths).toContain('decisions/use-redis.md');
      expect(gapPaths).toContain('notes/orphan.md');
    });

    it('returns empty when all entries are connected', () => {
      const graph = getKnowledgeGraph();
      graph.link('projects/alpha.md', 'projects/beta.md', 'related_to', 0.8);
      graph.link('projects/alpha.md', 'decisions/use-redis.md', 'depends_on', 0.9);
      graph.link('decisions/use-redis.md', 'notes/orphan.md', 'related_to', 0.5);

      const result = gaps(tempDir);
      for (const g of result) {
        expect(g.degree).toBeLessThanOrEqual(1);
      }
    });
  });

  describe('generateBrief', () => {
    it('returns a brief with all fields', () => {
      const graph = getKnowledgeGraph();
      graph.link('projects/alpha.md', 'decisions/use-redis.md', 'depends_on', 0.9);
      invalidateBriefCache();

      const brief = generateBrief(tempDir);
      expect(brief.total_entries).toBeGreaterThan(0);
      expect(brief.total_edges).toBeGreaterThan(0);
      expect(brief.generated_at).toBeTruthy();
      expect(brief.text).toContain('Knowledge Base:');
    });

    it('returns cached brief on second call', () => {
      invalidateBriefCache();
      const brief1 = generateBrief(tempDir);
      const brief2 = generateBrief(tempDir);
      expect(brief1.generated_at).toBe(brief2.generated_at);
    });

    it('invalidates cache correctly', () => {
      invalidateBriefCache();
      const brief1 = generateBrief(tempDir);
      invalidateBriefCache();
      const brief2 = generateBrief(tempDir);
      expect(brief2.total_entries).toBe(brief1.total_entries);
    });
  });
});
