/**
 * Text chunking utilities for preparing content for embedding models.
 *
 * Two strategies:
 * - Knowledge chunking: splits on markdown headers and paragraph breaks
 * - Session chunking: treats each message as a natural chunk boundary
 */

/** A single chunk of text ready for embedding. */
export interface Chunk {
  index: number;
  text: string;
  metadata?: Record<string, unknown>;
}

/** A session message to be chunked. */
export interface SessionMessage {
  role: string;
  text: string;
  timestamp?: string;
  sessionId?: string;
}

const DEFAULT_MAX_CHARS = 2000;
const DEFAULT_OVERLAP = 200;
/** Default minimum chunk size — drop chunks shorter than this when filtering. */
export const DEFAULT_MIN_CHUNK_SIZE = 30;

export interface ChunkSessionOptions {
  maxChars?: number;
  /**
   * Drop chunks whose text length (after the role prefix) is below this many chars.
   * Default 0 (no filtering) for backwards compatibility with the legacy
   * positional-arg call form. Pass 30 (DEFAULT_MIN_CHUNK_SIZE) to filter out
   * low-signal acks and noise.
   */
  minChunkSize?: number;
}

/**
 * Strip YAML frontmatter delimited by `---\n...\n---` from the start of text.
 */
function stripFrontmatter(text: string): string {
  const match = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return match ? text.slice(match[0].length) : text;
}

/**
 * Normalize whitespace: collapse runs of 3+ newlines to 2, trim each line,
 * but preserve single blank lines (paragraph structure).
 */
function normalizeWhitespace(text: string): string {
  return text
    .replace(/[ \t]+$/gm, '')
    .replace(/^[ \t]+/gm, (m) => m)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Split text at a clean boundary (paragraph, sentence, or word) near maxChars.
 * Returns [before, after].
 */
function splitAtBoundary(text: string, maxChars: number): [string, string] {
  if (text.length <= maxChars) return [text, ''];

  const doubleNewline = text.lastIndexOf('\n\n', maxChars);
  if (doubleNewline > maxChars * 0.3) {
    return [text.slice(0, doubleNewline).trimEnd(), text.slice(doubleNewline).trimStart()];
  }

  const sentenceEnd = text.slice(0, maxChars).search(/[.!?]\s+(?=[A-Z])[^]*$/);
  if (sentenceEnd > maxChars * 0.3) {
    const splitPos = sentenceEnd + 1;
    return [text.slice(0, splitPos).trimEnd(), text.slice(splitPos).trimStart()];
  }

  const lastSpace = text.lastIndexOf(' ', maxChars);
  if (lastSpace > maxChars * 0.3) {
    return [text.slice(0, lastSpace).trimEnd(), text.slice(lastSpace).trimStart()];
  }

  return [text.slice(0, maxChars), text.slice(maxChars)];
}

/**
 * Split a long text into chunks of approximately maxChars with overlap.
 * Used internally when a single section exceeds the limit.
 */
function splitWithOverlap(text: string, maxChars: number, overlap: number): string[] {
  // Clamp overlap to at most half of maxChars to prevent infinite loops
  const safeOverlap = Math.min(overlap, Math.floor(maxChars / 2));
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxChars) {
      chunks.push(remaining);
      break;
    }

    const [chunk, rest] = splitAtBoundary(remaining, maxChars);
    chunks.push(chunk);

    if (rest.length === 0) break;
    const overlapStart = Math.max(0, chunk.length - safeOverlap);
    const overlapText = text.slice(
      text.length - remaining.length + overlapStart,
      text.length - remaining.length + chunk.length,
    );
    remaining = overlapText.length > 0 && safeOverlap > 0 ? overlapText + ' ' + rest : rest;

    if (remaining.length >= text.length) {
      remaining = rest;
    }
  }

  return chunks;
}

/**
 * Chunk a knowledge-base document (typically markdown).
 *
 * Strategy:
 * 1. Split on markdown headers (## and above)
 * 2. Within each section, split on paragraph breaks if still too long
 * 3. Apply character overlap between chunks for context continuity
 * 4. Short texts (< maxChars/2) are returned as a single chunk
 *
 * @param text - The full document text
 * @param maxChars - Maximum characters per chunk (default 2000, ~500 tokens)
 * @returns Array of chunks with index and text
 */
export function chunkKnowledge(text: string, maxChars: number = DEFAULT_MAX_CHARS): Chunk[] {
  const stripped = stripFrontmatter(text);
  const normalized = normalizeWhitespace(stripped);
  if (normalized.length === 0) return [];

  if (normalized.length < maxChars / 2) {
    return [{ index: 0, text: normalized }];
  }

  const headerPattern = /^(?=#{1,4}\s)/m;
  const sections = normalized.split(headerPattern).filter((s) => s.trim().length > 0);

  const chunks: Chunk[] = [];
  let chunkIndex = 0;

  for (const section of sections) {
    const trimmed = section.trim();
    if (trimmed.length === 0) continue;

    if (trimmed.length <= maxChars) {
      chunks.push({ index: chunkIndex++, text: trimmed });
    } else {
      const subChunks = splitWithOverlap(trimmed, maxChars, DEFAULT_OVERLAP);
      for (const sub of subChunks) {
        if (sub.trim().length > 0) {
          chunks.push({ index: chunkIndex++, text: sub.trim() });
        }
      }
    }
  }

  return chunks;
}

/**
 * Chunk session messages for embedding.
 *
 * Strategy:
 * - Each message is a natural chunk (role + text)
 * - Messages exceeding maxChars are split at sentence/word boundaries
 * - Timestamp and role are included as metadata
 *
 * @param messages - Array of session messages
 * @param maxChars - Maximum characters per chunk (default 2000)
 * @returns Array of chunks with index, text, and metadata
 */
export function chunkSession(
  messages: SessionMessage[],
  optsOrMaxChars: number | ChunkSessionOptions = DEFAULT_MAX_CHARS,
): Chunk[] {
  const opts: ChunkSessionOptions =
    typeof optsOrMaxChars === 'number' ? { maxChars: optsOrMaxChars } : optsOrMaxChars;
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const minChunkSize = opts.minChunkSize ?? 0;

  const chunks: Chunk[] = [];
  let chunkIndex = 0;

  for (const msg of messages) {
    const text = normalizeWhitespace(msg.text);
    if (text.length === 0) continue;
    if (minChunkSize > 0 && text.length < minChunkSize) continue;

    const prefix = `[${msg.role}]: `;
    const metadata: Record<string, unknown> = { role: msg.role };
    if (msg.timestamp) metadata.timestamp = msg.timestamp;
    if (msg.sessionId) metadata.sessionId = msg.sessionId;

    const fullText = prefix + text;

    if (fullText.length <= maxChars) {
      chunks.push({ index: chunkIndex++, text: fullText, metadata });
    } else {
      const subChunks = splitWithOverlap(fullText, maxChars, 0);
      for (let i = 0; i < subChunks.length; i++) {
        const sub = subChunks[i].trim();
        if (sub.length > 0) {
          chunks.push({
            index: chunkIndex++,
            text: sub,
            metadata: { ...metadata, part: i },
          });
        }
      }
    }
  }

  return chunks;
}
