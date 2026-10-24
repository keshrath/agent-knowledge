// =============================================================================
// agent-knowledge — Library API
//
// Public exports for programmatic use. Import from 'agent-knowledge/lib'.
// The default export (index.ts) is the MCP stdio server.
// =============================================================================

// Server factory
export { createServer } from './server.js';

// Configuration
export { getConfig, getConfigLocation, loadPersistedConfig, savePersistedConfig } from './types.js';
export type { KnowledgeConfig, PersistedConfig } from './types.js';

// Knowledge store (CRUD)
export {
  listEntries,
  readEntry,
  writeEntry,
  deleteEntry,
  parseFrontmatter,
  sanitizePath,
  CATEGORIES,
} from './knowledge/store.js';
export type { KnowledgeEntry, Category } from './knowledge/store.js';

// Knowledge search
export { searchKnowledge, invalidateKnowledgeIndexCache } from './knowledge/search.js';
export type {
  SearchOptions as KnowledgeSearchOptions,
  SearchResult as KnowledgeSearchResult,
} from './knowledge/search.js';

// Knowledge graph
export { KnowledgeGraph, getKnowledgeGraph, RELATIONSHIP_TYPES } from './knowledge/graph.js';
export type { RelationshipType, Edge, GraphNode, GraphResult } from './knowledge/graph.js';

// Confidence/decay scoring
export {
  EntryScoring,
  getEntryScoring,
  decayFactor,
  maturityMultiplier,
  computeFinalScore,
} from './knowledge/scoring.js';
export type { EntryScore, Maturity } from './knowledge/scoring.js';

// Consolidation (duplicate detection)
export { checkDuplicates, consolidate } from './knowledge/consolidate.js';
export type {
  DuplicateWarning,
  ConsolidationCluster,
  ConsolidationReport,
} from './knowledge/consolidate.js';

// Reflection
export { reflect } from './knowledge/reflect.js';
export type { UnconnectedEntry, ReflectionResult } from './knowledge/reflect.js';

// Session discovery & parsing
export {
  getProjectDirs,
  getSessionFiles,
  parseSessionFile,
  extractMessages,
  getSessionMeta,
} from './sessions/parser.js';
export type { SessionEntry, SessionMessage, SessionMeta } from './sessions/parser.js';

// Session search
export { searchSessions } from './sessions/search.js';
export type { SearchSessionOptions } from './sessions/search.js';

// Session summaries
export { listSessions, getSessionSummary } from './sessions/summary.js';
export type { SessionSummary } from './sessions/summary.js';

// Scoped search
export { scopedSearch } from './sessions/scopes.js';
export type { SearchScope, ScopedSearchOptions } from './sessions/scopes.js';

// Search primitives
export { TfIdfIndex, recencyDecay } from './search/tfidf.js';
export type { SearchResult, SearchOptions } from './search/types.js';

// Embeddings
export type { EmbeddingProvider, EmbeddingConfig, ProviderName } from './embeddings/types.js';
export { getEmbeddingConfig } from './embeddings/types.js';
export { getEmbeddingProvider, resetProvider } from './embeddings/factory.js';

// Vector store
export { VectorStore } from './vectorstore/store.js';
export type { VectorEntry, VectorSearchResult, VectorStoreStats } from './vectorstore/store.js';
export { chunkKnowledge, chunkSession } from './vectorstore/chunker.js';
export type { Chunk, SessionMessage as ChunkSessionMessage } from './vectorstore/chunker.js';

// Tool handlers
export { toolHandlers, validateArgs, ok, err, SCOPES } from './tool-handlers.js';
export type { ToolResult, ToolHandler } from './tool-handlers.js';

// Validation
export {
  ValidationError,
  requireString,
  optionalString,
  optionalNumber,
  optionalBoolean,
  requireEnum,
  optionalEnum,
  validateFilename,
} from './validate.js';
