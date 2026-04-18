import { describe, it, expect, afterAll } from 'vitest';
import http from 'http';
import { startDashboard } from '../src/dashboard.js';

// Use a random high port to avoid conflicts
const TEST_PORT = 19423 + Math.floor(Math.random() * 1000);
let server: http.Server;

function fetch(
  path: string,
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    http
      .get(`http://localhost:${TEST_PORT}${path}`, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode!, body: data, headers: res.headers }));
        res.on('error', reject);
      })
      .on('error', reject);
  });
}

describe('dashboard HTTP server', () => {
  // Start server once for all tests
  it('starts on the given port', async () => {
    server = await startDashboard(TEST_PORT);
    expect(server).toBeDefined();
    expect(server.listening).toBe(true);
  });

  afterAll(() => {
    if (server) server.close();
  });

  it('GET /health returns JSON with status ok', async () => {
    const { status, body } = await fetch('/health');
    expect(status).toBe(200);
    const data = JSON.parse(body);
    expect(data.status).toBe('ok');
    expect(data.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(data.uptime).toBeGreaterThanOrEqual(0);
  });

  it('GET /api/knowledge returns KnowledgeEntry-shaped rows', async () => {
    const { status, body } = await fetch('/api/knowledge');
    expect(status).toBe(200);
    const data = JSON.parse(body);
    expect(Array.isArray(data)).toBe(true);
    // Shape check — if the API handler breaks we should see that in the
    // row structure, not just the array wrapper.
    for (const row of data.slice(0, 3)) {
      expect(typeof row.path).toBe('string');
      expect(typeof row.title).toBe('string');
      expect(typeof row.category).toBe('string');
      expect(Array.isArray(row.tags)).toBe(true);
    }
  });

  it('GET /api/knowledge rows surface evergreen, author, and last_accessed', async () => {
    // v1.8.1: dashboard extends row shape with evergreen (boolean),
    // author (string|null), and last_accessed (string|null).
    const { status, body } = await fetch('/api/knowledge');
    expect(status).toBe(200);
    const data = JSON.parse(body);
    expect(Array.isArray(data)).toBe(true);
    for (const row of data.slice(0, 5)) {
      expect(row).toHaveProperty('evergreen');
      expect(typeof row.evergreen).toBe('boolean');
      expect(row).toHaveProperty('author');
      expect(row.author === null || typeof row.author === 'string').toBe(true);
      expect(row).toHaveProperty('last_accessed');
      expect(row.last_accessed === null || typeof row.last_accessed === 'string').toBe(true);
    }
  });

  it('GET /api/sessions returns session-listing rows with meta fields', async () => {
    const { status, body } = await fetch('/api/sessions');
    expect(status).toBe(200);
    const data = JSON.parse(body);
    expect(Array.isArray(data)).toBe(true);
    for (const row of data.slice(0, 3)) {
      expect(typeof row.sessionId).toBe('string');
      expect(typeof row.project).toBe('string');
      // startTime can be 'unknown' but must at least be a string.
      expect(typeof row.startTime).toBe('string');
    }
  });

  it('GET /api/sessions/search returns array', async () => {
    const { status, body } = await fetch('/api/sessions/search?q=test&max_results=1');
    expect(status).toBe(200);
    const data = JSON.parse(body);
    expect(Array.isArray(data)).toBe(true);
  }, 60_000);

  it('GET /api/sessions/recall returns array', async () => {
    const { status, body } = await fetch('/api/sessions/recall?scope=errors&q=test&max_results=1');
    expect(status).toBe(200);
    const data = JSON.parse(body);
    expect(Array.isArray(data)).toBe(true);
  }, 60_000);

  it('GET /api/knowledge/search returns array', async () => {
    const { status, body } = await fetch('/api/knowledge/search?q=test');
    expect(status).toBe(200);
    const data = JSON.parse(body);
    expect(Array.isArray(data)).toBe(true);
  });

  it('returns 404 for non-existent session', async () => {
    const { status } = await fetch('/api/sessions/nonexistent-id-12345');
    expect(status).toBe(404);
  });

  it('returns 404 for non-existent session summary', async () => {
    const { status } = await fetch('/api/sessions/nonexistent-id-12345/summary');
    expect(status).toBe(404);
  });

  it('returns CORS headers on responses', async () => {
    const { headers } = await fetch('/health');
    expect(headers['access-control-allow-origin']).toBe('*');
  });

  it('serves static files for root path', async () => {
    const { status, headers } = await fetch('/');
    // Status depends on whether the built UI directory (dist/ui/) exists:
    // - 200: UI files are built and served (content-type must be text/html)
    // - 404: UI not built yet (dev environment without prior `npm run build`)
    // 403 is NOT expected for root path — only for path traversal attempts
    expect([200, 404]).toContain(status);
    if (status === 200) {
      expect(headers['content-type']).toContain('text/html');
    }
  });

  it('rejects non-GET methods with 405', async () => {
    return new Promise<void>((resolve, reject) => {
      const req = http.request(
        { hostname: 'localhost', port: TEST_PORT, path: '/health', method: 'POST' },
        (res) => {
          expect(res.statusCode).toBe(405);
          res.resume();
          resolve();
        },
      );
      req.on('error', reject);
      req.end();
    });
  });

  it('allows OPTIONS requests (CORS preflight)', async () => {
    return new Promise<void>((resolve, reject) => {
      const req = http.request(
        { hostname: 'localhost', port: TEST_PORT, path: '/api/knowledge', method: 'OPTIONS' },
        (res) => {
          expect(res.statusCode).toBe(204);
          expect(res.headers['access-control-allow-origin']).toBe('*');
          res.resume();
          resolve();
        },
      );
      req.on('error', reject);
      req.end();
    });
  });
});
