// =============================================================================
// agent-knowledge — REST server
//
// The local REST API the Claude Code /knowledge pane, the hook scripts, the
// opencode plugin and agent-tasks call. One process serves it: the first to
// bind the port; the others retry, so one of them takes over when the serving
// process exits. Binds 127.0.0.1 (AGENT_KNOWLEDGE_HOST overrides) and runs
// every request through the request guard.
// =============================================================================

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequestGuard, type RequestGuard } from './transport/guard.js';
import { json } from './transport/http.js';
import { createRouter } from './transport/rest.js';

export const DEFAULT_PORT = 3423;

export interface RestServer {
  httpServer: Server;
  port: number;
  close(): void;
}

/** Listens on `port` (0 picks a free one); rejects with code EADDRINUSE when it is taken. */
export function startRestServer(port = DEFAULT_PORT): Promise<RestServer> {
  const host = process.env.AGENT_KNOWLEDGE_HOST || '127.0.0.1';
  const router = createRouter();
  let guard: RequestGuard;
  const httpServer = createServer((req, res) => {
    if (guard(req, res)) return;
    router.handle(req, res).catch(() => {
      if (!res.headersSent) json(res, { error: 'Internal server error' }, 500);
    });
  });
  return new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => {
      const bound = (httpServer.address() as AddressInfo).port;
      guard = createRequestGuard(bound, host);
      process.stderr.write(`agent-knowledge REST API: http://localhost:${bound}\n`);
      resolve({ httpServer, port: bound, close: () => httpServer.close() });
    });
  });
}

export interface RestLeader {
  /** The server while this process holds the port, else null. */
  readonly server: RestServer | null;
  close(): void;
}

/**
 * Serves REST on `port` from whichever process holds it. A process that finds the port
 * taken tries again every `retryMs`, so the pane stays up when the serving one exits.
 * `onServe` runs once, when this process starts serving.
 */
export function serveRestWhenFree(
  port: number,
  retryMs = 5_000,
  onServe: () => void = () => {},
): RestLeader {
  let server: RestServer | null = null;
  let timer: NodeJS.Timeout | null = null;
  let isClosed = false;
  const attempt = () => {
    startRestServer(port).then(
      (s) => {
        if (isClosed) return s.close();
        server = s;
        onServe();
      },
      (err: NodeJS.ErrnoException) => {
        if (isClosed) return;
        if (err.code !== 'EADDRINUSE') {
          process.stderr.write(`[knowledge] REST server start failed: ${err.message}\n`);
          return;
        }
        timer = setTimeout(attempt, retryMs);
        timer.unref();
      },
    );
  };
  attempt();

  return {
    get server() {
      return server;
    },
    close() {
      isClosed = true;
      if (timer) clearTimeout(timer);
      server?.close();
    },
  };
}
