import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';

vi.mock('../src/types.js', () => {
  let _memoryDir = '';
  let _dataDir = '';
  return {
    getConfig: () => ({
      memoryDir: _memoryDir,
      dataDir: _dataDir,
      sessionsDir: path.join(_dataDir, 'projects'),
      embeddingProvider: 'local',
      embeddingAlpha: 0.3,
      gitUrl: undefined,
      autoDistill: true,
      extraSessionRoots: [],
    }),
    _setDirs: (memoryDir: string, dataDir: string) => {
      _memoryDir = memoryDir;
      _dataDir = dataDir;
    },
    getVersion: () => '1.0.0',
  };
});

import { distillSessions, scrubContent, normalizeProjectName } from '../src/knowledge/distill.js';
import { _setDirs } from '../src/types.js';

function makeGitRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });
  for (const cat of ['projects', 'people', 'decisions', 'workflows', 'notes']) {
    fs.mkdirSync(path.join(dir, cat), { recursive: true });
  }
  fs.writeFileSync(path.join(dir, 'README.md'), '# Test Memory\n');
  execSync('git add -A && git commit -m "init"', { cwd: dir, stdio: 'pipe' });
}

function makeSession(
  dataDir: string,
  projectName: string,
  sessionId: string,
  messages: Array<{ role: string; content: string }>,
): void {
  const projDir = path.join(dataDir, 'projects', projectName);
  fs.mkdirSync(projDir, { recursive: true });

  const lines = messages.map((m, i) => {
    const ts = new Date(Date.now() - (messages.length - i) * 60000).toISOString();
    return JSON.stringify({
      type: m.role,
      timestamp: ts,
      message: { role: m.role, content: m.content },
    });
  });

  fs.writeFileSync(path.join(projDir, `${sessionId}.jsonl`), lines.join('\n') + '\n');
}

// ── normalizeProjectName ────────────────────────────────────────────────────

describe('normalizeProjectName', () => {
  it('strips Windows user prefix', () => {
    expect(normalizeProjectName('C--Users-Alice-myproj19-myproj')).toBe('myproj19');
  });

  it('strips double-dash user prefix', () => {
    expect(normalizeProjectName('C--Users-Alice--claude-mcp-servers-agent-comm')).toBe(
      'agent-comm',
    );
  });

  it('merges worktree into parent project', () => {
    expect(
      normalizeProjectName(
        'C--Users-Alice--claude-mcp-servers-agent-comm--worktrees-review-security',
      ),
    ).toBe('agent-comm');
  });

  it('merges host-prefixed worktrees into parent project', () => {
    expect(normalizeProjectName('C--Users-Alice-myproj19-myproj--claude-worktrees-feature-x')).toBe(
      'myproj19',
    );
  });

  it('merges swarm sessions into parent project', () => {
    expect(normalizeProjectName('C--Users-Alice--agent-comm-swarm-scale-test-3')).toBe(
      'agent-comm',
    );
    expect(normalizeProjectName('C--Users-Alice--agent-comm-swarm-comm-agent-1')).toBe(
      'agent-comm',
    );
    expect(normalizeProjectName('C--Users-Alice--agent-comm-swarm-ui-fixer')).toBe('agent-comm');
  });

  it('maps a bare host config dir to a stable label', () => {
    expect(normalizeProjectName('C--Users-Alice--claude')).toBe('claude-code-config');
  });

  it('strips host-name prefix for subprojects', () => {
    expect(normalizeProjectName('C--Users-Alice--claude-channels')).toBe('channels');
    expect(normalizeProjectName('C--Users-Alice--claude-downloads')).toBe('downloads');
  });

  it('collapses duplicated trailing project segment', () => {
    expect(
      normalizeProjectName('C--Users-Alice-myproj16-env-myproj-customers-etron-onretail-myproj'),
    ).toBe('myproj16');
  });
});

// ── scrubContent ────────────────────────────────────────────────────────────

