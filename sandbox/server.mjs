/**
 * Invincible sandbox daemon — CLI entry.
 *
 * Env:
 *   SANDBOX_TOKEN      (required) bearer secret
 *   SANDBOX_WORKSPACE  (required) path jail root
 *   SANDBOX_LISTEN     (optional) default 127.0.0.1:8787
 *
 * Run: npm run sandbox:start
 *   or: node sandbox/server.mjs
 */
import { DEFAULT_LISTEN } from './constants.mjs';
import { createSandboxServer, parseListen } from './createServer.mjs';

function main() {
  const token = process.env.SANDBOX_TOKEN;
  const workspace = process.env.SANDBOX_WORKSPACE;
  const listen = process.env.SANDBOX_LISTEN ?? DEFAULT_LISTEN;

  if (!token) {
    console.error('SANDBOX_TOKEN is required');
    process.exit(1);
  }
  if (!workspace) {
    console.error('SANDBOX_WORKSPACE is required');
    process.exit(1);
  }

  const { host, port } = parseListen(listen);
  const server = createSandboxServer({ token, workspace });

  server.listen(port, host, () => {
    console.log(
      `[sandbox] protocol v1 listening on http://${host}:${port} workspace=${workspace}`,
    );
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
