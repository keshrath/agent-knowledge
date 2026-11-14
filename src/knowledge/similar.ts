import { getEmbeddingProvider } from '../embeddings/index.js';
import { getVectorStore } from '../sessions/indexer.js';
import { askedAbout } from './search.js';

/** How long a first prompt waits for the embedding model: a cold one is left for the next. */
const MODEL_WAIT_MS = 1_500;

/**
 * The provider whose closeness the rule's dials were measured on (tests/first-prompt-eval):
 * the local model. Another's cosines lie elsewhere, so it adds nothing until measured.
 */
const MEASURED = 'local';

let cache: { key: string; stamp: string; vectors: Map<string, Float32Array[]> } | null = null;

/**
 * How close in meaning each curated entry is to a prompt: the cosine of its closest chunk,
 * from the embeddings the indexer keeps (the first-prompt rule's second judge, `similar`).
 * Null without them: another provider, no entry embedded, or the model not answering in time.
 */
export async function promptSimilarity(
  prompt: string,
  waitMs = MODEL_WAIT_MS,
): Promise<Map<string, number> | null> {
  const asked = (async () => {
    const provider = await getEmbeddingProvider();
    if (provider?.name !== MEASURED) return null;
    return { name: provider.name, v: await provider.embedOne(askedAbout(prompt)) };
  })().catch(() => null);
  const got = await Promise.race([
    asked,
    new Promise<null>((r) => setTimeout(() => r(null), waitMs).unref()),
  ]);
  if (!got || got.v.length === 0) return null;
  const { name, v } = got;
  const key = `${name}:${v.length}`;
  const fresh = getVectorStore().knowledgeVectors(
    name,
    v.length,
    cache?.key === key ? cache.stamp : undefined,
  );
  if (fresh) cache = { key, ...fresh };
  if (!cache || cache.vectors.size === 0) return null;
  const similar = new Map<string, number>();
  for (const [id, chunks] of cache.vectors) {
    let best = -1;
    for (const c of chunks) {
      let dot = 0;
      for (let i = 0; i < c.length; i++) dot += c[i]! * v[i]!;
      if (dot > best) best = dot;
    }
    similar.set(id, best);
  }
  return similar;
}
