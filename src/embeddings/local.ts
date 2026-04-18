import type { EmbeddingProvider } from './types.js';

const DEFAULT_MODEL = 'Xenova/all-MiniLM-L6-v2';
const DEFAULT_DIMENSIONS = 384;
const DEFAULT_BATCH_SIZE = 8;
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
const DEFAULT_NUM_THREADS = 1;

type PipelineFn = (
  texts: string[],
  options: { pooling: string; normalize: boolean },
) => Promise<{ tolist(): number[][]; dispose?: () => void }>;

let _pipeline: PipelineFn | null = null;
let _pipelineLoading: Promise<PipelineFn | null> | null = null;
let _idleTimer: ReturnType<typeof setTimeout> | null = null;
let _idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS;

const _numThreads = parseInt(
  process.env.AGENT_KNOWLEDGE_EMBEDDING_THREADS ?? String(DEFAULT_NUM_THREADS),
  10,
);
process.env.ONNX_NUM_THREADS = String(_numThreads);
process.env.OMP_NUM_THREADS = String(_numThreads);

async function loadPipeline(model: string): Promise<PipelineFn | null> {
  try {
    console.error(
      `[knowledge] Loading embedding model ${model} (quantized, ${_numThreads} thread(s))...`,
    );
    const { pipeline } = await import('@huggingface/transformers');

    const pipe = await pipeline('feature-extraction', model, {
      dtype: 'q8',
      session_options: {
        intraOpNumThreads: _numThreads,
        interOpNumThreads: _numThreads,
      },
    } as Record<string, unknown>);
    console.error(`[knowledge] Embedding model loaded (threads: ${_numThreads})`);
    if (!pipe || typeof pipe !== 'function') {
      throw new Error('Failed to load transformer pipeline');
    }
    return pipe as PipelineFn;
  } catch (err) {
    console.error(`[knowledge] Failed to load embedding model ${model}:`, err);
    return null;
  }
}

function resetIdleTimer(): void {
  if (_idleTimer) clearTimeout(_idleTimer);
  if (_idleTimeoutMs <= 0) return;
  _idleTimer = setTimeout(() => {
    if (_pipeline) {
      console.error('[knowledge] Unloading embedding model (idle timeout)');
      _pipeline = null;
      _pipelineLoading = null;
    }
    _idleTimer = null;
  }, _idleTimeoutMs);
}

export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'local';
  readonly dimensions: number;
  readonly model: string;
  private readonly batchSize: number;

  constructor(modelOverride?: string, batchSize?: number, idleTimeoutMs?: number) {
    this.model = modelOverride || DEFAULT_MODEL;
    this.dimensions = DEFAULT_DIMENSIONS;
    this.batchSize = batchSize ?? DEFAULT_BATCH_SIZE;
    if (idleTimeoutMs !== undefined) _idleTimeoutMs = idleTimeoutMs;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const pipe = await this.getPipeline();
    if (!pipe) return texts.map(() => []);

    resetIdleTimer();

    const results: number[][] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      try {
        const output = await pipe(batch, {
          pooling: 'mean',
          normalize: true,
        });
        const vectors = output.tolist();
        results.push(...vectors);
      } catch (err) {
        console.error('[knowledge] Embedding batch failed:', err);
        results.push(...batch.map(() => []));
      }
    }

    resetIdleTimer();
    return results;
  }

  async embedOne(text: string): Promise<number[]> {
    const results = await this.embed([text]);
    return results[0] ?? [];
  }

  async isAvailable(): Promise<boolean> {
    const pipe = await this.getPipeline();
    return pipe !== null;
  }

  private async getPipeline(): Promise<PipelineFn | null> {
    if (_pipeline) return _pipeline;
    if (!_pipelineLoading) {
      _pipelineLoading = loadPipeline(this.model).then((pipe) => {
        _pipeline = pipe;
        if (pipe) resetIdleTimer();
        return pipe;
      });
    }
    return _pipelineLoading;
  }
}
