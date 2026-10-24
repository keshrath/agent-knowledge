// Release manifests: CI publishes npm first, then the MCP Registry, so a
// manifest the registry rejects must fail here, before anything is published.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) =>
  JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')) as Record<
    string,
    unknown
  >;

describe('release manifests', () => {
  const pkg = read('package.json');
  const server = read('server.json') as {
    version: string;
    description: string;
    packages: Array<{ version: string }>;
  };

  it('keep every version file on the package version', () => {
    expect(server.version).toBe(pkg.version);
    expect(server.packages.map((p) => p.version)).toEqual([pkg.version]);
    expect(read('plugin/.claude-plugin/plugin.json').version).toBe(pkg.version);
  });

  it('pin the plugin MCP server to the package major', () => {
    const mcp = read('plugin/.mcp.json') as {
      mcpServers: Record<string, { args: string[] }>;
    };
    const major = String(pkg.version).split('.')[0];
    expect(mcp.mcpServers['agent-knowledge'].args).toContain(`agent-knowledge@^${major}`);
  });

  it('point the marketplace entry at the plugin folder', () => {
    const market = read('.claude-plugin/marketplace.json') as {
      plugins: Array<{ name: string; source: string }>;
    };
    expect(market.plugins).toEqual([
      expect.objectContaining({ name: 'agent-knowledge', source: './plugin' }),
    ]);
  });

  it('server.json description fits the MCP Registry limit (100 chars)', () => {
    expect(server.description.length).toBeLessThanOrEqual(100);
  });

  it('depend on no agent-common', () => {
    const deps = { ...(pkg.dependencies as object), ...(pkg.devDependencies as object) };
    expect(Object.keys(deps)).not.toContain('agent-common');
  });
});
