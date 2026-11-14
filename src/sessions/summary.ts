import fs from 'fs';
import {
  getProjectDirs,
  getSessionFiles,
  parseSessionFile,
  readSessionFile,
  extractMessages,
  getSessionMeta,
  promptsOf,
  type SessionEntry,
  type SessionMessage,
  type SessionMeta,
} from './parser.js';
import { getAvailableAdapters } from './adapters/index.js';
import { branchName, projectName } from './human.js';
import { withoutControls } from '../text.js';

// ── Interfaces ──────────────────────────────────────────────────────────────

export interface SessionSummary {
  /** The project as a person names it: its folder's name, not the store's slug. */
  name: string;
  meta: SessionMeta;
  topicCount: number;
  topics: Array<{ timestamp: string | null; content: string }>;
  toolsUsed: string[];
  filesModified: string[];
  gitCommits: string[];
  errorPatterns: string[];
  urlsAccessed: string[];
  packagesChanged: string[];
}

// ── Structured extraction (deterministic, no LLM) ─────────────────────────

// Commits made in the session: the line `git commit` prints, `[main 9a8b7c6] Fix the sync`
// (`[main (root-commit) 9a8b7c6]` for the first). A SHA merely shown (git log, a push's range)
// was not made here.
const GIT_COMMIT_RE = /^\[[^\]\s]+(?: \(root-commit\))? ([0-9a-f]{7,40})\] (.+)$/gm;

function extractGitCommits(messages: Array<{ role: string; content: string }>): string[] {
  const commits = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role !== 'tool_result') continue;
    GIT_COMMIT_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = GIT_COMMIT_RE.exec(msg.content)) !== null) {
      commits.set(match[1]!.substring(0, 7), match[2]!.trim());
    }
  }
  return Array.from(commits, ([sha, subject]) => `${sha} ${subject}`).slice(0, 20);
}

// Files changed: the path an editing or writing tool call names (Edit, Write, MultiEdit,
// NotebookEdit; edit_file, write_file, apply_patch of other hosts).
const CHANGING_TOOL_RE = /edit|write|create|patch|notebook/i;
const PATH_ARGS = ['file_path', 'notebook_path', 'path', 'target_file', 'filePath'];

function extractChangedFiles(messages: SessionMessage[]): string[] {
  const files = new Set<string>();
  for (const msg of messages) {
    if (!msg.tool || !CHANGING_TOOL_RE.test(msg.tool.name)) continue;
    const key = PATH_ARGS.find((k) => typeof msg.tool!.input[k] === 'string');
    if (key) files.add(String(msg.tool.input[key]));
  }
  return Array.from(files).sort();
}

// A line of tool output that reports an error, in any case and as a word: `FAILED tests/…`,
// `psycopg2.errors.UniqueViolation: …`, `Error: …`. A count of none (`0 errors`) is not one.
const ERROR_LINE_RE =
  /^.*?(?<!\b0 )\b(?:errors?|exceptions?|fail(?:s|ed|ures?)?|fatal|panic|traceback)\b.*$/gim;

export function extractErrorPatterns(messages: Array<{ role: string; content: string }>): string[] {
  const errors = new Set<string>();
  for (const msg of messages) {
    if (msg.role !== 'tool_result') continue;
    // A coloured `[31mFAILED` is a word only once its escapes are gone.
    const text = withoutControls(msg.content);
    ERROR_LINE_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = ERROR_LINE_RE.exec(text)) !== null) {
      const line = match[0].trim();
      if (line.length > 10 && line.length < 200) {
        errors.add(line);
      }
      if (errors.size >= 10) break;
    }
  }
  return Array.from(errors);
}

// URLs — from tool results
const URL_RE = /https?:\/\/[^\s"'<>)\]]+/g;
// Filter out noise URLs
const URL_NOISE =
  /\.(png|jpg|jpeg|gif|svg|ico|woff|ttf|eot|map)(\?|$)|fonts\.googleapis|cdnjs|unpkg/i;

function extractUrls(messages: Array<{ role: string; content: string }>): string[] {
  const urls = new Set<string>();
  for (const msg of messages) {
    if (msg.role !== 'tool_result' && msg.role !== 'tool_use') continue;
    URL_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = URL_RE.exec(msg.content)) !== null) {
      const url = match[0].replace(/[.,;:!?)]+$/, ''); // Strip trailing punctuation
      if (!URL_NOISE.test(url) && url.length < 200) {
        urls.add(url);
      }
      if (urls.size >= 15) break;
    }
  }
  return Array.from(urls);
}

// Package changes — npm install / pip install
const NPM_INSTALL_RE = /npm\s+(?:install|i|add)\s+([^\s&|;]+(?:\s+[^\s&|;-][^\s&|;]*)*)/g;
const PIP_INSTALL_RE = /pip\s+install\s+([^\s&|;]+(?:\s+[^\s&|;-][^\s&|;]*)*)/g;

