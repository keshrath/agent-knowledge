import { tokenize } from './bm25.js';
import { withoutControls } from '../text.js';

/**
 * Shared excerpt-building utility.
 *
 * Extracts a window of text around the first occurrence of `query`,
 * with configurable context on each side.
 */
export function buildExcerpt(
  raw: string,
  query: string,
  options: { contextBefore?: number; contextAfter?: number; caseSensitive?: boolean } = {},
): string {
  const { contextBefore = 100, contextAfter = 100, caseSensitive = false } = options;
  const text = withoutControls(raw);

  if (!text) return '';
  if (!query) return text.substring(0, 300) + (text.length > 300 ? '...' : '');

  let idx: number;
  try {
    idx = text.search(new RegExp(query, caseSensitive ? '' : 'i'));
  } catch (err) {
    console.error('[knowledge] excerpt regex:', err instanceof Error ? err.message : err);
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    idx = text.search(new RegExp(escaped, caseSensitive ? '' : 'i'));
  }

  // Not there as one phrase (the usual case for a question): centred on the first word of the
  // query that is, so the excerpt shows why it matched.
  if (idx === -1) idx = firstWordAt(text, query, caseSensitive);
  if (idx === -1) {
    return text.substring(0, 300) + (text.length > 300 ? '...' : '');
  }

  const start = Math.max(0, idx - contextBefore);
  const end = Math.min(text.length, idx + query.length + contextAfter);

  return (
    (start > 0 ? '...' : '') + text.substring(start, end).trim() + (end < text.length ? '...' : '')
  );
}

/** Where the first of the query's words (as the index ranks them) starts a word in `text`; -1 when none. */
function firstWordAt(text: string, query: string, caseSensitive: boolean): number {
  const at = tokenize(query)
    .filter((w) => w.length >= 3)
    .map((w) => {
      // The tokenizer leaves letters and digits alone: a word is its own pattern.
      return text.search(new RegExp(`\\b${w}`, caseSensitive ? '' : 'i'));
    })
    .filter((i) => i >= 0);
  return at.length ? Math.min(...at) : -1;
}
