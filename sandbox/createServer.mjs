import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import {
  INVINCIBLE_SANDBOX_PROTOCOL,
  INVINCIBLE_SANDBOX_DAEMON_VERSION,
  SANDBOX_EXPECTED_DAEMON_VERSION_HEADER,
  SANDBOX_DAEMON_OUT_OF_DATE_CODE,
  sandboxDaemonOutOfDateError,
  MAX_JSON_BODY_BYTES,
} from './constants.mjs';
import { JailError, resolveWorkspaceRoot } from './paths.mjs';
import {
  ToolError,
  execCmd,
  listDir,
  readFileTool,
  writeFileTool,
  strReplaceTool,
  statTool,
} from './tools.mjs';

/**
 * @param {string} expected
 * @param {string} provided
 */
function safeEqualToken(expected, provided) {
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length) {
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

/** @param {string | undefined} header */
function parseBearer(header) {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1].trim() : null;
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {number} [maxBytes]
 */
async function readJsonBody(req, maxBytes = MAX_JSON_BODY_BYTES) {
  /** @type {Buffer[]} */
  const chunks = [];
  let len = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    len += buf.byteLength;
    if (len > maxBytes) {
      throw new ToolError('Request body too large', 413);
    }
    chunks.push(buf);
  }
  if (len === 0) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(raw);
  } catch {
    throw new ToolError('Invalid JSON body', 400);
  }
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {string} error
 */
function sendError(res, status, error) {
  sendJson(res, status, { error });
}

/**
 * @param {string | undefined} value
 * @returns {number | null} finite non-negative int, or null when absent/malformed
 */
function parseExpectedDaemonVersion(value) {
  if (value == null) return null;
  if (typeof value !== 'string') return null;
  const n = Number(value.trim());
  if (!Number.isFinite(n)) return null;
  const i = Math.floor(n);
  if (i < 0) return null;
  return i;
}

/**
 * Create the Invincible sandbox HTTP server (protocol v{@link INVINCIBLE_SANDBOX_PROTOCOL}).
 * @param {{ token: string, workspace: string, onOutOfDate?: (info: { running: number, expected: number }) => void }} opts
 */
export function createSandboxServer(opts) {
  if (!opts.token || typeof opts.token !== 'string') {
    throw new Error('SANDBOX_TOKEN is required');
  }
  if (!opts.workspace || typeof opts.workspace !== 'string') {
    throw new Error('SANDBOX_WORKSPACE is required');
  }

  const { token, workspace } = opts;

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const method = (req.method ?? 'GET').toUpperCase();

      if (method === 'GET' && url.pathname === '/health') {
        // Publish the REAL jail root the daemon actually enforces — not the raw
        // SANDBOX_WORKSPACE env string (which may be a relative path or a
        // symlink; the jail/exec paths resolve it via realpath). Disclosed unauth
        // (like version/daemonVersion, on the token-private daemon port); FS
        // mutation stays /v1/* token-gated. A missing/invalid root throws
        // JailError here → the client's fail-closed parse sees null (all FS ops
        // against a broken root would fail anyway).
        const workspaceRoot = resolveWorkspaceRoot(workspace);
        sendJson(res, 200, {
          ok: true,
          version: INVINCIBLE_SANDBOX_PROTOCOL,
          daemonVersion: INVINCIBLE_SANDBOX_DAEMON_VERSION,
          workspaceRoot,
        });
        return;
      }

      if (url.pathname.startsWith('/v1/')) {
        const provided = parseBearer(req.headers.authorization);
        if (provided == null || !safeEqualToken(token, provided)) {
          req.resume();
          sendError(res, 401, 'Unauthorized');
          return;
        }
      }

      // Daemon version gate: refuse tool work (426) when the caller expects a
      // newer daemon. Runs AFTER bearer auth so a wrong token still wins with 401.
      if (method === 'POST' && url.pathname.startsWith('/v1/')) {
        const expected = parseExpectedDaemonVersion(
          req.headers[SANDBOX_EXPECTED_DAEMON_VERSION_HEADER.toLowerCase()],
        );
        if (expected != null && expected > INVINCIBLE_SANDBOX_DAEMON_VERSION) {
          const running = INVINCIBLE_SANDBOX_DAEMON_VERSION;
          opts.onOutOfDate?.({ running, expected });
          req.resume();
          sendJson(res, 426, {
            error: sandboxDaemonOutOfDateError(running, expected),
            code: SANDBOX_DAEMON_OUT_OF_DATE_CODE,
            running,
            expected,
          });
          return;
        }
      }

      if (method === 'POST' && url.pathname === '/v1/list_dir') {
        const body = await readJsonBody(req);
        const result = await listDir(workspace, body ?? {});
        sendJson(res, 200, result);
        return;
      }

      if (method === 'POST' && url.pathname === '/v1/read_file') {
        const body = await readJsonBody(req);
        const result = await readFileTool(workspace, body ?? {});
        sendJson(res, 200, result);
        return;
      }

      if (method === 'POST' && url.pathname === '/v1/write_file') {
        const body = await readJsonBody(req);
        const result = await writeFileTool(workspace, body ?? {});
        sendJson(res, 200, result);
        return;
      }

      if (method === 'POST' && url.pathname === '/v1/str_replace') {
        const body = await readJsonBody(req);
        const result = await strReplaceTool(workspace, body ?? {});
        sendJson(res, 200, result);
        return;
      }

      if (method === 'POST' && url.pathname === '/v1/stat') {
        const body = await readJsonBody(req);
        const result = await statTool(workspace, body ?? {});
        sendJson(res, 200, result);
        return;
      }

      if (method === 'POST' && url.pathname === '/v1/exec') {
        const body = await readJsonBody(req);
        const result = await execCmd(workspace, body ?? {});
        sendJson(res, 200, result);
        return;
      }

      sendError(res, 404, 'Not found');
    } catch (err) {
      if (err instanceof JailError) {
        sendError(res, 400, err.message);
        return;
      }
      if (err instanceof ToolError) {
        sendError(res, err.status, err.message);
        return;
      }
      console.error('[sandbox] unhandled', err);
      sendError(res, 500, 'Internal server error');
    }
  });

  return server;
}

/** @param {string} listen */
export function parseListen(listen) {
  const idx = listen.lastIndexOf(':');
  if (idx <= 0) {
    throw new Error(`Invalid SANDBOX_LISTEN: ${listen}`);
  }
  const host = listen.slice(0, idx);
  const port = Number(listen.slice(idx + 1));
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid SANDBOX_LISTEN port: ${listen}`);
  }
  return { host, port };
}
