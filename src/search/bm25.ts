/**
 * BM25 ranker — Okapi BM25 over a tokenized corpus.
 *
 * Same shape as TfIdfIndex (addDocument / search / clear) so callers can
 * swap rankers via configuration. Tokenizer + stopword list match
 * tfidf.ts so the two rankers are directly comparable on the same corpus.
 */

const STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'but',
  'not',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'have',
  'has',
  'had',
  'having',
  'do',
  'does',
  'did',
  'doing',
  'will',
  'would',
  'could',
  'should',
  'shall',
  'may',
  'might',
  'can',
  'must',
  'to',
  'of',
  'in',
  'for',
  'on',
  'with',
  'at',
  'by',
  'from',
  'as',
  'into',
  'through',
  'during',
  'before',
  'after',
  'above',
  'below',
  'between',
  'out',
  'off',
  'over',
  'under',
  'again',
  'further',
  'then',
  'once',
  'here',
  'there',
  'when',
  'where',
  'why',
  'how',
  'all',
  'each',
  'every',
  'both',
  'few',
  'more',
  'most',
  'other',
  'some',
  'such',
  'no',
  'nor',
  'only',
  'own',
  'same',
  'so',
  'than',
  'too',
  'very',
  'just',
  'about',
  'up',
  'down',
  'if',
  'it',
  'its',
  'he',
  'she',
  'they',
  'them',
  'his',
  'her',
  'their',
  'we',
  'me',
  'him',
  'my',
  'your',
  'our',
  'this',
  'that',
  'these',
  'those',
  'i',
  'you',
  'what',
  'which',
  'who',
  'whom',
  'am',
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0 && !STOPWORDS.has(token));
}

interface DocEntry {
  termFreqs: Map<string, number>;
  length: number;
}

export interface BM25Options {
  k1?: number;
  b?: number;
}

export class BM25Index {
  private docs: Map<string, DocEntry> = new Map();
  private docFreq: Map<string, number> = new Map();
  private invertedIndex: Map<string, Set<string>> = new Map();
  private totalDocs: number = 0;
  private totalLength: number = 0;
  private readonly k1: number;
  private readonly b: number;

  constructor(opts: BM25Options = {}) {
    this.k1 = opts.k1 ?? 1.2;
    this.b = opts.b ?? 0.75;
  }

  addDocument(id: string, text: string): void {
    if (this.docs.has(id)) {
      const existing = this.docs.get(id)!;
      for (const term of existing.termFreqs.keys()) {
        const count = this.docFreq.get(term) ?? 0;
        if (count <= 1) {
          this.docFreq.delete(term);
          this.invertedIndex.delete(term);
        } else {
          this.docFreq.set(term, count - 1);
          this.invertedIndex.get(term)?.delete(id);
        }
      }
      this.totalDocs--;
      this.totalLength -= existing.length;
    }

    const tokens = tokenize(text);
    const termFreqs = new Map<string, number>();
    for (const token of tokens) {
      termFreqs.set(token, (termFreqs.get(token) ?? 0) + 1);
    }

    this.docs.set(id, { termFreqs, length: tokens.length });

    for (const term of termFreqs.keys()) {
      this.docFreq.set(term, (this.docFreq.get(term) ?? 0) + 1);
      if (!this.invertedIndex.has(term)) {
        this.invertedIndex.set(term, new Set());
      }
      this.invertedIndex.get(term)!.add(id);
    }

    this.totalDocs++;
    this.totalLength += tokens.length;
  }

  search(query: string, maxResults?: number): Array<{ id: string; score: number }> {
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0 || this.totalDocs === 0) return [];

    const avgdl = this.totalLength / this.totalDocs;
    const candidates = new Set<string>();
    for (const term of queryTokens) {
      const posting = this.invertedIndex.get(term);
      if (posting) for (const id of posting) candidates.add(id);
    }

    const results: Array<{ id: string; score: number }> = [];
    for (const id of candidates) {
      const doc = this.docs.get(id);
      if (!doc) continue;
      let score = 0;
      for (const term of queryTokens) {
        const tf = doc.termFreqs.get(term) ?? 0;
        if (tf === 0) continue;
        const df = this.docFreq.get(term) ?? 0;
        // BM25 IDF (Robertson-Sparck-Jones, with +1 to avoid negatives)
        const idf = Math.log(1 + (this.totalDocs - df + 0.5) / (df + 0.5));
        const denom = tf + this.k1 * (1 - this.b + this.b * (doc.length / avgdl));
        score += idf * ((tf * (this.k1 + 1)) / denom);
      }
      if (score > 0) results.push({ id, score });
    }

    results.sort((a, b) => b.score - a.score);
    return maxResults && maxResults > 0 ? results.slice(0, maxResults) : results;
  }

  clear(): void {
    this.docs.clear();
    this.docFreq.clear();
    this.invertedIndex.clear();
    this.totalDocs = 0;
    this.totalLength = 0;
  }
}