function extractPackageChanges(messages: Array<{ role: string; content: string }>): string[] {
  const packages = new Set<string>();
  for (const msg of messages) {
    if (msg.role !== 'tool_use' && msg.role !== 'tool_result') continue;
    for (const re of [NPM_INSTALL_RE, PIP_INSTALL_RE]) {
      re.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = re.exec(msg.content)) !== null) {
        // Split the args — each word is a package name (ignore flags starting with -)
        const args = match[1].split(/\s+/).filter((a) => !a.startsWith('-') && a.length > 0);
        for (const pkg of args) {
          packages.add(pkg.replace(/@[\d^~>=<.*]+$/, '')); // Strip version specifiers
        }
      }
    }
  }
  return Array.from(packages).slice(0, 20);
}

// ── Session summary ─────────────────────────────────────────────────────────

/**
 * `text` to about `n` characters, never cut inside a word: a key cut short could fall below the
 * length the scrubber's rule for it needs, and its first characters reach a snapshot.
 */
export function clip(text: string, n: number): string {
  if (text.length <= n) return text;
  const word = /^\S{0,1000}/.exec(text.slice(n))![0];
  return `${text.slice(0, n)}${word}…`;
}

/** Where a session's transcript is on this machine: its project folder and its file. */
export function findSession(
  sessionId: string,
  project?: string,
): { project: { name: string; path: string }; file: string } | null {
  for (const proj of getProjectDirs()) {
    if (project && !proj.name.toLowerCase().includes(project.toLowerCase())) continue;
    const match = getSessionFiles(proj.path).find((s) => s.id === sessionId);
    if (match) return { project: proj, file: match.file };
  }
  return null;
}

/**
 * A session's summary: what was asked (`promptsOf`, each to 300 characters), the tools called,
 * the files changed, the commits made, the errors met. Null when no transcript holds the id.
 */
export function getSessionSummary(sessionId: string, project?: string): SessionSummary | null {
  const found = findSession(sessionId, project);
  return found && summarize(found.project.name, parseSessionFile(found.file));
}

/** getSessionSummary with the transcript read in slices: the REST holder keeps answering. */
export async function loadSessionSummary(
  sessionId: string,
  project?: string,
): Promise<SessionSummary | null> {
  const found = findSession(sessionId, project);
  return found && summarize(found.project.name, await readSessionFile(found.file));
}

function summarize(store: string, entries: SessionEntry[]): SessionSummary | null {
  if (entries.length === 0) return null;

  const meta = getSessionMeta(entries);
  const messages = extractMessages(entries);
  const topics = promptsOf(entries).map((p) => ({
    timestamp: p.timestamp,
    content: clip(p.text, 300),
  }));

  // Tools: the names the calls carry (mcp__agent-knowledge__knowledge whole)
  const toolNames = new Set<string>();
  for (const msg of messages) {
    if (msg.tool) toolNames.add(msg.tool.name);
  }

  // Structured extraction — deterministic, no LLM
  const gitCommits = extractGitCommits(messages);
  const errorPatterns = extractErrorPatterns(messages);
  const urlsAccessed = extractUrls(messages);
  const packagesChanged = extractPackageChanges(messages);

  return {
    name: projectName(meta.cwd, store),
    meta,
    topicCount: topics.length,
    topics,
    toolsUsed: Array.from(toolNames).sort(),
    filesModified: extractChangedFiles(messages),
    gitCommits,
    errorPatterns,
    urlsAccessed,
    packagesChanged,
  };
}

// ── List sessions ───────────────────────────────────────────────────────────

/**
 * List all sessions with metadata, sorted by startTime descending.
 * Optionally filter by project name (substring match).
 */
// ── Session metadata cache (keyed by file path + mtime) ─────────────────────

const metaCache = new Map<string, { mtime: number; meta: SessionMeta }>();

