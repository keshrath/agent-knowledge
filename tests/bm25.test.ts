import { describe, it, expect, beforeEach } from 'vitest';
import { BM25Index } from '../src/search/bm25.js';

describe('BM25Index', () => {
  let index: BM25Index;

  beforeEach(() => {
    index = new BM25Index();
  });

  it('tokenizes text and removes stopwords', () => {
    index.addDocument('doc1', 'The Quick Brown Fox Jumps Over The Lazy Dog');
    const results = index.search('quick brown fox');
    expect(results.length).toBe(1);
    expect(results[0].id).toBe('doc1');
    expect(results[0].score).toBeGreaterThan(0);
  });

  it('ranks the most relevant document first', () => {
    index.addDocument('doc1', 'javascript is a programming language');
    index.addDocument('doc2', 'typescript typescript typescript is great for typed programming');
    index.addDocument('doc3', 'python is also a language');
    const results = index.search('typescript');
    expect(results[0].id).toBe('doc2');
  });

  it('prefers shorter docs that match (length normalization)', () => {
    index.addDocument('short', 'database connection pooling');
    index.addDocument('long', 'database connection pooling ' + 'unrelated text '.repeat(100));
    const results = index.search('database connection pooling');
    expect(results[0].id).toBe('short');
  });

  it('returns empty results for an empty query', () => {
    index.addDocument('doc1', 'content here');
    expect(index.search('')).toEqual([]);
  });

  it('clears state', () => {
    index.addDocument('doc1', 'hello world');
    index.clear();
    expect(index.search('hello')).toEqual([]);
  });

  it('handles re-adding a document with the same ID', () => {
    index.addDocument('doc1', 'old content about databases');
    index.addDocument('doc1', 'new content about networking');
    const old = index.search('databases');
    const fresh = index.search('networking');
    expect(old.length).toBe(0);
    expect(fresh.length).toBe(1);
  });

  it('respects maxResults', () => {
    for (let i = 0; i < 10; i++) {
      index.addDocument(`doc${i}`, `topic alpha beta ${i}`);
    }
    const results = index.search('alpha', 3);
    expect(results.length).toBe(3);
  });

  it('returns no results when no terms match', () => {
    index.addDocument('doc1', 'cats and dogs');
    expect(index.search('zebra').length).toBe(0);
  });

  it('handles special chars in the query gracefully', () => {
    index.addDocument('doc1', 'error handling with try catch');
    const results = index.search('error!!! @#$ handling???');
    expect(results.length).toBe(1);
    expect(results[0].id).toBe('doc1');
  });
});
