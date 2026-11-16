// app.ts — HTTP router for the forge. Dispatches to the four surfaces;
// main.ts owns the trial lifecycle and stays unchanged.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { store } from './store.ts';
import { handleRest, sendJson } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleGit } from './gitproto.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const path = pathOf(req);
        const method = req.method ?? 'GET';

        // Boot probe: no auth.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        if (path === '/api/graphql' && method === 'POST') {
          if (await handleGraphQL(req, res, store)) return;
        } else if (path === '/mcp' && method === 'POST') {
          if (await handleMcp(req, res, store)) return;
        } else if (path.startsWith('/api/v3')) {
          if (await handleRest(req, res, store)) return;
        } else if (path.includes('.git/') || path.endsWith('.git')) {
          if (await handleGit(req, res, store)) return;
        }

        // Unknown route: JSON 404, never HTML.
        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        // A handler must never take the server down with it.
        try {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
        } catch {
          try {
            res.writeHead(500, { 'content-type': JSON_TYPE });
            res.end('{"message":"Internal Server Error"}\n');
          } catch {
            // socket already gone; nothing to do
          }
        }
      }
    })();
  });
}
