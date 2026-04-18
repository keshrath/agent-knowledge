import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('getEmbeddingConfig', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
  });

  it('defaults to local provider when no env vars set', async () => {
    delete process.env.AGENT_KNOWLEDGE_EMBEDDING_PROVIDER;
    delete process.env.AGENT_KNOWLEDGE_EMBEDDING_ALPHA;
    delete process.env.AGENT_KNOWLEDGE_OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.AGENT_KNOWLEDGE_ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.AGENT_KNOWLEDGE_GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.AGENT_KNOWLEDGE_EMBEDDING_MODEL;

    const { getEmbeddingConfig } = await import('../src/embeddings/types.js');
    const config = getEmbeddingConfig();
    expect(config.provider).toBe('local');
    expect(config.alpha).toBeCloseTo(0.3);
    // With no env vars, API keys and model override should all be absent
    expect(config).not.toHaveProperty('openaiApiKey', expect.any(String));
    expect(config.openaiApiKey).toBeUndefined();
    expect(config).not.toHaveProperty('anthropicApiKey', expect.any(String));
    expect(config.anthropicApiKey).toBeUndefined();
    expect(config).not.toHaveProperty('geminiApiKey', expect.any(String));
    expect(config.geminiApiKey).toBeUndefined();
    expect(config.modelOverride).toBeUndefined();
    // Verify the full default config shape
    expect(config).toEqual({
      provider: 'local',
      alpha: expect.closeTo(0.3),
      openaiApiKey: undefined,
      anthropicApiKey: undefined,
      geminiApiKey: undefined,
      modelOverride: undefined,
    });
  });

  it('reads provider from AGENT_KNOWLEDGE_EMBEDDING_PROVIDER', async () => {
    process.env.AGENT_KNOWLEDGE_EMBEDDING_PROVIDER = 'openai';
    const { getEmbeddingConfig } = await import('../src/embeddings/types.js');
    const config = getEmbeddingConfig();
    expect(config.provider).toBe('openai');
  });

  it('reads alpha from AGENT_KNOWLEDGE_EMBEDDING_ALPHA', async () => {
    process.env.AGENT_KNOWLEDGE_EMBEDDING_ALPHA = '0.7';
    const { getEmbeddingConfig } = await import('../src/embeddings/types.js');
    const config = getEmbeddingConfig();
    expect(config.alpha).toBeCloseTo(0.7);
  });

  it('reads openai key from AGENT_KNOWLEDGE_OPENAI_API_KEY', async () => {
    process.env.AGENT_KNOWLEDGE_OPENAI_API_KEY = 'sk-test-123';
    const { getEmbeddingConfig } = await import('../src/embeddings/types.js');
    const config = getEmbeddingConfig();
    expect(config.openaiApiKey).toBe('sk-test-123');
  });

  it('falls back to OPENAI_API_KEY if AGENT_KNOWLEDGE_OPENAI_API_KEY not set', async () => {
    delete process.env.AGENT_KNOWLEDGE_OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-fallback';
    const { getEmbeddingConfig } = await import('../src/embeddings/types.js');
    const config = getEmbeddingConfig();
    expect(config.openaiApiKey).toBe('sk-fallback');
  });

  it('reads claude key from AGENT_KNOWLEDGE_ANTHROPIC_API_KEY', async () => {
    process.env.AGENT_KNOWLEDGE_ANTHROPIC_API_KEY = 'sk-ant-test';
    const { getEmbeddingConfig } = await import('../src/embeddings/types.js');
    const config = getEmbeddingConfig();
    expect(config.anthropicApiKey).toBe('sk-ant-test');
  });

  it('falls back to ANTHROPIC_API_KEY if AGENT_KNOWLEDGE_ANTHROPIC_API_KEY not set', async () => {
    delete process.env.AGENT_KNOWLEDGE_ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-fallback';
    const { getEmbeddingConfig } = await import('../src/embeddings/types.js');
    const config = getEmbeddingConfig();
    expect(config.anthropicApiKey).toBe('sk-ant-fallback');
  });

  it('reads gemini key from AGENT_KNOWLEDGE_GEMINI_API_KEY', async () => {
    process.env.AGENT_KNOWLEDGE_GEMINI_API_KEY = 'AIza-test';
    const { getEmbeddingConfig } = await import('../src/embeddings/types.js');
    const config = getEmbeddingConfig();
    expect(config.geminiApiKey).toBe('AIza-test');
  });

  it('reads model override from AGENT_KNOWLEDGE_EMBEDDING_MODEL', async () => {
    process.env.AGENT_KNOWLEDGE_EMBEDDING_MODEL = 'custom-model-v2';
    const { getEmbeddingConfig } = await import('../src/embeddings/types.js');
    const config = getEmbeddingConfig();
    expect(config.modelOverride).toBe('custom-model-v2');
  });
});

