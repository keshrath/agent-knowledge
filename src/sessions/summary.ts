import fs from 'fs';
import {
  getProjectDirs,
  getSessionFiles,
  parseSessionFile,
  extractMessages,
  getSessionMeta,
  type SessionMeta,
} from './parser.js';
import { getAvailableAdapters } from './adapters/index.js';

// ── Interfaces ──────────────────────────────────────────────────────────────

export interface SessionSummary {
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

// ── File path extraction ────────────────────────────────────────────────────

/**
 * Regex to match common file paths in tool results.
 * Captures paths like /src/foo.ts, ./bar.js, C:\path\file.py, etc.
 */
const FILE_PATH_RE =
  /(?:^|[\s"'`(])([./~]?(?:[\w.-]+\/)+[\w.-]+\.(?:ts|tsx|js|jsx|py|rs|go|java|vue|svelte|css|scss|html|json|yaml|yml|toml|md|txt|sh|sql|prisma|graphql|proto))\b/g;

function extractFilePaths(text: string): string[] {
  const paths = new Set<string>();
  let match: RegExpExecArray | null;

  // Reset lastIndex
  FILE_PATH_RE.lastIndex = 0;

  while ((match = FILE_PATH_RE.exec(text)) !== null) {
    paths.add(match[1]);
  }

  return Array.from(paths);
}

/**
 * Extract tool names from tool_use entries.
 * The tool name is typically the first word or a JSON "name" field.
 */
const TOOL_NAME_RE = /(?:"name"\s*:\s*"([^"]+)"|^(\w+(?:_\w+)*))/;

function extractToolName(content: string): string | null {
  const match = content.match(TOOL_NAME_RE);
  return match ? (match[1] ?? match[2] ?? null) : null;
}

// ── Structured extraction (deterministic, no LLM) ─────────────────────────

// Git commit SHAs — match 7-40 char hex strings preceded by commit-related context
const GIT_COMMIT_RE = /\b([0-9a-f]{7,40})\b/g;
const GIT_COMMIT_CONTEXT_RE = /(?:commit|merge|cherry-pick|revert|rebase|push|pull|checkout)\b/i;

function extractGitCommits(messages: Array<{ role: string; content: string }>): string[] {
  const commits = new Set<string>();
  for (const msg of messages) {
    if (msg.role !== 'tool_result') continue;
    // Only extract from output that looks like git output
    if (!GIT_COMMIT_CONTEXT_RE.test(msg.content)) continue;
    GIT_COMMIT_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = GIT_COMMIT_RE.exec(msg.content)) !== null) {
      const sha = match[1];
      // Filter out common false positives (all-zeros, etc)
      if (sha.length >= 7 && sha.length <= 40 && !/^0+$/.test(sha)) {
        commits.add(sha.substring(0, 7)); // Normalize to short SHA
      }
    }
  }
  return Array.from(commits).slice(0, 20);
}

// Error patterns — extract Error/Exception lines
const ERROR_LINE_RE = /^.*(?:Error|Exception|FAIL|FATAL|panic|Traceback)[:.\s].{10,200}/gm;