describe('scrubContent', () => {
  it('removes system-reminder tags', () => {
    const input = 'hello <system-reminder>secret stuff</system-reminder> world';
    expect(scrubContent(input)).toBe('hello  world');
  });

  it('removes task-notification tags', () => {
    const input = 'before <task-notification>task data</task-notification> after';
    expect(scrubContent(input)).toBe('before  after');
  });

  it('redacts API keys', () => {
    expect(scrubContent('key is sk-abc123def456ghi789jkl012mno345p')).toContain(
      '[REDACTED_API_KEY]',
    );
  });

  it('redacts GitHub tokens', () => {
    expect(scrubContent('token: ghp_abcdef1234567890abcdef1234567890abcdef12')).toContain(
      '[REDACTED_GITHUB_TOKEN]',
    );
  });

  it('redacts GitLab tokens', () => {
    expect(scrubContent('glpat-abc123def456ghi789jkl')).toContain('[REDACTED_GITLAB_TOKEN]');
  });

  it('redacts bearer tokens', () => {
    expect(
      scrubContent('Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature'),
    ).toContain('[REDACTED');
  });

  it('redacts password assignments', () => {
    expect(scrubContent('password=mysecretpassword123')).toContain('[REDACTED_CREDENTIAL]');
  });

  it('redacts connection strings', () => {
    expect(scrubContent('postgres://admin:s3cret@db.host.com/mydb')).toContain('[REDACTED]');
  });

  it('leaves normal text unchanged', () => {
    const text = 'Fix the login page CSS for mobile viewports';
    expect(scrubContent(text)).toBe(text);
  });
});

// ── distillSessions ─────────────────────────────────────────────────────────

describe('distillSessions', () => {
  let memoryDir: string;
  let dataDir: string;

  beforeEach(() => {
    memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-distill-mem-'));
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-distill-claude-'));
    makeGitRepo(memoryDir);
    (_setDirs as (m: string, c: string) => void)(memoryDir, dataDir);
  });

  afterEach(() => {
    fs.rmSync(memoryDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('returns empty when no sessions exist', async () => {
    const result = await distillSessions();
    expect(result.updated).toHaveLength(0);
    expect(result.created).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
  });

  it('creates a new project entry from session data', async () => {
    makeSession(dataDir, 'my-test-project', 'session-001', [
      { role: 'user', content: 'Please implement the login feature with OAuth support' },
      { role: 'assistant', content: 'I will implement OAuth login...' },
    ]);

    const result = await distillSessions();
    // Session with meaningful content should produce at least one new project entry
    expect(result.created.length + result.updated.length).toBeGreaterThanOrEqual(1);
  });

  it('respects the distill cursor to avoid reprocessing', async () => {
    makeSession(dataDir, 'cursor-test', 'session-003', [
      { role: 'user', content: 'First session with important work on the API layer' },
      { role: 'assistant', content: 'Working on it...' },
    ]);

    await distillSessions();

    const cursorPath = path.join(dataDir, '.knowledge-distill-cursor');
    expect(fs.existsSync(cursorPath)).toBe(true);
    const cursor = fs.readFileSync(cursorPath, 'utf-8').trim();
    // Content contract — must be a parseable ISO timestamp, not a placeholder
    // or empty marker. Otherwise the second run's "don't reprocess" check is
    // relying on an accidental truthy string.
    const parsed = new Date(cursor).getTime();
    expect(Number.isFinite(parsed)).toBe(true);
    expect(parsed).toBeGreaterThan(0);

    const result2 = await distillSessions();
    expect(result2.updated).toHaveLength(0);
    expect(result2.created).toHaveLength(0);
  });

  it('does not write secrets to project entries', async () => {
    makeSession(dataDir, 'secret-test', 'session-004', [
      {
        role: 'user',
        content:
          'Set the API key to sk-abc123def456ghi789jkl012mno345pqrs and deploy the application',
      },
      { role: 'assistant', content: 'Setting up...' },
    ]);

    await distillSessions();

    const files = fs.readdirSync(path.join(memoryDir, 'projects'));
    for (const file of files) {
      const content = fs.readFileSync(path.join(memoryDir, 'projects', file), 'utf-8');
      expect(content).not.toContain('sk-abc123');
    }
  });
});
