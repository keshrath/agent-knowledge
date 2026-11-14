import fs from 'fs';
import { branchName, humanText } from './human.js';
import os from 'os';
import path from 'path';
import { getConfig } from '../types.js';
import { getAvailableAdapters } from './adapters/index.js';
import { runAll, runSliced } from '../slice.js';

// ── Text extraction helper ──────────────────────────────────────────────────

interface TextPart {
  type: string;
  text?: string;
}

function isTextPart(p: unknown): p is TextPart {
  return typeof p === 'object' && p !== null && 'type' in p && (p as TextPart).type === 'text';
}

/** Extract text from message content (string, array of strings/text parts, or unknown). */
function extractText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = content
      .filter((p: unknown) => typeof p === 'string' || isTextPart(p))
      .map((p: unknown) => (typeof p === 'string' ? p : (p as TextPart).text))
      .filter(Boolean) as string[];
    return parts.length > 0 ? parts.join('\n') : null;
  }
  return null;
}

interface ToolPart {
  type: 'tool_use' | 'tool_result';
  name?: unknown;
  input?: unknown;
  content?: unknown;
}

/** The content array's tool_use or tool_result blocks. */
function toolParts(content: unknown, type: ToolPart['type']): ToolPart[] {
  if (!Array.isArray(content)) return [];
  return content.filter(
    (p: unknown): p is ToolPart =>
      typeof p === 'object' && p !== null && (p as ToolPart).type === type,
  );
}

function toolResultText(part: ToolPart): string {
  const text = extractText(part.content) ?? JSON.stringify(part.content ?? '');
  return text.substring(0, 500);
}

// ── Interfaces ──────────────────────────────────────────────────────────────

export interface SessionEntry {
  type?: string;
  role?: string; // Cursor Composer uses `role` instead of `type`
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  message?: { role?: string; content: unknown };
  content?: string;
  /** Claude Code: written by the host in the person's turn (a skill's text, an image note). */
  isMeta?: boolean;
  /** Claude Code: the summary a compaction wrote in the person's turn, not their prompt. */
  isCompactSummary?: boolean;
}

export interface SessionMessage {
  role: 'user' | 'assistant' | 'tool_use' | 'tool_result';
  /** What was said; for a tool call, a line as a person reads it: `Edit src/a.ts`, `Bash git push`. */
  content: string;
  timestamp: string | null;
  /** A tool call's name and input as the host recorded them. */
  tool?: ToolCall;
}

export interface ToolCall {
  name: string;
  input: Record<string, unknown>;
}

/** The arguments that say what a call did, most telling first. */
const TOOL_ARGS = [
  'file_path',
  'notebook_path',
  'path',
  'target_file',
  'filePath',
  'command',
  'pattern',
  'query',
  'url',
  'description',
  'prompt',
];

/** A tool call as one short line: its name and the argument that says what it did. */
export function toolCallText(call: ToolCall): string {
  const key = TOOL_ARGS.find((k) => typeof call.input[k] === 'string' && call.input[k] !== '');
  const arg = key ? String(call.input[key]).replace(/\s+/g, ' ').trim() : '';
  const line = arg ? `${call.name} ${arg}` : call.name;
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

/** A tool call from a host's record of one: a block, or a JSON text of `{ name, input }`. */
function toolCallOf(raw: unknown): ToolCall | null {
  let v = raw;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }
  if (!v || typeof v !== 'object') return null;
  const { name, input } = v as { name?: unknown; input?: unknown };
  if (typeof name !== 'string' || !name) return null;
  return {
    name,
    input: input && typeof input === 'object' ? (input as Record<string, unknown>) : {},
  };
}

export interface SessionMeta {
  startTime: string;
  endTime: string;
  cwd: string;
  branch: string;
  messageCount: number;
  /** The prompts (`promptsOf`): 0 for a session nobody asked anything in. */
  userMessageCount: number;
  /** The first prompt, to 200 characters; '' with none. */
  preview: string;
}

// ── Parsing ─────────────────────────────────────────────────────────────────

