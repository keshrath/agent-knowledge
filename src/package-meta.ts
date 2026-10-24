// =============================================================================
// agent-knowledge — package.json metadata (name + version)
//
// Read once from the package's own package.json (one level above src/ and
// dist/), so MCP server info, the REST /health route and getVersion() share
// one source.
// =============================================================================

import { readFileSync } from 'node:fs';

export interface PackageMeta {
  name: string;
  version: string;
}

let cached: PackageMeta | null = null;

export function readPackageMeta(): PackageMeta {
  if (cached) return cached;
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')) as {
      name?: unknown;
      version?: unknown;
    };
    cached = {
      name: typeof pkg.name === 'string' ? pkg.name : 'agent-knowledge',
      version: typeof pkg.version === 'string' ? pkg.version : '0.0.0',
    };
  } catch {
    cached = { name: 'agent-knowledge', version: '0.0.0' };
  }
  return cached;
}
