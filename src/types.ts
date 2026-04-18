import { homedir } from 'os';
import { join } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import type { ProviderName } from './embeddings/types.js';
import { readPackageMeta } from './package-meta.js';

export interface KnowledgeConfig {
  memoryDir: string;
  dataDir: string;
  sessionsDir: string;
  extraSessionRoots: string[];
  embeddingProvider: ProviderName;
  embeddingAlpha: number;
  gitUrl: string | undefined;
  autoDistill: boolean;
  /**
   * When true (default), session messages are chunked verbatim and indexed
   * into the vector store so raw conversation is retrievable later.
   * Disable only if disk usage is a concern; auto-distillation runs separately.
   */
  indexVerbatim: boolean;
}

// ── Persistent config file (~/.config/knowledge/config.json) ───────────────────

export interface PersistedConfig {
  gitUrl?: string;
  memoryDir?: string;
  autoDistill?: boolean;
  embeddingProvider?: string;
  embeddingAlpha?: number;
  indexVerbatim?: boolean;
}

function getConfigDir(): string {
  if (process.platform === 'win32') {
    return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'knowledge');
  }
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'knowledge');
}

function getConfigPath(): string {
  return join(getConfigDir(), 'config.json');
}

export function getConfigLocation(): string {
  return getConfigPath();
}

export function loadPersistedConfig(): PersistedConfig {
  const configPath = getConfigPath();
  if (!existsSync(configPath)) return {};
  try {
    return JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch (err) {
    console.error('[knowledge] load config:', err instanceof Error ? err.message : err);
    return {};
  }
}

export function savePersistedConfig(updates: Partial<PersistedConfig>): PersistedConfig {
  const configDir = getConfigDir();
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }
  const existing = loadPersistedConfig();
  const merged = { ...existing };
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined || value === null || value === '') {
      delete (merged as Record<string, unknown>)[key];
    } else {
      (merged as Record<string, unknown>)[key] = value;
    }
  }
  writeFileSync(getConfigPath(), JSON.stringify(merged, null, 2) + '\n', 'utf-8');
  return merged;
}

// ── Config resolution (env vars > persisted config > defaults) ──────────────

export function getConfig(): KnowledgeConfig {
  const home = homedir();
  // Primary host data root override — defaults to the platform config dir
  // when unset. Most deployments leave it unset and rely on the adapter
  // registry's multi-host auto-detection instead.
  const dataDir = process.env.AGENT_KNOWLEDGE_DATA_DIR || getConfigDir();
  const persisted = loadPersistedConfig();

  const memoryDir =
    process.env.AGENT_KNOWLEDGE_MEMORY_DIR || persisted.memoryDir || join(home, 'agent-knowledge');
  const sessionsDir = join(dataDir, 'projects');

  // Extra session roots: from env var (comma-separated) + auto-detected editors
  const extraSessionRoots: string[] = [];
  const envRoots = process.env.AGENT_KNOWLEDGE_EXTRA_SESSION_ROOTS;
  if (envRoots) {
    for (const r of envRoots.split(',')) {
      const trimmed = r.trim();
      if (trimmed) extraSessionRoots.push(trimmed);
    }
  }
  // Auto-detect common AI coding tool session directories
  // Per the host-agnostic Genericity rule: support every well-known AI coding
  // host root, not just Claude Code. New hosts: add an entry here.
  const autoDetectRoots = [
    join(home, '.claude', 'projects'),
    join(home, '.cursor', 'projects'),
    join(home, '.codex', 'projects'),
    join(home, '.aider', 'projects'),
    join(home, '.continue', 'projects'),
  ];
  for (const root of autoDetectRoots) {
    if (existsSync(root) && root !== sessionsDir && !extraSessionRoots.includes(root)) {
      extraSessionRoots.push(root);
    }
  }

  const embeddingProvider =
    (process.env.AGENT_KNOWLEDGE_EMBEDDING_PROVIDER as ProviderName) ||
    (persisted.embeddingProvider as ProviderName) ||
    'local';
  const embeddingAlpha = parseFloat(
    process.env.AGENT_KNOWLEDGE_EMBEDDING_ALPHA || String(persisted.embeddingAlpha ?? 0.3),
  );
  const gitUrl = process.env.AGENT_KNOWLEDGE_GIT_URL || persisted.gitUrl || undefined;
  const autoDistillEnv = process.env.AGENT_KNOWLEDGE_AUTO_DISTILL;
  const autoDistill =
    autoDistillEnv !== undefined
      ? autoDistillEnv.toLowerCase() !== 'false'
      : (persisted.autoDistill ?? true);

  const indexVerbatimEnv = process.env.AGENT_KNOWLEDGE_INDEX_VERBATIM;
  const indexVerbatim =
    indexVerbatimEnv !== undefined
      ? indexVerbatimEnv.toLowerCase() !== 'false'
      : (persisted.indexVerbatim ?? true);

  return {
    memoryDir,
    dataDir,
    sessionsDir,
    extraSessionRoots,
    embeddingProvider,
    embeddingAlpha,
    gitUrl,
    autoDistill,
    indexVerbatim,
  };
}

/**
 * Read the version from package.json (cached via readPackageMeta).
 */
export function getVersion(): string {
  return readPackageMeta().version;
}