/**
 * Parse a JSONL session file into an array of entries.
 * Malformed lines are silently skipped.
 */
export function parseSessionFile(filePath: string): SessionEntry[] {
  const entries: SessionEntry[] = [];
  runAll(parseSteps(filePath, entries));
  return entries;
}

/**
 * parseSessionFile without holding the process: a transcript of tens of megabytes is parsed in
 * slices, so the REST holder keeps answering while a snapshot reads it.
 */
export async function readSessionFile(filePath: string): Promise<SessionEntry[]> {
  const entries: SessionEntry[] = [];
  await runSliced(parseSteps(filePath, entries));
  return entries;
}

/** Reads a session (a file, or an adapter's) into `out`, one step per line parsed. */
function* parseSteps(filePath: string, out: SessionEntry[]) {
  // Dispatch virtual descriptors to the appropriate adapter
  for (const adapter of getAvailableAdapters()) {
    if (filePath.startsWith(`${adapter.prefix}://`)) {
      out.push(...adapter.parseSession(filePath));
      return;
    }
  }
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    console.error('[knowledge] read session file:', err instanceof Error ? err.message : err);
    return;
  }
  yield* lineSteps(raw, out);
}

/** The entries of JSONL text into `out`, one step per line; a line that is not JSON is skipped. */
function* lineSteps(raw: string, out: SessionEntry[]) {
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch (err) {
      console.error('[knowledge] parse session line:', err instanceof Error ? err.message : err);
    }
    yield;
  }
}

/** The entries of JSONL text, one per line; a line that is not JSON is skipped. */
function parseLines(raw: string): SessionEntry[] {
  const entries: SessionEntry[] = [];
  runAll(lineSteps(raw, entries));
  return entries;
}

/**
 * The entries a JSONL session file holds from byte `from` on, up to its last complete line,
 * and the byte that line ends at: a live session's file only grows, so what it gained since
 * `from` is read without reading it all again. A last line that is not yet whole JSON (still
 * being written) waits for the next read. Throws when the file cannot be read.
 */
