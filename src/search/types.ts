export interface SearchResult {
  source: 'session' | 'knowledge';
  id: string;
  project?: string;
  /** A session hit's project as a person names it (its folder), not the store's slug. */
  name?: string;
  title?: string;
  role?: string;
  timestamp?: string;
  excerpt: string;
  score: number;
  metadata?: Record<string, unknown>;
}

export interface SearchOptions {
  query: string;
  maxResults?: number;
  caseSensitive?: boolean;
  fuzzy?: boolean;
  fuzzyThreshold?: number;
}
