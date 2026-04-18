import { describe, it, expect } from 'vitest';
import { buildExcerpt } from '../src/search/excerpt.js';

describe('buildExcerpt', () => {
  it('returns excerpt centred on the first match with context before AND after', () => {
    const text = 'The quick brown fox jumps over the lazy dog';
    const excerpt = buildExcerpt(text, 'fox');
    expect(excerpt).toContain('fox');
    // Context on both sides is the actual contract — a broken implementation
    // that returns only the match or only the suffix would pass toContain('fox').
    expect(excerpt).toMatch(/brown.*fox/i); // preceding word
    expect(excerpt).toMatch(/fox.*jumps/i); // following word
    expect(excerpt.length).toBeLessThanOrEqual(text.length);
  });

  it('returns first 300 chars when no match found', () => {
    const text = 'a'.repeat(500);
    const excerpt = buildExcerpt(text, 'zzzzz');
    expect(excerpt.length).toBeLessThanOrEqual(303); // 300 + '...'
    expect(excerpt.endsWith('...')).toBe(true);
  });

  it('returns full text when short and no match', () => {
    const text = 'short text';
    const excerpt = buildExcerpt(text, 'zzzzz');
    expect(excerpt).toBe('short text');
  });

  it('is case-insensitive by default', () => {
    const text = 'Hello World HELLO world';
    const excerpt = buildExcerpt(text, 'hello');
    expect(excerpt).toContain('Hello');
  });

  it('respects caseSensitive option', () => {
    const text = 'Start hello middle Hello end';
    const sensitive = buildExcerpt(text, 'Hello', { caseSensitive: true });
    expect(sensitive).toContain('Hello');
  });

  it('uses custom context sizes', () => {
    const prefix = 'A'.repeat(200);
    const suffix = 'B'.repeat(200);
    const text = prefix + 'MATCH' + suffix;

    const excerpt = buildExcerpt(text, 'MATCH', { contextBefore: 10, contextAfter: 10 });
    // Should be much shorter than full text
    expect(excerpt.length).toBeLessThan(text.length);
    expect(excerpt).toContain('MATCH');
  });

  it('handles empty text', () => {
    expect(buildExcerpt('', 'test')).toBe('');
  });

  it('handles empty query', () => {
    const result = buildExcerpt('some text', '');
    expect(result).toBe('some text');
  });

  it('handles regex special chars in query', () => {
    const text = 'Testing [brackets] and (parens)';
    const excerpt = buildExcerpt(text, '[brackets]');
    expect(excerpt).toContain('[brackets]');
  });

  it('adds ellipsis prefix when excerpt starts mid-text', () => {
    const text = 'A'.repeat(200) + 'MATCH' + 'B'.repeat(50);
    const excerpt = buildExcerpt(text, 'MATCH');
    expect(excerpt.startsWith('...')).toBe(true);
  });

  it('adds ellipsis suffix when excerpt ends before end of text', () => {
    const text = 'A'.repeat(10) + 'MATCH' + 'B'.repeat(500);
    const excerpt = buildExcerpt(text, 'MATCH');
    expect(excerpt.endsWith('...')).toBe(true);
  });

  it('no ellipsis when match is near start and text is short', () => {
    const text = 'MATCH followed by some text';
    const excerpt = buildExcerpt(text, 'MATCH');
    expect(excerpt.startsWith('...')).toBe(false);
  });
});