describe('getEmbeddingProvider', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('returns null for openai when no API key is set', async () => {
    const { getEmbeddingProvider, resetProvider } = await import('../src/embeddings/factory.js');
    resetProvider();
    const provider = await getEmbeddingProvider({
      provider: 'openai',
      alpha: 0.3,
      openaiApiKey: undefined,
    });
    expect(provider).toBeNull();
  });

  it('returns null for claude when no API key is set', async () => {
    const { getEmbeddingProvider, resetProvider } = await import('../src/embeddings/factory.js');
    resetProvider();
    const provider = await getEmbeddingProvider({
      provider: 'claude',
      alpha: 0.3,
      anthropicApiKey: undefined,
    });
    expect(provider).toBeNull();
  });

  it('returns null for gemini when no API key is set', async () => {
    const { getEmbeddingProvider, resetProvider } = await import('../src/embeddings/factory.js');
    resetProvider();
    const provider = await getEmbeddingProvider({
      provider: 'gemini',
      alpha: 0.3,
      geminiApiKey: undefined,
    });
    expect(provider).toBeNull();
  });

  it('returns null for unknown provider', async () => {
    const { getEmbeddingProvider, resetProvider } = await import('../src/embeddings/factory.js');
    resetProvider();
    const provider = await getEmbeddingProvider({
      provider: 'nonexistent' as unknown as import('../src/embeddings/types.js').ProviderName,
      alpha: 0.3,
    });
    expect(provider).toBeNull();
  });
});

describe('LocalEmbeddingProvider', () => {
  it('has correct default name, dimensions, and model', async () => {
    const { LocalEmbeddingProvider } = await import('../src/embeddings/local.js');
    const provider = new LocalEmbeddingProvider();
    expect(provider.name).toBe('local');
    expect(provider.dimensions).toBe(384);
    expect(provider.model).toBe('Xenova/all-MiniLM-L6-v2');
  });

  it('accepts a model override', async () => {
    const { LocalEmbeddingProvider } = await import('../src/embeddings/local.js');
    const provider = new LocalEmbeddingProvider('custom/model');
    expect(provider.model).toBe('custom/model');
    expect(provider.dimensions).toBe(384);
  });
});

describe('OpenAIEmbeddingProvider', () => {
  it('has correct default name, dimensions, and model', async () => {
    const { OpenAIEmbeddingProvider } = await import('../src/embeddings/openai.js');
    const provider = new OpenAIEmbeddingProvider('sk-test');
    expect(provider.name).toBe('openai');
    expect(provider.dimensions).toBe(1536);
    expect(provider.model).toBe('text-embedding-3-small');
  });

  it('accepts a model override', async () => {
    const { OpenAIEmbeddingProvider } = await import('../src/embeddings/openai.js');
    const provider = new OpenAIEmbeddingProvider('sk-test', 'text-embedding-3-large');
    expect(provider.model).toBe('text-embedding-3-large');
  });
});

describe('AnthropicEmbeddingProvider', () => {
  it('has correct default name, dimensions, and model', async () => {
    const { AnthropicEmbeddingProvider } = await import('../src/embeddings/anthropic.js');
    const provider = new AnthropicEmbeddingProvider('sk-ant-test');
    expect(provider.name).toBe('claude');
    expect(provider.dimensions).toBe(512);
    expect(provider.model).toBe('voyage-3-lite');
  });

  it('accepts a model override', async () => {
    const { AnthropicEmbeddingProvider } = await import('../src/embeddings/anthropic.js');
    const provider = new AnthropicEmbeddingProvider('sk-ant-test', 'voyage-3');
    expect(provider.model).toBe('voyage-3');
  });
});

describe('GeminiEmbeddingProvider', () => {
  it('has correct default name, dimensions, and model', async () => {
    const { GeminiEmbeddingProvider } = await import('../src/embeddings/gemini.js');
    const provider = new GeminiEmbeddingProvider('AIza-test');
    expect(provider.name).toBe('gemini');
    expect(provider.dimensions).toBe(768);
    expect(provider.model).toBe('text-embedding-004');
  });

  it('accepts a model override', async () => {
    const { GeminiEmbeddingProvider } = await import('../src/embeddings/gemini.js');
    const provider = new GeminiEmbeddingProvider('AIza-test', 'text-embedding-005');
    expect(provider.model).toBe('text-embedding-005');
  });
});
