import { getEmbeddingProvider } from '../embeddings/index.js';
import { VectorStore, chunkKnowledge, chunkSession } from '../vectorstore/index.js';
import type { VectorEntry } from '../vectorstore/index.js';
import type { SessionMessage } from '../vectorstore/chunker.js';
import { listEntries, readEntry } from '../knowledge/store.js';
import {
  getProjectDirs,
  getSessionFiles,
  parseSessionFile,
  extractMessages,
  getSessionMeta,
} from './parser.js';
import { getConfig } from '../types.js';
import { promote } from '../knowledge/promote.js';

let _vectorStore: VectorStore | null = null;

function getVectorStore(): VectorStore {
  if (!_vectorStore) {
    _vectorStore = new VectorStore();
  }
  return _vectorStore;
}

/**
 * Index a single knowledge entry into the vector store.
 */
export async function indexKnowledgeEntry(path: string, content: string): Promise<void> {
  const provider = await getEmbeddingProvider();
  if (!provider) return;

  const store = getVectorStore();
  const chunks = chunkKnowledge(content);
  if (chunks.length === 0) return;

  const texts = chunks.map((c) => c.text);
  const embeddings = await provider.embed(texts);

  const entries: VectorEntry[] = chunks.map((chunk, i) => ({
    id: `knowledge:${path}:${chunk.index}`,
    source: 'knowledge' as const,
    sourceId: path,
    chunkIndex: chunk.index,
    chunkText: chunk.text,
    provider: provider.name,
    dimensions: provider.dimensions,
    embedding: embeddings[i],
    metadata: chunk.metadata,
  }));

  store.upsert(entries);
}

/**
 * Index session messages into the vector store.
 *
 * Honors `config.indexVerbatim` — when false, the verbatim per-message
 * chunking is skipped (auto-distillation still runs separately).
 */
export async function indexSessionMessages(
  sessionId: string,
  messages: SessionMessage[],
): Promise<void> {
  const provider = await getEmbeddingProvider();
  if (!provider) return;

  const config = getConfig();
  if (!config.indexVerbatim) return;

  const store = getVectorStore();
  // Filter very short messages (< 30 chars) — they tend to be ack-noise
  // like "ok" or "thanks" with no retrieval signal.
  const chunks = chunkSession(messages, { minChunkSize: 30 });
  if (chunks.length === 0) return;

  const texts = chunks.map((c) => c.text);
  const embeddings = await provider.embed(texts);

  const entries: VectorEntry[] = chunks.map((chunk, i) => ({
    id: `session:${sessionId}:${chunk.index}`,
    source: 'session' as const,
    sourceId: sessionId,
    chunkIndex: chunk.index,
    chunkText: chunk.text,
    provider: provider.name,
    dimensions: provider.dimensions,
    embedding: embeddings[i],
    metadata: chunk.metadata,
  }));

  store.upsert(entries);
}

/**
 * Background indexer that embeds all unindexed knowledge entries and session
 * messages. Runs non-blocking after server startup.
 */
export async function backgroundIndex(): Promise<void> {
  const provider = await getEmbeddingProvider();
  if (!provider) {
    console.error('[knowledge] No embedding provider available, skipping background index');
    return;
  }

  const store = getVectorStore();
  const wiped = store.setProvider(provider.name, provider.dimensions);
  if (wiped) {
    console.error('[knowledge] Embedding provider changed, wiped existing vectors');
  }

  const config = getConfig();

  // ── Index knowledge entries ─────────────────────────────────────────────

  try {
    const entries = listEntries(config.memoryDir);
    let indexed = 0;
    const total = entries.length;

    for (const entry of entries) {
      try {
        if (store.hasEmbeddings(entry.path)) {
          indexed++;
          continue;
        }

        const { content } = readEntry(config.memoryDir, entry.path);
        await indexKnowledgeEntry(entry.path, content);
        indexed++;

        if (indexed % 10 === 0 || indexed === total) {
          console.error(`[knowledge] Indexed ${indexed}/${total} knowledge entries...`);
        }

        await new Promise((r) => setTimeout(r, 2000));
      } catch (err) {
        console.error(`[knowledge] Failed to index knowledge entry ${entry.path}: ${err}`);
      }
    }

    if (total > 0) {
      console.error(`[knowledge] Knowledge indexing complete: ${indexed}/${total}`);
    }
  } catch (err) {
    console.error(`[knowledge] Knowledge indexing failed: ${err}`);
  }

  // ── Index session messages ──────────────────────────────────────────────

  try {
    const projects = getProjectDirs();
    let totalSessions = 0;
    let indexedSessions = 0;

    for (const proj of projects) {
      const sessions = getSessionFiles(proj.path);
      totalSessions += sessions.length;
    }

    for (const proj of projects) {
      const sessions = getSessionFiles(proj.path);

      for (const sess of sessions) {
        try {
          if (store.hasEmbeddings(sess.id)) {
            indexedSessions++;
            continue;
          }

          const entries = parseSessionFile(sess.file);
          if (entries.length === 0) {
            indexedSessions++;
            continue;
          }

          const meta = getSessionMeta(entries);
          const messages = extractMessages(entries);

          const sessionMessages: SessionMessage[] = messages.map((m) => ({
            role: m.role,
            text: m.content,
            timestamp: m.timestamp ?? meta.startTime,
            sessionId: sess.id,
          }));

          await indexSessionMessages(sess.id, sessionMessages);
          indexedSessions++;

          if (indexedSessions % 20 === 0 || indexedSessions === totalSessions) {
            console.error(`[knowledge] Indexed ${indexedSessions}/${totalSessions} sessions...`);
          }

          // Throttle: 2s pause between sessions to avoid pegging CPU
          await new Promise((r) => setTimeout(r, 2000));
        } catch (err) {
          console.error(`[knowledge] Failed to index session ${sess.id}: ${err}`);
          indexedSessions++;
        }
      }
    }

    if (totalSessions > 0) {
      console.error(`[knowledge] Session indexing complete: ${indexedSessions}/${totalSessions}`);
    }
  } catch (err) {
    console.error(`[knowledge] Session indexing failed: ${err}`);
  }

  console.error('[knowledge] Background indexing complete');

  // ── Auto-promote session insights into knowledge base ───────────────────
  // v1.8.0: the regex-only distiller is replaced by the scored/gated promoter
  // (src/knowledge/promote.ts). Only candidates that clear all three gates
  // (minScore, minRecallCount, minUniqueQueries) land in projects/. Every
  // run drops an audit trail in ~/agent-knowledge/.dreams/YYYY-MM-DD.md.
  const config2 = getConfig();
  if (config2.autoDistill) {
    try {
      console.error('[knowledge] Starting auto-promotion (scored pass)...');
      const result = await promote({ mode: 'apply' });
      const { candidates, passed, promoted, skipped } = result.totals;
      console.error(
        `[knowledge] Promote run: ${candidates} candidate(s), ${passed} passed gates, ${promoted} written, ${skipped} skipped`,
      );
      if (result.diaryPath) {
        console.error(`[knowledge] Dreams diary: ${result.diaryPath}`);
      }
    } catch (err) {
      console.error(`[knowledge] Auto-promotion failed: ${err}`);
    }
  }
}
