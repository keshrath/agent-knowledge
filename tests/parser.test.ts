import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  parseSessionFile,
  extractMessages,
  getSessionMeta,
  getSessionFiles,
  getProjectDirs,
} from '../src/sessions/parser.js';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-parser-test-'));
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function writeJsonl(filePath: string, entries: object[]): void {
  fs.writeFileSync(filePath, entries.map((e) => JSON.stringify(e)).join('\n'));
}

describe('parseSessionFile', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });
  afterEach(() => {
    cleanup(tmpDir);
  });

  it('parses valid JSONL file', () => {
    const file = path.join(tmpDir, 'session.jsonl');
    writeJsonl(file, [
      {
        type: 'user',
        timestamp: '2026-01-01T00:00:00Z',
        message: { role: 'user', content: 'Hello' },
      },
      {
        type: 'assistant',
        timestamp: '2026-01-01T00:00:01Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Hi' }] },
      },
    ]);
    const entries = parseSessionFile(file);
    expect(entries.length).toBe(2);
    expect(entries[0].type).toBe('user');
    expect(entries[1].type).toBe('assistant');
  });

  it('returns empty array for non-existent file', () => {
    expect(parseSessionFile(path.join(tmpDir, 'nope.jsonl'))).toEqual([]);
  });

  it('skips malformed JSON lines', () => {
    const file = path.join(tmpDir, 'bad.jsonl');
    const good1 = JSON.stringify({ type: 'user', message: { content: 'ok' } });
    const good2 = JSON.stringify({ type: 'assistant', message: { content: 'hi' } });
    fs.writeFileSync(file, good1 + '\nnot json\n' + good2);
    expect(parseSessionFile(file).length).toBe(2);
  });

  it('handles empty file', () => {
    const file = path.join(tmpDir, 'empty.jsonl');
    fs.writeFileSync(file, '');
    expect(parseSessionFile(file)).toEqual([]);
  });

  it('handles file with only whitespace lines', () => {
    const file = path.join(tmpDir, 'ws.jsonl');
    fs.writeFileSync(file, '  \n  \n  \n');
    expect(parseSessionFile(file)).toEqual([]);
  });
});

