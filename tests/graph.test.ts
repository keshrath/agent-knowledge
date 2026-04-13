import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  KnowledgeGraph,
  RELATIONSHIP_TYPES,
  isEdgeValidAt,
  type RelationshipType,
} from '../src/knowledge/graph.js';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-graph-test-'));
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe('KnowledgeGraph', () => {
  let tmpDir: string;
  let dbPath: string;
  let graph: KnowledgeGraph;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    dbPath = path.join(tmpDir, 'test-graph.db');
    graph = new KnowledgeGraph(dbPath);
  });

  afterEach(() => {
    try {
      graph.close();
    } catch {
      /* ignore */
    }
    cleanup(tmpDir);
  });

  describe('link', () => {
    it('creates an edge between two entries', () => {
      const edge = graph.link('projects/a.md', 'projects/b.md', 'related_to');
      expect(edge.source).toBe('projects/a.md');
      expect(edge.target).toBe('projects/b.md');
      expect(edge.rel_type).toBe('related_to');
      expect(edge.strength).toBe(0.5);
    });

    it('updates strength on duplicate edge', () => {
      graph.link('projects/a.md', 'projects/b.md', 'related_to', 0.3);
      const edge = graph.link('projects/a.md', 'projects/b.md', 'related_to', 0.9);
      expect(edge.strength).toBe(0.9);
    });

    it('allows multiple rel types between same entries', () => {
      graph.link('a.md', 'b.md', 'related_to');
      graph.link('a.md', 'b.md', 'depends_on');
      const edges = graph.links('a.md');
      expect(edges.length).toBe(2);
    });

    it('rejects self-referencing edge', () => {
      expect(() => graph.link('a.md', 'a.md', 'related_to')).toThrow('self-referencing');
    });

    it('rejects invalid strength', () => {
      expect(() => graph.link('a.md', 'b.md', 'related_to', 1.5)).toThrow('between 0 and 1');
      expect(() => graph.link('a.md', 'b.md', 'related_to', -0.1)).toThrow('between 0 and 1');
    });

    it('accepts custom strength', () => {
      const edge = graph.link('a.md', 'b.md', 'supersedes', 0.8);
      expect(edge.strength).toBe(0.8);
    });
  });

  describe('unlink', () => {
    it('removes a specific edge', () => {
      graph.link('a.md', 'b.md', 'related_to');
      const removed = graph.unlink('a.md', 'b.md', 'related_to');
      expect(removed).toBe(1);
      expect(graph.links('a.md').length).toBe(0);
    });

    it('removes all edges when rel_type omitted', () => {
      graph.link('a.md', 'b.md', 'related_to');
      graph.link('a.md', 'b.md', 'depends_on');
      const removed = graph.unlink('a.md', 'b.md');
      expect(removed).toBe(2);
    });

    it('returns 0 when no matching edge', () => {
      const removed = graph.unlink('a.md', 'b.md', 'related_to');
      expect(removed).toBe(0);
    });
  });

  describe('links', () => {
    it('returns all edges when no filter', () => {
      graph.link('a.md', 'b.md', 'related_to');
      graph.link('c.md', 'd.md', 'depends_on');
      const edges = graph.links();
      expect(edges.length).toBe(2);
    });

    it('filters by entry', () => {
      graph.link('a.md', 'b.md', 'related_to');
      graph.link('c.md', 'd.md', 'depends_on');
      const edges = graph.links('a.md');
      expect(edges.length).toBe(1);
    });

    it('finds entry as both source and target', () => {
      graph.link('a.md', 'b.md', 'related_to');
      graph.link('c.md', 'a.md', 'depends_on');
      const edges = graph.links('a.md');
      expect(edges.length).toBe(2);
    });

    it('filters by rel_type', () => {
      graph.link('a.md', 'b.md', 'related_to');
      graph.link('a.md', 'c.md', 'depends_on');
      const edges = graph.links(undefined, 'depends_on');
      expect(edges.length).toBe(1);
    });

    it('filters by both entry and rel_type', () => {
      graph.link('a.md', 'b.md', 'related_to');
      graph.link('a.md', 'c.md', 'depends_on');
      graph.link('d.md', 'e.md', 'depends_on');
      const edges = graph.links('a.md', 'depends_on');
      expect(edges.length).toBe(1);
    });
  });

  describe('graph (BFS)', () => {
    it('returns starting node when no edges', () => {
      const result = graph.graph('a.md');
      expect(result.nodes.length).toBe(1);
      expect(result.nodes[0]).toEqual({ path: 'a.md', depth: 0 });
      expect(result.edges.length).toBe(0);
    });

    it('traverses 1 hop', () => {
      graph.link('a.md', 'b.md', 'related_to');
      graph.link('b.md', 'c.md', 'depends_on');
      const result = graph.graph('a.md', 1);
      expect(result.nodes.length).toBe(2);
      expect(result.edges.length).toBe(1);
    });

    it('traverses 2 hops (default)', () => {
      graph.link('a.md', 'b.md', 'related_to');
      graph.link('b.md', 'c.md', 'depends_on');
      graph.link('c.md', 'd.md', 'supersedes');
      const result = graph.graph('a.md');
      expect(result.nodes.length).toBe(3);
      expect(result.edges.length).toBe(2);
    });

    it('does not revisit nodes', () => {
      graph.link('a.md', 'b.md', 'related_to');
      graph.link('b.md', 'a.md', 'depends_on');
      const result = graph.graph('a.md', 3);
      expect(result.nodes.length).toBe(2);
    });

    it('terminates on cycle A→B→C→A', () => {
      graph.link('a.md', 'b.md', 'related_to');
      graph.link('b.md', 'c.md', 'depends_on');
      graph.link('c.md', 'a.md', 'builds_on');
      const result = graph.graph('a.md', 10);
      expect(result.nodes.length).toBe(3);
      expect(result.edges.length).toBe(3);
      const nodePaths = result.nodes.map((n) => n.path).sort();
      expect(nodePaths).toEqual(['a.md', 'b.md', 'c.md']);
    });
  });

  describe('getRelated', () => {
    it('returns 1-hop connected entries', () => {
      graph.link('a.md', 'b.md', 'related_to', 0.8);
      graph.link('c.md', 'a.md', 'depends_on', 0.6);
      const related = graph.getRelated('a.md');
      expect(related.length).toBe(2);
    });

    it('returns empty for unconnected entry', () => {
      const related = graph.getRelated('isolated.md');
      expect(related).toEqual([]);
    });
  });

  describe('RELATIONSHIP_TYPES', () => {
    it('contains all expected types including code structure', () => {
      expect(RELATIONSHIP_TYPES.length).toBe(11);
      expect(RELATIONSHIP_TYPES).toContain('calls');
      expect(RELATIONSHIP_TYPES).toContain('imports');
      expect(RELATIONSHIP_TYPES).toContain('inherits');
    });
  });

  describe('directed traversal', () => {
    it('outbound follows source→target only', () => {
      graph.link('a.md', 'b.md', 'calls');
      graph.link('c.md', 'a.md', 'calls');
      const result = graph.graph('a.md', 5, undefined, 'outbound');
      const paths = result.nodes.map((n) => n.path).sort();
      expect(paths).toEqual(['a.md', 'b.md']); // c.md not reached (inbound edge)
    });

    it('inbound follows target→source only', () => {
      graph.link('a.md', 'b.md', 'calls');
      graph.link('c.md', 'a.md', 'calls');
      const result = graph.graph('a.md', 5, undefined, 'inbound');
      const paths = result.nodes.map((n) => n.path).sort();
      expect(paths).toEqual(['a.md', 'c.md']); // b.md not reached (outbound edge)
    });

    it('both follows edges in either direction (default)', () => {
      graph.link('a.md', 'b.md', 'calls');
      graph.link('c.md', 'a.md', 'calls');
      const result = graph.graph('a.md', 5);
      expect(result.nodes.length).toBe(3);
    });

    it('multi-hop directed traversal', () => {
      graph.link('a.md', 'b.md', 'calls');
      graph.link('b.md', 'c.md', 'calls');
      graph.link('c.md', 'd.md', 'calls');
      const result = graph.graph('a.md', 3, undefined, 'outbound');
      const paths = result.nodes.map((n) => n.path).sort();
      expect(paths).toEqual(['a.md', 'b.md', 'c.md', 'd.md']);
    });

    it('inbound multi-hop (impact analysis: who depends on me?)', () => {
      graph.link('a.md', 'c.md', 'calls');
      graph.link('b.md', 'c.md', 'calls');
      graph.link('d.md', 'a.md', 'calls');
      const result = graph.graph('c.md', 3, undefined, 'inbound');
      const paths = result.nodes.map((n) => n.path).sort();
      expect(paths).toEqual(['a.md', 'b.md', 'c.md', 'd.md']);
    });
  });

  describe('rel_type filter on traverse', () => {
    it('filters edges by rel_type during traversal', () => {
      graph.link('a.md', 'b.md', 'calls');
      graph.link('a.md', 'c.md', 'related_to');
      const result = graph.graph('a.md', 5, undefined, 'both', 'calls');
      const paths = result.nodes.map((n) => n.path).sort();
      expect(paths).toEqual(['a.md', 'b.md']); // c.md not reached (wrong rel_type)
    });

    it('combines direction and rel_type filter', () => {
      graph.link('a.md', 'b.md', 'calls');
      graph.link('c.md', 'a.md', 'calls');
      graph.link('a.md', 'd.md', 'imports');
      const result = graph.graph('a.md', 5, undefined, 'outbound', 'calls');
      const paths = result.nodes.map((n) => n.path).sort();
      expect(paths).toEqual(['a.md', 'b.md']); // c.md (inbound) and d.md (wrong type) excluded
    });
  });

  describe('bulkLink', () => {
    it('creates multiple edges in a transaction', () => {
      const count = graph.bulkLink([
        { source: 'a.md', target: 'b.md', rel_type: 'calls' },
        { source: 'b.md', target: 'c.md', rel_type: 'calls' },
        { source: 'a.md', target: 'c.md', rel_type: 'imports' },
      ]);
      expect(count).toBe(3);
      expect(graph.links().length).toBe(3);
    });

    it('skips self-referencing edges', () => {
      const count = graph.bulkLink([
        { source: 'a.md', target: 'a.md', rel_type: 'calls' },
        { source: 'a.md', target: 'b.md', rel_type: 'calls' },
      ]);
      expect(count).toBe(1);
    });

    it('skips invalid rel_types', () => {
      const count = graph.bulkLink([
        { source: 'a.md', target: 'b.md', rel_type: 'invalid' as unknown as RelationshipType },
        { source: 'a.md', target: 'c.md', rel_type: 'calls' },
      ]);
      expect(count).toBe(1);
    });

    it('uses tree-sitter as default origin', () => {
      graph.bulkLink([{ source: 'a.md', target: 'b.md', rel_type: 'calls' }]);
      const edges = graph.links('a.md');
      expect(edges[0].origin).toBe('tree-sitter');
    });

    it('allows custom origin', () => {
      graph.bulkLink([{ source: 'a.md', target: 'b.md', rel_type: 'calls', origin: 'custom' }]);
      const edges = graph.links('a.md');
      expect(edges[0].origin).toBe('custom');
    });

    it('handles empty array', () => {
      const count = graph.bulkLink([]);
      expect(count).toBe(0);
    });
  });

  describe('unlinkByOrigin', () => {
    it('deletes all edges with matching origin', () => {
      graph.bulkLink([
        { source: 'a.md', target: 'b.md', rel_type: 'calls' },
        { source: 'b.md', target: 'c.md', rel_type: 'imports' },
      ]);
      graph.link('a.md', 'c.md', 'related_to'); // default origin: 'manual'
      expect(graph.links().length).toBe(3);
      const removed = graph.unlinkByOrigin('tree-sitter');
      expect(removed).toBe(2);
      expect(graph.links().length).toBe(1);
      expect(graph.links()[0].rel_type).toBe('related_to');
    });

    it('returns 0 when no matching origin', () => {
      graph.link('a.md', 'b.md', 'related_to');
      const removed = graph.unlinkByOrigin('tree-sitter');
      expect(removed).toBe(0);
    });
  });

  describe('temporal validity', () => {
    it('stores valid_from / valid_to on link', () => {
      const edge = graph.link('a.md', 'b.md', 'related_to', 0.5, '2025-01-01', '2025-12-31');
      expect(edge.valid_from).toBe('2025-01-01');
      expect(edge.valid_to).toBe('2025-12-31');
    });

    it('defaults valid_from / valid_to to null when omitted', () => {
      const edge = graph.link('a.md', 'b.md', 'related_to');
      expect(edge.valid_from).toBeNull();
      expect(edge.valid_to).toBeNull();
    });

    it('isEdgeValidAt: open-ended edge is valid at any date with explicit asOf', () => {
      const edge = graph.link('a.md', 'b.md', 'related_to');
      expect(isEdgeValidAt(edge, '2026-04-08')).toBe(true);
    });

    it('isEdgeValidAt: filters by valid_from window', () => {
      const edge = graph.link('a.md', 'b.md', 'related_to', 0.5, '2025-06-01', null);
      expect(isEdgeValidAt(edge, '2025-05-01')).toBe(false);
      expect(isEdgeValidAt(edge, '2025-07-01')).toBe(true);
    });

    it('isEdgeValidAt: filters by valid_to window', () => {
      const edge = graph.link('a.md', 'b.md', 'related_to', 0.5, null, '2025-06-30');
      expect(isEdgeValidAt(edge, '2025-05-01')).toBe(true);
      expect(isEdgeValidAt(edge, '2025-07-01')).toBe(false);
    });

    it('links() filters by as_of', () => {
      graph.link('a.md', 'b.md', 'related_to', 0.5, '2025-01-01', '2025-06-30');
      graph.link('a.md', 'c.md', 'related_to', 0.5, '2025-07-01', null);
      const inJune = graph.links('a.md', undefined, '2025-06-15');
      expect(inJune.length).toBe(1);
      expect(inJune[0].target).toBe('b.md');
      const inAug = graph.links('a.md', undefined, '2025-08-15');
      expect(inAug.length).toBe(1);
      expect(inAug[0].target).toBe('c.md');
    });

    it('graph() respects as_of when traversing', () => {
      graph.link('a.md', 'b.md', 'related_to', 0.5, '2025-01-01', '2025-06-30');
      graph.link('b.md', 'c.md', 'depends_on', 0.5, '2025-07-01', null);
      const inJune = graph.graph('a.md', 5, '2025-06-15');
      expect(inJune.nodes.map((n) => n.path).sort()).toEqual(['a.md', 'b.md']);
      const inAug = graph.graph('a.md', 5, '2025-08-15');
      expect(inAug.nodes.length).toBe(1); // a.md cannot reach b.md (first edge expired)
    });

    it('invalidate() sets valid_to on a specific edge', () => {
      graph.link('a.md', 'b.md', 'related_to');
      const updated = graph.invalidate('a.md', 'b.md', 'related_to', '2026-01-01');
      expect(updated).toBe(1);
      const edges = graph.links('a.md');
      expect(edges[0].valid_to).toBe('2026-01-01');
    });

    it('invalidate() with no rel_type marks all edges between pair', () => {
      graph.link('a.md', 'b.md', 'related_to');
      graph.link('a.md', 'b.md', 'depends_on');
      const updated = graph.invalidate('a.md', 'b.md', undefined, '2026-01-01');
      expect(updated).toBe(2);
    });
  });
});
