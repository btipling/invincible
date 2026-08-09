/**
 * Invincible sandbox daemon — CLI entry.
 *
 * Env:
 *   SANDBOX_TOKEN           (required) bearer secret
 *   SANDBOX_WORKSPACE       (required) path jail root
 *   SANDBOX_LISTEN          (optional) default 127.0.0.1:8787
 *   SANDBOX_AUTO_UPDATE     (optional) "1"/"true" enables git self-update
 *   SANDBOX_GIT_DIR         (required if SANDBOX_AUTO_UPDATE) repo root checkout
 *   SANDBOX_GIT_REF         (optional) ff-only target, default origin/main
 *   SANDBOX_UPDATE_CHECK_MS (optional) background check interval; 0 disables timer
 *
 * Run: npm run sandbox:start
 *   or: node sandbox/server.mjs
 */
import { DEFAULT_LISTEN, INVINCIBLE_SANDBOX_PROTOCOL } from './constants.mjs';
import { createSandboxServer, parseListen } from './createServer.mjs';
import { resolveAutoUpdateConfig, attemptAutoUpdate } from './autoUpdate.mjs';

function main() {
  const token = process.env.SANDBOX_TOKEN;
  const workspace = process.env.SANDBOX_WORKSPACE;
  const listen = process.env.SANDBOX_LISTEN ?? DEFAULT_LISTEN;
  const auto = resolveAutoUpdateConfig();

  if (!token) {
    console.error('SANDBOX_TOKEN is required');
    process.exit(1);
  }
  if (!workspace) {
    console.error('SANDBOX_WORKSPACE is required');
    process.exit(1);
  }

  const { host, port } = parseListen(listen);

  let exitScheduled = false;
  function scheduleExit() {
    if (exitScheduled) return;
    exitScheduled = true;
    console.log('[sandbox] updated; exiting for supervisor restart');
    setTimeout(() => process.exit(0), 100).unref();
  }

  // Background interval: catches idle hosts even when no tool request arrives.
  // `auto.intervalMs` is already 0-disabled via config when UPDATE_CHECK_MS=0.
  if (auto.enabled && auto.gitDir && auto.intervalMs > 0) {
    const timer = setInterval(() => {
      void attemptAutoUpdate(auto).then((res) => {
        if (res.updated) scheduleExit();
      });
    }, auto.intervalMs);
    timer.unref();
  }

  const server = createSandboxServer({
    token,
    workspace,
    onOutOfDate:
      auto.enabled && auto.gitDir
        ? () => {
            // Non-blocking: respond 426 immediately; try to update & self-restart.
            void attemptAutoUpdate(auto).then((res) => {
              if (res.updated) scheduleExit();
            });
          }
        : undefined,
  });

  server.listen(port, host, () => {
    console.log(
      `[sandbox] protocol v${INVINCIBLE_SANDBOX_PROTOCOL} listening on http://${host}:${port} workspace=${workspace}` +
        (auto.enabled && auto.gitDir ? ` auto-update on (git=${auto.gitDir}, ref=${auto.ref})` : ''),
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