describe('extractMessages', () => {
  it('extracts user messages with string content', () => {
    const entries = [
      {
        type: 'user',
        timestamp: '2026-01-01T00:00:00Z',
        message: { role: 'user', content: 'Hello world' },
      },
    ];
    const msgs = extractMessages(entries);
    expect(msgs.length).toBe(1);
    expect(msgs[0].role).toBe('user');
    expect(msgs[0].content).toBe('Hello world');
    expect(msgs[0].timestamp).toBe('2026-01-01T00:00:00Z');
  });

  it('extracts user messages with object content (JSON stringified)', () => {
    const entries = [
      {
        type: 'user',
        timestamp: '2026-01-01T00:00:00Z',
        message: { role: 'user', content: { text: 'complex' } },
      },
    ];
    const msgs = extractMessages(entries);
    expect(msgs.length).toBe(1);
    expect(msgs[0].content).toContain('complex');
  });

  it('extracts assistant text parts', () => {
    const entries = [
      {
        type: 'assistant',
        timestamp: '2026-01-01T00:00:01Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Part A.' },
            { type: 'text', text: 'Part B.' },
          ],
        },
      },
    ];
    const msgs = extractMessages(entries);
    expect(msgs.length).toBe(1);
    expect(msgs[0].content).toContain('Part A.');
    expect(msgs[0].content).toContain('Part B.');
  });

  it('skips assistant entries with no text parts', () => {
    const entries = [
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', name: 'read' }] },
      },
    ];
    expect(extractMessages(entries).length).toBe(0);
  });

  it('truncates tool_use content to 500 chars', () => {
    const entries = [{ type: 'tool_use', content: 'x'.repeat(1000) }];
    const msgs = extractMessages(entries);
    expect(msgs.length).toBe(1);
    expect(msgs[0].content.length).toBe(500);
  });

  it('truncates tool_result content to 500 chars', () => {
    const entries = [{ type: 'tool_result', message: { content: 'y'.repeat(1000) } }];
    const msgs = extractMessages(entries);
    expect(msgs.length).toBe(1);
    expect(msgs[0].content.length).toBe(500);
  });

  it('uses null for missing timestamp', () => {
    const entries = [{ type: 'user', message: { role: 'user', content: 'no ts' } }];
    const msgs = extractMessages(entries);
    expect(msgs[0].timestamp).toBeNull();
  });

  it('returns empty array for empty input', () => {
    expect(extractMessages([])).toEqual([]);
  });

  it('ignores unknown entry types', () => {
    const entries = [{ type: 'unknown', message: { content: 'ignored' } }];
    expect(extractMessages(entries).length).toBe(0);
  });

  // ── Cursor Composer format (role instead of type) ──

  it('extracts user messages using role field (Cursor format)', () => {
    const entries = [
      {
        role: 'user',
        timestamp: '2026-01-01T00:00:00Z',
        message: { content: [{ type: 'text', text: 'Hello from Cursor' }] },
      },
    ];
    const msgs = extractMessages(entries);
    expect(msgs.length).toBe(1);
    expect(msgs[0].role).toBe('user');
    expect(msgs[0].content).toBe('Hello from Cursor');
  });

  it('extracts assistant messages using role field (Cursor format)', () => {
    const entries = [
      {
        role: 'assistant',
        timestamp: '2026-01-01T00:00:01Z',
        message: { content: [{ type: 'text', text: 'Hi back' }] },
      },
    ];
    const msgs = extractMessages(entries);
    expect(msgs.length).toBe(1);
    expect(msgs[0].role).toBe('assistant');
    expect(msgs[0].content).toBe('Hi back');
  });

  it('handles Cursor user messages with multiple text parts', () => {
    const entries = [
      {
        role: 'user',
        timestamp: '2026-01-01T00:00:00Z',
        message: {
          content: [
            { type: 'text', text: 'Part 1' },
            { type: 'text', text: 'Part 2' },
          ],
        },
      },
    ];
    const msgs = extractMessages(entries);
    expect(msgs.length).toBe(1);
    expect(msgs[0].content).toBe('Part 1\nPart 2');
  });

  it('handles mixed Claude Code and Cursor entries', () => {
    const entries = [
      {
        type: 'user',
        timestamp: '2026-01-01T00:00:00Z',
        message: { content: 'Claude Code user msg' },
      },
      {
        role: 'assistant',
        timestamp: '2026-01-01T00:00:01Z',
        message: { content: [{ type: 'text', text: 'Cursor assistant msg' }] },
      },
      {
        role: 'user',
        timestamp: '2026-01-01T00:00:02Z',
        message: { content: [{ type: 'text', text: 'Cursor user msg' }] },
      },
    ];
    const msgs = extractMessages(entries);
    expect(msgs.length).toBe(3);
    expect(msgs[0].content).toBe('Claude Code user msg');
    expect(msgs[1].content).toBe('Cursor assistant msg');
    expect(msgs[2].content).toBe('Cursor user msg');
  });

  it('prefers type over role when both are present', () => {
    const entries = [
      {
        type: 'user',
        role: 'assistant',
        timestamp: '2026-01-01T00:00:00Z',
        message: { content: 'has both fields' },
      },
    ];
    const msgs = extractMessages(entries);
    expect(msgs.length).toBe(1);
    expect(msgs[0].role).toBe('user');
  });
});

