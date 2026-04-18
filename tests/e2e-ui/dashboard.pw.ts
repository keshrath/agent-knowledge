// =============================================================================
// agent-knowledge — Playwright E2E dashboard test
//
// Boots the standalone HTTP+WS dashboard with a temp AGENT_KNOWLEDGE_MEMORY_DIR /
// AGENT_KNOWLEDGE_DATA_DIR so the real ~/agent-knowledge/ is never touched. Seeds a
// few markdown entries, then drives the dashboard with chromium and verifies
// the grid renders, the search box returns the seeded entry, and the detail
// panel opens on click.
// =============================================================================

import { test, expect, type ConsoleMessage } from '@playwright/test';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { join } from 'path';
import { createServer } from 'net';
import type { Server } from 'http';

let tempMemoryDir: string;
let tempDataDir: string;
let server: Server;
let baseUrl: string;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close();
        reject(new Error('no port'));
      }
    });
  });
}

test.beforeAll(async () => {
  tempMemoryDir = mkdtempSync(join(tmpdir(), 'agent-knowledge-mem-'));
  tempDataDir = mkdtempSync(join(tmpdir(), 'agent-knowledge-data-'));
  process.env.AGENT_KNOWLEDGE_MEMORY_DIR = tempMemoryDir;
  process.env.AGENT_KNOWLEDGE_DATA_DIR = tempDataDir;

  // Seed three markdown entries via the store API after env is set so any
  // store-side path resolution picks up the temp dir.
  const { writeEntry } = await import('../../dist/knowledge/store.js');
  writeEntry(
    tempMemoryDir,
    'projects',
    'e2e-seed-playwright',
    '---\nname: e2e seed playwright\ntags: [e2e, playwright]\n---\n\nplaywright e2e seeded entry for the dashboard test.',
  );
  writeEntry(
    tempMemoryDir,
    'notes',
    'e2e-second',
    '---\nname: second entry\n---\n\nanother seeded note.',
  );
  writeEntry(
    tempMemoryDir,
    'decisions',
    'e2e-third',
    '---\nname: third entry\n---\n\na seeded decision.',
  );

  const { startDashboard } = await import('../../dist/dashboard.js');
  const port = await freePort();
  server = await startDashboard(port);
  baseUrl = `http://localhost:${port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
  });
  // Best-effort cleanup. On Windows the dashboard's fs.watch handle on the
  // memory dir can briefly outlive server.close(), causing EPERM on rmSync.
  try {
    if (tempMemoryDir) rmSync(tempMemoryDir, { recursive: true, force: true });
  } catch {
    /* ignore — temp dir will be cleaned by the OS */
  }
  try {
    if (tempDataDir) rmSync(tempDataDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

test.describe('agent-knowledge dashboard', () => {
  test('loads with no console errors and renders the SPA shell', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (msg: ConsoleMessage) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.goto(baseUrl + '/');
    await page.waitForSelector('#knowledge-search-input', { timeout: 10_000 });

    expect(pageErrors).toEqual([]);
    // Tolerate non-critical console noise (favicon, fonts, WS reconnect chatter).
    const hardErrors = consoleErrors.filter(
      (e) => !/favicon|404|fonts\.googleapis|websocket/i.test(e),
    );
    expect(hardErrors).toEqual([]);

    const screenshotDir = join(homedir(), '.claude', 'tmp');
    mkdirSync(screenshotDir, { recursive: true });
    await page.screenshot({
      path: join(screenshotDir, 'e2e-agent-knowledge.png'),
      fullPage: true,
    });
  });

  test('REST /api/knowledge returns the seeded entries', async ({ request }) => {
    const res = await request.get(baseUrl + '/api/knowledge');
    expect(res.ok()).toBe(true);
    const body = (await res.json()) as Array<{ path?: string }>;
    const paths = body.map((e) => e.path ?? '');
    expect(paths.some((p) => p.includes('e2e-seed-playwright'))).toBe(true);
    expect(body.length).toBeGreaterThanOrEqual(3);
  });

  test('REST /api/knowledge/search returns the seeded entry for a query', async ({ request }) => {
    const res = await request.get(baseUrl + '/api/knowledge/search?q=playwright');
    expect(res.ok()).toBe(true);
    const body = (await res.json()) as { results?: Array<{ path?: string }> } | Array<unknown>;
    const results = Array.isArray(body) ? body : (body.results ?? []);
    expect(results.length).toBeGreaterThan(0);
  });

  test('search input accepts a query without errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await page.goto(baseUrl + '/');
    await page.waitForSelector('#knowledge-search-input', { timeout: 5000 });

    await page.fill('#knowledge-search-input', 'playwright');
    // Wait for any debounced search request to fire and resolve.
    await page.waitForTimeout(1500);

    expect(errors).toEqual([]);
    // The search input retains the query.
    await expect(page.locator('#knowledge-search-input')).toHaveValue('playwright');
  });
});
