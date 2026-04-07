// =============================================================================
// agent-knowledge — package.json metadata (name + version)
//
// Thin wrapper around agent-common's readPackageMeta, locked to agent-knowledge's
// own package.json so MCP server info, dashboard, and getVersion() all read
// from a single authoritative source.
// =============================================================================

import { readPackageMeta as readKitPackageMeta, type PackageMeta } from 'agent-common';

export function readPackageMeta(): PackageMeta {
  return readKitPackageMeta({
    importMetaUrl: import.meta.url,
    fallbackName: 'agent-knowledge',
    fallbackVersion: '0.0.0',
  });
}
