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
}

// ── Persistent config file (~/.config/knowledge/config.json) ───────────────────

export interface PersistedConfig {
  gitUrl?: string;
  memoryDir?: string;
  autoDistill?: boolean;
  embeddingProvider?: string;
  embeddingAlpha?: number;
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
  // KNOWLEDGE_DATA_DIR is optional — defaults to platform config dir.
  const dataDir = process.env.KNOWLEDGE_DATA_DIR || getConfigDir();
  const persisted = loadPersistedConfig();

  const memoryDir =
    process.env.KNOWLEDGE_MEMORY_DIR || persisted.memoryDir || join(home, 'agent-knowledge');
  const sessionsDir = join(dataDir, 'projects');

  // Extra session roots: from env var (comma-separated) + auto-detected editors
  const extraSessionRoots: string[] = [];
  const envRoots = process.env.EXTRA_SESSION_ROOTS;
  if (envRoots) {
    for (const r of envRoots.split(',')) {
      const trimmed = r.trim();
      if (trimmed) extraSessionRoots.push(trimmed);
    }
  }
  // Auto-detect common AI coding tool session directories
  const autoDetectRoots = [join(home, '.claude', 'projects'), join(home, '.cursor', 'projects')];
  for (const root of autoDetectRoots) {
    if (existsSync(root) && root !== sessionsDir && !extraSessionRoots.includes(root)) {
      extraSessionRoots.push(root);
    }
  }

  const embeddingProvider =
    (process.env.KNOWLEDGE_EMBEDDING_PROVIDER as ProviderName) ||
    (persisted.embeddingProvider as ProviderName) ||
    'local';
  const embeddingAlpha = parseFloat(
    process.env.KNOWLEDGE_EMBEDDING_ALPHA || String(persisted.embeddingAlpha ?? 0.3),
  );
  const gitUrl = process.env.KNOWLEDGE_GIT_URL || persisted.gitUrl || undefined;
  const autoDistillEnv = process.env.KNOWLEDGE_AUTO_DISTILL;
  const autoDistill =
    autoDistillEnv !== undefined
      ? autoDistillEnv.toLowerCase() !== 'false'
      : (persisted.autoDistill ?? true);

  return {
    memoryDir,
    dataDir,
    sessionsDir,
    extraSessionRoots,
    embeddingProvider,
    embeddingAlpha,
    gitUrl,
    autoDistill,
  };
}

/**
 * Read the version from package.json (cached via readPackageMeta).
 */
export function getVersion(): string {
  return readPackageMeta().version;
}