describe('getSessionMeta', () => {
  it('extracts full metadata', () => {
    const entries = [
      {
        type: 'user',
        timestamp: '2026-01-01T10:00:00Z',
        cwd: '/proj',
        gitBranch: 'main',
        message: { content: 'First message' },
      },
      { type: 'assistant', timestamp: '2026-01-01T10:00:01Z', message: { content: 'Response' } },
      { type: 'user', timestamp: '2026-01-01T10:01:00Z', message: { content: 'Second' } },
    ];
    const meta = getSessionMeta(entries);
    expect(meta.startTime).toBe('2026-01-01T10:00:00Z');
    expect(meta.endTime).toBe('2026-01-01T10:01:00Z');
    expect(meta.cwd).toBe('/proj');
    expect(meta.branch).toBe('main');
    expect(meta.messageCount).toBe(3);
    expect(meta.userMessageCount).toBe(2);
    expect(meta.preview).toContain('First message');
  });

  it('handles empty entries', () => {
    const meta = getSessionMeta([]);
    expect(meta.startTime).toBe('unknown');
    expect(meta.endTime).toBe('unknown');
    expect(meta.messageCount).toBe(0);
  });

  it('returns N/A preview when no user messages', () => {
    const entries = [
      { type: 'assistant', timestamp: '2026-01-01T10:00:00Z', message: { content: 'hi' } },
    ];
    expect(getSessionMeta(entries).preview).toBe('N/A');
  });

  it('truncates preview to 200 chars', () => {
    const entries = [
      { type: 'user', timestamp: '2026-01-01T00:00:00Z', message: { content: 'a'.repeat(500) } },
    ];
    expect(getSessionMeta(entries).preview.length).toBe(200);
  });

  // ── Cursor Composer format ──

  it('counts user messages using role field (Cursor format)', () => {
    const entries = [
      {
        role: 'user',
        timestamp: '2026-01-01T10:00:00Z',
        cwd: '/proj',
        gitBranch: 'feat',
        message: { content: [{ type: 'text', text: 'Cursor hello' }] },
      },
      {
        role: 'assistant',
        timestamp: '2026-01-01T10:00:01Z',
        message: { content: [{ type: 'text', text: 'Response' }] },
      },
    ];
    const meta = getSessionMeta(entries);
    expect(meta.userMessageCount).toBe(1);
    expect(meta.messageCount).toBe(2);
    expect(meta.preview).toBe('Cursor hello');
  });

  it('extracts preview from Cursor array content', () => {
    const entries = [
      {
        role: 'user',
        timestamp: '2026-01-01T00:00:00Z',
        message: {
          content: [
            { type: 'text', text: 'First part' },
            { type: 'text', text: 'Second part' },
          ],
        },
      },
    ];
    const meta = getSessionMeta(entries);
    expect(meta.preview).toContain('First part');
    expect(meta.preview).toContain('Second part');
  });
});

describe('getSessionFiles', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });
  afterEach(() => {
    cleanup(tmpDir);
  });

  it('lists .jsonl files and extracts IDs', () => {
    fs.writeFileSync(path.join(tmpDir, 'abc-123.jsonl'), '{}');
    fs.writeFileSync(path.join(tmpDir, 'def-456.jsonl'), '{}');
    fs.writeFileSync(path.join(tmpDir, 'readme.txt'), 'not a session');
    const files = getSessionFiles(tmpDir);
    expect(files.length).toBe(2);
    expect(files.map((f) => f.id)).toContain('abc-123');
  });

  it('returns empty for non-existent directory', () => {
    expect(getSessionFiles(path.join(tmpDir, 'nope'))).toEqual([]);
  });

  it('returns empty for directory with no jsonl files', () => {
    expect(getSessionFiles(tmpDir)).toEqual([]);
  });
});