function extractErrorPatterns(messages: Array<{ role: string; content: string }>): string[] {
  const errors = new Set<string>();
  for (const msg of messages) {
    if (msg.role !== 'tool_result') continue;
    ERROR_LINE_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = ERROR_LINE_RE.exec(msg.content)) !== null) {
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
 * Generate a structured summary of a session.
 *
 * - Extracts user messages as topics (first 300 chars each)
 * - Collects unique tool names from tool_use entries
 * - Extracts file paths mentioned in tool results
 */
export function getSessionSummary(sessionId: string, project?: string): SessionSummary | null {
  const projects = getProjectDirs().filter(
    (p) => !project || p.name.toLowerCase().includes(project.toLowerCase()),
  );

  for (const proj of projects) {
    const sessions = getSessionFiles(proj.path);
    const match = sessions.find((s) => s.id === sessionId);
    if (!match) continue;

    const entries = parseSessionFile(match.file);
    if (entries.length === 0) return null;

    const meta = getSessionMeta(entries);
    const messages = extractMessages(entries);

    // Topics: user messages truncated to 300 chars
    // Filter out tool results, JSON blobs, base64 images, system reminders
    const isHumanMessage = (text: string): boolean => {
      const t = text.trimStart();
      if (t.startsWith('[{') || t.startsWith('{"')) return false;
      if (t.includes('tool_use_id') || t.includes('tool_result')) return false;
      if (t.includes('base64') || t.includes('media_type')) return false;
      if (t.includes('<system-reminder>')) return false;
      if (t.length < 3) return false;
      return true;
    };

    const topics = messages
      .filter((m) => m.role === 'user')
      .filter((m) => isHumanMessage(m.content))
      .map((m) => ({
        timestamp: m.timestamp,
        content: m.content.length > 300 ? m.content.substring(0, 300) + '...' : m.content,
      }));

    // Tools: unique tool names from tool_use messages
    const toolNames = new Set<string>();
    for (const msg of messages) {
      if (msg.role === 'tool_use') {
        const name = extractToolName(msg.content);
        if (name) toolNames.add(name);
      }
    }

    // Files: paths mentioned in tool_result messages
    const allFiles = new Set<string>();
    for (const msg of messages) {
      if (msg.role === 'tool_result') {
        for (const fp of extractFilePaths(msg.content)) {
          allFiles.add(fp);
        }
      }
    }

    // Structured extraction — deterministic, no LLM
    const gitCommits = extractGitCommits(messages);
    const errorPatterns = extractErrorPatterns(messages);
    const urlsAccessed = extractUrls(messages);
    const packagesChanged = extractPackageChanges(messages);

    return {
      meta,
      topicCount: topics.length,
      topics,
      toolsUsed: Array.from(toolNames).sort(),
      filesModified: Array.from(allFiles).sort(),
      gitCommits,
      errorPatterns,
      urlsAccessed,
      packagesChanged,
    };
  }

  return null;
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
    if (stat.size > headSize) {
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

    const extractText = (content: unknown): string => {
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) {
        const parts = content
          .filter(
            (p) =>
              typeof p === 'string' || (typeof p === 'object' && p !== null && p.type === 'text'),
          )
          .map((p) => (typeof p === 'string' ? p : p.text));
        return parts.length > 0 ? parts.join('\n') : '';
      }
      return '';
    };

    let preview = '';
    let userMessageCount = 0;
    for (const line of headLines) {
      try {
        const entry = JSON.parse(line);
        const role = entry.type ?? entry.role;
        if (role === 'user') {
          userMessageCount++;
          if (!preview && entry.message?.content !== null && entry.message?.content !== undefined) {
            const text = extractText(entry.message.content);
            if (text) preview = text.substring(0, 200);
          }
        }
      } catch {
        continue;
      }
    }

    return {
      startTime: (first.timestamp as string) || 'unknown',
      endTime: (last.timestamp as string) || (first.timestamp as string) || 'unknown',
      cwd: (first.cwd as string) || '',
      branch: (first.gitBranch as string) || '',
      messageCount: Math.max(1, Math.round(stat.size / 500)),
      userMessageCount,
      preview,
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
): Array<{ project: string; sessionId: string } & SessionMeta> {
  const projects = getProjectDirs().filter(
    (p) => !project || p.name.toLowerCase().includes(project.toLowerCase()),
  );

  const results: Array<{ project: string; sessionId: string } & SessionMeta> = [];

  for (const proj of projects) {
    const sessions = getSessionFiles(proj.path);
    for (const sess of sessions) {
      const meta = getCachedMeta(sess);
      if (!meta) continue;
      results.push({
        project: proj.name,
        sessionId: sess.id,
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
