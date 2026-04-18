import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { gitPull, gitPush, gitSync, ensureRepo } from '../src/knowledge/git.js';

function makeTmpGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-git-test-'));
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });
  fs.writeFileSync(path.join(dir, 'README.md'), '# Test\n');
  execSync('git add -A', { cwd: dir, stdio: 'pipe' });
  execSync('git commit -m "initial"', { cwd: dir, stdio: 'pipe' });
  return dir;
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe('gitPull', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpGitRepo();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  it('surfaces a remote-related error message when pulling with no remote configured', async () => {
    const result = await gitPull(tmpDir);
    expect(result.success).toBe(false);
    // A truthy-string assertion would pass for "oops" or "". Pin the error
    // shape: git's message for missing-remote mentions "remote" or similar.
    // Accept any of the recognised failure-mode phrases across git versions.
    expect(result.message).toMatch(
      /remote|no such|not a git|fatal|unable to|ref(s|spec|erence)|origin|unknown/i,
    );
    expect(result.message.length).toBeGreaterThan(5);
  });
});

describe('gitPush', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpGitRepo();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  it('commits new files when there are changes', async () => {
    fs.mkdirSync(path.join(tmpDir, 'notes'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'notes', 'test.md'), 'test content');

    await gitPush(tmpDir, 'test commit');
    const log = execSync('git log --oneline', { cwd: tmpDir, stdio: 'pipe' }).toString();
    expect(log).toContain('test commit');
  });

  it('does not create empty commits when nothing changed', async () => {
    const logBefore = execSync('git log --oneline', { cwd: tmpDir, stdio: 'pipe' }).toString();
    const countBefore = logBefore.trim().split('\n').length;

    await gitPush(tmpDir, 'should not appear');

    const logAfter = execSync('git log --oneline', { cwd: tmpDir, stdio: 'pipe' }).toString();
    const countAfter = logAfter.trim().split('\n').length;

    expect(countAfter).toBe(countBefore);
  });

  it('uses default commit message when none provided', async () => {
    fs.writeFileSync(path.join(tmpDir, 'new.md'), 'content');
    await gitPush(tmpDir);
    const log = execSync('git log --oneline', { cwd: tmpDir, stdio: 'pipe' }).toString();
    expect(log).toContain('update knowledge base');
  });

  it('handles special characters in commit message safely', async () => {
    fs.writeFileSync(path.join(tmpDir, 'special.md'), 'content');
    await gitPush(tmpDir, 'test `whoami` $(echo hack) "quotes" & | ;');
    const log = execSync('git log -1 --format=%s', { cwd: tmpDir, stdio: 'pipe' })
      .toString()
      .trim();
    expect(log).toContain('test');
  });
});

describe('ensureRepo', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      cleanup(tmpDir);
    }
  });

  it('returns no-op for existing git repo', () => {
    tmpDir = makeTmpGitRepo();
    const result = ensureRepo(tmpDir);
    expect(result.success).toBe(true);
    expect(result.message).toContain('already exists');
  });

  it('creates local-only dir with categories when no git URL', () => {
    tmpDir = path.join(os.tmpdir(), `knowledge-ensure-${Date.now()}`);
    const result = ensureRepo(tmpDir);
    expect(result.success).toBe(true);
    expect(result.message).toContain('local-only');
    expect(fs.existsSync(path.join(tmpDir, 'projects'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'people'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'decisions'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'workflows'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'notes'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.git'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, 'README.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.gitignore'))).toBe(true);
    const readme = fs.readFileSync(path.join(tmpDir, 'README.md'), 'utf-8');
    expect(readme).toContain('Knowledge Base');
    const gitignore = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('.env');
    expect(gitignore).toContain('*.pem');
  });

  it('clones remote repo when dir does not exist and gitUrl provided', () => {
    const sourceDir = makeTmpGitRepo();
    const bareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-bare-'));
    execSync(`git clone --bare "${sourceDir}" "${bareDir}/repo.git"`, { stdio: 'pipe' });
    cleanup(sourceDir);

    tmpDir = path.join(os.tmpdir(), `knowledge-clone-${Date.now()}`);
    const result = ensureRepo(tmpDir, path.join(bareDir, 'repo.git'));
    expect(result.success).toBe(true);
    expect(result.message).toContain('cloned');
    expect(fs.existsSync(path.join(tmpDir, '.git'))).toBe(true);
    cleanup(bareDir);
  });

  it('inits repo with remote when dir exists but is not a git repo', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-init-'));
    const bareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-bare2-'));
    execSync('git init --bare', { cwd: bareDir, stdio: 'pipe' });

    const result = ensureRepo(tmpDir, bareDir);
    expect(result.success).toBe(true);
    expect(result.message).toContain('initialized');
    expect(fs.existsSync(path.join(tmpDir, '.git'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'projects'))).toBe(true);
    cleanup(bareDir);
  });
});

describe('gitSync', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpGitRepo();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  it('returns both pull and push results', async () => {
    const result = await gitSync(tmpDir);
    expect(result).toHaveProperty('pull');
    expect(result).toHaveProperty('push');
    // No remote configured, so both pull and push fail gracefully
    expect(result.pull.success).toBe(false);
    expect(result.push.success).toBe(false);
  });
});