function fastMeta(filePath: string): SessionMeta | null {
  try {
    const fd = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(fd);
    if (stat.size === 0) {
      fs.closeSync(fd);
      return null;
    }

    const headSize = Math.min(32768, stat.size);
    const headBuf = Buffer.alloc(headSize);
    fs.readSync(fd, headBuf, 0, headBuf.length, 0);
    const headStr = headBuf.toString('utf-8');
    const headLines = headStr.split('\n').filter((l) => l.trim());
    if (headLines.length === 0) {
      fs.closeSync(fd);
      return null;
    }

    // Find the first line with a top-level timestamp (skip metadata-only entries
    // like file-history-snapshot which have no timestamp/cwd/gitBranch at top level)
    let first: Record<string, unknown> | null = null;
    for (const line of headLines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.timestamp) {
          first = parsed;
          break;
        }
      } catch (err) {
        console.error('[knowledge] parse head line:', err instanceof Error ? err.message : err);
        continue;
      }
    }
    if (!first) {
      // Fallback: use the very first parseable line even without timestamp
      try {
        first = JSON.parse(headLines[0]) as Record<string, unknown>;
      } catch (err) {
        console.error('[knowledge] parse fallback line:', err instanceof Error ? err.message : err);
        fs.closeSync(fd);
        return null;
      }
    }

    let last: Record<string, unknown> = first!;
    if (stat.size <= headSize) {
      // The whole file is in the head: its last timestamped line is the session's end.
      for (let i = headLines.length - 1; i >= 0; i--) {
        try {
          const parsed = JSON.parse(headLines[i]);
          if (parsed.timestamp) {
            last = parsed;
            break;
          }
        } catch {
          continue;
        }
      }
    } else {
      const tailSize = Math.min(4096, stat.size);
      const tailBuf = Buffer.alloc(tailSize);
      fs.readSync(fd, tailBuf, 0, tailSize, stat.size - tailSize);
      const tailStr = tailBuf.toString('utf-8');
      const tailLines = tailStr.split('\n').filter((l) => l.trim());
      // Find last line with a timestamp (skip trailing metadata entries)
      for (let i = tailLines.length - 1; i >= 0; i--) {
        try {
          const parsed = JSON.parse(tailLines[i]);
          if (parsed.timestamp) {
            last = parsed;
            break;
          }
        } catch (err) {
          console.error('[knowledge] parse tail line:', err instanceof Error ? err.message : err);
          continue;
        }
      }
    }
    fs.closeSync(fd);

    // What was asked, from the head; a session whose first prompt is not whole in it (a long
    // paste) is read through, so a session with a prompt never reads as one without.
    const parsed = (lines: string[]) =>
      lines.flatMap((l) => {
        try {
          return [JSON.parse(l) as SessionEntry];
        } catch {
          return [];
        }
      });
    let said = promptsOf(parsed(headLines));
    if (said.length === 0 && stat.size > headSize) said = promptsOf(parseSessionFile(filePath));

    return {
      startTime: (first.timestamp as string) || 'unknown',
      endTime: (last.timestamp as string) || (first.timestamp as string) || 'unknown',
      cwd: (first.cwd as string) || '',
      branch: branchName((first.gitBranch as string) || ''),
      messageCount: Math.max(1, Math.round(stat.size / 500)),
      userMessageCount: said.length,
      preview: (said[0]?.text ?? '').substring(0, 200),
    };
  } catch {
    return null;
  }
}

function isVirtualDescriptor(filePath: string): boolean {
  for (const adapter of getAvailableAdapters()) {
    if (filePath.startsWith(`${adapter.prefix}://`)) return true;
  }
  return false;
}

function getCachedMeta(sess: { id: string; file: string }): SessionMeta | null {
  // Virtual descriptors cannot use fs-based fastMeta; fall back to full parse
  if (isVirtualDescriptor(sess.file)) {
    const cached = metaCache.get(sess.file);
    if (cached) return cached.meta;
    const entries = parseSessionFile(sess.file);
    if (entries.length === 0) return null;
    const meta = getSessionMeta(entries);
    metaCache.set(sess.file, { mtime: 0, meta });
    return meta;
  }

  try {
    const stat = fs.statSync(sess.file);
    const mtime = stat.mtimeMs;
    const cached = metaCache.get(sess.file);
    if (cached && cached.mtime === mtime) return cached.meta;

    const meta = fastMeta(sess.file);
    if (!meta) return null;
    metaCache.set(sess.file, { mtime, meta });
    return meta;
  } catch {
    return null;
  }
}

export function listSessions(
  project?: string,
): Array<{ project: string; sessionId: string; name: string } & SessionMeta> {
  const projects = getProjectDirs().filter(
    (p) => !project || p.name.toLowerCase().includes(project.toLowerCase()),
  );

  const results: Array<{ project: string; sessionId: string; name: string } & SessionMeta> = [];

  for (const proj of projects) {
    const sessions = getSessionFiles(proj.path);
    for (const sess of sessions) {
      const meta = getCachedMeta(sess);
      if (!meta) continue;
      results.push({
        project: proj.name,
        sessionId: sess.id,
        name: projectName(meta.cwd, proj.name),
        ...meta,
      });
    }
  }

  // Sort by startTime descending (newest first)
  results.sort((a, b) => {
    if (a.startTime === 'unknown') return 1;
    if (b.startTime === 'unknown') return -1;
    return new Date(b.startTime).getTime() - new Date(a.startTime).getTime();
  });

  return results;
}
