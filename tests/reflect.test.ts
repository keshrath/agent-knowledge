import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-reflect-test-'));
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function writeEntry(dir: string, relPath: string, content: string): void {
  const fullPath = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf-8');
}

function makeEntry(title: string, tags: string[], body: string): string {
  return `---\ntitle: ${title}\ntags: [${tags.join(', ')}]\nupdated: 2025-01-01\n---\n${body}`;
}

// Mock the graph module so we control what getKnowledgeGraph returns
vi.mock('../src/knowledge/graph.js', () => {
  let mockEdges: Array<{
    source: string;
    target: string;
    rel_type: string;
    strength: number;
    created_at: string;
  }> = [];

  return {
    getKnowledgeGraph: () => ({
      links: () => mockEdges,
    }),
    RELATIONSHIP_TYPES: [
      'related_to',
      'supersedes',
      'depends_on',
      'contradicts',
      'specializes',
      'part_of',
      'alternative_to',
      'builds_on',
    ],
    __setMockEdges: (
      edges: Array<{
        source: string;
        target: string;
        rel_type: string;
        strength: number;
        created_at: string;
      }>,
    ) => {
      mockEdges = edges;
    },
    __clearMockEdges: () => {
      mockEdges = [];
    },
  };
});

import { reflect } from '../src/knowledge/reflect.js';

// Helper to access the mock control functions
async function setMockEdges(
  edges: Array<{
    source: string;
    target: string;
    rel_type: string;
    strength: number;
    created_at: string;
  }>,
): Promise<void> {
  const mod = await import('../src/knowledge/graph.js');
  (mod as unknown as { __setMockEdges: typeof setMockEdges }).__setMockEdges(edges);
}

async function clearMockEdges(): Promise<void> {
  const mod = await import('../src/knowledge/graph.js');
  (mod as unknown as { __clearMockEdges: () => void }).__clearMockEdges();
}

describe('reflect', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = makeTmpDir();
    await clearMockEdges();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  it('returns entries with no graph edges as unconnected', async () => {
    writeEntry(
      tmpDir,
      'projects/alpha.md',
      makeEntry('Alpha Project', ['dev'], 'Alpha is a web framework for building APIs.'),
    );
    writeEntry(
      tmpDir,
      'projects/beta.md',
      makeEntry('Beta Project', ['dev'], 'Beta is a testing library for integration tests.'),
    );

    // No edges — all entries should be unconnected
    const result = reflect(tmpDir);
    expect(result.totalEntries).toBe(2);
    expect(result.unconnectedEntries.length).toBe(2);
    expect(result.connectedCount).toBe(0);
    const paths = result.unconnectedEntries.map((e) => e.path);
    expect(paths).toContain('projects/alpha.md');
    expect(paths).toContain('projects/beta.md');
  });

  it('excludes entries with edges from unconnected list', async () => {
    writeEntry(
      tmpDir,
      'projects/alpha.md',
      makeEntry('Alpha Project', ['dev'], 'Alpha is a web framework.'),
    );
    writeEntry(
      tmpDir,
      'projects/beta.md',
      makeEntry('Beta Project', ['dev'], 'Beta is a testing library.'),
    );
    writeEntry(
      tmpDir,
      'projects/gamma.md',
      makeEntry('Gamma Project', ['dev'], 'Gamma is a database driver.'),
    );

    // Alpha and Beta are connected via an edge; Gamma is not
    await setMockEdges([
      {
        source: 'projects/alpha.md',
        target: 'projects/beta.md',
        rel_type: 'related_to',
        strength: 0.7,
        created_at: '2025-01-01',
      },
    ]);

    const result = reflect(tmpDir);
    expect(result.totalEntries).toBe(3);
    expect(result.connectedCount).toBe(2);
    expect(result.unconnectedEntries.length).toBe(1);
    expect(result.unconnectedEntries[0].path).toBe('projects/gamma.md');
  });

  it('returns structured prompt with entry summaries', async () => {
    writeEntry(
      tmpDir,
      'notes/design.md',
      makeEntry(
        'Design Patterns',
        ['architecture'],
        'Singleton, factory, observer patterns in OOP.',
      ),
    );

    const result = reflect(tmpDir);
    expect(result.prompt).toContain('Knowledge Graph Reflection');
    expect(result.prompt).toContain('Unconnected Entries');
    expect(result.prompt).toContain('notes/design.md');
    expect(result.prompt).toContain('Design Patterns');
    expect(result.prompt).toContain('Singleton');
    expect(result.instructions).toContain('`knowledge_graph` with action "link"');
  });

  it('filters by category', async () => {
    writeEntry(
      tmpDir,
      'projects/proj1.md',
      makeEntry('Project One', ['dev'], 'A development project.'),
    );
    writeEntry(tmpDir, 'notes/note1.md', makeEntry('Note One', ['misc'], 'A miscellaneous note.'));

    const result = reflect(tmpDir, 'projects');
    expect(result.totalEntries).toBe(1);
    expect(result.unconnectedEntries.length).toBe(1);
    expect(result.unconnectedEntries[0].path).toBe('projects/proj1.md');
  });

  it('respects max_entries parameter', async () => {
    for (let i = 1; i <= 5; i++) {
      writeEntry(
        tmpDir,
        `notes/entry${i}.md`,
        makeEntry(`Entry ${i}`, ['test'], `Content for entry number ${i}.`),
      );
    }

    const result = reflect(tmpDir, undefined, 2);
    expect(result.totalEntries).toBe(5);
    expect(result.unconnectedEntries.length).toBe(2);
  });

  it('returns empty result for empty knowledge base', async () => {
    const result = reflect(tmpDir);
    expect(result.totalEntries).toBe(0);
    expect(result.unconnectedEntries).toEqual([]);
    expect(result.connectedCount).toBe(0);
    expect(result.prompt).toContain('All knowledge entries are connected');
  });
});