describe('getProjectDirs — extra session roots', () => {
  let tmpDir: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    originalEnv = process.env.AGENT_KNOWLEDGE_EXTRA_SESSION_ROOTS;
  });
  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.AGENT_KNOWLEDGE_EXTRA_SESSION_ROOTS;
    } else {
      process.env.AGENT_KNOWLEDGE_EXTRA_SESSION_ROOTS = originalEnv;
    }
    cleanup(tmpDir);
    vi.restoreAllMocks();
  });

  it('discovers Cursor-style workspace with agent-transcripts/', () => {
    const ws = path.join(tmpDir, 'C--Users-Foo-myproject');
    fs.mkdirSync(path.join(ws, 'agent-transcripts'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'agent-transcripts', 'sess1.jsonl'), '{}');

    process.env.AGENT_KNOWLEDGE_EXTRA_SESSION_ROOTS = tmpDir;
    const dirs = getProjectDirs();
    const cursor = dirs.find((d) => d.name === 'cursor-C--Users-Foo-myproject');
    expect(cursor).toBeDefined();
    expect(cursor!.path).toBe(path.join(ws, 'agent-transcripts'));
  });

  it('discovers multiple Cursor workspaces', () => {
    for (const name of ['ws-a', 'ws-b']) {
      const ws = path.join(tmpDir, name);
      fs.mkdirSync(path.join(ws, 'agent-transcripts'), { recursive: true });
      fs.writeFileSync(path.join(ws, 'agent-transcripts', 'sess.jsonl'), '{}');
    }

    process.env.AGENT_KNOWLEDGE_EXTRA_SESSION_ROOTS = tmpDir;
    const dirs = getProjectDirs();
    expect(dirs.find((d) => d.name === 'cursor-ws-a')).toBeDefined();
    expect(dirs.find((d) => d.name === 'cursor-ws-b')).toBeDefined();
  });

  it('discovers generic subdirectory with JSONL files', () => {
    const sub = path.join(tmpDir, 'my-editor-project');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, 'session.jsonl'), '{}');

    process.env.AGENT_KNOWLEDGE_EXTRA_SESSION_ROOTS = tmpDir;
    const dirs = getProjectDirs();
    const found = dirs.find((d) => d.name === 'my-editor-project');
    expect(found).toBeDefined();
    expect(found!.path).toBe(sub);
  });

  it('discovers flat root containing JSONL files directly', () => {
    const flatRoot = path.join(tmpDir, 'flat-sessions');
    fs.mkdirSync(flatRoot, { recursive: true });
    fs.writeFileSync(path.join(flatRoot, 'session1.jsonl'), '{}');

    process.env.AGENT_KNOWLEDGE_EXTRA_SESSION_ROOTS = flatRoot;
    const dirs = getProjectDirs();
    const found = dirs.find((d) => d.name === 'flat-sessions');
    expect(found).toBeDefined();
    expect(found!.path).toBe(flatRoot);
  });

  it('skips non-existent extra roots gracefully', () => {
    process.env.AGENT_KNOWLEDGE_EXTRA_SESSION_ROOTS = path.join(tmpDir, 'nonexistent');
    expect(() => getProjectDirs()).not.toThrow();
  });

  it('supports comma-separated AGENT_KNOWLEDGE_EXTRA_SESSION_ROOTS', () => {
    const rootA = path.join(tmpDir, 'rootA');
    const rootB = path.join(tmpDir, 'rootB');
    fs.mkdirSync(rootA, { recursive: true });
    fs.mkdirSync(rootB, { recursive: true });
    fs.writeFileSync(path.join(rootA, 'a.jsonl'), '{}');
    fs.writeFileSync(path.join(rootB, 'b.jsonl'), '{}');

    process.env.AGENT_KNOWLEDGE_EXTRA_SESSION_ROOTS = `${rootA}, ${rootB}`;
    const dirs = getProjectDirs();
    expect(dirs.find((d) => d.name === 'rootA')).toBeDefined();
    expect(dirs.find((d) => d.name === 'rootB')).toBeDefined();
  });

  it('ignores subdirectories without JSONL or agent-transcripts', () => {
    const emptyWs = path.join(tmpDir, 'empty-workspace');
    fs.mkdirSync(emptyWs, { recursive: true });
    fs.writeFileSync(path.join(emptyWs, 'readme.txt'), 'no sessions here');

    process.env.AGENT_KNOWLEDGE_EXTRA_SESSION_ROOTS = tmpDir;
    const dirs = getProjectDirs();
    const found = dirs.find((d) => d.name.includes('empty-workspace'));
    expect(found).toBeUndefined();
  });

  it('still discovers Claude Code projects alongside extra roots', () => {
    const ws = path.join(tmpDir, 'cursor-ws');
    fs.mkdirSync(path.join(ws, 'agent-transcripts'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'agent-transcripts', 's.jsonl'), '{}');

    process.env.AGENT_KNOWLEDGE_EXTRA_SESSION_ROOTS = tmpDir;
    const dirs = getProjectDirs();
    const cursorFound = dirs.find((d) => d.name === 'cursor-cursor-ws');
    expect(cursorFound).toBeDefined();
  });
});
