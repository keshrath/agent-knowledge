// =============================================================================
// agent-knowledge — REST server
//
// The local REST API the Claude Code plugin (the /knowledge pane and the
// session lifecycle), the opencode plugin and agent-tasks call. One process
// serves it: the first to bind the port; the others retry, so one of them
// takes over when the serving process exits. The serving process asks itself
// for /health now and then and, when it gets no answer, lets the port go and
// binds it again, so a listener that stopped accepting never holds the port.
// Binds 127.0.0.1 (AGENT_KNOWLEDGE_HOST overrides) and runs every request
// through the request guard.
// =============================================================================

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequestGuard, type RequestGuard } from './transport/guard.js';
import { json } from './transport/http.js';
import { createRouter } from './transport/rest.js';

export const DEFAULT_PORT = 3423;
const KEEP_ALIVE_MS = 65_000;

export interface RestServer {
  httpServer: Server;
  port: number;
  /** Where it answers: its bound address (loopback for an unspecified one) and port. */
  url: string;
  close(): void;
}

/** The address a bound server answers on; `0.0.0.0` and `::` answer on loopback. */
function urlOf({ address, family, port }: AddressInfo): string {
  const host = address === '0.0.0.0' ? '127.0.0.1' : address === '::' ? '::1' : address;
  return `http://${family === 'IPv6' ? `[${host}]` : host}:${port}`;
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
  // An idle connection is kept well past the pane's 5 s poll: at Node's default (5 s) the server
  // closes it just as a client reuses it, and that request is reset (ECONNRESET).
  httpServer.keepAliveTimeout = KEEP_ALIVE_MS;
  httpServer.headersTimeout = KEEP_ALIVE_MS + 1_000;
  return new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => {
      const address = httpServer.address() as AddressInfo;
      const bound = address.port;
      guard = createRequestGuard(bound, host);
      process.stderr.write(`agent-knowledge REST API: http://localhost:${bound}\n`);
      resolve({
        httpServer,
        port: bound,
        url: urlOf(address),
        close: () => {
          httpServer.close();
          httpServer.closeAllConnections();
        },
      });
    });
  });
}

export interface RestLeader {
  /** The server while this process holds the port, else null. */
  readonly server: RestServer | null;
  close(): void;
}

export interface LeaderOptions {
  /** How often the holder asks itself for /health. */
  watchMs?: number;
  /** Whether the server at `url` answers; the default asks /health with a 5 s timeout. */
  probe?: (url: string) => Promise<boolean>;
}

/** Unanswered self-checks in a row after which the holder lets the port go. */
const STRIKES = 2;

async function answers(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Serves REST on `port` from whichever process holds it. A process that finds the port
 * taken tries again every `retryMs`, so the pane stays up when the serving one exits.
 * The holder checks itself every `watchMs`: two checks in a row without an answer close
 * its listener and it binds again (or, when another process took the port meanwhile,
 * waits like any other). `onServe` runs once, when this process first starts serving.
 */
export function serveRestWhenFree(
  port: number,
  retryMs = 5_000,
  onServe: () => void = () => {},
  { watchMs = 30_000, probe = answers }: LeaderOptions = {},
): RestLeader {
  let server: RestServer | null = null;
  let timer: NodeJS.Timeout | null = null;
  let watch: NodeJS.Timeout | null = null;
  let isClosed = false;
  let hasServed = false;
  let misses = 0;

  const check = async () => {
    const s = server;
    if (!s || isClosed) return;
    if (await probe(s.url)) {
      misses = 0;
      return;
    }
    if (++misses < STRIKES || server !== s) return;
    process.stderr.write(
      `[knowledge] REST server on ${s.port} stopped answering: letting the port go\n`,
    );
    misses = 0;
    server = null;
    if (watch) clearInterval(watch);
    s.close();
    attempt();
  };

  const attempt = () => {
    startRestServer(port).then(
      (s) => {
        if (isClosed) return s.close();
        server = s;
        watch = setInterval(() => void check(), watchMs);
        watch.unref();
        if (!hasServed) {
          hasServed = true;
          onServe();
        }
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
      if (watch) clearInterval(watch);
      server?.close();
    },
  };
}
