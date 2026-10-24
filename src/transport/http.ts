// =============================================================================
// agent-knowledge — HTTP helpers for the REST server
//
// JSON responses, a size-limited JSON body reader and a small router with
// :param segments. node:http only.
// =============================================================================

import type { IncomingMessage, ServerResponse } from 'node:http';

/** An error with the HTTP status a handler answers with. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
) => void | Promise<void>;

export function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(data));
}

/** The request's JSON object body; HttpError 413 past `maxBytes`, 400 when not a JSON object. */
export function readBody(
  req: IncomingMessage,
  maxBytes = 64 * 1024,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    // Past the limit the rest is read and dropped, not cut off: a destroyed socket
    // would take the 413 answer with it.
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) reject(new HttpError(413, 'Request body too large'));
      else chunks.push(chunk);
    });
    req.on('end', () => {
      if (size > maxBytes) return;
      try {
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString());
        if (typeof body !== 'object' || body === null || Array.isArray(body)) {
          reject(new HttpError(400, 'Request body must be a JSON object'));
        } else {
          resolve(body as Record<string, unknown>);
        }
      } catch {
        reject(new HttpError(400, 'Invalid JSON in request body'));
      }
    });
    req.on('error', reject);
  });
}

interface Route {
  method: string;
  pattern: RegExp;
  names: string[];
  handler: RouteHandler;
}

export class Router {
  private readonly routes: Route[] = [];

  /** `:name` matches one path segment; a slash inside a value is sent encoded (%2F). */
  route(method: string, path: string, handler: RouteHandler): this {
    const names: string[] = [];
    const source = path.replace(/:(\w+)/g, (_m, name: string) => {
      names.push(name);
      return '([^/]+)';
    });
    this.routes.push({ method, pattern: new RegExp(`^${source}$`), names, handler });
    return this;
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    for (const r of this.routes) {
      if (req.method !== r.method) continue;
      const match = pathname.match(r.pattern);
      if (!match) continue;
      const params: Record<string, string> = {};
      try {
        r.names.forEach((name, i) => (params[name] = decodeURIComponent(match[i + 1]!)));
        await r.handler(req, res, params);
      } catch (err) {
        if (res.headersSent) return;
        if (err instanceof HttpError) json(res, { error: err.message }, err.status);
        else if (err instanceof URIError) json(res, { error: 'Bad request' }, 400);
        else {
          process.stderr.write(
            `[knowledge] REST handler error: ${err instanceof Error ? err.message : String(err)}\n`,
          );
          json(res, { error: 'Internal server error' }, 500);
        }
      }
      return;
    }
    json(res, { error: 'Not found' }, 404);
  }
}
