import type { EmbeddingProvider, EmbeddingConfig } from './types.js';
import { getEmbeddingConfig } from './types.js';

let _instance: EmbeddingProvider | null = null;
let _instanceProvider: string | null = null;

/**
 * Get or create the embedding provider based on config.
 * Returns null if the requested provider is unavailable.
 */
export async function getEmbeddingProvider(
  config?: EmbeddingConfig,
): Promise<EmbeddingProvider | null> {
  const cfg = config ?? getEmbeddingConfig();

  if (_instance && _instanceProvider === cfg.provider) return _instance;

  _instance = await createProvider(cfg);
  _instanceProvider = cfg.provider;
  return _instance;
}

async function createProvider(cfg: EmbeddingConfig): Promise<EmbeddingProvider | null> {
  switch (cfg.provider) {
    case 'local': {
      const { LocalEmbeddingProvider } = await import('./local.js');
      const idleEnv = process.env.AGENT_KNOWLEDGE_EMBEDDING_IDLE_TIMEOUT;
      const idleTimeoutMs = idleEnv !== undefined ? parseInt(idleEnv, 10) * 1000 : 60_000;
      const provider = new LocalEmbeddingProvider(cfg.modelOverride, undefined, idleTimeoutMs);
      if (await provider.isAvailable()) return provider;
      console.error('[knowledge] Local embedding model unavailable');
      return null;
    }
    case 'openai': {
      if (!cfg.openaiApiKey) {
        console.error('[knowledge] KNOWLEDGE_OPENAI_API_KEY not set');
        return null;
      }
      const { OpenAIEmbeddingProvider } = await import('./openai.js');
      return new OpenAIEmbeddingProvider(cfg.openaiApiKey, cfg.modelOverride);
    }
    case 'claude': {
      if (!cfg.anthropicApiKey) {
        console.error('[knowledge] KNOWLEDGE_ANTHROPIC_API_KEY not set');
        return null;
      }
      const { AnthropicEmbeddingProvider } = await import('./anthropic.js');
      return new AnthropicEmbeddingProvider(cfg.anthropicApiKey, cfg.modelOverride);
    }
    case 'gemini': {
      if (!cfg.geminiApiKey) {
        console.error('[knowledge] KNOWLEDGE_GEMINI_API_KEY not set');
        return null;
      }
      const { GeminiEmbeddingProvider } = await import('./gemini.js');
      return new GeminiEmbeddingProvider(cfg.geminiApiKey, cfg.modelOverride);
    }
    default:
      console.error(`[knowledge] Unknown provider: ${cfg.provider}`);
      return null;
  }
}

/** Reset cached instance (used when switching providers). */
export function resetProvider(): void {
  _instance = null;
  _instanceProvider = null;
}