export function readSessionTail(
  filePath: string,
  from = 0,
): { entries: SessionEntry[]; end: number } {
  const fd = fs.openSync(filePath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (size <= from) return { entries: [], end: from };
    const buf = Buffer.alloc(size - from);
    const read = fs.readSync(fd, buf, 0, buf.length, from);
    const last = read > 0 ? buf.lastIndexOf(0x0a, read - 1) : -1;
    const entries = last < 0 ? [] : parseLines(buf.toString('utf-8', 0, last + 1));
    // After the last newline: a finished last line (a file that ends without one), or a line
    // still being written, which does not parse yet and waits for the next read.
    const rest = buf.toString('utf-8', last + 1, read).trim();
    if (rest) {
      try {
        entries.push(JSON.parse(rest) as SessionEntry);
        return { entries, end: from + read };
      } catch {
        /* still being written */
      }
    }
    return { entries, end: from + last + 1 };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Extract structured messages from raw session entries.
 *
 * - User messages: entry.message.content (string or stringified)
 * - Assistant messages: text parts from content array
 * - Tool use / result: content truncated to 500 chars
 */
export function extractMessages(entries: SessionEntry[]): SessionMessage[] {
  const messages: SessionMessage[] = [];

  for (const entry of entries) {
    const ts = entry.timestamp ?? null;
    // Support both `type` (Claude Code) and `role` (Cursor Composer) fields
    const entryType = entry.type ?? entry.role;

    if (entryType === 'user' && entry.message?.content) {
      const results = toolParts(entry.message.content, 'tool_result');
      const content = extractText(entry.message.content);
      if (content) messages.push({ role: 'user', content, timestamp: ts });
      for (const r of results) {
        messages.push({ role: 'tool_result', content: toolResultText(r), timestamp: ts });
      }
      if (!content && results.length === 0) {
        messages.push({
          role: 'user',
          content: JSON.stringify(entry.message.content),
          timestamp: ts,
        });
      }
    } else if (entryType === 'assistant' && entry.message?.content) {
      const content = extractText(entry.message.content);
      if (content) {
        messages.push({ role: 'assistant', content, timestamp: ts });
      }
      // Claude Code nests tool calls in the assistant's content, not as entries of their own.
      for (const u of toolParts(entry.message.content, 'tool_use')) {
        const call = toolCallOf(u);
        if (call)
          messages.push({
            role: 'tool_use',
            content: toolCallText(call),
            timestamp: ts,
            tool: call,
          });
      }
    } else if (entryType === 'tool_use' || entryType === 'tool_result') {
      const content =
        typeof entry.content === 'string'
          ? entry.content
          : typeof entry.message?.content === 'string'
            ? entry.message.content
            : null;

      // A tool call recorded as JSON reads as a line; anything else as it came.
      const call = entryType === 'tool_use' && content ? toolCallOf(content) : null;
      if (call) {
        messages.push({ role: 'tool_use', content: toolCallText(call), timestamp: ts, tool: call });
      } else if (content) {
        messages.push({
          role: entryType as 'tool_use' | 'tool_result',
          content: content.substring(0, 500),
          timestamp: ts,
        });
      }
    }
  }

  return messages;
}

/**
 * What the person asked, in order (`humanText`): their own messages, not what the host wrote in
 * their turn (`isMeta`: a skill's instructions, an image note, a message from another agent;
 * `isCompactSummary`: the summary a compaction left).
 */
export function promptsOf(
  entries: SessionEntry[],
): Array<{ timestamp: string | null; text: string }> {
  return entries.flatMap((e) => {
    if ((e.type ?? e.role) !== 'user' || e.isMeta || e.isCompactSummary) return [];
    const text = humanText(extractText(e.message?.content) ?? '');
    return text ? [{ timestamp: e.timestamp ?? null, text }] : [];
  });
}

/**
 * Extract metadata from session entries (first/last entry, counts, preview).
 */
export function getSessionMeta(entries: SessionEntry[]): SessionMeta {
  if (entries.length === 0) {
    return {
      startTime: 'unknown',
      endTime: 'unknown',
      cwd: 'unknown',
      branch: 'unknown',
      messageCount: 0,
      userMessageCount: 0,
      preview: '',
    };
  }

  // Skip leading metadata-only entries (permission-mode, file-history-snapshot,
  // summary, etc.) which lack a top-level timestamp / cwd / gitBranch. The
  // first entry with a timestamp is the real session start. Mirrors the same
  // fix in fastMeta() — the two code paths used to disagree, leaving the
  // session detail panel showing "unknown / unknown" while the card showed
  // the correct project + branch.
  const firstWithTimestamp = entries.find((e) => e.timestamp);
  const lastWithTimestamp = [...entries].reverse().find((e) => e.timestamp);
  const first = firstWithTimestamp ?? entries[0];
  const last = lastWithTimestamp ?? entries[entries.length - 1];
  const said = promptsOf(entries);

  return {
    startTime: first?.timestamp ?? 'unknown',
    endTime: last?.timestamp ?? 'unknown',
    cwd: first?.cwd ?? 'unknown',
    branch: branchName(first?.gitBranch ?? ''),
    messageCount: entries.length,
    userMessageCount: said.length,
    preview: (said[0]?.text ?? '').substring(0, 200),
  };
}

// ── Discovery ───────────────────────────────────────────────────────────────

/**
 * Discover all session directories under the primary session root and any extra session roots.
 *
 * Extra roots are scanned as follows:
 * - Cursor-style roots (containing `<workspace>/agent-transcripts/`):
 *   Each workspace with an `agent-transcripts/` subdirectory becomes a project
 *   named `cursor-<workspace>`.
 * - Generic roots with subdirectories containing JSONL files:
 *   Each subdirectory becomes a project named `ext-<dirname>`.
 * - Flat roots containing JSONL files directly:
 *   The root itself becomes a single project named after the decoded directory.
 */

/**
 * Decode a Claude Code style project directory name into a human-readable name.
 * e.g. "C--Users-john--my-project" → "my-project"
 *      "C--home-john--repos--app" → "repos/app"
 *      "C--Users-john" → "~"
 * Falls back to the raw name if it doesn't match the expected pattern.
 */
function decodeProjectDirName(dirName: string): string {
  const homeParts = os.homedir().replace(/\\/g, '/').split('/');
  const homeEncoded = homeParts[0].replace(':', '') + '--' + homeParts.slice(1).join('-');

  if (dirName === homeEncoded) return '~';

  if (dirName.startsWith(homeEncoded + '--')) {
    return dirName.slice(homeEncoded.length + 2).replace(/--/g, '/');
  }

  if (dirName.startsWith(homeEncoded + '-')) {
    return dirName.slice(homeEncoded.length + 1).replace(/--/g, '/');
  }

  const parts = dirName.split('--');
  if (parts.length < 2) return dirName;
  return parts[parts.length - 1];
}

export function getProjectDirs(): Array<{ name: string; path: string }> {
  const { sessionsDir, extraSessionRoots } = getConfig();
  const results: Array<{ name: string; path: string }> = [];

  // Primary session root
  if (fs.existsSync(sessionsDir)) {
    for (const d of fs.readdirSync(sessionsDir, { withFileTypes: true })) {
      if (d.isDirectory()) {
        results.push({ name: d.name, path: path.join(sessionsDir, d.name) });
      }
    }
  }

  // Extra session roots
  for (const root of extraSessionRoots) {
    if (!fs.existsSync(root)) continue;

    let subdirs: fs.Dirent[];
    try {
      subdirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch (err) {
      console.error('[knowledge] read session root:', err instanceof Error ? err.message : err);
      continue;
    }

    let addedAny = false;
    for (const d of subdirs) {
      const transcriptsDir = path.join(root, d.name, 'agent-transcripts');
      if (fs.existsSync(transcriptsDir)) {
        results.push({
          name: `cursor-${d.name}`,
          path: transcriptsDir,
        });
        addedAny = true;
        continue;
      }

      // Generic subdirectory: check if it contains JSONL files directly
      const subPath = path.join(root, d.name);
      try {
        const hasJsonl = fs.readdirSync(subPath).some((f) => f.endsWith('.jsonl'));
        if (hasJsonl) {
          results.push({
            name: decodeProjectDirName(d.name),
            path: subPath,
          });
          addedAny = true;
        }
      } catch (err) {
        console.error('[knowledge] read session subdir:', err instanceof Error ? err.message : err);
      }
    }

    // Flat root: if no subdirectories matched, check if the root itself has JSONL files
    if (!addedAny) {
      try {
        const hasJsonl = fs.readdirSync(root).some((f) => f.endsWith('.jsonl'));
        if (hasJsonl) {
          results.push({
            name: decodeProjectDirName(path.basename(root)),
            path: root,
          });
        }
      } catch (err) {
        console.error('[knowledge] read flat root:', err instanceof Error ? err.message : err);
      }
    }
  }

  // Discover sessions from additional adapters (OpenCode)
  for (const adapter of getAvailableAdapters()) {
    try {
      results.push(...adapter.discoverProjects());
    } catch (err) {
      console.error('[knowledge] adapter discover:', err instanceof Error ? err.message : err);
    }
  }

  return results;
}

/**
 * List all .jsonl session files in a given project directory.
 */
export function getSessionFiles(projectPath: string): Array<{ id: string; file: string }> {
  // Dispatch virtual descriptors to the appropriate adapter
  for (const adapter of getAvailableAdapters()) {
    if (projectPath.startsWith(`${adapter.prefix}://`)) {
      return adapter.listSessions(projectPath);
    }
  }

  if (!fs.existsSync(projectPath)) return [];

  return fs
    .readdirSync(projectPath)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => ({
      id: f.replace('.jsonl', ''),
      file: path.join(projectPath, f),
    }));
}
